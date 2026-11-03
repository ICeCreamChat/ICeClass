"""Functional business workflows through the authenticated operation endpoints."""
import copy
import csv
import io
import json
import os
import zipfile
from datetime import datetime, timedelta
from unittest.mock import patch
from xml.etree import ElementTree as ET

import app as service
import ideas
import test_ideas as idea_fixtures
from banban_agent import BanbanAgent
from banban_operations import KEY, operation_tools
from island_xlsx import export_schedule, import_schedule
from reading import SHANGHAI
from test_app import ServerTestCase


XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
STAFF_PASSWORD = 'TeacherPassword123'


class StewardBusinessTest(ServerTestCase):
    submit = idea_fixtures.IdeasTests.submit
    device_headers = idea_fixtures.IdeasTests.device_headers

    async def asyncSetUp(self):
        self.enterContext(patch.dict(os.environ, {
            'ICECLASS_IDEAS_DIGEST_ENABLED': 'false', 'DEEPSEEK_API_KEY': '',
        }))
        mail = self.enterContext(patch.object(ideas, 'send_mail', side_effect=AssertionError('No test email')))
        self.addCleanup(mail.assert_not_called)
        await super().asyncSetUp()
        self.device = await self.enroll_test_device()
        self.cid = self.device['classId']
        self.owner = self.cookie, self.csrf
        self.db = self.app[service.STORE_KEY]
        self.ops = self.app[KEY]
        self.island_path = '/api/island/classes/' + self.cid

    def as_owner(self):
        self.cookie, self.csrf = self.owner

    async def staff(self, role='teacher', username='business.teacher'):
        self.as_owner()
        response, user = await self.json_request('POST', '/api/teachers', {
            'username': username, 'displayName': '业务测试账号', 'password': STAFF_PASSWORD,
            'role': role, 'classIds': [self.cid] if role == 'teacher' else [],
        }, csrf=True)
        self.assertEqual(response.status, 201, user)
        return user

    async def login_staff(self, user):
        response, data = await self.json_request('POST', '/api/auth/login', {
            'username': user['username'], 'password': STAFF_PASSWORD,
        })
        self.assertEqual(response.status, 200, data)
        self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]
        self.csrf = data['user']['csrfToken']
        return data['user']

    async def platform(self, action, payload=None, **target):
        return await self.json_request('POST', '/api/banban/operations', {
            'kind': 'platform', 'args': {'operation': action, 'payload': payload or {}, **target},
        }, csrf=True)

    async def prepare(self, action, payload=None, *, status='awaiting_confirmation', **target):
        response, operation = await self.platform(action, payload, **target)
        self.assertEqual(response.status, 200, operation)
        self.assertEqual(operation['status'], status, operation)
        return operation

    async def confirm(self, operation, *, status='succeeded'):
        response, result = await self.json_request('POST',
            '/api/banban/operations/' + operation['id'] + '/confirm', {'confirmed': True}, csrf=True)
        self.assertEqual(response.status, 200, result)
        self.assertEqual(result['id'], operation['id'])
        self.assertEqual(result['status'], status, result)
        return result

    async def profile(self):
        response, profile = await self.json_request('GET', self.island_path)
        self.assertEqual(response.status, 200, profile)
        return profile

    async def configured_island(self):
        profile = await self.profile()
        config = copy.deepcopy(profile['config'])
        config['lessons'] = [{'slotId': 'period-1', 'weekday': 1, 'week': 'all',
                              'subject': '原课语文', 'teacher': '王老师', 'location': '本班'}]
        config['appearance']['width'] = 620
        config['reminders']['volume'] = 38
        config['components'] = [{'id': 'class-note', 'type': 'text', 'enabled': True,
                                 'title': '班级提醒', 'text': '保留这条提醒', 'date': ''}]
        response, saved = await self.json_request('PUT', self.island_path,
            {'config': config, 'revision': profile['revision']}, csrf=True)
        self.assertEqual(response.status, 200, saved)
        return saved

    def import_file(self, profile):
        config = copy.deepcopy(profile['config'])
        config['lessons'][0].update(subject='导入物理', teacher='李老师')
        return export_schedule(config, class_name='高一（1）班')

    async def upload(self, operation, content):
        response = await self.client.post('/api/banban/operations/' + operation['id'] + '/file',
            data=content, headers={**self.headers(csrf=True), 'Content-Type': XLSX})
        return response, await response.json()

    async def export_data(self):
        response, other = await self.json_request('POST', '/api/classes', {'name': '高二（9）班'}, csrf=True)
        self.assertEqual(response.status, 201, other)
        self.other = other['id']
        self.day = '2026-10-16'
        timestamp = int(datetime(2026, 10, 16, 7, 40, tzinfo=SHANGHAI).timestamp() * 1000)
        for cid, active, effective, text in (
            (self.cid, 1023, 511, '本班独有通知'), (self.other, 31, 15, '其他班私密通知'),
        ):
            self.db.run('INSERT INTO reading_buckets VALUES(?,?,?,?,?)',
                        (cid, self.day, timestamp // 10000, active, effective))
            response, result = await self.json_request('POST', '/api/shouts', {
                'classId': cid, 'text': text, 'alertLevel': 'info', 'quietAcknowledged': True,
            }, csrf=True)
            self.assertEqual(response.status, 202, result)
        self.db.run('INSERT INTO reading_buckets VALUES(?,?,?,?,?)',
                    (self.cid, '2026-10-15', (timestamp - 86400000) // 10000, 1023, 1023))

    async def download(self, operation):
        self.assertEqual(operation['status'], 'succeeded', operation)
        url = operation['result']['downloadUrl']
        self.assertEqual(url, '/api/banban/operations/' + operation['id'] + '/download')
        response = await self.client.get(url, headers=self.headers())
        content = await response.read()
        self.assertEqual(response.status, 200, content[:200])
        self.assertIn('attachment;', response.headers['Content-Disposition'])
        self.assertEqual(len(content), operation['result']['size'])
        return response, content

    def workbook_text(self, content):
        self.assertTrue(content.startswith(b'PK'))
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            self.assertIsNone(archive.testzip())
            self.assertIn('xl/workbook.xml', archive.namelist())
            return '\n'.join(' '.join(ET.fromstring(archive.read(name)).itertext())
                             for name in archive.namelist() if name.endswith('.xml'))

    async def test_idea_review_requires_confirmation_and_updates_version_once(self):
        response, submitted = await self.submit(text='希望班级植物可以记录成长')
        self.assertEqual(response.status, 201, submitted)
        item = submitted['item']
        operation = await self.prepare('idea.review', {
            'version': item['version'], 'status': 'adopted', 'reply': '将安排试用', 'published': True,
            'publishedTitle': '班级植物日记', 'publishedText': '记录班级植物的成长。',
        }, targetId=item['id'])
        before = self.db.one('SELECT * FROM ideas WHERE id=?', (item['id'],))
        self.assertEqual((before['status'], before['version'], before['published']), ('pending', 1, 0))
        result = await self.confirm(operation)
        reviewed = result['result']['item']
        self.assertEqual((reviewed['status'], reviewed['reply'], reviewed['version']), ('adopted', '将安排试用', 2))
        self.assertTrue(reviewed['published'])
        await self.confirm(operation)
        self.assertEqual(self.db.one('SELECT version FROM ideas WHERE id=?', (item['id'],))['version'], 2)
        response, public = await self.json_request('GET', '/api/ideas/showcase')
        self.assertEqual(response.status, 200, public)
        self.assertEqual(public['items'][0]['publishedTitle'], '班级植物日记')

    async def test_idea_review_rejects_stale_version_and_changes_since_preparation(self):
        for timing in ('before_prepare', 'after_prepare'):
            with self.subTest(timing=timing):
                response, submitted = await self.submit(text='版本冲突测试 ' + timing)
                self.assertEqual(response.status, 201, submitted)
                item = submitted['item']

                async def concurrent_review():
                    response, changed = await self.json_request('PATCH', '/api/ideas/admin/' + item['id'],
                        {'version': item['version'], 'status': 'implementing', 'reply': '其他评审已保存'}, csrf=True)
                    self.assertEqual(response.status, 200, changed)
                    return self.db.one('SELECT * FROM ideas WHERE id=?', (item['id'],))

                if timing == 'before_prepare':
                    current = await concurrent_review()
                operation = await self.prepare('idea.review',
                    {'version': item['version'], 'status': 'declined', 'reply': '不应覆盖'}, targetId=item['id'])
                if timing == 'after_prepare':
                    current = await concurrent_review()
                result = await self.confirm(operation, status='failed')
                self.assertTrue(result['result']['detail'])
                self.assertEqual(self.db.one('SELECT * FROM ideas WHERE id=?', (item['id'],)), current)

    async def test_idea_review_is_denied_to_principal_and_teacher(self):
        response, submitted = await self.submit()
        self.assertEqual(response.status, 201, submitted)
        item = submitted['item']
        for role in ('principal', 'teacher'):
            with self.subTest(role=role):
                user = await self.staff(role, 'business.' + role)
                logged_in = await self.login_staff(user)
                response, result = await self.platform('idea.review',
                    {'version': item['version'], 'status': 'adopted'}, targetId=item['id'])
                self.assertEqual(response.status, 403, result)
                tools = {tool['function']['name']: tool['function'] for tool in operation_tools(self.app, logged_in)}
                self.assertNotIn('idea.review', tools['operate_platform']['parameters']['properties']['operation']['enum'])
        self.assertEqual(self.db.one('SELECT version FROM ideas WHERE id=?', (item['id'],))['version'], 1)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM banban_operations')['n'], 0)

    async def test_school_visibility_revision_conflict_preserves_newer_rules(self):
        response, original = await self.json_request('GET', '/api/island/visibility')
        self.assertEqual(response.status, 200, original)
        desired = {**original['config'], 'hideDaytimeLessons': False}
        operation = await self.prepare('island.visibility.update',
            {'config': desired, 'revision': original['revision']})
        current = {**original['config'], 'hideFirstEvening': False}
        response, saved = await self.json_request('PUT', '/api/island/visibility',
            {'config': current, 'revision': original['revision']}, csrf=True)
        self.assertEqual(response.status, 200, saved)
        await self.confirm(operation, status='failed')
        _, after = await self.json_request('GET', '/api/island/visibility')
        self.assertEqual(after, saved)
        stale = await self.prepare('island.visibility.update', {'config': desired, 'revision': original['revision']})
        await self.confirm(stale, status='failed')
        _, after = await self.json_request('GET', '/api/island/visibility')
        self.assertEqual(after, saved)
        fresh = await self.prepare('island.visibility.update', {'config': desired, 'revision': saved['revision']})
        result = await self.confirm(fresh)
        self.assertEqual(result['result']['revision'], saved['revision'] + 1)
        self.assertEqual(result['result']['config'], desired)

    async def test_enrollment_secret_stays_out_of_rows_tools_and_chat_histories(self):
        response, settings = await self.json_request('PUT', '/api/banban/settings',
            {'enabled': True, 'model': 'fixture', 'apiKey': 'fixture-only'}, csrf=True)
        self.assertEqual(response.status, 200, settings)
        observed = []

        async def provider(agent, config, messages, allow_tools=True):
            observed.append(copy.deepcopy(messages))
            if messages[-1]['role'] == 'user':
                yield {'tool_calls': [{'index': 0, 'id': 'enrollment-once', 'function': {
                    'name': 'operate_platform', 'arguments': json.dumps({
                        'operation': 'enrollment.school.create', 'payload': {'validDays': 7}})}}]}
            else:
                yield {'text': '绑定信息已生成，请在私密入口查看。'}

        with patch.object(BanbanAgent, 'provider', provider):
            response = await self.client.post('/api/banban/chat/stream', json={
                'message': '请生成七天有效的全校绑定码', 'voice': {'mode': 'voice'},
            }, headers=self.headers(csrf=True))
            self.assertEqual(response.status, 200)
            events = [json.loads(line) async for line in response.content if line.strip()]
        self.assertEqual(events[-1]['type'], 'done', events)
        tool_results = [json.loads(message['content']) for call in observed for message in call
                        if message['role'] == 'tool' and message.get('tool_call_id') == 'enrollment-once']
        self.assertEqual(len(tool_results), 1, observed)
        operation = tool_results[0]
        self.assertEqual(operation['status'], 'succeeded', operation)
        self.assertIn('privateUrl', operation['result'])
        response, private = await self.json_request('GET', operation['result']['privateUrl'])
        self.assertEqual(response.status, 200, private)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        secret = private['code']
        self.assertGreaterEqual(len(secret), 5)
        school = self.db.one('SELECT * FROM school_enrollment WHERE id=1')
        self.assertEqual(school['code_hash'], service.sha256(service.normalize_code(secret)))
        self.assertEqual(school['expires_at'] - school['created_at'], 7 * 86400000)
        _, listed = await self.json_request('GET', '/api/banban/operations')
        _, detail = await self.json_request('GET', '/api/banban/operations/' + operation['id'])
        response, history = await self.json_request('GET',
            '/api/banban/conversation?conversationId=' + events[-1]['conversationId'])
        self.assertEqual(response.status, 200, history)
        self.assertEqual([message['role'] for message in history['messages']], ['user', 'assistant'])
        durable_history = self.db.all('SELECT * FROM banban_conversation_messages')
        self.assertEqual(len(durable_history), 2)
        exposed = {'events': events, 'providerMessages': observed, 'tools': tool_results,
                   'operations': listed, 'detail': detail, 'history': history,
                   'operationRows': self.db.all('SELECT * FROM banban_operations'),
                   'historyRows': durable_history, 'conversations': self.db.all('SELECT * FROM banban_conversations'),
                   'audit': self.db.all('SELECT * FROM audit_events')}
        serialized = json.dumps(exposed, ensure_ascii=False)
        self.assertNotIn(secret, serialized)
        self.assertNotIn(service.normalize_code(secret), serialized)
        self.assertNotIn('code', operation['result'])

    async def test_private_result_checks_login_owner_current_permission_and_expiry(self):
        operation = await self.prepare('enrollment.school.create', {'validDays': 1})
        result = await self.confirm(operation)
        url = result['result']['privateUrl']
        response, private = await self.json_request('GET', url)
        self.assertEqual(response.status, 200, private)
        secret = private['code']
        self.cookie, self.csrf = '', ''
        response, denied = await self.json_request('GET', url)
        self.assertEqual(response.status, 401, denied)
        principal = await self.staff('principal', 'private.principal')
        await self.login_staff(principal)
        response, denied = await self.json_request('GET', url)
        self.assertEqual(response.status, 403, denied)
        self.assertNotIn(secret, json.dumps(denied))
        self.as_owner()
        owner_id = self.db.one("SELECT id FROM users WHERE username='ICe'")['id']
        self.db.run("UPDATE users SET role='teacher' WHERE id=?", (owner_id,))
        try:
            response, denied = await self.json_request('GET', url)
            self.assertEqual(response.status, 403, denied)
            self.assertNotIn(secret, json.dumps(denied))
        finally:
            self.db.run("UPDATE users SET role='superadmin' WHERE id=?", (owner_id,))
        response, still_private = await self.json_request('GET', url)
        self.assertEqual(response.status, 200, still_private)
        self.assertEqual(still_private['code'], secret)
        self.db.run('UPDATE banban_operations SET expires_at=? WHERE id=?', (service.now_ms() - 1, operation['id']))
        response, expired = await self.json_request('GET', url)
        self.assertEqual(response.status, 400, expired)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertNotIn(secret, json.dumps(expired))

    async def test_class_enrollment_returns_usable_secret_only_through_private_endpoint(self):
        operation = await self.prepare('enrollment.class.create', classId=self.cid)
        self.assertNotIn(operation['id'], self.ops.private_results)
        result = await self.confirm(operation)
        response, private = await self.json_request('GET', result['result']['privateUrl'])
        self.assertEqual(response.status, 200, private)
        self.assertEqual(private['className'], '高一（1）班')
        stored = self.db.one('SELECT * FROM enrollment_codes WHERE code_hash=?',
                             (service.sha256(service.normalize_code(private['code'])),))
        self.assertEqual(stored['class_id'], self.cid)
        self.assertEqual(stored['expires_at'] - stored['created_at'], 900000)
        self.assertNotIn(private['code'], json.dumps(self.db.all('SELECT * FROM banban_operations')))
        response, enrolled = await self.json_request('POST', '/api/device/enroll',
            {'code': private['code'], 'deviceName': '私密绑定结果验收设备'})
        self.assertEqual(response.status, 200, enrolled)
        self.assertEqual(enrolled['classId'], self.cid)

    async def test_history_export_download_is_real_scoped_csv(self):
        await self.export_data()
        teacher = await self.staff()
        await self.login_staff(teacher)
        operation = await self.prepare('history.export', {'classId': self.cid}, status='succeeded')
        response, content = await self.download(operation)
        self.assertEqual(response.content_type, 'text/csv')
        rows = list(csv.DictReader(io.StringIO(content.decode('utf-8-sig'))))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['班级'], '高一（1）班')
        self.assertEqual(rows[0]['喊话内容'], '本班独有通知')
        self.assertNotIn('其他班私密通知', content.decode('utf-8-sig'))

    async def test_reading_export_download_contains_scoped_csv_and_xlsx_data(self):
        await self.export_data()
        for format in ('csv', 'xlsx'):
            with self.subTest(format=format):
                operation = await self.prepare('reading.export', {
                    'start': self.day, 'end': self.day, 'grades': '高一', 'format': format,
                }, status='succeeded')
                response, content = await self.download(operation)
                if format == 'csv':
                    self.assertEqual(response.content_type, 'text/csv')
                    rows = list(csv.DictReader(io.StringIO(content.decode('utf-8-sig'))))
                    self.assertEqual(len(rows), 1)
                    self.assertEqual((rows[0]['班级'], rows[0]['开始日期'], rows[0]['结束日期']),
                                     ('高一（1）班', self.day, self.day))
                    self.assertEqual((rows[0]['运行秒数'], rows[0]['有效发声秒数']), ('10', '9'))
                    text = content.decode('utf-8-sig')
                else:
                    self.assertEqual(response.content_type, XLSX)
                    text = self.workbook_text(content)
                    self.assertIn('高一（1）班', text)
                    self.assertIn(self.day, response.headers['Content-Disposition'])
                self.assertNotIn('高二（9）班', text)

    async def test_island_export_download_is_actual_workbook_with_saved_lessons(self):
        profile = await self.configured_island()
        teacher = await self.staff()
        await self.login_staff(teacher)
        operation = await self.prepare('island.export', classId=self.cid, status='succeeded')
        response, content = await self.download(operation)
        self.assertEqual(response.content_type, XLSX)
        text = self.workbook_text(content)
        self.assertIn('高一（1）班', text)
        self.assertIn('原课语文', text)
        parsed = import_schedule(content, profile['config'])
        self.assertEqual(parsed['lessons'], profile['config']['lessons'])
        self.assertEqual(parsed['slots'], profile['config']['slots'])

    async def test_exports_deny_explicit_out_of_scope_class(self):
        await self.export_data()
        teacher = await self.staff()
        await self.login_staff(teacher)
        for action in ('history.export', 'reading.export'):
            with self.subTest(action=action):
                operation = await self.prepare(action, {'classId': self.other}, status='failed')
                self.assertNotIn('downloadUrl', operation['result'])
                response = await self.client.get('/api/banban/operations/' + operation['id'] + '/download',
                                                 headers=self.headers())
                self.assertEqual(response.status, 400)
                self.assertNotIn('attachment', response.headers.get('Content-Disposition', ''))
        response, denied = await self.platform('island.export', classId=self.other)
        self.assertEqual(response.status, 403, denied)

    async def test_exports_apply_top_level_class_selectors_to_download_query(self):
        await self.export_data()
        teacher = await self.staff()
        response, updated = await self.json_request('PUT', '/api/teachers/' + teacher['id'] + '/classes',
            {'classIds': [self.cid, self.other]}, csrf=True)
        self.assertEqual(response.status, 200, updated)
        await self.login_staff(teacher)
        for action in ('history.export', 'reading.export'):
            payload = {'start': self.day, 'end': self.day} if action == 'reading.export' else {}
            for cid, name in ((self.cid, '高一（1）班'), (self.other, '高二（9）班')):
                for selector, value in (('className', name), ('classId', cid)):
                    with self.subTest(action=action, selector=selector, class_name=name):
                        operation = await self.prepare(action, payload, status='succeeded', **{selector: value})
                        response, content = await self.download(operation)
                        self.assertEqual(response.content_type, 'text/csv')
                        rows = list(csv.DictReader(io.StringIO(content.decode('utf-8-sig'))))
                        self.assertEqual([row['班级'] for row in rows], [name])
                        if action == 'history.export':
                            expected = '本班独有通知' if cid == self.cid else '其他班私密通知'
                            self.assertEqual(rows[0]['喊话内容'], expected)
                        else:
                            self.assertEqual((rows[0]['开始日期'], rows[0]['结束日期']), (self.day, self.day))
                            self.assertEqual(rows[0]['运行秒数'], '10' if cid == self.cid else '5')
                        stored = json.loads(self.db.one('SELECT args FROM banban_operations WHERE id=?',
                                                       (operation['id'],))['args'])
                        self.assertEqual(stored['payload']['classId'], cid)

    async def test_exports_reject_conflicting_top_level_and_payload_classes(self):
        await self.export_data()
        teacher = await self.staff()
        response, updated = await self.json_request('PUT', '/api/teachers/' + teacher['id'] + '/classes',
            {'classIds': [self.cid, self.other]}, csrf=True)
        self.assertEqual(response.status, 200, updated)
        await self.login_staff(teacher)
        for action in ('history.export', 'reading.export'):
            for cid, name, conflicting in ((self.cid, '高一（1）班', self.other),
                                            (self.other, '高二（9）班', self.cid)):
                for selector, value in (('className', name), ('classId', cid)):
                    with self.subTest(action=action, selector=selector, class_name=name):
                        payload = {'classId': conflicting}
                        if action == 'reading.export':
                            payload.update(start=self.day, end=self.day)
                        before = self.db.one('SELECT COUNT(*) n FROM banban_operations')['n']
                        response, rejected = await self.platform(action, payload, **{selector: value})
                        self.assertEqual(response.status, 400, rejected)
                        self.assertIn('error', rejected)
                        self.assertNotIn('downloadUrl', rejected.get('result', {}))
                        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM banban_operations')['n'], before)

    async def test_exports_deny_out_of_scope_top_level_class_selectors(self):
        await self.export_data()
        teacher = await self.staff()
        await self.login_staff(teacher)
        for action in ('history.export', 'reading.export'):
            payload = {'start': self.day, 'end': self.day} if action == 'reading.export' else {}
            for selector, value in (('className', '高二（9）班'), ('classId', self.other)):
                with self.subTest(action=action, selector=selector):
                    response, rejected = await self.platform(action, payload, **{selector: value})
                    self.assertEqual(response.status, 403, rejected)
                    self.assertIn('error', rejected)
                    self.assertEqual(self.db.one('SELECT COUNT(*) n FROM banban_operations')['n'], 0)

    async def test_download_rechecks_ownership_and_current_class_scope(self):
        await self.export_data()
        teacher = await self.staff()
        await self.login_staff(teacher)
        operations = []
        for action in ('history.export', 'reading.export', 'island.export'):
            if action == 'island.export':
                operation = await self.prepare(action, classId=self.cid, status='succeeded')
            else:
                operation = await self.prepare(action, {'classId': self.cid}, status='succeeded')
            operations.append(operation)
        self.as_owner()
        for operation in operations:
            with self.subTest(action=operation['action'], authorization='owner'):
                response = await self.client.get(operation['result']['downloadUrl'], headers=self.headers())
                denied = await response.json()
                self.assertIn('error', denied)
                self.assertNotIn('attachment', response.headers.get('Content-Disposition', ''))
                self.assertEqual(response.status, 403, denied)
        response, updated = await self.json_request('PUT', '/api/teachers/' + teacher['id'] + '/classes',
            {'classIds': [self.other]}, csrf=True)
        self.assertEqual(response.status, 200, updated)
        await self.login_staff(teacher)
        for operation in operations:
            with self.subTest(action=operation['action'], authorization='class_scope'):
                response = await self.client.get(operation['result']['downloadUrl'], headers=self.headers())
                denied = await response.json()
                self.assertIn('error', denied)
                self.assertNotIn('attachment', response.headers.get('Content-Disposition', ''))
                self.assertEqual(response.status, 403, denied)

    async def test_island_import_raw_workbook_previews_without_saving_then_confirms_same_id(self):
        original = await self.configured_island()
        stored = self.db.one('SELECT * FROM island_profiles WHERE class_id=?', (self.cid,))
        operation = await self.prepare('island.import', classId=self.cid, status='awaiting_input')
        self.assertEqual(operation['input'], 'island-import')
        response, preview = await self.upload(operation, self.import_file(original))
        self.assertEqual(response.status, 200, preview)
        self.assertEqual((preview['id'], preview['action'], preview['status']),
                         (operation['id'], 'island.update', 'awaiting_confirmation'))
        self.assertEqual(preview['parameters']['config']['lessons'][0]['subject'], '导入物理')
        self.assertEqual(self.db.one('SELECT * FROM island_profiles WHERE class_id=?', (self.cid,)), stored)
        self.assertEqual((await self.profile())['config'], original['config'])
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM banban_operations')['n'], 1)
        result = await self.confirm(operation)
        self.assertEqual(result['result']['revision'], original['revision'] + 1)
        saved = await self.profile()
        self.assertEqual(saved['config']['lessons'][0]['subject'], '导入物理')
        self.assertEqual(saved['config']['lessons'][0]['teacher'], '李老师')
        for key in ('appearance', 'reminders', 'components'):
            self.assertEqual(saved['config'][key], original['config'][key], key)
        await self.confirm(operation)
        self.assertEqual((await self.profile())['revision'], saved['revision'])

    async def test_island_import_malformed_file_preserves_profile_and_allows_retry(self):
        original = await self.configured_island()
        stored = self.db.one('SELECT * FROM island_profiles WHERE class_id=?', (self.cid,))
        content = self.import_file(original)
        operation = await self.prepare('island.import', classId=self.cid, status='awaiting_input')
        for malformed in (b'not an XLSX file', content[:100]):
            with self.subTest(prefix=malformed[:16]):
                response, error = await self.upload(operation, malformed)
                self.assertEqual(response.status, 400, error)
                self.assertIn('error', error)
                row = self.db.one('SELECT * FROM banban_operations WHERE id=?', (operation['id'],))
                self.assertEqual(row['status'], 'awaiting_input')
                self.assertEqual(json.loads(row['args'])['operation'], 'island.import')
                self.assertEqual(self.db.one('SELECT * FROM island_profiles WHERE class_id=?', (self.cid,)), stored)
        response, preview = await self.upload(operation, content)
        self.assertEqual(response.status, 200, preview)
        self.assertEqual((preview['id'], preview['status']), (operation['id'], 'awaiting_confirmation'))
        self.assertEqual(self.db.one('SELECT * FROM island_profiles WHERE class_id=?', (self.cid,)), stored)

    async def test_island_import_201_overrides_are_visible_saved_and_fully_inspectable(self):
        original = await self.configured_island()
        config = copy.deepcopy(original['config'])
        expected = [{'date': (datetime(2026, 10, 1) + timedelta(days=index)).date().isoformat(),
                     'slotId': 'period-1', 'subject': '临时调课' + str(index + 1),
                     'teacher': '李老师', 'location': '本班', 'cancelled': False}
                    for index in range(201)]
        config['overrides'] = expected
        operation = await self.prepare('island.import', classId=self.cid, status='awaiting_input')
        response, preview = await self.upload(operation, export_schedule(config, class_name='高一（1）班'))
        self.assertEqual(response.status, 200, preview)
        self.assertEqual((preview['id'], preview['status']), (operation['id'], 'awaiting_confirmation'))
        before_confirmation = await self.profile()
        self.assertEqual(before_confirmation['revision'], original['revision'])
        self.assertEqual(before_confirmation['config'], original['config'])
        with self.subTest(surface='confirmation_parameters'):
            self.assertEqual(len(preview['parameters']['config']['overrides']), 201)
            self.assertEqual(preview['parameters']['config']['overrides'], expected)
        result = await self.confirm(operation)
        saved = await self.profile()
        self.assertEqual(saved['revision'], original['revision'] + 1)
        self.assertEqual(result['result']['revision'], saved['revision'])
        self.assertEqual(len(saved['config']['overrides']), 201)
        self.assertEqual(saved['config']['overrides'], expected)

        response, settings = await self.json_request('PUT', '/api/banban/settings',
            {'enabled': True, 'model': 'fixture', 'apiKey': 'fixture-only'}, csrf=True)
        self.assertEqual(response.status, 200, settings)
        inspected = []

        async def provider(agent, provider_config, messages, allow_tools=True):
            if messages[-1]['role'] == 'user':
                yield {'tool_calls': [{'index': 0, 'id': 'inspect-all-overrides', 'function': {
                    'name': 'inspect_platform', 'arguments': json.dumps({'resource': 'island', 'classId': self.cid})}}]}
            else:
                inspected.extend(json.loads(message['content']) for message in messages
                                 if message['role'] == 'tool' and message.get('tool_call_id') == 'inspect-all-overrides')
                yield {'text': '已读取当前课表。'}

        with patch.object(BanbanAgent, 'provider', provider):
            response = await self.client.post('/api/banban/chat/stream',
                json={'message': '查看高一（1）班当前浮岛课表'}, headers=self.headers(csrf=True))
            self.assertEqual(response.status, 200)
            events = [json.loads(line) async for line in response.content if line.strip()]
        self.assertEqual(events[-1]['type'], 'done', events)
        self.assertEqual(len(inspected), 1)
        with self.subTest(surface='inspect_platform_island'):
            self.assertEqual(inspected[0]['revision'], saved['revision'])
            self.assertEqual(len(inspected[0]['config']['overrides']), 201)
            self.assertEqual(inspected[0]['config']['overrides'], expected)

    async def test_cancelled_island_import_cannot_upload_or_save(self):
        original = await self.configured_island()
        stored = self.db.one('SELECT * FROM island_profiles WHERE class_id=?', (self.cid,))
        content = self.import_file(original)
        for stage in ('awaiting_input', 'awaiting_confirmation'):
            with self.subTest(stage=stage):
                operation = await self.prepare('island.import', classId=self.cid, status='awaiting_input')
                if stage == 'awaiting_confirmation':
                    response, preview = await self.upload(operation, content)
                    self.assertEqual(response.status, 200, preview)
                response, cancelled = await self.json_request('POST',
                    '/api/banban/operations/' + operation['id'] + '/cancel', {}, csrf=True)
                self.assertEqual(response.status, 200, cancelled)
                self.assertEqual(cancelled['status'], 'cancelled')
                response, denied = await self.upload(operation, content)
                self.assertEqual(response.status, 400, denied)
                await self.confirm(operation, status='cancelled')
                self.assertEqual(self.db.one('SELECT * FROM island_profiles WHERE class_id=?', (self.cid,)), stored)

    async def test_island_import_confirmation_cannot_overwrite_newer_profile_revision(self):
        original = await self.configured_island()
        operation = await self.prepare('island.import', classId=self.cid, status='awaiting_input')
        response, preview = await self.upload(operation, self.import_file(original))
        self.assertEqual(response.status, 200, preview)
        newer = copy.deepcopy(original['config'])
        newer['lessons'][0]['subject'] = '其他教师最新课程'
        response, current = await self.json_request('PUT', self.island_path,
            {'config': newer, 'revision': original['revision']}, csrf=True)
        self.assertEqual(response.status, 200, current)
        stored = self.db.one('SELECT * FROM island_profiles WHERE class_id=?', (self.cid,))
        await self.confirm(operation, status='failed')
        self.assertEqual(self.db.one('SELECT * FROM island_profiles WHERE class_id=?', (self.cid,)), stored)
        self.assertEqual((await self.profile())['config']['lessons'][0]['subject'], '其他教师最新课程')


if __name__ == '__main__':
    import unittest
    unittest.main()

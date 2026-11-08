"""Exercise homework registration through the real HTTP and SQLite boundaries."""
import copy
import csv
import io
import json
import unittest
from datetime import datetime, timedelta, timezone

import app as service
from test_app import ServerTestCase


SUBJECTS = [('chinese', '语文'), ('math', '数学'), ('english', '英语'), ('physics', '物理'),
            ('chemistry', '化学'), ('biology', '生物'), ('politics', '政治'), ('history', '历史'), ('geography', '地理')]


def profile():
    return {'activeTermId': '2026-fall',
            'students': [{'id': 's1', 'name': '测试甲'}, {'id': 's2', 'name': '测试乙'}],
            'terms': [{'id': '2026-fall', 'label': '测试学期', 'subjects': [
                {'id': sid, 'name': name, 'items': ([{'id': 'math-book', 'name': '练习册', 'active': True},
                                                   {'id': 'math-paper', 'name': '试卷', 'active': True}]
                                                  if sid == 'math' else [])} for sid, name in SUBJECTS]}]}


class HomeworkTests(ServerTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.device = await self.enroll_test_device()
        self.cid = self.device['classId']
        self.db = self.app[service.STORE_KEY]
        self.day = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
        self.device_headers = {'Authorization': 'Bearer ' + self.device['deviceToken'],
                               'X-ICeClass-Device-Id': self.device['deviceId'],
                               'X-ICeClass-Class-Id': self.cid}
        self.url = f'/api/homework/classes/{self.cid}/profile'

    async def get_json(self, path, status=200, *, device=False):
        response = await self.client.get(path, headers=self.device_headers if device else self.headers())
        self.assertEqual(response.status, status, await response.text())
        return await response.json()

    async def configure(self, value=None, revision=0, status=200):
        response = await self.client.put(self.url, json={'revision': revision, 'value': value or profile()}, headers=self.headers(csrf=True))
        self.assertEqual(response.status, status, await response.text())
        return await response.json()

    async def save(self, *, expected_status=200, **changes):
        body = {'classId': self.cid, 'termId': '2026-fall', 'profileRevision': 1, 'date': self.day,
                'subjectId': 'math', 'itemId': 'math-book', 'revision': 0, 'status': 'submitted', 'missing': []}
        body.update(changes)
        response = await self.client.put('/api/homework/classroom/records', json=body, headers=self.device_headers)
        self.assertEqual(response.status, expected_status, await response.text())
        return await response.json()

    async def test_new_class_has_no_roster_and_read_does_not_register(self):
        data = await self.get_json('/api/homework/classroom', device=True)
        self.assertEqual(data['value']['students'], [])
        self.assertEqual(data['records'], [])
        await self.save(expected_status=409)
        await self.configure()
        await self.get_json('/api/homework/classroom', device=True)
        report = await self.get_json('/api/homework/report')
        self.assertEqual(report['totals']['expected'], 0)
        self.assertEqual(report['total'], 0)

    async def test_default_academic_year_uses_a_short_hyphen(self):
        data = await self.get_json('/api/homework/classroom', device=True)
        self.assertRegex(data['value']['terms'][0]['label'], r'^\d{4}-\d{4} 学年第[一二]学期$')

    async def test_legacy_academic_year_labels_display_consistently_without_rewriting_history(self):
        value = profile()
        value['terms'][0]['label'] = '2026—2027 学年第一学期'
        custom = copy.deepcopy(value['terms'][0])
        custom.update(id='project', label='项目—阶段一')
        value['terms'].append(custom)
        configured = await self.configure(value)
        expected = '2026-2027 学年第一学期'
        self.assertEqual(configured['value']['terms'][0]['label'], expected)
        self.assertEqual(configured['value']['terms'][1]['label'], '项目—阶段一')
        raw_profile = json.dumps(value, ensure_ascii=False)
        self.db.run('UPDATE homework_profiles SET value=? WHERE class_id=?', (raw_profile, self.cid))
        await self.save()
        snapshot = json.loads(self.db.one('SELECT value FROM homework_records WHERE class_id=?', (self.cid,))['value'])
        snapshot['termName'] = '2026–2027 学年第一学期'
        raw_record = json.dumps(snapshot, ensure_ascii=False)
        self.db.run('UPDATE homework_records SET value=? WHERE class_id=?', (raw_record, self.cid))
        for path, device in [(self.url, False), ('/api/homework/classroom', True)]:
            data = await self.get_json(path, device=device)
            self.assertEqual(data['revision'], 1)
            self.assertEqual(data['value']['terms'][0]['label'], expected)
            self.assertEqual(data['value']['terms'][1]['label'], '项目—阶段一')
        for group in ('assignments', 'students'):
            report = await self.get_json('/api/homework/report?group=' + group)
            self.assertTrue(report['rows'])
            self.assertTrue(all(row['termName'] == expected for row in report['rows']))
            response = await self.client.get('/api/homework/export?group=' + group, headers=self.headers())
            self.assertEqual(response.status, 200)
            rows = list(csv.reader(io.StringIO((await response.read()).decode('utf-8-sig'))))
            self.assertTrue(all(row[1] == expected for row in rows[1:]))
        self.assertEqual(self.db.one('SELECT value FROM homework_profiles WHERE class_id=?', (self.cid,))['value'], raw_profile)
        self.assertEqual(self.db.one('SELECT value FROM homework_records WHERE class_id=?', (self.cid,))['value'], raw_record)

    async def test_items_are_independent_and_resubmission_replaces_counts(self):
        await self.configure()
        saved = await self.save(missing=['s2'])
        self.assertEqual(saved['record']['revision'], 1)
        await self.save(itemId='math-paper')
        data = await self.get_json('/api/homework/classroom', device=True)
        self.assertEqual(len(data['records']), 2)
        report = await self.get_json('/api/homework/report')
        self.assertEqual(report['totals'], {'assignments': 2, 'expected': 4, 'submitted': 3, 'missing': 1, 'noHomework': 0})
        await self.save(revision=1)
        report = await self.get_json('/api/homework/report?group=students&pageSize=1')
        self.assertEqual(report['totals']['submitted'], 4)
        self.assertEqual(report['total'], 2)
        self.assertEqual(len(report['rows']), 1)
        self.assertEqual(report['rows'][0]['expected'], 2)

    async def test_no_homework_and_unregistered_excluded_from_denominator(self):
        await self.configure()
        await self.save(status='no_homework')
        report = await self.get_json('/api/homework/report')
        self.assertEqual(report['totals']['expected'], 0)
        self.assertEqual(report['totals']['noHomework'], 1)
        await self.save(itemId='math-paper', missing=['s1'])
        report = await self.get_json('/api/homework/report?group=students')
        self.assertEqual(report['totals']['expected'], 2)
        self.assertEqual(next(r for r in report['rows'] if r['studentId'] == 's1')['missing'], 1)

    async def test_conflicts_never_overwrite_saved_data(self):
        await self.configure()
        await self.save(missing=['s2'])
        await self.save(expected_status=409, missing=['s1'])
        await self.configure(revision=0, status=409)
        await self.configure(revision=1)
        await self.save(expected_status=409, revision=1)
        data = await self.get_json('/api/homework/classroom', device=True)
        self.assertEqual(data['records'][0]['missing'], ['s2'])
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM homework_records')['n'], 1)

    async def test_history_preserves_names_and_roster_after_configuration_change(self):
        await self.configure()
        await self.save(missing=['s2'])
        updated = profile()
        updated['students'] = [{'id': 's3', 'name': '新测试学生'}]
        updated['terms'][0]['subjects'][1]['items'][0]['name'] = '更名作业'
        await self.configure(updated, revision=1)
        report = await self.get_json('/api/homework/report')
        self.assertEqual(report['rows'][0]['itemName'], '练习册')
        self.assertEqual(report['rows'][0]['missingNames'], ['测试乙'])
        self.assertEqual(report['totals']['expected'], 2)

    async def test_resubmission_keeps_original_snapshot_after_roster_change(self):
        await self.configure()
        await self.save(missing=['s2'])
        updated = profile()
        updated['students'] = [{'id': 's3', 'name': '新测试学生'}]
        updated['terms'][0]['label'] = '更名学期'
        updated['terms'][0]['subjects'][1]['items'][0]['name'] = '更名作业'
        await self.configure(updated, revision=1)
        saved = await self.save(profileRevision=2, revision=1, missing=['s2'])
        self.assertEqual(saved['record']['students'], profile()['students'])
        self.assertEqual(saved['record']['itemName'], '练习册')
        self.assertEqual(saved['record']['termName'], '测试学期')
        await self.save(expected_status=400, profileRevision=2, revision=2, missing=['s3'])
        await self.save(profileRevision=2, revision=2)
        await self.save(profileRevision=2, itemId='math-paper')
        report = await self.get_json('/api/homework/report')
        self.assertEqual(report['totals']['expected'], 3)
        self.assertEqual(report['totals']['submitted'], 3)

    async def test_device_binding_disable_and_cookie_cannot_escape_scope(self):
        await self.configure()
        await self.get_json(self.url, 401, device=True)
        await self.get_json('/api/homework/classroom', 401)
        old = dict(self.device_headers)
        self.device_headers.pop('X-ICeClass-Class-Id')
        await self.get_json('/api/homework/classroom', 401, device=True)
        self.device_headers = old
        _, other = await self.json_request('POST', '/api/classes', {'name': '高二（8）班'}, csrf=True)
        self.db.run('UPDATE devices SET class_id=? WHERE id=?', (other['id'], self.device['deviceId']))
        await self.get_json('/api/homework/classroom', 401, device=True)
        await self.save(expected_status=401)
        self.db.run('UPDATE devices SET class_id=?,enabled=0 WHERE id=?', (self.cid, self.device['deviceId']))
        await self.get_json('/api/homework/classroom', 401, device=True)

    async def test_validation_and_future_dates_do_not_create_records(self):
        await self.configure()
        for changes in ({'missing': ['unknown']}, {'missing': ['s1', 's1']}, {'itemId': 'unknown'},
                        {'date': '2026-13-01'}, {'revision': True}, {'status': 'other'},
                        {'status': 'no_homework', 'missing': ['s1']}, {'subjectId': 'physics'},
                        {'date': '2099-01-01'}, {'subjectId': {}}, {'subjectId': []}):
            await self.save(expected_status=400, **changes)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM homework_records')['n'], 0)
        for changes in ({'students': [{'id': 's1', 'name': ''}]}, {'activeTermId': 'unknown'}):
            value = profile()
            value.update(changes)
            await self.configure(value, revision=1, status=400)
        value = profile()
        value['terms'][0]['subjects'][0]['id'] = {}
        await self.configure(value, revision=1, status=400)
        await self.get_json('/api/homework/report?start=2020-01-01&end=2026-01-01', 400)
        await self.get_json('/api/homework/report?group=unknown', 400)

    async def test_teacher_roles_csrf_and_live_scope(self):
        await self.configure()
        await self.save()
        admin = self.cookie, self.csrf
        _, other = await self.json_request('POST', '/api/classes', {'name': '高二（8）班'}, csrf=True)
        for username, role, fields in [('hwhead', 'teacher', {'classIds': [self.cid]}),
                                       ('hwsubject', 'subject_teacher', {'teachingClassIds': [self.cid]})]:
            response, data = await self.json_request('POST', '/api/teachers', {
                'username': username, 'displayName': username, 'role': role, 'password': 'HomeworkTest123', **fields}, csrf=True)
            self.assertEqual(response.status, 201, data)
        for username, editable in [('hwhead', True), ('hwsubject', False)]:
            response, data = await self.json_request('POST', '/api/auth/login', {'username': username, 'password': 'HomeworkTest123'})
            self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]
            self.csrf = data['user']['csrfToken']
            data = await self.get_json(self.url)
            self.assertEqual(data['canEdit'], editable)
            await self.get_json('/api/homework/report')
            await self.get_json(f"/api/homework/classes/{other['id']}/profile", 403)
            await self.get_json('/api/homework/report?classId=' + other['id'], 403)
            response, _ = await self.json_request('PUT', self.url, {'revision': 1, 'value': profile()})
            self.assertEqual(response.status, 403)
            if not editable:
                await self.configure(revision=1, status=403)
            self.cookie, self.csrf = admin

    async def test_export_uses_history_and_blocks_spreadsheet_formulas(self):
        value = profile()
        value['students'][0]['name'] = '=1+1'
        await self.configure(value)
        await self.save(missing=['s1'])
        response = await self.client.get('/api/homework/export?group=students', headers=self.headers())
        self.assertEqual(response.status, 200, await response.text())
        data = await response.read()
        self.assertTrue(data.startswith(b'\xef\xbb\xbf'))
        rows = list(csv.reader(io.StringIO(data.decode('utf-8-sig'))))
        self.assertIn("'=1+1", rows[1])
        self.assertNotIn('=1+1', rows[1])

    async def test_banban_export_produces_an_authenticated_download(self):
        await self.configure()
        await self.save(missing=['s2'])
        response, operation = await self.json_request('POST', '/api/banban/operations', {
            'kind': 'platform', 'args': {'operation': 'homework.export',
                'payload': {'classId': self.cid, 'start': self.day, 'end': self.day}},
        }, csrf=True)
        self.assertEqual(response.status, 200, operation)
        self.assertEqual(operation['status'], 'succeeded', operation)
        response = await self.client.get(operation['result']['downloadUrl'], headers=self.headers())
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(response.content_type, 'text/csv')
        rows = list(csv.DictReader(io.StringIO((await response.read()).decode('utf-8-sig'))))
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]['作业'], rows[0]['未交名单']), ('练习册', '测试乙'))

    async def test_new_semester_and_disabled_item_are_not_registerable(self):
        await self.configure()
        value = profile()
        second = copy.deepcopy(value['terms'][0])
        second['id'], second['label'] = '2027-spring', '新测试学期'
        value['terms'].append(second)
        value['activeTermId'] = second['id']
        await self.configure(value, revision=1)
        await self.save(expected_status=409, profileRevision=2)
        value['terms'][1]['subjects'][1]['items'][0]['active'] = False
        await self.configure(value, revision=2)
        await self.save(expected_status=400, profileRevision=3, termId='2027-spring')

    async def test_classroom_page_is_served_with_nonce_and_separate_device_api(self):
        response = await self.client.get('/homework/classroom/')
        self.assertEqual(response.status, 200, await response.text())
        html = await response.text()
        self.assertIn('homework-dialog', html)
        self.assertNotIn('__CSP_NONCE__', html)
        self.assertNotIn("'unsafe-inline'", response.headers['Content-Security-Policy'])
        self.assertIn('frame-ancestors', response.headers['Content-Security-Policy'])

    async def test_teacher_page_exposes_homework_navigation(self):
        response = await self.client.get('/')
        self.assertEqual(response.status, 200)
        html = await response.text()
        self.assertIn('data-view="homework"', html)
        self.assertIn('homework-admin.js', html)


if __name__ == '__main__':
    unittest.main()

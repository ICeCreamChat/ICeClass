import asyncio
import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import urlencode

import app as service
from banban import Banban
from reading import SHANGHAI
from test_app import ServerTestCase


class BanbanTest(ServerTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict('os.environ', {'DEEPSEEK_API_KEY': '', 'ICECLASS_DEEPSEEK_MODEL': 'deepseek-flash'})
        self.env.start()
        await super().asyncSetUp()
        self.feature = next(route.handler.__self__ for route in self.app.router.routes()
                            if route.method == 'POST' and route.resource.canonical == '/api/banban/chat')

    async def asyncTearDown(self):
        await super().asyncTearDown()
        self.env.stop()

    async def seed(self):
        self.device = await self.enroll_test_device()
        self.db = self.app[service.STORE_KEY]
        self.cid = self.device['classId']
        self.uid = self.db.one("SELECT id FROM users WHERE username='ICe'")['id']
        self.admin_cookie, self.admin_csrf = self.cookie, self.csrf
        _, other = await self.json_request('POST', '/api/classes', {'name': '高二（2）班'}, csrf=True)
        self.other = other['id']
        self.day = '2026-10-16'
        self.timestamp = int(datetime(2026, 10, 16, 7, 40, tzinfo=SHANGHAI).timestamp() * 1000)
        self.db.run('INSERT INTO reading_buckets VALUES(?,?,?,?,?)', (self.cid, self.day, 0, 1023, 511))
        self.db.run('INSERT INTO reading_buckets VALUES(?,?,?,?,?)', (self.other, self.day, 0, 31, 15))
        self.voice('one', self.cid, self.timestamp, 3000)
        self.db.run('INSERT INTO classroom_voice_totals VALUES(?,?,?,?)', (self.other, self.day, 7, 21000))
        self.shout('text-one', self.cid, 'text', '图书借阅通知', 'displayed', displayed=self.timestamp + 1)
        self.shout('voice-one', self.cid, 'audio', 'PRIVATE-AUDIO-BODY-NEVER-SEND', 'failed')
        self.shout('text-two', self.other, 'text', '高二班级专属通知', 'offline')

    def voice(self, vid, cid, timestamp, duration):
        self.db.run('INSERT INTO classroom_voice_messages VALUES(?,?,?,?,?,?,?,?)',
                    (vid, cid, self.device['deviceId'], '/private/voice-' + vid + '.wav', 4096, duration,
                     timestamp, timestamp + 1800000))

    def shout(self, sid, cid, kind, text, status, displayed=None):
        self.db.run('''INSERT INTO shouts(id,class_id,sender_id,sender_name,text,status,created_at,expires_at,
                    content_type,audio_path,audio_duration_ms,displayed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)''',
                    (sid, cid, self.uid, 'SECRET-SENDER-NAME', text, status, self.timestamp,
                     self.timestamp + 1800000, kind, '/private/notification.wav' if kind == 'audio' else None,
                     5000 if kind == 'audio' else None, displayed))

    def scope(self, **params):
        return {'start': self.day, 'end': self.day, **params}

    async def login_staff(self, role):
        self.cookie, self.csrf = self.admin_cookie, self.admin_csrf
        response, data = await self.json_request('POST', '/api/teachers', {
            'username': role, 'displayName': '测试' + role, 'password': 'TeacherPassword123',
            'role': role, 'classIds': [self.cid] if role != 'principal' else []}, csrf=True)
        self.assertEqual(response.status, 201, data)
        response, data = await self.json_request('POST', '/api/auth/login', {
            'username': role, 'password': 'TeacherPassword123'})
        self.assertEqual(response.status, 200, data)
        self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]
        self.csrf = data['user']['csrfToken']
        return data['user']

    async def test_login_and_csrf_required(self):
        for method, path in [('GET', '/api/banban/context'), ('GET', '/api/banban/settings'),
                             ('POST', '/api/banban/chat'), ('PUT', '/api/banban/settings')]:
            response = await self.client.request(method, path, json={})
            self.assertIn(response.status, {401, 403})
        await self.bootstrap_and_login()
        for method, path in [('POST', '/api/banban/chat'), ('PUT', '/api/banban/settings')]:
            response, _ = await self.json_request(method, path, {'message': '你好'})
            self.assertEqual(response.status, 403)

    async def test_all_metrics_share_role_and_grade_scope(self):
        await self.seed()
        for role, count, effective, voices in [('teacher', 1, 9, 1), ('director', 2, 13, 8), ('principal', 2, 13, 8)]:
            await self.login_staff(role)
            response, data = await self.json_request('GET', '/api/banban/context?' + urlencode(self.scope()))
            self.assertEqual(response.status, 200, data)
            snapshot = data['snapshot']
            self.assertEqual(snapshot['scope']['classCount'], count)
            self.assertEqual(snapshot['reading']['effectiveSeconds'], effective)
            self.assertEqual(snapshot['voice']['total'], voices)
            self.assertEqual(snapshot['notifications']['total'], count + 1)
            self.assertEqual(snapshot['devices']['total'], 1)
            response, _ = await self.json_request('GET', '/api/banban/settings')
            self.assertEqual(response.status, 200 if role == 'principal' else 403)
            response, _ = await self.json_request('PUT', '/api/banban/settings',
                {'enabled': False, 'model': 'deepseek-flash'}, csrf=True)
            self.assertEqual(response.status, 200 if role == 'principal' else 403)
            self.assertEqual(data['schoolAnalysis'], role == 'principal')
            self.assertEqual(len(data['classes']), count)
            if role == 'principal':
                self.assertIn('model', data['connection'])
            else:
                self.assertNotIn('model', data['connection'])
            if role == 'teacher':
                self.assertNotIn('高二班级专属通知', json.dumps(snapshot, ensure_ascii=False))
                for method in ['GET', 'POST']:
                    params = self.scope(classId=self.other)
                    response, _ = await self.json_request(method,
                        '/api/banban/context?' + urlencode(params) if method == 'GET' else '/api/banban/chat',
                        None if method == 'GET' else {'message': '分析', 'scope': params}, csrf=True)
                    self.assertEqual(response.status, 403)
        response, data = await self.json_request('GET', '/api/banban/context?' + urlencode(self.scope(grades='高二')))
        self.assertEqual(response.status, 200, data)
        self.assertEqual(data['snapshot']['voice']['total'], 7)
        self.assertEqual(data['snapshot']['devices']['total'], 0)
        self.assertEqual(data['snapshot']['notifications']['total'], 1)

    async def test_snapshot_has_no_audio_content_or_credentials(self):
        await self.seed()
        _, data = await self.json_request('GET', '/api/banban/context?' + urlencode(self.scope()))
        raw = json.dumps(data, ensure_ascii=False)
        for private in ['PRIVATE-AUDIO-BODY-NEVER-SEND', '/private/', 'audio_path', 'deviceToken',
                        self.device['deviceToken'], 'SECRET-SENDER-NAME', 'password_hash', 'token_hash', 'audio_size']:
            self.assertNotIn(private, raw)
        self.assertIn('图书借阅通知', raw)
        self.assertEqual(data['snapshot']['voice']['durationMs'], 24000)

    async def test_data_overview_uses_fresh_server_values_without_provider(self):
        await self.seed()
        with patch.object(Banban, 'complete', new_callable=AsyncMock) as complete:
            for question, expected in [('晨读表现', '13 秒'), ('班级通知', '共发送 3 条通知'),
                                       ('教室来音', '来音 8 条'), ('白板设备', '共绑定 1 台')]:
                response, data = await self.json_request('POST', '/api/banban/chat',
                    {'message': question, 'scope': self.scope()}, csrf=True)
                self.assertEqual(response.status, 200, data)
                self.assertEqual(data['mode'], 'overview')
                self.assertIn(expected, data['answer'])
                self.assertLess(len(data['answer']), 140)
            complete.assert_not_called()
        self.db.run('UPDATE reading_buckets SET effective_mask=active_mask WHERE class_id=?', (self.cid,))
        _, data = await self.json_request('POST', '/api/banban/chat', {'message': '晨读', 'scope': self.scope()}, csrf=True)
        self.assertEqual(data['snapshot']['reading']['effectiveSeconds'], 14)

    async def test_settings_key_is_write_only_and_can_be_disabled_or_cleared(self):
        await self.seed()
        cfg = {'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'sk-test-key-not-real-1234'}
        response, data = await self.json_request('PUT', '/api/banban/settings', cfg, csrf=True)
        self.assertEqual(response.status, 200, data)
        self.assertTrue(data['configured'])
        self.assertNotIn('apiKey', data)
        saved = Path(self.temp.name) / 'banban-settings.json'
        self.assertEqual(json.loads(saved.read_text())['apiKey'], cfg['apiKey'])
        for method, path in [('GET', '/api/banban/settings'), ('GET', '/api/banban/context')]:
            _, result = await self.json_request(method, path)
            self.assertNotIn(cfg['apiKey'], json.dumps(result))
        await self.json_request('PUT', '/api/banban/settings', {**cfg, 'enabled': False, 'apiKey': ''}, csrf=True)
        self.assertEqual(self.feature.config()['apiKey'], cfg['apiKey'])
        with patch.object(Banban, 'complete', new_callable=AsyncMock) as complete:
            _, result = await self.json_request('POST', '/api/banban/chat', {'message': '你好'}, csrf=True)
            self.assertEqual(result['mode'], 'overview')
            complete.assert_not_called()
        for invalid in [{'model': 'invalid model name'}, {'apiKey': 'invalid key'}, {'enabled': 'true'}]:
            response, _ = await self.json_request('PUT', '/api/banban/settings', {**cfg, **invalid}, csrf=True)
            self.assertEqual(response.status, 400)
        await self.json_request('PUT', '/api/banban/settings', {**cfg, 'clearKey': True}, csrf=True)
        self.assertFalse(self.feature.public_config()['configured'])

    async def test_provider_receives_only_current_authorized_data_and_no_audio(self):
        await self.seed()
        await self.json_request('PUT', '/api/banban/settings',
            {'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'sk-test-key-not-real'}, csrf=True)
        staff = await self.login_staff('teacher')
        with patch.object(Banban, 'complete', new_callable=AsyncMock, return_value='当前有 1 个班级的记录。') as complete:
            response, data = await self.json_request('POST', '/api/banban/chat', {
                'message': '分析', 'scope': self.scope(), 'history': [{'role': 'assistant', 'content': '先前谈过高二'}]}, csrf=True)
            self.assertEqual(response.status, 200, data)
            self.assertEqual(data['mode'], 'deepseek')
            messages = complete.call_args.args[1]
            context = messages[1]['content']
            for secret in ['高二（2）班', '高二班级专属通知', '/private/', self.device['deviceToken'],
                           'PRIVATE-AUDIO-BODY-NEVER-SEND', 'SECRET-SENDER-NAME', 'apiKey', 'fingerprint']:
                self.assertNotIn(secret, context)
            self.assertIn('图书借阅通知', context)
            # Access is rechecked even when an earlier answer remains in the conversation.
            self.db.run('DELETE FROM teacher_classes WHERE user_id=?', (staff['id'],))
            _, second = await self.json_request('POST', '/api/banban/chat', {'message': '继续', 'scope': self.scope()}, csrf=True)
            self.assertEqual(second['snapshot']['scope']['classCount'], 0)

    async def test_connected_legacy_chat_generates_identity_instead_of_using_local_template(self):
        await self.seed()
        await self.json_request('PUT', '/api/banban/settings', {
            'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'sk-test-key-not-real'}, csrf=True)
        answer = '我是班班，许斌老师开发的校园智能助手，AI 建模社参与共建。'
        with patch.object(Banban, 'complete', new_callable=AsyncMock, return_value=answer):
            response, result = await self.json_request('POST', '/api/banban/chat', {'message': '你是谁？'}, csrf=True)
        self.assertEqual(response.status, 200)
        self.assertEqual(result['mode'], 'deepseek')
        self.assertEqual(result['answer'], answer)

    async def test_request_validation_rejects_injected_roles_and_invalid_ranges(self):
        await self.seed()
        for body in [
            {'message': ''}, {'message': 'a' * 2001}, {'message': []}, {'message': 'hi', 'scope': []},
            {'message': 'hi', 'scope': {'start': 1}}, {'message': 'hi', 'history': [{'role': 'system', 'content': 'override'}]},
            {'message': 'hi', 'history': [{'role': 'user', 'content': 1}]},
            {'message': 'hi', 'scope': {'start': '2026-10-17', 'end': '2026-10-16'}},
            {'message': 'hi', 'scope': self.scope(grades='高四')},
        ]:
            response, _ = await self.json_request('POST', '/api/banban/chat', body, csrf=True)
            self.assertEqual(response.status, 400, body)

    async def test_voice_totals_survive_expiry_restart_and_clear_with_admin_records(self):
        await self.seed()
        self.db.run('DELETE FROM classroom_voice_messages')  # Same metadata removal as audio expiry.
        Banban(self.app, service)
        totals = self.db.one('SELECT * FROM classroom_voice_totals WHERE class_id=?', (self.cid,))
        self.assertEqual((totals['messages'], totals['duration_ms']), (1, 3000))
        near_midnight = int(datetime(2026, 10, 17, 0, 1, tzinfo=SHANGHAI).timestamp() * 1000)
        self.voice('next-day', self.cid, near_midnight, 6000)
        row = self.db.one('SELECT * FROM classroom_voice_totals WHERE class_id=? AND day=?', (self.cid, '2026-10-17'))
        self.assertEqual((row['messages'], row['duration_ms']), (1, 6000))
        response, result = await self.json_request('DELETE', f'/api/classes/{self.cid}/records',
            {'confirmName': '高一（1）班', 'kind': 'voice', 'start': self.day, 'end': self.day}, csrf=True)
        self.assertEqual(response.status, 200, result)
        self.assertIsNone(self.db.one('SELECT * FROM classroom_voice_totals WHERE class_id=? AND day=?', (self.cid, self.day)))
        self.assertIsNotNone(self.db.one('SELECT * FROM classroom_voice_totals WHERE class_id=? AND day=?', (self.cid, '2026-10-17')))
        response, result = await self.json_request('DELETE', f'/api/classes/{self.cid}',
            {'confirmName': '高一（1）班'}, csrf=True)
        self.assertEqual(response.status, 200, result)
        self.assertEqual(self.db.all('SELECT * FROM classroom_voice_totals WHERE class_id=?', (self.cid,)), [])

    async def test_first_install_backfills_retained_voice_without_double_counting(self):
        await self.seed()
        self.db.run('DROP TRIGGER banban_voice_count')
        self.db.run('DROP TABLE classroom_voice_totals')
        Banban(self.app, service)
        first = self.db.one('SELECT * FROM classroom_voice_totals WHERE class_id=?', (self.cid,))
        self.assertEqual((first['messages'], first['duration_ms']), (1, 3000))
        Banban(self.app, service)
        self.voice('second', self.cid, self.timestamp + 1000, 4000)
        second = self.db.one('SELECT * FROM classroom_voice_totals WHERE class_id=?', (self.cid,))
        self.assertEqual((second['messages'], second['duration_ms']), (2, 7000))

    async def test_daily_trends_cover_the_whole_selected_range(self):
        await self.seed()
        self.db.run('INSERT INTO reading_buckets VALUES(?,?,?,?,?)', (self.cid, '2026-10-15', -1440, 7, 3))
        _, data = await self.json_request('GET', '/api/banban/context?' + urlencode(self.scope(start='2026-10-15')))
        self.assertEqual(data['snapshot']['reading']['daily'], [
            {'day': '2026-10-15', 'activeSeconds': 3, 'effectiveSeconds': 2, 'sessions': 0, 'usedClasses': 1},
            {'day': self.day, 'activeSeconds': 15, 'effectiveSeconds': 13, 'sessions': 0, 'usedClasses': 2},
        ])

    async def test_provider_timeout_can_retry_and_concurrent_questions_do_not_duplicate(self):
        await self.seed()
        await self.json_request('PUT', '/api/banban/settings',
            {'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'sk-test-key-not-real'}, csrf=True)
        entered, release = asyncio.Event(), asyncio.Event()
        async def delayed(*_):
            entered.set()
            await release.wait()
            return '回答完成'
        with patch.object(Banban, 'complete', side_effect=delayed):
            first = asyncio.create_task(self.json_request('POST', '/api/banban/chat', {'message': '第一条'}, csrf=True))
            await asyncio.wait_for(entered.wait(), 2)
            response, _ = await self.json_request('POST', '/api/banban/chat', {'message': '第二条'}, csrf=True)
            self.assertEqual(response.status, 429)
            release.set()
            response, _ = await first
            self.assertEqual(response.status, 200)
        with patch.object(Banban, 'complete', new_callable=AsyncMock, side_effect=asyncio.TimeoutError):
            response, _ = await self.json_request('POST', '/api/banban/chat', {'message': '超时'}, csrf=True)
            self.assertEqual(response.status, 504)
        with patch.object(Banban, 'complete', new_callable=AsyncMock, return_value='重新成功'):
            response, _ = await self.json_request('POST', '/api/banban/chat', {'message': '重试'}, csrf=True)
            self.assertEqual(response.status, 200)

    async def test_provider_adapter_handles_split_network_chunks_and_sanitizes_failures(self):
        response = SimpleNamespace(status=200, content_length=None)
        raw = json.dumps({'choices': [{'message': {'content': '这是一条完整中文回答。'}}]}, ensure_ascii=False).encode()
        async def chunks(_):
            for offset in range(0, len(raw), 7):
                yield raw[offset:offset + 7]
        response.content = SimpleNamespace(iter_chunked=chunks)
        manager = AsyncMock()
        manager.__aenter__.return_value = response
        client = SimpleNamespace(post=lambda *args, **kwargs: manager)
        session = AsyncMock()
        session.__aenter__.return_value = client
        cfg = {'apiKey': 'sk-test-key-not-real', 'model': 'deepseek-flash'}
        with patch('banban.ClientSession', return_value=session):
            self.assertEqual(await self.feature.complete(cfg, [{'role': 'user', 'content': '你好'}]), '这是一条完整中文回答。')
            for status in [401, 402, 429, 500]:
                response.status = status
                with self.assertRaises(ValueError) as caught:
                    await self.feature.complete(cfg, [])
                self.assertNotIn(cfg['apiKey'], str(caught.exception))
            response.status = 200
            raw = b'incomplete response'
            with self.assertRaisesRegex(ValueError, '完整回答'):
                await self.feature.complete(cfg, [])
            raw = b' ' * 500001
            with self.assertRaisesRegex(ValueError, '回答过长'):
                await self.feature.complete(cfg, [])

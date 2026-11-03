"""A bound classroom uses its current homeroom teacher without a password."""
from __future__ import annotations

import asyncio
import json
from banban_history import BanbanHistory
from test_app import ServerTestCase
import app as service


class ClassroomBanbanTest(ServerTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.device = await self.enroll_test_device()
        self.db = self.app[service.STORE_KEY]
        self.cid = self.device['classId']
        self.teacher = await self.add_teacher('homeroom', [self.cid])
        self.agent = next(r.handler.__self__ for r in self.app.router.routes()
                          if r.method == 'POST' and r.resource.canonical == '/api/banban/chat/stream')

    async def add_teacher(self, name, classes):
        response, data = await self.json_request('POST', '/api/teachers', {
            'username': name, 'displayName': name, 'password': 'TeacherPassword123',
            'role': 'teacher', 'classIds': classes,
        }, csrf=True)
        self.assertEqual(response.status, 201, data)
        return data['id']

    def classroom_headers(self, proof=None, **overrides):
        headers = {
            'Authorization': 'Bearer ' + self.device['deviceToken'],
            'X-ICeClass-Device': self.device['deviceId'],
            'X-ICeClass-Class': self.cid,
        }
        if proof is not None:
            headers['X-CSRF-Token'] = proof
        headers.update(overrides)
        return headers

    async def identity(self):
        response = await self.client.get('/api/session', headers=self.classroom_headers())
        data = await response.json()
        self.assertEqual(response.status, 200, data)
        self.assertTrue(data['authenticated'], data)
        return data['user']

    async def teacher_login(self):
        response = await self.client.post('/api/auth/login', json={
            'username': 'homeroom', 'password': 'TeacherPassword123'})
        data = await response.json()
        self.assertEqual(response.status, 200, data)
        return data['user'], {'Cookie': response.headers['Set-Cookie'].split(';', 1)[0],
                              'X-CSRF-Token': data['user']['csrfToken']}

    def add_message(self, user, cid, content):
        self.agent.history.append(user, cid, self.agent.access(user), {},
                                  [{'role': 'user', 'content': content}])

    async def test_classroom_session_does_not_expose_teacher_login_name(self):
        identity = await self.identity()
        self.assertNotIn('homeroom', json.dumps(identity))
        teacher, _ = await self.teacher_login()
        self.assertEqual(teacher['username'], 'homeroom')

    async def test_teacher_chat_is_unreadable_unopenable_and_undeletable_from_classroom(self):
        teacher, teacher_headers = await self.teacher_login()
        private_id = self.agent.history.create(teacher)['id']
        self.add_message(teacher, private_id, '班主任的私人对话')
        classroom = await self.identity()
        headers = self.classroom_headers(classroom['csrfToken'])
        for path in ('/api/banban/conversation', '/api/banban/conversations'):
            response = await self.client.get(path, headers=headers)
            data = await response.json()
            self.assertEqual(response.status, 200, data)
            self.assertNotIn('班主任的私人对话', json.dumps(data, ensure_ascii=False))
        for method, path, body, status in (
            ('GET', '/api/banban/conversation?conversationId=' + private_id, None, 404),
            ('POST', f'/api/banban/conversations/{private_id}/open', {}, 404),
            ('DELETE', '/api/banban/conversations/' + private_id, None, 404),
            ('POST', '/api/banban/chat/stream', {'message': '继续', 'conversationId': private_id}, 400),
        ):
            response = await self.client.request(method, path, json=body, headers=headers)
            data = await response.json()
            self.assertEqual(response.status, status, data)
            self.assertNotIn('班主任的私人对话', json.dumps(data, ensure_ascii=False))
        response = await self.client.get('/api/banban/conversation?conversationId=' + private_id,
                                         headers=teacher_headers)
        self.assertEqual((await response.json())['messages'][0]['content'], '班主任的私人对话')

    async def test_classroom_chat_is_separate_and_does_not_switch_teachers_active_thread(self):
        teacher, teacher_headers = await self.teacher_login()
        first = self.agent.history.create(teacher)['id']
        self.add_message(teacher, first, '第一段教师对话')
        second = self.agent.history.create(teacher)['id']
        self.add_message(teacher, second, '第二段教师对话')
        self.agent.history.open(teacher, first)
        classroom = await self.identity()
        headers = self.classroom_headers(classroom['csrfToken'])
        response = await self.client.post('/api/banban/conversations', json={}, headers=headers)
        own = await response.json()
        self.assertEqual(response.status, 201, own)
        self.add_message(classroom, own['id'], '教室里的共同对话')
        response = await self.client.get('/api/banban/conversation', headers=teacher_headers)
        self.assertEqual((await response.json())['id'], first)
        response = await self.client.get('/api/banban/conversations', headers=headers)
        self.assertEqual([c['id'] for c in (await response.json())['conversations']], [own['id']])
        response = await self.client.get('/api/banban/conversations', headers=teacher_headers)
        self.assertEqual({c['id'] for c in (await response.json())['conversations']}, {first, second})
        response = await self.client.delete('/api/banban/conversations/' + own['id'], headers=teacher_headers)
        self.assertEqual(response.status, 404, await response.json())
        response = await self.client.delete('/api/banban/conversations/' + own['id'], headers=headers)
        self.assertEqual(response.status, 200, await response.json())
        self.assertIsNotNone(self.agent.history.get(teacher, first))
        self.assertIsNotNone(self.agent.history.get(teacher, second))

    async def test_classroom_cannot_read_teachers_operation_cards(self):
        teacher, _ = await self.teacher_login()
        private_id = self.agent.history.create(teacher)['id']
        classroom = await self.identity()
        headers = self.classroom_headers(classroom['csrfToken'])
        timestamp = service.now_ms()
        for oid, conversation in (('teacher-operation', private_id), ('standalone-teacher-operation', None)):
            self.db.run('''INSERT INTO banban_operations
                (id,actor_id,conversation_id,kind,title,args,target,class_id,status,created_at,updated_at,
                 expires_at,request_key,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                (oid, self.teacher, conversation, 'platform', '教师私人操作',
                 json.dumps({'operation': 'notice.send', 'payload': {'text': '私人操作内容'}}),
                 '本班', self.cid, 'succeeded', timestamp, timestamp, timestamp + 60000, oid, 'fixture'))
        response = await self.client.get('/api/banban/operations', headers=headers)
        data = await response.json()
        self.assertEqual(response.status, 200, data)
        self.assertEqual(data['operations'], [])
        for oid in ('teacher-operation', 'standalone-teacher-operation'):
            response = await self.client.get('/api/banban/operations/' + oid, headers=headers)
            data = await response.json()
            self.assertEqual(response.status, 403, data)
            self.assertNotIn('私人操作内容', json.dumps(data, ensure_ascii=False))
        response = await self.client.post('/api/banban/operations', headers=headers, json={
            'kind': 'platform', 'args': {'operation': 'notice.send', 'classId': self.cid,
                                        'payload': {'text': '教室测试操作', 'alertLevel': 'info'}}})
        own = await response.json()
        self.assertEqual(response.status, 200, own)
        row = self.db.one('SELECT conversation_id FROM banban_operations WHERE id=?', (own['id'],))
        self.assertIsNotNone(self.agent.history.get(classroom, row['conversation_id']))
        response = await self.client.get('/api/banban/operations', headers=headers)
        self.assertEqual([o['id'] for o in (await response.json())['operations']], [own['id']])
        response = await self.client.get('/api/banban/operations/' + own['id'], headers=headers)
        self.assertEqual(response.status, 200, await response.json())

    async def test_classroom_stream_stores_its_own_history_without_teacher_password(self):
        teacher, teacher_headers = await self.teacher_login()
        private_id = self.agent.history.create(teacher)['id']
        self.add_message(teacher, private_id, '教师端保留的对话')
        classroom = await self.identity()
        headers = self.classroom_headers(classroom['csrfToken'])
        response = await self.client.post('/api/banban/chat/stream', json={'message': '你好'}, headers=headers)
        self.assertEqual(response.status, 200)
        events = [json.loads(line) async for line in response.content if line.strip()]
        self.assertEqual(events[-1]['type'], 'done', events)
        self.assertNotEqual(events[-1]['conversationId'], private_id)
        response = await self.client.get('/api/banban/conversation', headers=headers)
        self.assertEqual((await response.json())['messages'][0]['content'], '你好')
        response = await self.client.get('/api/banban/conversation', headers=teacher_headers)
        self.assertEqual((await response.json())['id'], private_id)

    async def test_classroom_cancel_does_not_stop_teacher_answer(self):
        classroom = await self.identity()
        headers = self.classroom_headers(classroom['csrfToken'])
        teacher_job = asyncio.create_task(asyncio.Event().wait())
        self.agent.jobs[self.teacher] = teacher_job
        self.agent.f.busy.add(self.teacher)
        try:
            response = await self.client.post('/api/banban/chat/cancel', json={}, headers=headers)
            self.assertEqual(response.status, 200, await response.json())
            self.assertFalse(teacher_job.done())
            response = await self.client.post('/api/banban/conversations', json={}, headers=headers)
            self.assertEqual(response.status, 201, await response.json())
        finally:
            teacher_job.cancel()
            await asyncio.gather(teacher_job, return_exceptions=True)
            self.agent.jobs.pop(self.teacher, None)
            self.agent.f.busy.discard(self.teacher)

    async def test_active_thread_migration_preserves_teacher_selection(self):
        teacher, _ = await self.teacher_login()
        first = self.agent.history.create(teacher)['id']
        self.add_message(teacher, first, '旧版第一段')
        second = self.agent.history.create(teacher)['id']
        self.add_message(teacher, second, '旧版第二段')
        self.db.run('DROP TABLE banban_active_conversations')
        self.db.run('''CREATE TABLE banban_active_conversations(
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            conversation_id TEXT NOT NULL REFERENCES banban_conversations(id) ON DELETE CASCADE)''')
        self.db.run('INSERT INTO banban_active_conversations VALUES(?,?)', (self.teacher, first))
        history = BanbanHistory(self.db, service.now_ms, self.agent.access)
        self.assertEqual(history.load(teacher)['id'], first)
        classroom = await self.identity()
        own = history.create(classroom)['id']
        history.append(classroom, own, self.agent.access(classroom), {}, [{'role': 'user', 'content': '教室对话'}])
        self.assertEqual(history.load(teacher)['id'], first)
        again = BanbanHistory(self.db, service.now_ms, self.agent.access)
        self.assertEqual(again.load(teacher)['id'], first)
        self.assertEqual(again.load(classroom)['id'], own)

    async def test_binding_selects_teacher_without_login_or_new_session(self):
        before = self.db.one('SELECT COUNT(*) AS n FROM sessions')['n']
        identity = await self.identity()
        self.assertEqual(identity['id'], self.teacher)
        self.assertEqual(identity['role'], 'teacher')
        self.assertEqual(identity['classroom']['classId'], self.cid)
        self.assertFalse(identity['permissions']['manageUsers'])
        self.assertTrue(identity['csrfToken'])
        self.assertEqual(self.db.one('SELECT COUNT(*) AS n FROM sessions')['n'], before)

    async def test_subject_assignments_do_not_replace_or_duplicate_homeroom_identity(self):
        response, data = await self.json_request('POST', '/api/teachers', {
            'username': 'subject.only', 'displayName': '任课老师', 'role': 'subject_teacher',
            'password': 'SchoolTest2026', 'teachingClassIds': [self.cid]}, csrf=True)
        self.assertEqual(response.status, 201, data)
        identity = await self.identity()
        self.assertEqual(identity['id'], self.teacher)
        self.db.run('DELETE FROM teacher_classes WHERE user_id=?', (self.teacher,))
        response = await self.client.get('/api/session', headers=self.classroom_headers())
        data = await response.json()
        self.assertEqual(response.status, 401, data)
        self.assertIn('尚未分配', data['error'])

    async def test_cookie_cannot_override_or_rescue_classroom_identity(self):
        response = await self.client.get('/api/session', headers=self.classroom_headers(Cookie=self.cookie))
        self.assertEqual((await response.json())['user']['id'], self.teacher)
        for headers in (
            self.classroom_headers(Authorization='Bearer invalid', Cookie=self.cookie),
            self.classroom_headers(Authorization='', Cookie=self.cookie),
            self.classroom_headers(**{'X-ICeClass-Class': 'another-class', 'Cookie': self.cookie}),
        ):
            with self.subTest(headers=list(headers)):
                response = await self.client.get('/api/session', headers=headers)
                data = await response.json()
                self.assertEqual(response.status, 401, data)
                self.assertFalse(data['authenticated'])
                self.assertNotIn('user', data)

    async def test_requires_one_active_homeroom_teacher(self):
        self.db.run('DELETE FROM teacher_classes WHERE class_id=?', (self.cid,))
        response = await self.client.get('/api/session', headers=self.classroom_headers())
        data = await response.json()
        self.assertEqual(response.status, 401, data)
        self.assertIn('班主任', data['error'])
        self.db.run('INSERT INTO teacher_classes VALUES(?,?)', (self.teacher, self.cid))
        await self.add_teacher('second', [self.cid])
        response = await self.client.get('/api/session', headers=self.classroom_headers())
        data = await response.json()
        self.assertEqual(response.status, 401, data)
        self.assertIn('多位', data['error'])

    async def test_disabled_deleted_or_reassigned_entities_stop_access(self):
        identity = await self.identity()
        headers = self.classroom_headers(identity['csrfToken'])
        for table, key, value, column, changed, restored in (
            ('devices', 'id', self.device['deviceId'], 'enabled', 0, 1),
            ('devices', 'id', self.device['deviceId'], 'deleted_at', 1, None),
            ('classes', 'id', self.cid, 'enabled', 0, 1),
            ('users', 'id', self.teacher, 'enabled', 0, 1),
            ('users', 'id', self.teacher, 'deleted_at', 1, None),
            ('users', 'id', self.teacher, 'role', 'principal', 'teacher'),
        ):
            with self.subTest(table=table, column=column):
                self.db.run(f'UPDATE {table} SET {column}=? WHERE {key}=?', (changed, value))
                response = await self.client.get('/api/classes', headers=headers)
                self.assertEqual(response.status, 401, await response.json())
                self.db.run(f'UPDATE {table} SET {column}=? WHERE {key}=?', (restored, value))

    async def test_teacher_change_invalidates_old_read_and_write_requests(self):
        identity = await self.identity()
        replacement = await self.add_teacher('replacement', [])
        self.db.run('DELETE FROM teacher_classes WHERE class_id=?', (self.cid,))
        self.db.run('INSERT INTO teacher_classes VALUES(?,?)', (replacement, self.cid))
        for method, path, body in (
            ('GET', '/api/banban/conversation', None),
            ('POST', '/api/banban/conversations', {}),
        ):
            response = await self.client.request(method, path, json=body,
                                                 headers=self.classroom_headers(identity['csrfToken']))
            self.assertEqual(response.status, 401, await response.json())
        fresh = await self.identity()
        self.assertEqual(fresh['id'], replacement)
        self.assertNotEqual(fresh['csrfToken'], identity['csrfToken'])
        response = await self.client.get('/api/classes', headers=self.classroom_headers(fresh['csrfToken']))
        self.assertEqual(response.status, 200, await response.json())

    async def test_token_rotation_and_device_rebinding_invalidate_snapshot(self):
        identity = await self.identity()
        headers = self.classroom_headers(identity['csrfToken'])
        self.db.run('UPDATE devices SET token_hash=? WHERE id=?',
                    (service.sha256('rotated-token'), self.device['deviceId']))
        response = await self.client.get('/api/classes', headers=headers)
        self.assertEqual(response.status, 401, await response.json())
        self.db.run('UPDATE devices SET token_hash=? WHERE id=?',
                    (service.sha256(self.device['deviceToken']), self.device['deviceId']))
        _, other = await self.json_request('POST', '/api/classes', {'name': '高二（2）班'}, csrf=True)
        self.db.run('UPDATE devices SET class_id=? WHERE id=?', (other['id'], self.device['deviceId']))
        response = await self.client.get('/api/session', headers=self.classroom_headers())
        self.assertEqual(response.status, 401, await response.json())

    async def test_account_settings_and_history_belong_to_teacher_and_current_class(self):
        _, other = await self.json_request('POST', '/api/classes', {'name': '高二（2）班'}, csrf=True)
        self.db.run('INSERT INTO teacher_classes VALUES(?,?)', (self.teacher, other['id']))
        self.db.run('INSERT INTO banban_connections VALUES(?,?,?,?,?,?)',
                    (self.teacher, 'personal', 1, 'https://api.deepseek.com/v1', 'teacher-model', 'test-secret'))
        identity = await self.identity()
        headers = self.classroom_headers(identity['csrfToken'])
        response = await self.client.get('/api/classes', headers=headers)
        self.assertEqual([c['id'] for c in (await response.json())['classes']], [self.cid])
        response = await self.client.get('/api/banban/connection', headers=headers)
        data = await response.json()
        self.assertEqual(response.status, 200, data)
        self.assertEqual(data['personal']['model'], 'teacher-model')
        self.assertNotIn('test-secret', str(data))
        response = await self.client.post('/api/banban/conversations', json={}, headers=headers)
        data = await response.json()
        self.assertEqual(response.status, 201, data)
        self.assertEqual(self.db.one('SELECT user_id FROM banban_conversations')['user_id'], self.teacher)
        response = await self.client.get('/api/teachers', headers=headers)
        self.assertEqual(response.status, 403, await response.json())

    async def test_classroom_requests_need_current_proof_and_normal_login_keeps_csrf(self):
        await self.identity()
        for method, path, body in (
            ('GET', '/api/classes', None), ('POST', '/api/banban/conversations', {}),
        ):
            for proof in (None, 'invalid', 'é'):
                response = await self.client.request(method, path, json=body, headers=self.classroom_headers(proof))
                self.assertEqual(response.status, 401, await response.json())
        response, data = await self.json_request('GET', '/api/session')
        self.assertEqual(response.status, 200, data)
        self.assertEqual(data['user']['role'], 'superadmin')
        response, data = await self.json_request('POST', '/api/banban/conversations', {})
        self.assertEqual(response.status, 403, data)
        response, data = await self.json_request('POST', '/api/banban/conversations', {}, csrf=True)
        self.assertEqual(response.status, 201, data)

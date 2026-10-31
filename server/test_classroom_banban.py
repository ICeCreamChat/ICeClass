"""A bound classroom uses its current homeroom teacher without a password."""
from __future__ import annotations

from test_app import ServerTestCase
import app as service


class ClassroomBanbanTest(ServerTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.device = await self.enroll_test_device()
        self.db = self.app[service.STORE_KEY]
        self.cid = self.device['classId']
        self.teacher = await self.add_teacher('homeroom', [self.cid])

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

    async def test_binding_selects_teacher_without_login_or_new_session(self):
        before = self.db.one('SELECT COUNT(*) AS n FROM sessions')['n']
        identity = await self.identity()
        self.assertEqual(identity['id'], self.teacher)
        self.assertEqual(identity['role'], 'teacher')
        self.assertEqual(identity['classroom']['classId'], self.cid)
        self.assertFalse(identity['permissions']['manageUsers'])
        self.assertTrue(identity['csrfToken'])
        self.assertEqual(self.db.one('SELECT COUNT(*) AS n FROM sessions')['n'], before)

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

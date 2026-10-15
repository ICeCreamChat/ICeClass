import uuid
from unittest.mock import patch

from aiohttp import WSServerHandshakeError, WSMsgType

import app as service
from reading import local_day
from test_app import ServerTestCase


class ManagementTest(ServerTestCase):
    async def test_grade_roster_can_grow_and_change_without_replacing_class_ids(self):
        device = await self.enroll_test_device()
        for grade, count in [('高一', 16), ('高二', 14), ('高三', 14)]:
            response, result = await self.json_request('POST', '/api/classes/batch',
                                                      {'grade': grade, 'start': 1, 'end': count}, csrf=True)
            self.assertEqual(response.status, 200, result)
            self.assertEqual(len(result['created']) + result['skipped'], count)
        await self.json_request('POST', '/api/enrollment/school-code', {'code': 'mas22'}, csrf=True)

        async def roster():
            response = await self.client.post('/api/device/enrollment/classes', json={'code': 'mas22'})
            self.assertEqual(response.status, 200)
            return (await response.json())['classes']

        initial = await roster()
        self.assertEqual(len(initial), 44)
        self.assertEqual(initial[0], {'id': device['classId'], 'name': '高一（1）班'})
        self.assertEqual([c['name'] for c in initial[:16]], [f'高一（{n}）班' for n in range(1, 17)])
        last = initial[-1]
        await self.json_request('POST', '/api/classes/batch', {'grade': '高一', 'start': 17, 'end': 17}, csrf=True)
        await self.json_request('PATCH', '/api/classes/' + last['id'], {'name': '高三（15）班'}, csrf=True)
        refreshed = await roster()
        self.assertEqual(len(refreshed), 45)
        self.assertEqual(refreshed[16]['name'], '高一（17）班')
        self.assertEqual(refreshed[-1], {'id': last['id'], 'name': '高三（15）班'})
        await self.json_request('PATCH', '/api/classes/' + last['id'], {'enabled': False}, csrf=True)
        self.assertNotIn(last['id'], [c['id'] for c in await roster()])
        response = await self.client.post('/api/device/enroll', json={'code': 'mas22', 'classId': last['id']})
        self.assertEqual(response.status, 404)
        self.assertEqual(self.app[service.STORE_KEY].one('SELECT class_id FROM devices WHERE id=?',
                                                       (device['deviceId'],))['class_id'], device['classId'])

    def seed_reading(self, device):
        db = self.app[service.STORE_KEY]
        now, sid = service.now_ms(), str(uuid.uuid4())
        day = local_day(now)
        db.run('INSERT INTO reading_sessions VALUES(?,?,?,?,?,?)', (sid, device['deviceId'], device['classId'], 'classic', now, now))
        db.run('INSERT INTO reading_session_days VALUES(?,?)', (sid, day))
        db.run('INSERT INTO reading_buckets VALUES(?,?,?,?,?)', (device['classId'], day, now//10000, 3, 1))
        db.run('INSERT INTO reading_events VALUES(?,?,?,?,?,?,?,1)', (str(uuid.uuid4()), sid, device['classId'], day, now, 'carrots', '完成'))
        return sid, day

    async def teacher(self, cid, role='teacher'):
        response, data = await self.json_request('POST', '/api/teachers', {'username': 'staff1', 'displayName': '测试老师', 'password': 'TeacherPassword123', 'role': role, 'classIds': [cid]}, csrf=True)
        self.assertEqual(response.status, 201, data)
        return data

    async def test_delete_class_cleans_dependencies_and_keeps_other_classes(self):
        device = await self.enroll_test_device()
        db = self.app[service.STORE_KEY]
        sid, _ = self.seed_reading(device)
        staff = await self.teacher(device['classId'])
        _, other = await self.json_request('POST', '/api/classes', {'name': '其他班级'}, csrf=True)
        await self.json_request('POST', '/api/classes/' + device['classId'] + '/enrollment-code', {}, csrf=True)
        await self.json_request('POST', '/api/classes/' + device['classId'] + '/control', {'action': 'set_volume', 'volume': 30}, csrf=True)
        await self.json_request('POST', '/api/shouts', {'classId': device['classId'], 'text': '待删除通知'}, csrf=True)
        db.run('INSERT INTO reading_launches VALUES(?,?,?)', ('launch', device['deviceId'], service.now_ms()+100000))
        db.run('INSERT INTO reading_browser_sessions VALUES(?,?,?)', ('browser', device['deviceId'], service.now_ms()+100000))
        db.run('INSERT INTO device_telemetry(device_id,reported_at) VALUES(?,?)', (device['deviceId'], service.now_ms()))
        path = '/api/classes/' + device['classId']
        response, _ = await self.json_request('DELETE', path, {'confirmName': '高一（1）班'})
        self.assertEqual(response.status, 403)
        response, _ = await self.json_request('DELETE', path, {'confirmName': '错误班级'}, csrf=True)
        self.assertEqual(response.status, 400)
        response, data = await self.json_request('DELETE', path, {'confirmName': '高一（1）班'}, csrf=True)
        self.assertEqual(response.status, 200, data)
        self.assertIsNone(db.one('SELECT id FROM classes WHERE id=?', (device['classId'],)))
        self.assertIsNotNone(db.one('SELECT id FROM classes WHERE id=?', (other['id'],)))
        for table in ('reading_events', 'reading_buckets', 'reading_sessions', 'shouts', 'devices', 'enrollment_codes', 'teacher_classes', 'classroom_controls'):
            self.assertEqual(db.one(f'SELECT COUNT(*) n FROM {table} WHERE class_id=?', (device['classId'],))['n'], 0, table)
        self.assertEqual(db.all('PRAGMA foreign_key_check'), [])

    async def test_deleted_user_session_revoked_history_preserved_username_reusable(self):
        device = await self.enroll_test_device()
        admin_cookie, admin_csrf = self.cookie, self.csrf
        staff = await self.teacher(device['classId'])
        response, login = await self.json_request('POST', '/api/auth/login', {'username': 'staff1', 'password': 'TeacherPassword123'})
        teacher_cookie = response.headers['Set-Cookie'].split(';', 1)[0]
        self.cookie, self.csrf = teacher_cookie, login['user']['csrfToken']
        response, shout = await self.json_request('POST', '/api/shouts', {'classId': device['classId'], 'text': '保留历史作者'}, csrf=True)
        self.assertEqual(response.status, 202, shout)
        self.cookie, self.csrf = admin_cookie, admin_csrf
        db = self.app[service.STORE_KEY]
        uid = db.one("SELECT id FROM users WHERE username='staff1'")['id']
        response, data = await self.json_request('DELETE', '/api/teachers/' + uid, {'confirmName': 'staff1'}, csrf=True)
        self.assertEqual(response.status, 200, data)
        self.assertIsNotNone(db.one('SELECT sender_id FROM shouts WHERE id=?', (shout['id'],)))
        self.assertEqual(db.one('SELECT enabled FROM users WHERE id=?', (uid,))['enabled'], 0)
        response = await self.client.get('/api/session', headers={'Cookie': teacher_cookie})
        self.assertFalse((await response.json())['authenticated'])
        response, _ = await self.json_request('PATCH', '/api/teachers/' + uid, {'enabled': True}, csrf=True)
        self.assertEqual(response.status, 404)
        await self.teacher(device['classId'])
        self.assertEqual(db.all('PRAGMA foreign_key_check'), [])

    async def test_deleted_device_revokes_socket_reading_cookie_and_keeps_statistics(self):
        device = await self.enroll_test_device()
        sid, _ = self.seed_reading(device)
        headers = {'Authorization': 'Bearer ' + device['deviceToken']}
        ws = await self.client.ws_connect('/ws/device?deviceId=' + device['deviceId'], headers=headers)
        await ws.receive_json()
        launch = await (await self.client.post('/api/reading/launch?deviceId=' + device['deviceId'], headers=headers)).json()
        self.assertEqual((await self.client.post('/api/reading/device/connect', json=launch)).status, 200)
        response, data = await self.json_request('DELETE', '/api/devices/' + device['deviceId'], {'confirmName': '更新测试电脑'}, csrf=True)
        self.assertEqual(response.status, 200, data)
        self.assertIn((await ws.receive()).type, (WSMsgType.CLOSE, WSMsgType.CLOSED))
        self.assertEqual((await self.client.get('/api/reading/device/settings')).status, 401)
        with self.assertRaises(WSServerHandshakeError):
            await self.client.ws_connect('/ws/device?deviceId=' + device['deviceId'], headers=headers)
        _, controls = await self.json_request('GET', '/api/classroom-controls')
        self.assertEqual(controls['devices'], [])
        response, _ = await self.json_request('PATCH', '/api/devices/' + device['deviceId'], {'enabled': True}, csrf=True)
        self.assertEqual(response.status, 404)
        db = self.app[service.STORE_KEY]
        self.assertIsNotNone(db.one('SELECT id FROM reading_sessions WHERE id=?', (sid,)))
        self.assertEqual(db.one('SELECT COUNT(*) n FROM reading_buckets')['n'], 1)
        await ws.close()

    async def test_cleanup_scope_date_validation_and_other_records_untouched(self):
        device = await self.enroll_test_device()
        sid, day = self.seed_reading(device)
        db = self.app[service.STORE_KEY]
        _, other = await self.json_request('POST', '/api/classes', {'name': '其他班级'}, csrf=True)
        db.run('INSERT INTO reading_buckets VALUES(?,?,?,?,?)', (other['id'], day, 1, 1, 1))
        db.run('INSERT INTO reading_buckets VALUES(?,?,?,?,?)', (device['classId'], '2020-01-01', 2, 1, 1))
        _, shout = await self.json_request('POST', '/api/shouts', {'classId': device['classId'], 'text': '保持通知'}, csrf=True)
        path = '/api/classes/' + device['classId'] + '/records'
        body = {'confirmName': '高一（1）班', 'kind': 'reading', 'start': day, 'end': day}
        response, data = await self.json_request('DELETE', path, body, csrf=True)
        self.assertEqual(response.status, 200, data)
        self.assertEqual(db.one('SELECT COUNT(*) n FROM reading_buckets')['n'], 2)
        self.assertEqual(db.one('SELECT COUNT(*) n FROM reading_events')['n'], 0)
        self.assertIsNotNone(db.one('SELECT id FROM reading_sessions WHERE id=?', (sid,)))
        self.assertIsNotNone(db.one('SELECT id FROM shouts WHERE id=?', (shout['id'],)))
        for invalid in ({'start': '2026-01-02', 'end': '2026-01-01'}, {'end': '9999-12-31'}, {'kind': 'users'}):
            response, _ = await self.json_request('DELETE', path, {**body, **invalid}, csrf=True)
            self.assertEqual(response.status, 400)
        response, _ = await self.json_request('DELETE', path, {**body, 'kind': 'history', 'allDates': True}, csrf=True)
        self.assertEqual(response.status, 200)
        self.assertIsNone(db.one('SELECT id FROM shouts WHERE id=?', (shout['id'],)))

    async def test_reusable_school_code_expiry_close_and_disabled_class(self):
        device = await self.enroll_test_device()
        path = '/api/enrollment/school-code'
        response, _ = await self.json_request('POST', path, {'code': 'mas22', 'validDays': 30})
        self.assertEqual(response.status, 403)
        response, data = await self.json_request('POST', path, {'code': 'mas22', 'validDays': 30}, csrf=True)
        self.assertEqual(response.status, 200, data)
        expires = data['expiresAt']
        for code in ('mas22', 'MAS22'):
            response = await self.client.post('/api/device/enrollment/classes', json={'code': code})
            self.assertEqual(response.status, 200)
            self.assertEqual(len((await response.json())['classes']), 1)
            response = await self.client.post('/api/device/enroll', json={'code': code, 'classId': device['classId'], 'deviceName': '同码绑定教室'})
            self.assertEqual(response.status, 200, await response.text())
        await self.json_request('PATCH', '/api/classes/' + device['classId'], {'enabled': False}, csrf=True)
        response = await self.client.post('/api/device/enrollment/classes', json={'code': 'mas22'})
        self.assertEqual((await response.json())['classes'], [])
        self.assertEqual((await self.client.post('/api/device/enroll', json={'code': 'mas22', 'classId': device['classId']})).status, 404)
        with patch.object(service, 'now_ms', return_value=expires+1):
            self.assertEqual((await self.client.post('/api/device/enrollment/classes', json={'code': 'mas22'})).status, 403)
        await self.json_request('DELETE', path, {}, csrf=True)
        self.assertEqual((await self.client.post('/api/device/enrollment/classes', json={'code': 'mas22'})).status, 403)

    async def test_enrollment_rate_limit_covers_direct_enroll(self):
        device = await self.enroll_test_device()
        await self.json_request('POST', '/api/enrollment/school-code', {'code': 'mas22'}, csrf=True)
        for _ in range(5):
            self.assertEqual((await self.client.post('/api/device/enrollment/classes', json={'code': 'wrong'})).status, 403)
        self.assertEqual((await self.client.post('/api/device/enroll', json={'code': 'mas22', 'classId': device['classId']})).status, 429)
        db = self.app[service.STORE_KEY]
        self.assertEqual(db.one('SELECT COUNT(*) n FROM devices')['n'], 1)

    async def test_staff_denied_admin_deletes_superadmin_protected_unbound_controls_rejected(self):
        device = await self.enroll_test_device()
        db = self.app[service.STORE_KEY]
        uid = db.one("SELECT id FROM users WHERE username='ICe'")['id']
        response, _ = await self.json_request('DELETE', '/api/teachers/' + uid, {'confirmName': 'ICe'}, csrf=True)
        self.assertEqual(response.status, 403)
        _, other = await self.json_request('POST', '/api/classes', {'name': '未绑定班级'}, csrf=True)
        response, _ = await self.json_request('POST', '/api/classes/' + other['id'] + '/control', {'action': 'set_volume', 'volume': 50}, csrf=True)
        self.assertEqual(response.status, 409)
        for role in ('teacher', 'director', 'principal'):
            admin_cookie, admin_csrf = self.cookie, self.csrf
            await self.json_request('POST', '/api/teachers', {'username': role, 'displayName': role, 'password': 'TeacherPassword123', 'role': role, 'classIds': [device['classId']]}, csrf=True)
            response, login = await self.json_request('POST', '/api/auth/login', {'username': role, 'password': 'TeacherPassword123'})
            self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]; self.csrf = login['user']['csrfToken']
            for path, body in [('/api/classes/' + device['classId'], {'confirmName': '高一（1）班'}), ('/api/devices/' + device['deviceId'], {'confirmName': '更新测试电脑'}), ('/api/enrollment/school-code', {})]:
                response, _ = await self.json_request('DELETE', path, body, csrf=True)
                self.assertEqual(response.status, 403, role + path)
            self.cookie, self.csrf = admin_cookie, admin_csrf

import uuid

from aiohttp import WSServerHandshakeError, WSMsgType

import app as service
from test_app import ServerTestCase
import test_management


class ClassroomLifecycleTest(ServerTestCase):
    async def test_batch_promotion_is_atomic_preserves_bindings_and_updates_online_name(self):
        device = await self.enroll_test_device()
        db = self.app[service.STORE_KEY]
        sid, _ = test_management.ManagementTest.seed_reading(self, device)
        response, second = await self.json_request('POST', '/api/classes', {'name': '高二（1）班'}, csrf=True)
        self.assertEqual(response.status, 201)
        response, third = await self.json_request('POST', '/api/classes', {'name': '高三（1）班'}, csrf=True)
        self.assertEqual(response.status, 201)
        headers = {'Authorization': 'Bearer ' + device['deviceToken']}
        ws = await self.client.ws_connect('/ws/device?deviceId=' + device['deviceId'], headers=headers)
        self.assertEqual((await ws.receive_json())['className'], '高一（1）班')
        changes = [{'id': device['classId'], 'name': '高二（1）班'}, {'id': second['id'], 'name': '高三（1）班'}]
        response, _ = await self.json_request('POST', '/api/classes/rename-batch', {'changes': changes}, csrf=True)
        self.assertEqual(response.status, 409)
        self.assertEqual(db.one('SELECT name FROM classes WHERE id=?', (device['classId'],))['name'], '高一（1）班')
        changes.append({'id': third['id'], 'name': '2026届毕业（1）班'})
        response, data = await self.json_request('POST', '/api/classes/rename-batch', {'changes': changes}, csrf=True)
        self.assertEqual(response.status, 200, data)
        self.assertEqual(data['updated'], 3)
        self.assertEqual((await ws.receive_json())['className'], '高二（1）班')
        self.assertEqual(db.one('SELECT class_id FROM devices WHERE id=?', (device['deviceId'],))['class_id'], device['classId'])
        self.assertEqual(db.one('SELECT class_id FROM reading_sessions WHERE id=?', (sid,))['class_id'], device['classId'])
        self.assertEqual(db.all('PRAGMA foreign_key_check'), [])
        await ws.close()

    async def test_duplicate_computers_visible_and_admin_reassign_keeps_old_statistics(self):
        device = await self.enroll_test_device()
        db = self.app[service.STORE_KEY]
        sid, _ = test_management.ManagementTest.seed_reading(self, device)
        await self.json_request('POST', '/api/enrollment/school-code', {'code': 'mas22', 'validDays': 30}, csrf=True)
        response, second = await self.json_request('POST', '/api/device/enroll', {
            'code': 'mas22', 'classId': device['classId'], 'deviceName': '另一台白板',
            'computer': {'computerName': 'CLASSROOM-PC', 'osVersion': 'Windows 11',
                         'localAddresses': ['192.168.1.20', '127.0.0.1', 'invalid', '8.8.8.8']}}, csrf=False)
        self.assertEqual(response.status, 200, second)
        headers = {'Authorization': 'Bearer ' + second['deviceToken']}
        ws = await self.client.ws_connect('/ws/device?deviceId=' + second['deviceId'], headers=headers)
        await ws.receive_json()
        await ws.send_json({'type': 'device_status', 'computer': {'computerName': 'REAL-PC', 'localAddresses': ['10.0.0.2'], 'osVersion': 'Windows 10'}, 'capabilities': ['reading']})
        await ws.send_json({'type': 'heartbeat'})
        self.assertEqual((await ws.receive_json())['type'], 'heartbeat_ack')
        _, rows = await self.json_request('GET', '/api/devices')
        self.assertTrue(all(r['class_device_count'] == 2 for r in rows['devices']))
        self.assertEqual(len({r['device_code'] for r in rows['devices']}), 2)
        registered = next(r for r in rows['devices'] if r['id'] == second['deviceId'])
        self.assertEqual(registered['computer_name'], 'REAL-PC')
        self.assertEqual(registered['local_addresses'], ['10.0.0.2'])
        self.assertTrue(registered['online'])
        launch = await (await self.client.post('/api/reading/launch?deviceId=' + second['deviceId'], headers=headers)).json()
        await self.client.post('/api/reading/device/connect', json=launch)
        _, target = await self.json_request('POST', '/api/classes', {'name': '高一（2）班'}, csrf=True)
        response, data = await self.json_request('PATCH', '/api/devices/' + second['deviceId'],
            {'classId': target['id'], 'name': 'A栋202白板', 'note': '二楼东侧', 'verified': True}, csrf=True)
        self.assertEqual(response.status, 200, data)
        self.assertIn((await ws.receive()).type, (WSMsgType.CLOSE, WSMsgType.CLOSED))
        self.assertEqual((await self.client.get('/api/reading/device/settings')).status, 401)
        self.assertIsNotNone(db.one('SELECT id FROM reading_sessions WHERE id=?', (sid,)))
        self.assertEqual(db.one('SELECT class_id FROM reading_sessions WHERE id=?', (sid,))['class_id'], device['classId'])
        new_ws = await self.client.ws_connect('/ws/device?deviceId=' + second['deviceId'], headers=headers)
        current = await new_ws.receive_json()
        self.assertEqual(current['classId'], target['id'])
        self.assertEqual(current['deviceName'], 'A栋202白板')
        _, rows = await self.json_request('GET', '/api/devices')
        self.assertTrue(all(r['class_device_count'] == 1 for r in rows['devices']))
        self.assertTrue(next(r for r in rows['devices'] if r['id'] == second['deviceId'])['verified_at'])
        await new_ws.close(); await ws.close()

    async def test_local_rebind_reuses_device_id_rotates_token_and_rejects_impersonation(self):
        device = await self.enroll_test_device()
        await self.json_request('POST', '/api/enrollment/school-code', {'code': 'mas22'}, csrf=True)
        _, target = await self.json_request('POST', '/api/classes', {'name': '高二（1）班'}, csrf=True)
        body = {'code': 'mas22', 'classId': target['id'], 'replaceDeviceId': device['deviceId'], 'deviceName': '改绑后的电脑'}
        response = await self.client.post('/api/device/enroll', json=body)
        self.assertEqual(response.status, 403)
        headers = {'Authorization': 'Bearer ' + device['deviceToken']}
        response = await self.client.post('/api/device/enroll', json=body, headers=headers)
        data = await response.json()
        self.assertEqual(response.status, 200, data)
        self.assertEqual(data['deviceId'], device['deviceId'])
        self.assertNotEqual(data['deviceToken'], device['deviceToken'])
        self.assertEqual(self.app[service.STORE_KEY].one('SELECT COUNT(*) n FROM devices')['n'], 1)
        with self.assertRaises(WSServerHandshakeError):
            await self.client.ws_connect('/ws/device?deviceId=' + device['deviceId'], headers=headers)

    async def test_teacher_cannot_promote_or_reassign_and_invalid_updates_do_not_mutate(self):
        device = await self.enroll_test_device()
        response, _ = await self.json_request('PATCH', '/api/devices/' + device['deviceId'], {'classId': str(uuid.uuid4()), 'verified': True}, csrf=True)
        self.assertEqual(response.status, 400)
        response, _ = await self.json_request('PATCH', '/api/devices/' + device['deviceId'], {'verified': 'yes'}, csrf=True)
        self.assertEqual(response.status, 400)
        await self.json_request('POST', '/api/teachers', {'username': 'teacher1', 'displayName': '教师', 'password': 'TeacherPassword123', 'classIds': [device['classId']]}, csrf=True)
        response, login = await self.json_request('POST', '/api/auth/login', {'username': 'teacher1', 'password': 'TeacherPassword123'})
        self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]; self.csrf = login['user']['csrfToken']
        response, _ = await self.json_request('PATCH', '/api/devices/' + device['deviceId'], {'verified': True}, csrf=True)
        self.assertEqual(response.status, 403)
        response, _ = await self.json_request('POST', '/api/classes/rename-batch', {'changes': [{'id': device['classId'], 'name': '高二（1）班'}]}, csrf=True)
        self.assertEqual(response.status, 403)
        self.assertEqual(self.app[service.STORE_KEY].one('SELECT name FROM classes WHERE id=?', (device['classId'],))['name'], '高一（1）班')

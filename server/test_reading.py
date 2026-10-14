import asyncio
from datetime import datetime, timezone, timedelta
from unittest.mock import patch

import app as service
from reading import DEFAULT
from test_app import ServerTestCase


def timestamp(hour, minute, second=0):
    return int(datetime(2026, 10, 14, hour, minute, second, tzinfo=timezone(timedelta(hours=8))).timestamp() * 1000)


class ReadingTest(ServerTestCase):
    async def open_reading(self, device, mode="classic"):
        response = await self.client.post('/api/reading/launch?deviceId=' + device['deviceId'], headers={'Authorization': 'Bearer ' + device['deviceToken']})
        self.assertEqual(response.status, 200)
        launch = await response.json()
        response = await self.client.post('/api/reading/device/connect', json=launch)
        self.assertEqual(response.status, 200, await response.text())
        response = await self.client.post('/api/reading/device/sessions', json={'mode': mode})
        self.assertEqual(response.status, 201, await response.text())
        return (await response.json())['sessionId'], launch

    async def configure(self, start=440, end=450):
        value = {**DEFAULT, 'enabled': True, 'periods': [{'weekdays': [1,2,3,4,5,6,7], 'start': start, 'end': end}]}
        response, data = await self.json_request('PUT', '/api/reading/settings', value, csrf=True)
        self.assertEqual(response.status, 200, data)
        return value

    async def test_window_clipping_threshold_pause_replay_and_class_dedup(self):
        clock = [timestamp(7,19,55)]
        with patch.object(service, 'now_ms', side_effect=lambda: clock[0]):
            device = await self.enroll_test_device()
            await self.configure()
            session, _ = await self.open_reading(device)
            clock[0] = timestamp(7,20,8)
            samples = [{'at': timestamp(7,19,59), 'volume': 60, 'active': True},
                       {'at': timestamp(7,20,0), 'volume': 30, 'active': True},
                       {'at': timestamp(7,20,1), 'volume': 29, 'active': True},
                       {'at': timestamp(7,20,2), 'volume': 80, 'active': False},
                       {'at': timestamp(7,20,7), 'volume': 80, 'active': True}]
            body = {'sessionId': session, 'samples': samples, 'events': [{'id': 'carrot-1', 'at': timestamp(7,20,3), 'kind': 'carrots'}, {'id': 'outside', 'at': timestamp(7,19,59), 'kind': 'carrots'}]}
            for _ in range(2):
                response = await self.client.post('/api/reading/device/pulse', json=body)
                self.assertEqual(response.status, 200, await response.text())
            second, _ = await self.open_reading(device, 'rocket')
            await self.client.post('/api/reading/device/pulse', json={'sessionId': second, 'samples': [samples[-1]], 'events': []})
            response, report = await self.json_request('GET', '/api/reading/report?start=2026-10-14&end=2026-10-14')
            row = report['rows'][0]
            self.assertEqual((row['activeSeconds'], row['effectiveSeconds']), (3, 2))
            self.assertEqual(row['completed']['carrots'], 1)
            self.assertEqual(row['ratio'], 66.7)
            # Both sessions are visible, but the same class-second is counted only once.
            self.assertEqual(row['sessions'], 2)
            clock[0] = timestamp(7,30)
            await self.client.post('/api/reading/device/pulse', json={'sessionId': session, 'samples': [{'at': clock[0], 'volume': 90, 'active': True}]})
            _, report = await self.json_request('GET', '/api/reading/report?start=2026-10-14&end=2026-10-14')
            self.assertEqual(report['rows'][0]['effectiveSeconds'], 2)

    async def test_all_modes_completion_and_disabled_statistics(self):
        clock = [timestamp(7,20)]
        with patch.object(service, 'now_ms', side_effect=lambda: clock[0]):
            device = await self.enroll_test_device()
            for mode, kind in [('classic','carrots'), ('carving','poems'), ('particle','badges'), ('rocket','launches')]:
                session, _ = await self.open_reading(device, mode)
                clock[0] += 1000
                await self.client.post('/api/reading/device/pulse', json={'sessionId': session, 'samples': [{'at': clock[0], 'volume': 70, 'active': True}], 'events': [{'id': mode, 'at': clock[0], 'kind': kind, 'title': '演示目标'}]})
            _, report = await self.json_request('GET', '/api/reading/report?start=2026-10-14&end=2026-10-14')
            self.assertEqual(report['rows'][0]['activeSeconds'], 0)
            await self.configure()
            for mode, kind in [('classic','carrots'), ('carving','poems'), ('particle','badges'), ('rocket','launches')]:
                session, _ = await self.open_reading(device, mode)
                clock[0] += 1000
                await self.client.post('/api/reading/device/pulse', json={'sessionId': session, 'samples': [{'at': clock[0], 'volume': 70, 'active': True}], 'events': [{'id': mode+'-enabled', 'at': clock[0], 'kind': kind}]})
            _, report = await self.json_request('GET', '/api/reading/report?start=2026-10-14&end=2026-10-14')
            self.assertEqual(report['rows'][0]['effectiveSeconds'], 4)
            self.assertEqual(report['rows'][0]['sessions'], 4)
            self.assertEqual(sum(report['rows'][0]['completed'].values()), 4)
            self.assertEqual(report['daily'][0]['sessions'], 4)
            self.assertEqual(sum(report['daily'][0]['completed'].values()), 4)
            self.assertEqual(report['daily'][0]['effectiveSeconds'], 4)

    async def test_launch_single_use_origin_cookie_and_disabled_device(self):
        device = await self.enroll_test_device()
        _, launch = await self.open_reading(device)
        response = await self.client.post('/api/reading/device/sessions', json={'mode': []})
        self.assertEqual(response.status, 400)
        response = await self.client.post('/api/reading/device/connect', json=launch)
        self.assertEqual(response.status, 401)
        response = await self.client.post('/api/reading/device/sessions', json={'mode': 'classic'}, headers={'Origin': 'https://other.example'})
        self.assertEqual(response.status, 401)
        response, _ = await self.json_request('PATCH', '/api/devices/' + device['deviceId'], {'enabled': False}, csrf=True)
        self.assertEqual(response.status, 200)
        response = await self.client.get('/api/reading/device/settings')
        self.assertEqual(response.status, 401)

    async def test_teacher_permissions_config_validation_and_export(self):
        device = await self.enroll_test_device()
        config = await self.configure()
        response, _ = await self.json_request('PUT', '/api/reading/settings', config)
        self.assertEqual(response.status, 403)
        response, _ = await self.json_request('PUT', '/api/reading/settings', {**config, 'threshold': 0}, csrf=True)
        self.assertEqual(response.status, 400)
        response, other = await self.json_request('POST', '/api/classes', {'name': '高一（2）班'}, csrf=True)
        await self.json_request('POST', '/api/teachers', {'username': 'reading_teacher', 'displayName': '教师', 'password': 'TeacherPassword123', 'classIds': [device['classId']]}, csrf=True)
        response, user = await self.json_request('POST', '/api/auth/login', {'username': 'reading_teacher', 'password': 'TeacherPassword123'})
        self.cookie = response.headers['Set-Cookie'].split(';',1)[0]
        self.csrf = user['user']['csrfToken']
        response, _ = await self.json_request('PUT', '/api/reading/settings', config, csrf=True)
        self.assertEqual(response.status, 403)
        response, _ = await self.json_request('GET', '/api/classroom-controls')
        self.assertEqual(response.status, 403)
        response, _ = await self.json_request('POST', '/api/classes/' + device['classId'] + '/control', {'action': 'set_volume','volume': 50}, csrf=True)
        self.assertEqual(response.status, 403)
        response, report = await self.json_request('GET', '/api/reading/report')
        self.assertEqual(len(report['rows']), 1)
        response, _ = await self.json_request('GET', '/api/reading/report?classId=' + other['id'])
        self.assertEqual(response.status, 403)
        response = await self.client.get('/api/reading/export', headers=self.headers())
        self.assertEqual(response.status, 200)
        self.assertIn('高一（1）班', await response.text())
        self.assertNotIn('高一（2）班', await response.text())

    async def test_volume_command_ack_offline_persistence_and_open_reading(self):
        device = await self.enroll_test_device()
        ws = await self.client.ws_connect('/ws/device?deviceId=' + device['deviceId'], headers={'Authorization': 'Bearer ' + device['deviceToken']})
        self.assertEqual((await ws.receive_json())['type'], 'connected')
        path = '/api/classes/' + device['classId'] + '/control'
        response, _ = await self.json_request('POST', path, {'action': 'set_volume', 'volume': 30})
        self.assertEqual(response.status, 403)
        response, data = await self.json_request('POST', path, {'action': 'set_volume', 'volume': 130}, csrf=True)
        self.assertEqual(response.status, 400)
        response, data = await self.json_request('POST', path, {'action': 'set_volume', 'volume': 30}, csrf=True)
        self.assertEqual(data['delivered'], 1)
        command = await ws.receive_json()
        self.assertEqual(command['volume'], 30)
        await ws.send_json({'type': 'device_status', 'outputVolume': 80, 'version': '2.0.0', 'capabilities': ['reading', 'volume']})
        await ws.send_json({'type': 'device_command_ack', 'commandId': command['commandId'], 'action': 'set_volume', 'success': True, 'outputVolume': 30})
        for _ in range(30):
            _, status = await self.json_request('GET', '/api/classroom-controls')
            if status['devices'][0]['actual_volume'] == 30: break
            await asyncio.sleep(.01)
        self.assertEqual(status['devices'][0]['actual_volume'], 30)
        self.assertEqual(status['devices'][0]['desired_volume'], 30)
        await ws.close()
        _, data = await self.json_request('POST', path, {'action': 'set_volume', 'volume': 50}, csrf=True)
        self.assertEqual(data['delivered'], 0)
        ws = await self.client.ws_connect('/ws/device?deviceId=' + device['deviceId'], headers={'Authorization': 'Bearer ' + device['deviceToken']})
        await ws.receive_json()
        self.assertEqual((await ws.receive_json())['volume'], 50)
        _, data = await self.json_request('POST', path, {'action': 'open_reading'}, csrf=True)
        self.assertEqual((await ws.receive_json())['action'], 'open_reading')
        await ws.close()

    async def test_media_range_and_companion_csp(self):
        response = await self.client.get('/reading/')
        self.assertEqual(response.status, 200)
        self.assertIn('integration.js', await response.text())
        response = await self.client.get('/reading/早读陪伴素材/rabbit.mp4', headers={'Range': 'bytes=0-99'})
        self.assertEqual(response.status, 206)
        self.assertEqual(len(await response.read()), 100)

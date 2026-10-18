import copy
import uuid
from pathlib import Path
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

import app as service
from reading import DEFAULT
from test_app import ServerTestCase
from test_reading import timestamp


class OfflineReadingTest(ServerTestCase):
    async def test_fresh_demo_records_with_its_enabled_rules(self):
        from preview import create_preview
        demo = create_preview(Path(self.temp.name) / 'separate-demo.db')
        async with TestClient(TestServer(demo)) as client:
            db = demo[service.STORE_KEY]
            device = db.one("SELECT d.* FROM devices d JOIN classes c ON c.id=d.class_id WHERE c.name='高一（1）班'")
            path = '?deviceId=' + device['id']
            auth = {'Authorization': 'Bearer local-demo-device-1'}
            response = await client.get('/api/reading/offline/context' + path, headers=auth)
            self.assertEqual(response.status, 200)
            context = await response.json()
            at = service.now_ms()
            event_id = str(uuid.uuid4())
            batch = {'id': str(uuid.uuid4()), 'sessionId': str(uuid.uuid4()),
                     'contextId': context['contextId'], 'classId': context['classId'],
                     'mode': 'particle', 'startedAt': at,
                     'samples': [{'at': at, 'volume': 50, 'active': True}],
                     'events': [{'id': event_id, 'at': at, 'kind': 'badges'}]}
            response = await client.post('/api/reading/offline/sync' + path, headers=auth,
                                         json={'batches': [batch], 'pendingCount': 1})
            data = await response.json()
            self.assertEqual(data['acknowledged'], [batch['id']])
            self.assertFalse(data['rejected'])
            self.assertEqual(db.one('SELECT counted FROM reading_events WHERE id=?', (event_id,))['counted'], 1)

    async def setup_device(self, clock):
        self.device = await self.enroll_test_device()
        self.path = '?deviceId=' + self.device['deviceId']
        self.auth = {'Authorization': 'Bearer ' + self.device['deviceToken']}
        await self.configure()
        self.context = await self.context_for_device()
        self.started = clock[0]

    async def configure(self, threshold=30, start=440, end=450):
        value = {**DEFAULT, 'enabled': True, 'threshold': threshold,
                 'periods': [{'weekdays': [1, 2, 3, 4, 5, 6, 7], 'start': start, 'end': end}]}
        response, data = await self.json_request('PUT', '/api/reading/settings', value, csrf=True)
        self.assertEqual(response.status, 200, data)

    async def context_for_device(self):
        response = await self.client.get('/api/reading/offline/context' + self.path, headers=self.auth)
        self.assertEqual(response.status, 200, await response.text())
        return await response.json()

    def batch(self, at, mode='classic', kind='carrots'):
        return {'id': str(uuid.uuid4()), 'sessionId': str(uuid.uuid4()),
                'contextId': self.context['contextId'], 'classId': self.context['classId'],
                'mode': mode, 'startedAt': self.started,
                'samples': [{'at': at, 'volume': 50, 'active': True}],
                'events': [{'id': str(uuid.uuid4()), 'at': at, 'kind': kind, 'title': '本机目标'}]}

    async def sync(self, batches, pending=None):
        response = await self.client.post('/api/reading/offline/sync' + self.path, headers=self.auth,
                                          json={'batches': batches, 'pendingCount': len(batches) if pending is None else pending})
        data = await response.json()
        self.assertEqual(response.status, 200, data)
        return data

    async def report(self):
        _, report = await self.json_request('GET', '/api/reading/report?start=2026-10-14&end=2026-10-15')
        return report

    async def test_delayed_replay_uses_original_day_rules_and_is_idempotent(self):
        clock = [timestamp(7, 19)]
        with patch.object(service, 'now_ms', side_effect=lambda: clock[0]):
            await self.setup_device(clock)
            first = self.batch(timestamp(7, 20, 1))
            outside = self.batch(timestamp(7, 19, 59))
            clock[0] = timestamp(7, 25)
            await self.configure(threshold=80)  # Only later samples need the higher threshold.
            later = self.batch(timestamp(7, 25, 1))
            clock[0] = timestamp(7, 30) + 86_400_000  # Upload the next day, well past the old 90-second limit.
            for _ in range(2):
                data = await self.sync([first, outside, later])
                self.assertEqual(data['acknowledged'], [first['id'], outside['id'], later['id']])
                self.assertFalse(data['rejected'])
            row = (await self.report())['rows'][0]
            self.assertEqual((row['activeSeconds'], row['effectiveSeconds'], row['completed']['carrots']), (2, 1, 2))
            self.assertEqual((row['sessions'], row['days']), (2, 1))
            self.assertEqual(row['sync']['state'], 'current')
            self.assertEqual((await self.report())['daily'][0]['day'], '2026-10-14')

    async def test_all_modes_overlapping_devices_and_midnight(self):
        clock = [timestamp(23, 59, 58)]
        with patch.object(service, 'now_ms', side_effect=lambda: clock[0]):
            await self.setup_device(clock)
            await self.configure(start=0, end=1440)
            batches = [self.batch(clock[0], mode, kind) for mode, kind in
                       [('classic', 'carrots'), ('carving', 'poems'), ('particle', 'badges'), ('rocket', 'launches')]]
            batches[-1]['samples'].append({'at': clock[0] + 3000, 'volume': 80, 'active': True})
            clock[0] += 86_400_000
            await self.sync(batches)
            await self.sync(batches)
            report = await self.report()
            self.assertEqual(report['rows'][0]['activeSeconds'], 2)
            self.assertEqual(sum(report['rows'][0]['completed'].values()), 4)
            self.assertEqual([r['day'] for r in report['daily']], ['2026-10-14', '2026-10-15'])

    async def test_authentication_validation_and_review_preserve_other_valid_batches(self):
        clock = [timestamp(7, 20)]
        with patch.object(service, 'now_ms', side_effect=lambda: clock[0]):
            await self.setup_device(clock)
            for method, path in [('GET', 'context'), ('POST', 'sync')]:
                response = await self.client.request(method, '/api/reading/offline/' + path + self.path, json={})
                self.assertEqual(response.status, 401)
            good = self.batch(clock[0]); bad = []
            for change in ({'contextId': str(uuid.uuid4())}, {'mode': []}, {'startedAt': True}, {'startedAt': clock[0] + 90_000}):
                item = copy.deepcopy(good); item.update(change); item['id'] = str(uuid.uuid4()); bad.append(item)
            item = self.batch(clock[0]); item['samples'][0]['volume'] = True; bad.append(item)
            item = self.batch(clock[0]); item['events'][0]['kind'] = []; bad.append(item)
            data = await self.sync([good] + bad)
            self.assertEqual(data['acknowledged'], [good['id']])
            self.assertEqual(len(data['rejected']), len(bad))
            self.assertEqual((await self.report())['rows'][0]['sync']['state'], 'review')
            response, _ = await self.json_request('PATCH', '/api/devices/' + self.device['deviceId'], {'enabled': False}, csrf=True)
            self.assertEqual(response.status, 200)
            response = await self.client.post('/api/reading/offline/sync' + self.path, headers=self.auth, json={'batches': [good]})
            self.assertEqual(response.status, 401)

    async def test_rebinding_keeps_previous_class_records_and_rejects_wrong_session(self):
        clock = [timestamp(7, 20)]
        with patch.object(service, 'now_ms', side_effect=lambda: clock[0]):
            await self.setup_device(clock)
            old = self.batch(clock[0]); old_cid = self.context['classId']
            response, new = await self.json_request('POST', '/api/classes', {'name': '高二（1）班'}, csrf=True)
            clock[0] += 30_000
            response, _ = await self.json_request('PATCH', '/api/devices/' + self.device['deviceId'], {'classId': new['id']}, csrf=True)
            self.assertEqual(response.status, 200)
            self.context = await self.context_for_device()
            self.assertNotEqual(self.context['contextId'], old['contextId'])
            data = await self.sync([old])
            self.assertEqual(data['acknowledged'], [old['id']])
            rows = {r['classId']: r for r in (await self.report())['rows']}
            self.assertEqual(rows[old_cid]['effectiveSeconds'], 1)
            self.assertEqual(rows[new['id']]['effectiveSeconds'], 0)
            conflict = self.batch(clock[0]); conflict['sessionId'] = old['sessionId']
            self.assertTrue((await self.sync([conflict]))['rejected'])

    async def test_admin_cleanup_is_not_undone_by_delayed_or_retried_upload(self):
        clock = [timestamp(7, 20)]
        with patch.object(service, 'now_ms', side_effect=lambda: clock[0]):
            await self.setup_device(clock)
            old, delayed = self.batch(clock[0]), self.batch(clock[0] + 1000)
            await self.sync([old])
            clock[0] += 10_000
            response, data = await self.json_request('DELETE', '/api/classes/' + self.context['classId'] + '/records',
                {'confirmName': self.context['className'], 'kind': 'reading', 'allDates': True}, csrf=True)
            self.assertEqual(response.status, 200, data)
            await self.sync([old, delayed])
            self.assertEqual((await self.report())['rows'][0]['activeSeconds'], 0)
            fresh = self.batch(clock[0] + 1000); clock[0] += 2000
            await self.sync([fresh])
            self.assertEqual((await self.report())['rows'][0]['activeSeconds'], 1)

    async def test_stale_sync_is_not_treated_as_confirmed_zero(self):
        clock = [timestamp(7, 20)]
        with patch.object(service, 'now_ms', side_effect=lambda: clock[0]):
            await self.setup_device(clock)
            self.assertEqual((await self.report())['rows'][0]['sync']['state'], 'unconfirmed')
            await self.sync([], pending=10)
            self.assertEqual((await self.report())['rows'][0]['sync']['state'], 'pending')
            await self.sync([])
            self.assertEqual((await self.report())['rows'][0]['sync']['state'], 'current')
            clock[0] += 120_001
            self.assertEqual((await self.report())['rows'][0]['sync']['state'], 'unconfirmed')

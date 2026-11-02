"""Bulk island settings use isolated databases and never touch real classes."""
import copy
import json

import app as service
from island import defaults
from test_app import ServerTestCase
from test_island_visibility import consumer_hidden


class IslandBulkTest(ServerTestCase):
    async def json_request(self, *args, **kwargs):
        response, data = await super().json_request(*args, **kwargs)
        data.pop('serverTime', None)
        return response, data

    async def setup_classes(self):
        await self.bootstrap_and_login()
        self.classes = []
        for name in ('高一（9）班', '高二（2）班'):
            response, classroom = await self.json_request('POST', '/api/classes', {'name': name}, csrf=True)
            self.assertEqual(response.status, 201, classroom)
            self.classes.append(classroom['id'])
        self.originals = []
        for index, cid in enumerate(self.classes):
            config = defaults('高一' if index == 0 else '高二')
            # Different local identifiers and grade times must retain their references.
            first = config['slots'][1]
            first['id'] = f'local-first-{index}'
            config['lessons'] = [{'slotId': first['id'], 'weekday': 1, 'week': 'odd',
                                  'subject': '语文', 'teacher': f'本班教师{index}', 'location': '本班'}]
            config['overrides'] = [{'slotId': first['id'], 'date': '2026-11-02', 'subject': '数学'}]
            config['visibility'] = {'followSchool': False, 'hiddenSlotIds': [first['id']]}
            config['dutyRotations']['evening'].update(enabled=True, cycleWeeks=3, lessons=[
                {'slotId': 'evening-study-1', 'weekday': 1, 'cycleWeek': 2,
                 'subject': '物理', 'teacher': '本班晚自习教师'}])
            response, saved = await self.json_request('PUT', '/api/island/classes/' + cid,
                {'revision': 0, 'config': config}, csrf=True)
            self.assertEqual(response.status, 200, saved)
            self.originals.append(saved)

    async def preview(self, changes, class_ids=None):
        body = {'classIds': class_ids or self.classes, 'changes': changes}
        response = await self.client.post('/api/island/bulk/preview', json=body, headers=self.headers(csrf=True))
        self.assertEqual(response.status, 200, await response.text())
        data = await response.json()
        return {**body, 'revisions': {row['classId']: row['revision'] for row in data['classes']}}, data

    async def test_selected_groups_preserve_class_content_and_device_revision(self):
        await self.setup_classes()
        response, enrollment = await self.json_request('POST',
            '/api/classes/' + self.classes[0] + '/enrollment-code', {}, csrf=True)
        self.assertEqual(response.status, 200, enrollment)
        response, device = await self.json_request('POST', '/api/device/enroll',
            {'code': enrollment['code'], 'deviceName': '隔离批量同步测试机'})
        self.assertEqual(response.status, 200, device)
        _, self.originals[0] = await self.json_request('GET', '/api/island/classes/' + self.classes[0])
        source = defaults('高一')
        source['slots'][1].update(start=476, end=521)
        source['slots'].append({'id': 'school-midday', 'label': '午间静校', 'start': 750, 'end': 815})
        source['appearance'].update(width=640, hideDuringLessons=True)
        source['reminders'].update(sound=True, volume=40)
        changes = {key: source[key] for key in ('slots', 'appearance', 'reminders')}
        changes['enabled'] = False
        body, preview = await self.preview(changes)
        self.assertTrue(preview['valid'])
        for cid, original in zip(self.classes, self.originals):
            _, current = await self.json_request('GET', '/api/island/classes/' + cid)
            self.assertEqual(current, original, 'Preview is read-only')
        response, result = await self.json_request('PUT', '/api/island/bulk', body, csrf=True)
        self.assertEqual(response.status, 200, result)
        self.assertEqual(result['updated'], 2)
        self.assertEqual(result['unchanged'], 0)
        for cid, original in zip(self.classes, self.originals):
            _, current = await self.json_request('GET', '/api/island/classes/' + cid)
            self.assertEqual(current['revision'], original['revision'] + 1)
            for key in ('lessons', 'overrides', 'dutyRotations', 'visibility', 'weekAnchor', 'components', 'automation'):
                self.assertEqual(current['config'][key], original['config'][key], key)
            first = next(s for s in current['config']['slots'] if s['id'] == original['config']['lessons'][0]['slotId'])
            self.assertEqual((first['start'], first['end']), (476, 521))
            self.assertIn('school-midday', [s['id'] for s in current['config']['slots']])
            self.assertFalse(current['config']['enabled'])
            self.assertEqual(current['config']['appearance']['width'], 640)
            self.assertEqual(current['config']['appearance']['hideDuringLessons'],
                             original['config']['appearance']['hideDuringLessons'], 'Class hiding rules are not copied')
        device_headers = {'Authorization': 'Bearer ' + device['deviceToken']}
        device_path = '/api/island/device?deviceId=' + device['deviceId']
        response = await self.client.get(device_path, headers=device_headers)
        delivered = await response.json()
        self.assertEqual(response.status, 200, delivered)
        self.assertEqual(delivered['revision'], self.originals[0]['revision'] + 1)
        self.assertFalse(delivered['config']['enabled'])
        self.assertEqual(delivered['config']['lessons'], self.originals[0]['config']['lessons'])
        for revision, expected_status in ((self.originals[0]['revision'], 409), (delivered['revision'], 200)):
            response = await self.client.post('/api/island/device/ack?deviceId=' + device['deviceId'],
                headers=device_headers, json={'revision': revision})
            self.assertEqual(response.status, expected_status)
        _, current = await self.json_request('GET', '/api/island/classes/' + self.classes[0])
        self.assertTrue(current['devices'][0]['current'])
        # A class head can still override their own settings after a school batch.
        await self.json_request('POST', '/api/teachers', {'username': 'class.head', 'displayName': '班主任',
            'password': 'TeacherPassword123', 'classIds': [self.classes[0]]}, csrf=True)
        response, login = await self.json_request('POST', '/api/auth/login',
            {'username': 'class.head', 'password': 'TeacherPassword123'})
        self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]
        self.csrf = login['user']['csrfToken']
        _, current = await self.json_request('GET', '/api/island/classes/' + self.classes[0])
        current['config']['enabled'] = True
        response, _ = await self.json_request('PUT', '/api/island/classes/' + self.classes[0], current, csrf=True)
        self.assertEqual(response.status, 200)

    async def test_concurrent_change_aborts_entire_batch_and_noop_does_not_bump(self):
        await self.setup_classes()
        body, _ = await self.preview({'enabled': False})
        changed = copy.deepcopy(self.originals[1])
        changed['config']['appearance']['width'] = 600
        response, _ = await self.json_request('PUT', '/api/island/classes/' + self.classes[1], changed, csrf=True)
        self.assertEqual(response.status, 200)
        response, result = await self.json_request('PUT', '/api/island/bulk', body, csrf=True)
        self.assertEqual(response.status, 409, result)
        _, untouched = await self.json_request('GET', '/api/island/classes/' + self.classes[0])
        self.assertEqual(untouched, self.originals[0])
        body, _ = await self.preview({'enabled': True})
        response, result = await self.json_request('PUT', '/api/island/bulk', body, csrf=True)
        self.assertEqual(response.status, 200, result)
        self.assertEqual((result['updated'], result['unchanged']), (0, 2))
        _, untouched = await self.json_request('GET', '/api/island/classes/' + self.classes[0])
        self.assertEqual(untouched, self.originals[0])

    async def test_bulk_save_keeps_legacy_course_hiding_and_noop_revision(self):
        await self.setup_classes()
        cid = self.classes[0]
        legacy = copy.deepcopy(self.originals[0]['config'])
        legacy.pop('visibility')
        legacy['appearance']['hideDuringLessons'] = True
        self.app[service.STORE_KEY].run('UPDATE island_profiles SET value=? WHERE class_id=?',
                                      (json.dumps(legacy), cid))
        changes = {'appearance': {'width': 640},
                   'slots': [{'id': 'school-first', 'label': '第一节', 'start': 476, 'end': 521},
                             {'id': 'school-extra', 'label': '补充时段', 'start': 1060, 'end': 1080}]}
        body, preview = await self.preview(changes)
        self.assertTrue(preview['valid'], preview)
        response, result = await self.json_request('PUT', '/api/island/bulk', body, csrf=True)
        self.assertEqual(response.status, 200, result)
        _, saved = await self.json_request('GET', '/api/island/classes/' + cid)
        samples = [('2026-11-02', 480), ('2026-11-02', 535), ('2026-11-01', 480)]
        self.assertEqual(consumer_hidden(saved['config'], samples), [True, False, False])
        self.assertEqual(saved['config']['lessons'], legacy['lessons'])
        body, _ = await self.preview(changes)
        response, result = await self.json_request('PUT', '/api/island/bulk', body, csrf=True)
        self.assertEqual(response.status, 200, result)
        self.assertEqual(result['updated'], 0)
        _, unchanged = await self.json_request('GET', '/api/island/classes/' + cid)
        self.assertEqual(unchanged, saved)

    async def test_preserve_unmatched_slots_and_block_ambiguous_or_overlapping_schedule(self):
        await self.setup_classes()
        template = [{'id': 'other-id', 'label': '第一节', 'start': 476, 'end': 521}]
        body, result = await self.preview({'slots': template}, [self.classes[0]])
        self.assertTrue(result['valid'])
        response, _ = await self.json_request('PUT', '/api/island/bulk', body, csrf=True)
        self.assertEqual(response.status, 200)
        _, current = await self.json_request('GET', '/api/island/classes/' + self.classes[0])
        self.assertEqual(len(current['config']['slots']), len(self.originals[0]['config']['slots']))
        template[0].update(start=510, end=555)
        body, result = await self.preview({'slots': template})
        self.assertFalse(result['valid'])
        self.assertTrue(all('重叠' in c['error'] for c in result['classes']))
        response, _ = await self.json_request('PUT', '/api/island/bulk', body, csrf=True)
        self.assertEqual(response.status, 409)
        _, unchanged = await self.json_request('GET', '/api/island/classes/' + self.classes[0])
        self.assertEqual(unchanged, current)

    async def test_invalid_targets_fields_revisions_and_csrf_never_write(self):
        await self.setup_classes()
        for patch in ({'changes': {}}, {'changes': {'lessons': []}}, {'changes': {'enabled': 'false'}},
                      {'changes': {'slots': []}}, {'classIds': []}, {'classIds': self.classes * 2},
                      {'classIds': ['missing']}, {'classIds': [True]}):
            body = {'classIds': self.classes, 'changes': {'enabled': False}, **patch}
            response, result = await self.json_request('POST', '/api/island/bulk/preview', body, csrf=True)
            self.assertEqual(response.status, 400, result)
        body, _ = await self.preview({'enabled': False})
        response, _ = await self.json_request('PUT', '/api/island/bulk', body)
        self.assertEqual(response.status, 403)
        for revisions in (None, {}, {cid: True for cid in self.classes}, {**body['revisions'], 'unexpected': 1}):
            response, result = await self.json_request('PUT', '/api/island/bulk', {**body, 'revisions': revisions}, csrf=True)
            self.assertEqual(response.status, 400, result)
        self.app[service.STORE_KEY].run('UPDATE classes SET enabled=0 WHERE id=?', (self.classes[1],))
        response, _ = await self.json_request('PUT', '/api/island/bulk', body, csrf=True)
        self.assertEqual(response.status, 400)
        _, current = await self.json_request('GET', '/api/island/classes/' + self.classes[0])
        self.assertEqual(current, self.originals[0])

    async def test_ambiguous_slot_labels_abort_without_changing_any_class(self):
        await self.setup_classes()
        original = copy.deepcopy(self.originals[0])
        original['config']['slots'][2]['label'] = original['config']['slots'][1]['label']
        response, original = await self.json_request('PUT', '/api/island/classes/' + self.classes[0],
            original, csrf=True)
        self.assertEqual(response.status, 200)
        template = [{'id': 'school-first', 'label': '第 一 节', 'start': 476, 'end': 521}]
        body, preview = await self.preview({'slots': template})
        self.assertFalse(preview['valid'])
        self.assertIn('同名', preview['classes'][0]['error'])
        self.assertNotIn('error', preview['classes'][1])
        response, _ = await self.json_request('PUT', '/api/island/bulk', body, csrf=True)
        self.assertEqual(response.status, 409)
        for cid, expected in zip(self.classes, (original, self.originals[1])):
            _, current = await self.json_request('GET', '/api/island/classes/' + cid)
            self.assertEqual(current, expected)

    async def test_only_school_admin_can_preview_or_apply(self):
        await self.setup_classes()
        body, _ = await self.preview({'enabled': False})
        await self.json_request('POST', '/api/teachers', {'username': 'local.head', 'displayName': '班主任',
            'password': 'TeacherPassword123', 'classIds': self.classes}, csrf=True)
        response, login = await self.json_request('POST', '/api/auth/login',
            {'username': 'local.head', 'password': 'TeacherPassword123'})
        self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]
        self.csrf = login['user']['csrfToken']
        for method, path in [('POST', '/api/island/bulk/preview'), ('PUT', '/api/island/bulk')]:
            response, result = await self.json_request(method, path, body, csrf=True)
            self.assertEqual(response.status, 403, result)
        for cid, original in zip(self.classes, self.originals):
            _, current = await self.json_request('GET', '/api/island/classes/' + cid)
            self.assertEqual(current, original)

    async def test_banban_discovers_and_executes_readonly_bulk_preview(self):
        await self.setup_classes()
        _, catalog = await self.json_request('GET', '/api/banban/operations/catalog')
        specs = {item['id']: item for item in catalog['business']}
        self.assertIn('island.bulk.preview', specs)
        self.assertFalse(specs['island.bulk.preview']['confirmation'])
        self.assertTrue(specs['island.bulk.update']['confirmation'])
        response, operation = await self.json_request('POST', '/api/banban/operations', {
            'kind': 'platform', 'args': {'operation': 'island.bulk.preview',
                'payload': {'classIds': self.classes, 'changes': {'enabled': False}}}}, csrf=True)
        self.assertEqual(response.status, 200, operation)
        self.assertEqual(operation['status'], 'succeeded', operation)
        self.assertTrue(operation['result']['valid'])
        for cid, original in zip(self.classes, self.originals):
            _, current = await self.json_request('GET', '/api/island/classes/' + cid)
            self.assertEqual(current, original)

import copy
import io
import json
import unittest
import zipfile
from datetime import date

import app as service
from island import defaults, normalize, lessons_on
from island_xlsx import export_schedule, import_schedule, read_sheets
from test_app import ServerTestCase


def sample():
    p = defaults()
    p['slots'] = [{'id': 'p1', 'label': '第一节', 'start': 480, 'end': 520},
                  {'id': 'p2', 'label': '第二节', 'start': 530, 'end': 570}]
    p['lessons'] = [{'weekday': 1, 'slotId': 'p1', 'week': 'odd', 'subject': '语文', 'teacher': '王老师', 'location': '本班'},
                    {'weekday': 1, 'slotId': 'p1', 'week': 'even', 'subject': '数学', 'teacher': '', 'location': ''},
                    {'weekday': 1, 'slotId': 'p2', 'week': 'all', 'subject': '=1+1', 'teacher': '', 'location': ''}]
    return p


class IslandModelTest(unittest.TestCase):
    def test_parity_before_and_after_anchor_and_temporary_overrides(self):
        p = normalize(sample())
        for on, expected in [('2026-09-07', '语文'), ('2026-09-14', '数学'), ('2026-08-31', '数学'), ('2026-10-19', '语文')]:
            self.assertEqual(lessons_on(p, date.fromisoformat(on))[0]['subject'], expected)
        p['overrides'] = [{'date': '2026-10-19', 'slotId': 'p1', 'subject': '班会', 'cancelled': False},
                          {'date': '2026-10-19', 'slotId': 'p2', 'cancelled': True}]
        rows = lessons_on(p, date(2026, 10, 19))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['subject'], '班会')
        self.assertTrue(rows[0]['temporary'])
        self.assertEqual(len(lessons_on(p, date(2026, 10, 26))), 2)

    def test_validation_rejects_overlap_duplicate_missing_and_wrong_types(self):
        changes = [lambda p: p['slots'][1].update(start=500), lambda p: p['slots'][1].update(id='p1'),
                   lambda p: p['lessons'].append({**p['lessons'][0], 'week': 'all'}),
                   lambda p: p['lessons'][0].update(slotId='missing'), lambda p: p.update(enabled='true'),
                   lambda p: p.update(weekAnchor='2026-09-08'), lambda p: p['appearance'].update(width=True),
                   lambda p: p.update(components=[{'id': 'c', 'type': 'unsupported'}]),
                   lambda p: p.update(components=[{'id': 'c', 'type': 'countdown', 'date': '2026-02-30'}])]
        for change in changes:
            p = sample(); change(p)
            with self.assertRaises(ValueError): normalize(p)

    def test_automation_targets_and_rules_are_bounded(self):
        p = sample()
        rule = {'id': 'r', 'name': '自动打开', 'trigger': 'start', 'action': 'website', 'value': 'https://example.com'}
        p['automation'] = [rule]
        self.assertEqual(normalize(p)['automation'][0]['value'], rule['value'])
        for target in ['file:///C:/Windows', 'javascript:alert(1)', 'https://user:secret@example.com', 'https://example.com/\n']:
            rule['value'] = target
            with self.assertRaises(ValueError): normalize(p)
        rule.update(action='app', value=r'C:\School\Lesson.exe')
        normalize(p)
        for target in ['cmd.exe /c test', r'C:\School\Lesson.exe --args', r'\\server\share\a.exe']:
            rule['value'] = target
            with self.assertRaises(ValueError): normalize(p)

    def test_xlsx_round_trip_retains_parity_anchor_unicode_and_literal_formula(self):
        p = normalize(sample())
        p['overrides'] = [{'date': '2026-10-19', 'slotId': 'p1', 'subject': '', 'teacher': '', 'location': '', 'cancelled': True}]
        p['components'].append({'id': 'extra', 'type': 'text', 'enabled': True, 'title': '寄语', 'text': '保持好奇', 'date': ''})
        content = export_schedule(p)
        result = normalize(import_schedule(content, p))
        self.assertEqual(result, p)
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            xml = archive.read('xl/worksheets/sheet2.xml')
            self.assertIn(b'=1+1', xml)
            self.assertNotIn(b'<f>', xml)

    def test_xlsx_rejects_bad_zip_formula_entity_and_oversize(self):
        for content in [b'not a zip', b'x' * 2000001]:
            with self.assertRaises(ValueError): read_sheets(content)
        original = export_schedule(normalize(sample()))
        for replacement in [b'<!DOCTYPE x [<!ENTITY a "x">]><x/>', b'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>']:
            dest = io.BytesIO()
            with zipfile.ZipFile(io.BytesIO(original)) as source, zipfile.ZipFile(dest, 'w') as output:
                for name in source.namelist(): output.writestr(name, replacement if name.endswith('sheet1.xml') else source.read(name))
            with self.assertRaises(ValueError): read_sheets(dest.getvalue())


class IslandTest(ServerTestCase):
    async def setup_class(self):
        device = await self.enroll_test_device()
        return device, '/api/island/classes/' + device['classId']

    async def test_island_save_conflict_and_durable_device_delivery(self):
        device, path = await self.setup_class()
        response, p = await self.json_request('GET', path)
        self.assertEqual((response.status, p['revision']), (200, 0))
        response, saved = await self.json_request('PUT', path, {'revision': 0, 'config': sample()}, csrf=True)
        self.assertEqual((response.status, saved['revision']), (200, 1), saved)
        response, conflict = await self.json_request('PUT', path, {'revision': 0, 'config': defaults()}, csrf=True)
        self.assertEqual(response.status, 409, conflict)
        headers = {'Authorization': 'Bearer ' + device['deviceToken']}
        response = await self.client.get('/api/island/device?deviceId=' + device['deviceId'], headers=headers)
        payload = await response.json()
        self.assertEqual(payload['config']['lessons'][0]['subject'], '语文')
        self.assertEqual(payload['classId'], device['classId'])
        for rev, status in [(0, 409), (1, 200)]:
            response = await self.client.post('/api/island/device/ack?deviceId=' + device['deviceId'], headers=headers, json={'revision': rev, 'detail': '课前提醒已执行'})
            self.assertEqual(response.status, status)
        _, p = await self.json_request('GET', path)
        self.assertTrue(p['devices'][0]['current'])
        self.assertEqual(p['devices'][0]['detail'], '课前提醒已执行')
        self.assertIsNotNone(self.app[service.STORE_KEY].one('SELECT value FROM island_profiles WHERE class_id=?', (device['classId'],)))

    async def test_island_roles_csrf_device_revocation_and_rebinding(self):
        device, path = await self.setup_class()
        _, other = await self.json_request('POST', '/api/classes', {'name': '高二（9）班'}, csrf=True)
        await self.json_request('POST', '/api/teachers', {'username': 'island.teacher', 'displayName': '教师', 'password': 'TeacherPassword123', 'classIds': [device['classId']]}, csrf=True)
        response, login = await self.json_request('POST', '/api/auth/login', {'username': 'island.teacher', 'password': 'TeacherPassword123'})
        self.cookie = response.headers['Set-Cookie'].split(';',1)[0]; self.csrf = login['user']['csrfToken']
        for suffix in ['', '/export']:
            response = await self.client.get('/api/island/classes/' + other['id'] + suffix, headers=self.headers())
            self.assertEqual(response.status, 403)
        response, _ = await self.json_request('PUT', path, {'revision': 0, 'config': sample()})
        self.assertEqual(response.status, 403)
        response, saved = await self.json_request('PUT', path, {'revision': 0, 'config': sample()}, csrf=True)
        self.assertEqual(response.status, 200, saved)
        db = self.app[service.STORE_KEY]
        db.run('UPDATE devices SET enabled=0 WHERE id=?', (device['deviceId'],))
        response = await self.client.get('/api/island/device?deviceId=' + device['deviceId'], headers={'Authorization': 'Bearer '+device['deviceToken']})
        self.assertEqual(response.status, 401)
        db.run('UPDATE devices SET enabled=1,class_id=? WHERE id=?', (other['id'], device['deviceId']))
        response = await self.client.get('/api/island/device?deviceId=' + device['deviceId'], headers={'Authorization': 'Bearer '+device['deviceToken']})
        self.assertEqual((await response.json())['revision'], 0)

    async def test_island_import_is_preview_and_preserves_non_schedule_settings(self):
        device, path = await self.setup_class()
        headers = {**self.headers(csrf=True), 'Content-Type': 'application/octet-stream'}
        response = await self.client.post(path+'/import', headers=headers, data=export_schedule(normalize(sample())))
        self.assertEqual(response.status, 200, await response.text())
        config = (await response.json())['config']
        self.assertEqual(len(config['lessons']), 3)
        _, original = await self.json_request('GET', path)
        self.assertEqual(original['revision'], 0)
        await self.json_request('PUT', path, {'revision': 0, 'config': config}, csrf=True)
        response = await self.client.get(path+'/export', headers=self.headers())
        self.assertEqual(response.status, 200)
        self.assertEqual(len(read_sheets(await response.read())['课程']), 4)

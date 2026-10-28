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


def rotation_sample():
    p = defaults('高一')
    p['slots'].append({'id': 'midday', 'label': '午间静校', 'start': 750, 'end': 810})
    p['lessons'] = [{'slotId': 'period-1', 'weekday': 1, 'week': 'all', 'subject': '物理'}]
    for kind, total, anchor, slots in [('midday', 3, '2026-09-07', ['midday']),
                                       ('evening', 4, '2026-09-14', ['evening-study-1', 'evening-study-2'])]:
        p['dutyRotations'][kind] = {'enabled': True, 'cycleWeeks': total, 'weekAnchor': anchor, 'slotIds': slots,
            'lessons': [{'slotId': sid, 'weekday': 1, 'cycleWeek': week,
                         'subject': '静校' if kind == 'midday' else '数学', 'teacher': f'{kind}-{week}', 'location': ''}
                        for week in range(1, total + 1) for sid in slots]}
    return p


class IslandModelTest(unittest.TestCase):
    def test_independent_duty_cycles_and_start_dates_keep_fixed_lessons(self):
        p = normalize(rotation_sample())
        for on, midday, evening in [('2026-09-07', 1, None), ('2026-09-21', 3, 2),
                                     ('2026-09-28', 1, 3), ('2026-10-05', 2, 4), ('2026-10-12', 3, 1)]:
            rows = lessons_on(p, date.fromisoformat(on))
            self.assertEqual(rows[0]['subject'], '物理')
            duties = {r['dutyKind']: r['teacher'] for r in rows if 'dutyKind' in r}
            self.assertEqual(duties.get('midday'), f'midday-{midday}')
            self.assertEqual(duties.get('evening'), f'evening-{evening}' if evening else None)
        self.assertEqual(len(lessons_on(p, date(2026, 8, 31))), 1)
        self.assertEqual(lessons_on(p, date(2026, 9, 13)), [])
        self.assertEqual([r['start'] for r in lessons_on(p, date(2026, 9, 21))], [475, 750, 1100, 1200])

    def test_duty_temporary_changes_and_disable_do_not_shift_following_weeks(self):
        p = normalize(rotation_sample())
        p['overrides'] = [{'date': '2026-09-21', 'slotId': 'midday', 'cancelled': True},
                          {'date': '2026-09-21', 'slotId': 'evening-study-1', 'subject': '语文', 'teacher': '代班教师'}]
        rows = lessons_on(p, date(2026, 9, 21))
        self.assertEqual([r['subject'] for r in rows], ['物理', '语文', '数学'])
        self.assertTrue(rows[1]['temporary'])
        self.assertEqual(rows[2]['teacher'], 'evening-2')
        self.assertEqual(lessons_on(p, date(2026, 9, 28))[1]['teacher'], 'midday-1')
        p['dutyRotations']['midday']['enabled'] = False
        self.assertNotIn('midday', [r['id'] for r in lessons_on(p, date(2026, 9, 28))])
        self.assertEqual(len(p['dutyRotations']['midday']['lessons']), 3)

    def test_duties_across_year_and_empty_cycle_week(self):
        p = rotation_sample()
        p['dutyRotations']['midday'].update(weekAnchor='2026-12-28')
        p['dutyRotations']['midday']['lessons'] = [p['dutyRotations']['midday']['lessons'][2]]
        p = normalize(p)
        for on in ('2026-12-28', '2027-01-04'):
            self.assertNotIn('midday', [r['id'] for r in lessons_on(p, date.fromisoformat(on))])
        self.assertEqual(next(r for r in lessons_on(p, date(2027, 1, 11)) if r['id'] == 'midday')['teacher'], 'midday-3')

    def test_duty_validation_rejects_conflicts_duplicates_and_invalid_cycles(self):
        changes = [lambda d: d.update(cycleWeeks=True), lambda d: d.update(cycleWeeks=0), lambda d: d.update(cycleWeeks=21),
                   lambda d: d.update(weekAnchor='2026-09-08'), lambda d: d.update(enabled='true'),
                   lambda d: d.update(slotIds=[]), lambda d: d.update(slotIds=['missing']),
                   lambda d: d['lessons'][0].update(cycleWeek=4), lambda d: d['lessons'][0].update(weekday=0),
                   lambda d: d['lessons'][0].update(subject=''), lambda d: d['lessons'][0].update(teacher=None),
                   lambda d: d['lessons'].append(copy.deepcopy(d['lessons'][0]))]
        for change in changes:
            p = rotation_sample(); change(p['dutyRotations']['midday'])
            with self.assertRaises(ValueError): normalize(p)
        p = rotation_sample(); p['lessons'].append({'slotId': 'midday', 'weekday': 1, 'subject': '冲突'})
        with self.assertRaises(ValueError): normalize(p)
        p = rotation_sample(); p['dutyRotations']['evening']['slotIds'].append('midday')
        with self.assertRaises(ValueError): normalize(p)
        p = sample(); p.pop('dutyRotations')
        self.assertFalse(any(d['enabled'] for d in normalize(p)['dutyRotations'].values()))

    def test_duty_xlsx_roundtrip_and_old_workbook_preserve_rotations(self):
        p = normalize(rotation_sample())
        content = export_schedule(p)
        self.assertEqual(normalize(import_schedule(content, p)), p)
        self.assertIn('班级课表', read_sheets(content))
        # A pre-feature workbook contains only the original four sheets.
        from test_island_xlsx import legacy_xlsx
        metadata = {}
        old = normalize(import_schedule(legacy_xlsx(p, duties=False), p, metadata=metadata))
        self.assertEqual(old['dutyRotations'], p['dutyRotations'])
        self.assertFalse(metadata['dutiesIncluded'])
    def test_grade_defaults_match_the_school_timetable_without_creating_lessons(self):
        common = [('07:30', '07:53'), ('07:55', '08:40'), ('08:50', '09:35'),
                  ('10:05', '10:50'), ('11:00', '11:40'), ('14:00', '14:45'),
                  ('14:55', '15:40'), ('15:50', '16:35'), ('16:45', '17:30'),
                  ('18:20', '19:50'), ('20:00', '21:30')]
        for grade in ('高一', '高二', '高三'):
            with self.subTest(grade=grade):
                expected = list(common)
                if grade == '高一': expected[4] = ('11:00', '11:45')
                if grade == '高三': expected[8] = ('16:45', '17:25')
                config = normalize(defaults(grade))
                actual = [(f"{slot['start'] // 60:02}:{slot['start'] % 60:02}",
                           f"{slot['end'] // 60:02}:{slot['end'] % 60:02}") for slot in config['slots']]
                self.assertEqual(actual, expected)
                self.assertEqual(config['lessons'], [])
                self.assertEqual(config['automation'], [])
                self.assertEqual(lessons_on(config, date(2026, 10, 23)), [])
        self.assertEqual(defaults()['slots'], [])
        self.assertEqual(defaults('其他')['slots'], [])

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
            xml = archive.read('xl/worksheets/sheet1.xml')
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
    async def test_rotations_save_reload_deliver_and_older_editor_preserves_them(self):
        device, path = await self.setup_class()
        response, saved = await self.json_request('PUT', path, {'revision': 0, 'config': rotation_sample()}, csrf=True)
        self.assertEqual(response.status, 200, saved)
        _, reloaded = await self.json_request('GET', path)
        self.assertEqual(reloaded['config']['dutyRotations'], saved['config']['dutyRotations'])
        response = await self.client.get('/api/island/device?deviceId=' + device['deviceId'], headers={'Authorization': 'Bearer ' + device['deviceToken']})
        self.assertEqual((await response.json())['config'], saved['config'])
        older = copy.deepcopy(saved['config']); older.pop('dutyRotations'); older['appearance']['width'] = 600
        response, updated = await self.json_request('PUT', path, {'revision': 1, 'config': older}, csrf=True)
        self.assertEqual(response.status, 200, updated)
        self.assertEqual(updated['config']['dutyRotations'], saved['config']['dutyRotations'])
        self.assertEqual(updated['config']['appearance']['width'], 600)
        response, _ = await self.json_request('PUT', path, {'revision': 1, 'config': rotation_sample()}, csrf=True)
        self.assertEqual(response.status, 409)
        headers = {**self.headers(csrf=True), 'Content-Type': 'application/octet-stream'}
        response = await self.client.post(path + '/import', headers=headers, data=export_schedule(saved['config']))
        preview = await response.json()
        self.assertEqual(response.status, 200, preview)
        self.assertTrue(preview['dutiesIncluded'])
        self.assertEqual(preview['config']['dutyRotations'], saved['config']['dutyRotations'])
        _, final = await self.json_request('GET', path)
        self.assertEqual(final['revision'], 2)

    async def setup_class(self):
        device = await self.enroll_test_device()
        return device, '/api/island/classes/' + device['classId']

    async def test_initial_grade_defaults_do_not_write_and_match_device_delivery(self):
        device, path = await self.setup_class()
        db = self.app[service.STORE_KEY]
        for name, grade in [('高一（1）班', '高一'), ('高2（1）班', '高二'), ('高三（1）班', '高三'), ('实验班', None)]:
            with self.subTest(name=name):
                db.run('UPDATE classes SET name=? WHERE id=?', (name, device['classId']))
                response, profile = await self.json_request('GET', path)
                self.assertEqual(response.status, 200, profile)
                self.assertEqual(profile['revision'], 0)
                self.assertIsNone(profile['updatedAt'])
                self.assertEqual(profile['config'], defaults(grade))
                response = await self.client.get('/api/island/device?deviceId=' + device['deviceId'],
                                                headers={'Authorization': 'Bearer ' + device['deviceToken']})
                self.assertEqual(response.status, 200)
                self.assertEqual((await response.json())['config'], profile['config'])
                self.assertIsNone(db.one('SELECT value FROM island_profiles WHERE class_id=?', (device['classId'],)))

    async def test_teacher_can_save_defaults_then_customize_without_affecting_other_classes(self):
        device, path = await self.setup_class()
        response, other = await self.json_request('POST', '/api/classes', {'name': '高三（9）班'}, csrf=True)
        self.assertEqual(response.status, 201, other)
        response, _ = await self.json_request('POST', '/api/teachers', {'username': 'schedule.teacher', 'displayName': '教师',
            'password': 'TeacherPassword123', 'classIds': [device['classId']]}, csrf=True)
        self.assertEqual(response.status, 201)
        response, login = await self.json_request('POST', '/api/auth/login',
            {'username': 'schedule.teacher', 'password': 'TeacherPassword123'})
        self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]
        self.csrf = login['user']['csrfToken']
        _, initial = await self.json_request('GET', path)
        response, saved = await self.json_request('PUT', path, {'revision': 0, 'config': initial['config']}, csrf=True)
        self.assertEqual((response.status, saved['revision']), (200, 1), saved)
        config = saved['config']
        config['slots'][4]['end'] = 702
        config['lessons'] = [{'slotId': config['slots'][4]['id'], 'weekday': 5, 'subject': '化学'}]
        response, updated = await self.json_request('PUT', path, {'revision': 1, 'config': config}, csrf=True)
        self.assertEqual((response.status, updated['revision']), (200, 2), updated)
        _, reloaded = await self.json_request('GET', path)
        self.assertEqual(reloaded['config']['slots'][4]['end'], 702)
        self.assertEqual(lessons_on(reloaded['config'], date(2026, 10, 23))[0]['subject'], '化学')
        response, _ = await self.json_request('GET', '/api/island/classes/' + other['id'])
        self.assertEqual(response.status, 403)
        db = self.app[service.STORE_KEY]
        self.assertIsNone(db.one('SELECT value FROM island_profiles WHERE class_id=?', (other['id'],)))
        response = await self.client.get('/api/island/device?deviceId=' + device['deviceId'],
                                        headers={'Authorization': 'Bearer ' + device['deviceToken']})
        self.assertEqual((await response.json())['config'], reloaded['config'])
        db.run('UPDATE classes SET name=? WHERE id=?', ('高二（1）班', device['classId']))
        _, renamed = await self.json_request('GET', path)
        self.assertEqual(renamed['config'], reloaded['config'])
        response, cleared = await self.json_request('PUT', path, {'revision': 2, 'config': defaults()}, csrf=True)
        self.assertEqual(response.status, 200, cleared)
        _, reloaded = await self.json_request('GET', path)
        self.assertEqual(reloaded['config']['slots'], [])

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
        data = await response.read()
        self.assertEqual(len(normalize(import_schedule(data, config))['lessons']), 3)
        self.assertIn('filename*=UTF-8', response.headers['Content-Disposition'])

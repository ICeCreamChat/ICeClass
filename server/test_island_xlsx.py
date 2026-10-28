import copy
import io
import unittest
import zipfile
from datetime import date
from xml.etree import ElementTree as ET

from island import defaults, normalize
from island_xlsx import HEADERS, clock, export_schedule, import_schedule, read_sheets
from island_timetable_xlsx import DAY_GROUP, SHEET
from reading_xlsx import S, R, child, cell, text, xml, relationships


def legacy_xlsx(config, *, duties=True):
    """Fixture in the previously shipped four/six-table format."""
    data = {'作息': [[s['id'], s['label'], clock(s['start']), clock(s['end'])] for s in config['slots']],
        '课程': [[l['weekday'], l['slotId'], {'all': '全部', 'odd': '单周', 'even': '双周'}[l['week']],
                l['subject'], l['teacher'], l['location']] for l in config['lessons']],
        '临时调课': [[o['date'], o['slotId'], o['subject'], o['teacher'], o['location'], '是' if o['cancelled'] else '否']
                     for o in config['overrides']], '学期': [[config['weekAnchor']]]}
    if duties:
        data['值班循环'], data['值班课程'] = [], []
        for kind, duty in config['dutyRotations'].items():
            name = {'midday': '午间静校', 'evening': '晚自习'}[kind]
            data['值班循环'].append([name, '是' if duty['enabled'] else '否', duty['cycleWeeks'], duty['weekAnchor'],
                                  *(duty['slotIds'] + ['', ''])[:2]])
            data['值班课程'].extend([[name, l['cycleWeek'], l['weekday'], l['slotId'], l['subject'], l['teacher'], l['location']]
                                       for l in duty['lessons']])
    workbook = ET.Element(f'{{{S}}}workbook')
    sheets = child(workbook, S, 'sheets')
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        relations = []
        for i, (name, values) in enumerate(data.items(), 1):
            child(sheets, S, 'sheet', name=name, sheetId=i, **{f'{{{R}}}id': f'rId{i}'})
            sheet = ET.Element(f'{{{S}}}worksheet')
            rows = child(sheet, S, 'sheetData')
            for n, values_row in enumerate([HEADERS[name], *values], 1):
                row = child(rows, S, 'row', r=n)
                for k, value in enumerate(values_row, 1):
                    cell(row, k, value)
            archive.writestr(f'xl/worksheets/sheet{i}.xml', xml(sheet))
            relations.append((f'rId{i}', 'worksheet', f'worksheets/sheet{i}.xml'))
        archive.writestr('xl/workbook.xml', xml(workbook))
        archive.writestr('xl/_rels/workbook.xml.rels', xml(relationships(relations)))
    return output.getvalue()


def edit_book(content, transform):
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(content)) as source, zipfile.ZipFile(output, 'w') as target:
        for name in source.namelist():
            target.writestr(name, transform(name, source.read(name)))
    return output.getvalue()


def set_cells(content, values):
    def transform(name, data):
        if name != 'xl/worksheets/sheet1.xml':
            return data
        root = ET.fromstring(data)
        for c in root.iter(f'{{{S}}}c'):
            ref = c.attrib['r']
            if ref not in values:
                continue
            for node in list(c):
                c.remove(node)
            value = values[ref]
            if isinstance(value, (int, float)):
                c.attrib.pop('t', None)
                text(c, S, 'v', value)
            else:
                c.set('t', 'inlineStr')
                text(child(c, S, 'is'), S, 't', value)
        return xml(root)
    return edit_book(content, transform)


def groups(content, title):
    rows = read_sheets(content)[SHEET]
    active = None
    result = []
    for n, values in zip(rows.row_numbers, rows):
        if values[0] in ('日常课程', '午间静校', '晚自习'):
            active = values[0]
        if active == title and values[2] == '学科':
            result.append((n, values))
    return result


class TimetableTemplateTest(unittest.TestCase):
    def profile(self):
        from test_island import rotation_sample
        return normalize(rotation_sample())

    def test_empty_default_and_configured_templates_round_trip(self):
        for p in [normalize(defaults()), normalize(defaults('高一')), self.profile()]:
            with self.subTest(slots=len(p['slots'])):
                result = normalize(import_schedule(export_schedule(p), p))
                self.assertEqual(result, p)

    def test_teacher_edits_visible_daily_midday_and_evening_cells(self):
        p = self.profile()
        content = export_schedule(p, class_name='高一（9）班')
        changes = {}
        for title, subject, teacher in [('日常课程', '语文', '欧阳老师'), ('午间静校', '午间自习', '午间老师'),
                                         ('晚自习', '英语', '晚自习老师')]:
            n, _ = (next(g for g in groups(content, title) if g[1][10] == 'period-1')
                    if title == '日常课程' else groups(content, title)[0])
            changes.update({f'D{n}': subject, f'D{n+1}': teacher})
        metadata = {}
        result = normalize(import_schedule(set_cells(content, changes), p, metadata=metadata))
        self.assertEqual(result['lessons'][0]['subject'], '语文')
        self.assertEqual(result['lessons'][0]['teacher'], '欧阳老师')
        self.assertEqual(result['dutyRotations']['midday']['lessons'][0]['teacher'], '午间老师')
        self.assertEqual(result['dutyRotations']['evening']['lessons'][0]['subject'], '英语')
        evening = [l for l in result['dutyRotations']['evening']['lessons'] if l['cycleWeek'] == 1 and l['weekday'] == 1]
        self.assertEqual(len(evening), 2)
        self.assertTrue(all(l['subject'] == '英语' and l['teacher'] == '晚自习老师' and l['location'] == '' for l in evening))
        self.assertEqual(metadata, {'dutiesIncluded': True, 'sourceClass': '高一（9）班', 'scheduleOnly': True})
        self.assertEqual(result['appearance'], p['appearance'])
        self.assertEqual(p['lessons'][0]['subject'], '物理')

    def test_enable_midday_uses_existing_times_without_time_inputs(self):
        p = normalize(defaults('高一'))
        p['slots'].append({'id': 'school-midday', 'label': '午间静校', 'start': 740, 'end': 810})
        p = normalize(p)
        content = export_schedule(p)
        n, _ = groups(content, '午间静校')[0]
        settings = n - 2
        content = set_cells(content, {f'B{settings}': '是', f'D{n}': '静校', f'D{n+1}': '李老师'})
        result = normalize(import_schedule(content, p))
        duty = result['dutyRotations']['midday']
        self.assertTrue(duty['enabled'])
        self.assertEqual(len(duty['slotIds']), 1)
        self.assertEqual(duty['lessons'][0]['teacher'], '李老师')
        slot = next(s for s in result['slots'] if s['id'] == duty['slotIds'][0])
        self.assertEqual((slot['start'], slot['end']), (740, 810))
        self.assertEqual(result['slots'], p['slots'])

    def test_missing_midday_slot_requests_platform_setup_without_creating_times(self):
        p = normalize(defaults('高一'))
        content = export_schedule(p)
        n, _ = groups(content, '午间静校')[0]
        with self.assertRaisesRegex(ValueError, f'B{n}.*先在平台设置.*无需填写时间'):
            import_schedule(set_cells(content, {f'D{n}': '静校', f'D{n+1}': '李老师'}), p)

    def test_import_uses_destination_class_times_and_maps_different_slot_ids(self):
        source = self.profile()
        target = copy.deepcopy(source)
        target['slots'][1].update(start=480, end=525)
        target['slots'][1]['id'] = 'target-period-1'
        target['lessons'][0]['slotId'] = 'target-period-1'
        result = normalize(import_schedule(export_schedule(source), target))
        self.assertEqual(result['slots'], target['slots'])
        self.assertEqual(result['lessons'][0]['slotId'], 'target-period-1')

    def test_mixed_all_odd_even_days_and_disabled_duty_data_are_retained(self):
        p = self.profile()
        p['lessons'].extend([{'slotId': 'period-1', 'weekday': 2, 'week': 'odd', 'subject': '语文', 'teacher': '', 'location': ''},
                             {'slotId': 'period-1', 'weekday': 2, 'week': 'even', 'subject': '历史', 'teacher': '', 'location': ''}])
        p['dutyRotations']['midday']['enabled'] = False
        result = normalize(import_schedule(export_schedule(p), p))
        self.assertCountEqual(result['lessons'], p['lessons'])
        self.assertEqual(result['dutyRotations'], p['dutyRotations'])

    def test_twenty_week_maximum_and_blank_later_weeks(self):
        p = self.profile()
        for duty in p['dutyRotations'].values():
            duty['cycleWeeks'] = 20
        result = normalize(import_schedule(export_schedule(p), p))
        self.assertEqual(result, p)
        self.assertLess(len(read_sheets(export_schedule(p))[SHEET]), 1000)

    def test_compact_template_has_no_empty_location_rows_or_time_inputs(self):
        content = export_schedule(self.profile())
        rows = read_sheets(content)[SHEET]
        self.assertFalse(any(r[2] == '地点' for r in rows))
        self.assertFalse(any('07:55' in value or '08:40' in value for r in rows for value in r))
        evening = groups(content, '晚自习')
        self.assertEqual(len(evening), 4)
        self.assertTrue(all(r[1] == '晚自习（两节统一）' and r[10].startswith(DAY_GROUP) for _, r in evening))

    def test_teacher_only_duty_input_defaults_activity_and_expands_both_evening_slots(self):
        p = self.profile()
        content = export_schedule(p)
        changes = {}
        for title in ('午间静校', '晚自习'):
            n, _ = groups(content, title)[0]
            changes.update({f'D{n}': '', f'D{n+1}': '李老师'})
        result = normalize(import_schedule(set_cells(content, changes), p))
        for kind, title, count in [('midday', '午间静校', 1), ('evening', '晚自习', 2)]:
            rows = [l for l in result['dutyRotations'][kind]['lessons'] if l['cycleWeek'] == 1]
            self.assertEqual(len(rows), count)
            self.assertTrue(all(l['subject'] == title and l['teacher'] == '李老师' and not l['location'] for l in rows))

    def test_split_evening_subject_teacher_location_and_missing_lesson_round_trip(self):
        for change in ({'subject': '英语'}, {'teacher': '另一位老师'}, {'location': '实验室'}, None):
            with self.subTest(change=change):
                p = self.profile()
                lessons = p['dutyRotations']['evening']['lessons']
                if change is None:
                    lessons.pop(1)
                else:
                    lessons[1].update(change)
                p = normalize(p)
                content = export_schedule(p)
                first_week = [r for _, r in groups(content, '晚自习') if r[0] == '1']
                self.assertEqual(len(first_week), 2)
                self.assertTrue(all(not r[10].startswith(DAY_GROUP) for r in first_week))
                self.assertEqual(normalize(import_schedule(content, p)), p)

    def test_existing_locations_stay_visible_and_editable(self):
        p = self.profile()
        p['lessons'][0]['location'] = '实验室'
        for l in p['dutyRotations']['evening']['lessons']:
            l['location'] = '图书馆'
        content = export_schedule(p)
        n, _ = groups(content, '晚自习')[0]
        self.assertEqual(read_sheets(content)[SHEET][next(i for i, r in enumerate(read_sheets(content)[SHEET]) if r[2] == '学科' and r[10].startswith(DAY_GROUP)) + 2][2], '地点')
        result = normalize(import_schedule(set_cells(content, {f'D{n+2}': '本班教室'}), p))
        self.assertEqual(result['lessons'], p['lessons'])
        self.assertTrue(all(l['location'] == '本班教室' for l in result['dutyRotations']['evening']['lessons'] if l['cycleWeek'] == 1))

    def test_combined_slots_map_to_destination_ids_without_changing_times(self):
        source = self.profile()
        target = copy.deepcopy(source)
        mapping = {sid: 'target-' + sid for sid in source['dutyRotations']['evening']['slotIds']}
        for s in target['slots']:
            s['id'] = mapping.get(s['id'], s['id'])
        duty = target['dutyRotations']['evening']
        duty['slotIds'] = [mapping[sid] for sid in duty['slotIds']]
        for l in duty['lessons']:
            l['slotId'] = mapping[l['slotId']]
        self.assertEqual(normalize(import_schedule(export_schedule(source), target)), normalize(target))

    def test_invalid_combined_metadata_and_renamed_group_are_rejected(self):
        content = export_schedule(self.profile())
        n, _ = groups(content, '晚自习')[0]
        for value in ('@day:invalid', '@day:[]', '@day:[["evening-study-1","晚自习第1节"]]',
                      '@day:[[{},"a"],["b","c"]]'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, f'B{n}'):
                import_schedule(set_cells(content, {f'K{n}': value}), self.profile())
        with self.assertRaisesRegex(ValueError, f'B{n}'):
            import_schedule(set_cells(content, {f'B{n}': '晚自习第1节'}), self.profile())

    def test_older_three_row_template_still_imports(self):
        p = self.profile()
        # Existing nonempty location rows also produce the old three-row shape.
        for l in p['lessons']:
            l['location'] = '实验室'
        for duty in p['dutyRotations'].values():
            for l in duty['lessons']:
                l['location'] = '本班教室'
        p['dutyRotations']['evening']['lessons'][1]['teacher'] = '另一位老师'
        p = normalize(p)
        self.assertEqual(normalize(import_schedule(export_schedule(p), p)), p)

    def test_copying_two_rows_adds_a_new_cycle_week(self):
        p = self.profile()
        content = export_schedule(p)
        first, _ = groups(content, '午间静校')[0]
        last, _ = groups(content, '午间静校')[-1]
        content = set_cells(content, {f'E{first-2}': 4})
        def transform(name, data):
            if name != 'xl/worksheets/sheet1.xml':
                return data
            root = ET.fromstring(data)
            sheet_data = root.find(f'{{{S}}}sheetData')
            original = list(sheet_data)
            copied = [copy.deepcopy(row) for row in original if first <= int(row.attrib['r']) < first + 2]
            for c in copied[0]:
                if c.attrib['r'] == f'A{first}':
                    c.find(f'{{{S}}}v').text = '4'
            insert_at = next(i for i, row in enumerate(original) if int(row.attrib['r']) == last + 1) + 1
            for offset, row in enumerate(copied):
                sheet_data.insert(insert_at + offset, row)
            for n, row in enumerate(sheet_data, 1):
                row.set('r', str(n))
                for c in row:
                    letters = ''.join(char for char in c.attrib['r'] if char.isalpha())
                    c.set('r', letters + str(n))
            return xml(root)
        result = normalize(import_schedule(edit_book(content, transform), p))
        midday = result['dutyRotations']['midday']
        self.assertEqual(midday['cycleWeeks'], 4)
        self.assertEqual(next(l for l in midday['lessons'] if l['cycleWeek'] == 4)['teacher'], 'midday-1')
        self.assertEqual(result['dutyRotations']['evening'], p['dutyRotations']['evening'])
        self.assertEqual(result['slots'], p['slots'])

    def test_errors_point_to_visible_cells_and_never_mutate_current_profile(self):
        p = self.profile()
        original = copy.deepcopy(p)
        content = export_schedule(p)
        n, _ = next(g for g in groups(content, '日常课程') if g[1][10] == 'period-1')
        midday_n, _ = groups(content, '午间静校')[0]
        settings = midday_n - 2
        for changes, address in [({f'D{n}': '' , f'D{n+1}': '仅教师'}, f'D{n}'),
                ({f'B{n}': '不存在的课节'}, f'B{n}'), ({f'A{n}': '三周'}, f'A{n}'),
                ({f'D{n+1}': '很长' * 21}, f'D{n+1}'), ({f'E{settings}': 2}, 'A'),
                ({f'E{settings}': 21}, f'E{settings}'), ({f'H{settings}': '2026-09-08'}, f'H{settings}'),
                ({'D7': '星期二'}, 'A7'), ({f'C{n+1}': ''}, f'C{n}')]:
            with self.subTest(changes=changes):
                with self.assertRaisesRegex(ValueError, '班级课表.*' + address):
                    import_schedule(set_cells(content, changes), p)
        self.assertEqual(p, original)

    def test_numeric_dates_and_1904_date_system(self):
        p = self.profile()
        content = export_schedule(p)
        def transform(name, data):
            root = ET.fromstring(data) if name in ('xl/workbook.xml', 'xl/worksheets/sheet1.xml') else None
            if name == 'xl/workbook.xml':
                child(root, S, 'workbookPr', date1904=1)
            elif name == 'xl/worksheets/sheet1.xml':
                for c in root.iter(f'{{{S}}}c'):
                    if c.attrib.get('s') == '16':
                        node = c.find(f'{{{S}}}v')
                        node.text = str(int(node.text) - 1462)
            return xml(root) if root is not None else data
        self.assertEqual(normalize(import_schedule(edit_book(content, transform), p)), p)

    def test_legacy_four_and_six_sheet_files_still_import(self):
        p = self.profile()
        for duties in (False, True):
            metadata = {}
            self.assertEqual(normalize(import_schedule(legacy_xlsx(p, duties=duties), p, metadata=metadata)), p)
            self.assertEqual(metadata['dutiesIncluded'], duties)

    def test_removed_optional_override_sheet_keeps_existing_overrides(self):
        p = self.profile()
        p['overrides'] = [{'date': '2026-10-19', 'slotId': 'period-1', 'subject': '', 'teacher': '', 'location': '', 'cancelled': True}]
        def transform(name, data):
            if name != 'xl/workbook.xml':
                return data
            root = ET.fromstring(data)
            nodes = root.find(f'{{{S}}}sheets')
            nodes.remove(list(nodes)[1])
            return xml(root)
        self.assertEqual(normalize(import_schedule(edit_book(export_schedule(p), transform), p)), p)

    def test_formula_beyond_recognized_columns_is_rejected(self):
        content = export_schedule(self.profile())
        def transform(name, data):
            if name != 'xl/worksheets/sheet1.xml':
                return data
            root = ET.fromstring(data)
            node = child(next(root.iter(f'{{{S}}}row')), S, 'c', r='Z1')
            text(node, S, 'f', '1+1')
            return xml(root)
        with self.assertRaisesRegex(ValueError, 'Z1.*公式'):
            read_sheets(edit_book(content, transform))


if __name__ == '__main__':
    unittest.main()

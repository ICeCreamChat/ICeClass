"""Teacher-facing timetable layout and parsing; the archive reader lives in island_xlsx."""
from __future__ import annotations

import copy
import json
import math
import re
import unicodedata
from datetime import date, timedelta
from xml.etree import ElementTree as ET

from reading_xlsx import S, child, cell, column, styles, text

SHEET = '班级课表'
DAYS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']
SECTIONS = {'日常课程': None, '午间静校': 'midday', '晚自习': 'evening'}
FIELDS = [('学科', 'subject'), ('教师', 'teacher'), ('地点', 'location')]
PARITIES = {'全部': 'all', '单周': 'odd', '双周': 'even'}
DAY_GROUP = '@day:'


def template_styles():
    root = styles()
    fonts, fills, borders, xfs = [root.find(f'{{{S}}}{tag}') for tag in ('fonts', 'fills', 'borders', 'cellXfs')]
    for font in fonts:
        font.find(f'{{{S}}}color').set('rgb', 'FF111111')
    for fill in fills:
        color = fill.find(f'{{{S}}}patternFill/{{{S}}}fgColor')
        if color is not None:
            color.set('rgb', 'FFFFFFFF')
    for size, bold, color in [(16, True, 'FF111111'), (11, True, 'FF111111'), (10, False, 'FF333333')]:
        font = child(fonts, S, 'font')
        child(font, S, 'name', val='Microsoft YaHei')
        child(font, S, 'sz', val=size)
        child(font, S, 'color', rgb=color)
        if bold:
            child(font, S, 'b')
    for color in ('FFFFFFFF', 'FFFFFFFF'):
        fill = child(child(fills, S, 'fill'), S, 'patternFill', patternType='solid')
        child(fill, S, 'fgColor', rgb=color)
        child(fill, S, 'bgColor', indexed=64)
    border = child(borders, S, 'border')
    for side in ('left', 'right', 'top', 'bottom', 'diagonal'):
        edge = child(border, S, side, **({'style': 'thin'} if side != 'diagonal' else {}))
        if side != 'diagonal':
            child(edge, S, 'color', rgb='FF111111')
    number_formats = root.find(f'{{{S}}}numFmts')
    child(number_formats, S, 'numFmt', numFmtId=167, formatCode='[hh]:mm')
    number_formats.set('count', str(len(number_formats)))
    # Title, section, input, subject input, field label, header, time, date,
    # slot label, note, last input row. Existing styles 0-8 remain unchanged.
    for font, fill, num, border_id in [(4, 0, 0, 0), (5, 3, 0, 1), (0, 4, 0, 1),
            (5, 4, 0, 1), (6, 5, 0, 1), (2, 2, 0, 1), (0, 4, 167, 1),
            (0, 4, 165, 1), (5, 5, 0, 1), (6, 0, 0, 0), (0, 4, 0, 1)]:
        xf = child(xfs, S, 'xf', numFmtId=num, fontId=font, fillId=fill, borderId=border_id,
                   xfId=0, applyAlignment=1, applyNumberFormat=1)
        child(xf, S, 'alignment', vertical='center', horizontal='center' if font == 2 else 'left', wrapText=1)
    for node in (fonts, fills, borders, xfs):
        node.set('count', str(len(node)))
    # The auxiliary temporary-change table uses the original base/header styles.
    for i in (0, 2):
        xfs[i].set('borderId', '1')
    return root


def template_sheet(config, class_name=''):
    root = ET.Element(f'{{{S}}}worksheet')
    view = child(child(root, S, 'sheetViews'), S, 'sheetView', workbookViewId=0, showGridLines=0)
    child(view, S, 'pane', xSplit=3, ySplit=7, topLeftCell='D8', activePane='bottomRight', state='frozen')
    child(view, S, 'selection', pane='bottomRight', activeCell='D8', sqref='D8')
    child(root, S, 'sheetFormatPr', defaultRowHeight=24)
    cols = child(root, S, 'cols')
    widths = [10, 25, 8, *([18] * 7), 12]
    for i, width in enumerate(widths, 1):
        child(cols, S, 'col', min=i, max=i, width=width, customWidth=1, **({'hidden': 1} if i == 11 else {}))
    data = child(root, S, 'sheetData')
    merges, validations = [], []
    row_number = 0

    def row(values=(), formats=None, height=26):
        nonlocal row_number
        row_number += 1
        node = child(data, S, 'row', r=row_number, ht=height, customHeight=1)
        for i, value in enumerate(values, 1):
            cell(node, i, value, (formats or {}).get(i, 0))
        return row_number

    def band(title, style=10, height=31):
        n = row([title, *([''] * 9)], {i: style for i in range(1, 11)}, height)
        merges.append(f'A{n}:J{n}')
        return n

    def header(duty=False):
        row(['循环周' if duty else '周次', '时段', '内容', *DAYS, '时段标识'],
            {i: 14 for i in range(1, 12)}, 29)

    def group(slot, week, lessons, duty=False):
        # Most teaching takes place in the class's own room. Only expose a
        # location row when there is existing location data to preserve.
        fields = FIELDS if any(l.get('location') for l in lessons.values()) else FIELDS[:2]
        for index, (label, key) in enumerate(fields):
            values = [lessons.get(day, {}).get(key, '') for day in range(1, 8)]
            formats = {1: 11, 2: 17, 3: 13,
                       **{i: 12 if index == 0 else 19 if index == 2 else 11 for i in range(4, 11)}}
            # Fit exported long teacher/place names without reducing the font.
            height = max(26, max((math.ceil(sum(2 if unicodedata.east_asian_width(c) in 'FW' else 1
                       for c in str(value)) / 17) * 15 + 8 for value in values), default=26))
            if index == 0:
                height = max(height, math.ceil(sum(2 if unicodedata.east_asian_width(c) in 'FW' else 1
                             for c in slot['label']) / 24) * 15 + 8)
            n = row([week if index == 0 else '', slot['label'] if index == 0 else '',
                     label, *values,
                     slot.get('id', '') if index == 0 else ''], formats, height)
            if index == 0 and not duty:
                validations.append((f'A{n}', 'list', '"全部,单周,双周"', None))

    row(height=9)
    band((class_name + ' ' if class_name else '') + '课程与值班安排', 9, 34)
    band('按星期填写学科、教师；值班可只填教师。地点默认本班教室，上课时间沿用平台作息，无需填写。', 18, 27)
    row(['班级', class_name, '', '', '学期首周', date.fromisoformat(config['weekAnchor']), '', '', '填写首周周一'],
        {1: 17, 2: 11, 5: 17, 6: 16, 9: 18}, 28)
    merges.extend(['B4:D4', 'F4:H4', 'I4:J4'])
    band('晚自习每天填一次，自动应用到两节；已有分节安排会分别列出。增加循环周：复制整周行，再修改周次和循环周数。', 18, 28)
    band('日常课程')
    header()
    duties = config.get('dutyRotations', {})
    owned = {sid for d in duties.values() for sid in d['slotIds']}
    fixed = {l['slotId'] for l in config['lessons']}
    slots = {s['id']: s for s in config['slots']}
    daily = [s for s in config['slots'] if s['id'] not in owned or s['id'] in fixed]
    for slot in daily or [{'label': '第一节'}]:
        lessons = [l for l in config['lessons'] if l['slotId'] == slot.get('id')]
        parities = (['all'] if not lessons or any(l['week'] == 'all' for l in lessons) else [])
        if any(l['week'] != 'all' for l in lessons):
            parities.extend(['odd', 'even'])
        for parity in parities:
            group(slot, next(k for k, v in PARITIES.items() if v == parity),
                  {l['weekday']: l for l in lessons if l['week'] == parity})
    for title, kind in list(SECTIONS.items())[1:]:
        duty = duties.get(kind, {'enabled': False, 'cycleWeeks': 2, 'weekAnchor': config['weekAnchor'], 'slotIds': [], 'lessons': []})
        row(height=12)
        band(title)
        n = row(['启用循环', '是' if duty['enabled'] else '否', '', '循环周数', duty['cycleWeeks'], '',
                 '首周周一', date.fromisoformat(duty['weekAnchor'])],
                {1: 17, 2: 11, 4: 17, 5: 11, 7: 17, 8: 16}, 28)
        merges.extend([f'H{n}:J{n}'])
        validations.extend([(f'B{n}', 'list', '"是,否"', None), (f'E{n}', 'whole', 1, 20)])
        header(True)
        selected = [slots[sid] for sid in duty['slotIds']] or [{'label': title}]
        for week in range(1, duty['cycleWeeks'] + 1):
            arranged = [{l['weekday']: l for l in duty['lessons']
                         if l['cycleWeek'] == week and l['slotId'] == slot.get('id')} for slot in selected]
            def signature(days):
                return {day: tuple(l.get(key, '') for _, key in FIELDS) for day, l in days.items()}
            if kind == 'evening' and len(selected) > 1 and all(signature(days) == signature(arranged[0]) for days in arranged[1:]):
                # Metadata identifies the destination slots; visible cells are
                # the only authority for subjects, teachers and locations.
                combined = {'label': '晚自习（两节统一）', 'id': DAY_GROUP + json.dumps(
                    [[s['id'], s['label']] for s in selected], ensure_ascii=False, separators=(',', ':'))}
                group(combined, week, arranged[0], True)
            else:
                for slot, lessons in zip(selected, arranged):
                    group(slot, week, lessons, True)
    merged = child(root, S, 'mergeCells', count=len(merges))
    for ref in merges:
        child(merged, S, 'mergeCell', ref=ref)
    rules = child(root, S, 'dataValidations', count=len(validations))
    for ref, kind, first, last in validations:
        rule = child(rules, S, 'dataValidation', type=kind, sqref=ref, allowBlank=1,
                     showErrorMessage=1, errorTitle='请检查填写内容', error='请按表格提示填写。',
                     **({'operator': 'between'} if last is not None else {}))
        text(rule, S, 'formula1', first)
        if last is not None:
            text(rule, S, 'formula2', last)
    child(root, S, 'pageMargins', left=.25, right=.25, top=.4, bottom=.4, header=.2, footer=.2)
    child(root, S, 'pageSetup', orientation='landscape', paperSize=8, fitToWidth=1, fitToHeight=0)
    return root


def fail(ref, message):
    raise ValueError(f'“{SHEET}” {ref}：{message}')


def number(value, ref, low, high):
    if len(value) > 12 or not re.fullmatch(r'\d+(?:\.0+)?', value):
        fail(ref, f'请填写 {low}-{high} 的整数。')
    result = int(float(value))
    if not low <= result <= high:
        fail(ref, f'请填写 {low}-{high} 的整数。')
    return result


def monday(value, ref, date1904=False):
    try:
        if re.fullmatch(r'\d+(?:\.0+)?', value):
            result = date(1904, 1, 1) + timedelta(days=int(float(value))) if date1904 else date(1899, 12, 30) + timedelta(days=int(float(value)))
        else:
            result = date.fromisoformat(value.replace('/', '-'))
        if not 1900 <= result.year <= 9999 or result.weekday() != 0:
            raise ValueError()
        return result.isoformat()
    except (ValueError, OverflowError):
        fail(ref, '请填写首周周一日期，例如 2026-09-07。')


def match_slots(identifier, label, slots, kind, ref, has_lessons):
    def match(sid, name):
        if not isinstance(sid, str) or not isinstance(name, str) or not name:
            fail(ref, '时段标识不完整，请重新导出模板。')
        if sid in slots:
            if slots[sid]['label'] != name:
                fail(ref, '时段名称与本班作息不一致，请保留原名称，或重新导出本班模板。')
            return sid
        matches = [s['id'] for s in slots.values() if s['label'] == name]
        if len(matches) == 1:
            return matches[0]
        fail(ref, f'无法匹配本班的“{name}”时段，请先在平台设置作息或值班时段，再重新导出模板；Excel 无需填写时间。')

    if identifier.startswith(DAY_GROUP):
        try:
            pairs = json.loads(identifier[len(DAY_GROUP):])
        except (ValueError, RecursionError):
            fail(ref, '晚自习时段标识已损坏，请重新导出模板。')
        if (kind != 'evening' or label != '晚自习（两节统一）' or not isinstance(pairs, list) or len(pairs) != 2
                or any(not isinstance(p, list) or len(p) != 2 for p in pairs)):
            fail(ref, '请保留两节统一的晚自习时段名称和标识，或重新导出模板。')
        ids = [match(*pair) for pair in pairs]
        if len(set(ids)) != len(ids):
            fail(ref, '两节晚自习不能使用同一个时段。')
        return ids
    if not identifier and not has_lessons and not any(s['label'] == label for s in slots.values()):
        return []  # An unconfigured, empty placeholder must not create times.
    return [match(identifier, label)]


def parse_template(rows, current, *, date1904=False):
    result = copy.deepcopy(current)
    # The workbook contains courses, never a second editable copy of the bell
    # schedule. Import against the destination class's currently saved slots.
    result.update(lessons=[], dutyRotations={})
    section, seen, settings, headers = None, set(), set(), set()
    slots = {s['id']: s for s in current['slots']}
    groups = set()
    source_class, anchor_found = '', False
    numbers = getattr(rows, 'row_numbers', list(range(1, len(rows) + 1)))
    i = 0
    while i < len(rows):
        values, n = rows[i], numbers[i]
        a, b, field = values[:3]
        if a == '班级':
            if anchor_found or values[4] != '学期首周':
                fail(f'A{n}', '请保留唯一的班级与学期首周设置行。')
            source_class = b
            result['weekAnchor'] = monday(values[5], f'F{n}', date1904)
            anchor_found = True
        elif a in SECTIONS:
            if a in seen:
                fail(f'A{n}', '该区域重复，请只保留一份。')
            section = a
            seen.add(a)
        elif a == '启用循环' and section in SECTIONS and SECTIONS[section]:
            if section in settings or values[3] != '循环周数' or values[6] != '首周周一':
                fail(f'A{n}', '请保留唯一的启用循环、循环周数和首周周一设置行。')
            if b not in ('是', '否'):
                fail(f'B{n}', '启用循环请填写“是”或“否”。')
            result['dutyRotations'][SECTIONS[section]] = {'enabled': b == '是',
                'cycleWeeks': number(values[4], f'E{n}', 1, 20),
                'weekAnchor': monday(values[7], f'H{n}', date1904), 'slotIds': [], 'lessons': []}
            settings.add(section)
        elif a in ('周次', '循环周') and b == '时段':
            if section is None or values[:10] != [a, '时段', '内容', *DAYS]:
                fail(f'A{n}', '请保留时段、内容和星期一至星期日的原表头。')
            headers.add(section)
        elif field == '学科':
            if section not in headers or (SECTIONS[section] and section not in settings):
                fail(f'C{n}', '请先保留该区域的设置和表头。')
            if i + 1 >= len(rows) or rows[i + 1][2] != '教师':
                fail(f'C{n}', '每组须保留连续的学科、教师两行；已有的地点行也请一并保留。')
            count = 3 if i + 2 < len(rows) and rows[i + 2][2] == '地点' else 2
            block = rows[i:i + count]
            for k in range(1, count):
                if any(block[k][:2]) or block[k][10]:
                    fail(f'A{numbers[i + k]}', '周次和时段只保留在该组的学科行。')
            has_lessons = any(value for r in block for value in r[3:10])
            kind = SECTIONS[section]
            ids = match_slots(values[10], b, slots, kind, f'B{n}', has_lessons)
            if not ids:
                i += count
                continue
            if kind:
                duty = result['dutyRotations'][kind]
                week = number(a, f'A{n}', 1, 20)
                if week > duty['cycleWeeks'] and has_lessons:
                    fail(f'A{n}', '本周有安排，但已超出循环周数。请调整循环周数或清空这周的安排。')
                for sid in ids:
                    if sid not in duty['slotIds']:
                        duty['slotIds'].append(sid)
            else:
                if a not in PARITIES:
                    fail(f'A{n}', '周次请填写“全部”“单周”或“双周”。')
                week = PARITIES[a]
            for sid in ids:
                key = (section, sid, week)
                if key in groups:
                    fail(f'A{n}', '同一周次和时段重复，请合并到同一组。')
                groups.add(key)
            for day in range(1, 8):
                col = day + 2
                subject, teacher = [r[col] for r in block[:2]]
                location = block[2][col] if count == 3 else ''
                if not subject:
                    if kind and teacher:
                        subject = section
                    elif teacher or location:
                        fail(f'{column(col + 1)}{n}', '请补充学科；值班也可只填教师，没有安排时请将本组内容一起清空。')
                    else:
                        continue
                for offset, (value, limit, label) in enumerate([(subject, 40, '学科'), (teacher, 40, '教师'), (location, 60, '地点')]):
                    if len(value) > limit or any(ord(char) < 32 for char in value):
                        fail(f'{column(col + 1)}{numbers[i + offset]}', f'{label}最多 {limit} 字，不能包含换行或控制字符。')
                for sid in ids:
                    lesson = {'slotId': sid, 'weekday': day, 'subject': subject, 'teacher': teacher, 'location': location}
                    lesson['cycleWeek' if kind else 'week'] = week
                    (duty['lessons'] if kind else result['lessons']).append(lesson)
            i += count
            continue
        elif field in ('教师', '地点') or (section and any(values[:13])):
            fail(f'A{n}', '无法识别此行，请保留原来的区域、设置、表头及学科、教师行。')
        i += 1
    if seen != set(SECTIONS) or headers != set(SECTIONS) or not anchor_found or settings != set(SECTIONS) - {'日常课程'}:
        fail('A1', '请保留日常课程、午间静校、晚自习三个区域，以及各区域的设置。')
    return result, source_class

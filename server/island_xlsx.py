"""Bounded OOXML timetable import/export, without executing formulas or macros."""
from __future__ import annotations

import copy
import io
import math
import posixpath
import re
import zipfile
from xml.etree import ElementTree as ET

from reading_xlsx import S, R, T, P, child, text, xml, styles, cell, column, relationships

HEADERS = {'作息': ['时段标识', '名称', '开始', '结束'],
           '课程': ['星期(1-7)', '时段标识', '周次(全部/单周/双周)', '科目', '教师', '地点'],
           '临时调课': ['日期(YYYY-MM-DD)', '时段标识', '科目', '教师', '地点', '停课(是/否)'],
           '学期': ['第一周周一(YYYY-MM-DD)']}


def clock(n):
    return f'{n//60:02}:{n%60:02}'


def export_schedule(config):
    data = {'作息': [[s['id'], s['label'], clock(s['start']), clock(s['end'])] for s in config['slots']],
            '课程': [[l['weekday'], l['slotId'], {'all': '全部', 'odd': '单周', 'even': '双周'}[l['week']],
                     l['subject'], l['teacher'], l['location']] for l in config['lessons']],
            '临时调课': [[o['date'], o['slotId'], o['subject'], o['teacher'], o['location'], '是' if o['cancelled'] else '否'] for o in config['overrides']],
            '学期': [[config['weekAnchor']]]}
    workbook = ET.Element(f'{{{S}}}workbook')
    sheets = child(workbook, S, 'sheets')
    parts = {'xl/styles.xml': styles(), '_rels/.rels': relationships([('rId1', 'officeDocument', 'xl/workbook.xml')])}
    relations = []
    types = ET.Element(f'{{{T}}}Types')
    for ext, mime in [('rels', 'application/vnd.openxmlformats-package.relationships+xml'), ('xml', 'application/xml')]:
        child(types, T, 'Default', Extension=ext, ContentType=mime)
    for path, kind in [('xl/workbook.xml', 'sheet.main'), ('xl/styles.xml', 'styles')]:
        child(types, T, 'Override', PartName='/' + path, ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.' + kind + '+xml')
    for i, (name, headers) in enumerate(HEADERS.items(), 1):
        child(sheets, S, 'sheet', name=name, sheetId=i, **{f'{{{R}}}id': f'rId{i}'})
        root = ET.Element(f'{{{S}}}worksheet')
        view = child(child(root, S, 'sheetViews'), S, 'sheetView', workbookViewId=0)
        child(view, S, 'pane', ySplit=1, topLeftCell='A2', activePane='bottomLeft', state='frozen')
        cols = child(root, S, 'cols')
        for j in range(1, len(headers)+1):
            child(cols, S, 'col', min=j, max=j, width=30 if j == 1 else 24, customWidth=1)
        rows = child(root, S, 'sheetData')
        for j, values in enumerate([headers, *data[name]], 1):
            row = child(rows, S, 'row', r=j, ht=26, customHeight=1)
            for k, value in enumerate(values, 1):
                cell(row, k, value, 2 if j == 1 else 0)
        path = f'xl/worksheets/sheet{i}.xml'
        parts[path] = root
        relations.append((f'rId{i}', 'worksheet', f'worksheets/sheet{i}.xml'))
        child(types, T, 'Override', PartName='/' + path, ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml')
    relations.append(('rId5', 'styles', 'styles.xml'))
    parts.update({'[Content_Types].xml': types, 'xl/workbook.xml': workbook,
                  'xl/_rels/workbook.xml.rels': relationships(relations)})
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, root in parts.items():
            archive.writestr(name, xml(root))
    return output.getvalue()


def read_sheets(content):
    if not content or len(content) > 2_000_000:
        raise ValueError('请导入不超过 2 MB 的 .xlsx 文件。')
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or len(names) > 100 or sum(x.file_size for x in archive.infolist()) > 8_000_000:
                raise ValueError('Excel 文件结构过大或重复。')
            if any('vbaProject' in n for n in names):
                raise ValueError('不支持含宏的文件。')
            def parse(path):
                data = archive.read(path)
                if b'<!DOCTYPE' in data or b'<!ENTITY' in data:
                    raise ValueError('不支持此 XML 结构。')
                return ET.fromstring(data)
            strings = [''.join(x.itertext()) for x in parse('xl/sharedStrings.xml')] if 'xl/sharedStrings.xml' in names else []
            targets = {r.attrib['Id']: posixpath.normpath(posixpath.join('xl', r.attrib['Target'])) if not r.attrib['Target'].startswith('/') else r.attrib['Target'][1:]
                       for r in parse('xl/_rels/workbook.xml.rels') if r.attrib.get('TargetMode') != 'External'}
            result = {}
            for sheet in parse('xl/workbook.xml').find(f'{{{S}}}sheets'):
                name = sheet.attrib['name']
                if name not in HEADERS:
                    continue
                path = targets[sheet.attrib[f'{{{R}}}id']]
                if not path.startswith('xl/worksheets/'):
                    raise ValueError('无效的工作表路径。')
                result[name] = rows = []
                for row in parse(path).iter(f'{{{S}}}row'):
                    if len(rows) > 1000:
                        raise ValueError('单个工作表最多 1000 行。')
                    values = [''] * len(HEADERS[name])
                    for c in row.findall(f'{{{S}}}c'):
                        ref = c.attrib.get('r', '')
                        match = re.fullmatch(r'([A-Z]{1,3})\d+', ref)
                        if not match:
                            raise ValueError('无效的单元格。')
                        col = 0
                        for letter in match[1]:
                            col = col * 26 + ord(letter) - 64
                        if col > len(values):
                            continue
                        if c.find(f'{{{S}}}f') is not None:
                            raise ValueError('请先将公式粘贴为值再导入。')
                        kind = c.attrib.get('t')
                        value = c.findtext(f'{{{S}}}v', '')
                        if kind == 's':
                            value = strings[int(value)]
                        elif kind == 'inlineStr':
                            value = ''.join(c.find(f'{{{S}}}is').itertext())
                        values[col-1] = value.strip()
                    if any(values):
                        rows.append(values)
            return result
    except (zipfile.BadZipFile, KeyError, ET.ParseError, IndexError, TypeError, OverflowError) as error:
        raise ValueError('无法读取 Excel，请使用导出的课表模板。') from error


def import_schedule(content, current):
    sheets = read_sheets(content)
    for name, headers in HEADERS.items():
        if name not in sheets or not sheets[name] or sheets[name][0] != headers:
            raise ValueError(f'缺少“{name}”工作表或表头已修改，请先导出模板。')
    def minute(value):
        if not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d|24:00', value):
            try:
                number = float(value)
                if 0 <= number <= 1 and math.isfinite(number):
                    return round(number*1440)
            except ValueError:
                pass
            raise ValueError('作息时间请填写 HH:mm（如 08:00）。')
        return int(value[:2])*60 + int(value[3:])
    config = copy.deepcopy(current)
    config['slots'] = [{'id': r[0], 'label': r[1], 'start': minute(r[2]), 'end': minute(r[3])} for r in sheets['作息'][1:]]
    config['lessons'] = [{'weekday': int(r[0]), 'slotId': r[1], 'week': {'全部': 'all', '单周': 'odd', '双周': 'even'}.get(r[2], r[2]),
                          'subject': r[3], 'teacher': r[4], 'location': r[5]} for r in sheets['课程'][1:]]
    config['overrides'] = []
    for r in sheets['临时调课'][1:]:
        if r[5] not in ('是', '否', ''):
            raise ValueError('停课一栏请填写“是”或“否”。')
        config['overrides'].append({'date': r[0], 'slotId': r[1], 'subject': r[2], 'teacher': r[3], 'location': r[4], 'cancelled': r[5] == '是'})
    if len(sheets['学期']) != 2:
        raise ValueError('学期表应只填写一个第一周周一日期。')
    config['weekAnchor'] = sheets['学期'][1][0]
    return config

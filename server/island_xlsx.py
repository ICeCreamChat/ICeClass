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
from island_timetable_xlsx import SHEET, template_sheet, template_styles, parse_template

HEADERS = {'作息': ['时段标识', '名称', '开始', '结束'],
           '课程': ['星期(1-7)', '时段标识', '周次(全部/单周/双周)', '科目', '教师', '地点'],
           '临时调课': ['日期(YYYY-MM-DD)', '时段标识', '科目', '教师', '地点', '停课(是/否)'],
           '学期': ['第一周周一(YYYY-MM-DD)'],
           '值班循环': ['类型(午间静校/晚自习)', '启用(是/否)', '循环周数', '第一周周一(YYYY-MM-DD)', '时段标识1', '时段标识2'],
           '值班课程': ['类型(午间静校/晚自习)', '循环内周次', '星期(1-7)', '时段标识', '科目', '教师', '地点']}

DUTY_NAMES = {'midday': '午间静校', 'evening': '晚自习'}


def clock(n):
    return f'{n//60:02}:{n%60:02}'


def export_schedule(config, *, class_name=''):
    override = ET.Element(f'{{{S}}}worksheet')
    view = child(child(override, S, 'sheetViews'), S, 'sheetView', workbookViewId=0, showGridLines=0)
    child(view, S, 'pane', ySplit=1, topLeftCell='A2', activePane='bottomLeft', state='frozen')
    cols = child(override, S, 'cols')
    for i, width in enumerate([24, 28, 22, 22, 26, 20], 1):
        child(cols, S, 'col', min=i, max=i, width=width, customWidth=1)
    rows = child(override, S, 'sheetData')
    values = [HEADERS['临时调课'], *[[o['date'], o['slotId'], o['subject'], o['teacher'], o['location'],
              '是' if o['cancelled'] else '否'] for o in config['overrides']]]
    for n, values_row in enumerate(values, 1):
        row = child(rows, S, 'row', r=n, ht=28, customHeight=1)
        for i, value in enumerate(values_row, 1):
            cell(row, i, value, 2 if n == 1 else 0)
    documents = {SHEET: template_sheet(config, class_name), '临时调课': override}
    workbook = ET.Element(f'{{{S}}}workbook')
    sheets = child(workbook, S, 'sheets')
    parts = {'xl/styles.xml': template_styles(), '_rels/.rels': relationships([('rId1', 'officeDocument', 'xl/workbook.xml')])}
    relations = []
    types = ET.Element(f'{{{T}}}Types')
    for ext, mime in [('rels', 'application/vnd.openxmlformats-package.relationships+xml'), ('xml', 'application/xml')]:
        child(types, T, 'Default', Extension=ext, ContentType=mime)
    for path, kind in [('xl/workbook.xml', 'sheet.main'), ('xl/styles.xml', 'styles')]:
        child(types, T, 'Override', PartName='/' + path, ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.' + kind + '+xml')
    for i, (name, root) in enumerate(documents.items(), 1):
        child(sheets, S, 'sheet', name=name, sheetId=i, **{f'{{{R}}}id': f'rId{i}'})
        path = f'xl/worksheets/sheet{i}.xml'
        parts[path] = root
        relations.append((f'rId{i}', 'worksheet', f'worksheets/sheet{i}.xml'))
        child(types, T, 'Override', PartName='/' + path, ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml')
    relations.append((f'rId{len(documents) + 1}', 'styles', 'styles.xml'))
    parts.update({'[Content_Types].xml': types, 'xl/workbook.xml': workbook,
                  'xl/_rels/workbook.xml.rels': relationships(relations)})
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, root in parts.items():
            # OPC readers (including Windows Packaging/Excel) require package
            # roots in their default namespace, rather than an ns0 prefix.
            if root.tag in (f'{{{T}}}Types', f'{{{P}}}Relationships'):
                namespace = root.tag[1:].split('}')[0]
                root = copy.deepcopy(root)
                for node in root.iter():
                    node.tag = node.tag.removeprefix('{' + namespace + '}')
                root.set('xmlns', namespace)
            archive.writestr(name, xml(root))
    return output.getvalue()


class SheetRows(list):
    def __init__(self):
        super().__init__()
        self.row_numbers = []


class SheetSet(dict):
    date1904 = False


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
            result = SheetSet()
            workbook = parse('xl/workbook.xml')
            properties = workbook.find(f'{{{S}}}workbookPr')
            result.date1904 = properties is not None and properties.attrib.get('date1904') in ('1', 'true')
            for sheet in workbook.find(f'{{{S}}}sheets'):
                name = sheet.attrib['name']
                if name not in HEADERS and name != SHEET:
                    continue
                if name in result:
                    raise ValueError('Excel 工作表名称重复。')
                path = targets[sheet.attrib[f'{{{R}}}id']]
                if not path.startswith('xl/worksheets/'):
                    raise ValueError('无效的工作表路径。')
                result[name] = rows = SheetRows()
                for count, row in enumerate(parse(path).iter(f'{{{S}}}row'), 1):
                    if count > 1000:
                        raise ValueError('单个工作表最多 1000 行。')
                    n = int(row.attrib.get('r', count))
                    if n < 1 or n > 1_048_576 or (rows.row_numbers and n <= rows.row_numbers[-1]):
                        raise ValueError('工作表行号无效或重复。')
                    values = [''] * (11 if name == SHEET else len(HEADERS[name]))
                    for c in row.findall(f'{{{S}}}c'):
                        ref = c.attrib.get('r', '')
                        match = re.fullmatch(r'([A-Z]{1,3})\d+', ref)
                        if not match:
                            raise ValueError('无效的单元格。')
                        col = 0
                        for letter in match[1]:
                            col = col * 26 + ord(letter) - 64
                        if c.find(f'{{{S}}}f') is not None:
                            raise ValueError(f'“{name}” {ref}：请先将公式粘贴为值再导入。')
                        if col > len(values):
                            continue
                        kind = c.attrib.get('t')
                        value = c.findtext(f'{{{S}}}v', '')
                        if kind == 's':
                            value = strings[int(value)]
                        elif kind == 'inlineStr':
                            value = ''.join(c.find(f'{{{S}}}is').itertext())
                        values[col-1] = value.strip()
                    if any(values):
                        rows.append(values)
                        rows.row_numbers.append(n)
            return result
    except (zipfile.BadZipFile, KeyError, ET.ParseError, IndexError, TypeError, OverflowError) as error:
        raise ValueError('无法读取 Excel，请使用导出的课表模板。') from error


def import_schedule(content, current, *, metadata=None):
    sheets = read_sheets(content)
    if SHEET in sheets:
        config, source_class = parse_template(sheets[SHEET], current, date1904=sheets.date1904)
        if '临时调课' in sheets:
            config['overrides'] = _overrides(sheets['临时调课'])
        if metadata is not None:
            metadata.update(dutiesIncluded=True, sourceClass=source_class, scheduleOnly=True)
        return config
    if metadata is not None:
        metadata['dutiesIncluded'] = '值班循环' in sheets or '值班课程' in sheets
    for name in ('作息', '课程', '临时调课', '学期'):
        headers = HEADERS[name]
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
    if '值班循环' in sheets or '值班课程' in sheets:
        for name in ('值班循环', '值班课程'):
            if name not in sheets or not sheets[name] or sheets[name][0] != HEADERS[name]:
                raise ValueError(f'请同时保留“值班循环”和“值班课程”工作表及原表头。')
        kinds = {name: kind for kind, name in DUTY_NAMES.items()}
        config['dutyRotations'] = {}
        for r in sheets['值班循环'][1:]:
            kind = kinds.get(r[0])
            if not kind or kind in config['dutyRotations'] or r[1] not in ('是', '否'):
                raise ValueError('值班循环的类型不可重复，启用一栏请填写“是”或“否”。')
            config['dutyRotations'][kind] = {'enabled': r[1] == '是', 'cycleWeeks': int(r[2]),
                                             'weekAnchor': r[3], 'slotIds': [s for s in r[4:6] if s], 'lessons': []}
        for r in sheets['值班课程'][1:]:
            kind = kinds.get(r[0])
            if kind not in config['dutyRotations']:
                raise ValueError('值班课程的类型必须先在“值班循环”中设置。')
            config['dutyRotations'][kind]['lessons'].append({'cycleWeek': int(r[1]), 'weekday': int(r[2]),
                'slotId': r[3], 'subject': r[4], 'teacher': r[5], 'location': r[6]})
    return config


def _overrides(rows):
    if not rows or rows[0] != HEADERS['临时调课']:
        raise ValueError('请保留“临时调课”工作表的原表头。')
    result = []
    for r in rows[1:]:
        if r[5] not in ('是', '否', ''):
            raise ValueError('停课一栏请填写“是”或“否”。')
        result.append({'date': r[0], 'slotId': r[1], 'subject': r[2], 'teacher': r[3],
                       'location': r[4], 'cancelled': r[5] == '是'})
    return result

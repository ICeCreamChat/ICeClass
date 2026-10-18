"""Export the authorized reading report as a small, dependency-free XLSX file."""
from __future__ import annotations

import io
import math
import re
import unicodedata
import zipfile
from datetime import date, datetime, timedelta, timezone
from xml.etree import ElementTree as ET

S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
D = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
T = 'http://schemas.openxmlformats.org/package/2006/content-types'
for prefix, uri in (('', S), ('r', R), ('c', C), ('a', A), ('xdr', D)):
    ET.register_namespace(prefix, uri)

SYNC = {'current': '已同步', 'pending': '待补传', 'review': '待核实', 'unconfirmed': '待同步确认'}
MODES = {'classic': '兔拔萝卜', 'carving': '诗词镌刻', 'particle': '粒子浮雕', 'rocket': '火箭升空'}
COUNTS = ('carrots', 'poems', 'badges', 'launches', 'energy')
COUNT_LABELS = ['萝卜（颗）', '诗词（篇）', '徽章（次）', '发射（次）', '能量（格）']
INVALID_XML = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]')


def child(parent, namespace, tag, **attrs):
    return ET.SubElement(parent, f'{{{namespace}}}{tag}', {key: str(value) for key, value in attrs.items()})


def text(parent, namespace, tag, value, **attrs):
    element = child(parent, namespace, tag, **attrs)
    element.text = INVALID_XML.sub('', str(value))[:32767]
    return element


def xml(root):
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def column(index):
    name = ''
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


def cell(row, index, value, style=0):
    c = child(row, S, 'c', r=column(index) + row.attrib['r'], s=style)
    if value is None:
        return
    if isinstance(value, date):
        value = (value - date(1899, 12, 30)).days
    if isinstance(value, (int, float)) and math.isfinite(value):
        text(c, S, 'v', value)
    else:
        c.set('t', 'inlineStr')
        text(child(c, S, 'is'), S, 't', value, **{'{http://www.w3.org/XML/1998/namespace}space': 'preserve'})


def styles():
    root = ET.Element(f'{{{S}}}styleSheet')
    formats = child(root, S, 'numFmts', count=3)
    for id_, code in ((164, '[m]"分"ss"秒"'), (165, 'yyyy-mm-dd'), (166, '0.0%')):
        child(formats, S, 'numFmt', numFmtId=id_, formatCode=code)
    fonts = child(root, S, 'fonts', count=4)
    for size, bold, color in ((11, False, 'FF263B50'), (20, True, 'FF0B62B0'), (11, True, 'FFFFFFFF'), (11, True, 'FF096AC5')):
        f = child(fonts, S, 'font'); child(f, S, 'sz', val=size); child(f, S, 'name', val='Microsoft YaHei')
        child(f, S, 'color', rgb=color)
        if bold:
            child(f, S, 'b')
    fills = child(root, S, 'fills', count=4)
    for pattern, color in (('none', None), ('gray125', None), ('solid', 'FF1673CB'), ('solid', 'FFF0F6FD')):
        fill = child(child(fills, S, 'fill'), S, 'patternFill', patternType=pattern)
        if color:
            child(fill, S, 'fgColor', rgb=color); child(fill, S, 'bgColor', indexed=64)
    borders = child(root, S, 'borders', count=1)
    border = child(borders, S, 'border')
    for side in ('left', 'right', 'top', 'bottom', 'diagonal'):
        child(border, S, side)
    child(child(root, S, 'cellStyleXfs', count=1), S, 'xf', numFmtId=0, fontId=0, fillId=0, borderId=0)
    xfs = child(root, S, 'cellXfs', count=9)
    # Base, title, header, integer, duration, percent, date, note, highlighted duration.
    for font, fill, num in ((0, 0, 0), (1, 0, 0), (2, 2, 0), (0, 0, 3), (0, 0, 164), (0, 0, 166), (0, 0, 165), (0, 3, 0), (3, 0, 164)):
        xf = child(xfs, S, 'xf', numFmtId=num, fontId=font, fillId=fill, borderId=0, xfId=0, applyAlignment=1, applyNumberFormat=1)
        child(xf, S, 'alignment', vertical='center', wrapText=1)
    child(child(root, S, 'cellStyles', count=1), S, 'cellStyle', name='Normal', xfId=0, builtinId=0)
    return root


def worksheet(headers, rows, widths, formats, report, title, summary, chart=False):
    root = ET.Element(f'{{{S}}}worksheet')
    header_row = 24 if chart else 6
    view = child(child(root, S, 'sheetViews'), S, 'sheetView', workbookViewId=0, showGridLines=0)
    # Do not pin the whole chart above the table: it would leave almost no room to scroll data on a laptop.
    if not chart:
        child(view, S, 'pane', ySplit=header_row, topLeftCell=f'A{header_row + 1}', activePane='bottomLeft', state='frozen')
        child(view, S, 'selection', pane='bottomLeft', activeCell=f'A{header_row + 1}', sqref=f'A{header_row + 1}')
    child(root, S, 'sheetFormatPr', defaultRowHeight=23)
    cols = child(root, S, 'cols')
    for i, width in enumerate(widths, 1):
        child(cols, S, 'col', min=i, max=i, width=width, customWidth=1)
    data = child(root, S, 'sheetData')
    cell(child(data, S, 'row', r=1, ht=38, customHeight=1), 1, title, 1)
    generated = datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M')
    scope = '、'.join(report.get('grades', [])) or '全部年级'
    cell(child(data, S, 'row', r=2, ht=27, customHeight=1), 1, f'{scope} · 统计区间：{report["start"]} 至 {report["end"]} · 导出于 {generated}（北京时间）')
    row = child(data, S, 'row', r=3, ht=28, customHeight=1)
    for i, (value, style) in enumerate(summary, 1):
        cell(row, i, value, style)
    cell(child(data, S, 'row', r=4, ht=34, customHeight=1), 1,
         '仅统计学校设定时段内的有效发声；同时长并列。弱网记录补传后成绩可能变化，结算前请确认同步完成。无记录不代表没有早读。', 7)
    row = child(data, S, 'row', r=header_row, ht=36, customHeight=1)
    for i, value in enumerate(headers, 1):
        cell(row, i, value, 2)
    for index, values in enumerate(rows, header_row + 1):
        # Account for Chinese characters when wrapping class names.
        width = sum(2 if unicodedata.east_asian_width(c) in ('F', 'W') else 1 for c in str(values[1]))
        row = child(data, S, 'row', r=index, ht=max(30, math.ceil(width / widths[1]) * 18), customHeight=1)
        for i, value in enumerate(values, 1):
            cell(row, i, value, formats.get(i, 0))
    child(root, S, 'autoFilter', ref=f'A{header_row}:{column(len(headers))}{header_row + len(rows)}')
    merges = child(root, S, 'mergeCells', count=3)
    for row in (1, 2, 4):
        child(merges, S, 'mergeCell', ref=f'A{row}:{column(len(headers))}{row}')
    child(root, S, 'pageMargins', left=.25, right=.25, top=.5, bottom=.5, header=.25, footer=.25)
    if chart:
        child(root, S, 'drawing', **{f'{{{R}}}id': 'rId1'})
    return root, header_row


def chart_parts(rows, first_row):
    root = ET.Element(f'{{{C}}}chartSpace')
    child(root, C, 'lang', val='zh-CN')
    chart = child(root, C, 'chart'); title = child(chart, C, 'title')
    rich = child(child(title, C, 'tx'), C, 'rich'); child(rich, A, 'bodyPr'); child(rich, A, 'lstStyle')
    p = child(rich, A, 'p'); text(child(p, A, 'r'), A, 't', f'有效发声 · 前 {len(rows)} 个有记录班级')
    child(title, C, 'overlay', val=0)
    plot = child(chart, C, 'plotArea'); child(plot, C, 'layout')
    bar = child(plot, C, 'barChart'); child(bar, C, 'barDir', val='col'); child(bar, C, 'grouping', val='clustered')
    child(bar, C, 'varyColors', val=0)
    series = child(bar, C, 'ser'); child(series, C, 'idx', val=0); child(series, C, 'order', val=0)
    text(child(series, C, 'tx'), C, 'v', '有效发声')
    child(child(child(series, C, 'spPr'), A, 'solidFill'), A, 'srgbClr', val='65A9EE')
    cat = child(child(series, C, 'cat'), C, 'strRef')
    text(cat, C, 'f', f"'班级排行榜'!$B${first_row}:$B${first_row + len(rows) - 1}")
    cache = child(cat, C, 'strCache'); child(cache, C, 'ptCount', val=len(rows))
    for i, row in enumerate(rows):
        text(child(cache, C, 'pt', idx=i), C, 'v', row['className'])
    val = child(child(series, C, 'val'), C, 'numRef')
    text(val, C, 'f', f"'班级排行榜'!$F${first_row}:$F${first_row + len(rows) - 1}")
    cache = child(val, C, 'numCache'); text(cache, C, 'formatCode', '[m]"分"ss"秒"'); child(cache, C, 'ptCount', val=len(rows))
    for i, row in enumerate(rows):
        text(child(cache, C, 'pt', idx=i), C, 'v', row['effectiveSeconds'] / 86400)
    labels = child(bar, C, 'dLbls'); child(labels, C, 'numFmt', formatCode='[m]"分"ss"秒"', sourceLinked=0)
    child(labels, C, 'showVal', val=1); child(labels, C, 'showLegendKey', val=0)
    child(bar, C, 'gapWidth', val=65)
    for id_ in (10, 20):
        child(bar, C, 'axId', val=id_)
    for tag, id_, cross, pos in (('catAx', 10, 20, 'b'), ('valAx', 20, 10, 'l')):
        axis = child(plot, C, tag); child(axis, C, 'axId', val=id_)
        scaling = child(axis, C, 'scaling'); child(scaling, C, 'orientation', val='minMax')
        if tag == 'valAx':
            child(scaling, C, 'min', val=0)
            child(scaling, C, 'max', val=max(1800, math.ceil(max(row['effectiveSeconds'] for row in rows) / 600) * 600) / 86400)
        child(axis, C, 'axPos', val=pos)
        if tag == 'valAx':
            child(axis, C, 'majorGridlines'); child(axis, C, 'numFmt', formatCode='[m]"分"', sourceLinked=0)
        child(axis, C, 'tickLblPos', val='nextTo'); child(axis, C, 'crossAx', val=cross); child(axis, C, 'crosses', val='autoZero')
    child(chart, C, 'plotVisOnly', val=1)
    drawing = ET.Element(f'{{{D}}}wsDr')
    anchor = child(drawing, D, 'twoCellAnchor')
    for tag, col, row in (('from', 0, 5), ('to', 10, 22)):
        marker = child(anchor, D, tag)
        for field, value in (('col', col), ('colOff', 0), ('row', row), ('rowOff', 0)):
            text(marker, D, field, value)
    frame = child(anchor, D, 'graphicFrame', macro='')
    props = child(frame, D, 'nvGraphicFramePr'); child(props, D, 'cNvPr', id=1, name='有效发声时长'); child(props, D, 'cNvGraphicFramePr')
    transform = child(frame, D, 'xfrm'); child(transform, A, 'off', x=0, y=0); child(transform, A, 'ext', cx=0, cy=0)
    graphic = child(child(frame, A, 'graphic'), A, 'graphicData', uri=C)
    child(graphic, C, 'chart', **{f'{{{R}}}id': 'rId1'}); child(anchor, D, 'clientData')
    return root, drawing


def relationships(items):
    root = ET.Element(f'{{{P}}}Relationships')
    for id_, type_, target in items:
        child(root, P, 'Relationship', Id=id_, Type=R + '/' + type_, Target=target)
    return root


def export_reading_xlsx(report):
    """Only consume the report already filtered by the caller's permissions."""
    rows = report['rows']
    used = sum(row['activeSeconds'] > 0 for row in rows)
    total = sum(row['effectiveSeconds'] for row in rows)
    summary = [('使用班级', 0), (used, 3), ('有效发声', 0), (total / 86400, 8), ('使用次数', 0), (sum(row['sessions'] for row in rows), 3),
               ('同步未确认', 0), (sum(row.get('sync', {}).get('state') != 'current' for row in rows), 3)]
    values = [[row['rank'], row['className'], row['sessions'], row['days'], row['activeSeconds'] / 86400, row['effectiveSeconds'] / 86400,
               row['ratio'] / 100 if row['ratio'] is not None else None, *[row['completed'][key] for key in COUNTS],
               '、'.join(MODES[mode] for mode in row['modes']), SYNC.get(row.get('sync', {}).get('state'), '待同步确认')] for row in rows]
    leaders = [row for row in rows if row['activeSeconds'] > 0][:10]
    sheet1, header = worksheet(['名次', '班级', '使用次数', '使用天数', '运行时长', '有效发声', '达标占比', *COUNT_LABELS, '活动模式', '同步状态'],
                               values, [9, 25, 12, 12, 18, 18, 14, 13, 13, 13, 13, 13, 27, 18],
                               {1: 3, 3: 3, 4: 3, 5: 4, 6: 8, 7: 5, **{i: 3 for i in range(8, 13)}}, report, 'ICeClass 班伴 · 班级早读排行榜', summary, bool(leaders))
    daily = [[date.fromisoformat(row['day']), row['className'], row['sessions'], row['activeSeconds'] / 86400, row['effectiveSeconds'] / 86400,
              *[row['completed'][key] for key in COUNTS]] for row in report['daily']]
    sheet2, _ = worksheet(['日期', '班级', '使用次数', '运行时长', '有效发声', *COUNT_LABELS], daily,
                         [16, 25, 12, 18, 18, 13, 13, 13, 13, 13], {1: 6, 3: 3, 4: 4, 5: 8, **{i: 3 for i in range(6, 11)}},
                         report, 'ICeClass 班伴 · 每日早读记录', summary)
    workbook = ET.Element(f'{{{S}}}workbook')
    sheets = child(workbook, S, 'sheets')
    for i, name in enumerate(('班级排行榜', '每日记录'), 1):
        child(sheets, S, 'sheet', name=name, sheetId=i, **{f'{{{R}}}id': f'rId{i}'})
    parts = {'xl/workbook.xml': workbook, 'xl/styles.xml': styles(), 'xl/worksheets/sheet1.xml': sheet1, 'xl/worksheets/sheet2.xml': sheet2,
             '_rels/.rels': relationships([('rId1', 'officeDocument', 'xl/workbook.xml')]),
             'xl/_rels/workbook.xml.rels': relationships([('rId1', 'worksheet', 'worksheets/sheet1.xml'), ('rId2', 'worksheet', 'worksheets/sheet2.xml'), ('rId3', 'styles', 'styles.xml')])}
    if leaders:
        chart, drawing = chart_parts(leaders, header + 1)
        parts.update({'xl/charts/chart1.xml': chart, 'xl/drawings/drawing1.xml': drawing,
                      'xl/worksheets/_rels/sheet1.xml.rels': relationships([('rId1', 'drawing', '../drawings/drawing1.xml')]),
                      'xl/drawings/_rels/drawing1.xml.rels': relationships([('rId1', 'chart', '../charts/chart1.xml')])})
    types = ET.Element(f'{{{T}}}Types')
    child(types, T, 'Default', Extension='rels', ContentType='application/vnd.openxmlformats-package.relationships+xml')
    child(types, T, 'Default', Extension='xml', ContentType='application/xml')
    for name, kind in [('xl/workbook.xml', 'spreadsheetml.sheet.main'), ('xl/styles.xml', 'spreadsheetml.styles'),
                       ('xl/worksheets/sheet1.xml', 'spreadsheetml.worksheet'), ('xl/worksheets/sheet2.xml', 'spreadsheetml.worksheet'),
                       *([('xl/charts/chart1.xml', 'drawingml.chart'), ('xl/drawings/drawing1.xml', 'drawing')] if leaders else [])]:
        child(types, T, 'Override', PartName='/' + name, ContentType=f'application/vnd.openxmlformats-officedocument.{kind}+xml')
    parts['[Content_Types].xml'] = types
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, root in parts.items():
            archive.writestr(name, xml(root))
    return output.getvalue()

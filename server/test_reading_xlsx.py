import io
import unittest
import zipfile
from datetime import date
from xml.etree import ElementTree as ET

from reading_xlsx import export_reading_xlsx
from test_app import ServerTestCase

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart'}


def sheets(body):
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        for name in archive.namelist():
            if name.endswith('.xml') or name.endswith('.rels'):
                ET.fromstring(archive.read(name))
        return [ET.fromstring(archive.read(f'xl/worksheets/sheet{i}.xml')) for i in (1, 2)]


class ReadingWorkbookTest(unittest.TestCase):
    def report(self):
        complete = dict.fromkeys(('carrots', 'poems', 'badges', 'launches', 'energy'), 0)
        complete['carrots'] = 4
        row = {'classId': 'one', 'className': '=1+1 & <班>\x01', 'rank': 1, 'sessions': 2, 'days': 1,
               'activeSeconds': 600, 'effectiveSeconds': 570, 'ratio': 95, 'modes': ['classic'],
               'completed': complete, 'sync': {'state': 'pending'}}
        return {'start': '2026-10-15', 'end': '2026-10-16', 'rows': [row],
                'daily': [{**row, 'day': '2026-10-16'}]}

    def test_workbook_keeps_numeric_units_dates_and_literal_user_text(self):
        report = self.report()
        body = export_reading_xlsx(report)
        first, daily = sheets(body)
        def value(root, ref):
            cell = root.find(f'.//s:c[@r="{ref}"]', NS)
            return cell, cell.findtext('s:v', namespaces=NS)
        name, _ = value(first, 'B25')
        self.assertEqual(name.get('t'), 'inlineStr')
        self.assertEqual(name.findtext('s:is/s:t', namespaces=NS), '=1+1 & <班>')
        self.assertEqual(first.findall('.//s:f', NS), [])
        self.assertEqual(float(value(first, 'C25')[1]), 2)
        self.assertAlmostEqual(float(value(first, 'F25')[1]) * 86400, 570)
        self.assertAlmostEqual(float(value(first, 'G25')[1]), .95)
        self.assertEqual(value(daily, 'A7')[1], str((date(2026, 10, 16) - date(1899, 12, 30)).days))
        self.assertEqual(first.find('s:autoFilter', NS).get('ref'), 'A24:N25')
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            chart = ET.fromstring(archive.read('xl/charts/chart1.xml'))
            self.assertEqual(chart.findtext('.//c:numRef/c:f', namespaces=NS), "'班级排行榜'!$F$25:$F$25")
            self.assertAlmostEqual(float(chart.findtext('.//c:numCache/c:pt/c:v', namespaces=NS)) * 86400, 570)
            self.assertIn('待补传', archive.read('xl/worksheets/sheet1.xml').decode())

    def test_empty_and_zero_reports_have_no_invented_rank_or_chart(self):
        report = self.report()
        report['rows'][0].update(activeSeconds=0, effectiveSeconds=0, rank=None, ratio=None, sessions=0, days=0)
        report['daily'] = []
        body = export_reading_xlsx(report)
        first, daily = sheets(body)
        self.assertIsNone(first.find('.//s:c[@r="A7"]/s:v', NS))
        self.assertIsNone(first.find('.//s:c[@r="G7"]/s:v', NS))
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            self.assertNotIn('xl/charts/chart1.xml', archive.namelist())
        report['rows'] = []
        first, daily = sheets(export_reading_xlsx(report))
        self.assertEqual(first.find('s:autoFilter', NS).get('ref'), 'A6:N6')
        self.assertEqual(daily.find('s:autoFilter', NS).get('ref'), 'A6:J6')


class ReadingExportTest(ServerTestCase):
    async def test_xlsx_export_requires_login_and_rejects_bad_ranges(self):
        response = await self.client.get('/api/reading/export?format=xlsx')
        self.assertEqual(response.status, 401)
        await self.bootstrap_and_login()
        for query in ('start=bad', 'start=2026-10-16&end=2026-10-15', 'start=2020-01-01&end=2026-10-16'):
            response = await self.client.get('/api/reading/export?format=xlsx&' + query, headers=self.headers())
            self.assertEqual(response.status, 400)

    async def test_xlsx_uses_same_class_and_date_permissions_as_report(self):
        device = await self.enroll_test_device()
        _, other = await self.json_request('POST', '/api/classes', {'name': '高二（9）班'}, csrf=True)
        await self.json_request('POST', '/api/teachers', {'username': 'xlsx_teacher', 'displayName': '王老师',
                                'password': 'TeacherPassword123', 'classIds': [device['classId']]}, csrf=True)
        response, user = await self.json_request('POST', '/api/auth/login', {'username': 'xlsx_teacher', 'password': 'TeacherPassword123'})
        self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]
        self.csrf = user['user']['csrfToken']
        response = await self.client.get('/api/reading/export?format=xlsx&start=2026-10-15&end=2026-10-16', headers=self.headers())
        self.assertEqual(response.status, 200)
        self.assertIn('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', response.headers['Content-Type'])
        self.assertIn('2026-10-15-2026-10-16.xlsx', response.headers['Content-Disposition'])
        body = await response.read()
        sheets(body)
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            contents = '\n'.join(archive.read(name).decode() for name in archive.namelist())
        self.assertIn('高一（1）班', contents)
        self.assertNotIn('高二（9）班', contents)
        response = await self.client.get('/api/reading/export?format=xlsx&classId=' + other['id'], headers=self.headers())
        self.assertEqual(response.status, 403)

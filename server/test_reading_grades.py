import io
import unittest
import zipfile
from urllib.parse import urlencode

import app as service
from reading import class_grade
from test_app import ServerTestCase


class GradeNamesTest(unittest.TestCase):
    def test_grades_allow_existing_names_spacing_and_fullwidth_digits(self):
        for name, expected in [('高一（1）班', '高一'), (' 高 二 （9）班 ', '高二'),
                               ('高三十班', '高三'), ('高１(8)班', '高一'), ('高2年级3班', '高二'),
                               ('高10班', '其他'), ('弱网验收班', '其他')]:
            with self.subTest(name=name):
                self.assertEqual(class_grade(name), expected)


class ReadingGradesTest(ServerTestCase):
    async def seed(self):
        await self.bootstrap_and_login()
        self.classes = {}
        for name, score in [('高一（10）班', 10), ('高一（2）班', 30), ('高二（1）班', 40),
                            ('高三（1）班', 30), ('弱网验收班', 0)]:
            response, row = await self.json_request('POST', '/api/classes', {'name': name}, csrf=True)
            self.assertEqual(response.status, 201, row)
            self.classes[name] = row['id']
            if score:
                self.app[service.STORE_KEY].run('INSERT INTO reading_buckets VALUES(?,?,?,?,?)',
                    (row['id'], '2026-10-16', 0, (1 << score) - 1, (1 << score) - 1))

    def query(self, **params):
        return urlencode({'start': '2026-10-16', 'end': '2026-10-16', **params})

    async def test_single_multiple_and_all_grades_recompute_ranks_and_daily_records(self):
        await self.seed()
        _, report = await self.json_request('GET', '/api/reading/report?' + self.query(grades='高一'))
        self.assertEqual([r['className'] for r in report['rows']], ['高一（2）班', '高一（10）班'])
        self.assertEqual([r['rank'] for r in report['rows']], [1, 2])
        self.assertEqual({r['className'] for r in report['daily']}, {'高一（2）班', '高一（10）班'})
        _, report = await self.json_request('GET', '/api/reading/report?' + self.query(grades='高三,高一,高三'))
        self.assertEqual(report['grades'], ['高一', '高三'])
        self.assertEqual([r['rank'] for r in report['rows']], [1, 1, 3])
        self.assertEqual({r['grade'] for r in report['rows']}, {'高一', '高三'})
        _, report = await self.json_request('GET', '/api/reading/report?' + self.query())
        self.assertEqual(len(report['rows']), 5)
        self.assertEqual(report['rows'][0]['className'], '高二（1）班')
        self.assertEqual(report['rows'][-1]['rank'], None)
        _, report = await self.json_request('GET', '/api/reading/report?' + self.query(grades='其他'))
        self.assertEqual([r['className'] for r in report['rows']], ['弱网验收班'])

    async def test_invalid_grade_and_class_combination(self):
        await self.seed()
        for path in ('report', 'export'):
            response = await self.client.get('/api/reading/' + path + '?' + self.query(grades='高四'), headers=self.headers())
            self.assertEqual(response.status, 400)
        _, report = await self.json_request('GET', '/api/reading/report?' + self.query(grades='高一', classId=self.classes['高二（1）班']))
        self.assertEqual(report['rows'], [])

    async def test_xlsx_and_csv_export_only_selected_grades(self):
        await self.seed()
        for format_ in ('xlsx', 'csv'):
            response = await self.client.get('/api/reading/export?' + self.query(grades='高一,高三', format=format_), headers=self.headers())
            self.assertEqual(response.status, 200)
            body = await response.read()
            if format_ == 'xlsx':
                with zipfile.ZipFile(io.BytesIO(body)) as archive:
                    content = '\n'.join(archive.read(n).decode('utf-8') for n in archive.namelist() if n.endswith('.xml'))
                self.assertIn('高一、高三', content)
            else:
                content = body.decode('utf-8-sig')
            self.assertIn('高一（2）班', content)
            self.assertIn('高三（1）班', content)
            self.assertNotIn('高二（1）班', content)

    async def test_grade_selection_cannot_expand_teacher_permissions(self):
        await self.seed()
        await self.json_request('POST', '/api/teachers', {'username': 'grade_teacher', 'displayName': '王老师',
            'password': 'TeacherPassword123', 'classIds': [self.classes['高一（2）班']]}, csrf=True)
        response, user = await self.json_request('POST', '/api/auth/login', {'username': 'grade_teacher', 'password': 'TeacherPassword123'})
        self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]
        self.csrf = user['user']['csrfToken']
        _, report = await self.json_request('GET', '/api/reading/report?' + self.query(grades='高一,高二,高三'))
        self.assertEqual([r['className'] for r in report['rows']], ['高一（2）班'])
        _, report = await self.json_request('GET', '/api/reading/report?' + self.query(grades='高二'))
        self.assertEqual(report['rows'], [])
        for path in ('report', 'export'):
            response = await self.client.get('/api/reading/' + path + '?' + self.query(grades='高一', classId=self.classes['高二（1）班']), headers=self.headers())
            self.assertEqual(response.status, 403)

"""Teacher history boundaries through the installed HTTP routes and a temporary school database."""
import csv
import io
import json
from urllib.parse import urlencode

from aiohttp.test_utils import make_mocked_request

from banban_operations import KEY as OPERATIONS_KEY
from test_card_quiz import CardQuizHttpCase, STAMP


class TeacherHistoryTests(CardQuizHttpCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        _, self.teacher = await self.account('history-teacher', teaching=[self.cid])
        self.empty = self.journal()['session']

    def insert_session(self, sid, stamp, subject='math'):
        value = {**self.empty, 'id': sid, 'subjectId': subject, 'startedAt': stamp}
        encoded = json.dumps(value)
        self.db.run('''INSERT INTO card_quiz_sessions
            (id,class_id,device_id,subject_id,started_at,ended_at,seq,revision,value,raw_value,updated_at)
            VALUES(?,?,?,?,?,?,?,1,?,?,?)''', (sid, self.cid, self.device['deviceId'], subject, stamp,
                                               value['endedAt'], value['seq'], encoded, encoded, stamp))

    async def history(self, path='/sessions', **params):
        return await self.api('GET', path + '?' + urlencode({'classId': self.cid, **params}), headers=self.teacher)

    async def test_1000_and_1001_sessions_and_full_cursor_walk(self):
        ids = [f'lesson-{i:04d}' for i in range(1001)]
        with self.db.transaction():
            for i, sid in enumerate(ids[:1000]):
                self.insert_session(sid, STAMP + i // 3)
            self.insert_session('history-only', STAMP, subject='history')
        at_limit = await self.history(subjectId='math')
        self.insert_session(ids[-1], STAMP + 1000 // 3)
        over_limit = await self.history(subjectId='math')
        for first, total in ((at_limit, 1000), (over_limit, 1001)):
            self.assertEqual(first['total'], total)
            self.assertLessEqual(len(first['sessions']), 100)
            self.assertEqual(first['sessions'][-1]['id'], ids[total - 1])
        page = await self.history(subjectId='math', limit=100)
        self.insert_session('new-during-read', STAMP + 1001)
        seen = []
        while True:
            batch = [s['id'] for s in reversed(page['sessions'])]
            self.assertTrue(0 < len(batch) <= 100)
            seen.extend(batch)
            if page['nextCursor'] is None:
                break
            self.assertLess(len(seen), len(ids))
            page = await self.history(subjectId='math', limit=100, **page['nextCursor'])
        self.assertEqual(seen, ids[::-1])
        self.assertEqual([s['id'] for s in (await self.history(subjectId='history'))['sessions']], ['history-only'])
        self.assertEqual((await self.history(subjectId='english'))['sessions'], [])
        self.assertEqual((await self.history(limit=1))['total'], 1003)

    async def test_tied_pages_exact_last_page_and_access(self):
        for sid in ('a', 'B', 'z', 'A'):
            self.insert_session(sid, STAMP)
        first = await self.history(limit=2)
        self.assertEqual([s['id'] for s in first['sessions']], ['a', 'z'])
        second = await self.history(limit=2, **first['nextCursor'])
        self.assertEqual([s['id'] for s in second['sessions']], ['A', 'B'])
        self.assertIsNone(second['nextCursor'])
        outside = await self.other_class()
        self.client.session.cookie_jar.clear()
        for route in ('/sessions', '/report'):
            query = route + '?' + urlencode({'classId': outside, **first['nextCursor']})
            await self.api('GET', query, status=403, headers=self.teacher)
            query = route + '?' + urlencode({'classId': self.cid, **first['nextCursor']})
            await self.api('GET', query, status=401, headers=self.dh)
            await self.api('GET', query, status=401, headers={})
            for invalid in ('limit=0', 'limit=101', 'limit=x', 'beforeStartedAt=1', 'beforeId=A',
                            'beforeId=A&beforeStartedAt=-1', 'beforeId=&beforeStartedAt=1'):
                with self.subTest(route=route, invalid=invalid):
                    await self.api('GET', f'{route}?classId={self.cid}&{invalid}', status=400, headers=self.teacher)

    async def test_teacher_capability_can_follow_numeric_cursor(self):
        for sid in ('a', 'b'):
            self.insert_session(sid, STAMP)
        request = make_mocked_request('GET', '/', headers=self.teacher, app=self.app)
        inspect = self.app[OPERATIONS_KEY].inspect
        query = {'classId': self.cid, 'subjectId': 'math', 'limit': 1}
        for resource in ('card-quiz.sessions', 'card-quiz.report'):
            first = await inspect(request, {'resource': resource, 'query': query})
            page = await inspect(request, {'resource': resource, 'query': {**query, **first['nextCursor']}})
            self.assertEqual([s['id'] for s in page['sessions']], ['a'])
            self.assertIsNone(page['nextCursor'])

    async def test_full_report_export_and_historic_detail_across_pages(self):
        await self.initialize()
        await self.sync(self.session(sid='old-graded'))
        with self.db.transaction():
            for i in range(1000):
                self.insert_session(f'pad-{i:04d}', STAMP + 10000)
        report = await self.history('/report', subjectId='math', limit=1)
        self.assertEqual([s['id'] for s in report['sessions']], ['pad-0999'])
        self.assertEqual(report['total'], 1001)
        self.assertEqual(report['knowledge'][0]['samples'], 2)
        self.assertEqual({s['studentId']: s['correct'] for s in report['students']}['s1'], 1)
        page = await self.history(subjectId='math', limit=1, **report['nextCursor'])
        self.assertEqual([s['id'] for s in page['sessions']], ['pad-0998'])
        detail = await self.api('GET', '/sessions/old-graded', headers=self.teacher)
        self.assertEqual(detail['report']['totals']['samples'], 2)
        csv_data = await self.history('/export', subjectId='math')
        rows = list(csv.reader(io.StringIO(csv_data.decode('utf-8-sig'))))
        self.assertEqual([row[1] for row in rows[1:]], ['old-graded'] * 4)

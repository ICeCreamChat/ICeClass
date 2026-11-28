"""Student history through the installed HTTP handlers and an isolated school database."""
import base64
import json

from test_card_quiz import CardQuizHttpCase, PNG, STAMP, question


class StudentHistoryTests(CardQuizHttpCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.initialize()
        self.lesson = self.session()['session']

    async def credentials(self, *, numbered=False):
        path = f'/classes/{self.cid}/students'
        state = await self.api('GET', path)
        versions = {k: state[k] for k in ('revision', 'rosterRevision', 'cardRevision')}
        if numbered:
            result = await self.api('POST', path + '/number-cards', {**versions, 'firstNumber': 1, 'lastNumber': 2})
        else:
            result = await self.api('POST', path, {**versions, 'entryYear': 2026, 'classCode': '101'})
        return result['credentials']

    async def signin(self, card):
        async with self.client.post('/api/student/login', json={k: card[k] for k in ('username', 'password')}) as response:
            self.assertEqual(response.status, 200)
            return {'Cookie': response.headers['Set-Cookie'].split(';', 1)[0],
                    'X-CSRF-Token': (await response.json())['student']['csrfToken']}

    async def request(self, method, path, auth, status=200, body=None):
        async with self.client.request(method, '/api/student' + path, headers=auth, json=body) as response:
            if response.status != status:
                reason = (await response.read())[:256].decode('utf-8', errors='replace')
                self.fail(f'{method} {path}: expected {status}, got {response.status}: {reason}')
            if response.content_type == 'application/json':
                return await response.json()
            self.assertEqual(response.content_type, 'image/png')
            return await response.read()

    async def image_id(self):
        image = await self.api('POST', '/images', {'dataUrl': 'data:image/png;base64,' + base64.b64encode(PNG).decode()})
        return image['id']

    def insert_lesson(self, sid, source, *, cid=None):
        value = {**source, 'id': sid, 'classId': cid or self.cid}
        encoded = json.dumps(value)
        self.db.run('''INSERT INTO card_quiz_sessions
            (id,class_id,device_id,subject_id,started_at,ended_at,seq,revision,raw_value,value,updated_at)
            VALUES(?,?,?,?,?,?,?,1,?,?,?)''', (sid, value['classId'], value['deviceId'], value['subjectId'],
                                              value['startedAt'], value['endedAt'], value['seq'], encoded, encoded, STAMP))

    async def test_1001_named_lessons_across_linked_classes_keep_only_own_outcomes(self):
        one, two, *_ = await self.credentials()
        own, peer = await self.signin(one), await self.signin(two)
        former = await self.other_class()
        # This account used s2 in its former class and uses s1 in its current class.
        self.db.run('INSERT INTO student_account_links(class_id,student_id,account_id) VALUES(?,?,?)',
                    (former, 's2', one['accountId']))
        ids = [f'math-{i:04}' for i in range(1001)]
        with self.db.transaction():
            for sid in ids[1:]:
                self.insert_lesson(sid, self.lesson)
        at_limit = await self.request('GET', '/report?subjectId=math', own)
        self.assertEqual((len(at_limit['sessions']), at_limit['totals']['correct']), (1000, 1000))
        old_image = await self.image_id()
        old_question = {**self.lesson['questions'][0], 'imageId': old_image}
        self.insert_lesson(ids[0], {**self.lesson, 'questions': [old_question]}, cid=former)
        self.insert_lesson('unclosed', {**self.lesson, 'endedAt': None})
        self.insert_lesson('not-on-roster', {**self.lesson, 'roster': self.lesson['roster'][:1]}, cid=former)

        result = await self.request('GET', '/report?subjectId=math&studentId=s2', own)
        self.assertEqual(set(result), {'accountId', 'sessions', 'records', 'knowledge', 'totals'})
        self.assertEqual(result['accountId'], one['accountId'])
        self.assertEqual([s['id'] for s in result['sessions']], ids)
        self.assertEqual([r['sessionId'] for r in result['records']], ids)
        self.assertEqual((result['records'][0]['classId'], result['records'][0]['option']), (former, 'B'))
        self.assertEqual((result['totals']['correct'], result['totals']['wrong']), (1000, 1))
        self.assertEqual(result['knowledge'][0]['samples'], 1001)
        self.assertEqual(await self.request('GET', '/images/' + old_image, own), PNG)
        await self.request('GET', '/images/' + old_image, peer, 403)
        self.assertEqual((await self.request('GET', '/report?subjectId=english', own))['sessions'], [])
        peer_report = await self.request('GET', '/report', peer)
        self.assertEqual([s['id'] for s in peer_report['sessions']], ids[1:])
        self.assertEqual(peer_report['totals']['wrong'], 1000)
        await self.request('POST', '/report/math-0000/analysis', own, 409, {'revision': 0})
        self.insert_lesson('old-ungraded', {**self.lesson, 'questions': [{**old_question, 'answer': None}]}, cid=former)
        analysis = await self.request('POST', '/report/old-ungraded/analysis', own, body={'revision': 1})
        self.assertEqual((analysis['sessionId'], analysis['accountId'], analysis['status']),
                         ('old-ungraded', one['accountId'], 'insufficient'))
        for sid in ('math-0000', 'old-ungraded', 'not-on-roster', 'unclosed'):
            await self.request('POST', f'/report/{sid}/analysis', peer, 404, {})

    async def test_named_image_after_1000_respects_class_roster_and_closed_lesson(self):
        own = await self.signin((await self.credentials())[0])
        oldest, newest, private = await self.image_id(), await self.image_id(), await self.image_id()

        def with_image(iid):
            return {**self.lesson, 'questions': [{**self.lesson['questions'][0], 'imageId': iid}]}

        with self.db.transaction():
            self.insert_lesson('a-oldest', with_image(oldest))
            for i in range(999):
                self.insert_lesson(f'lesson-{i:04}', self.lesson)
            self.insert_lesson('z-newest', with_image(newest))
        other = await self.other_class()
        self.insert_lesson('foreign', with_image(private), cid=other)
        self.insert_lesson('classmate', {**with_image(private), 'roster': self.lesson['roster'][1:]})
        self.insert_lesson('open', {**with_image(private), 'endedAt': None})
        for iid in (oldest, newest):
            self.assertEqual(await self.request('GET', '/images/' + iid, own), PNG)
        await self.request('GET', '/images/' + private, own, 403)
        await self.request('GET', '/images/' + oldest, self.dh, 401)

    async def test_number_card_images_reports_and_analysis_follow_latest_participation(self):
        one, two = [await self.signin(c) for c in await self.credentials(numbered=True)]
        older, first, second = await self.image_id(), await self.image_id(), await self.image_id()

        def add(iid):
            return {'action': 'add_question', 'payload': question(imageId=iid, answer=None)}

        def answer(number):
            return {'action': 'answer', 'payload': {'cardNumber': number, 'option': 'A'}}

        old = self.journal([add(older), {'action': 'start_round'}, answer(2), {'action': 'end_session'}],
                           card_mode='scanned')['session']
        current = self.journal([add(first), {'action': 'start_round'}, answer(1), {'action': 'end_round'},
                                add(second), {'action': 'start_round'}, answer(2), {'action': 'end_session'}],
                               started=STAMP + 20000, card_mode='scanned')['session']
        with self.db.transaction():
            for i in range(1000):
                self.insert_lesson(f'old-{i:04}', old)
        self.insert_lesson('current', current)
        result = await self.request('GET', '/report', two)
        self.assertEqual([s['id'] for s in result['sessions']], ['current'])
        self.assertEqual([r['imageId'] for r in result['records']], [second])
        self.assertEqual(await self.request('GET', '/images/' + second, two), PNG)
        self.assertEqual(await self.request('GET', '/images/' + first, one), PNG)
        for iid in (older, first):
            await self.request('GET', '/images/' + iid, two, 403)
        self.assertEqual((await self.request('POST', '/report/current/analysis', two, body={}))['status'], 'insufficient')
        await self.request('POST', '/report/old-0999/analysis', two, 404, {})
        latest = self.journal([add(first), {'action': 'start_round'}, answer(1), {'action': 'end_session'}],
                              started=STAMP + 40000, card_mode='scanned')['session']
        self.insert_lesson('latest', latest)
        self.assertEqual((await self.request('GET', '/report?subjectId=math', two))['sessions'], [])
        await self.request('GET', '/images/' + second, two, 403)
        await self.request('POST', '/report/current/analysis', two, 404, {})

    async def test_personal_answer_limit_accepts_100000_and_rejects_100001(self):
        own = await self.signin((await self.credentials())[0])
        # 100 closed rounds per lesson, one observation per round for this student.
        operations = [{'action': 'add_question', 'payload': question()}]
        for _ in range(100):
            operations.extend([{'action': 'start_round'}, {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'A'}},
                               {'action': 'end_round'}])
        hundred = self.journal(operations + [{'action': 'end_session'}])['session']
        with self.db.transaction():
            for i in range(1000):
                self.insert_lesson(f'full-{i:04}', hundred)
        report = await self.request('GET', '/report', own)
        self.assertEqual(len(report['records']), 100000)
        del report
        self.insert_lesson('extra', self.lesson)
        error = await self.request('GET', '/report', own, 400)
        self.assertIn('100000', error['error'])

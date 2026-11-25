"""Single-lesson knowledge evidence through the device, teacher and student HTTP handlers."""
import json

from test_card_quiz import CardQuizHttpCase, STAMP, question
from test_card_quiz_multiple import MultipleFixture


def op(action, **payload):
    return {'action': action, 'payload': payload}


def by_tag(report):
    return {row['tag']: row for row in report['knowledge']}


def evidence(row):
    return row['correct'], row['samples'], row['wrong'], row['wrongQuestionNumbers']


class SessionKnowledgeTests(CardQuizHttpCase):
    async def student_logins(self):
        path = f'/classes/{self.cid}/students'
        state = await self.api('GET', path)
        versions = {k: state[k] for k in ('revision', 'rosterRevision', 'cardRevision')}
        issued = await self.api('POST', path, {**versions, 'entryYear': 2026, 'classCode': '101'})
        logins = {}
        for credential in issued['credentials']:
            response = await self.client.post('/api/student/login', json={
                'username': credential['username'], 'password': credential['password']})
            self.assertEqual(response.status, 200)
            await response.read()
            logins[credential['studentId']] = {'Cookie': response.headers['Set-Cookie'].split(';', 1)[0]}
        return logins

    async def personal(self, headers):
        response = await self.client.get('/api/student/report?studentId=s2&classId=other', headers=headers)
        self.assertEqual(response.status, 200)
        return await response.json()

    async def test_four_students_latest_formal_combinations_and_question_numbers(self):
        await self.initialize()
        journal = self.journal([
            op('add_question', **question(type='multiple', options=list('ABCD'), answer='AC', tags=['集合', '交集'])),
            op('start_round'), op('answer', cardNumber=3, targetOption='A', option='A'), op('end_round'),
            op('start_round'), op('set_exempt', studentId='s4', exempt=True),
            op('answer', cardNumber=1, targetOption='A', option='A'),
            op('answer', cardNumber=2, targetOption='A', option='A'),
            op('set_multi_option', option='C'), op('answer', cardNumber=1, targetOption='C', option='A'),
            op('end_round'), op('start_round', practice=True),
            op('answer', cardNumber=3, targetOption='A', option='A'), op('end_round'),
            op('add_question', **question(answer='B', tags=['集合'])), op('start_round'),
            op('answer', cardNumber=1, option='A'), op('answer', cardNumber=2, option='B'),
            op('answer', cardNumber=3, option='A'), op('end_round'),
            op('add_question', **question(answer=None, tags=['函数', '集合'])), op('start_round'),
            op('answer', cardNumber=1, option='A'), op('answer', cardNumber=2, option='B'), op('end_round'),
            op('add_question', **question(tags=[])), op('start_round'), op('answer', cardNumber=2, option='B'),
            op('end_round'), op('add_question', **question(tags=['仅练习'])), op('start_round', practice=True),
            op('answer', cardNumber=1, option='B'), op('end_round'),
            op('add_question', **question(tags=['未开轮'])), op('end_session')])
        await self.sync(self.batch(journal))

        _, teacher = await self.account('topic-teacher', teaching=[self.cid])
        report = (await self.api('GET', '/sessions/session-1', headers=teacher))['report']
        topics = by_tag(report)
        self.assertEqual(set(topics), {'集合', '交集', '函数'})
        combined = topics['集合']
        self.assertEqual(combined['questionCount'], 3)
        self.assertEqual(evidence(combined), (2, 5, 3, [1, 2]))
        self.assertEqual((combined['abstained'], combined['exempt'], combined['ungraded']), (4, 1, 2))
        self.assertEqual(report['totals']['samples'], 6)  # Includes the untagged fourth question once.
        self.assertEqual({s['studentId']: evidence(s) for s in combined['students']}, {
            's1': (1, 2, 1, [2]), 's2': (1, 2, 1, [1]), 's3': (0, 1, 1, [2]), 's4': (0, 0, 0, [])})
        single = topics['交集']
        self.assertEqual((single['questionCount'], evidence(single)), (1, (1, 2, 1, [1])))
        self.assertEqual(single['students'][0]['studentId'], 's2')
        self.assertEqual((single['abstained'], single['exempt']), (1, 1))
        self.assertEqual(report['questions'][0]['rounds'][1]['combinationDistribution'], {'AC': 1, 'A': 1})
        self.assertEqual((topics['函数']['questionCount'], topics['函数']['ungraded'], topics['函数']['accuracy']),
                         (1, 2, None))

        _, outside_teacher = await self.account('other-teacher', teaching=[await self.other_class()])
        await self.api('GET', '/sessions/session-1?classId=' + self.cid, status=403, headers=outside_teacher)

        logins = await self.student_logins()
        for student in single['students']:
            with self.subTest(student=student['studentId']):
                personal = await self.personal(logins[student['studentId']])
                lesson, = personal['sessions']
                own = by_tag(lesson)['交集']
                self.assertEqual(evidence(own), evidence(student))
                self.assertEqual((own['abstained'], own['exempt']), (student['abstained'], student['exempt']))
                self.assertNotIn('students', own)

    async def test_lesson_scope_and_private_projections_recalculate_after_review(self):
        await self.initialize()
        bank = await self.new_question(tags=['数轴'])
        deck = await self.api('POST', '/decks', {'title': '测试题单', 'questionIds': [bank['id']]})
        await self.api('POST', f'/decks/{deck["id"]}/publish', {'revision': deck['revision'], 'classId': self.cid})
        add = op('add_question', **bank, bankId=bank['id'], bankVersion=bank['revision'])
        first = self.journal([add, op('start_round'), op('answer', cardNumber=1, option='A'),
                              op('answer', cardNumber=2, option='B'), op('end_round'),
                              add, op('start_round'), op('answer', cardNumber=1, option='B'),
                              op('answer', cardNumber=2, option='A'), op('end_session')], sid='lesson-a')
        second = self.journal([add, op('start_round'), op('answer', cardNumber=1, option='B'), op('end_session')],
                              sid='lesson-b', started=STAMP + 86_400_000)
        await self.sync(self.batch(second))
        await self.sync(self.batch(first))
        await self.sync(self.session(sid='still-open', ended=False))
        logins = await self.student_logins()
        await self.api('GET', '/sessions/lesson-a', status=401, headers=logins['s1'])
        own, other = await self.personal(logins['s1']), await self.personal(logins['s2'])
        self.assertEqual([s['id'] for s in own['sessions']], ['lesson-a', 'lesson-b'])
        self.assertEqual([s['id'] for s in other['sessions']], ['lesson-a', 'lesson-b'])
        first_own, second_own = [by_tag(s)['数轴'] for s in own['sessions']]
        self.assertEqual((first_own['questionCount'], evidence(first_own)), (2, (1, 2, 1, [2])))
        self.assertEqual((second_own['questionCount'], evidence(second_own)), (1, (0, 1, 1, [1])))
        self.assertEqual([evidence(by_tag(s)['数轴']) for s in other['sessions']], [(1, 2, 1, [1]), (0, 0, 0, [])])
        self.assertEqual(by_tag(other['sessions'][1])['数轴']['abstained'], 1)
        self.assertEqual([(r['questionNumber'], r['counted']) for r in own['records']], [(1, False), (2, False), (1, True)])
        for token in ('"students"', '"studentName"', '"studentId"', '测试学生2', '"s2"', 'still-open'):
            self.assertNotIn(token, json.dumps(own, ensure_ascii=False))
        self.assertEqual((own['totals']['samples'], own['totals']['wrong']), (1, 1))
        cross = by_tag(await self.api('GET', '/report?classId=' + self.cid))['数轴']
        self.assertEqual((cross['questionCount'], cross['correct'], cross['samples']), (1, 1, 2))

        detail = await self.api('GET', '/sessions/lesson-a')
        self.assertEqual(evidence(by_tag(detail['report'])['数轴']), (2, 4, 2, [1, 2]))
        reviewed = await self.api('PUT', '/sessions/lesson-a', {'revision': detail['revision'], 'questions': [
            {'id': first['session']['questions'][1]['id'], 'answer': 'B', 'tags': ['方向']}]})
        topics = by_tag(reviewed['report'])
        self.assertEqual(evidence(topics['方向']), (1, 2, 1, [2]))
        self.assertEqual(topics['方向']['students'][0]['studentId'], 's2')
        self.assertEqual(topics['数轴']['questionCount'], 1)
        updated = await self.personal(logins['s1'])
        self.assertEqual(evidence(by_tag(updated['sessions'][0])['方向']), (1, 1, 0, []))
        self.assertEqual(evidence(by_tag((await self.personal(logins['s2']))['sessions'][0])['方向']), (0, 1, 1, [2]))
        self.assertEqual(updated['sessions'][1], own['sessions'][1])
        self.assertEqual((updated['totals']['samples'], updated['totals']['wrong']), (1, 1))

    async def test_legacy_incomplete_and_open_rounds_supply_no_graded_sample(self):
        await self.initialize()
        legacy = MultipleFixture(self.cid, self.device['deviceId']).results().end()
        await self.sync(legacy.body())
        topic, = (await self.api('GET', '/sessions/multi-session'))['report']['knowledge']
        self.assertEqual((topic['incomplete'], topic['unanswered'], topic['abstained']), (1, 1, 0))
        self.assertEqual((topic['correct'], topic['samples'], topic['wrong']), (1, 2, 1))
        self.assertEqual(next(s for s in topic['students'] if s['studentId'] == 's2')['wrongQuestionNumbers'], [1])
        journal = self.journal([op('add_question', **question()), op('start_round'), op('answer', cardNumber=1, option='B'),
                                op('end_round'), op('start_round'), op('answer', cardNumber=1, option='A')])
        await self.sync(self.batch(journal))
        active, = (await self.api('GET', '/sessions/session-1'))['report']['knowledge']
        self.assertEqual(evidence(active), (0, 1, 1, [1]))

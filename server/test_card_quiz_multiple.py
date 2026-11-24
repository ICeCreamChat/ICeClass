"""Multiple choice contracts through real replay, HTTP, SQLite, pairing and reports."""
import copy
import csv
import io
import json
import unittest
from unittest.mock import patch

import app as service
from card_quiz_events import public_state, replay
from card_quiz_models import QuizError, dumps, validate_question, validate_session
from card_quiz_sessions import session_report
from test_card_quiz import CardQuizHttpCase, STAMP, question


def multiple_question(**changes):
    return question(type='multiple', options=['甲', '乙', '丙'], answer='AC', **changes)


class MultipleFixture:
    """Construct wire fixtures independently of the server and the JS worker."""
    def __init__(self, cid='class', device='device'):
        self.session = {'schema': 1, 'id': 'multi-session', 'classId': cid, 'deviceId': device,
                        'subjectId': 'math', 'startedAt': STAMP, 'endedAt': None,
                        'cardVersion': 'ice-v1', 'roster': [
                            {'id': 's' + str(i), 'name': '学生' + str(i), 'cardNumber': i}
                            for i in range(1, 5)],
                        'seq': 0, 'generation': 1, 'source': 'board', 'sourceId': 'board',
                        'questions': [], 'currentQuestionId': None, 'currentRoundId': None}
        self.events = []
        self.event('add_question', multiple_question())
        self.q = {**multiple_question(), 'id': 'multi-q', 'revision': 1, 'bankId': None,
                  'bankVersion': None, 'revealed': False, 'rounds': []}
        self.session['questions'].append(self.q)
        self.session.update(currentQuestionId='multi-q', generation=2)

    def event(self, action, payload=None, cid=None):
        s = self.session
        seq = s['seq'] + 1
        event = {'id': cid or 'multi-e' + str(seq), 'seq': seq, 'at': STAMP + seq * 1000,
                 'action': action, 'payload': payload or {}, 'questionId': s['currentQuestionId'],
                 'roundId': s['currentRoundId'], 'sourceId': s['sourceId'], 'generation': s['generation']}
        self.events.append(event)
        s['seq'] = seq
        return event

    def start(self, practice=False):
        e = self.event('start_round', {'practice': practice})
        self.session['generation'] += 1
        self.r = {'id': 'multi-r', 'startedAt': e['at'], 'endedAt': None,
                  'purpose': 'practice' if practice else 'formal', 'status': 'collecting',
                  'source': self.session['source'], 'sourceId': self.session['sourceId'],
                  'generation': self.session['generation'], 'activeOption': 'A', 'answers': {}, 'exempt': []}
        self.q['rounds'].append(self.r)
        self.session['currentRoundId'] = 'multi-r'
        return self

    def target(self, option, cid=None):
        self.event('set_multi_option', {'option': option}, cid)
        self.session['generation'] += 1
        self.r.update(activeOption=option, generation=self.session['generation'])
        return self

    def answer(self, card, option, cid=None):
        target = self.r['activeOption']
        e = self.event('answer', {'cardNumber': card, 'option': option, 'targetOption': target}, cid)
        sid = 's' + str(card)
        choices = {**self.r['answers'].get(sid, {}).get('choices', {}), target: option == 'A'}
        self.r['answers'][sid] = {'choices': choices, 'option': ''.join(k for k in 'ABCD' if choices.get(k)),
                                   'confirmedAt': e['at'], 'seq': e['seq']}
        return self

    def exempt(self, sid):
        self.event('set_exempt', {'studentId': sid, 'exempt': True})
        self.r['exempt'].append(sid)
        return self

    def end(self):
        e = self.event('end_session')
        self.r.update(status='closed', endedAt=e['at'])
        self.session.update(endedAt=e['at'], generation=self.session['generation'] + 1)
        return self

    def results(self):
        return (self.start().answer(1, 'A').answer(2, 'B').answer(3, 'A')
                .target('B').answer(1, 'B').answer(2, 'B')
                .target('C').answer(1, 'A').answer(2, 'B'))

    def body(self, start=1, receipts=()):
        return copy.deepcopy({'session': self.session, 'events': [e for e in self.events if e['seq'] >= start],
                              'fromSeq': start, 'receipts': list(receipts)})


class MultipleModelTests(unittest.TestCase):
    def test_empty_closed_round_freezes_multiple_shape_but_keeps_legacy_edits(self):
        for kind in ('single', 'boolean', 'multiple'):
            f = MultipleFixture()
            value = question(type=kind, options=['正确', '错误'] if kind == 'boolean' else ['甲', '乙', '丙'], answer='A')
            f.events[0]['payload'] = copy.deepcopy(value)
            f.q.update(value)
            f.start()
            if kind != 'multiple':
                f.r.pop('activeOption')
            e = f.event('end_round')
            f.r.update(status='closed', endedAt=e['at'])
            f.session['generation'] += 1
            replay(f.session, f.events)
            patches = [{'type': target, 'answer': 'A'} for target in ('single', 'boolean', 'multiple') if target != kind]
            if kind != 'boolean':
                patches.append({'options': ['甲', '乙'], 'answer': 'A'})
            for payload in patches:
                changed = copy.deepcopy(f)
                changed.event('edit_question', {'revision': 1, **payload})
                changed.q.update(payload, revision=2)
                if changed.q['type'] == 'boolean':
                    changed.q['options'] = ['正确', '错误']
                with self.subTest(kind=kind, patch=payload):
                    if kind == 'multiple' or payload.get('type') == 'multiple':
                        with self.assertRaisesRegex(QuizError, '轮次|新建'):
                            replay(changed.session, changed.events)
                    else:
                        replay(changed.session, changed.events)

    def test_answer_canonicalization_and_invalid_sets(self):
        for raw, expected in [('CA', 'AC'), ('C', 'C'), ('CBA', 'ABC'), (None, None)]:
            with self.subTest(raw=raw):
                value = multiple_question()
                value['answer'] = raw
                try:
                    actual = validate_question(value)['answer']
                except QuizError as exc:
                    self.fail('Valid multiple answer rejected: ' + str(exc))
                self.assertEqual(actual, expected)
        for raw in ('', 'AA', 'ACA', 'D', 'ac', ['A'], True):
            with self.subTest(invalid=raw), self.assertRaises(QuizError):
                validate_question({**multiple_question(), 'answer': raw})

    def test_snapshot_keeps_partial_false_choices_and_rejects_tampering(self):
        f = MultipleFixture().start().answer(1, 'B')
        try:
            actual = validate_session(f.session)
        except QuizError as exc:
            self.fail('Valid partial multiple snapshot rejected: ' + str(exc))
        self.assertEqual(actual, f.session)
        variants = [
            lambda r: r.pop('activeOption'), lambda r: r.update(activeOption='D'),
            lambda r: r['answers']['s1'].pop('choices'),
            lambda r: r['answers']['s1'].update(choices={}),
            lambda r: r['answers']['s1'].update(choices={'A': 0}),
            lambda r: r['answers']['s1'].update(choices={'D': False}),
            lambda r: r['answers']['s1'].update(option='A'),
            lambda r: r['answers']['s1'].update(choices={'A': False, 'B': True, 'C': True}, option='CB')]
        for mutate in variants:
            bad = copy.deepcopy(f.session)
            mutate(bad['questions'][0]['rounds'][0])
            with self.subTest(snapshot=bad), self.assertRaises(QuizError):
                validate_session(bad)

    def test_public_completion_current_option_and_exemption_are_independent(self):
        f = MultipleFixture()
        before = public_state(f.session, '班级')
        self.assertEqual((before.get('activeOption'), before.get('optionReceived')), (None, 0))
        f.results()
        state = public_state(f.session, '班级')
        self.assertEqual((state['received'], state['expected'], state.get('activeOption'), state.get('optionReceived')),
                         (2, 4, 'C', 2))
        f.target('A').exempt('s1')
        state = public_state(f.session, '班级')
        self.assertEqual((state['received'], state['expected'], state['optionReceived']), (1, 3, 2))
        self.assertFalse({'roster', 'answers', 'choices', 'answer'} & set(state))

    def test_replay_same_item_generation_correction_recovery_and_sealing(self):
        f = MultipleFixture().results()
        f.target('C').answer(1, 'B').target('C').answer(1, 'A')
        previous = f.session['generation']
        f.event('recover')
        f.session['generation'] += 1
        f.r.update(status='paused', generation=f.session['generation'])
        paused = copy.deepcopy(f.session)
        try:
            replay(paused, f.events)
        except QuizError as exc:
            self.fail('Valid multiple replay rejected: ' + str(exc))
        old = copy.deepcopy(f.session)
        seq = old['seq']
        f.event('resume_round')
        f.session['generation'] += 1
        f.r.update(status='collecting', generation=f.session['generation'])
        f.end()
        replay(f.session, f.events[seq:], old=old)
        self.assertEqual(f.r['answers']['s1']['choices'], {'A': True, 'B': False, 'C': True})
        self.assertEqual(paused['generation'], previous + 1)

    def test_replay_rejects_stale_target_generation_metadata_and_forged_choices(self):
        f = MultipleFixture().results()
        try:
            replay(f.session, f.events)
        except QuizError as exc:
            self.fail('Valid multiple replay rejected: ' + str(exc))
        for key, value in [('targetOption', None), ('targetOption', 'B'), ('option', 'C')]:
            bad = copy.deepcopy(f.events)
            bad[2]['payload'][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(QuizError):
                replay(f.session, bad)
        for key, value in [('generation', 2), ('questionId', 'other'), ('roundId', 'other')]:
            bad = copy.deepcopy(f.events)
            bad[5][key] = value  # set_multi_option requires the current round metadata too.
            with self.subTest(key=key), self.assertRaises(QuizError):
                replay(f.session, bad)
        forged = copy.deepcopy(f.session)
        forged['questions'][0]['rounds'][0]['answers']['s3'].update(
            choices={'A': True, 'B': False, 'C': True}, option='AC')
        with self.assertRaises(QuizError):
            replay(forged, f.events)

    def test_reports_split_partial_empty_and_complete_and_grade_exact_sets(self):
        f = MultipleFixture().results().end()
        try:
            report = session_report(f.session)
        except (KeyError, QuizError) as exc:
            self.fail('Multiple report cannot represent whole and partial answers: ' + str(exc))
        totals = report['totals']
        self.assertEqual({k: totals.get(k) for k in ('correct', 'wrong', 'incomplete', 'unanswered', 'samples', 'accuracy')},
                         {'correct': 1, 'wrong': 1, 'incomplete': 1, 'unanswered': 1, 'samples': 2, 'accuracy': .5})
        r = report['questions'][0]['rounds'][0]
        self.assertEqual(r['distribution'], {'A': 1, 'B': 0, 'C': 1})
        self.assertEqual(r['combinationDistribution'], {'AC': 1, '': 1})
        self.assertEqual([s['status'] for s in r['students']], ['correct', 'wrong', 'incomplete', 'unanswered'])
        self.assertEqual(r['students'][1]['option'], '')
        self.assertEqual(r['students'][2].get('choices'), {'A': True})
        for answer, correct in [('A', 0), ('ABC', 0), ('AC', 1), (None, 0)]:
            f.q['answer'] = answer
            totals = session_report(f.session)['totals']
            self.assertEqual(totals['correct'], correct)
            self.assertEqual(totals['incomplete'], 1)
            self.assertEqual(totals['ungraded'], 2 if answer is None else 0)

    def test_practice_round_keeps_multiple_completion_split_without_formal_grades(self):
        f = MultipleFixture().results().exempt('s2').end()
        f.r['purpose'] = 'practice'
        summary = session_report(f.session)
        r = summary['questions'][0]['rounds'][0]
        self.assertEqual([s['status'] for s in r['students']], ['practice', 'exempt', 'incomplete', 'unanswered'])
        self.assertEqual((r['incomplete'], r['unanswered'], r['exempt'], r['samples']), (1, 1, 1, 0))
        self.assertEqual(r['combinationDistribution'], {'AC': 1})
        self.assertEqual((summary['totals']['practice'], summary['totals']['samples']), (4, 0))

    def test_four_options_complete_distribution_and_false_partial_export_shape(self):
        f = MultipleFixture()
        f.q.update(options=['甲', '乙', '丙', '丁'], answer='BD')
        f.events[0]['payload'].update(options=['甲', '乙', '丙', '丁'], answer='DB')
        f.start().answer(1, 'B').answer(2, 'A').answer(3, 'B')
        f.target('B').answer(1, 'A').answer(2, 'A')
        f.target('C').answer(1, 'B').answer(2, 'B')
        f.target('D').answer(1, 'A').answer(2, 'A').end()
        replay(validate_session(f.session), f.events)
        report = session_report(f.session)
        self.assertEqual(report['questions'][0]['rounds'][0]['distribution'], {'A': 1, 'B': 2, 'C': 0, 'D': 2})
        self.assertEqual(report['questions'][0]['rounds'][0]['combinationDistribution'], {'BD': 1, 'ABD': 1})
        self.assertEqual([s['status'] for s in report['questions'][0]['rounds'][0]['students']],
                         ['correct', 'wrong', 'incomplete', 'unanswered'])

    def test_partial_answers_lock_type_and_option_range_and_paused_or_closed_retarget(self):
        f = MultipleFixture().start().answer(1, 'A')
        e = f.event('end_round')
        f.r.update(status='closed', endedAt=e['at'])
        f.session['generation'] += 1
        sealed = copy.deepcopy(f.session)
        replay(sealed, f.events)
        for payload in ({'type': 'single', 'answer': 'A'}, {'options': ['甲', '乙'], 'answer': 'A'}):
            changed = copy.deepcopy(f)
            changed.event('edit_question', {'revision': 1, **payload})
            changed.q.update(payload, revision=2)
            with self.subTest(edit=payload), self.assertRaises(QuizError):
                replay(changed.session, changed.events)
        for status in ('paused', 'closed'):
            changed = copy.deepcopy(f)
            changed.r['status'] = status
            previous = copy.deepcopy(changed.session)
            changed.target('B')
            with self.subTest(status=status), self.assertRaises(QuizError):
                replay(changed.session, changed.events[-1:], old=previous)


class MultipleHttpTests(CardQuizHttpCase):
    async def fixture(self, *, complete=False, ended=False):
        await self.initialize()
        f = MultipleFixture(self.cid, self.device['deviceId'])
        if complete:
            f.results()
        else:
            f.start().answer(1, 'A')
        if ended:
            f.end()
        await self.sync(f.body())
        return f

    async def phone_fixture(self):
        await self.initialize()
        f = MultipleFixture(self.cid, self.device['deviceId'])
        await self.sync(f.body())
        pair = await self.api('POST', '/device/pair', {'sessionId': f.session['id']}, headers=self.dh)
        await self.api('POST', '/pair', {'code': pair['code']})
        start = f.session['seq'] + 1
        f.event('set_source', {'source': 'phone', 'sourceId': pair['pairId']})
        f.session.update(source='phone', sourceId=pair['pairId'], generation=f.session['generation'] + 1)
        f.start()
        await self.sync(f.body(start))
        state = public_state(f.session, '高一（1）班')
        await self.api('POST', '/device/relay', {'sessionId': f.session['id'], 'state': state, 'receipts': []}, headers=self.dh)
        return pair, f, state

    def phone_command(self, f, action='set_multi_option', payload=None, cid='multi-command'):
        s = f.session
        return {'id': cid, 'sessionId': s['id'], 'questionId': s['currentQuestionId'],
                'roundId': s['currentRoundId'], 'sourceId': s['sourceId'], 'generation': s['generation'],
                'action': action, 'payload': payload if payload is not None else {'option': 'B'}}

    async def test_question_publish_and_review_canonical_answer_with_raw_history_preserved(self):
        bank = await self.new_question(type='multiple', options=['甲', '乙', '丙'], answer='CA')
        self.assertEqual(bank['answer'], 'AC')
        deck = await self.api('POST', '/decks', {'title': '多选', 'questionIds': [bank['id']]})
        published = await self.api('POST', '/decks/' + deck['id'] + '/publish', {'revision': 1, 'classId': self.cid})
        self.assertEqual(published['questions'][0]['answer'], 'AC')
        f = await self.fixture(complete=True, ended=True)
        result = await self.api('PUT', '/sessions/' + f.session['id'], {'revision': 1,
            'questions': [{'id': 'multi-q', 'answer': 'BA'}]})
        self.assertEqual(result['session']['questions'][0]['answer'], 'AB')
        self.assertEqual((result['report']['totals']['wrong'], result['report']['totals']['incomplete']), (2, 1))
        row = self.db.one('SELECT raw_value,value FROM card_quiz_sessions WHERE id=?', (f.session['id'],))
        self.assertEqual(json.loads(row['raw_value'])['questions'][0]['answer'], 'AC')
        self.assertEqual(json.loads(row['value'])['questions'][0]['answer'], 'AB')

    async def test_report_csv_partial_all_no_selection_unanswered_exempt_and_old_compatibility(self):
        f = await self.fixture(complete=True, ended=True)
        payload = await self.api('GET', '/sessions/' + f.session['id'])
        self.assertEqual(payload['report']['totals']['incomplete'], 1)
        report = await self.api('GET', '/report?classId=' + self.cid)
        self.assertEqual([(s['samples'], s.get('incomplete'), s['unanswered']) for s in report['students']],
                         [(1, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)])
        self.assertEqual((report['knowledge'][0]['answers'], report['knowledge'][0]['samples']), (2, 2))
        raw = await self.api('GET', '/export?classId=' + self.cid)
        rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
        answers = {r['学生编号']: r['作答'] for r in rows}
        self.assertEqual(answers, {'s1': 'AC', 's2': '全不选', 's3': 'A:选 / B:未答 / C:未答', 's4': ''})
        self.assertEqual([r['状态'] for r in rows], ['correct', 'wrong', 'incomplete', 'unanswered'])
        # Existing single/boolean public shapes and reports must remain readable.
        await self.sync(self.session(sid='old-single'))
        legacy = await self.api('GET', '/sessions/old-single')
        self.assertNotIn('incomplete', legacy['report']['questions'][0]['rounds'][0])
        self.assertNotIn('choices', legacy['report']['questions'][0]['rounds'][0]['students'][0])
        state = public_state(legacy['session'], '班级')
        self.assertNotIn('activeOption', state)
        self.assertNotIn('optionReceived', state)

    async def test_partial_exemption_and_correction_persist_across_recovery(self):
        f = await self.fixture(complete=True)
        start = f.session['seq'] + 1
        f.exempt('s3').target('C').answer(1, 'B')
        await self.sync(f.body(start))
        old = copy.deepcopy(f.session)
        start = f.session['seq'] + 1
        f.event('recover')
        f.session['generation'] += 1
        f.r.update(status='paused', generation=f.session['generation'])
        await self.sync(f.body(start))
        stored = (await self.api('GET', '/sessions/' + f.session['id']))['session']
        self.assertEqual(stored['questions'][0]['rounds'][0]['answers'], old['questions'][0]['rounds'][0]['answers'])
        start = f.session['seq'] + 1
        f.event('resume_round')
        f.session['generation'] += 1
        f.r.update(status='collecting', generation=f.session['generation'])
        f.answer(1, 'A').end()
        await self.sync(f.body(start))
        totals = (await self.api('GET', '/sessions/' + f.session['id']))['report']['totals']
        self.assertEqual((totals['correct'], totals['wrong'], totals['exempt'], totals['incomplete'], totals['unanswered']),
                         (1, 1, 1, 0, 1))

    async def test_sync_rejects_forged_choices_and_active_option_without_mutation(self):
        f = await self.fixture()
        original = self.db.one('SELECT * FROM card_quiz_sessions WHERE id=?', (f.session['id'],))
        for mutate in (
                lambda b: b['session']['questions'][0]['rounds'][0].update(activeOption='B'),
                lambda b: b['session']['questions'][0]['rounds'][0]['answers']['s1'].update(
                    choices={'A': True, 'B': False, 'C': True}, option='AC')):
            bad = f.body()
            bad['session']['id'] = 'tampered-session'
            for e in bad['events']:
                e['id'] += '-tampered'
            mutate(bad)
            await self.sync(bad, 400)
            self.assertIsNone(self.db.one('SELECT id FROM card_quiz_sessions WHERE id=?', ('tampered-session',)))
        self.assertEqual(self.db.one('SELECT * FROM card_quiz_sessions WHERE id=?', (f.session['id'],)), original)

    async def test_paired_phone_auth_stale_targets_generation_queue_and_receipt_replay(self):
        pair, f, state = await self.phone_fixture()
        path = '/pairs/' + pair['pairId'] + '/commands'
        command = self.phone_command(f)
        await self.api('POST', path, command, 401, self.dh)
        await self.api('POST', path, command, 403, {'Cookie': self.admin['Cookie']})
        _, other = await self.account('multi-other', teaching=[self.cid])
        await self.api('POST', path, command, 403, other)
        for bad in ({**command, 'generation': 1}, {**command, 'roundId': 'wrong'},
                    self.phone_command(f, 'answer', {'cardNumber': 1, 'option': 'A'}),
                    self.phone_command(f, 'answer', {'cardNumber': 1, 'option': 'A', 'targetOption': 'B'}),
                    self.phone_command(f, 'answer', {'cardNumber': 1, 'option': 'C', 'targetOption': 'A'}),
                    self.phone_command(f, payload={'option': 'D'})):
            await self.api('POST', path, bad, 409)
        answer = self.phone_command(f, 'answer', {'cardNumber': 1, 'option': 'B', 'targetOption': 'A'}, 'queued-answer')
        await self.api('POST', path, answer)
        self.assertEqual(await self.api('POST', path, command), {'status': 'pending', 'id': command['id']})
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            relayed = await self.api('POST', '/device/relay', {'sessionId': f.session['id'],
                'state': state, 'receipts': []}, headers=self.dh)
        self.assertEqual({c['id'] for c in relayed['commands']}, {command['id'], answer['id']})
        start = f.session['seq'] + 1
        f.target('B', command['id'])
        receipt = {'id': command['id'], 'fingerprint': dumps(command), 'result': {
            'seq': f.session['seq'], 'status': 'confirmed', 'state': public_state(f.session, '高一（1）班')}}
        body = f.body(start, [receipt])
        self.assertEqual((await self.sync(body))['receiptIds'], [command['id']])
        self.assertEqual(await self.api('POST', path, command), receipt['result'])
        row = self.db.one('SELECT status,rejection_origin FROM card_quiz_commands WHERE id=?', (answer['id'],))
        self.assertEqual((row['status'], row['rejection_origin']), ('rejected', 'transport'))
        bad = copy.deepcopy(body)
        bad['receipts'][0]['result']['state']['optionReceived'] = 1
        await self.sync(bad, 409)
        self.assertEqual(json.loads(self.db.one('SELECT result FROM card_quiz_commands WHERE id=?',
                                               (command['id'],))['result']), receipt['result'])

    async def test_anonymous_relay_rejects_private_invalid_and_stale_item_states(self):
        _, f, state = await self.phone_fixture()
        for changes in ({'choices': {'A': True}}, {'activeOption': 'D'}, {'optionReceived': 5},
                        {'optionReceived': True}):
            await self.api('POST', '/device/relay', {'sessionId': f.session['id'],
                'state': {**state, **changes}, 'receipts': []}, 400, self.dh)
        missing = {k: v for k, v in state.items() if k != 'activeOption'}
        await self.api('POST', '/device/relay', {'sessionId': f.session['id'], 'state': missing,
            'receipts': []}, 400, self.dh)
        # A live board cannot silently retarget a collecting round at the same generation.
        changed = {**state, 'activeOption': 'B', 'seq': state['seq'] + 1}
        await self.api('POST', '/device/relay', {'sessionId': f.session['id'], 'state': changed,
            'receipts': []}, 409, self.dh)

    async def test_actual_js_journal_multiple_sync_preserves_declined_options_and_abstentions(self):
        await self.initialize()
        journal = self.journal([
            {'action': 'add_question', 'payload': {**multiple_question(), 'answer': 'CA'}},
            {'action': 'start_round'},
            {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'A', 'targetOption': 'A'}},
            {'action': 'answer', 'payload': {'cardNumber': 2, 'option': 'B', 'targetOption': 'A'}},
            {'action': 'set_multi_option', 'payload': {'option': 'B'}},
            {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'B', 'targetOption': 'B'}},
            {'action': 'set_multi_option', 'payload': {'option': 'C'}},
            {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'A', 'targetOption': 'C'}},
            {'action': 'set_multi_option', 'payload': {'option': 'C'}},
            {'action': 'end_session'}])
        body = self.batch(journal)
        await self.sync(body)
        result = await self.api('GET', '/sessions/session-1')
        self.assertEqual(result['session'], journal['session'])
        self.assertEqual((result['report']['totals']['correct'], result['report']['totals']['wrong'],
                          result['report']['totals']['incomplete'], result['report']['totals']['abstained']), (1, 1, 0, 2))
        command_id = body['events'][-1]['id']
        self.assertEqual(journal['receipts'][command_id]['result']['state'], public_state(journal['session'], ''))

    async def test_closed_and_paused_phone_cannot_retarget_and_legacy_cannot_publish_multi_fields(self):
        pair, f, _ = await self.phone_fixture()
        start = f.session['seq'] + 1
        f.event('recover')
        f.session['generation'] += 1
        f.r.update(status='paused', generation=f.session['generation'])
        await self.sync(f.body(start))
        state = public_state(f.session, '高一（1）班')
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            await self.api('POST', '/device/relay', {'sessionId': f.session['id'], 'state': state,
                                                  'receipts': []}, headers=self.dh)
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', self.phone_command(f), 409)
        start = f.session['seq'] + 1
        e = f.event('end_round')
        f.r.update(status='closed', endedAt=e['at'])
        f.session['generation'] += 1
        await self.sync(f.body(start))
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', self.phone_command(f), 409)
        await self.sync(self.session(sid='old-single'))
        legacy = (await self.api('GET', '/sessions/old-single'))['session']
        state = {**public_state(legacy, '班级'), 'activeOption': None, 'optionReceived': 0}
        await self.api('POST', '/device/relay', {'sessionId': legacy['id'], 'state': state,
                                              'receipts': []}, 400, self.dh)

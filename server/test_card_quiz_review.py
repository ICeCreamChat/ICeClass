"""Review regressions use real HTTP, SQLite and the shared JavaScript Journal."""
import copy
import csv
import io
import json
import subprocess
from unittest.mock import patch

import app as service
from test_card_quiz import CardQuizHttpCase, PREFIX, STAMP, question


class CardQuizReviewTests(CardQuizHttpCase):
    async def test_three_question_lesson_counts_raised_cards_after_offline_resume(self):
        await self.initialize()

        def op(action, **payload):
            return {'action': action, 'payload': payload}

        first = self.journal([
            op('add_question', **question(type='multiple', options=list('ABCD'), answer='AC')),
            op('start_round'), op('set_exempt', studentId='s4', exempt=True),
            op('answer', cardNumber=1, targetOption='A', option='A'),
            op('set_multi_option', option='B'), op('recover')])
        for invalid in ('missing', 'unknown', 'late'):
            forged = copy.deepcopy(self.batch(first))
            opening = forged['events'][1]
            if invalid == 'missing':
                del opening['noCardPolicy']
            elif invalid == 'unknown':
                opening['noCardPolicy'] = 'unknown'
            else:
                forged['events'][-1]['noCardPolicy'] = opening.pop('noCardPolicy')
            with self.subTest(policy=invalid):
                await self.sync(forged, 400)
        await self.sync(self.batch(first))
        before = first['events'][-1]
        state = {**first['receipts'][before['id']]['result']['state'], 'className': '高一（1）班'}
        self.assertEqual((state['roundStatus'], state['received'], state['optionReceived']), ('paused', 1, 0))
        await self.api('POST', '/device/relay', {'sessionId': state['sessionId'], 'state': state,
                       'receipts': []}, headers=self.dh)

        remaining = [
            op('resume_round'), op('answer', cardNumber=2, targetOption='B', option='A'),
            op('set_multi_option', option='C'), op('answer', cardNumber=1, targetOption='C', option='A'),
            op('set_multi_option', option='D'), op('end_round')]
        for kind in ('single', 'boolean'):
            options = ['正确', '错误'] if kind == 'boolean' else ['甲', '乙']
            remaining.extend([op('add_question', **question(type=kind, options=options)), op('start_round'),
                              op('set_exempt', studentId='s4', exempt=True), op('answer', cardNumber=1, option='A'),
                              op('recover'), op('resume_round'), op('answer', cardNumber=3, option='B'),
                              op('end_round' if kind == 'single' else 'end_session')])
        rest = self.journal(remaining, base=first['session'], ids=())
        batch = self.batch(rest, before['seq'] + 1)
        self.assertEqual(await self.sync(batch), await self.sync(batch))
        result = await self.api('GET', '/sessions/session-1')
        rounds = [q['rounds'][0] for q in result['report']['questions']]
        self.assertEqual(rounds[0]['combinationDistribution'], {'AC': 1, 'B': 1})
        self.assertEqual(result['session']['questions'][0]['rounds'][0]['answers']['s1']['choices'], {'A': True, 'C': True})
        for r in rounds:
            self.assertEqual((r['correct'], r['wrong'], r['samples'], r['abstained'], r['exempt']), (1, 1, 2, 1, 1))
        self.assertEqual([r['students'][2]['status'] for r in rounds], ['abstained', 'wrong', 'wrong'])
        self.assertEqual(result['report']['totals']['accuracy'], .5)
        rows = list(csv.DictReader(io.StringIO((await self.api('GET', '/export?classId=' + self.cid)).decode('utf-8-sig'))))
        self.assertEqual([row['作答'] for row in rows if row['状态'] == 'abstained'], ['弃权'] * 3)
        self.assertEqual(rows[0]['作答'], 'AC')

    def receipt(self, journal, command_id):
        receipt = copy.deepcopy(journal['receipts'][command_id])
        receipt['id'] = command_id
        receipt['result']['state']['className'] = '高一（1）班'
        return receipt

    async def bank(self):
        bank = await self.new_question()
        deck = await self.api('POST', '/decks', {'title': '回归题单', 'questionIds': [bank['id']]})
        await self.api('POST', '/decks/' + deck['id'] + '/publish', {'revision': 1, 'classId': self.cid})
        return bank

    async def execution(self, *following):
        pair, state, body = await self.active_pair()
        command = self.command(pair)
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', command)
        journal = self.journal([{'action': 'start_round', 'id': command['id'], 'command': command},
                                *following], base=body['session'])
        return pair, state, body, journal, self.receipt(journal, command['id'])

    async def rename_class(self):
        response = await self.client.patch('/api/classes/' + self.cid,
            json={'name': '高一（2）班'}, headers=self.admin)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.db.one('SELECT name FROM classes WHERE id=?', (self.cid,))['name'], '高一（2）班')

    async def test_b1_practice_exemption_stays_in_round_and_csv_but_not_formal_totals(self):
        await self.initialize()
        journal = self.journal([
            {'action': 'add_question', 'payload': question()}, {'action': 'start_round'},
            {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'A'}},
            {'action': 'end_round'}, {'action': 'start_round', 'payload': {'practice': True}},
            {'action': 'set_exempt', 'payload': {'studentId': 's2', 'exempt': True}},
            {'action': 'answer', 'payload': {'cardNumber': 3, 'option': 'B'}}, {'action': 'end_session'}])
        await self.sync(self.batch(journal))
        data = await self.api('GET', '/sessions/session-1')
        formal, practice = data['report']['questions'][0]['rounds']
        self.assertEqual((formal['purpose'], formal['exempt'], formal['samples']), ('formal', 0, 1))
        self.assertEqual((practice['purpose'], practice['exempt'], practice['practice'], practice['abstained']), ('practice', 1, 1, 2))
        self.assertEqual(next(s['status'] for s in practice['students'] if s['studentId'] == 's2'), 'exempt')
        self.assertEqual(practice['distribution'], {'A': 0, 'B': 1})
        self.assertEqual(data['session']['questions'][0]['rounds'], journal['session']['questions'][0]['rounds'])
        exported = await self.api('GET', '/export?classId=' + self.cid)
        rows = list(csv.DictReader(io.StringIO(exported.decode('utf-8-sig'))))
        self.assertEqual(len(rows), 8)
        self.assertEqual([(r['用途'], r['状态']) for r in rows if r['学生编号'] == 's2'],
                         [('formal', 'abstained'), ('practice', 'exempt')])
        cross = await self.api('GET', '/report?classId=' + self.cid)
        with self.subTest(scope='classroom'):
            totals = data['report']['totals']
            self.assertEqual((totals['samples'], totals['correct'], totals['abstained'],
                              totals['exempt'], totals['practice']), (1, 1, 3, 0, 4))
        for scope, report in (('classroom', data['report']), ('cross-session', cross)):
            with self.subTest(scope=scope):
                student = next(s for s in report['students'] if s['studentId'] == 's2')
                self.assertEqual((student['abstained'], student['exempt'], student['practice']), (1, 0, 1))
        self.assertEqual((cross['knowledge'][0]['answers'], cross['knowledge'][0]['samples']), (1, 1))

    async def test_b2_confirmed_original_receipt_retries_with_empty_events_after_rename(self):
        _, _, _, journal, receipt = await self.execution()
        await self.sync(self.batch(journal, 7, [receipt]))
        stored = self.db.one('SELECT * FROM card_quiz_commands WHERE id=?', ('command-1',))
        await self.rename_class()
        retry = self.batch(journal, 8, [receipt])
        self.assertEqual(retry['events'], [])
        for _ in range(2):
            self.assertEqual(await self.sync(retry), {'syncedSeq': 7, 'receiptIds': ['command-1']})
        self.assertEqual(self.db.one('SELECT * FROM card_quiz_commands WHERE id=?', ('command-1',)), stored)

    async def test_b2_first_historical_receipt_after_rename_keeps_original_result(self):
        _, _, _, journal, receipt = await self.execution()
        self.assertEqual(self.db.one('SELECT status FROM card_quiz_commands WHERE id=?', ('command-1',))['status'], 'pending')
        await self.rename_class()
        self.assertEqual(await self.sync(self.batch(journal, 7, [receipt])),
                         {'syncedSeq': 7, 'receiptIds': ['command-1']})
        stored = self.db.one('SELECT status,result FROM card_quiz_commands WHERE id=?', ('command-1',))
        self.assertEqual(stored['status'], 'confirmed')
        self.assertEqual(json.loads(stored['result']), receipt['result'])
        self.assertEqual(json.loads(stored['result'])['state']['className'], '高一（1）班')

    async def test_b2_same_seq_rename_keeps_pair_connected_and_accepts_display_refresh(self):
        pair, state, _ = await self.active_pair()
        await self.rename_class()
        result = await self.api('GET', '/pairs/' + pair['pairId'])
        self.assertTrue(result['connected'])
        self.assertEqual(result['state'], {**state, 'className': '高一（2）班'})
        command = self.command(pair)
        self.assertEqual(await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', command),
                         {'status': 'pending', 'id': command['id']})
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            relayed = await self.api('POST', '/device/relay', {'sessionId': 'session-1',
                'state': {**state, 'className': '高一（2）班'}, 'receipts': []}, headers=self.dh)
        self.assertEqual(relayed['commands'], [command])

    async def test_b2_live_old_display_name_is_normalized_without_advancing_business_state(self):
        pair, state, _ = await self.active_pair()
        await self.rename_class()
        tick = service.now_ms()
        for index, name in enumerate((state['className'], '旧' * 40), 1):
            with self.subTest(name=name):
                with patch.object(service, 'now_ms', return_value=tick + index * 1000):
                    await self.api('POST', '/device/relay', {'sessionId': 'session-1',
                        'state': {**state, 'className': name}, 'receipts': []}, headers=self.dh)
                saved = self.db.one('SELECT state FROM card_quiz_relay_states WHERE session_id=?', ('session-1',))
                self.assertEqual(json.loads(saved['state']), {**state, 'className': '高一（2）班'})
        result = await self.api('GET', '/pairs/' + pair['pairId'])
        self.assertTrue(result['connected'])
        self.assertEqual(result['state'], {**state, 'className': '高一（2）班'})
        stored = self.db.one('SELECT seq,raw_value FROM card_quiz_sessions WHERE id=?', ('session-1',))
        self.assertEqual((stored['seq'], json.loads(stored['raw_value'])['generation']), (6, 5))

    async def test_b2_live_old_display_name_keeps_first_success_result_unchanged(self):
        _, _, _, journal, receipt = await self.execution()
        await self.rename_class()
        body = {'sessionId': 'session-1', 'state': receipt['result']['state'],
                'receipts': [{'id': 'command-1', 'result': receipt['result']}]}
        tick = service.now_ms()
        with patch.object(service, 'now_ms', return_value=tick + 1000):
            await self.api('POST', '/device/relay', body, headers=self.dh)
        command = self.db.one('SELECT * FROM card_quiz_commands WHERE id=?', ('command-1',))
        self.assertEqual(command['status'], 'confirmed')
        self.assertEqual(json.loads(command['result']), receipt['result'])
        saved = self.db.one('SELECT state FROM card_quiz_relay_states WHERE session_id=?', ('session-1',))
        self.assertEqual(json.loads(saved['state']), {**receipt['result']['state'], 'className': '高一（2）班'})
        self.assertEqual(await self.sync(self.batch(journal, 7, [receipt])),
                         {'syncedSeq': 7, 'receiptIds': ['command-1']})
        with patch.object(service, 'now_ms', return_value=tick + 2000):
            await self.api('POST', '/device/relay', body, headers=self.dh)
        self.assertEqual(self.db.one('SELECT * FROM card_quiz_commands WHERE id=?', ('command-1',)), command)
        changed = copy.deepcopy(receipt)
        changed['result']['state']['className'] = '高一（2）班'
        await self.sync(self.batch(journal, 8, [changed]), 409)
        self.assertEqual(self.db.one('SELECT * FROM card_quiz_commands WHERE id=?', ('command-1',)), command)

    async def test_b2_live_old_display_name_keeps_identity_source_and_size_checks(self):
        _, state, _ = await self.active_pair()
        await self.rename_class()
        stored = self.db.one('SELECT * FROM card_quiz_relay_states WHERE session_id=?', ('session-1',))
        for change, status, code in (
                ({'sessionId': 'other-session'}, 403, 'forbidden'),
                ({'subjectId': 'other-subject'}, 403, 'forbidden'),
                ({'sourceId': 'other-pair'}, 409, 'pair_invalid'),
                ({'generation': 6}, 409, 'stale_context'),
                ({'received': 1}, 409, 'stale_context'),
                ({'className': '旧' * 41}, 400, 'invalid_command'),
                ({'className': None}, 400, 'invalid_command'),
                ({'className': ''}, 400, 'invalid_command')):
            with self.subTest(change=change):
                with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
                    denied = await self.api('POST', '/device/relay', {'sessionId': 'session-1',
                        'state': {**state, **change}, 'receipts': []}, status, self.dh)
                self.assertEqual(denied['code'], code)
                self.assertEqual(self.db.one('SELECT * FROM card_quiz_relay_states WHERE session_id=?', ('session-1',)), stored)

    async def test_b2_same_seq_business_contradictions_still_reject_after_rename(self):
        pair, state, _ = await self.active_pair()
        original = self.db.one('SELECT state FROM card_quiz_relay_states WHERE session_id=?', ('session-1',))['state']
        await self.rename_class()
        for change in ({'generation': 6}, {'received': 1}, {'questionId': 'forged-question'},
                       {'source': 'board', 'sourceId': 'board'}, {'roundStatus': 'paused'}):
            with self.subTest(change=change):
                with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
                    await self.api('POST', '/device/relay', {'sessionId': 'session-1',
                        'state': {**state, 'className': '高一（2）班', **change}, 'receipts': []}, 409, self.dh)
                self.assertEqual(self.db.one('SELECT state FROM card_quiz_relay_states WHERE session_id=?',
                                             ('session-1',))['state'], original)
        self.assertTrue((await self.api('GET', '/pairs/' + pair['pairId']))['connected'])

    async def test_b2_changed_class_name_cannot_replace_confirmed_result_in_sync_or_relay(self):
        _, _, _, journal, receipt = await self.execution()
        await self.sync(self.batch(journal, 7, [receipt]))
        stored = self.db.one('SELECT * FROM card_quiz_commands WHERE id=?', ('command-1',))
        await self.rename_class()
        changed = copy.deepcopy(receipt)
        changed['result']['state']['className'] = '高一（2）班'
        denied = await self.sync(self.batch(journal, 8, [changed]), 409)
        self.assertIn('相同命令的设备回执内容不一致', denied['error'])
        state = {**receipt['result']['state'], 'className': '高一（2）班'}
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            denied = await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state,
                'receipts': [{'id': 'command-1', 'result': changed['result']}]}, 409, self.dh)
        self.assertIn('相同命令的设备回执内容不一致', denied['error'])
        self.assertEqual(self.db.one('SELECT * FROM card_quiz_commands WHERE id=?', ('command-1',)), stored)
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state,
                'receipts': [{'id': 'command-1', 'result': receipt['result']}]}, headers=self.dh)
        self.assertEqual(await self.sync(self.batch(journal, 8, [receipt])),
                         {'syncedSeq': 7, 'receiptIds': ['command-1']})
        self.assertEqual(self.db.one('SELECT * FROM card_quiz_commands WHERE id=?', ('command-1',)), stored)

    async def test_b2_renamed_class_does_not_overturn_explicit_device_rejection(self):
        _, state, _, journal, receipt = await self.execution()
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state,
                'receipts': [{'id': 'command-1', 'error': '设备明确拒绝'}]}, headers=self.dh)
        stored = self.db.one('SELECT * FROM card_quiz_commands WHERE id=?', ('command-1',))
        self.assertEqual(stored['rejection_origin'], 'device')
        await self.rename_class()
        denied = await self.sync(self.batch(journal, 7, [receipt]), 409)
        self.assertIn('相同命令的设备回执内容不一致', denied['error'])
        self.assertEqual(self.db.one('SELECT * FROM card_quiz_commands WHERE id=?', ('command-1',)), stored)
        self.assertEqual(self.db.one('SELECT seq FROM card_quiz_sessions WHERE id=?', ('session-1',))['seq'], 6)

    async def test_f1_answer_proof_binds_card_option_source_generation_and_round(self):
        await self.initialize()
        original = self.session()
        mutations = [lambda e: e['payload'].update(cardNumber=157),
                     lambda e: e['payload'].update(option='B'),
                     lambda e: e.update(generation=0), lambda e: e.update(sourceId='unrelated-pair'),
                     lambda e: e.update(questionId=None), lambda e: e.update(roundId='stale-round'),
                     lambda e: e.pop('generation')]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                body = copy.deepcopy(original)
                mutate(body['events'][2])
                await self.sync(body, 400)
                self.assertEqual(self.db.one('SELECT COUNT(*) n FROM card_quiz_sessions')['n'], 0)
        await self.sync(original)

    async def test_f1_only_end_session_event_proves_complete_sealing(self):
        await self.initialize()
        empty = self.batch(self.journal())
        forged = copy.deepcopy(empty)
        forged['session']['endedAt'] = STAMP
        await self.sync(forged, 400)
        await self.sync(empty)
        body = self.session(ended=False)
        await self.sync(body)
        forged = copy.deepcopy(body)
        forged['session'].update(seq=5, generation=4, endedAt=STAMP + 4000)
        forged['session']['questions'][0]['rounds'][0].update(status='closed', endedAt=STAMP + 4000)
        forged.update(fromSeq=5, events=[{**body['events'][-1], 'seq': 5, 'id': 'fake-seal',
                      'action': 'edit_question', 'at': STAMP + 4000, 'payload': {'revision': 1}}])
        await self.sync(forged, 400)
        await self.api('PUT', '/sessions/session-1', {'revision': 2, 'questions': []}, 409)
        await self.sync(self.advance(body, 'end_session'))
        data = await self.api('GET', '/sessions/session-1')
        await self.api('PUT', '/sessions/session-1', {'revision': data['revision'], 'questions': []})

    async def test_f1_real_journal_edits_seq_lock_recovery_and_generated_ids(self):
        await self.initialize()
        journal = self.journal([
            {'action': 'add_question', 'payload': question(text='题干' * 10000,
                options=['a' * 2000, 'b' * 2000], tags=['标' + str(i) for i in range(50)])},
            {'action': 'edit_question', 'payload': {'expectedSeq': 1, 'text': '锁定序号修改'}},
            {'action': 'start_round'},
            {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'B'}},
            {'action': 'recover'}, {'action': 'resume_round'},
            {'action': 'set_exempt', 'payload': {'studentId': 's2', 'exempt': True}},
            {'action': 'end_round'}, {'action': 'reveal'},
            {'action': 'start_round'}, {'action': 'end_session'}])
        await self.sync(self.batch(journal))
        data = await self.api('GET', '/sessions/session-1')
        q = data['session']['questions'][0]
        self.assertEqual((q['text'], q['revision']), ('锁定序号修改', 2))
        self.assertEqual([r['purpose'] for r in q['rounds']], ['formal', 'practice'])
        self.assertEqual(q['id'], journal['session']['questions'][0]['id'])
        self.assertEqual(data['report']['totals']['samples'], 1)
        bad = self.journal([{'action': 'add_question', 'payload': question()},
                            {'action': 'edit_question', 'payload': {'expectedSeq': 1, 'text': '正常'}}], sid='bad-lock')
        bad['events'][1]['payload']['expectedSeq'] = 0
        await self.sync(self.batch(bad), 400)

    async def test_transition_real_journal_batches_edit_unanswered_type_count_and_text(self):
        await self.initialize()
        body = self.batch(self.journal([{'action': 'add_question', 'payload': question(
            options=['甲', '乙', '丙', '丁'])}]))
        await self.sync(body)
        body = self.advance(body, 'edit_question', {'expectedSeq': 1, 'type': 'boolean', 'text': '改为判断题'})
        self.assertEqual(await self.sync(body), {'syncedSeq': 2, 'receiptIds': []})
        body = self.advance(body, 'edit_question', {'expectedSeq': 2, 'type': 'single',
            'options': ['新甲', '新乙', '新丙'], 'answer': 'C', 'text': '改为三选项'})
        await self.sync(body)
        saved = (await self.api('GET', '/sessions/session-1'))['session']['questions'][0]
        self.assertEqual((saved['type'], saved['options'], saved['text'], saved['revision']),
                         ('single', ['新甲', '新乙', '新丙'], '改为三选项', 3))
        # A sealed empty round has no answers and does not lock type/count.
        body = self.advance(body, 'start_round')
        await self.sync(body)
        body = self.advance(body, 'end_round')
        await self.sync(body)
        sealed = copy.deepcopy(body['session']['questions'][0]['rounds'])
        body = self.advance(body, 'edit_question', {'expectedSeq': 5, 'type': 'boolean', 'answer': 'A'})
        await self.sync(body)
        self.assertEqual(body['session']['questions'][0]['rounds'], sealed)

    async def test_transition_answered_question_can_edit_same_count_labels_preserving_sealed_round(self):
        await self.initialize()
        body = self.batch(self.journal([{'action': 'add_question', 'payload': question()},
            {'action': 'start_round'}, {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'A'}},
            {'action': 'end_round'}]))
        await self.sync(body)
        sealed = copy.deepcopy(body['session']['questions'][0]['rounds'])
        body = self.advance(body, 'edit_question', {'expectedSeq': 4, 'text': '改题干和选项文字',
            'options': ['重新描述甲', '重新描述乙']})
        await self.sync(body)
        data = await self.api('GET', '/sessions/session-1')
        saved = data['session']['questions'][0]
        self.assertEqual(saved['options'], ['重新描述甲', '重新描述乙'])
        self.assertEqual(saved['rounds'], sealed)
        self.assertEqual(data['report']['totals']['correct'], 1)
        forged = self.advance(body, 'edit_question', {'expectedSeq': 5, 'text': '不能改原轮'})
        forged['session']['questions'][0]['rounds'][0]['answers']['s1']['option'] = 'B'
        await self.sync(forged, 409)
        self.assertEqual((await self.api('GET', '/sessions/session-1'))['session']['questions'][0]['rounds'], sealed)

    async def test_transition_existing_answers_still_lock_type_and_count(self):
        await self.initialize()
        body = self.batch(self.journal([{'action': 'add_question', 'payload': question()},
            {'action': 'start_round'}, {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'A'}},
            {'action': 'end_round'}]))
        await self.sync(body)
        for change in ({'type': 'boolean', 'options': ['正确', '错误']},
                       {'options': ['甲', '乙', '丙']}):
            with self.subTest(change=change):
                with self.assertRaises(subprocess.CalledProcessError) as rejected:
                    self.advance(body, 'edit_question', {'expectedSeq': 4, **change})
                self.assertIn('已有作答', rejected.exception.stderr)
                # Generate a valid Journal first, then emulate an untrusted
                # upload that tries the change rejected by the actual model.
                forged = self.advance(body, 'edit_question', {'expectedSeq': 4, 'text': '合法起点'})
                forged['events'][0]['payload'].update(change)
                forged['session']['questions'][0].update(change)
                await self.sync(forged, 409)
        stored = self.db.one('SELECT seq,raw_value FROM card_quiz_sessions WHERE id=?', ('session-1',))
        self.assertEqual((stored['seq'], json.loads(stored['raw_value'])), (4, body['session']))

    async def test_transition_bank_version_matching_and_authorization_stay_enforced(self):
        await self.initialize()
        bank = await self.bank()
        body = self.batch(self.journal([{'action': 'add_question', 'payload': bank}]))
        await self.sync(body)
        body = self.advance(body, 'edit_question', {'expectedSeq': 1, 'text': '已授权题只改题干'})
        await self.sync(body)
        changed = self.advance(body, 'edit_question', {'expectedSeq': 2, 'text': '合法修订起点'})
        changed['events'][0]['payload']['options'] = ['新甲', '新乙']
        changed['session']['questions'][0]['options'] = ['新甲', '新乙']
        denied = await self.sync(changed, 409)
        self.assertIn('关联题库版本', denied['error'])
        initial = self.batch(self.journal([{'action': 'add_question', 'payload': bank}], sid='bank-version-mismatch'))
        initial['events'][0]['payload']['options'] = ['新甲', '新乙']
        initial['session']['questions'][0]['options'] = ['新甲', '新乙']
        denied = await self.sync(initial, 400)
        self.assertIn('关联的题库版本不一致', denied['error'])
        private = await self.new_question(text='未发布的私有题')
        unauthorized = self.batch(self.journal([{'action': 'add_question', 'payload': private}], sid='private-question'))
        denied = await self.sync(unauthorized, 403)
        self.assertIn('未授权给这个班级', denied['error'])

    async def test_f2_default_uses_latest_formal_round_even_empty_and_preserves_history(self):
        await self.initialize()
        for sid, partial in (('empty', False), ('partial', True)):
            body = self.session(sid=sid, ended=False)
            ops = [{'action': 'end_round'}, {'action': 'start_round'}]
            if partial:
                ops.append({'action': 'answer', 'payload': {'cardNumber': 2, 'option': 'B'}})
            ops.extend([{'action': 'end_round'}, {'action': 'start_round', 'payload': {'practice': True}},
                        {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'A'}},
                        {'action': 'end_session'}])
            journal = self.journal(ops, base=body['session'], sid=sid)
            journal['events'] = body['events'] + journal['events']
            await self.sync(self.batch(journal))
            report = (await self.api('GET', '/sessions/' + sid))['report']
            self.assertEqual((report['totals']['samples'], report['totals']['abstained']),
                             (1, 3) if partial else (0, 4))
            self.assertEqual(report['questions'][0]['rounds'][0]['samples'], 2)
            self.assertEqual(report['totals']['practice'], 4)
        report = await self.api('GET', '/report?classId=' + self.cid)
        s1 = next(s for s in report['students'] if s['studentId'] == 's1')
        self.assertEqual(s1['samples'], 0)
        self.assertEqual(report['knowledge'][0]['samples'], 1)
        self.assertIn('round-1', (await self.api('GET', '/export?classId=' + self.cid)).decode('utf-8-sig'))

    async def test_f3_latest_ungraded_removes_old_grade_and_f7_counts_questions_and_answers(self):
        await self.initialize()
        bank = await self.bank()
        await self.sync(self.session(bank=bank))
        for index in (1, 2):
            later = self.session(sid='later-' + str(index), bank=bank)
            shift = index * 10000
            later['session']['startedAt'] += shift
            later['session']['endedAt'] += shift
            for e in later['events']:
                e['at'] += shift
            for r in later['session']['questions'][0]['rounds']:
                r['startedAt'] += shift
                r['endedAt'] += shift
                for a in r['answers'].values():
                    a['confirmedAt'] += shift
            await self.sync(later)
            await self.api('PUT', '/sessions/later-' + str(index), {'revision': 1,
                'questions': [{'id': 'q1', 'answer': None, 'tags': ['代数', '未判定标签']}]})
        no_answer = self.journal([{'action': 'add_question', 'payload': bank}, {'action': 'start_round'},
                                  {'action': 'end_session'}], sid='new-empty', started=STAMP + 30000)
        await self.sync(self.batch(no_answer))
        report = await self.api('GET', '/report?classId=' + self.cid)
        s1 = next(s for s in report['students'] if s['studentId'] == 's1')
        self.assertEqual((s1['samples'], s1['correct'], s1['ungraded'], s1['accuracy']), (0, 0, 1, None))
        for row in report['knowledge']:
            self.assertEqual((row['questionCount'], row['answers'], row['samples'], row['accuracy']), (1, 2, 0, None))

    async def test_f4_recover_auto_rejection_reconciles_original_result_from_empty_sync(self):
        pair, state, body, journal, receipt = await self.execution({'action': 'recover'})
        uploaded = self.batch(journal, body['session']['seq'] + 1)
        await self.sync(uploaded)
        current = copy.deepcopy(receipt['result']['state'])
        current.update(seq=8, generation=7, roundStatus='paused')
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            relayed = await self.api('POST', '/device/relay', {'sessionId': 'session-1',
                'state': current, 'receipts': []}, headers=self.dh)
        self.assertEqual(relayed['commands'], [])
        path = '/pairs/' + pair['pairId'] + '/commands/command-1'
        self.assertEqual((await self.api('GET', path))['status'], 'rejected')
        recovery = self.batch(journal, 9, [receipt])
        for _ in range(2):
            self.assertEqual(await self.sync(recovery), {'syncedSeq': 8, 'receiptIds': ['command-1']})
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 2000):
            result = await self.api('GET', path)
        self.assertEqual(result, {'status': 'confirmed', 'result': receipt['result']})
        self.assertEqual((result['result']['seq'], result['result']['state']['roundStatus'],
                          result['result']['state']['generation']), (7, 'collecting', 6))

    async def test_f4_ended_expired_login_known_batch_keeps_review_and_unregistered_local_receipts(self):
        pair, _, body, journal, receipt = await self.execution({'action': 'end_session', 'id': 'local-end'})
        uploaded = self.batch(journal, 7)
        await self.sync(uploaded)
        await self.api('PUT', '/sessions/session-1', {'revision': 4,
            'questions': [{'id': 'q1', 'text': '教师保留修订', 'answer': 'B'}]})
        self.db.run('DELETE FROM sessions WHERE token_hash=?',
                    (self.db.one('SELECT login_hash FROM card_quiz_pairs WHERE id=?', (pair['pairId'],))['login_hash'],))
        receipts = [receipt, self.receipt(journal, 'local-end')]
        for start in (7, 9):
            result = await self.sync(self.batch(journal, start, receipts))
            self.assertEqual(result, {'syncedSeq': 8, 'receiptIds': ['command-1', 'local-end']})
        body['receipts'] = receipts
        self.assertEqual(await self.sync(body), {'syncedSeq': 8, 'receiptIds': ['command-1', 'local-end']})
        row = self.db.one('SELECT raw_value,value,seq,revision FROM card_quiz_sessions WHERE id=?', ('session-1',))
        self.assertEqual((row['seq'], row['revision']), (8, 5))
        self.assertEqual(json.loads(row['value'])['questions'][0]['text'], '教师保留修订')
        self.assertEqual(json.loads(row['raw_value'])['questions'][0]['text'], '测试题')
        await self.api('GET', '/pairs/' + pair['pairId'], status=401)
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', self.command(pair), 401)

    async def test_f4_explicit_device_rejection_is_immutable_despite_durable_proof(self):
        _, state, body, journal, receipt = await self.execution()
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state,
                'receipts': [{'id': 'command-1', 'error': '设备明确拒绝'}]}, headers=self.dh)
        await self.sync(self.batch(journal, 7, [receipt]), 409)
        row = self.db.one('SELECT status,error FROM card_quiz_commands WHERE id=?', ('command-1',))
        self.assertEqual((row['status'], row['error']), ('rejected', '设备明确拒绝'))
        self.assertEqual(self.db.one('SELECT seq FROM card_quiz_sessions WHERE id=?', ('session-1',))['seq'], 6)

    async def test_f4_proof_rejects_forged_fingerprints_results_and_unregistered_ids(self):
        _, _, _, journal, receipt = await self.execution()
        good = self.batch(journal, 7, [receipt])
        mutations = [lambda r: r.update(id='not-an-event'),
                     lambda r: r.update(fingerprint='a' * 64),
                     lambda r: r.update(fingerprint=r['fingerprint'].replace('start_round', 'end_round')),
                     lambda r: r.update(fingerprint=r['fingerprint'].replace('"payload":{}', '"payload":{"bad":NaN}')),
                     lambda r: r['result'].update(seq=6),
                     lambda r: r['result']['state'].update(roundId='forged'),
                     lambda r: r['result']['state'].update(generation=5),
                     lambda r: r['result']['state'].update(sourceId='wrong-pair'),
                     lambda r: r['result']['state'].update(received=1)]
        for mutate in mutations:
            bad = copy.deepcopy(good)
            mutate(bad['receipts'][0])
            response = await self.client.post(PREFIX + '/device/sync', json=bad, headers=self.dh)
            self.assertIn(response.status, (400, 409), await response.text())
            self.assertEqual(self.db.one('SELECT seq FROM card_quiz_sessions WHERE id=?', ('session-1',))['seq'], 6)
        self.assertEqual((await self.sync(good))['receiptIds'], ['command-1'])

    async def test_f4_explicit_failure_after_auto_cancellation_still_prevents_reconciliation(self):
        pair, state, _, journal, receipt = await self.execution({'action': 'recover'})
        paused = {**state, **receipt['result']['state'], 'seq': 8, 'generation': 7, 'roundStatus': 'paused'}
        tick = service.now_ms()
        with patch.object(service, 'now_ms', return_value=tick + 1000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': paused,
                'receipts': []}, headers=self.dh)
        with patch.object(service, 'now_ms', return_value=tick + 2000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': paused,
                'receipts': [{'id': 'command-1', 'error': '设备最终确认未执行'}]}, headers=self.dh)
        await self.sync(self.batch(journal, 7, [receipt]), 409)
        self.assertEqual(self.db.one('SELECT error FROM card_quiz_commands WHERE id=?',
                                    ('command-1',))['error'], '设备最终确认未执行')

    async def test_f1_large_question_keeps_existing_event_body_bound(self):
        await self.initialize()
        journal = self.journal([{'action': 'add_question', 'payload': question()}, {'action': 'end_session'}])
        # The current Journal rejects this payload before dispatch. Tamper with
        # a valid Journal to verify the independent HTTP boundary as well.
        oversized = question(
            text='题' * 20000, options=['项' * 2000] * 4,
            tags=[str(i) + '签' * 78 for i in range(50)])
        journal['events'][0]['payload'] = oversized
        journal['session']['questions'][0].update(oversized)
        denied = await self.sync(self.batch(journal), 400)
        self.assertIn('64 KiB', denied['error'])
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM card_quiz_sessions')['n'], 0)

    async def test_f1_malformed_exempt_student_returns_validation_error(self):
        await self.initialize()
        body = self.session(exempt=True)
        body['events'][4]['payload']['studentId'] = []
        await self.sync(body, 400)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM card_quiz_sessions')['n'], 0)

    async def test_f4_all_phone_actions_preserve_their_original_post_states(self):
        pair, state, body = await self.active_pair()
        operations = [
            ('edit_question', {'expectedSeq': 6, 'text': '手机改题'}), ('reveal', {}),
            ('add_question', question(text='手机新题')), ('start_round', {}),
            ('answer', {'cardNumber': 1, 'option': 'B'}), ('end_round', {})]
        tick = service.now_ms()
        receipts, events = [], []
        for i, (action, payload) in enumerate(operations, 1):
            session = body['session']
            command = self.command(pair, id='phone-' + str(i), action=action, payload=payload,
                generation=session['generation'], questionId=session['currentQuestionId'], roundId=session['currentRoundId'])
            await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', command)
            journal = self.journal([{'action': action, 'command': command}], base=session)
            receipt = self.receipt(journal, command['id'])
            with patch.object(service, 'now_ms', return_value=tick + i * 1000):
                await self.api('POST', '/device/relay', {'sessionId': 'session-1',
                    'state': receipt['result']['state'], 'receipts': [{'id': command['id'], 'result': receipt['result']}]},
                    headers=self.dh)
            receipts.append(receipt)
            events.extend(journal['events'])
            body = self.batch(journal, 7)
        body.update(events=events, receipts=receipts)
        for _ in range(2):
            result = await self.sync(body)
            self.assertEqual(result, {'syncedSeq': 12, 'receiptIds': ['phone-' + str(i) for i in range(1, 7)]})
        for receipt in receipts:
            stored = self.db.one('SELECT result FROM card_quiz_commands WHERE id=?', (receipt['id'],))
            self.assertEqual(json.loads(stored['result']), receipt['result'])
        self.assertEqual(receipts[2]['result']['state']['roundId'], None)
        self.assertEqual(receipts[3]['result']['state']['roundStatus'], 'collecting')
        bad = copy.deepcopy(body)
        bad['receipts'][0]['result'] = copy.deepcopy(receipts[-1]['result'])
        await self.sync(bad, 409)

    async def test_f4_source_withdrawal_and_pair_expiry_allow_only_proven_history(self):
        pair, _, _, journal, receipt = await self.execution(
            {'action': 'end_round'}, {'action': 'set_source', 'payload': {'source': 'board', 'sourceId': 'board'}})
        await self.sync(self.batch(journal, 7))
        self.db.run('UPDATE card_quiz_pairs SET expires_at=0 WHERE id=?', (pair['pairId'],))
        result = await self.sync(self.batch(journal, 10, [receipt]))
        self.assertEqual(result, {'syncedSeq': 9, 'receiptIds': ['command-1']})
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', self.command(pair), 403)
        stored = self.db.one('SELECT result FROM card_quiz_commands WHERE id=?', ('command-1',))
        self.assertEqual(json.loads(stored['result'])['state']['sourceId'], pair['pairId'])
        self.assertEqual(self.db.one('SELECT seq FROM card_quiz_sessions WHERE id=?', ('session-1',))['seq'], 9)

    async def test_f4_registered_command_cannot_be_replaced_by_different_valid_event(self):
        pair, _, body = await self.active_pair()
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', self.command(pair))
        journal = self.journal([{'id': 'command-1', 'action': 'add_question', 'payload': question()}], base=body['session'])
        await self.sync(self.batch(journal, 7, [self.receipt(journal, 'command-1')]), 409)
        self.assertEqual(self.db.one('SELECT status FROM card_quiz_commands WHERE id=?', ('command-1',))['status'], 'pending')

    async def test_f7_multiple_tags_count_distinct_questions_without_student_weighting(self):
        await self.initialize()
        journal = self.journal([
            {'action': 'add_question', 'payload': question(tags=['代数', '几何'])}, {'action': 'start_round'},
            {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'A'}},
            {'action': 'answer', 'payload': {'cardNumber': 2, 'option': 'B'}}, {'action': 'end_round'},
            {'action': 'add_question', 'payload': question(answer=None)}, {'action': 'start_round'},
            {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'A'}}, {'action': 'end_session'}])
        await self.sync(self.batch(journal))
        knowledge = {row['tag']: row for row in (await self.api('GET', '/report?classId=' + self.cid))['knowledge']}
        self.assertEqual((knowledge['代数']['questionCount'], knowledge['代数']['answers'], knowledge['代数']['samples']), (2, 3, 2))
        self.assertEqual((knowledge['几何']['questionCount'], knowledge['几何']['answers'], knowledge['几何']['samples']), (1, 2, 2))
        self.assertEqual(knowledge['代数']['accuracy'], .5)

    async def test_f4_receipts_are_bounded_unique_and_need_owned_session(self):
        _, _, _, journal, receipt = await self.execution()
        for receipts, status in (([receipt] * 129, 400), ([receipt] * 2, 400),
                                 ([{**receipt, 'fingerprint': 'x' * 17000}], 413)):
            await self.sync(self.batch(journal, 7, receipts), status)
        self.db.run('INSERT INTO devices(id,class_id,name,token_hash,enabled,created_at,updated_at) VALUES(?,?,?,?,1,?,?)',
                    ('other-device', self.cid, '另一设备', service.sha256('other-token'), STAMP, STAMP))
        wrong = {'Authorization': 'Bearer other-token', 'X-ICeClass-Device-Id': 'other-device',
                 'X-ICeClass-Class-Id': self.cid}
        await self.sync(self.batch(journal, 7, [receipt]), 403, wrong)

    async def test_f4_nonfinite_receipt_json_is_rejected_without_server_error(self):
        _, _, _, journal, receipt = await self.execution()
        receipt['result']['state']['received'] = 'overflow-number'
        raw = json.dumps(self.batch(journal, 7, [receipt])).replace('"overflow-number"', '1e400')
        response = await self.client.post(PREFIX + '/device/sync', data=raw,
            headers={**self.dh, 'Content-Type': 'application/json'})
        self.assertEqual(response.status, 400, await response.text())
        self.assertEqual(self.db.one('SELECT seq FROM card_quiz_sessions WHERE id=?', ('session-1',))['seq'], 6)

    async def test_f4_first_upload_receipts_are_acknowledged_after_commit(self):
        await self.initialize()
        journal = self.journal([{'action': 'end_session', 'id': 'empty-class-seal'}])
        receipt = self.receipt(journal, 'empty-class-seal')
        body = self.batch(journal, receipts=[receipt])
        self.assertEqual(await self.sync(body), {'syncedSeq': 1, 'receiptIds': ['empty-class-seal']})
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM card_quiz_events')['n'], 1)
        self.assertEqual(await self.sync(body), {'syncedSeq': 1, 'receiptIds': ['empty-class-seal']})

    async def test_f4_legacy_rejection_migration_preserves_unknown_device_failure(self):
        from card_quiz import CardQuiz
        _, state, _, journal, receipt = await self.execution()
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state,
                'receipts': [{'id': 'command-1', 'error': '迁移前的拒绝'}]}, headers=self.dh)
        self.db.run('ALTER TABLE card_quiz_commands DROP COLUMN rejection_origin')
        CardQuiz(self.app, service)
        row = self.db.one('SELECT status,error,rejection_origin FROM card_quiz_commands WHERE id=?', ('command-1',))
        self.assertEqual((row['status'], row['error'], row['rejection_origin']), ('rejected', '迁移前的拒绝', None))
        await self.sync(self.batch(journal, 7, [receipt]), 409)

    async def test_f5_newer_sync_revokes_stale_relay_permission(self):
        pair, _, body = await self.active_pair()
        body = self.advance(body, 'set_source', {'source': 'board', 'sourceId': 'board'})
        await self.sync(body)
        await self.api('GET', '/pairs/' + pair['pairId'], status=403)
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', self.command(pair), 403)

    async def test_relay_overtaken_by_sync_retries_original_receipt_without_reopening_round(self):
        from card_quiz_events import public_state
        pair, _, _, journal, receipt = await self.execution({'action': 'end_round'})
        await self.sync(self.batch(journal, 7))
        latest = public_state(journal['session'], receipt['result']['state']['className'])
        stale = {'sessionId': latest['sessionId'], 'state': receipt['result']['state'], 'retrySuperseded': True,
                 'receipts': [{'id': receipt['id'], 'result': receipt['result']}], 'preview': {'id': 'old', 'prepare': True}}
        command = lambda: self.db.one('SELECT status,result FROM card_quiz_commands WHERE id=?', (receipt['id'],))
        previous = command()
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            self.assertEqual(await self.api('POST', '/device/relay', stale, headers=self.dh), {'supersededSeq': latest['seq']})
            self.assertEqual(command(), previous)
            self.assertEqual((await self.api('GET', '/pairs/' + pair['pairId']))['state']['roundStatus'], 'closed')
            await self.api('POST', '/device/relay', {**stale, 'retrySuperseded': False}, 400, self.dh)
            await self.api('POST', '/device/relay', {**stale, 'state': {**stale['state'], 'seq': -1}}, 400, self.dh)
            await self.api('POST', '/device/relay', {**stale, 'state': latest}, headers=self.dh)
        self.assertEqual(json.loads(command()['result']), receipt['result'])
        self.assertEqual(command()['status'], 'confirmed')

    async def test_f5_same_seq_raw_and_relay_contradiction_is_rejected(self):
        pair, state, _ = await self.active_pair()
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1',
                'state': {**state, 'generation': 6, 'seq': 6}, 'receipts': []}, 409, self.dh)
        self.assertTrue((await self.api('GET', '/pairs/' + pair['pairId']))['connected'])

    async def test_f6_paused_phone_cannot_repair_or_switch_in_relay(self):
        _, state, _ = await self.active_pair()
        paused = {**state, 'seq': 7, 'generation': 6, 'roundStatus': 'paused'}
        tick = service.now_ms()
        with patch.object(service, 'now_ms', return_value=tick + 1000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': paused,
                'receipts': []}, headers=self.dh)
        await self.api('POST', '/device/pair', {'sessionId': 'session-1'}, 409, self.dh)
        with patch.object(service, 'now_ms', return_value=tick + 2000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1',
                'state': {**paused, 'source': 'board', 'sourceId': 'board', 'generation': 7, 'seq': 8},
                'receipts': []}, 409, self.dh)

    async def test_recent_pairings_batch_queries_keep_scope_and_poll_bounds(self):
        pair, state, _ = await self.active_pair()
        command = self.command(pair)
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', command)
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            result = await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state,
                'receipts': []}, headers=self.dh)
        self.assertEqual(result['commands'], [command])
        self.assertEqual([(p['pairId'], p['claimed']) for p in result['pairings']], [(pair['pairId'], True)])
        path = '/pairs/' + pair['pairId'] + '?commandId=command-1&commandId=missing'
        self.assertEqual((await self.api('GET', path))['receipts'], [{'id': 'command-1', 'status': 'pending'}])
        await self.api('GET', path, status=429)

    async def test_sync_body_above_global_cap_is_locally_bounded(self):
        await self.initialize()
        body = self.session(ended=False)
        for seq in range(5, 185):
            event = {**body['events'][-1], 'seq': seq, 'id': 'large-' + str(seq),
                     'at': STAMP + seq * 1000, 'payload': {'cardNumber': 1, 'option': 'A', 'note': 'x' * 60000}}
            body['events'].append(event)
        body['session']['seq'] = 184
        body['session']['questions'][0]['rounds'][0]['answers']['s1'] = {
            'option': 'A', 'confirmedAt': STAMP + 184000, 'seq': 184}
        self.assertGreater(len(json.dumps(body).encode()), 9 * 1024 * 1024)
        self.assertEqual((await self.sync(body))['syncedSeq'], 184)
        headers = {**self.dh, 'Content-Type': 'application/json'}
        response = await self.client.post(PREFIX + '/device/sync',
            data=io.BytesIO(b' ' * (32 * 1024 * 1024 + 1)), headers=headers)
        self.assertEqual(response.status, 413, await response.text())
        await self.api('POST', '/device/pair', {'sessionId': 'session-1', 'extra': 'x' * (9 * 1024 * 1024)},
                       413, self.dh)

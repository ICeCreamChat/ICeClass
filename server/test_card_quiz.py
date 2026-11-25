"""Card quiz contracts exercised through real HTTP requests and temporary SQLite."""
import asyncio
import base64
import copy
import csv
import io
import json
from pathlib import Path
import subprocess
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import app as service
from card_quiz_events import public_state
from homework import defaults
from teacher_capabilities import actions, reads, undeclared_routes
from test_app import ServerTestCase


PREFIX = '/api/card-quiz'
STAMP = 1_780_000_000_000
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/p8AAAAASUVORK5CYII=')


def question(**changes):
    value = {'subjectId': 'math', 'type': 'single', 'text': '测试题', 'imageId': None,
             'options': ['选项甲', '选项乙'], 'answer': 'A', 'tags': ['代数']}
    value.update(changes)
    return value


class CardQuizHttpCase(ServerTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.device = await self.enroll_test_device()
        self.cid = self.device['classId']
        self.db = self.app[service.STORE_KEY]
        self.admin = self.headers(csrf=True)
        self.dh = {'Authorization': 'Bearer ' + self.device['deviceToken'],
                   'X-ICeClass-Device-Id': self.device['deviceId'], 'X-ICeClass-Class-Id': self.cid}
        self.students = [{'id': 's' + str(i), 'name': '测试学生' + str(i)} for i in range(1, 5)]
        value = defaults()
        value['students'] = self.students
        response = await self.client.put('/api/homework/classes/' + self.cid + '/profile',
                                         json={'revision': 0, 'value': value}, headers=self.admin)
        self.assertEqual(response.status, 200, await response.text())

    async def api(self, method, path, body=None, status=200, headers=None):
        request_headers = dict(self.admin if headers is None else headers)
        arguments = {'json': body}
        if body is not None and len(json.dumps(body)) > 1024 * 1024:
            request_headers['Content-Type'] = 'application/json'
            arguments = {'data': io.BytesIO(json.dumps(body).encode('utf-8'))}
        response = await self.client.request(method, PREFIX + path, headers=request_headers, **arguments)
        self.assertEqual(response.status, status, (await response.read()).decode('utf-8', errors='replace'))
        if response.content_type == 'application/json':
            data = await response.json()
            if status >= 400:
                self.assertIsInstance(data.get('error'), str)
            return data
        return await response.read()

    async def account(self, name, *, head=(), teaching=()):
        response = await self.client.post('/api/teachers', json={
            'username': name, 'displayName': name, 'role': 'teacher' if head else 'subject_teacher',
            'password': 'CardQuizTest123', 'headClassIds': list(head), 'teachingClassIds': list(teaching)},
            headers=self.admin)
        self.assertEqual(response.status, 201, await response.text())
        uid = (await response.json())['id']
        response = await self.client.post('/api/auth/login', json={'username': name, 'password': 'CardQuizTest123'})
        self.assertEqual(response.status, 200, await response.text())
        return uid, {'Cookie': response.headers['Set-Cookie'].split(';', 1)[0],
                     'X-CSRF-Token': (await response.json())['user']['csrfToken']}

    async def other_class(self):
        response = await self.client.post('/api/classes', json={'name': '高二（8）班'}, headers=self.admin)
        self.assertEqual(response.status, 201, await response.text())
        return (await response.json())['id']

    async def initialize(self):
        return await self.api('PUT', f'/classes/{self.cid}/cards', {'revision': 0, 'initialize': True})

    async def new_question(self, *, headers=None, **changes):
        return await self.api('POST', '/questions', {'value': question(**changes)}, headers=headers)

    def journal(self, operations=(), *, base=None, sid='session-1', started=STAMP, ids=(), card_mode='assigned'):
        """Run the actual shared model and durable Journal, including incoming metadata."""
        root = Path(__file__).resolve().parents[1]
        script = r"""
const fs=require('node:fs'), path=require('node:path');
const input=JSON.parse(fs.readFileSync(0,'utf8')), ids=[...input.ids];
const crypto=require('node:crypto');
Object.defineProperty(globalThis,'crypto',{value:{randomUUID:()=>ids.shift()||crypto.randomUUID()}});
const Model=require(path.join(input.root,'web_controller/card-quiz/model.js'));
const Journal=require(path.join(input.root,'web_controller/card-quiz/journal.js'));
(async()=>{
  const session=input.base||Model.createSession(input.context,'math',input.started,input.cardMode);
  if(!input.base)session.id=input.sid;
  const control=new Journal.Controller(Journal.create(session),async value=>value);
  for(const op of input.operations){
    Date.now=()=>op.at;
    const s=control.session;
    await control.dispatch({id:op.id,sessionId:s.id,questionId:s.currentQuestionId,
      roundId:s.currentRoundId,generation:s.generation,sourceId:s.sourceId,
      action:op.action,payload:op.payload||{},...op.command});
  }
  process.stdout.write(JSON.stringify(control.journal));
})().catch(e=>{process.stderr.write(e.stack);process.exitCode=1;});
"""
        operations = [{**op, 'id': op.get('id', sid + '-e' + str((base or {}).get('seq', 0) + i)),
                       'at': op.get('at', started + ((base or {}).get('seq', 0) + i - 1) * 1000)}
                      for i, op in enumerate(operations, 1)]
        context = {'classId': self.cid, 'deviceId': self.device['deviceId'],
                   'rosterRevision': 1, 'cardRevision': 1,
                   'students': [{**s, 'cardNumber': i} for i, s in enumerate(self.students, 1)]}
        result = subprocess.run(['node', '-e', script], input=json.dumps({
            'root': str(root), 'base': base, 'context': context, 'sid': sid,
            'started': started, 'operations': operations, 'ids': list(ids), 'cardMode': card_mode}),
            text=True, encoding='utf-8', capture_output=True, check=True, timeout=20)
        return json.loads(result.stdout)

    @staticmethod
    def batch(journal, start=1, receipts=()):
        return {'session': journal['session'], 'events': [e for e in journal['events'] if e['seq'] >= start],
                'fromSeq': start, 'receipts': list(receipts)}

    def advance(self, body, action, payload=None, **command):
        journal = self.journal([{'action': action, 'payload': payload or {}, 'command': command}],
                               base=body['session'], ids=())
        return self.batch(journal, body['session']['seq'] + 1)

    def session(self, *, sid='session-1', ended=True, purpose='formal', answer='A', bank=None, exempt=False):
        payload = {**(bank or question(answer=answer))}
        if bank:
            payload.update(bankId=bank['id'], bankVersion=bank['revision'])
        operations = [{'action': 'add_question', 'payload': payload},
                      {'action': 'start_round', 'payload': {'practice': purpose == 'practice'}},
                      {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'A'}},
                      {'action': 'answer', 'payload': {'cardNumber': 2, 'option': 'B'}}]
        if exempt:
            operations.append({'action': 'set_exempt', 'payload': {'studentId': 's3', 'exempt': True}})
        if ended:
            operations.extend([{'action': 'end_round'}, {'action': 'end_session'}])
        return self.batch(self.journal(operations, sid=sid, ids=('session-id', 'q1', 'round-1')))

    async def sync(self, body=None, status=200, headers=None):
        return await self.api('POST', '/device/sync', body or self.session(), status,
                              self.dh if headers is None else headers)

    async def active_pair(self):
        await self.initialize()
        body = self.session(ended=False)
        await self.sync(body)
        pair = await self.api('POST', '/device/pair', {'sessionId': 'session-1'}, headers=self.dh)
        claimed = await self.api('POST', '/pair', {'code': pair['code']})
        self.assertEqual(claimed['pairId'], pair['pairId'])
        self.assertNotIn('deviceToken', json.dumps(pair))
        body = self.advance(body, 'end_round')
        await self.sync(body)
        state = {'sessionId': 'session-1', 'className': '高一（1）班', 'subjectId': 'math', 'questionId': 'q1',
                 'questionNumber': 1, 'questionType': 'single', 'optionCount': 2, 'roundId': 'round-1',
                 'roundStatus': 'closed', 'source': 'phone', 'sourceId': pair['pairId'], 'generation': 5,
                 'seq': 6, 'received': 2, 'expected': 4, 'ended': False}
        # Switching phones happens between sealed rounds and is saved before relaying.
        body = self.advance(body, 'set_source', {'source': 'phone', 'sourceId': pair['pairId']})
        await self.sync(body)
        state['noCardPolicy'] = 'abstain'
        await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state, 'receipts': []}, headers=self.dh)
        return pair, state, body

    def command(self, pair, **changes):
        value = {'id': 'command-1', 'sessionId': 'session-1', 'questionId': 'q1', 'roundId': 'round-1',
                 'generation': 5, 'sourceId': pair['pairId'], 'action': 'start_round', 'payload': {}}
        value.update(changes)
        return value

class CardQuizTests(CardQuizHttpCase):
    async def test_cards_read_never_assigns_and_initialize_is_versioned(self):
        path = f'/classes/{self.cid}/cards'
        data = await self.api('GET', path)
        self.assertEqual([s['cardNumber'] for s in data['students']], [None] * 4)
        self.assertTrue(data['canEdit'])
        self.assertEqual(data['revision'], 0)
        assigned = await self.initialize()
        self.assertEqual([s['cardNumber'] for s in assigned['students']], [1, 2, 3, 4])
        await self.api('PUT', path, {'revision': 0, 'initialize': True}, 409)
        self.assertEqual((await self.api('GET', path))['revision'], 1)

    async def test_card_bindings_validate_duplicates_capacity_and_leave_unbound(self):
        await self.initialize()
        path = f'/classes/{self.cid}/cards'
        for bindings in ([{'studentId': 's1', 'cardNumber': 1}, {'studentId': 's2', 'cardNumber': 1}],
                         [{'studentId': 's1', 'cardNumber': 158}], [{'studentId': 's1', 'cardNumber': True}],
                         [{'studentId': 'unknown', 'cardNumber': 5}], [{'studentId': 's1', 'cardNumber': 2}]):
            await self.api('PUT', path, {'revision': 1, 'bindings': bindings}, 400)
        data = await self.api('PUT', path, {'revision': 1, 'bindings': [{'studentId': 's1', 'cardNumber': None}]})
        self.assertEqual([s['cardNumber'] for s in data['students']], [None, 2, 3, 4])
        self.assertEqual((await self.api('GET', '/device/bootstrap', headers=self.dh))['students'][0]['cardNumber'], None)
        profile = defaults()
        profile['students'] = [{'id': 'p' + str(i), 'name': '学生'} for i in range(158)]
        response = await self.client.put('/api/homework/classes/' + self.cid + '/profile',
                                         json={'revision': 1, 'value': profile}, headers=self.admin)
        self.assertEqual(response.status, 200)
        await self.api('PUT', path, {'revision': 2, 'initialize': True}, 400)

    async def test_class_permission_csrf_and_real_teacher_device_separation(self):
        outside = await self.other_class()
        _, teacher = await self.account('subject1', teaching=[self.cid])
        data = await self.api('GET', f'/classes/{self.cid}/cards', headers=teacher)
        self.assertFalse(data['canEdit'])
        await self.api('PUT', f'/classes/{self.cid}/cards', {'revision': 0, 'initialize': True}, 403, teacher)
        for path in (f'/classes/{outside}/cards', f'/classes/{outside}/publications',
                     '/sessions?classId=' + outside, '/report?classId=' + outside, '/export?classId=' + outside):
            await self.api('GET', path, status=403, headers=teacher)
        await self.api('POST', '/questions', {'value': question()}, 403,
                       {'Cookie': self.admin['Cookie']})
        await self.api('GET', f'/classes/{self.cid}/cards', status=401, headers=self.dh)
        await self.api('GET', '/device/bootstrap', status=401, headers=self.admin)
        spoofed = {**self.admin, 'X-ICeClass-Device': self.device['deviceId'],
                   'X-ICeClass-Class': self.cid, **self.dh}
        await self.api('GET', '/questions', status=401, headers=spoofed)

    async def test_question_bank_is_private_and_revision_conflicts_preserve_data(self):
        saved = await self.new_question()
        _, other = await self.account('subject2', teaching=[self.cid])
        self.assertEqual((await self.api('GET', '/questions', headers=other))['questions'], [])
        path = '/questions/' + saved['id']
        await self.api('PUT', path, {'revision': 1, 'value': question(text='偷改')}, 403, other)
        await self.api('DELETE', path, {'revision': 1}, 403, other)
        updated = await self.api('PUT', path, {'revision': 1, 'value': question(text='修订')})
        self.assertEqual(updated['revision'], 2)
        await self.api('PUT', path, {'revision': 1, 'value': question()}, 409)
        await self.api('DELETE', path, {'revision': 1}, 409)
        await self.api('DELETE', path, {'revision': 2})
        self.assertEqual((await self.api('GET', '/questions'))['questions'], [])

    async def test_question_validation_does_not_silently_truncate(self):
        for change in ({'type': 'essay'}, {'options': ['A']}, {'options': ['a'] * 5},
                       {'answer': 'C'}, {'type': 'boolean', 'options': ['a', 'b', 'c']},
                       {'tags': ['x'] * 51}, {'imageId': 'data:image/png;base64,xx'}, {'text': 'x' * 20001}):
            await self.api('POST', '/questions', {'value': question(**change)}, 400)
        saved = await self.new_question(text='', answer=None, tags=[])
        self.assertIsNone(saved['answer'])
        self.assertEqual(saved['tags'], [])

    async def test_publications_keep_order_and_snapshots_after_edits_and_withdrawal(self):
        first, second = await self.new_question(), await self.new_question(text='第二题')
        deck = await self.api('POST', '/decks', {'title': '题单', 'questionIds': [second['id'], first['id']]})
        self.assertEqual((await self.api('GET', '/decks'))['decks'][0]['id'], deck['id'])
        await self.api('PUT', '/decks/' + deck['id'], {'revision': 0, 'title': '旧版本', 'questionIds': []}, 409)
        publication = await self.api('POST', '/decks/' + deck['id'] + '/publish', {'revision': 1, 'classId': self.cid})
        self.assertEqual([q['id'] for q in publication['questions']], [second['id'], first['id']])
        self.assertEqual(publication['questions'][0]['bankId'], second['id'])
        await self.api('DELETE', '/questions/' + second['id'], {'revision': 1})
        data = await self.api('GET', '/device/publications/' + publication['id'], headers=self.dh)
        self.assertEqual(data['questions'][0]['text'], '第二题')
        self.assertEqual(len((await self.api('GET', f'/classes/{self.cid}/publications'))['publications']), 1)
        await self.api('DELETE', '/publications/' + publication['id'])
        self.assertEqual((await self.api('GET', '/device/bootstrap', headers=self.dh))['publications'], [])
        await self.api('GET', '/device/publications/' + publication['id'], status=404, headers=self.dh)

    async def test_mixed_subject_deck_cannot_be_published_but_the_draft_is_retained(self):
        math = await self.new_question()
        english = await self.new_question(subjectId='english')
        questions = [math['id'], english['id']]
        deck = await self.api('POST', '/decks', {'title': '混合学科', 'questionIds': questions})
        path = '/decks/' + deck['id']
        publication = {'revision': deck['revision'], 'classId': self.cid}
        failure = await self.api('POST', path + '/publish', publication, 400)
        self.assertIn('同一学科', failure['error'])
        self.assertEqual((await self.api('GET', '/decks'))['decks'][0]['questionIds'], questions)
        self.assertEqual((await self.api('GET', '/device/bootstrap', headers=self.dh))['publications'], [])
        edited = await self.api('PUT', path, {'revision': deck['revision'], 'title': '数学', 'questionIds': [math['id']]})
        publication['revision'] = edited['revision']
        self.assertEqual(len((await self.api('POST', path + '/publish', publication))['questions']), 1)

    async def test_deck_private_questions_class_scope_and_list_bounds(self):
        saved = await self.new_question()
        _, other = await self.account('subject3', teaching=[self.cid])
        await self.api('POST', '/decks', {'title': '越权', 'questionIds': [saved['id']]}, 403, other)
        await self.api('POST', '/decks', {'title': '过长', 'questionIds': [saved['id']] * 101}, 400)
        deck = await self.api('POST', '/decks', {'title': '原题单', 'questionIds': [saved['id']]})
        await self.api('PUT', '/decks/' + deck['id'], {'revision': 1, 'title': '越权', 'questionIds': []}, 403, other)
        outside = await self.other_class()
        own = await self.api('POST', '/questions', {'value': question()}, headers=other)
        deck = await self.api('POST', '/decks', {'title': '任课题单', 'questionIds': [own['id']]}, headers=other)
        await self.api('POST', '/decks/' + deck['id'] + '/publish', {'revision': 1, 'classId': outside}, 403, other)

    async def test_images_validate_bytes_and_authorize_by_live_references(self):
        for data in ('data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,eA==',
                     'data:image/jpeg;base64,' + base64.b64encode(PNG).decode(),
                     'data:image/png;base64,' + base64.b64encode(PNG + b'x' * (2 * 1024 * 1024)).decode()):
            await self.api('POST', '/images', {'dataUrl': data}, 400)
        image = await self.api('POST', '/images', {'dataUrl': 'data:image/png;base64,' + base64.b64encode(PNG).decode()})
        path = '/images/' + image['id']
        self.assertEqual(await self.api('GET', path), PNG)
        _, other = await self.account('subject4', teaching=[self.cid])
        await self.api('GET', path, status=403, headers=other)
        await self.api('GET', path, status=403, headers=self.dh)
        await self.api('POST', '/questions', {'value': question(imageId=image['id'])}, 403, other)
        q = await self.new_question(imageId=image['id'])
        deck = await self.api('POST', '/decks', {'title': '图片题单', 'questionIds': [q['id']]})
        pub = await self.api('POST', '/decks/' + deck['id'] + '/publish', {'revision': 1, 'classId': self.cid})
        self.assertEqual(await self.api('GET', path, headers=other), PNG)
        self.assertEqual(await self.api('GET', path, headers=self.dh), PNG)
        await self.api('DELETE', '/publications/' + pub['id'])
        await self.api('GET', path, status=403, headers=other)

    async def test_sync_is_durable_contiguous_and_retries_are_content_checked(self):
        await self.initialize()
        body = self.session()
        self.assertEqual(await self.sync(body), {'syncedSeq': 6, 'receiptIds': []})
        self.assertEqual(await self.sync(copy.deepcopy(body)), {'syncedSeq': 6, 'receiptIds': []})
        bad = copy.deepcopy(body)
        bad['events'][2]['payload'] = {'different': True}
        await self.sync(bad, 409)
        bad = copy.deepcopy(body)
        bad['session']['questions'][0]['text'] = '同版本不同内容'
        await self.sync(bad, 409)
        data = await self.api('GET', '/sessions/session-1')
        self.assertEqual(data['session']['questions'][0]['text'], '测试题')
        self.assertEqual((await self.api('GET', '/sessions?classId=' + self.cid))['sessions'][0]['seq'], 6)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM card_quiz_sessions')['n'], 1)

    async def test_sync_invalid_snapshots_and_gaps_are_atomic(self):
        await self.initialize()
        original = self.session()
        mutations = [lambda b: b['events'].pop(2), lambda b: b.update(fromSeq=2),
                     lambda b: b['session']['questions'][0]['rounds'][0]['answers'].update(
                         stranger={'option': 'A', 'confirmedAt': STAMP + 2000, 'seq': 3}),
                     lambda b: b['session']['questions'][0]['rounds'][0]['answers']['s1'].update(option='D'),
                     lambda b: b['session']['roster'][1].update(cardNumber=1),
                     lambda b: b['session']['questions'][0]['rounds'][0].update(status='collecting'),
                     lambda b: b['session'].update(schema=2),
                     lambda b: b['session']['questions'][0].update(imageId='data:image/png;base64,eA==')]
        for mutate in mutations:
            bad = copy.deepcopy(original)
            mutate(bad)
            await self.sync(bad, 400)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM card_quiz_sessions')['n'], 0)
        await self.sync(original)

    async def test_sync_device_class_and_same_class_device_cannot_impersonate(self):
        await self.initialize()
        await self.sync()
        other = await self.other_class()
        bad = self.session(sid='outside')
        bad['session']['classId'] = other
        await self.sync(bad, 403)
        bad = self.session(sid='wrong-device')
        bad['session']['deviceId'] = 'another-device'
        await self.sync(bad, 403)
        await self.sync(self.session(sid='teacher-spoof'), 401, self.admin)
        self.db.run('UPDATE devices SET class_id=? WHERE id=?', (other, self.device['deviceId']))
        await self.sync(status=401)

    async def test_ended_session_teacher_revision_survives_old_upload_and_rejects_new_seq(self):
        await self.initialize()
        body = self.session()
        await self.sync(body)
        saved = await self.api('GET', '/sessions/session-1')
        updated = await self.api('PUT', '/sessions/session-1', {'revision': saved['revision'],
                                 'questions': [{'id': 'q1', 'text': '课后修订', 'answer': 'B', 'tags': ['订正']}]})
        self.assertEqual(updated['revision'], saved['revision'] + 1)
        await self.sync(body)
        self.assertEqual((await self.api('GET', '/sessions/session-1'))['session']['questions'][0]['text'], '课后修订')
        await self.api('PUT', '/sessions/session-1', {'revision': saved['revision'], 'questions': []}, 409)
        bad = copy.deepcopy(body)
        bad['session']['seq'] = 7
        bad.update(fromSeq=7, events=[{**body['events'][-1], 'seq': 7, 'id': 'late',
            'generation': body['session']['generation'], 'action': 'edit_question',
            'at': body['session']['endedAt'], 'payload': {'revision': 1}}])
        await self.sync(bad, 409)

    async def test_active_session_cannot_be_reviewed_and_recovery_only_pauses(self):
        await self.initialize()
        body = self.session(ended=False)
        await self.sync(body)
        await self.api('PUT', '/sessions/session-1', {'revision': 1, 'questions': [{'id': 'q1', 'answer': 'B'}]}, 409)
        body = self.advance(body, 'recover')
        bad = copy.deepcopy(body)
        bad['session']['questions'][0]['rounds'][0]['status'] = 'collecting'
        await self.sync(bad, 400)
        await self.sync(body)
        self.assertEqual((await self.api('GET', '/sessions/session-1'))['session']['generation'], 4)

    async def test_report_separates_unanswered_exempt_ungraded_and_practice(self):
        await self.initialize()
        await self.sync(self.session(exempt=True))
        data = await self.api('GET', '/sessions/session-1')
        totals = data['report']['totals']
        for key, value in {'samples': 2, 'correct': 1, 'wrong': 1, 'unanswered': 0, 'abstained': 1, 'exempt': 1}.items():
            self.assertEqual(totals[key], value)
        await self.sync(self.session(sid='practice', purpose='practice'))
        await self.sync(self.session(sid='ungraded', answer=None))
        report = await self.api('GET', '/report?classId=' + self.cid + '&subjectId=math')
        s1 = next(s for s in report['students'] if s['studentId'] == 's1')
        self.assertEqual((s1['samples'], s1['correct'], s1['wrong']), (1, 1, 0))
        self.assertEqual(report['knowledge'][0]['samples'], 2)
        self.assertEqual(report['knowledge'][0]['wrong'], 1)

    async def test_report_same_bank_version_uses_latest_valid_formal_answer(self):
        await self.initialize()
        bank = await self.new_question()
        deck = await self.api('POST', '/decks', {'title': '统计题单', 'questionIds': [bank['id']]})
        await self.api('POST', '/decks/' + deck['id'] + '/publish', {'revision': 1, 'classId': self.cid})
        first = self.session(bank=bank)
        await self.sync(first)
        later = self.session(sid='later', bank=bank)
        later['session']['startedAt'] += 10000
        later['session']['endedAt'] += 10000
        r = later['session']['questions'][0]['rounds'][0]
        r['startedAt'] += 10000
        r['endedAt'] += 10000
        for event in later['events']:
            event['at'] += 10000
        for answer in r['answers'].values():
            answer['confirmedAt'] += 10000
        r['answers']['s1']['option'] = 'B'
        later['events'][2]['payload']['option'] = 'B'
        await self.sync(later)
        data = await self.api('GET', '/report?classId=' + self.cid)
        s1 = next(s for s in data['students'] if s['studentId'] == 's1')
        self.assertEqual((s1['samples'], s1['wrong']), (1, 1))

    async def test_teacher_review_claim_validation_preserves_options_and_bank_revision(self):
        await self.initialize()
        await self.sync()
        uid, teacher = await self.account('reviewer', teaching=[self.cid])
        await self.api('PUT', '/sessions/session-1', {'revision': 1, 'teacherId': 'someone-else', 'questions': []}, 403, teacher)
        await self.api('PUT', '/sessions/session-1', {'revision': 1, 'questions': [{'id': 'q1', 'options': ['新', '项']}]}, 400)
        saved = await self.api('PUT', '/sessions/session-1', {'revision': 1, 'teacherId': uid, 'questions': [{'id': 'q1', 'answer': None}]}, headers=teacher)
        self.assertEqual(saved['session']['teacherId'], uid)
        self.assertIsNone(saved['session']['questions'][0]['answer'])

    async def test_export_quotes_spreadsheet_formulas(self):
        await self.initialize()
        body = self.session()
        body['session']['roster'][0]['name'] = '=1+1'
        body['session']['questions'][0]['text'] = '+SUM(A1)'
        body['events'][0]['payload']['text'] = '+SUM(A1)'
        await self.sync(body)
        raw = await self.api('GET', '/export?classId=' + self.cid)
        cells = [cell for row in csv.reader(io.StringIO(raw.decode('utf-8-sig'))) for cell in row]
        self.assertIn("'=1+1", cells)
        self.assertIn("'+SUM(A1)", cells)

    async def test_pair_is_single_use_expiring_and_requires_authorized_teacher(self):
        await self.initialize()
        await self.sync(self.session(ended=False))
        pair = await self.api('POST', '/device/pair', {'sessionId': 'session-1'}, headers=self.dh)
        _, other = await self.account('unrelated', teaching=[await self.other_class()])
        await self.api('POST', '/pair', {'code': pair['code']}, 403, other)
        with patch.object(service, 'now_ms', return_value=pair['expiresAt'] + 1):
            await self.api('POST', '/pair', {'code': pair['code']}, 409)
        pair = await self.api('POST', '/device/pair', {'sessionId': 'session-1'}, headers=self.dh)
        await self.api('POST', '/pair', {'code': pair['code']})
        await self.api('POST', '/pair', {'code': pair['code']}, 409)

    async def test_scan_invite_connects_without_a_login_and_only_collects_confirmed_cards(self):
        board = self.batch(self.journal([{'action': 'add_question', 'payload': question()}], card_mode='scanned'))
        await self.sync(board)
        sid = board['session']['id']
        offer = await self.api('POST', '/device/pair', {'sessionId': sid, 'quickScan': True}, headers=self.dh)
        link = urlsplit(offer['url'])
        self.assertEqual((link.path, link.query), ('/card-quiz/phone.html', ''))
        invite = {'invite': parse_qs(link.fragment)['scan'][0]}
        self.assertNotIn('code', offer)
        self.client.session.cookie_jar.clear()
        mobile = {'X-ICeClass-Scanner': 'a' * 64}
        second = {'X-ICeClass-Scanner': 'b' * 64}
        await self.api('GET', '/sessions', status=401, headers=mobile)
        await self.api('POST', '/scan', invite, 403, {})
        claimed = await self.api('POST', '/scan', invite, headers=mobile)
        self.assertEqual(claimed, await self.api('POST', '/scan', invite, headers=mobile))
        await self.api('POST', '/scan', invite, 409, second)
        pid = claimed['pairId']
        path = '/pairs/' + pid
        waiting = await self.api('GET', path, headers=mobile)
        self.assertIsNone(waiting['state'])
        self.assertFalse(waiting['connected'])
        self.assertTrue(waiting['boardOnline'])
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 20000):
            self.assertFalse((await self.api('GET', path, headers=mobile))['boardOnline'])
        await self.api('GET', path, status=403, headers=second)
        board = self.advance(board, 'set_source', {'source': 'phone', 'sourceId': pid})
        await self.sync(board)
        board = self.advance(board, 'start_round')
        await self.sync(board)
        state = public_state(board['session'], '高一（1）班')
        relay = {'sessionId': sid, 'state': state, 'receipts': []}
        stamp = service.now_ms() + 22000
        with patch.object(service, 'now_ms', return_value=stamp):
            await self.api('POST', '/device/relay', relay, headers=self.dh)
            current = await self.api('GET', path, headers=mobile)
            self.assertTrue(current['connected'])
            self.assertEqual(current['state']['received'], 0)
            self.assertEqual(current['state']['participantCount'], 0)
            self.assertNotIn('roster', current['state'])
            for action in ('start_round', 'end_round', 'edit_question', 'set_multi_option'):
                await self.api('POST', path + '/commands', {'action': action}, 403, mobile)
            for number, option in enumerate('AB', 1):
                cmd = {'id': 'scan-card-' + str(number), 'action': 'answer', 'sessionId': sid, 'sourceId': pid,
                       'questionId': state['questionId'], 'roundId': state['roundId'], 'generation': state['generation'],
                       'payload': {'cardNumber': number, 'option': option}}
                response = await self.api('POST', path + '/commands', cmd, headers=mobile)
                self.assertEqual(response['status'], 'pending')
        with patch.object(service, 'now_ms', return_value=stamp + 1500):
            self.assertEqual((await self.api('GET', path, headers=mobile))['state']['received'], 0)
            delivery = await self.api('POST', '/device/relay', relay, headers=self.dh)
        self.assertEqual(len(delivery['commands']), 2)
        receipts = []
        for cmd in delivery['commands']:
            journal = self.journal([{'action': 'answer', 'command': cmd}], base=board['session'])
            board = self.batch(journal, board['session']['seq'] + 1)
            await self.sync(board)
            result = journal['receipts'][cmd['id']]['result']
            result['state']['className'] = state['className']
            receipts.append({'id': cmd['id'], 'result': result})
        with patch.object(service, 'now_ms', return_value=stamp + 3000):
            await self.api('POST', '/device/relay', {**relay, 'state': public_state(board['session'], state['className']),
                                                     'receipts': receipts}, headers=self.dh)
            saved = await self.api('GET', path + '?commandId=scan-card-1&commandId=scan-card-2', headers=mobile)
            self.assertEqual(saved['state']['received'], 2)
            self.assertEqual(saved['state']['participantCount'], 2)
            self.assertEqual([r['status'] for r in saved['receipts']], ['confirmed', 'confirmed'])
        for secret in (invite['invite'], mobile['X-ICeClass-Scanner']):
            self.assertNotIn(secret, '\n'.join(self.db.db.iterdump()))

    async def test_scan_invite_expires_and_closing_whiteboard_invalidates_pending_phone(self):
        await self.initialize()
        await self.sync(self.session(ended=False))
        body = {'sessionId': 'session-1', 'quickScan': True}
        mobile = {'X-ICeClass-Scanner': 'c' * 64}
        offer = await self.api('POST', '/device/pair', body, headers=self.dh)
        invite = {'invite': parse_qs(urlsplit(offer['url']).fragment)['scan'][0]}
        with patch.object(service, 'now_ms', return_value=offer['expiresAt']):
            await self.api('POST', '/scan', invite, 410, mobile)
        await self.api('POST', '/scan', invite, headers=mobile)
        await self.api('POST', '/device/pair/cancel', {'sessionId': body['sessionId'], 'pairId': offer['pairId']},
                       headers=self.dh)
        await self.api('GET', '/pairs/' + offer['pairId'], status=403, headers=mobile)
        await self.api('POST', '/scan', invite, 410, mobile)

    async def test_pair_state_is_anonymous_and_source_must_be_saved_before_commands(self):
        pair, state, _ = await self.active_pair()
        data = await self.api('GET', '/pairs/' + pair['pairId'])
        self.assertTrue(data['connected'])
        for key in ('roster', 'answers', 'answer', 'students'):
            self.assertNotIn(key, data['state'])
        self.assertEqual(data['state'], state)
        await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': {**state, 'students': self.students}, 'receipts': []}, 400, self.dh)
        for action in ('recover', 'set_source', 'end_session', 'set_exempt'):
            await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', self.command(pair, action=action), 400)

    async def test_camera_preview_only_signals_current_paired_round_in_memory(self):
        pair, previous, body = await self.active_pair()
        body = self.advance(body, 'start_round')
        await self.sync(body)
        state = public_state(body['session'], previous['className'])
        path = '/pairs/' + pair['pairId']
        relay = {'sessionId': state['sessionId'], 'state': state, 'receipts': []}
        offer = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:fixture-offer\r\n'
        answer = offer.replace('fixture-offer', 'fixture-answer')
        signal = {'id': 'connection-1', 'offer': offer}
        stamp = service.now_ms() + 1200
        with patch.object(service, 'now_ms', return_value=stamp):
            ready = await self.api('POST', '/device/relay', {**relay, 'preview': signal}, headers=self.dh)
            self.assertEqual(ready['preview'], {'id': signal['id']})
            self.assertEqual((await self.api('GET', path+'?preview=open'))['preview'], signal)
            await self.api('POST', path+'/preview', {'id': 'previous', 'answer': answer}, 409)
            await self.api('POST', path+'/preview', {'id': signal['id'], 'answer': 'invalid'}, 400)
            _, other = await self.account('preview-other', teaching=[self.cid])
            await self.api('POST', path+'/preview', {'id': signal['id'], 'answer': answer}, 403, other)
            await self.api('POST', path+'/preview', {'id': signal['id'], 'answer': answer})
        with patch.object(service, 'now_ms', return_value=stamp+1300):
            received = await self.api('POST', '/device/relay', {**relay, 'preview': {'id': signal['id']}}, headers=self.dh)
            self.assertEqual(received['preview']['answer'], answer)
            self.assertEqual((await self.api('GET', path+'?preview=connection-1'))['preview'], {'id': signal['id']})
        self.assertNotIn('fixture-offer', '\n'.join(self.db.db.iterdump()))
        self.assertNotIn('fixture-answer', '\n'.join(self.db.db.iterdump()))
        sealed = self.advance(body, 'end_round')
        await self.sync(sealed)
        with patch.object(service, 'now_ms', return_value=stamp+2600):
            closed = await self.api('POST', '/device/relay', {**relay, 'state': public_state(sealed['session'], previous['className']),
                                                              'preview': {'id': 'closed', 'prepare': True}}, headers=self.dh)
            self.assertNotIn('preview', closed)
            self.assertNotIn('preview', await self.api('GET', path+'?preview=open'))
            await self.api('POST', path+'/preview', {'id': signal['id'], 'answer': answer}, 409)

    async def test_camera_preview_bounds_video_offers_and_answers_without_interrupting_relay(self):
        pair, previous, body = await self.active_pair()
        body = self.advance(body, 'start_round')
        await self.sync(body)
        state = public_state(body['session'], previous['className'])
        path = '/pairs/' + pair['pairId']
        base = {'sessionId': state['sessionId'], 'state': state, 'receipts': []}
        header = 'v=0\r\n'
        data = 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
        video = 'm=video 9 UDP/TLS/RTP/SAVPF 96 97\r\n'
        audio = 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
        receive = video + 'a=recvonly\r\n'
        send = video + 'a=sendonly\r\n'
        offer = header + receive + data

        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1200) as clock:
            async def board(key, **signal):
                clock.return_value += 1100
                return await self.api('POST', '/device/relay', {**base, 'preview': {'id': key, **signal}}, headers=self.dh)

            ready = await board('media', prepare=True)
            self.assertEqual(ready['preview'], {'id': 'media', 'iceServers': [], 'video': True})
            self.assertEqual((await board('media', offer=offer))['preview'], {'id': 'media'})
            self.assertEqual((await self.api('GET', path+'?preview=open'))['preview'], {'id': 'media', 'offer': offer})
            for invalid in (data + audio, receive, data + data, receive + receive + data, send + data,
                            video + data, video + 'a=inactive\r\n' + data, receive + 'a=sendrecv\r\n' + data,
                            data.replace('webrtc-datachannel', 'other-webrtc-datachannel'), data + 'a=x:' + 'x' * 16384):
                with self.subTest(offer=invalid[:80]):
                    result = await board('other', offer=header + invalid)
                    self.assertIn('commands', result)
                    self.assertNotIn('preview', result)
            self.assertNotIn('preview', await board('media', offer=header + send + data))
            for invalid in (receive + data, video + 'a=sendrecv\r\n' + data, video + data, send + audio + data,
                            send + send + data, data + send, data, send + data.replace(' 9 ', ' 0 '),
                            send + data.replace(' 9 ', ' 0 ') + 'a=bundle-only\r\n'):
                with self.subTest(answer=invalid):
                    await self.api('POST', path+'/preview', {'id': 'media', 'answer': header + invalid}, 400)
            answer = header + send + data
            await self.api('POST', path+'/preview', {'id': 'media', 'answer': answer})
            await self.api('POST', path+'/preview', {'id': 'media', 'answer': answer})
            self.assertEqual((await board('media'))['preview']['answer'], answer)
            await self.api('POST', path+'/preview', {'id': 'media', 'answer': header + video + 'a=inactive\r\n' + data}, 409)

            # The session direction applies until overridden by a media attribute. A bundled
            # zero-port offer is active, while a phone can decline the video m-line altogether.
            bundled = header + 'a=recvonly\r\n' + data + video.replace(' 9 ', ' 0 ') + 'a=bundle-only\r\n'
            for key, video_answer in [('inactive', video + 'a=inactive\r\n'), ('declined', video.replace(' 9 ', ' 0 '))]:
                self.assertIn('preview', await board(key, offer=bundled))
                legacy_answer = header + data + video_answer
                await self.api('POST', path+'/preview', {'id': key, 'answer': legacy_answer})
                self.assertEqual((await board(key))['preview']['answer'], legacy_answer)
            self.assertIn('preview', await board('data-only', offer=header + data))
            await self.api('POST', path+'/preview', {'id': 'data-only', 'answer': header + data + send}, 400)
            await self.api('POST', path+'/preview', {'id': 'data-only', 'answer': header + data})

    async def test_turn_credentials_only_reach_their_paired_device_without_blocking_answers(self):
        from card_quiz_turn import PreviewTurn
        pair, previous, body = await self.active_pair()
        body = self.advance(body, 'start_round')
        await self.sync(body)
        state = public_state(body['session'], previous['className'])
        path = '/pairs/' + pair['pairId']
        relay = {'sessionId': state['sessionId'], 'state': state, 'receipts': []}
        gate = asyncio.Event()
        issued = {role: [{'urls': ['turn:relay.example'], 'username': role,
                          'credential': 'private-' + role}] for role in ('board', 'phone')}
        async def issue():
            await gate.wait()
            return issued
        # Exercise the production pair/round validation and the asynchronous cache through HTTP.
        handler = next(r.handler for r in self.app.router.routes()
                       if r.resource.canonical == PREFIX + '/device/relay')
        turn = handler.__self__.preview_turn
        turn.endpoint = 'https://relay.example'
        stamp = service.now_ms() + 1300
        probe = {'id': 'preview-turn-1', 'prepare': True}
        with patch.object(PreviewTurn, 'issue', side_effect=issue) as provision:
            with patch.object(service, 'now_ms', return_value=stamp):
                waiting = await self.api('POST', '/device/relay', {**relay, 'preview': probe}, headers=self.dh)
                self.assertTrue(waiting['preview']['preparing'])
                self.assertNotIn('video', waiting['preview'])
                self.assertIn('commands', waiting)
                self.assertNotIn('preview', await self.api('GET', path+'?preview=open'))
            gate.set()
            await asyncio.sleep(0)
            with patch.object(service, 'now_ms', return_value=stamp+1000):
                board = await self.api('POST', '/device/relay', {**relay, 'preview': probe}, headers=self.dh)
                self.assertEqual(board['preview']['iceServers'], issued['board'])
                self.assertIs(board['preview']['video'], True)
            offer = {'id': probe['id'], 'offer': 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n'
                                                'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'}
            with patch.object(service, 'now_ms', return_value=stamp+2000):
                await self.api('POST', '/device/relay', {**relay, 'preview': offer}, headers=self.dh)
                phone = await self.api('GET', path+'?preview=open')
                self.assertEqual(phone['preview']['iceServers'], issued['phone'])
                self.assertNotIn('private-board', json.dumps(phone))
            with patch.object(service, 'now_ms', return_value=stamp+3100):
                self.assertNotIn('iceServers', (await self.api('GET', path+'?preview='+probe['id']))['preview'])
                _, other = await self.account('other-preview-turn', teaching=[self.cid])
                await self.api('GET', path+'?preview=open', status=403, headers=other)
            provision.assert_awaited_once()
            self.assertNotIn('private-board', '\n'.join(self.db.db.iterdump()))
            self.assertNotIn('private-phone', '\n'.join(self.db.db.iterdump()))

    async def test_relay_waits_for_device_receipt_and_retry_checks_content_before_state(self):
        pair, state, body = await self.active_pair()
        path = '/pairs/' + pair['pairId'] + '/commands'
        command = self.command(pair)
        self.assertEqual(await self.api('POST', path, command), {'status': 'pending', 'id': 'command-1'})
        self.assertEqual((await self.api('GET', path + '/command-1'))['status'], 'pending')
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            relayed = await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state, 'receipts': []}, headers=self.dh)
        self.assertEqual(relayed['commands'], [command])
        journal = self.journal([{'action': 'start_round', 'command': command}], base=body['session'])
        result = journal['receipts'][command['id']]['result']
        result['state']['className'] = state['className']
        next_state = result['state']
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 2000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': next_state,
                           'receipts': [{'id': command['id'], 'result': result}]}, headers=self.dh)
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 3000):
            self.assertEqual(await self.api('GET', path + '/command-1'), {'status': 'confirmed', 'result': result})
        self.assertEqual(await self.api('POST', path, command), result)
        await self.api('POST', path, {**command, 'payload': {'purpose': 'practice'}}, 409)

    async def test_relay_generation_disconnect_permission_and_login_session_are_rechecked(self):
        pair, state, _ = await self.active_pair()
        path = '/pairs/' + pair['pairId']
        command = self.command(pair)
        await self.api('POST', path + '/commands', {**command, 'generation': 1}, 409)
        await self.api('POST', path + '/commands', {**command, 'sourceId': 'other-pair'}, 409)
        uid, other = await self.account('phone-user', teaching=[self.cid])
        await self.api('GET', path, status=403, headers=other)
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 16000):
            self.assertFalse((await self.api('GET', path))['connected'])
            await self.api('POST', path + '/commands', command, 409)
        # A new login of the same account is not the login session which claimed the code.
        response = await self.client.post('/api/auth/login', json={'username': 'ICe', 'password': 'AdminPassword123'})
        fresh = {'Cookie': response.headers['Set-Cookie'].split(';', 1)[0],
                 'X-CSRF-Token': (await response.json())['user']['csrfToken']}
        await self.api('GET', path, status=403, headers=fresh)
        self.db.run('UPDATE devices SET enabled=0 WHERE id=?', (self.device['deviceId'],))
        await self.api('GET', path, status=403)

    async def test_relay_pending_queue_and_message_size_are_bounded(self):
        pair, _, _ = await self.active_pair()
        path = '/pairs/' + pair['pairId'] + '/commands'
        for i in range(128):
            await self.api('POST', path, self.command(pair, id='cmd-' + str(i)))
        await self.api('POST', path, self.command(pair, id='overflow'), 429)
        await self.api('POST', path, self.command(pair, id='too-big', payload={'text': 'x' * 17000}), 413)

    async def test_relay_wrong_device_cannot_acknowledge(self):
        pair, state, _ = await self.active_pair()
        path = '/pairs/' + pair['pairId'] + '/commands'
        await self.api('POST', path, self.command(pair))
        self.db.run('INSERT INTO devices(id,class_id,name,token_hash,enabled,created_at,updated_at) VALUES(?,?,?,?,1,?,?)',
                    ('second-device', self.cid, '同班另台', service.sha256('second-token'), STAMP, STAMP))
        second = {'Authorization': 'Bearer second-token', 'X-ICeClass-Device-Id': 'second-device',
                  'X-ICeClass-Class-Id': self.cid}
        await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state,
                       'receipts': [{'id': 'command-1', 'result': {'seq': 6}}]}, 403, second)
        self.assertEqual((await self.api('GET', path + '/command-1'))['status'], 'pending')

    async def test_handlers_are_discovered_and_protocols_have_manual_reasons(self):
        self.assertEqual(undeclared_routes(self.app), [])
        catalog = {**actions(self.app), **reads(self.app)}
        self.assertTrue(any(s.path == PREFIX + '/questions' for s in catalog.values()))
        for route in self.app.router.routes():
            path = route.resource.canonical
            if route.method == 'HEAD' or not path.startswith(PREFIX):
                continue
            if '/device/' in path or path == PREFIX + '/pair' or '/pairs/' in path or '/images' in path:
                self.assertTrue(getattr(route.handler, '__teacher_manual__', ''), (route.method, path))

    async def test_empty_answer_and_multicharacter_options_are_rejected(self):
        for answer in ('', 'AB'):
            await self.api('POST', '/questions', {'value': question(answer=answer)}, 400)
        await self.initialize()
        body = self.session()
        body['session']['questions'][0]['rounds'][0]['answers']['s1']['option'] = ''
        await self.sync(body, 400)

    async def test_malformed_event_actions_and_nonfinite_json_return_errors(self):
        await self.initialize()
        body = self.session()
        body['events'][0]['action'] = {}
        await self.sync(body, 400)
        response = await self.client.post(PREFIX + '/questions', data='{"value":NaN}',
                                          headers={**self.admin, 'Content-Type': 'application/json'})
        self.assertEqual(response.status, 400, await response.text())
        self.assertIn('error', await response.json())

    async def test_sync_cross_batch_event_order_and_answer_event_reference_are_validated(self):
        await self.initialize()
        body = self.session(ended=False)
        bad = copy.deepcopy(body)
        bad['session']['questions'][0]['rounds'][0]['answers']['s1']['seq'] = 1
        await self.sync(bad, 400)
        await self.sync(body)
        body = self.advance(body, 'recover')
        body['events'][0]['at'] = STAMP + 500
        await self.sync(body, 400)
        self.assertEqual((await self.api('GET', '/sessions/session-1'))['session']['seq'], 4)

    async def test_recovery_cannot_modify_answers_or_skip_generation(self):
        await self.initialize()
        body = self.session(ended=False)
        await self.sync(body)
        body = self.advance(body, 'recover')
        changed = copy.deepcopy(body)
        changed['session']['questions'][0]['rounds'][0]['answers']['s1']['option'] = 'B'
        await self.sync(changed, 400)
        changed = copy.deepcopy(body)
        changed['session'].update(generation=3)
        changed['session']['questions'][0]['rounds'][0].update(generation=3)
        await self.sync(changed, 400)
        await self.sync(body)

    async def test_closed_round_answers_cannot_be_changed_by_later_sync(self):
        await self.initialize()
        body = self.session()
        body['session']['endedAt'] = None
        body['session']['seq'] = 5
        body['session']['generation'] -= 1
        body['events'].pop()
        await self.sync(body)
        body['session']['seq'] = 6
        body['session']['questions'][0]['rounds'][0]['answers']['s1']['option'] = 'B'
        body.update(fromSeq=6, events=[{**body['events'][-1], 'seq': 6, 'id': 'late-answer',
            'generation': body['session']['generation'], 'action': 'answer', 'at': STAMP + 6000,
            'payload': {'cardNumber': 1, 'option': 'B'}}])
        await self.sync(body, 409)

    async def test_source_switch_requires_pause_or_a_sealed_round(self):
        await self.initialize()
        body = self.session(ended=False)
        await self.sync(body)
        body['session'].update(seq=5, source='phone', sourceId='other-source', generation=4)
        body['session']['questions'][0]['rounds'][0].update(status='paused', source='phone', sourceId='other-source', generation=4)
        body.update(fromSeq=5, events=[{**body['events'][-1], 'seq': 5, 'id': 'switch',
            'action': 'set_source', 'at': STAMP + 4000,
            'payload': {'source': 'phone', 'sourceId': 'other-source'}}])
        await self.sync(body, 409)

    async def test_paused_round_can_pass_to_phone_and_resume_without_losing_answers(self):
        await self.initialize()
        board = self.session(ended=False)
        await self.sync(board)
        pair = await self.api('POST', '/device/pair', {'sessionId': 'session-1'}, headers=self.dh)
        await self.api('POST', '/pair', {'code': pair['code']})

        async def relay(batch, status=200):
            state = public_state(batch['session'], '高一（1）班')
            return await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state,
                                                           'receipts': []}, status, self.dh)

        await relay(board)
        paused = self.advance(board, 'recover')
        await self.sync(paused)
        handoff = self.advance(paused, 'set_source', {'source': 'phone', 'sourceId': pair['pairId']})
        await relay(handoff, 409)
        await self.sync(handoff)
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            await relay(handoff)
            path = '/pairs/' + pair['pairId'] + '/commands'
            generation = handoff['session']['generation']
            resume = self.command(pair, id='resume-same-round', action='resume_round', generation=generation)
            self.assertEqual((await self.api('POST', path, resume))['status'], 'pending')
            await self.api('POST', path, {**resume, 'id': 'old-context', 'generation': generation - 1}, 409)
            live = self.advance(handoff, 'resume_round', id=resume['id'])
            await self.sync(live)
            received = self.advance(live, 'answer', {'cardNumber': 3, 'option': 'A'})
            await self.sync(received)
            await self.api('POST', path, {**resume, 'id': 'not-paused', 'generation': generation + 1}, 409)
        self.assertEqual(received['session']['currentRoundId'], 'round-1')
        self.assertEqual(len(received['session']['questions'][0]['rounds']), 1)
        self.assertEqual(public_state(received['session'], '')['received'], 3)

    async def test_pair_permission_revocation_stops_reads_commands_and_device_forwarding(self):
        pair, state, _ = await self.active_pair()
        # Pair with a teacher whose live scope can be revoked without deleting their login.
        next_pair = await self.api('POST', '/device/pair', {'sessionId': 'session-1'}, headers=self.dh)
        uid, teacher = await self.account('revoked-phone', teaching=[self.cid])
        await self.api('POST', '/pair', {'code': next_pair['code']}, headers=teacher)
        state.update(sourceId=next_pair['pairId'], generation=6, seq=7)
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state, 'receipts': []}, headers=self.dh)
        command = self.command(next_pair, generation=6)
        path = '/pairs/' + next_pair['pairId']
        await self.api('POST', path + '/commands', command, headers=teacher)
        self.db.run('DELETE FROM teaching_classes WHERE user_id=?', (uid,))
        await self.api('GET', path, status=403, headers=teacher)
        await self.api('POST', path + '/commands', command, 403, teacher)
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 2000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state, 'receipts': []}, 403, self.dh)
        await self.api('GET', '/pairs/' + pair['pairId'], status=403)

    async def test_pair_without_saved_phone_source_cannot_enqueue(self):
        await self.initialize()
        await self.sync(self.session(ended=False))
        pair = await self.api('POST', '/device/pair', {'sessionId': 'session-1'}, headers=self.dh)
        await self.api('POST', '/pair', {'code': pair['code']})
        data = await self.api('GET', '/pairs/' + pair['pairId'])
        self.assertFalse(data['connected'])
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', self.command(pair), 409)

    async def test_relay_poll_limits_and_duplicate_receipt_conflicts(self):
        pair, state, snapshot = await self.active_pair()
        await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state, 'receipts': []}, 429, self.dh)
        await self.api('GET', '/pairs/' + pair['pairId'])
        await self.api('GET', '/pairs/' + pair['pairId'], status=429)
        path = '/pairs/' + pair['pairId'] + '/commands'
        await self.api('POST', path, self.command(pair))
        body = {'sessionId': 'session-1', 'state': state, 'receipts': [{'id': 'command-1', 'error': '写盘失败'}]}
        tick = service.now_ms()
        for advance in (1000, 2000):
            with patch.object(service, 'now_ms', return_value=tick + advance):
                await self.api('POST', '/device/relay', body, headers=self.dh)
        journal = self.journal([{'action': 'start_round', 'command': self.command(pair)}], base=snapshot['session'])
        result = journal['receipts']['command-1']['result']
        result['state']['className'] = state['className']
        body.update(state=result['state'], receipts=[{'id': 'command-1', 'result': result}])
        with patch.object(service, 'now_ms', return_value=tick + 3000):
            await self.api('POST', '/device/relay', body, 409, self.dh)
        with patch.object(service, 'now_ms', return_value=tick + 4000):
            data = await self.api('GET', path + '/command-1')
        self.assertEqual(data, {'status': 'rejected', 'error': '写盘失败', 'code': 'invalid_command'})

    async def test_relay_same_seq_cannot_overwrite_state_and_old_generation_rejects_pending(self):
        pair, state, _ = await self.active_pair()
        path = '/pairs/' + pair['pairId'] + '/commands'
        await self.api('POST', path, self.command(pair))
        tick = service.now_ms()
        with patch.object(service, 'now_ms', return_value=tick + 1000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': {**state, 'received': 0}, 'receipts': []}, 409, self.dh)
        with patch.object(service, 'now_ms', return_value=tick + 2000):
            data = await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': {**state, 'seq': 7, 'generation': 6}, 'receipts': []}, headers=self.dh)
        self.assertEqual(data['commands'], [])
        self.assertEqual((await self.api('GET', path + '/command-1'))['status'], 'rejected')

    async def test_session_and_picture_scopes_survive_publication_withdrawal(self):
        await self.initialize()
        image = await self.api('POST', '/images', {'dataUrl': 'data:image/png;base64,' + base64.b64encode(PNG).decode()})
        q = await self.new_question(imageId=image['id'])
        deck = await self.api('POST', '/decks', {'title': '历史图片', 'questionIds': [q['id']]})
        pub = await self.api('POST', '/decks/' + deck['id'] + '/publish', {'revision': 1, 'classId': self.cid})
        body = self.session(bank=q)
        await self.sync(body)
        await self.api('DELETE', '/publications/' + pub['id'])
        self.assertEqual(await self.api('GET', '/images/' + image['id'], headers=self.dh), PNG)
        _, other = await self.account('outside-reader', teaching=[await self.other_class()])
        await self.api('GET', '/images/' + image['id'], status=403, headers=other)
        await self.api('GET', '/sessions/session-1', status=403, headers=other)
        await self.api('PUT', '/sessions/session-1', {'revision': 1, 'questions': []}, 403, other)

    async def test_sqlite_reopen_keeps_raw_upload_reviews_and_event_deduplication(self):
        from contextlib import closing
        import sqlite3
        from pathlib import Path
        await self.initialize()
        body = self.session()
        await self.sync(body)
        await self.api('PUT', '/sessions/session-1', {'revision': 1, 'questions': [{'id': 'q1', 'answer': 'B'}]})
        with closing(sqlite3.connect(Path(self.temp.name) / 'test.db')) as connection:
            raw, value, seq, version = connection.execute(
                'SELECT raw_value,value,seq,revision FROM card_quiz_sessions WHERE id=?', ('session-1',)).fetchone()
            self.assertEqual((seq, version), (6, 2))
            self.assertEqual(json.loads(raw)['questions'][0]['answer'], 'A')
            self.assertEqual(json.loads(value)['questions'][0]['answer'], 'B')
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM card_quiz_events').fetchone()[0], 6)
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM card_quiz_reviews').fetchone()[0], 1)
        await self.sync(body)

    async def test_card_static_entries_allow_same_origin_assets_camera_workers_and_embedding(self):
        from pathlib import Path
        root = Path(self.temp.name) / 'static-fixture'
        folder = root / 'card-quiz'
        folder.mkdir(parents=True)
        for page in ('phone', 'classroom'):
            (folder / (page + '.html')).write_text('<html><script nonce="__CSP_NONCE__"></script></html>', encoding='utf-8')
        with patch.object(service, 'WEB_ROOT', root):
            for page in ('phone', 'classroom'):
                response = await self.client.get('/card-quiz/' + page + '/')
                self.assertEqual(response.status, 200)
                policy = response.headers['Content-Security-Policy']
                self.assertIn("script-src 'self'", policy)
                self.assertIn("style-src 'self'", policy)
                self.assertIn("worker-src 'self' blob:", policy)
                self.assertIn("frame-ancestors 'self'", policy)
                self.assertNotIn('__CSP_NONCE__', await response.text())

    async def test_generated_pair_link_and_card_aliases_redirect_with_query_preserved(self):
        await self.initialize()
        await self.sync(self.session(ended=False))
        pair = await self.api('POST', '/device/pair', {'sessionId': 'session-1'}, headers=self.dh)
        link = urlsplit(pair['url'])
        paths = [(link.path, link.query, '/card-quiz/phone.html'),
                 ('/card-quiz/phone', 'code=ABC123', '/card-quiz/phone.html'),
                 ('/card-quiz/classroom/', 'review=1', '/card-quiz/classroom.html'),
                 ('/card-quiz', 'source=teacher', '/card-quiz/index.html'),
                 ('/card-quiz/', 'source=teacher', '/card-quiz/index.html')]
        for path, query, target in paths:
            with self.subTest(path=path):
                response = await self.client.get(path + '?' + query, allow_redirects=False)
                self.assertEqual(response.status, 302)
                self.assertEqual(response.headers['Location'], target + '?' + query)
                page = await self.client.get(path + '?' + query)
                self.assertEqual(page.status, 200)
                self.assertEqual(page.url.path, target)
                self.assertEqual(page.url.query_string, query)

    async def test_extended_events_are_preserved_and_retries_check_their_metadata(self):
        await self.initialize()
        body = self.session()
        await self.sync(body)
        stored = json.loads(self.db.one('SELECT value FROM card_quiz_events WHERE session_id=? AND seq=3', ('session-1',))['value'])
        self.assertEqual((stored['questionId'], stored['roundId'], stored['generation'], stored['sourceId']),
                         ('q1', 'round-1', 3, 'board'))
        body['events'][2]['sourceId'] = 'other-source'
        await self.sync(body, 409)

    async def test_recovery_after_unsynced_add_and_start_uses_all_generation_fences(self):
        await self.initialize()
        empty = self.batch(self.journal())
        await self.sync(empty)
        body = self.session(ended=False)
        recovered = self.advance(body, 'recover', questionId=None, roundId=None)
        recovered['events'] = body['events'] + recovered['events']
        recovered['fromSeq'] = 1
        body = recovered
        await self.sync(body)
        await self.sync(body)

    async def test_empty_classroom_state_from_shared_model_can_be_relayed(self):
        await self.initialize()
        body = self.batch(self.journal())
        await self.sync(body)
        state = {'sessionId': 'session-1', 'className': '高一（1）班', 'subjectId': 'math', 'questionId': None,
                 'questionNumber': 0, 'questionType': None, 'optionCount': 4, 'roundId': None,
                 'roundStatus': None, 'source': 'board', 'sourceId': 'board', 'generation': 1,
                 'seq': 0, 'received': 0, 'expected': 4, 'ended': False}
        self.assertEqual(await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state, 'receipts': []}, headers=self.dh), {'commands': [], 'pairings': []})

    async def test_banban_can_execute_the_registered_question_update_handler(self):
        saved = await self.new_question()
        response = await self.client.post('/api/banban/operations', json={'kind': 'platform', 'args': {
            'operation': 'card-quiz.question.save', 'payload': {'id': saved['id'], 'revision': 1,
                                                            'value': question(text='能力处理器修改')}}}, headers=self.admin)
        self.assertEqual(response.status, 200, await response.text())
        operation = await response.json()
        response = await self.client.post('/api/banban/operations/' + operation['id'] + '/confirm',
                                          json={'confirmed': True}, headers=self.admin)
        self.assertEqual(response.status, 200, await response.text())
        response = await self.client.get('/api/banban/operations/' + operation['id'], headers=self.admin)
        self.assertEqual((await response.json())['status'], 'succeeded')
        self.assertEqual((await self.api('GET', '/questions'))['questions'][0]['text'], '能力处理器修改')

    async def test_command_id_cannot_be_reused_by_another_pair_in_same_session(self):
        pair, state, _ = await self.active_pair()
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', self.command(pair))
        replacement = await self.api('POST', '/device/pair', {'sessionId': 'session-1'}, headers=self.dh)
        await self.api('POST', '/pair', {'code': replacement['code']})
        state.update(sourceId=replacement['pairId'], generation=6, seq=7)
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 1000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state, 'receipts': []}, headers=self.dh)
        await self.api('POST', '/pairs/' + replacement['pairId'] + '/commands', self.command(replacement, generation=6), 409)

    async def test_stopping_a_round_rejects_undelivered_answer_commands(self):
        pair, state, _ = await self.active_pair()
        state.update(roundStatus='collecting', roundId='phone-round', seq=7)
        tick = service.now_ms()
        with patch.object(service, 'now_ms', return_value=tick + 1000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state, 'receipts': []}, headers=self.dh)
        command = self.command(pair, action='answer', roundId='phone-round', payload={'cardNumber': 1, 'option': 'A'})
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', command)
        state.update(roundStatus='closed', seq=8)
        with patch.object(service, 'now_ms', return_value=tick + 2000):
            data = await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state, 'receipts': []}, headers=self.dh)
        self.assertEqual(data['commands'], [])
        self.assertEqual((await self.api('GET', '/pairs/' + pair['pairId'] + '/commands/command-1'))['status'], 'rejected')

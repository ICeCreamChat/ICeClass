"""Student identity, credentials and personal reports through real HTTP and SQLite."""
import asyncio
import json
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

import app as service
from homework import defaults
from teacher_capabilities import actions, reads, undeclared_routes
from test_card_quiz import CardQuizHttpCase, PNG, STAMP, question
from test_card_quiz_multiple import MultipleFixture
from student_accounts import StudentAccounts
from management import Management


class StudentAccountsTests(CardQuizHttpCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.initialize()
        self.path = f'/classes/{self.cid}/students'

    async def state(self, cid=None, headers=None):
        return await self.api('GET', f'/classes/{cid or self.cid}/students', headers=headers)

    @staticmethod
    def versions(state):
        return {key: state[key] for key in ('revision', 'rosterRevision', 'cardRevision')}

    async def generate(self, *, cid=None, code='101', state=None, **changes):
        current = state or await self.state(cid)
        return await self.api('POST', f'/classes/{cid or self.cid}/students', {
            **self.versions(current), 'entryYear': 2026, 'classCode': code, **changes})

    async def student(self, method, path, body=None, *, headers=None, status=200):
        response = await self.client.request(method, '/api/student' + path, json=body, headers=headers or {})
        self.assertEqual(response.status, status, await response.text())
        return response, await response.json()

    async def signin(self, credential):
        response, result = await self.student('POST', '/login', {
            'username': credential['username'], 'password': credential['password']})
        self.assertIn('HttpOnly', response.headers['Set-Cookie'])
        self.assertIn('SameSite=Strict', response.headers['Set-Cookie'])
        return {'Cookie': response.headers['Set-Cookie'].split(';', 1)[0],
                'X-CSRF-Token': result['student']['csrfToken']}

    async def test_generation_is_versioned_and_credentials_return_only_once(self):
        before = await self.state()
        self.assertEqual(before['classCode'], '101')
        self.assertTrue(before['canEdit'])
        self.assertEqual(before['revision'], 0)
        self.assertEqual(before['rosterRevision'], 1)
        self.assertEqual(before['cardRevision'], 1)
        created = await self.generate(code='109', state=before)
        self.assertEqual([c['username'] for c in created['credentials']],
                         ['2610901', '2610902', '2610903', '2610904'])
        self.assertTrue(all(len(c['password']) == 6 and c['password'].isascii()
                            and c['password'].isdigit() for c in created['credentials']))
        reread = await self.state()
        self.assertNotIn('credentials', reread)
        self.assertNotIn('password', json.dumps(reread))
        again = await self.generate(code='109', state=reread)
        self.assertEqual(again['credentials'], [])
        self.assertEqual(again['revision'], created['revision'])
        await self.api('POST', self.path, {**self.versions(before), 'entryYear': 2026, 'classCode': '109'}, 409)
        for credential in created['credentials']:
            row = self.db.one('SELECT * FROM student_accounts WHERE username=?', (credential['username'],))
            self.assertNotIn(credential['password'], row.values())
            self.assertTrue(service.verify_password(credential['password'], row['password_hash']))
        await self.signin(created['credentials'][0])

    async def test_student_login_is_separate_and_card_requires_current_password(self):
        credential = (await self.generate())['credentials'][0]
        auth = await self.signin(credential)
        _, own = await self.student('GET', '/session', headers=auth)
        self.assertTrue(own['authenticated'])
        self.assertEqual(own['student']['username'], credential['username'])
        self.assertNotIn('name', own['student'])
        response = await self.client.get('/api/classes', headers=auth)
        self.assertEqual(response.status, 401)
        await self.api('GET', f'/classes/{self.cid}/cards', status=401, headers=auth)
        _, teacher = await self.student('GET', '/session', headers=self.admin)
        self.assertFalse(teacher['authenticated'])
        await self.student('POST', '/card', {'password': credential['password']}, headers=auth)
        await self.student('POST', '/card', {'password': 'wrong'}, headers=auth, status=401)
        await self.student('POST', '/card', {'password': credential['password']},
                           headers={'Cookie': auth['Cookie']}, status=403)
        await self.student('GET', '/report', headers=self.admin, status=401)

    async def test_new_routes_declare_live_teacher_capabilities(self):
        self.assertEqual(undeclared_routes(self.app), [])
        self.assertIn('student.accounts', reads(self.app))
        for key in ('student.accounts.create', 'student.accounts.reset', 'student.accounts.link'):
            self.assertIn(key, actions(self.app))
        self.assertEqual(actions(self.app)['student.accounts.create'].workflow, 'private-result')
        self.assertEqual(actions(self.app)['student.accounts.reset'].workflow, 'private-result')

    async def number_cards(self, first=1, last=2, *, reset=False, state=None, headers=None, status=200):
        versions = self.versions(state or await self.state())
        return await self.api('POST', self.path + '/number-cards' + ('/reset' if reset else ''),
                              {**versions, 'firstNumber': first, 'lastNumber': last}, status, headers)

    async def test_number_cards_issue_reuse_reset_and_isolate_named_accounts(self):
        before = await self.state()
        await self.number_cards(first=0, status=400)
        _, staff = await self.account('number-readonly', teaching=[self.cid])
        await self.number_cards(headers=staff, status=403)
        await self.number_cards(headers=self.dh, status=401)
        with patch('student_accounts.today', return_value='2026-11-25'):
            issued = await self.number_cards(state=before)
        first, second = issued['credentials']
        self.assertTrue(all(c['numberCard'] for c in (first, second)))
        self.assertEqual([c['cardNumber'] for c in (first, second)], [1, 2])
        self.assertEqual(first['username'], '26110101')
        self.assertEqual((await self.state())['students'], before['students'])
        self.assertEqual([c['username'] for c in (await self.state(headers=staff))['numberCards']], [None, None])
        self.assertEqual((await self.number_cards())['credentials'], [])
        await self.number_cards(state=before, status=409)
        with patch('student_accounts.today', return_value='2027-11-25'):
            extra = (await self.number_cards(2, 3))['credentials']
        self.assertEqual([c['username'] for c in extra], ['26110103'])
        old, other = await self.signin(first), await self.signin(second)
        _, own = await self.student('POST', '/card', {'password': first['password']}, headers=old)
        self.assertEqual(own['card'], first)
        await self.student('PUT', '/password', {'currentPassword': first['password'], 'newPassword': '987654'},
                           headers=old, status=403)
        await self.api('POST', self.path + '/link', {**self.versions(await self.state()),
                       'studentId': 's1', 'username': first['username']}, 404)
        replacement = (await self.number_cards(1, 1, reset=True))['credentials'][0]
        self.assertEqual(replacement['username'], first['username'])
        self.assertNotEqual(replacement['password'], first['password'])
        await self.student('GET', '/report', headers=old, status=401)
        await self.signin(replacement)
        await self.student('GET', '/report', headers=other)
        self.assertNotIn('password', json.dumps(await self.state()))

    async def restart_accounts_service(self):
        await self.client.close()
        root = Path(self.temp.name)
        self.app = service.create_app(root / 'test.db', root / 'receiver_release')
        self.db = self.app[service.STORE_KEY]
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()

    def legacy_number_card(self, number, username, *, issued_at='2026-09-01T08:00:00+08:00', cid=None):
        aid = f'legacy-{number}'
        password = f'{100000 + number:06d}'
        timestamp = int(datetime.fromisoformat(issued_at).timestamp() * 1000)
        self.db.run('''INSERT INTO student_accounts
            (id,username,password_hash,class_id,student_id,holder_card_number,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?)''',
                    (aid, username, service.hash_password(password), cid or self.cid, f'holder-{number}',
                     number, timestamp, timestamp))
        return {'accountId': aid, 'username': username, 'password': password}

    def historical_student_session(self, aid):
        token, csrf = service.random_token(), service.random_token()
        now = service.now_ms()
        self.db.run('''INSERT INTO student_sessions(token_hash,account_id,csrf_token,expires_at,created_at)
            VALUES(?,?,?,?,?)''', (service.sha256(token), aid, csrf, now + 86_400_000, now))
        return {'Cookie': 'iceclass_student_session=' + token, 'X-CSRF-Token': csrf}

    async def assert_invalid_login(self, username, credential):
        response = await self.client.post('/api/student/login', json={
            'username': username, 'password': credential['password']})
        self.assertEqual(response.status, 401, username)
        self.assertEqual((await response.json())['code'], 'invalid_credentials')
        self.assertNotIn('Set-Cookie', response.headers)

    async def test_both_printed_aliases_retired_for_all_sixty_cards(self):
        self.db.run('UPDATE classes SET name=? WHERE id=?', ('高一（9）班', self.cid))
        with patch('student_accounts.today', return_value='2026-11-25'):
            issued = await self.number_cards(1, 60)
        cards = issued['credentials']
        self.assertEqual(len(cards), 60)
        self.db.run("""CREATE TABLE IF NOT EXISTS student_card_login_aliases (
            username TEXT PRIMARY KEY CHECK(username GLOB '[0-9][0-9]0[0-9][0-9][0-9][0-9][0-9]'),
            account_id TEXT NOT NULL REFERENCES student_accounts(id) ON DELETE CASCADE)""")
        with self.db.transaction():
            for card in cards:
                for prefix in ('01009', '26009'):
                    self.db.run('INSERT INTO student_card_login_aliases VALUES(?,?)',
                                (f'{prefix}{card["cardNumber"]:03d}', card['accountId']))
        mixed = self.historical_student_session(cards[0]['accountId'])
        current = await self.signin(cards[-1])
        accounts = self.db.all('SELECT * FROM student_accounts ORDER BY id')
        await self.restart_accounts_service()
        self.assertTrue(self.db.all('SELECT * FROM student_accounts ORDER BY id') == accounts)
        self.assertIsNone(self.db.one("SELECT 1 FROM sqlite_master WHERE name='student_card_login_aliases'"))
        state = await self.state()
        self.assertEqual(state['revision'], issued['revision'])
        self.assertEqual([(row['cardNumber'], row['username']) for row in state['numberCards']],
                         [(n, f'261109{n:02d}') for n in range(1, 61)])
        self.assertNotIn('password', json.dumps(state))
        for session in (mixed, current):
            _, result = await self.student('GET', '/session', headers=session)
            self.assertTrue(result['authenticated'])
        for n, card in enumerate(cards, 1):
            self.assertEqual(card['username'], f'261109{n:02d}')
            for prefix in ('01009', '26009'):
                await self.assert_invalid_login(f'{prefix}{n:03d}', card)
            session = await self.signin(card)
            _, result = await self.student('GET', '/session', headers=session)
            self.assertEqual(result['student']['id'], card['accountId'])
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM student_sessions')['n'], 62)
        replacement = (await self.number_cards(1, 1, reset=True))['credentials'][0]
        self.assertEqual((replacement['username'], replacement['accountId']), ('26110901', cards[0]['accountId']))
        for alias in ('01009001', '26009001'):
            await self.assert_invalid_login(alias, replacement)
        await self.assert_invalid_login(replacement['username'], cards[0])
        await self.signin(replacement)
        await self.student('GET', '/report', headers=mixed, status=401)
        await self.student('GET', '/report', headers=current)

    async def test_old_primary_migrates_on_startup_with_password_report_and_history_intact(self):
        self.db.run('UPDATE classes SET name=? WHERE id=?', ('高一（9）班', self.cid))
        named = (await self.generate(code='109'))['credentials'][0]
        personal = await self.signin(named)
        old = self.legacy_number_card(1, '01009001')
        last = self.legacy_number_card(157, '26009157')
        old_session = self.historical_student_session(old['accountId'])
        identity = '''SELECT id,password_hash,class_id,student_id,holder_card_number,created_at,enabled
            FROM student_accounts ORDER BY id'''
        before = self.db.all(identity)
        ops = [{'action': 'add_question', 'payload': question()}, {'action': 'start_round'},
               {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'A'}}, {'action': 'end_session'}]
        for i in range(2):
            await self.sync(self.batch(self.journal(ops, sid=f'holder-lesson-{i}', card_mode='scanned',
                                                    started=STAMP + 20000 * i)))
        history = self.db.all('SELECT * FROM card_quiz_sessions ORDER BY id')
        events = self.db.all('SELECT * FROM card_quiz_events ORDER BY session_id,seq')
        revision = (await self.state())['revision']
        with patch('student_accounts.today', return_value='2026-11-25'):
            await self.restart_accounts_service()
        self.assertTrue(self.db.all(identity) == before)
        self.assertEqual(self.db.all('SELECT * FROM card_quiz_sessions ORDER BY id'), history)
        self.assertEqual(self.db.all('SELECT * FROM card_quiz_events ORDER BY session_id,seq'), events)
        await self.student('GET', '/report', headers=old_session, status=401)
        _, named_state = await self.student('GET', '/session', headers=personal)
        self.assertEqual(named_state['student']['username'], named['username'])
        await self.signin(named)
        for card, number in ((old, 1), (last, 157)):
            for prefix in ('01009', '26009'):
                await self.assert_invalid_login(f'{prefix}{number:03d}', card)
            username = f'261109{number:02d}'
            session = await self.signin(dict(card, username=username))
            _, info = await self.student('POST', '/card', {'password': card['password']}, headers=session)
            self.assertEqual((info['card']['accountId'], info['card']['username']), (card['accountId'], username))
            if number == 1:
                _, report = await self.student('GET', '/report', headers=session)
                self.assertEqual(report['accountId'], old['accountId'])
                self.assertEqual([(r['sessionId'], r['status']) for r in report['records']],
                                 [('holder-lesson-1', 'correct')])
        migrated = self.db.all('SELECT * FROM student_accounts ORDER BY id')
        self.assertEqual((await self.state())['revision'], revision + 1)
        with patch('student_accounts.today', return_value='2028-11-25'):
            await self.restart_accounts_service()
            repeat = await self.number_cards(1, 1)
        self.assertEqual((repeat['credentials'], repeat['revision']), ([], revision + 1))
        self.assertEqual([c['username'] for c in repeat['numberCards']], ['26110901', '261109157'])
        self.assertTrue(self.db.all('SELECT * FROM student_accounts ORDER BY id') == migrated)
        self.assertEqual(self.db.all('PRAGMA foreign_key_check'), [])

    async def test_overlapping_issue_migrates_existing_card_and_only_creates_missing_card(self):
        self.db.run('UPDATE classes SET name=? WHERE id=?', ('高二（9）班', self.cid))
        old = self.legacy_number_card(1, '02009001', issued_at='2028-01-15T08:00:00+08:00')
        original = self.db.one('SELECT password_hash FROM student_accounts WHERE id=?', (old['accountId'],))
        await self.assert_invalid_login(old['username'], old)
        with patch('student_accounts.today', return_value='2029-11-25'):
            issued = await self.number_cards(1, 2)
        self.assertEqual([c['username'] for c in issued['credentials']], ['26120902'])
        self.assertEqual([c['username'] for c in issued['numberCards']], ['26120901', '26120902'])
        self.assertEqual(issued['numberCards'][0]['accountId'], old['accountId'])
        self.assertTrue(self.db.one('SELECT password_hash FROM student_accounts WHERE id=?', (old['accountId'],)) == original)
        await self.signin(dict(old, username='26120901'))
        await self.assert_invalid_login(old['username'], old)
        await self.signin(issued['credentials'][0])

    async def test_legacy_only_class_keeps_first_school_year_across_migration_and_reissue(self):
        self.db.run('UPDATE classes SET name=? WHERE id=?', ('高一（9）班', self.cid))
        later = self.legacy_number_card(1, '01009001', issued_at='2027-10-12T08:00:00+08:00')
        first = self.legacy_number_card(3, '01009003', issued_at='2026-08-01T00:01:00+08:00')
        self.db.run('UPDATE student_accounts SET updated_at=(SELECT MAX(created_at) FROM student_accounts)')
        identity = 'SELECT id,student_id,password_hash,created_at FROM student_accounts ORDER BY id'
        original = self.db.all(identity)
        with patch('student_accounts.today', return_value='2028-11-25'):
            await self.restart_accounts_service()
            migrated = await self.state()
        self.assertEqual([(r['accountId'], r['username']) for r in migrated['numberCards']],
                         [(later['accountId'], '26110901'), (first['accountId'], '26110903')])
        self.assertTrue(self.db.all(identity) == original)
        for card, username in ((later, '26110901'), (first, '26110903')):
            await self.assert_invalid_login(card['username'], card)
            await self.signin(dict(card, username=username))
        with patch('student_accounts.today', return_value='2029-11-25'):
            issued = await self.number_cards(1, 3)
            self.assertEqual([c['username'] for c in issued['credentials']], ['26110902'])
            snapshot = self.db.all('SELECT * FROM student_accounts ORDER BY id')
            await self.restart_accounts_service()
            repeated = await self.number_cards(1, 3)
        self.assertEqual((repeated['credentials'], repeated['revision']), ([], issued['revision']))
        self.assertTrue(self.db.all('SELECT * FROM student_accounts ORDER BY id') == snapshot)

    async def test_old_cards_use_grade_and_class_number_at_issue_after_promotion(self):
        other = await self.other_class()
        first = self.legacy_number_card(1, '01001001')
        second = self.legacy_number_card(2, '02008002', cid=other)
        issued_at = self.db.one('SELECT created_at FROM student_accounts WHERE id=?', (first['accountId'],))['created_at']
        self.db.run("UPDATE audit_events SET created_at=? WHERE action='class.create'", (issued_at - 1,))
        response, _ = await self.json_request('POST', '/api/classes/rename-batch', {'changes': [
            {'id': self.cid, 'name': '高二（9）班'}]}, csrf=True)
        self.assertEqual(response.status, 200)
        response, _ = await self.json_request('PATCH', '/api/classes/' + other, {'name': '高三（7）班'}, csrf=True)
        self.assertEqual(response.status, 200)
        promoted_at = int(datetime.fromisoformat('2027-09-01T08:00:00+08:00').timestamp() * 1000)
        self.db.run("UPDATE audit_events SET created_at=? WHERE action IN ('class.rename','class.update')", (promoted_at,))
        with patch('student_accounts.today', return_value='2028-11-25'):
            await self.restart_accounts_service()
        for cid, card, username in ((self.cid, first, '26110101'), (other, second, '25120802')):
            current, = (await self.state(cid))['numberCards']
            self.assertEqual((current['accountId'], current['username']), (card['accountId'], username))
            await self.signin(dict(card, username=username))

    async def test_unusable_first_issue_time_defers_old_class_without_guessing_a_year(self):
        old = self.legacy_number_card(1, '01001001')
        self.db.run('UPDATE student_accounts SET created_at=0 WHERE id=?', (old['accountId'],))
        original = self.db.one('SELECT * FROM student_accounts WHERE id=?', (old['accountId'],))
        with patch('student_accounts.today', return_value='2028-11-25'):
            with self.assertLogs('iceclass', 'WARNING'):
                await self.restart_accounts_service()
            await self.number_cards(1, 2, status=409)
        self.assertTrue(self.db.all('SELECT * FROM student_accounts') == [original])
        await self.assert_invalid_login(old['username'], old)

    async def test_migration_conflict_preserves_class_and_noop_issue_retries_with_existing_prefix(self):
        first = self.legacy_number_card(1, '01001001')
        second = self.legacy_number_card(2, '01001002')
        old_session = self.historical_student_session(first['accountId'])
        # 26 + 110 + 102 is a valid named student's eight-digit login.
        person = {'username': '26110102', 'password': '314159'}
        self.db.run('''INSERT INTO student_accounts(id,username,password_hash,class_id,student_id,created_at,updated_at)
            VALUES('person',?,?,?,'named',1,1)''', (person['username'], service.hash_password(person['password']), self.cid))
        original = self.db.all('SELECT * FROM student_accounts ORDER BY id')
        with patch('student_accounts.today', return_value='2026-11-25'):
            with self.assertLogs('iceclass', 'WARNING') as warnings:
                await self.restart_accounts_service()
            self.assertIn(self.cid, warnings.output[0])
            await self.number_cards(1, 2, status=409)
        self.assertTrue(self.db.all('SELECT * FROM student_accounts ORDER BY id') == original)
        self.assertEqual([c['username'] for c in (await self.state())['numberCards']], [None, None])
        await self.assert_invalid_login(first['username'], first)
        await self.assert_invalid_login(second['username'], second)
        await self.assert_invalid_login(person['username'], second)
        await self.signin(person)
        await self.student('GET', '/report', headers=old_session, status=401)
        # A previously issued canonical card fixes the class prefix even after a rename or across years.
        self.db.run("""INSERT INTO student_accounts
            (id,username,password_hash,class_id,student_id,holder_card_number,created_at,updated_at)
            VALUES('issued','25110903',?,?,'holder-3',3,1,1)""", (service.hash_password('271828'), self.cid))
        with patch('student_accounts.today', return_value='2029-11-25'):
            repeat = await self.number_cards(1, 2)
        self.assertEqual(repeat['credentials'], [])
        self.assertEqual(repeat['revision'], 1)
        for n, card in enumerate((first, second), 1):
            await self.signin(dict(card, username=f'251109{n:02d}'))
            await self.assert_invalid_login(card['username'], card)
        await self.student('GET', '/report', headers=old_session, status=401)
        await self.signin(person)

    async def test_year_prefix_owned_by_another_class_is_not_assigned(self):
        self.db.run("INSERT INTO classes(id,name,enabled,created_at,updated_at) VALUES('other-class','旧班',1,1,1)")
        self.db.run('''INSERT INTO student_accounts
            (id,username,password_hash,class_id,student_id,holder_card_number,created_at,updated_at)
            VALUES('other-card','26110101',?,'other-class','other-holder',1,1,1)''', (service.hash_password('136042'),))
        with patch('student_accounts.today', return_value='2026-11-25'):
            await self.number_cards(status=409)
        self.assertIsNone(self.db.one('SELECT id FROM student_accounts WHERE class_id=?', (self.cid,)))
        auth = await self.signin({'username':'26110101', 'password':'136042'})
        _, result = await self.student('GET', '/session', headers=auth)
        self.assertEqual(result['student']['classId'], 'other-class')

    async def test_number_card_class_nine_prefix_and_three_digit_cards(self):
        self.db.run('UPDATE classes SET name=? WHERE id=?', ('高一（9）班', self.cid))
        with patch('student_accounts.today', return_value='2026-11-25'):
            first = (await self.number_cards(1, 1))['credentials'][0]
        self.assertEqual(first['username'], '26110901')
        for n in (60, 99, 100, 157):
            card = (await self.number_cards(n, n))['credentials'][0]
            self.assertEqual(card['username'], f'261109{n:02d}')
            await self.signin(card)

    async def test_number_card_does_not_replace_a_named_student_with_the_same_digits(self):
        self.db.run('''INSERT INTO student_accounts
            (id,username,password_hash,class_id,student_id,created_at,updated_at)
            VALUES('person','26110102',?,?,'named',1,1)''', (service.hash_password('315990'), self.cid))
        with patch('student_accounts.today', return_value='2026-11-25'):
            await self.number_cards(1, 2, status=409)
        self.assertIsNone(self.db.one('SELECT 1 FROM student_accounts WHERE holder_card_number IS NOT NULL'))
        await self.signin({'username':'26110102', 'password':'315990'})

    async def test_number_card_only_its_latest_class_lesson_with_no_history_fallback(self):
        issue = await self.number_cards()
        one, two = [await self.signin(c) for c in issue['credentials']]
        named = await self.signin((await self.generate())['credentials'][0])
        def op(action, **payload):
            return {'action': action, 'payload': payload}
        seen = [op('add_question', **question()), op('start_round'), op('answer', cardNumber=1, option='A'),
                op('end_round'), op('add_question', **question(answer='B')), op('start_round'),
                op('answer', cardNumber=2, option='A'), op('end_session')]
        lesson = self.journal(seen, sid='scanned-first', card_mode='scanned')
        await self.sync(self.batch(lesson))
        _, result = await self.student('GET', '/report?classId=other&studentId=s1&cardNumber=1', headers=two)
        self.assertEqual([(r['questionNumber'], r['status']) for r in result['records']], [(2, 'wrong')])
        self.assertEqual((result['totals']['wrong'], result['totals']['abstained']), (1, 0))
        personal = self.journal(seen, sid='named-next', started=STAMP+20000)
        await self.sync(self.batch(personal))
        _, result = await self.student('GET', '/report', headers=one)
        self.assertEqual([s['id'] for s in result['sessions']], ['scanned-first'])
        self.assertEqual((result['totals']['correct'], result['totals']['abstained']), (1, 1))
        _, result = await self.student('GET', '/report', headers=named)
        self.assertEqual([s['id'] for s in result['sessions']], ['named-next'])
        later = self.journal(seen[:3] + [op('end_session')], sid='scanned-latest', started=STAMP+40000, card_mode='scanned')
        await self.sync(self.batch(later))
        for query in ('', '?subjectId=math', '?sessionId=scanned-first'):
            _, result = await self.student('GET', '/report'+query, headers=two)
            self.assertEqual((result['sessions'], result['records']), ([], []))
        _, result = await self.student('GET', '/report?subjectId=english', headers=one)
        self.assertEqual(result['sessions'], [])
        self.assertEqual(len((await self.api('GET', '/sessions/scanned-first'))['session']['roster']), 2)

    async def reset(self, ids, *, state=None, cid=None, status=200, headers=None):
        current = state or await self.state(cid, headers)
        return await self.api('POST', f'/classes/{cid or self.cid}/students/reset',
                              {**self.versions(current), 'studentIds': ids}, status, headers)

    async def profile(self, cid, students):
        row = self.db.one('SELECT revision FROM homework_profiles WHERE class_id=?', (cid,))
        value = defaults()
        value['students'] = students
        response = await self.client.put(f'/api/homework/classes/{cid}/profile',
                                         json={'revision': row['revision'] if row else 0, 'value': value}, headers=self.admin)
        self.assertEqual(response.status, 200, await response.text())

    async def link(self, cid, sid, username, *, headers=None, status=200):
        state = await self.state(cid, headers)
        return await self.api('POST', f'/classes/{cid}/students/link',
                              {**self.versions(state), 'studentId': sid, 'username': username}, status, headers)

    async def test_reset_invalidates_old_password_and_all_sessions_but_only_selected_students(self):
        created = await self.generate()
        first, second = created['credentials'][:2]
        auth, other = await self.signin(first), await self.signin(second)
        another_session = await self.signin(first)
        reset = await self.reset(['s1'], state=created)
        self.assertEqual(len(reset['credentials']), 1)
        self.assertNotEqual(reset['credentials'][0]['password'], first['password'])
        for old in (auth, another_session):
            await self.student('GET', '/report', headers=old, status=401)
        await self.student('POST', '/login', {'username': first['username'], 'password': first['password']}, status=401)
        await self.student('GET', '/report', headers=other)
        await self.signin(reset['credentials'][0])
        await self.reset(['s2'], state=created, status=409)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM student_sessions')['n'], 2)

    async def test_student_change_password_preserves_leading_zero_and_requires_relogin(self):
        credential = (await self.generate())['credentials'][0]
        auth = await self.signin(credential)
        current_state = await self.state()
        for value in ('12345', '1234567', '１２３４５６', 123456, True, 'ab1234'):
            await self.student('PUT', '/password', {'currentPassword': credential['password'], 'newPassword': value},
                               headers=auth, status=400)
        await self.student('PUT', '/password', {'currentPassword': 'wrong', 'newPassword': '000042'}, headers=auth, status=401)
        await self.student('PUT', '/password', {'currentPassword': credential['password'], 'newPassword': '000042'}, headers=auth)
        await self.student('GET', '/report', headers=auth, status=401)
        await self.reset(['s1'], state=current_state, status=409)
        new_auth = await self.signin({**credential, 'password': '000042'})
        _, card = await self.student('POST', '/card', {'password': '000042'}, headers=new_auth)
        self.assertEqual(card['card']['password'], '000042')
        self.assertNotIn('name', card['card'])
        await self.student('POST', '/logout', headers=new_auth)
        await self.student('GET', '/report', headers=new_auth, status=401)

    async def test_password_generation_handles_leading_zero_and_avoids_reusing_old_password(self):
        with patch('student_accounts.secrets.randbelow', return_value=42):
            created = await self.generate()
            self.assertEqual(created['credentials'][0]['password'], '000042')
            reset = await self.reset(['s1'], state=created)
        self.assertEqual(reset['credentials'][0]['password'], '000043')
        await self.signin(reset['credentials'][0])

    async def test_teacher_scopes_device_auth_and_csrf_are_enforced(self):
        await self.generate()
        _, teacher = await self.account('readonly-teacher', teaching=[self.cid])
        _, head = await self.account('class-head', head=[self.cid])
        readonly = await self.state(headers=teacher)
        self.assertFalse(readonly['canEdit'])
        await self.reset(['s1'], state=readonly, headers=teacher, status=403)
        await self.reset(['s1'], headers=head)
        current = await self.state()
        await self.api('POST', self.path, {**self.versions(current), 'entryYear': 2026, 'classCode': '101'},
                       403, {'Cookie': self.admin['Cookie']})
        await self.api('GET', self.path, status=401, headers=self.dh)
        await self.api('POST', self.path + '/reset', {**self.versions(current), 'studentIds': ['s1']}, 401, self.dh)
        other = await self.other_class()
        await self.api('GET', f'/classes/{other}/students', status=403, headers=head)

    async def test_generation_rolls_back_entire_batch_on_username_collision(self):
        await self.generate(code='101')
        other = await self.other_class()
        await self.profile(other, [{'id': 'other1', 'name': '另一学生一'}, {'id': 'other2', 'name': '另一学生二'}])
        await self.api('PUT', f'/classes/{other}/cards', {'revision': 0, 'bindings': [
            {'studentId': 'other1', 'cardNumber': 5}, {'studentId': 'other2', 'cardNumber': 1}]})
        current = await self.state(other)
        await self.api('POST', f'/classes/{other}/students',
                       {**self.versions(current), 'entryYear': 2026, 'classCode': '101'}, 409)
        self.assertIsNone(self.db.one('SELECT 1 FROM student_accounts WHERE username=?', ('2610105',)))
        self.assertEqual((await self.state(other))['revision'], 0)
        self.assertTrue(all(s['accountId'] is None for s in (await self.state(other))['students']))

    async def test_generation_validates_all_versions_year_code_and_three_digit_cards(self):
        before = await self.state()
        for key in ('revision', 'rosterRevision', 'cardRevision'):
            await self.api('POST', self.path, {**self.versions(before), key: 99, 'entryYear': 2026, 'classCode': '101'}, 409)
        for year, code in ((True, '101'), (26, '101'), (2100, '101'), (2026, '1'), (2026, 101), (2026, '１００'), (2026, '100')):
            await self.api('POST', self.path, {**self.versions(before), 'entryYear': year, 'classCode': code}, 400)
        await self.api('PUT', f'/classes/{self.cid}/cards', {'revision': 1, 'bindings': [
            {'studentId': 's1', 'cardNumber': 100}, {'studentId': 's2', 'cardNumber': 157}]})
        created = await self.generate()
        self.assertEqual([s['username'] for s in created['credentials'][:2]], ['26101100', '26101157'])
        await self.signin(created['credentials'][0])
        await self.api('PUT', f'/classes/{self.cid}/cards', {'revision': 2, 'bindings': [
            {'studentId': 's1', 'cardNumber': 99}]})
        changed = await self.state()
        self.assertEqual(changed['students'][0]['username'], '26101100')
        await self.reset(['s1'], state=created, status=409)

    async def test_reused_card_does_not_inherit_departed_student_account_or_history(self):
        created = await self.generate()
        first = created['credentials'][0]
        await self.profile(self.cid, [*self.students[1:], {'id': 'new-student', 'name': '新同学'}])
        await self.api('PUT', f'/classes/{self.cid}/cards', {'revision': 1, 'bindings': [
            {'studentId': 'new-student', 'cardNumber': 1}]})
        current = await self.state()
        self.assertIsNone(current['students'][-1]['accountId'])
        await self.api('POST', self.path, {**self.versions(current), 'entryYear': 2026, 'classCode': '101'}, 409)
        self.assertEqual(self.db.one('SELECT id FROM student_accounts WHERE username=?', (first['username'],))['id'], first['accountId'])
        auth = await self.signin(first)
        await self.student('POST', '/card', {'password': first['password']}, headers=auth, status=409)

    async def test_same_roster_id_in_other_class_is_not_an_account_link(self):
        created = await self.generate()
        other = await self.other_class()
        await self.profile(other, [{'id': 's1', 'name': '不同的同学'}])
        await self.api('PUT', f'/classes/{other}/cards', {'revision': 0, 'initialize': True})
        generated = await self.generate(cid=other, code='208')
        self.assertNotEqual(generated['credentials'][0]['accountId'], created['credentials'][0]['accountId'])
        await self.link(other, 's1', created['credentials'][0]['username'], status=409)

    async def test_transfer_preserves_username_password_and_original_history_identity(self):
        created = await self.generate()
        credential = created['credentials'][0]
        auth = await self.signin(credential)
        await self.sync()
        other = await self.other_class()
        await self.profile(other, [{'id': 'moved', 'name': '转入同学'}])
        await self.api('PUT', f'/classes/{other}/cards', {'revision': 0, 'bindings': [{'studentId': 'moved', 'cardNumber': 9}]})
        transferred = await self.link(other, 'moved', credential['username'])
        self.assertEqual(transferred['students'][0]['username'], credential['username'])
        self.assertTrue(transferred['students'][0]['activeHere'])
        self.assertFalse((await self.state())['students'][0]['activeHere'])
        _, personal = await self.student('GET', '/report', headers=auth)
        self.assertEqual(personal['totals']['correct'], 1)
        self.assertEqual(personal['records'][0]['classId'], self.cid)
        _, card = await self.student('POST', '/card', {'password': credential['password']}, headers=auth)
        self.assertEqual(card['card']['classId'], other)
        self.assertEqual(card['card']['cardNumber'], 9)
        self.assertEqual(card['card']['username'], credential['username'])
        await self.reset(['s1'], state=created, status=409)
        await self.reset(['s1'], status=409)

    async def test_transfer_requires_management_access_to_source_and_destination(self):
        credential = (await self.generate())['credentials'][0]
        other = await self.other_class()
        await self.profile(other, [{'id': 'new-id', 'name': '转入同学'}])
        _, target_teacher = await self.account('destination-head', head=[other])
        await self.link(other, 'new-id', credential['username'], headers=target_teacher, status=403)
        self.assertIsNone((await self.state(other))['students'][0]['accountId'])

    async def test_manager_can_transfer_from_archived_class_without_changing_history(self):
        credential = (await self.generate())['credentials'][0]
        await self.sync()
        other = await self.other_class()
        await self.profile(other, [{'id': 'moved', 'name': '升班同学'}])
        self.db.run('UPDATE classes SET enabled=0 WHERE id=?', (self.cid,))
        await self.link(other, 'moved', credential['username'])
        auth = await self.signin(credential)
        _, report = await self.student('GET', '/report', headers=auth)
        self.assertEqual(report['totals']['correct'], 1)

    async def test_personal_reports_never_include_other_students_or_active_classrooms(self):
        created = await self.generate()
        auth = await self.signin(created['credentials'][0])
        other_auth = await self.signin(created['credentials'][1])
        await self.sync()
        await self.sync(self.session(sid='ongoing', ended=False))
        _, own = await self.student('GET', '/report?studentId=s2&classId=other&accountId=other', headers=auth)
        self.assertEqual(own['accountId'], created['credentials'][0]['accountId'])
        self.assertEqual(own['totals']['samples'], 1)
        self.assertEqual(own['totals']['correct'], 1)
        self.assertEqual(own['totals']['accuracy'], 1)
        self.assertEqual(len(own['records']), 1)
        self.assertEqual(own['records'][0]['option'], 'A')
        self.assertTrue(own['records'][0]['counted'])
        self.assertEqual(own['knowledge'][0]['samples'], 1)
        for text in ('测试学生2', 'studentName', 'deviceId', 'teacherId', 'ongoing', 's2'):
            self.assertNotIn(text, json.dumps(own, ensure_ascii=False))
        _, other = await self.student('GET', '/report', headers=other_auth)
        self.assertEqual(other['accountId'], created['credentials'][1]['accountId'])
        self.assertEqual(other['totals']['wrong'], 1)
        self.assertEqual(other['records'][0]['option'], 'B')
        _, filtered = await self.student('GET', '/report?subjectId=english', headers=auth)
        self.assertEqual(filtered['records'], [])
        self.assertIsNone(filtered['totals']['accuracy'])

    async def test_personal_report_updates_after_teacher_answer_revision(self):
        credential = (await self.generate())['credentials'][0]
        auth = await self.signin(credential)
        await self.sync()
        current = await self.api('GET', '/sessions/session-1')
        await self.api('PUT', '/sessions/session-1', {'revision': current['revision'], 'questions': [
            {'id': 'q1', 'text': '课后补录', 'answer': 'B', 'tags': ['新标签']}]})
        _, own = await self.student('GET', '/report', headers=auth)
        self.assertEqual(own['totals']['wrong'], 1)
        self.assertEqual(own['records'][0]['text'], '课后补录')
        self.assertEqual(own['knowledge'][0]['tag'], '新标签')

    async def test_login_and_password_reentry_share_bounded_failure_limit(self):
        credential = (await self.generate())['credentials'][0]
        auth = await self.signin(credential)
        for i in range(service.LOGIN_FAILURE_LIMIT):
            await self.student('POST', '/card', {'password': 'bad'}, headers=auth,
                               status=429 if i == service.LOGIN_FAILURE_LIMIT - 1 else 401)
        await self.student('POST', '/login', {'username': credential['username'], 'password': credential['password']}, status=429)

    async def test_concurrent_wrong_passwords_cannot_lose_failure_increments(self):
        credential = (await self.generate())['credentials'][0]
        responses = await asyncio.gather(*[
            self.client.post('/api/student/login', json={'username': credential['username'], 'password': '999999'
                if credential['password'] != '999999' else '999998'}) for _ in range(service.LOGIN_FAILURE_LIMIT)])
        statuses = [response.status for response in responses]
        for response in responses:
            await response.read()
        self.assertIn(429, statuses)
        await self.student('POST', '/login', {'username': credential['username'], 'password': credential['password']}, status=429)

    async def test_personal_report_keeps_sparse_combinations_and_abstentions(self):
        created = await self.generate()
        f = MultipleFixture(self.cid, self.device['deviceId']).start()
        f.r['noCardPolicy'] = f.events[-1]['noCardPolicy'] = 'abstain'
        f.answer(1, 'A').target('C').answer(1, 'A').end()
        await self.sync(f.body())
        for index, expected, samples in [(0, 'correct', 1), (1, 'abstained', 0)]:
            auth = await self.signin(created['credentials'][index])
            _, report = await self.student('GET', '/report', headers=auth)
            record, = report['records']
            self.assertEqual((record['status'], record['noCardPolicy']), (expected, 'abstain'))
            self.assertEqual((report['totals']['samples'], report['totals'][expected]), (samples, 1))
            if samples:
                self.assertEqual((record['option'], record['choices']), ('AC', {'A': True, 'C': True}))
            else:
                self.assertIsNone(report['totals']['accuracy'])

    async def test_personal_multiple_statuses_match_teacher_denominators(self):
        created = await self.generate()
        fixture = MultipleFixture(self.cid, self.device['deviceId']).results().end()
        await self.sync(fixture.body())
        for index, expected in enumerate(('correct', 'wrong', 'incomplete', 'unanswered')):
            with self.subTest(status=expected):
                auth = await self.signin(created['credentials'][index])
                _, own = await self.student('GET', '/report', headers=auth)
                self.assertEqual(own['records'][0]['status'], expected)
                self.assertEqual(own['totals'][expected], 1)
                self.assertEqual(own['totals']['samples'], 1 if index < 2 else 0)
                self.assertEqual(len(own['knowledge']), 1 if index < 2 else 0)
                self.assertEqual(own['records'][0].get('choices'),
                                 fixture.r['answers'].get('s' + str(index + 1), {}).get('choices'))

    async def test_practice_superseded_rounds_ungraded_and_missing_tags_are_distinct(self):
        credential = (await self.generate())['credentials'][0]
        auth = await self.signin(credential)
        operations = [
            {'action': 'add_question', 'payload': question(answer='B')},
            {'action': 'start_round'}, {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'A'}},
            {'action': 'end_round'}, {'action': 'start_round'},
            {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'B'}}, {'action': 'end_round'},
            {'action': 'start_round', 'payload': {'practice': True}},
            {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'A'}}, {'action': 'end_round'},
            {'action': 'add_question', 'payload': question(type='boolean', options=['正确', '错误'], answer=None, text='', tags=[])},
            {'action': 'start_round'}, {'action': 'answer', 'payload': {'cardNumber': 1, 'option': 'B'}},
            {'action': 'end_round'}, {'action': 'end_session'}]
        await self.sync(self.batch(self.journal(operations)))
        _, own = await self.student('GET', '/report', headers=auth)
        self.assertEqual(own['totals']['samples'], 1)
        self.assertEqual(own['totals']['correct'], 1)
        self.assertEqual(own['totals']['practice'], 1)
        self.assertEqual(own['totals']['ungraded'], 1)
        self.assertEqual([r['counted'] for r in own['records']], [False, True, False, True])
        self.assertEqual(own['records'][-1]['type'], 'boolean')
        self.assertEqual(own['records'][-1]['text'], '')
        self.assertEqual(own['records'][-1]['tags'], [])
        self.assertEqual(own['knowledge'][0]['samples'], 1)

    async def test_latest_published_question_answer_is_counted_once(self):
        credential = (await self.generate())['credentials'][0]
        auth = await self.signin(credential)
        bank = await self.new_question()
        deck = await self.api('POST', '/decks', {'title': '个人分析题单', 'questionIds': [bank['id']]})
        await self.api('POST', f'/decks/{deck["id"]}/publish', {'revision': deck['revision'], 'classId': self.cid})
        await self.sync(self.session(bank=bank))
        await self.sync(self.session(sid='session-2', bank=bank))
        _, own = await self.student('GET', '/report', headers=auth)
        self.assertEqual(own['totals']['samples'], 1)
        self.assertEqual([r['counted'] for r in own['records']], [False, True])

    async def test_student_image_access_requires_own_ended_classroom_reference(self):
        import base64
        credential = (await self.generate())['credentials'][0]
        auth = await self.signin(credential)
        image = await self.api('POST', '/images', {'dataUrl': 'data:image/png;base64,' + base64.b64encode(PNG).decode()})
        bank = await self.new_question(imageId=image['id'])
        deck = await self.api('POST', '/decks', {'title': '题图', 'questionIds': [bank['id']]})
        await self.api('POST', f'/decks/{deck["id"]}/publish', {'revision': deck['revision'], 'classId': self.cid})
        response = await self.client.get('/api/student/images/' + image['id'], headers=auth)
        self.assertEqual(response.status, 403)
        await response.read()
        await self.sync(self.session(bank=bank))
        response = await self.client.get('/api/student/images/' + image['id'], headers=auth)
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.read(), PNG)
        other = await self.other_class()
        await self.profile(other, [{'id': 's1', 'name': '其他班同学'}])
        await self.api('PUT', f'/classes/{other}/cards', {'revision': 0, 'initialize': True})
        outsider = await self.signin((await self.generate(cid=other, code='208'))['credentials'][0])
        response = await self.client.get('/api/student/images/' + image['id'], headers=outsider)
        self.assertEqual(response.status, 403)
        await response.read()

    async def test_empty_missing_roster_and_disabled_class_fail_without_changing_staff_auth(self):
        credential = (await self.generate())['credentials'][0]
        auth = await self.signin(credential)
        self.db.run('UPDATE classes SET enabled=0 WHERE id=?', (self.cid,))
        await self.student('GET', '/report', headers=auth, status=401)
        await self.student('POST', '/login', credential, status=401)
        response = await self.client.post('/api/auth/login', json={'username': 'ICe', 'password': '123456'})
        self.assertEqual(response.status, 401)
        response = await self.client.put('/api/auth/password', json={
            'currentPassword': 'AdminPassword123', 'newPassword': '123456'}, headers=self.admin)
        self.assertEqual(response.status, 400)

    async def test_student_short_path_preserves_query_and_api_responses_are_not_cached(self):
        response = await self.client.get('/student?from=card', allow_redirects=False)
        self.assertEqual(response.status, 302)
        self.assertEqual(response.headers['Location'], '/card-quiz/student.html?from=card')
        response, _ = await self.student('GET', '/session')
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    async def test_banban_generation_keeps_passwords_out_of_durable_operation_results(self):
        state = await self.state()
        response = await self.client.post('/api/banban/operations', json={
            'kind': 'platform', 'args': {'operation': 'student.accounts.create', 'classId': self.cid,
                'payload': {**self.versions(state), 'entryYear': 2026, 'classCode': '101'}}}, headers=self.admin)
        self.assertEqual(response.status, 200, await response.text())
        operation = await response.json()
        response = await self.client.post('/api/banban/operations/' + operation['id'] + '/confirm',
                                           json={'confirmed': True}, headers=self.admin)
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(set(result['result']), {'detail', 'privateUrl'})
        response = await self.client.get(result['result']['privateUrl'], headers=self.admin)
        self.assertEqual(response.status, 200, await response.text())
        private = await response.json()
        self.assertEqual(len(private['credentials']), 4)
        durable = json.dumps({'result': result, 'operations': self.db.all('SELECT * FROM banban_operations'),
                              'audit': self.db.all('SELECT * FROM audit_events')}, ensure_ascii=False)
        for credential in private['credentials']:
            self.assertNotIn(credential['password'], durable)
        response = await self.client.get(result['result']['privateUrl'])
        self.assertEqual(response.status, 401)
        await response.read()

    async def test_roster_change_during_password_preparation_cannot_create_stale_accounts(self):
        state = await self.state()
        prepared, proceed = asyncio.Event(), asyncio.Event()
        original = StudentAccounts.new_passwords

        async def gated(feature, accounts):
            result = await original(feature, accounts)
            prepared.set()
            await proceed.wait()
            return result

        with patch.object(StudentAccounts, 'new_passwords', gated):
            request = asyncio.create_task(self.client.post(f'/api/card-quiz/classes/{self.cid}/students', json={
                **self.versions(state), 'entryYear': 2026, 'classCode': '101'}, headers=self.admin))
            try:
                await asyncio.wait_for(prepared.wait(), 5)
                await self.profile(self.cid, self.students[:2])
            finally:
                proceed.set()
            response = await request
            self.assertEqual(response.status, 409, await response.text())
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM student_accounts')['n'], 0)

    async def test_reset_during_self_card_password_check_cannot_return_old_credentials(self):
        created = await self.generate()
        credential = created['credentials'][0]
        auth = await self.signin(credential)
        checked, proceed = asyncio.Event(), asyncio.Event()
        original = StudentAccounts.check_password

        async def gated(feature, request, *args):
            await original(feature, request, *args)
            if request.path.endswith('/card'):
                checked.set()
                await proceed.wait()

        with patch.object(StudentAccounts, 'check_password', gated):
            request = asyncio.create_task(self.client.post('/api/student/card',
                json={'password': credential['password']}, headers=auth))
            try:
                await asyncio.wait_for(checked.wait(), 5)
                await self.reset(['s1'], state=created)
            finally:
                proceed.set()
            response = await request
            self.assertEqual(response.status, 401)
            self.assertNotIn('card', await response.json())

    async def test_link_rechecks_destination_management_after_waiting_for_body(self):
        credential = (await self.generate())['credentials'][0]
        other = await self.other_class()
        await self.profile(other, [{'id': 'moved', 'name': '转入同学'}])
        uid, head = await self.account('transfer-head', head=[self.cid, other])
        state = await self.state(other, head)
        waiting, proceed = asyncio.Event(), asyncio.Event()
        original = StudentAccounts.body

        async def gated(feature, request):
            if request.path.endswith('/link'):
                waiting.set()
                await proceed.wait()
            return await original(feature, request)

        with patch.object(StudentAccounts, 'body', gated):
            request = asyncio.create_task(self.client.post(f'/api/card-quiz/classes/{other}/students/link',
                json={**self.versions(state), 'studentId': 'moved', 'username': credential['username']}, headers=head))
            try:
                await asyncio.wait_for(waiting.wait(), 5)
                self.db.run('DELETE FROM teacher_classes WHERE user_id=? AND class_id=?', (uid, other))
            finally:
                proceed.set()
            response = await request
            self.assertEqual(response.status, 403, await response.text())
        self.assertEqual(self.db.one('SELECT class_id FROM student_accounts WHERE id=?',
                                     (credential['accountId'],))['class_id'], self.cid)

    async def test_class_with_current_student_accounts_returns_actionable_conflict_on_delete(self):
        created = await self.generate()
        response = await self.client.delete('/api/classes/' + self.cid,
            json={'confirmName': '高一（1）班'}, headers=self.admin)
        self.assertEqual(response.status, 409, await response.text())
        self.assertIsNotNone(self.db.one('SELECT id FROM classes WHERE id=?', (self.cid,)))
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM student_accounts')['n'], 4)
        await self.signin(created['credentials'][0])

    async def test_class_delete_rechecks_manager_after_waiting_for_confirmation(self):
        await self.sync()
        waiting, proceed = asyncio.Event(), asyncio.Event()
        original = Management.confirmed
        actor = {}

        async def gated(feature, request, name):
            actor['id'] = service.current_user(request)['id']
            waiting.set()
            await proceed.wait()
            return await original(feature, request, name)

        with patch.object(Management, 'confirmed', gated):
            request = asyncio.create_task(self.client.delete('/api/classes/' + self.cid,
                json={'confirmName': '高一（1）班'}, headers=self.admin))
            try:
                await asyncio.wait_for(waiting.wait(), 5)
                self.db.run('UPDATE users SET enabled=0 WHERE id=?', (actor['id'],))
            finally:
                proceed.set()
            response = await request
            self.assertEqual(response.status, 401, await response.text())
        self.assertIsNotNone(self.db.one('SELECT id FROM classes WHERE id=?', (self.cid,)))
        self.assertIsNotNone(self.db.one('SELECT id FROM card_quiz_sessions WHERE class_id=?', (self.cid,)))

    async def test_deleting_former_class_cleans_links_but_preserves_transferred_accounts(self):
        await self.profile(self.cid, self.students[:1])
        credential = (await self.generate())['credentials'][0]
        await self.sync()
        other = await self.other_class()
        await self.profile(other, [{'id': 'moved', 'name': '已转入同学'}])
        await self.link(other, 'moved', credential['username'])
        response = await self.client.delete('/api/classes/' + self.cid,
            json={'confirmName': '高一（1）班'}, headers=self.admin)
        self.assertEqual(response.status, 200, await response.text())
        self.assertIsNone(self.db.one('SELECT id FROM classes WHERE id=?', (self.cid,)))
        account = self.db.one('SELECT * FROM student_accounts WHERE id=?', (credential['accountId'],))
        self.assertEqual(account['class_id'], other)
        self.assertEqual(account['username'], credential['username'])
        self.assertEqual(self.db.all('SELECT * FROM student_account_links WHERE class_id=?', (self.cid,)), [])
        self.assertEqual(self.db.all('PRAGMA foreign_key_check'), [])
        await self.signin(credential)

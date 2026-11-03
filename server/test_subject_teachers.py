"""Head and subject assignments share a login, but never share privileged scope."""
import sqlite3
import unittest
from pathlib import Path

import app as service
from permissions import ROLE_LABELS
import test_app as app_tests
import test_school_roles as role_tests


class SubjectTeachersTest(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = app_tests.ServerTestCase.asyncTearDown
    headers = app_tests.ServerTestCase.headers
    json_request = app_tests.ServerTestCase.json_request
    bootstrap_and_login = app_tests.ServerTestCase.bootstrap_and_login
    login = role_tests.SchoolRolesTest.login
    seed_scope_records = role_tests.SchoolRolesTest.seed_scope_records

    async def asyncSetUp(self):
        await role_tests.SchoolRolesTest.asyncSetUp(self)
        self.head = self.classes['高一（1）班']
        self.taught = self.classes['高二（1）班']
        self.outside = self.classes['高三（1）班']
        response, data = await self.json_request('POST', '/api/teachers', {
            'username': 'subject', 'displayName': '任课老师', 'role': 'subject_teacher',
            'password': 'SchoolTest2026', 'teachingClassIds': [self.taught]}, csrf=True)
        self.assertEqual(response.status, 201, data)
        self.accounts['subject'] = data['id']
        response, data = await self.json_request('PATCH', '/api/teachers/' + self.accounts['teacher1'], {
            'headClassIds': [self.head], 'teachingClassIds': [self.taught]}, csrf=True)
        self.assertEqual(response.status, 200, data)

    async def test_roles_and_separate_assignments_are_returned(self):
        self.assertEqual([ROLE_LABELS[r] for r in ('principal', 'director', 'grade_leader', 'teacher', 'subject_teacher')],
                         ['校长', '主任', '年级部', '班主任', '任课老师'])
        _, data = await self.json_request('GET', '/api/teachers')
        dual = next(u for u in data['teachers'] if u['username'] == 'teacher1')
        self.assertEqual([c['id'] for c in dual['headClasses']], [self.head])
        self.assertEqual([c['id'] for c in dual['teachingClasses']], [self.taught])
        self.assertEqual({c['id'] for c in dual['classes']}, {self.head, self.taught})
        for username, expected in [('subject', {self.taught}), ('teacher1', {self.head, self.taught})]:
            user = await self.login(username)
            self.assertEqual(user['permissions']['receiveClassroomVoice'], username == 'teacher1')
            _, data = await self.json_request('GET', '/api/classes')
            self.assertEqual({c['id'] for c in data['classes']}, expected)
            for classroom in data['classes']:
                self.assertEqual(classroom['canEditIsland'], classroom['id'] == self.head)
                self.assertEqual(classroom['canReceiveVoice'], classroom['id'] == self.head)

    async def test_subject_can_read_and_export_but_not_edit_or_import(self):
        await self.login('subject')
        path = '/api/island/classes/' + self.taught
        response, profile = await self.json_request('GET', path)
        self.assertEqual(response.status, 200, profile)
        self.assertFalse(profile['canEdit'])
        response = await self.client.get(path + '/export', headers=self.headers())
        self.assertEqual(response.status, 200)
        await response.read()
        for method, suffix, body in [('PUT', '', {'revision': profile['revision'], 'config': profile['config']}),
                                      ('POST', '/import', {})]:
            response, data = await self.json_request(method, path + suffix, body, csrf=True)
            self.assertEqual(response.status, 403, data)
        _, after = await self.json_request('GET', path)
        self.assertEqual(after['revision'], profile['revision'])
        await self.login('teacher1')
        response, _ = await self.json_request('PUT', path, {'revision': profile['revision'], 'config': profile['config']}, csrf=True)
        self.assertEqual(response.status, 403)
        own = '/api/island/classes/' + self.head
        _, profile = await self.json_request('GET', own)
        self.assertTrue(profile['canEdit'])
        response, data = await self.json_request('PUT', own, {'revision': profile['revision'], 'config': profile['config']}, csrf=True)
        self.assertEqual(response.status, 200, data)

    async def test_voice_access_and_assistant_counts_exclude_taught_classes(self):
        db = self.seed_scope_records()
        root = self.app[service.AUDIO_ROOT_KEY]
        for number in (0, 1):
            target = root / f'fixture/voice-{number}.wav'
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'local audio fixture')
        for username, expected in [('subject', set()), ('teacher1', {self.head})]:
            user = await self.login(username)
            _, data = await self.json_request('GET', '/api/classroom-voice')
            self.assertEqual({m['class_id'] for m in data['messages']}, expected)
            response, _ = await self.json_request('GET', '/api/classroom-voice?classId=' + self.taught)
            self.assertEqual(response.status, 403)
            response = await self.client.get('/api/classroom-voice/voice-1/audio', headers=self.headers())
            self.assertEqual(response.status, 404)
            await response.read()
            response, _ = await self.json_request('DELETE', '/api/classroom-voice/voice-1', {}, csrf=True)
            self.assertEqual(response.status, 403)
            _, context = await self.json_request('GET', '/api/banban/context')
            self.assertEqual({r['className'] for r in context['snapshot']['voice']['rows']},
                             {'高一（1）班'} if expected else set())
            if username == 'subject':
                agent = next(r.handler.__self__ for r in self.app.router.routes()
                             if r.method == 'POST' and r.resource.canonical == '/api/banban/chat/stream')
                for topic in ('help', 'platform'):
                    _, card = agent.platform.read(context['snapshot'], topic, user)
                    self.assertTrue(all(item['view'] != 'classroom-voice' for item in card['findings'] + card['actions']))
        self.assertEqual(db.all("SELECT * FROM classroom_voice_receipts WHERE message_id='voice-1'"), [])
        response = await self.client.get('/api/classroom-voice/voice-0/audio', headers=self.headers())
        self.assertEqual(response.status, 200)
        await response.read()
        self.assertIsNotNone(db.one("SELECT * FROM classroom_voice_receipts WHERE message_id='voice-0'"))

    async def test_subject_notifications_and_control_remain_scoped(self):
        self.seed_scope_records()
        await self.login('subject')
        for cid, allowed in [(self.taught, True), (self.head, False), (self.outside, False)]:
            response, data = await self.json_request('POST', '/api/shouts', {'classId': cid, 'text': '测试任课通知'}, csrf=True)
            self.assertEqual(response.status, 202 if allowed else 403, data)
            response, data = await self.json_request('POST', '/api/classes/' + cid + '/control',
                                                   {'action': 'set_volume', 'volume': 40}, csrf=True)
            self.assertEqual(response.status, 202 if allowed else 403, data)

    async def test_assistant_cannot_prepare_privileged_actions_for_taught_classes(self):
        self.seed_scope_records()
        for username in ('subject', 'teacher1'):
            await self.login(username)
            for args in ({'operation': 'island.update', 'classId': self.taught, 'payload': {}},
                         {'operation': 'voice.delete', 'targetId': 'voice-1', 'payload': {}}):
                response, data = await self.json_request('POST', '/api/banban/operations',
                                                       {'kind': 'platform', 'args': args}, csrf=True)
                self.assertEqual(response.status, 403, data)
        self.assertEqual(self.app[service.STORE_KEY].all('SELECT * FROM banban_operations'), [])

    async def test_subject_assignment_changes_revoke_session_and_preserve_password(self):
        db = self.app[service.STORE_KEY]
        before = db.one('SELECT password_hash FROM users WHERE id=?', (self.accounts['subject'],))
        await self.login('subject')
        session = self.cookie, self.csrf
        self.cookie, self.csrf = self.admin
        response, data = await self.json_request('PATCH', '/api/teachers/' + self.accounts['subject'],
                                               {'teachingClassIds': [self.outside]}, csrf=True)
        self.assertEqual(response.status, 200, data)
        self.assertEqual(db.one('SELECT password_hash FROM users WHERE id=?', (self.accounts['subject'],)), before)
        self.cookie, self.csrf = session
        response, _ = await self.json_request('GET', '/api/classes')
        self.assertEqual(response.status, 401)
        await self.login('subject')
        _, data = await self.json_request('GET', '/api/classes')
        self.assertEqual([c['id'] for c in data['classes']], [self.outside])

    async def test_swapping_head_and_teaching_scope_invalidates_old_chat_context(self):
        user = await self.login('teacher1')
        agent = next(r.handler.__self__ for r in self.app.router.routes()
                     if r.method == 'POST' and r.resource.canonical == '/api/banban/chat/stream')
        before = agent.access(user)
        conversation = agent.history.create(user)['id']
        self.cookie, self.csrf = self.admin
        response, data = await self.json_request('PATCH', '/api/teachers/' + self.accounts['teacher1'],
            {'headClassIds': [self.taught], 'teachingClassIds': [self.head]}, csrf=True)
        self.assertEqual(response.status, 200, data)
        user = await self.login('teacher1')
        after = agent.access(user)
        self.assertEqual(before['classes'], after['classes'])
        self.assertNotEqual(before, after)
        self.assertIsNone(agent.history.get(user, conversation))
        self.assertIsNotNone(self.app[service.STORE_KEY].one('SELECT id FROM banban_conversations WHERE id=?', (conversation,)))
        self.app[service.STORE_KEY].run('DELETE FROM teaching_classes WHERE user_id=?', (user['id'],))
        self.assertEqual(set(agent.access(user)), {'role', 'classes'})

    async def test_cross_grade_dual_assignment_protects_accounts(self):
        await self.login('grade1')
        response, _ = await self.json_request('PATCH', '/api/teachers/' + self.accounts['teacher1'],
                                            {'enabled': False}, csrf=True)
        self.assertEqual(response.status, 403)
        response, _ = await self.json_request('POST', '/api/teachers', {
            'username': 'cross.scope', 'displayName': '跨年级', 'password': 'SchoolTest2026',
            'role': 'subject_teacher', 'teachingClassIds': [self.taught]}, csrf=True)
        self.assertEqual(response.status, 403)
        response, data = await self.json_request('POST', '/api/teachers', {
            'username': 'local.subject', 'displayName': '本年级任课', 'password': 'SchoolTest2026',
            'role': 'subject_teacher', 'teachingClassIds': [self.head]}, csrf=True)
        self.assertEqual(response.status, 201, data)
        await self.login('director')
        response, data = await self.json_request('PATCH', '/api/teachers/' + self.accounts['teacher1'],
                                               {'teachingClassIds': [self.outside]}, csrf=True)
        self.assertEqual(response.status, 200, data)

    async def test_subject_cannot_take_head_assignment_and_legacy_edits_keep_teaching(self):
        response, _ = await self.json_request('PATCH', '/api/teachers/' + self.accounts['subject'],
                                            {'headClassIds': [self.head]}, csrf=True)
        self.assertEqual(response.status, 400)
        response, data = await self.json_request('PUT', '/api/teachers/' + self.accounts['teacher1'] + '/classes',
                                               {'classIds': [self.outside]}, csrf=True)
        self.assertEqual(response.status, 200, data)
        _, users = await self.json_request('GET', '/api/teachers')
        dual = next(u for u in users['teachers'] if u['username'] == 'teacher1')
        self.assertEqual([c['id'] for c in dual['headClasses']], [self.outside])
        self.assertEqual([c['id'] for c in dual['teachingClasses']], [self.taught])

    def test_upgrade_preserves_existing_rows_and_is_repeatable(self):
        path = Path(self.temp.name) / 'five-role-upgrade.db'
        old = sqlite3.connect(path)
        old.executescript(service.SCHEMA_PATH.read_text('utf-8'))
        old.execute("INSERT INTO users VALUES('old','old','原班主任','teacher','original-hash',1,1,1)")
        old.execute("INSERT INTO classes VALUES('class','高一（1）班',1,1,1)")
        old.execute("INSERT INTO teacher_classes VALUES('old','class')")
        old.execute("INSERT INTO sessions VALUES('token','old','csrf',9999999999999,1)")
        old.commit(); old.close()
        for _ in range(2):
            upgraded = service.Store(path)
            try:
                self.assertEqual(upgraded.one("SELECT password_hash FROM users WHERE id='old'"), {'password_hash': 'original-hash'})
                self.assertEqual(upgraded.one('SELECT * FROM teacher_classes'), {'user_id': 'old', 'class_id': 'class'})
                self.assertIsNotNone(upgraded.one('SELECT * FROM sessions'))
                self.assertEqual(upgraded.all('SELECT * FROM teaching_classes'), [])
                self.assertEqual(upgraded.all('PRAGMA foreign_key_check'), [])
                upgraded.run("UPDATE users SET role='subject_teacher' WHERE id='old'")
            finally:
                upgraded.close()

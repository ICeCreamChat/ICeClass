"""Exercise responsibilities through HTTP, including direct cross-scope requests."""
import sqlite3
import unittest
from pathlib import Path

import app as service
from test_app import ServerTestCase as _Base


class SchoolRolesTest(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = _Base.asyncTearDown
    headers = _Base.headers
    json_request = _Base.json_request
    bootstrap_and_login = _Base.bootstrap_and_login

    async def asyncSetUp(self):
        await _Base.asyncSetUp(self)
        await self.bootstrap_and_login()
        self.admin = (self.cookie, self.csrf)
        self.classes = {}
        for name in ('高一（1）班', '高二（1）班', '高三（1）班', '毕业留存班'):
            response, data = await self.json_request('POST', '/api/classes', {'name': name}, csrf=True)
            self.assertEqual(response.status, 201, data)
            self.classes[name] = data['id']
        self.accounts = {}
        for username, role, extra in [
            ('principal', 'principal', {}), ('director', 'director', {}),
            ('grade1', 'grade_leader', {'grade': '高一'}), ('grade2', 'grade_leader', {'grade': '高二'}),
            ('teacher1', 'teacher', {'classIds': [self.classes['高一（1）班']]}),
            ('teacher2', 'teacher', {'classIds': [self.classes['高二（1）班']]}),
        ]:
            response, data = await self.json_request('POST', '/api/teachers', {
                'username': username, 'displayName': username, 'role': role,
                'password': 'SchoolTest2026', **extra}, csrf=True)
            self.assertEqual(response.status, 201, data)
            self.accounts[username] = data['id']

    async def login(self, username):
        response, data = await self.json_request('POST', '/api/auth/login', {'username': username, 'password': 'SchoolTest2026'})
        self.assertEqual(response.status, 200, data)
        self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]
        self.csrf = data['user']['csrfToken']
        return data['user']

    async def test_four_responsibilities_and_dynamic_classes(self):
        for username, expected in [('principal', set(self.classes.values())),
                                   ('director', {cid for name, cid in self.classes.items() if name.startswith('高')}),
                                   ('grade1', {self.classes['高一（1）班']}), ('teacher1', {self.classes['高一（1）班']})]:
            await self.login(username)
            for path, field in [('/api/classes', 'classes'), ('/api/reading/report', 'rows')]:
                response, data = await self.json_request('GET', path)
                self.assertEqual(response.status, 200, data)
                self.assertEqual({r.get('id', r.get('classId')) for r in data[field]}, expected)
        self.cookie, self.csrf = self.admin
        _, created = await self.json_request('POST', '/api/classes', {'name': '高一（2）班'}, csrf=True)
        for username, included in [('director', True), ('grade1', True), ('grade2', False), ('teacher1', False)]:
            await self.login(username)
            _, data = await self.json_request('GET', '/api/classes')
            self.assertEqual(created['id'] in {c['id'] for c in data['classes']}, included)

    async def test_principal_has_school_management(self):
        user = await self.login('principal')
        self.assertTrue(user['permissions']['schoolAdmin'])
        for path in ('/api/teachers', '/api/devices', '/api/reading/settings', '/api/enrollment/school-code', '/api/banban/connection'):
            response, data = await self.json_request('GET', path)
            self.assertEqual(response.status, 200, (path, data))
        response, data = await self.json_request('PUT', '/api/quiet-hours', {'periods': []}, csrf=True)
        self.assertEqual(response.status, 200, data)
        response, data = await self.json_request('POST', '/api/teachers', {
            'username': 'new.head', 'displayName': '新部长', 'role': 'grade_leader', 'grade': '高三', 'password': 'SchoolTest2026'}, csrf=True)
        self.assertEqual(response.status, 201, data)

    async def test_grade_leader_management_cannot_cross_scope_or_promote_self(self):
        await self.login('grade1')
        _, data = await self.json_request('GET', '/api/teachers')
        self.assertEqual({r['username'] for r in data['teachers']}, {'grade1', 'teacher1'})
        for path, body in [
            ('/api/teachers/' + self.accounts['teacher2'], {'enabled': False}),
            ('/api/teachers/' + self.accounts['teacher1'], {'role': 'principal'}),
            ('/api/teachers/' + self.accounts['grade1'], {'role': 'principal'}),
            ('/api/classes/' + self.classes['高二（1）班'], {'enabled': False}),
            ('/api/classes/' + self.classes['高一（1）班'], {'name': '高二（9）班'}),
        ]:
            response, data = await self.json_request('PATCH', path, body, csrf=True)
            self.assertEqual(response.status, 403, (path, data))
        response, data = await self.json_request('PUT', '/api/teachers/' + self.accounts['teacher1'] + '/classes', {'classIds': [self.classes['高二（1）班']]}, csrf=True)
        self.assertEqual(response.status, 403, data)
        response, data = await self.json_request('POST', '/api/teachers', {
            'username': 'grade1.new', 'displayName': '新增本年级教师', 'password': 'SchoolTest2026',
            'role': 'teacher', 'classIds': [self.classes['高一（1）班']]}, csrf=True)
        self.assertEqual(response.status, 201, data)
        response, data = await self.json_request('POST', '/api/classes', {'name': '高一（3）班'}, csrf=True)
        self.assertEqual(response.status, 201, data)

    async def test_direct_requests_reports_voice_history_and_assistant_share_scope(self):
        await self.login('grade1')
        outside = self.classes['高二（1）班']
        for path in (f'/api/reading/report?classId={outside}', f'/api/history?classId={outside}',
                     f'/api/classroom-voice?classId={outside}', f'/api/banban/context?classId={outside}'):
            response, data = await self.json_request('GET', path)
            self.assertEqual(response.status, 403, (path, data))
        response, data = await self.json_request('POST', f'/api/classes/{outside}/control', {'action': 'set_volume', 'volume': 50}, csrf=True)
        self.assertEqual(response.status, 403, data)
        response, data = await self.json_request('GET', '/api/banban/context')
        self.assertEqual(response.status, 200, data)
        self.assertEqual({c['id'] for c in data['classes']}, {self.classes['高一（1）班']})
        response, data = await self.json_request('GET', '/api/reading/settings')
        self.assertEqual(response.status, 403, data)

    async def test_scope_change_revokes_sessions_and_protects_root(self):
        await self.login('teacher1')
        teacher_session = (self.cookie, self.csrf)
        self.cookie, self.csrf = self.admin
        response, data = await self.json_request('PATCH', '/api/teachers/' + self.accounts['teacher1'], {
            'classIds': [self.classes['高二（1）班']]}, csrf=True)
        self.assertEqual(response.status, 200, data)
        self.cookie, self.csrf = teacher_session
        response, _ = await self.json_request('GET', '/api/classes')
        self.assertEqual(response.status, 401)
        await self.login('principal')
        root = self.app[service.STORE_KEY].one("SELECT id FROM users WHERE role='superadmin'")['id']
        for method, suffix, body in [('PATCH', '', {'role': 'teacher'}), ('PUT', '/password', {'password': 'SchoolTest2026'}), ('DELETE', '', {'confirmName': 'ICe'})]:
            response, _ = await self.json_request(method, '/api/teachers/' + root + suffix, body, csrf=True)
            self.assertIn(response.status, (403, 404))

    def seed_scope_records(self):
        db = self.app[service.STORE_KEY]
        timestamp = service.now_ms()
        root = db.one("SELECT id FROM users WHERE role='superadmin'")['id']
        for number, cid in enumerate(self.classes.values()):
            did, vid, sid = f'device-{number}', f'voice-{number}', f'shout-{number}'
            db.run('''INSERT INTO devices(id,class_id,name,token_hash,enabled,created_at,updated_at)
                      VALUES(?,?,?,?,1,?,?)''', (did, cid, did, 'hash-' + did, timestamp, timestamp))
            db.run('INSERT INTO classroom_voice_messages VALUES(?,?,?,?,?,?,?,?)',
                   (vid, cid, did, 'fixture/' + vid + '.wav', 1024, 3000, timestamp, timestamp + 1800000))
            db.run('''INSERT INTO shouts(id,class_id,sender_id,sender_name,text,status,created_at,expires_at)
                      VALUES(?,?,?,?,?,'offline',?,?)''', (sid, cid, root, '测试', sid, timestamp, timestamp + 1800000))
        return db

    async def test_scoped_lists_contain_only_real_authorized_records(self):
        self.seed_scope_records()
        expected = {'principal': set(self.classes.values()),
                    'director': {cid for name, cid in self.classes.items() if name.startswith('高')},
                    'grade1': {self.classes['高一（1）班']}, 'teacher1': {self.classes['高一（1）班']}}
        for username, ids in expected.items():
            await self.login(username)
            for path, field in [('/api/classroom-controls', 'devices'), ('/api/history', 'history'),
                                ('/api/classroom-voice', 'messages')]:
                response, data = await self.json_request('GET', path)
                self.assertEqual(response.status, 200, (path, data))
                self.assertEqual({row['class_id'] for row in data[field]}, ids, (username, path))
            response, data = await self.json_request('GET', '/api/devices')
            if username == 'teacher1':
                self.assertEqual(response.status, 403)
            else:
                self.assertEqual(response.status, 200, data)
                self.assertEqual({row['class_id'] for row in data['devices']}, ids)
        await self.login('grade1')
        for method, path, body in [
            ('PATCH', '/api/devices/device-1', {'enabled': False}),
            ('PATCH', '/api/devices/device-0', {'classId': self.classes['高二（1）班']}),
            ('GET', '/api/classroom-voice/voice-1/audio', None),
            ('DELETE', '/api/classroom-voice/voice-1', None),
            ('DELETE', '/api/history/shout-1', None),
            ('POST', '/api/shouts', {'classId': self.classes['高二（1）班'], 'text': '越权通知'}),
        ]:
            response, data = await self.json_request(method, path, body, csrf=method != 'GET')
            self.assertEqual(response.status, 404 if path.endswith('/audio') else 403, (path, data))
        response, data = await self.json_request('POST', '/api/classes/' + self.classes['高一（1）班'] + '/control',
                                                 {'action': 'set_volume', 'volume': 40}, csrf=True)
        self.assertEqual(response.status, 202, data)

    async def test_manager_deletes_are_scoped_and_cross_grade_staff_are_protected(self):
        db = self.seed_scope_records()
        await self.login('grade1')
        for path, body in [
            ('/api/teachers/' + self.accounts['teacher2'], {'confirmName': 'teacher2'}),
            ('/api/devices/device-1', {'confirmName': 'device-1'}),
            ('/api/classes/' + self.classes['高二（1）班'], {'confirmName': '高二（1）班'}),
            ('/api/classes/' + self.classes['高二（1）班'] + '/records',
             {'confirmName': '高二（1）班', 'kind': 'history', 'allDates': True}),
        ]:
            response, data = await self.json_request('DELETE', path, body, csrf=True)
            self.assertEqual(response.status, 403, (path, data))
        # A teacher spanning two grades cannot be edited or deleted by either single-grade manager.
        db.run('INSERT INTO teacher_classes VALUES(?,?)', (self.accounts['teacher1'], self.classes['高二（1）班']))
        response, _ = await self.json_request('DELETE', '/api/teachers/' + self.accounts['teacher1'],
                                            {'confirmName': 'teacher1'}, csrf=True)
        self.assertEqual(response.status, 403)
        db.run('DELETE FROM teacher_classes WHERE user_id=? AND class_id=?',
               (self.accounts['teacher1'], self.classes['高二（1）班']))
        for path, body in [
            ('/api/teachers/' + self.accounts['teacher1'], {'confirmName': 'teacher1'}),
            ('/api/devices/device-0', {'confirmName': 'device-0'}),
            ('/api/classes/' + self.classes['高一（1）班'] + '/records',
             {'confirmName': '高一（1）班', 'kind': 'history', 'allDates': True}),
            ('/api/classes/' + self.classes['高一（1）班'], {'confirmName': '高一（1）班'}),
        ]:
            response, data = await self.json_request('DELETE', path, body, csrf=True)
            self.assertEqual(response.status, 200, (path, data))
        self.assertIsNotNone(db.one("SELECT id FROM shouts WHERE id='shout-1'"))
        await self.login('director')
        response, data = await self.json_request('DELETE', '/api/teachers/' + self.accounts['grade2'],
                                                {'confirmName': 'grade2'}, csrf=True)
        self.assertEqual(response.status, 200, data)
        response, _ = await self.json_request('DELETE', '/api/classes/' + self.classes['毕业留存班'],
                                            {'confirmName': '毕业留存班'}, csrf=True)
        self.assertEqual(response.status, 403)
        self.assertEqual(db.all('PRAGMA foreign_key_check'), [])

    async def test_upgrade_existing_four_role_database_preserves_deleted_column_and_relations(self):
        path = Path(self.temp.name) / 'production-shape.db'
        db = sqlite3.connect(path)
        schema = service.SCHEMA_PATH.read_text('utf-8').replace(
            "'principal', 'grade_leader'", "'principal'")
        db.executescript(schema)
        db.execute('ALTER TABLE users ADD COLUMN deleted_at INTEGER')
        db.execute("INSERT INTO users VALUES('old','old','原教师','teacher','original-hash',1,1,1,NULL)")
        db.execute("INSERT INTO classes VALUES('class','高一（1）班',1,1,1)")
        db.execute("INSERT INTO teacher_classes VALUES('old','class')")
        db.execute("INSERT INTO sessions VALUES('token','old','csrf',9999999999999,1)")
        db.commit(); db.close()
        upgraded = service.Store(path)
        try:
            self.assertEqual(upgraded.one("SELECT password_hash,deleted_at FROM users WHERE id='old'"), {'password_hash': 'original-hash', 'deleted_at': None})
            self.assertIsNotNone(upgraded.one('SELECT * FROM teacher_classes'))
            self.assertIsNotNone(upgraded.one('SELECT * FROM sessions'))
            upgraded.run("UPDATE users SET role='grade_leader' WHERE id='old'")
            self.assertEqual(upgraded.db.execute('PRAGMA foreign_key_check').fetchall(), [])
        finally:
            upgraded.close()

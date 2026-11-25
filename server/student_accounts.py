"""Independent student identities and one-time printable credentials."""
from __future__ import annotations

import asyncio
import hmac
import re
import secrets
import sqlite3
from datetime import date

from aiohttp import web

from card_quiz_models import QuizError, array, fail, identifier, integer, new_id, revision, unique
from homework import school_year_start, today
from student_reports import StudentReports
from teacher_capabilities import teacher_action, teacher_manual, teacher_read


SCHEMA = """
CREATE TABLE IF NOT EXISTS student_accounts (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 class_id TEXT NOT NULL REFERENCES classes(id), student_id TEXT NOT NULL,
 holder_card_number INTEGER CHECK(holder_card_number BETWEEN 1 AND 157),
 revision INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(class_id,student_id));
CREATE TABLE IF NOT EXISTS student_account_links (
 class_id TEXT NOT NULL REFERENCES classes(id), student_id TEXT NOT NULL,
 account_id TEXT NOT NULL REFERENCES student_accounts(id) ON DELETE CASCADE,
 PRIMARY KEY(class_id,student_id));
CREATE INDEX IF NOT EXISTS idx_student_links_account ON student_account_links(account_id,class_id);
CREATE TABLE IF NOT EXISTS student_account_versions (
 class_id TEXT PRIMARY KEY REFERENCES classes(id), revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS student_card_login_aliases (
 username TEXT PRIMARY KEY CHECK(username GLOB '[0-9][0-9]0[0-9][0-9][0-9][0-9][0-9]'),
 account_id TEXT NOT NULL REFERENCES student_accounts(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS student_sessions (
 token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES student_accounts(id) ON DELETE CASCADE,
 csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_student_sessions_account ON student_sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_student_sessions_expiry ON student_sessions(expires_at);
"""
COOKIE = 'iceclass_student_session'
STUDENT_REASON = '学生本人专用入口，使用独立学生会话、本人密码及本人数据范围，不能以教师身份代办。'


def password_value(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{6}', value):
        fail('学生密码须为 6 位数字。')
    return value


class StudentAccounts(StudentReports):
    def __init__(self, app, service, quiz):
        self.service, self.quiz, self.db = service, quiz, app[service.STORE_KEY]
        self.db.db.executescript(SCHEMA)
        with self.db.transaction():
            if 'holder_card_number' not in {col['name'] for col in self.db.all('PRAGMA table_info(student_accounts)')}:
                self.db.run('ALTER TABLE student_accounts ADD COLUMN holder_card_number INTEGER CHECK(holder_card_number BETWEEN 1 AND 157)')
            self.db.run('''CREATE UNIQUE INDEX IF NOT EXISTS idx_student_holder_cards
                ON student_accounts(class_id,holder_card_number) WHERE holder_card_number IS NOT NULL''')

    async def body(self, request):
        return await self.quiz.body(request, 64 * 1024)

    def class_revision(self, cid):
        row = self.db.one('SELECT revision FROM student_account_versions WHERE class_id=?', (cid,))
        return row['revision'] if row else 0

    def bump(self, cid):
        self.db.run('''INSERT INTO student_account_versions(class_id,revision) VALUES(?,1)
            ON CONFLICT(class_id) DO UPDATE SET revision=revision+1''', (cid,))

    def check_versions(self, cid, body):
        current = (self.class_revision(cid), self.quiz.roster(cid)[0], self.quiz.cards(cid)[0])
        expected = tuple(revision(body.get(key)) for key in ('revision', 'rosterRevision', 'cardRevision'))
        if current != expected:
            fail('学生账号、名单或卡号已变化，请刷新后重新核对。', 409)

    def class_info(self, cid):
        row = self.db.one('SELECT name,enabled FROM classes WHERE id=?', (cid,))
        if not row:
            fail('班级不存在。', 404)
        return row

    def account_for(self, cid, sid):
        return self.db.one('''SELECT a.* FROM student_account_links l
            JOIN student_accounts a ON a.id=l.account_id WHERE l.class_id=? AND l.student_id=?''', (cid, sid))

    def payload(self, cid, user):
        room = self.class_info(cid)
        roster_revision, roster = self.quiz.roster(cid)
        card_revision, cards = self.quiz.cards(cid)
        match = self.service.CLASS_NAME_RE.fullmatch(room['name'])
        code = None
        if match and 1 <= int(match[2]) <= 99:
            code = str({'一': 1, '二': 2, '三': 3}[match[1]]) + f'{int(match[2]):02d}'
        rows = self.db.all('''SELECT l.student_id AS linked_student,a.* FROM student_account_links l
            JOIN student_accounts a ON a.id=l.account_id WHERE l.class_id=?''', (cid,))
        accounts = {row['linked_student']: row for row in rows}
        students = []
        for student in roster:
            account = accounts.get(student['id'])
            active = bool(account and account['class_id'] == cid and account['student_id'] == student['id'])
            students.append({'studentId': student['id'], 'name': student['name'],
                             'cardNumber': cards['bindings'].get(student['id']),
                             'accountId': account['id'] if account else None,
                             'username': account['username'] if account else None,
                             'accountRevision': account['revision'] if account else None,
                             'activeHere': active})
        number_cards = self.db.all('''SELECT id AS accountId,holder_card_number AS cardNumber FROM student_accounts
            WHERE class_id=? AND holder_card_number IS NOT NULL ORDER BY holder_card_number''', (cid,))
        return {'classId': cid, 'className': room['name'], 'classCode': code, 'numberCards': number_cards,
                'revision': self.class_revision(cid), 'rosterRevision': roster_revision,
                'cardRevision': card_revision, 'students': students,
                'canEdit': bool(self.service.can_access_class(self.db, user, cid, include_teaching=False))}

    def teacher(self, request, *, edit=False):
        user = self.quiz.staff(request)
        cid = identifier(request.match_info['class_id'])
        self.quiz.access(user, cid, edit=edit)
        return user, cid

    @teacher_read('student.accounts', '查看班级学生账号', target='class')
    async def get_accounts(self, request):
        user, cid = self.teacher(request)
        return self.quiz.reply(self.payload(cid, user))

    def credential(self, account, password):
        cid, sid = account['class_id'], account['student_id']
        number = account.get('holder_card_number')
        return {'accountId': account['id'], 'username': account['username'], 'password': password,
                'classId': cid, 'className': self.class_info(cid)['name'], 'studentId': sid,
                'cardNumber': number or self.quiz.cards(cid)[1]['bindings'].get(sid),
                **({'numberCard': True} if number else {})}

    def number_card_prefix(self, cid, class_code):
        batch = self.db.one('''SELECT substr(username,1,6) AS prefix FROM student_accounts
            WHERE class_id=? AND holder_card_number IS NOT NULL AND substr(username,3,1)='1' LIMIT 1''', (cid,))
        if batch:
            return batch['prefix']
        grade = int(class_code[0]) if class_code else 1
        entry_year = school_year_start(date.fromisoformat(today())) - (grade - 1)
        occupied = {row['prefix'] for row in self.db.all('''SELECT DISTINCT substr(username,1,6) AS prefix
            FROM student_accounts WHERE holder_card_number IS NOT NULL AND class_id<>?''', (cid,))}
        codes = [class_code] if class_code else (f'{n:03d}' for n in range(100))
        for code in codes:
            prefix = f'{entry_year % 100:02d}1{code}'
            if prefix not in occupied:
                return prefix
        fail('该入学年份的通用卡班号已被占用，请核对班级。', 409)

    def number_card_username(self, prefix, number, account_id):
        username = f'{prefix}{number:02d}'
        if self.db.one('SELECT 1 FROM student_accounts WHERE username=? AND id<>?', (username, account_id)):
            fail('该通用卡编号已由其他账号使用，请核对入学年份、班级和卡号。', 409)
        return username

    async def write_number_cards(self, request, *, reset=False):
        user, cid = self.teacher(request, edit=True)
        body = await self.body(request)
        self.check_versions(cid, body)
        first = integer(body.get('firstNumber'), '起始卡号', 1, 157)
        last = integer(body.get('lastNumber'), '结束卡号', first, 157)
        existing = {a['holder_card_number']: a for a in self.db.all('''SELECT * FROM student_accounts
                    WHERE class_id=? AND holder_card_number BETWEEN ? AND ?''', (cid, first, last))}
        if reset and len(existing) != last - first + 1:
            fail('所选号段含未发放的纸卡，请先生成或调整号段。', 409)
        accounts = [existing[n] if reset else {'id': new_id(), 'class_id': cid, 'student_id': new_id(), 'holder_card_number': n}
                    for n in range(first, last + 1) if reset or n not in existing]
        prepared = await self.new_passwords(accounts)
        with self.db.transaction():
            user, cid = self.teacher(request, edit=True)
            self.check_versions(cid, body)
            if accounts:
                prefix = self.number_card_prefix(cid, self.payload(cid, user)['classCode'])
                legacy = self.db.all('''SELECT id,username,holder_card_number FROM student_accounts
                    WHERE class_id=? AND holder_card_number IS NOT NULL AND substr(username,3,1)='0' ''', (cid,))
                for row in legacy:
                    name = self.number_card_username(prefix, row['holder_card_number'], row['id'])
                    self.db.run('UPDATE student_accounts SET username=? WHERE id=?', (name, row['id']))
                    self.db.run('INSERT INTO student_card_login_aliases(username,account_id) VALUES(?,?)',
                                (row['username'], row['id']))
            now = self.service.now_ms()
            for account, (_, encoded) in zip(accounts, prepared):
                n = account['holder_card_number']
                account['username'] = self.number_card_username(prefix, n, account['id'])
                if reset:
                    self.db.run('UPDATE student_accounts SET password_hash=?,revision=revision+1,updated_at=? WHERE id=?',
                                (encoded, now, account['id']))
                    self.db.run('DELETE FROM student_sessions WHERE account_id=?', (account['id'],))
                else:
                    self.db.run('''INSERT INTO student_accounts
                        (id,username,password_hash,class_id,student_id,holder_card_number,created_at,updated_at)
                        VALUES(?,?,?,?,?,?,?,?)''', (account['id'], account['username'], encoded, cid, account['student_id'], n, now, now))
            if accounts:
                self.bump(cid)
                action = 'reset' if reset else 'issue'
                self.quiz.audit(user, 'student.number_cards.' + action, 'class', cid, f'按号发卡 {first}-{last}，共 {len(accounts)} 张')
        result = self.payload(cid, user)
        result['credentials'] = [self.credential(a, p[0]) for a, p in zip(accounts, prepared)]
        return self.quiz.reply(result)

    @teacher_action('student.number_cards.issue', '为本班通用纸卡生成登录编号和密码', target='class', head_only=True,
                    fields='revision rosterRevision cardRevision firstNumber lastNumber', workflow='private-result',
                    impact='仅生成号段内缺失的通用卡账号。密码仅在本次发放表显示。')
    async def issue_number_cards(self, request):
        return await self.write_number_cards(request)

    @teacher_action('student.number_cards.reset', '重置所选通用卡密码并补印', target='class', head_only=True,
                    fields='revision rosterRevision cardRevision firstNumber lastNumber', workflow='private-result',
                    impact='所选通用卡的旧密码和旧登录会话失效，新密码仅在本次发放表显示。')
    async def reset_number_cards(self, request):
        return await self.write_number_cards(request, reset=True)

    async def new_passwords(self, accounts):
        def prepare():
            result = []
            for account in accounts:
                password = f'{secrets.randbelow(1_000_000):06d}'
                if account.get('password_hash') and self.service.verify_password(password, account['password_hash']):
                    password = f'{(int(password) + 1) % 1_000_000:06d}'
                result.append((password, self.service.hash_password(password)))
            return result
        return await asyncio.to_thread(prepare)

    @teacher_action('student.accounts.create', '批量生成学生账号', target='class', head_only=True,
                    fields='revision rosterRevision cardRevision entryYear classCode', workflow='private-result',
                    impact='为尚未创建账号的学生生成独立初始密码，仅在本次结果中发放。')
    async def create_accounts(self, request):
        user, cid = self.teacher(request, edit=True)
        body = await self.body(request)
        self.check_versions(cid, body)
        year = integer(body.get('entryYear'), '入学年份', 2000, 2099)
        code = body.get('classCode')
        if not isinstance(code, str) or not re.fullmatch(r'[123][0-9]{2}', code) or code.endswith('00'):
            fail('班级编码须为三位数字，如高一（9）班为 109。')
        snapshot = self.payload(cid, user)
        selected = [s for s in snapshot['students'] if s['cardNumber'] is not None and s['accountId'] is None]
        if not selected and any(s['accountId'] is None for s in snapshot['students']):
            fail('请先给需要生成账号的学生分配并保存卡号。')
        accounts = [{'id': new_id(), 'username': f'{year % 100:02d}{code}{s["cardNumber"]:02d}',
                     'class_id': cid, 'student_id': s['studentId']} for s in selected]
        prepared = await self.new_passwords(accounts)
        timestamp = self.service.now_ms()
        try:
            with self.db.transaction():
                self.teacher(request, edit=True)
                self.check_versions(cid, body)
                for account, (_, encoded) in zip(accounts, prepared):
                    self.db.run('''INSERT INTO student_accounts
                        (id,username,password_hash,class_id,student_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)''',
                                (account['id'], account['username'], encoded, cid, account['student_id'], timestamp, timestamp))
                    self.db.run('INSERT INTO student_account_links(class_id,student_id,account_id) VALUES(?,?,?)',
                                (cid, account['student_id'], account['id']))
                if accounts:
                    self.bump(cid)
                    self.quiz.audit(user, 'student.accounts.create', 'class', cid, f'生成 {len(accounts)} 个学生账号')
        except sqlite3.IntegrityError:
            fail('账号编号已被使用，请核对入学年份、班级编码和卡号；原有账号与历史均未修改。', 409)
        result = self.payload(cid, user)
        result['credentials'] = [self.credential(a, p[0]) for a, p in zip(accounts, prepared)]
        return self.quiz.reply(result)

    @teacher_action('student.accounts.reset', '重置学生密码并准备发放或打印', target='class', head_only=True,
                    fields='revision rosterRevision cardRevision studentIds', workflow='private-result',
                    impact='所选学生的旧密码及旧登录会话立即失效，新密码仅在本次结果中发放。')
    async def reset_accounts(self, request):
        user, cid = self.teacher(request, edit=True)
        body = await self.body(request)
        self.check_versions(cid, body)
        ids = [identifier(sid) for sid in array(body.get('studentIds'), 157, '学生编号')]
        if not ids:
            fail('请选择需要重置密码的学生。')
        unique(ids, '学生编号')
        students = {s['studentId']: s for s in self.payload(cid, user)['students']}
        if any(sid not in students or not students[sid]['activeHere'] for sid in ids):
            fail('只能重置当前关联本班名单的学生账号；请先生成账号或核对转班情况。', 409)
        accounts = [self.account_for(cid, sid) for sid in ids]
        prepared = await self.new_passwords(accounts)
        with self.db.transaction():
            self.teacher(request, edit=True)
            self.check_versions(cid, body)
            for account, (_, encoded) in zip(accounts, prepared):
                self.db.run('UPDATE student_accounts SET password_hash=?,revision=revision+1,updated_at=? WHERE id=?',
                            (encoded, self.service.now_ms(), account['id']))
                self.db.run('DELETE FROM student_sessions WHERE account_id=?', (account['id'],))
            self.bump(cid)
            self.quiz.audit(user, 'student.accounts.reset', 'class', cid, f'重置 {len(accounts)} 个学生密码')
        result = self.payload(cid, user)
        result['credentials'] = [self.credential(a, p[0]) for a, p in zip(accounts, prepared)]
        return self.quiz.reply(result)

    @teacher_action('student.accounts.link', '升班或转班时关联原学生账号', target='class', head_only=True,
                    fields='revision rosterRevision cardRevision studentId username',
                    impact='保留原账号与历史，将当前纸卡及名单身份关联到目标班级；同时核验原班管理权限。')
    async def link_account(self, request):
        user, cid = self.teacher(request, edit=True)
        body = await self.body(request)
        sid, username = identifier(body.get('studentId')), identifier(body.get('username'))
        with self.db.transaction():
            user, cid = self.teacher(request, edit=True)
            self.check_versions(cid, body)
            if sid not in {s['id'] for s in self.quiz.roster(cid)[1]}:
                fail('目标学生不在当前班级名单中。')
            account = self.db.one('SELECT * FROM student_accounts WHERE username=? AND enabled=1 AND holder_card_number IS NULL', (username,))
            if not account:
                fail('原学生账号不存在。', 404)
            if not self.service.can_access_class(self.db, user, account['class_id'],
                                                 include_disabled=True, include_teaching=False):
                fail('没有原班级的学生管理权限，请由同时管理两个班级的老师关联。', 403)
            existing = self.account_for(cid, sid)
            if existing and existing['id'] != account['id']:
                fail('此名单编号已属于另一个学生账号，不能覆盖其历史。', 409)
            old_cid = account['class_id']
            if old_cid == cid and account['student_id'] == sid:
                return self.quiz.reply(self.payload(cid, user))
            if old_cid == cid and account['student_id'] in {s['id'] for s in self.quiz.roster(cid)[1]}:
                fail('原名单编号仍在本班使用，请先核对名单，不能将两位学生合并。', 409)
            self.db.run('INSERT OR IGNORE INTO student_account_links(class_id,student_id,account_id) VALUES(?,?,?)',
                        (cid, sid, account['id']))
            self.db.run('UPDATE student_accounts SET class_id=?,student_id=?,revision=revision+1,updated_at=? WHERE id=?',
                        (cid, sid, self.service.now_ms(), account['id']))
            for changed_class in {cid, old_cid}:
                self.bump(changed_class)
            self.quiz.audit(user, 'student.accounts.link', 'class', cid, '关联原学生账号 ' + account['username'])
        return self.quiz.reply(self.payload(cid, user))

    def require_student(self, request):
        if ('Authorization' in request.headers or self.service.is_classroom_request(request)
                or 'X-ICeClass-Device-Id' in request.headers):
            fail('请使用学生账号登录。', 401)
        token = request.cookies.get(COOKIE)
        account = self.db.one('''SELECT a.*,s.csrf_token,s.token_hash FROM student_sessions s
            JOIN student_accounts a ON a.id=s.account_id JOIN classes c ON c.id=a.class_id
            WHERE s.token_hash=? AND s.expires_at>? AND a.enabled=1 AND c.enabled=1''',
                              (self.service.sha256(token), self.service.now_ms())) if token else None
        if not account:
            fail('学生登录已失效，请重新登录。', 401)
        if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
            supplied = request.headers.get('X-CSRF-Token', '')
            if not supplied or not supplied.isascii() or not hmac.compare_digest(supplied, account['csrf_token']):
                fail('页面凭证已失效，请刷新后重试。', 403)
        return account

    def public_student(self, account):
        sid, cid = account['student_id'], account['class_id']
        number = account.get('holder_card_number')
        active = not number and sid in {s['id'] for s in self.quiz.roster(cid)[1]}
        return {'id': account['id'], 'username': account['username'], 'classId': cid,
                'className': self.class_info(cid)['name'], 'csrfToken': account['csrf_token'],
                'numberCard': bool(number),
                'cardNumber': self.quiz.cards(cid)[1]['bindings'].get(sid) if active else number}

    def failure_context(self, request, username):
        source = request.headers.get('X-Real-IP') or request.remote or 'unknown'
        key = self.service.sha256(f'student:{source.lower()}\n{username}')
        timestamp = self.service.now_ms()
        failure = self.db.one('SELECT * FROM login_failures WHERE key=?', (key,))
        if failure and failure['blocked_until'] and failure['blocked_until'] > timestamp:
            fail('密码输入错误次数过多，请稍后重试。', 429)
        return key, timestamp, failure

    def wrong_password(self, key, timestamp, failure):
        # Password verification yields to a worker; parallel attempts may have updated this row.
        timestamp = self.service.now_ms()
        failure = self.db.one('SELECT * FROM login_failures WHERE key=?', (key,))
        same_window = failure and timestamp - failure['window_started_at'] < self.service.LOGIN_FAILURE_WINDOW_MS
        failures = failure['failures'] + 1 if same_window else 1
        started = failure['window_started_at'] if same_window else timestamp
        blocked = timestamp + self.service.LOGIN_BLOCK_MS if failures >= self.service.LOGIN_FAILURE_LIMIT else None
        self.db.run('''INSERT INTO login_failures(key,failures,window_started_at,blocked_until) VALUES(?,?,?,?)
            ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,window_started_at=excluded.window_started_at,
            blocked_until=excluded.blocked_until''', (key, failures, started, blocked))
        fail('密码输入错误次数过多，请稍后重试。' if blocked else '学生编号或密码错误。',
             429 if blocked else 401, 'rate_limited' if blocked else 'invalid_credentials')

    async def check_password(self, request, account, password, username):
        context = self.failure_context(request, username)
        if (not isinstance(password, str) or not re.fullmatch(r'[0-9]{6}', password)
                or not account or not await asyncio.to_thread(self.service.verify_password, password, account['password_hash'])):
            self.wrong_password(*context)
        self.failure_context(request, username)
        self.db.run('DELETE FROM login_failures WHERE key=?', (context[0],))

    @teacher_manual(STUDENT_REASON)
    async def login(self, request):
        body = await self.body(request)
        username = body.get('username')
        username = username.strip() if isinstance(username, str) else ''
        if not re.fullmatch(r'[0-9]{7,9}', username):
            username = ''
        account = self.db.one('''SELECT a.* FROM student_accounts a JOIN classes c ON c.id=a.class_id
            WHERE a.username=? AND a.enabled=1 AND c.enabled=1''', (username,))
        if not account and len(username) == 8 and username[2] == '0':
            account = self.db.one('''SELECT a.* FROM student_card_login_aliases l
                JOIN student_accounts a ON a.id=l.account_id JOIN classes c ON c.id=a.class_id
                WHERE l.username=? AND a.holder_card_number IS NOT NULL AND a.enabled=1 AND c.enabled=1''', (username,))
        await self.check_password(request, account, body.get('password'), account['username'] if account else username)
        token, csrf = self.service.random_token(), self.service.random_token(24)
        timestamp = self.service.now_ms()
        with self.db.transaction():
            current = self.db.one('SELECT * FROM student_accounts WHERE id=? AND enabled=1', (account['id'],))
            if not current or current['revision'] != account['revision'] or not self.class_info(current['class_id'])['enabled']:
                fail('账号已变化，请重新登录。', 401)
            self.db.run('INSERT INTO student_sessions(token_hash,account_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)',
                        (self.service.sha256(token), account['id'], csrf,
                         timestamp + self.service.SESSION_DAYS * 86_400_000, timestamp))
        account['csrf_token'] = csrf
        response = self.quiz.reply({'student': self.public_student(account)})
        response.set_cookie(COOKIE, token, path='/', httponly=True, secure=True, samesite='Strict',
                            max_age=self.service.SESSION_DAYS * 86_400)
        return response

    @teacher_manual(STUDENT_REASON)
    async def session(self, request):
        try:
            account = self.require_student(request)
        except QuizError as error:
            if error.status == 401:
                return self.quiz.reply({'authenticated': False})
            raise
        return self.quiz.reply({'authenticated': True, 'student': self.public_student(account)})

    @teacher_manual(STUDENT_REASON)
    async def logout(self, request):
        account = self.require_student(request)
        self.db.run('DELETE FROM student_sessions WHERE token_hash=?', (account['token_hash'],))
        response = self.quiz.reply({'ok': True})
        response.del_cookie(COOKIE, path='/', secure=True, httponly=True, samesite='Strict')
        return response

    @teacher_manual(STUDENT_REASON)
    async def change_password(self, request):
        account = self.require_student(request)
        if account.get('holder_card_number'):
            fail('通用卡使用纸面固定密码，请联系本班老师换发。', 403)
        body = await self.body(request)
        password = password_value(body.get('newPassword'))
        await self.check_password(request, account, body.get('currentPassword'), account['username'])
        encoded = await asyncio.to_thread(self.service.hash_password, password)
        with self.db.transaction():
            current = self.require_student(request)
            if current['revision'] != account['revision']:
                fail('账号已变化，请重新登录后重试。', 409)
            self.db.run('UPDATE student_accounts SET password_hash=?,revision=revision+1,updated_at=? WHERE id=?',
                        (encoded, self.service.now_ms(), account['id']))
            self.db.run('DELETE FROM student_sessions WHERE account_id=?', (account['id'],))
            self.bump(current['class_id'])
        response = self.quiz.reply({'ok': True, 'reauthenticate': True})
        response.del_cookie(COOKIE, path='/', secure=True, httponly=True, samesite='Strict')
        return response

    @teacher_manual(STUDENT_REASON)
    async def card(self, request):
        account = self.require_student(request)
        body = await self.body(request)
        await self.check_password(request, account, body.get('password'), account['username'])
        current = self.require_student(request)
        if current['revision'] != account['revision']:
            fail('账号已变化，请刷新后重新核对。', 409)
        if self.public_student(current)['cardNumber'] is None:
            fail('当前名单或卡号尚未关联，请联系班主任。', 409)
        return self.quiz.reply({'card': self.credential(current, body['password'])})


def install(app, service, quiz):
    feature = StudentAccounts(app, service, quiz)

    @web.middleware
    async def errors(request, handler):
        if not request.path.startswith('/api/student/'):
            return await handler(request)
        try:
            return await handler(request)
        except QuizError as error:
            return quiz.reply({'error': str(error), 'code': error.code}, error.status)
        except web.HTTPException as error:
            return quiz.reply({'error': error.reason}, error.status)

    app.middlewares.append(errors)
    base = '/api/card-quiz/classes/{class_id}/students'
    app.router.add_get(base, feature.get_accounts)
    app.router.add_post(base, feature.create_accounts)
    app.router.add_post(base + '/reset', feature.reset_accounts)
    app.router.add_post(base + '/link', feature.link_account)
    app.router.add_post(base + '/number-cards', feature.issue_number_cards)
    app.router.add_post(base + '/number-cards/reset', feature.reset_number_cards)
    for method, path, handler in (
        ('POST', '/login', feature.login), ('GET', '/session', feature.session),
        ('POST', '/logout', feature.logout), ('PUT', '/password', feature.change_password),
        ('POST', '/card', feature.card), ('GET', '/report', feature.report), ('GET', '/images/{id}', feature.image),
    ):
        app.router.add_route(method, '/api/student' + path, handler)
    return feature

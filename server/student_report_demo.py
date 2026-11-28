"""Read-only access to a prepared student report. No classroom records are queried."""
from __future__ import annotations

import hmac

from card_quiz_models import fail
from student_report_example import LESSON
from teacher_capabilities import teacher_manual


SCHEMA = """
CREATE TABLE IF NOT EXISTS student_report_demo_access (
 account_id TEXT PRIMARY KEY REFERENCES student_accounts(id) ON DELETE CASCADE,
 password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS student_report_demo_sessions (
 token_hash TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES student_report_demo_access(account_id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL, csrf_token TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_report_demo_expiry ON student_report_demo_sessions(expires_at);
"""
TOKEN_PREFIX = 'report-example.'
PAGE = '/card-quiz/student-example.html'


class StudentReportDemo:
    def __init__(self, accounts, cookie):
        self.db, self.service, self.quiz, self.cookie = accounts.db, accounts.service, accounts.quiz, cookie
        self.db.db.executescript(SCHEMA)

    def start(self, account, verifier, token, csrf, expires_at):
        # Recheck after password verification yielded to a worker thread.
        valid = self.db.one('SELECT 1 FROM student_report_demo_access WHERE account_id=? AND password_hash=?',
                            (account['id'], verifier))
        if not valid:
            fail('备用密码已更新，请重新登录。', 401)
        self.db.run('DELETE FROM student_report_demo_sessions WHERE expires_at<=?', (self.service.now_ms(),))
        self.db.run('INSERT INTO student_report_demo_sessions(token_hash,account_id,expires_at,csrf_token) VALUES(?,?,?,?)',
                    (self.service.sha256(token), account['id'], expires_at, csrf))

    def has_cookie(self, request):
        return request.cookies.get(self.cookie, '').startswith(TOKEN_PREFIX)

    def session(self, request):
        if (not self.has_cookie(request) or 'Authorization' in request.headers or
                self.service.is_classroom_request(request) or 'X-ICeClass-Device-Id' in request.headers):
            return None
        return self.db.one('''SELECT a.username,a.holder_card_number,c.name AS class_name,s.csrf_token,s.token_hash
            FROM student_report_demo_sessions s JOIN student_report_demo_access d ON d.account_id=s.account_id
            JOIN student_accounts a ON a.id=d.account_id JOIN classes c ON c.id=a.class_id
            WHERE s.token_hash=? AND s.expires_at>? AND a.enabled=1 AND c.enabled=1 AND a.holder_card_number IS NOT NULL''',
                           (self.service.sha256(request.cookies[self.cookie]), self.service.now_ms()))

    @teacher_manual('此报告仅供使用备用密码登录的学生读取。')
    async def report(self, request):
        session = self.session(request)
        if not session:
            fail('请用备用密码登录后查看课后报告。', 401)
        return self.quiz.reply({'lesson': LESSON, 'username': session['username'], 'className': session['class_name'],
                                'cardNumber': session['holder_card_number'], 'csrfToken': session['csrf_token']})

    def logout(self, request):
        session = self.session(request)
        if not session:
            fail('学生登录已失效，请重新登录。', 401)
        supplied = request.headers.get('X-CSRF-Token', '')
        if not supplied.isascii() or not hmac.compare_digest(supplied, session['csrf_token']):
            fail('页面凭证已失效，请刷新后重试。', 403)
        self.db.run('DELETE FROM student_report_demo_sessions WHERE token_hash=?', (session['token_hash'],))

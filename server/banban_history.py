"""Account-owned chat threads, paged messages and calendar-based cleanup."""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta

from aiohttp import web
from reading import SHANGHAI

HISTORY_KEY = web.AppKey('banban_history', object)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


class BanbanHistory:
    def __init__(self, db, now, access):
        self.db, self.now, self.access = db, now, access
        legacy = bool(db.one("SELECT name FROM sqlite_master WHERE type='table' AND name='banban_conversations'"))
        legacy = legacy and 'id' not in {row['name'] for row in db.all('PRAGMA table_info(banban_conversations)')}
        with db.transaction():
            if legacy:
                db.run('ALTER TABLE banban_conversations RENAME TO banban_conversations_legacy')
            for sql in [
                '''CREATE TABLE IF NOT EXISTS banban_conversations(
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    access TEXT NOT NULL, title TEXT NOT NULL, scope TEXT NOT NULL,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 0)''',
                '''CREATE INDEX IF NOT EXISTS banban_conversations_owner
                    ON banban_conversations(user_id,updated_at DESC,id DESC)''',
                '''CREATE TABLE IF NOT EXISTS banban_conversation_messages(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id TEXT NOT NULL REFERENCES banban_conversations(id) ON DELETE CASCADE,
                    body TEXT NOT NULL, created_at INTEGER NOT NULL)''',
                '''CREATE INDEX IF NOT EXISTS banban_messages_thread
                    ON banban_conversation_messages(conversation_id,id)''',
                '''CREATE TABLE IF NOT EXISTS banban_active_conversations(
                    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    conversation_id TEXT NOT NULL REFERENCES banban_conversations(id) ON DELETE CASCADE)''',
                '''CREATE TABLE IF NOT EXISTS banban_history_policy(
                    id INTEGER PRIMARY KEY CHECK(id=1), cycle TEXT NOT NULL,
                    next_cleanup_at INTEGER NOT NULL, last_cleanup_at INTEGER)''',
            ]:
                db.run(sql)
            if legacy:
                for row in db.all('SELECT * FROM banban_conversations_legacy'):
                    messages = json.loads(row['messages'])
                    cid = str(uuid.uuid4())
                    title = self.title(next((m['content'] for m in messages if m['role'] == 'user'), '新对话'))
                    db.run('INSERT INTO banban_conversations VALUES(?,?,?,?,?,?,?,?)',
                           (cid, row['user_id'], encoded(json.loads(row['access'])), title, row['scope'],
                            row['updated_at'], row['updated_at'], len(messages)))
                    for message in messages:
                        db.run('INSERT INTO banban_conversation_messages(conversation_id,body,created_at) VALUES(?,?,?)',
                               (cid, encoded(message), row['updated_at']))
                    db.run('INSERT INTO banban_active_conversations VALUES(?,?)', (row['user_id'], cid))
                db.run('DROP TABLE banban_conversations_legacy')
            db.run('INSERT OR IGNORE INTO banban_history_policy VALUES(1,?,?,NULL)',
                   ('monthly', self.next_boundary('monthly', self.now())))

    @staticmethod
    def title(message):
        return re.sub(r'\s+', ' ', message).strip()[:48] or '新对话'

    @staticmethod
    def next_boundary(cycle, timestamp):
        local = datetime.fromtimestamp(timestamp / 1000, SHANGHAI).replace(hour=0, minute=0, second=0, microsecond=0)
        if cycle == 'weekly':
            local += timedelta(days=7 - local.weekday())
        else:
            local = local.replace(year=local.year + (local.month == 12), month=local.month % 12 + 1, day=1)
        return int(local.timestamp() * 1000)

    def policy(self):
        row = self.db.one('SELECT * FROM banban_history_policy WHERE id=1')
        return {'cycle': row['cycle'], 'nextCleanupAt': row['next_cleanup_at'],
                'lastCleanupAt': row['last_cleanup_at'], 'timezone': 'Asia/Shanghai'}

    def set_policy(self, cycle):
        if cycle not in {'weekly', 'monthly'}:
            raise ValueError('请选择每周或每月统一清理。')
        if cycle != self.policy()['cycle']:
            self.db.run('UPDATE banban_history_policy SET cycle=?,next_cleanup_at=? WHERE id=1',
                        (cycle, self.next_boundary(cycle, self.now())))
        return self.policy()

    def cleanup_due(self):
        timestamp, policy = self.now(), self.policy()
        if timestamp < policy['nextCleanupAt']:
            return False
        local = datetime.fromtimestamp(timestamp / 1000, SHANGHAI).replace(hour=0, minute=0, second=0, microsecond=0)
        local = local - timedelta(days=local.weekday()) if policy['cycle'] == 'weekly' else local.replace(day=1)
        cutoff = int(local.timestamp() * 1000)
        with self.db.transaction():
            # New threads in this period survive delayed cleanup after a restart.
            self.db.run('DELETE FROM banban_conversations WHERE created_at<?', (cutoff,))
            self.db.run('UPDATE banban_history_policy SET next_cleanup_at=?,last_cleanup_at=? WHERE id=1',
                        (self.next_boundary(policy['cycle'], timestamp), timestamp))
        return True

    def owner_clause(self, user):
        return (user['id'], encoded(self.access(user)))

    def current(self, user):
        return self.db.one('''SELECT c.* FROM banban_conversations c
            LEFT JOIN banban_active_conversations a ON a.user_id=c.user_id AND a.conversation_id=c.id
            WHERE c.user_id=? AND c.access=? ORDER BY (a.conversation_id IS NOT NULL) DESC,c.updated_at DESC,c.id DESC LIMIT 1''',
                           self.owner_clause(user))

    def get(self, user, conversation_id=None):
        self.cleanup_due()
        if conversation_id is None:
            return self.current(user)
        return self.db.one('SELECT * FROM banban_conversations WHERE id=? AND user_id=? AND access=?',
                           (conversation_id, *self.owner_clause(user)))

    @staticmethod
    def metadata(row):
        return {'id': row['id'], 'title': row['title'], 'createdAt': row['created_at'],
                'updatedAt': row['updated_at'], 'messageCount': row['message_count']}

    def create(self, user):
        self.cleanup_due()
        current = self.current(user)
        if current and current['message_count'] == 0:
            return self.load(user, current['id'])
        timestamp, cid = self.now(), str(uuid.uuid4())
        with self.db.transaction():
            self.db.run('INSERT INTO banban_conversations VALUES(?,?,?,?,?,?,?,0)',
                        (cid, *self.owner_clause(user), '新对话', '{}', timestamp, timestamp))
            self.activate(user, cid)
        return self.load(user, cid)

    def activate(self, user, cid):
        self.db.run('''INSERT INTO banban_active_conversations VALUES(?,?) ON CONFLICT(user_id)
            DO UPDATE SET conversation_id=excluded.conversation_id''', (user['id'], cid))

    def open(self, user, cid):
        data = self.load(user, cid)
        self.activate(user, cid)
        return data

    def delete(self, user, cid):
        # Ownership is required even for school administrators. A permission
        # change need not prevent someone from removing their own old text.
        with self.db.transaction():
            deleted = self.db.run('DELETE FROM banban_conversations WHERE id=? AND user_id=?', (cid, user['id']))
            if deleted.rowcount != 1:
                raise ValueError('这段对话不存在或当前账号无法删除。')
            # Foreign keys also remove all messages and the active reference.
            current = self.current(user)
            if current:
                self.activate(user, current['id'])
        return self.load(user)

    def listing(self, user, cursor=None):
        self.cleanup_due()
        params = self.owner_clause(user)
        where = ''
        if cursor:
            where = ' AND (updated_at<? OR (updated_at=? AND id<?))'
            params += (cursor[0], cursor[0], cursor[1])
        rows = self.db.all('SELECT * FROM banban_conversations WHERE user_id=? AND access=?' + where +
                           ' ORDER BY updated_at DESC,id DESC LIMIT 31', params)
        page = rows[:30]
        return {'conversations': [self.metadata(r) for r in page],
                'nextCursor': {'updatedAt': page[-1]['updated_at'], 'id': page[-1]['id']} if len(rows) > 30 else None,
                'policy': self.policy()}

    def load(self, user, cid=None, before=None, limit=40):
        row = self.get(user, cid)
        if not row:
            if cid is not None:
                raise ValueError('这段对话已清理或当前账号无法查看，请开始新对话。')
            return {'id': None, 'title': '新对话', 'messages': [], 'scope': {}, 'updatedAt': None,
                    'messageCount': 0, 'hasMore': False, 'beforeId': None, 'policy': self.policy()}
        params = (row['id'],)
        where = ''
        if before is not None:
            where = ' AND id<?'
            params += (before,)
        rows = self.db.all('SELECT * FROM banban_conversation_messages WHERE conversation_id=?' + where +
                           ' ORDER BY id DESC LIMIT ?', (*params, limit + 1))
        page = list(reversed(rows[:limit]))
        return {**self.metadata(row), 'messages': [json.loads(r['body']) for r in page],
                'scope': json.loads(row['scope']), 'hasMore': len(rows) > limit,
                'beforeId': page[0]['id'] if page else None, 'policy': self.policy()}

    def context(self, user, cid):
        data = self.load(user, cid, limit=80)
        selected, size = [], 0
        # This is the model's context budget, never a storage or history limit.
        for message in reversed(data['messages']):
            cost = len(message['content'][:8000])
            if size + cost > 24000:
                break
            selected.append(message)
            size += cost
        data['messages'] = list(reversed(selected))
        if data['messages'] and data['messages'][0]['role'] == 'assistant':
            data['messages'].pop(0)
        return data

    def append(self, user, cid, access, scope, messages):
        row = self.get(user, cid)
        if not row or json.loads(row['access']) != access:
            raise ValueError('这段对话已清理或权限已变化，请开始新对话。')
        timestamp = self.now()
        with self.db.transaction():
            for message in messages:
                self.db.run('INSERT INTO banban_conversation_messages(conversation_id,body,created_at) VALUES(?,?,?)',
                            (cid, encoded(message), timestamp))
            title = self.title(messages[0]['content']) if row['message_count'] == 0 else row['title']
            self.db.run('UPDATE banban_conversations SET title=?,scope=?,updated_at=?,message_count=message_count+? WHERE id=?',
                        (title, encoded(scope), timestamp, len(messages), cid))
            self.activate(user, cid)
        return timestamp

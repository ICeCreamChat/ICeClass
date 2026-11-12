"""Persistent monthly admission limits for authenticated Banban callers."""
import json
from datetime import datetime
from math import ceil

from aiohttp import web
from reading import SHANGHAI
from teacher_capabilities import teacher_action, teacher_read


CHARGED_KEY = web.AppKey('banban_quota_charged', dict)
MAX_LIMIT = 1_000_000


def month_bounds(timestamp):
    current = datetime.fromtimestamp(timestamp / 1000, SHANGHAI)
    year, month = (current.year + 1, 1) if current.month == 12 else (current.year, current.month + 1)
    return current.strftime('%Y-%m'), int(datetime(year, month, 1, tzinfo=SHANGHAI).timestamp() * 1000)


class QuotaExceeded(Exception):
    def __init__(self, quota):
        super().__init__('本月班班次数已用完，下月自动恢复，或请超级管理员调整上限。')
        self.quota = quota

    def response(self, service):
        return service.json_response({'error': str(self), 'code': 'banban_quota_exhausted', 'quota': self.quota}, 429,
            headers={'Retry-After': str(max(1, ceil((self.quota['resetsAt'] - service.now_ms()) / 1000)))})


class BanbanQuota:
    def __init__(self, feature):
        self.f, self.s, self.db = feature, feature.s, feature.db
        self.db.db.executescript('''
            CREATE TABLE IF NOT EXISTS banban_quota_policy(
                id INTEGER PRIMARY KEY CHECK(id=1), device_limit INTEGER, account_limit INTEGER,
                revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS banban_quota_overrides(
                kind TEXT NOT NULL CHECK(kind IN ('device','account')), subject_id TEXT NOT NULL,
                monthly_limit INTEGER, PRIMARY KEY(kind,subject_id));
            CREATE TABLE IF NOT EXISTS banban_quota_usage(
                kind TEXT NOT NULL CHECK(kind IN ('device','account')), subject_id TEXT NOT NULL,
                month TEXT NOT NULL, used INTEGER NOT NULL CHECK(used>=0), PRIMARY KEY(kind,subject_id,month));
        ''')
        # Keep existing installations usable until the superadmin sets limits.
        self.db.run('INSERT OR IGNORE INTO banban_quota_policy(id,updated_at) VALUES(1,?)', (self.s.now_ms(),))

    def install(self):
        self.f.app.router.add_get('/api/banban/quota', self.own)
        self.f.app.router.add_get('/api/banban/quotas', self.settings)
        self.f.app.router.add_put('/api/banban/quotas', self.save)

    def period(self):
        return month_bounds(self.s.now_ms())

    @staticmethod
    def subject(user):
        classroom = user.get('classroom')
        return ('device', classroom['deviceId']) if classroom else ('account', user['id'])

    def status(self, user):
        kind, ident = self.subject(user)
        month, resets = self.period()
        policy = self.db.one('SELECT * FROM banban_quota_policy WHERE id=1')
        override = self.db.one('SELECT monthly_limit FROM banban_quota_overrides WHERE kind=? AND subject_id=?',
                               (kind, ident))
        limit = override['monthly_limit'] if override else policy[kind + '_limit']
        usage = self.db.one('SELECT used FROM banban_quota_usage WHERE kind=? AND subject_id=? AND month=?',
                            (kind, ident, month))
        used = usage['used'] if usage else 0
        return {'kind': kind, 'month': month, 'used': used, 'limit': limit,
                'remaining': None if limit is None else max(0, limit - used), 'resetsAt': resets,
                'source': 'custom' if override else 'default'}

    def consume(self, request, user):
        # Only server code can set this request-local marker. Tool calls within
        # an admitted turn share it; confirmations and receipts never call here.
        if request.get(CHARGED_KEY) is not None:
            return request[CHARGED_KEY]
        kind, ident = self.subject(user)
        with self.db.transaction():
            quota = self.status(user)
            if quota['remaining'] == 0:
                raise QuotaExceeded(quota)
            self.db.run('''INSERT INTO banban_quota_usage(kind,subject_id,month,used) VALUES(?,?,?,1)
                ON CONFLICT(kind,subject_id,month) DO UPDATE SET used=used+1''', (kind, ident, quota['month']))
            quota['used'] += 1
            if quota['remaining'] is not None:
                quota['remaining'] -= 1
        request[CHARGED_KEY] = quota
        return quota

    def admin(self, request):
        user = self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        if user['role'] != 'superadmin' or user.get('classroom'):
            return self.s.json_response({'error': '仅超级管理员可管理班班次数。'}, 403)
        return user

    def targets(self):
        devices = self.db.all('''SELECT d.id,d.name,d.enabled,c.name detail FROM devices d
            JOIN classes c ON c.id=d.class_id WHERE d.deleted_at IS NULL ORDER BY c.name,d.name,d.id''')
        accounts = self.db.all('''SELECT id,display_name name,username detail,enabled FROM users
            WHERE deleted_at IS NULL ORDER BY display_name,username,id''')
        return [{**row, 'kind': kind} for kind, rows in (('device', devices), ('account', accounts)) for row in rows]

    def configuration(self):
        policy = self.db.one('SELECT * FROM banban_quota_policy WHERE id=1')
        month, resets = self.period()
        overrides = self.db.all('SELECT kind,subject_id id,monthly_limit AS "limit" FROM banban_quota_overrides ORDER BY kind,subject_id')
        custom = {(row['kind'], row['id']): row['limit'] for row in overrides}
        usage = {(row['kind'], row['subject_id']): row['used'] for row in
                 self.db.all('SELECT kind,subject_id,used FROM banban_quota_usage WHERE month=?', (month,))}
        targets = self.targets()
        valid = {(row['kind'], row['id']) for row in targets}
        for row in targets:
            key = row['kind'], row['id']
            row.update(used=usage.get(key, 0), limit=custom[key] if key in custom else policy[row['kind'] + '_limit'],
                       source='custom' if key in custom else 'default')
        return {'revision': policy['revision'], 'deviceLimit': policy['device_limit'], 'accountLimit': policy['account_limit'],
                'month': month, 'resetsAt': resets, 'overrides': [row for row in overrides if (row['kind'], row['id']) in valid],
                'targets': targets}

    @teacher_read('banban.quota', '查看本人班班月度次数')
    async def own(self, request):
        user = self.s.require_user(request)
        return user if isinstance(user, web.Response) else self.s.json_response(self.status(user))

    @teacher_read('banban.quotas', '查看班班次数设置与当月用量', roles=('superadmin',))
    async def settings(self, request):
        user = self.admin(request)
        return user if isinstance(user, web.Response) else self.s.json_response(self.configuration())

    @staticmethod
    def validate_limit(value):
        if value is not None and (type(value) is not int or not 0 <= value <= MAX_LIMIT):
            raise ValueError('月度上限请填写 0-1000000 的整数；不限次使用空值。')

    def validate(self, body):
        if not isinstance(body, dict) or set(body) != {'revision', 'deviceLimit', 'accountLimit', 'overrides'}:
            raise ValueError('次数设置格式不正确，请重新载入后保存。')
        if type(body['revision']) is not int or body['revision'] < 0:
            raise ValueError('设置版本不正确，请重新载入。')
        for key in ('deviceLimit', 'accountLimit'):
            self.validate_limit(body[key])
        targets = {(row['kind'], row['id']) for row in self.targets()}
        if not isinstance(body['overrides'], list) or len(body['overrides']) > len(targets):
            raise ValueError('单独设置的设备或账号列表不正确。')
        seen = set()
        for row in body['overrides']:
            if not isinstance(row, dict) or set(row) != {'kind', 'id', 'limit'} or not all(
                    isinstance(row[key], str) for key in ('kind', 'id')):
                raise ValueError('单独设置的格式不正确。')
            key = row['kind'], row['id']
            if key not in targets or key in seen:
                raise ValueError('单独设置的设备或账号不存在，或有重复项，请重新载入。')
            self.validate_limit(row['limit'])
            seen.add(key)

    @teacher_action('banban.quotas.update', '设置班班月度次数',
                    fields='revision deviceLimit accountLimit overrides', roles=('superadmin',),
                    impact='立即调整每月上限，保留当月已用次数；未单独列出的设备与账号沿用默认上限。')
    async def save(self, request):
        user = self.admin(request)
        if isinstance(user, web.Response):
            return user
        body = await self.s.read_json(request)
        try:
            with self.db.transaction():
                self.validate(body)
                changed = self.db.run('''UPDATE banban_quota_policy SET device_limit=?,account_limit=?,
                    revision=revision+1,updated_at=? WHERE id=1 AND revision=?''',
                    (body['deviceLimit'], body['accountLimit'], self.s.now_ms(), body['revision'])).rowcount
                if not changed:
                    return self.s.json_response({'error': '次数设置已在其他页面修改，请重新载入后核对。'}, 409)
                self.db.run('DELETE FROM banban_quota_overrides')
                for row in body['overrides']:
                    self.db.run('INSERT INTO banban_quota_overrides VALUES(?,?,?)', (row['kind'], row['id'], row['limit']))
                self.s.audit(self.db, user['id'], 'banban.quota.update', 'settings', None,
                             json.dumps({key: body[key] for key in ('deviceLimit', 'accountLimit', 'overrides')}, ensure_ascii=False))
        except ValueError as error:
            return self.s.json_response({'error': str(error)}, 400)
        return self.s.json_response(self.configuration())

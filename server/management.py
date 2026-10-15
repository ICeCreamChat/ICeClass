"""ICe-only record management and school-wide classroom enrollment."""
from __future__ import annotations

import hmac
import ipaddress
import json
import secrets
import uuid
from datetime import date, datetime, timedelta

from aiohttp import web
from reading import SHANGHAI


def install_management(app, service):
    db = app[service.STORE_KEY]
    for table in ('users', 'devices'):
        if 'deleted_at' not in {row['name'] for row in db.all(f'PRAGMA table_info({table})')}:
            db.run(f'ALTER TABLE {table} ADD COLUMN deleted_at INTEGER')
    columns = {row['name'] for row in db.all('PRAGMA table_info(devices)')}
    for name, definition in {'computer_name': 'TEXT', 'os_version': 'TEXT',
                             'local_addresses': "TEXT NOT NULL DEFAULT '[]'", 'identity_seen_at': 'INTEGER',
                             'binding_note': "TEXT NOT NULL DEFAULT ''", 'verified_at': 'INTEGER'}.items():
        if name not in columns:
            db.run(f'ALTER TABLE devices ADD COLUMN {name} {definition}')
    db.run('''CREATE TABLE IF NOT EXISTS school_enrollment (
        id INTEGER PRIMARY KEY CHECK(id=1), code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)''')
    feature = Management(app, service)
    app.router.add_delete('/api/classes/{class_id}', feature.delete_class)
    app.router.add_delete('/api/classes/{class_id}/records', feature.clear_records)
    app.router.add_delete('/api/teachers/{teacher_id}', feature.delete_user)
    app.router.add_delete('/api/devices/{device_id}', feature.delete_device)
    app.router.add_get('/api/enrollment/school-code', feature.school_status)
    app.router.add_post('/api/enrollment/school-code', feature.school_code)
    app.router.add_delete('/api/enrollment/school-code', feature.close_school_code)
    app.router.add_post('/api/device/enrollment/classes', feature.enrollment_classes)
    app.router.add_post('/api/classes/rename-batch', feature.rename_classes)


def record_computer_info(db, device_id, info, timestamp):
    """Optional metadata from newer receivers; old clients remain compatible."""
    if not isinstance(info, dict):
        return
    addresses = []
    for value in info.get('localAddresses', [])[:8] if isinstance(info.get('localAddresses'), list) else []:
        try:
            address = ipaddress.ip_address(value)
            if address.is_private and not address.is_loopback and not address.is_unspecified:
                addresses.append(str(address))
        except (ValueError, TypeError):
            continue
    computer = info.get('computerName')
    os_version = info.get('osVersion')
    db.run('UPDATE devices SET computer_name=?,os_version=?,local_addresses=?,identity_seen_at=? WHERE id=?',
           (computer.strip()[:80] if isinstance(computer, str) else '',
            os_version.strip()[:120] if isinstance(os_version, str) else '',
            json.dumps(list(dict.fromkeys(addresses))), timestamp, device_id))


def device_summary(row, rooms, counts):
    row['online'] = any(did == row['id'] and not ws.closed for ws, did in rooms.sockets.get(row['class_id'], {}).items())
    row['local_addresses'] = json.loads(row.get('local_addresses') or '[]')
    row['class_device_count'] = counts.get(row['class_id'], 0)
    row['device_code'] = 'BB-' + row['id'].replace('-', '')[:8].upper() + '-' + row['id'].replace('-', '')[-4:].upper()
    return row


def school_code_valid(db, service, code):
    row = db.one('SELECT code_hash,expires_at FROM school_enrollment WHERE id=1')
    return bool(row and row['expires_at'] > service.now_ms() and
                hmac.compare_digest(row['code_hash'], service.sha256(service.normalize_code(code))))


def check_school_code(request, service, code):
    db = request.app[service.STORE_KEY]
    source = request.headers.get('X-Real-IP') or request.remote or 'unknown'
    key, now = service.sha256('enrollment\n' + source), service.now_ms()
    failure = db.one('SELECT * FROM login_failures WHERE key=?', (key,))
    if failure and (failure['blocked_until'] or 0) > now:
        return service.json_response({'error': '尝试过多，请稍后再试。'}, 429)
    if not school_code_valid(db, service, code):
        window = failure['window_started_at'] if failure and now-failure['window_started_at'] < 300000 else now
        attempts = failure['failures'] + 1 if failure and window == failure['window_started_at'] else 1
        db.run('INSERT INTO login_failures VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,window_started_at=excluded.window_started_at,blocked_until=excluded.blocked_until',
               (key, attempts, window, now+300000 if attempts >= 5 else None))
        return service.json_response({'error': '全校绑定码不正确、已关闭或已过期。'}, 403)
    db.run('DELETE FROM login_failures WHERE key=?', (key,))
    return None


class Management:
    def __init__(self, app, service):
        self.app, self.service = app, service
        self.db = app[service.STORE_KEY]

    async def confirmed(self, request, name):
        body = await self.service.read_json(request) or {}
        if body.get('confirmName') != name:
            return self.service.json_response({'error': '请准确输入名称以确认操作。'}, 400)
        return body

    def unlink_audio(self, paths):
        root = self.app[self.service.AUDIO_ROOT_KEY].resolve()
        for relative in paths:
            if not isinstance(relative, str) or not relative:
                continue
            target = (root / relative).resolve()
            if root not in target.parents:
                continue
            try:
                target.unlink(missing_ok=True)
            except OSError:
                self.app[self.service.LOGGER_KEY].warning('Could not remove cleared audio file: %s', target.name)

    async def rename_classes(self, request):
        user = self.service.require_admin(request)
        if isinstance(user, web.Response): return user
        body = await self.service.read_json(request) or {}
        changes = body.get('changes')
        if not isinstance(changes, list) or not 1 <= len(changes) <= 200:
            return self.service.json_response({'error': '请选择需要升班或更名的班级。'}, 400)
        proposed = {}
        for item in changes:
            if not isinstance(item, dict) or not isinstance(item.get('id'), str) or item['id'] in proposed:
                return self.service.json_response({'error': '班级选择重复或无效。'}, 400)
            name = self.service.normalize_class_name(item.get('name'))
            if not name:
                return self.service.json_response({'error': '班级名称应为 2 至 40 个字符。'}, 400)
            proposed[item['id']] = name
        if len(set(proposed.values())) != len(proposed):
            return self.service.json_response({'error': '更新后的班级名称不能重复。'}, 409)
        with self.db.transaction():
            original = {row['id']: row['name'] for row in self.db.all('SELECT id,name FROM classes')}
            if any(cid not in original for cid in proposed):
                return self.service.json_response({'error': '有班级已不存在，请刷新后重试。'}, 404)
            occupied = set(name for cid, name in original.items() if cid not in proposed)
            conflict = next((name for name in proposed.values() if name in occupied), None)
            if conflict:
                return self.service.json_response({'error': f'“{conflict}”仍由其他班级占用，请将那个班级一并更名。'}, 409)
            # Temporary unique names let several grades move together without colliding.
            for cid in proposed:
                self.db.run('UPDATE classes SET name=? WHERE id=?', ('moving-' + str(uuid.uuid4()), cid))
            for cid, name in proposed.items():
                self.db.run('UPDATE classes SET name=?,updated_at=? WHERE id=?', (name, self.service.now_ms(), cid))
                self.service.audit(self.db, user['id'], 'class.rename', 'class', cid,
                                   json.dumps({'previousName': original[cid], 'name': name}, ensure_ascii=False))
        for cid, name in proposed.items():
            await self.service.rooms(request).broadcast(cid, {'type': 'binding_updated', 'classId': cid, 'className': name})
        return self.service.json_response({'updated': len(proposed)})

    async def delete_class(self, request):
        user = self.service.require_admin(request)
        if isinstance(user, web.Response): return user
        cid = request.match_info['class_id']
        row = self.db.one('SELECT name FROM classes WHERE id=?', (cid,))
        if not row: return self.service.json_response({'error': '班级不存在。'}, 404)
        body = await self.confirmed(request, row['name'])
        if isinstance(body, web.Response): return body
        paths = [r['audio_path'] for table in ('shouts', 'classroom_voice_messages')
                 for r in self.db.all(f'SELECT audio_path FROM {table} WHERE class_id=?', (cid,))]
        with self.db.transaction():
            self.db.run('DELETE FROM reading_events WHERE class_id=?', (cid,))
            self.db.run('DELETE FROM reading_session_days WHERE session_id IN (SELECT id FROM reading_sessions WHERE class_id=?)', (cid,))
            self.db.run('DELETE FROM reading_sessions WHERE class_id=?', (cid,))
            self.db.run('DELETE FROM reading_buckets WHERE class_id=?', (cid,))
            for table in ('reading_launches', 'reading_browser_sessions', 'device_telemetry'):
                self.db.run(f'DELETE FROM {table} WHERE device_id IN (SELECT id FROM devices WHERE class_id=?)', (cid,))
            self.db.run('DELETE FROM classroom_controls WHERE class_id=?', (cid,))
            self.db.run('DELETE FROM classroom_voice_messages WHERE class_id=?', (cid,))
            self.db.run('DELETE FROM shouts WHERE class_id=?', (cid,))
            self.db.run('DELETE FROM devices WHERE class_id=?', (cid,))
            self.db.run('DELETE FROM classes WHERE id=?', (cid,))
            self.service.audit(self.db, user['id'], 'class.delete', 'class', cid, json.dumps({'name': row['name']}, ensure_ascii=False))
        await self.service.rooms(request).disconnect_all(cid)
        self.unlink_audio(paths)
        return self.service.json_response({'deleted': True})

    async def delete_user(self, request):
        user = self.service.require_admin(request)
        if isinstance(user, web.Response): return user
        uid = request.match_info['teacher_id']
        row = self.db.one('SELECT username,role FROM users WHERE id=? AND deleted_at IS NULL', (uid,))
        if not row: return self.service.json_response({'error': '账号不存在。'}, 404)
        if row['role'] == 'superadmin' or uid == user['id']:
            return self.service.json_response({'error': '不能删除超级管理员 ICe。'}, 403)
        body = await self.confirmed(request, row['username'])
        if isinstance(body, web.Response): return body
        with self.db.transaction():
            # Keep the historical author and audit references, revoke credentials and free the username.
            self.db.run('UPDATE users SET username=?,password_hash=?,enabled=0,deleted_at=?,updated_at=? WHERE id=?',
                        ('deleted-' + uid, self.service.hash_password(self.service.random_token()), self.service.now_ms(), self.service.now_ms(), uid))
            self.db.run('DELETE FROM sessions WHERE user_id=?', (uid,))
            self.db.run('DELETE FROM teacher_classes WHERE user_id=?', (uid,))
            self.db.run('DELETE FROM classroom_voice_receipts WHERE user_id=?', (uid,))
            self.service.audit(self.db, user['id'], 'user.delete', 'user', uid, json.dumps({'username': row['username']}, ensure_ascii=False))
        return self.service.json_response({'deleted': True})

    async def delete_device(self, request):
        user = self.service.require_admin(request)
        if isinstance(user, web.Response): return user
        did = request.match_info['device_id']
        row = self.db.one('SELECT name,class_id FROM devices WHERE id=? AND deleted_at IS NULL', (did,))
        if not row: return self.service.json_response({'error': '设备不存在。'}, 404)
        body = await self.confirmed(request, row['name'])
        if isinstance(body, web.Response): return body
        paths = [r['audio_path'] for r in self.db.all('SELECT audio_path FROM classroom_voice_messages WHERE device_id=?', (did,))]
        with self.db.transaction():
            self.db.run('UPDATE devices SET enabled=0,token_hash=?,deleted_at=?,updated_at=? WHERE id=?',
                        (self.service.sha256(self.service.random_token()), self.service.now_ms(), self.service.now_ms(), did))
            self.db.run('DELETE FROM reading_launches WHERE device_id=?', (did,))
            self.db.run('DELETE FROM reading_browser_sessions WHERE device_id=?', (did,))
            self.db.run('DELETE FROM classroom_voice_messages WHERE device_id=?', (did,))
            self.service.audit(self.db, user['id'], 'device.delete', 'device', did, json.dumps({'name': row['name'], 'classId': row['class_id']}, ensure_ascii=False))
        await self.service.rooms(request).disconnect_device(row['class_id'], did)
        self.unlink_audio(paths)
        return self.service.json_response({'deleted': True})

    async def clear_records(self, request):
        user = self.service.require_admin(request)
        if isinstance(user, web.Response): return user
        cid = request.match_info['class_id']
        row = self.db.one('SELECT name FROM classes WHERE id=?', (cid,))
        if not row: return self.service.json_response({'error': '班级不存在。'}, 404)
        body = await self.confirmed(request, row['name'])
        if isinstance(body, web.Response): return body
        kind = body.get('kind')
        if kind not in ('reading', 'history', 'voice'):
            return self.service.json_response({'error': '请选择需要清理的记录类型。'}, 400)
        if body.get('allDates') is True:
            start, end = '0001-01-01', '9998-12-31'
        else:
            try:
                start = date.fromisoformat(body.get('start', '')).isoformat()
                end = date.fromisoformat(body.get('end', '')).isoformat()
                if start > end or end > '9998-12-31': raise ValueError()
            except (ValueError, TypeError):
                return self.service.json_response({'error': '请选择有效的起止日期。'}, 400)
        paths, count = [], 0
        with self.db.transaction():
            if kind == 'reading':
                for table in ('reading_events', 'reading_buckets'):
                    count += self.db.run(f'DELETE FROM {table} WHERE class_id=? AND day BETWEEN ? AND ?', (cid, start, end)).rowcount
                self.db.run('DELETE FROM reading_session_days WHERE day BETWEEN ? AND ? AND session_id IN (SELECT id FROM reading_sessions WHERE class_id=?)', (start, end, cid))
            else:
                table = 'shouts' if kind == 'history' else 'classroom_voice_messages'
                # Avoid timestamps outside the platform's supported datetime range for an all-date cleanup.
                if body.get('allDates') is True:
                    condition, params = 'class_id=?', (cid,)
                else:
                    first = int(datetime.combine(date.fromisoformat(start), datetime.min.time(), SHANGHAI).timestamp() * 1000)
                    last = int(datetime.combine(date.fromisoformat(end) + timedelta(days=1), datetime.min.time(), SHANGHAI).timestamp() * 1000)
                    condition, params = 'class_id=? AND created_at>=? AND created_at<?', (cid, first, last)
                paths = [r['audio_path'] for r in self.db.all(f'SELECT audio_path FROM {table} WHERE {condition}', params)]
                count = self.db.run(f'DELETE FROM {table} WHERE {condition}', params).rowcount
            self.service.audit(self.db, user['id'], 'class.records_clear', 'class', cid, json.dumps({'kind': kind, 'start': start, 'end': end, 'count': count}))
        self.unlink_audio(paths)
        return self.service.json_response({'cleared': True, 'count': count})

    async def school_status(self, request):
        user = self.service.require_admin(request)
        if isinstance(user, web.Response): return user
        row = self.db.one('SELECT expires_at FROM school_enrollment WHERE id=1')
        return self.service.json_response({'enabled': bool(row and row['expires_at'] > self.service.now_ms()), 'expiresAt': row['expires_at'] if row else None})

    async def school_code(self, request):
        user = self.service.require_admin(request)
        if isinstance(user, web.Response): return user
        body = await self.service.read_json(request) or {}
        code = str(body.get('code') or '').strip()
        if not code:
            alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
            code = ''.join(secrets.choice(alphabet) for _ in range(10))
        if not 5 <= len(code) <= 40 or not code.isascii() or not code.replace('-', '').isalnum():
            return self.service.json_response({'error': '绑定码需要 5 至 40 位英文字母或数字，可包含短横线。'}, 400)
        days = body.get('validDays', 30)
        if type(days) is not int or days not in (1, 7, 30, 90):
            return self.service.json_response({'error': '请选择有效的绑定码有效期。'}, 400)
        now = self.service.now_ms()
        expires = now + days * 86400000
        with self.db.transaction():
            self.db.run('INSERT INTO school_enrollment VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,created_at=excluded.created_at',
                        (self.service.sha256(self.service.normalize_code(code)), expires, now))
            self.service.audit(self.db, user['id'], 'enrollment.school_open', 'school', None, json.dumps({'validDays': days}))
        return self.service.json_response({'code': code, 'expiresAt': expires, 'enabled': True})

    async def close_school_code(self, request):
        user = self.service.require_admin(request)
        if isinstance(user, web.Response): return user
        with self.db.transaction():
            self.db.run('DELETE FROM school_enrollment')
            self.service.audit(self.db, user['id'], 'enrollment.school_close', 'school', None, None)
        return self.service.json_response({'enabled': False})

    async def enrollment_classes(self, request):
        body = await self.service.read_json(request) or {}
        code = self.service.normalize_code(body.get('code', ''))
        if not code or len(code) > 40:
            return self.service.json_response({'error': '请输入有效的全校绑定码。'}, 400)
        denied = check_school_code(request, self.service, code)
        if denied is not None: return denied
        rows = self.db.all('SELECT id,name FROM classes WHERE enabled=1 ORDER BY name')
        rows.sort(key=lambda row: self.service.class_sort_key(row['name']))
        return self.service.json_response({'classes': rows})

"""Bounded client fault reports, readable only by the school service owner."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import re
import uuid

from aiohttp import web
from teacher_capabilities import teacher_manual, teacher_read

MAX_REPORT_BYTES = 1024 * 1024
MAX_STORED_BYTES = 64 * 1024 * 1024
WEEK = 7 * 86400000
SHANGHAI = timezone(timedelta(hours=8))


def redact(text: str) -> str:
    text = re.sub(r'''(?im)(["']?(?:Set-)?Cookie["']?\s*[:=])[^\r\n]*''', r'\1 [已隐藏]', text)
    text = re.sub(r'''(?i)(["']?Authorization["']?\s*[:=]\s*["']?)(?:Bearer|Basic)\s+[^\s"']+''', r'\1[已隐藏]', text)
    text = re.sub(r'''(?i)(["']?(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|device[_-]?token|csrf(?:[_-]?token)?|iceclass_session|token|secret)["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n]+)''', r'\1[已隐藏]', text)
    text = re.sub(r'(?i)(https?://)[^/\s@]+@', r'\1[已隐藏]@', text)
    return re.sub(r'\bsk-[A-Za-z0-9_-]{12,}\b', '[已隐藏]', text)


def cleanup_client_diagnostics(db, timestamp: int) -> None:
    """Once each Monday at 03:00 CST, catch up after downtime on next cleanup."""
    now = datetime.fromtimestamp(timestamp / 1000, SHANGHAI)
    scheduled = (now - timedelta(days=now.weekday())).replace(hour=3, minute=0, second=0, microsecond=0)
    if now < scheduled:
        scheduled -= timedelta(days=7)
    week = int(scheduled.timestamp() * 1000)
    with db.transaction():
        previous = db.one('SELECT last_week FROM client_diagnostic_maintenance WHERE id=1')['last_week']
        if previous >= week:
            return
        db.run('DELETE FROM client_diagnostics WHERE received_at<?', (week - WEEK,))
        db.run('UPDATE client_diagnostic_maintenance SET last_week=? WHERE id=1', (week,))


def install_client_diagnostics(app: web.Application, service) -> None:
    db = app[service.STORE_KEY]
    db.db.executescript('''
        CREATE TABLE IF NOT EXISTS client_diagnostics (
            id TEXT PRIMARY KEY, edition TEXT NOT NULL, kind TEXT NOT NULL,
            owner_id TEXT NOT NULL, installation_id TEXT NOT NULL, device_name TEXT NOT NULL,
            device_id TEXT, class_id TEXT, actor_label TEXT NOT NULL DEFAULT '',
            version TEXT NOT NULL, summary TEXT NOT NULL, report TEXT NOT NULL,
            received_at INTEGER NOT NULL, byte_size INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_client_diagnostic_time ON client_diagnostics(received_at DESC);
        CREATE INDEX IF NOT EXISTS idx_client_diagnostic_owner ON client_diagnostics(owner_id, kind, received_at DESC);
        CREATE TABLE IF NOT EXISTS client_diagnostic_maintenance (id INTEGER PRIMARY KEY CHECK(id=1), last_week INTEGER NOT NULL);
        INSERT OR IGNORE INTO client_diagnostic_maintenance VALUES(1,0);
    ''')

    def admin(request):
        if service.is_classroom_request(request):
            return service.json_response({'error': '仅超级管理员可查看客户端日志。'}, 403)
        user = service.require_user(request)
        if isinstance(user, web.Response):
            return user
        return user if user['role'] == 'superadmin' else service.json_response({'error': '仅超级管理员可查看客户端日志。'}, 403)

    @teacher_manual('诊断由本机收集器自动上报错误，或由本人在关于页面提交，不能由模型代读本机日志。')
    async def submit(request):
        device = None
        if service.is_classroom_request(request):
            device = service.authenticate_device(request, request.headers.get('X-ICeClass-Device', ''))
            if not device:
                return service.json_response({'error': '教室绑定已失效，请重新绑定后提交。'}, 401)
            binding = db.one('SELECT d.name, c.name AS class_name FROM devices d JOIN classes c ON c.id=d.class_id WHERE d.id=?', (device['id'],))
            owner, edition = 'device:' + device['id'], 'classroom'
            label = binding['class_name'] + ' · ' + binding['name']
        else:
            user = service.require_user(request)
            if isinstance(user, web.Response):
                return user
            owner, edition = 'user:' + user['id'], 'teacher'
            label = user['displayName'] + '（' + user['username'] + '）'
        try:
            raw = bytearray()
            async for chunk in request.content.iter_chunked(65536):
                raw.extend(chunk)
                if len(raw) > 2 * MAX_REPORT_BYTES + 16384:
                    raise ValueError()
            body = json.loads(raw)
            fields = {'id', 'edition', 'kind', 'version', 'installationId', 'deviceName', 'summary', 'report'}
            if not isinstance(body, dict) or set(body) - fields or body.get('edition') != edition:
                raise ValueError()
            limits = {'kind': 10, 'version': 40, 'installationId': 40, 'deviceName': 80, 'summary': 200, 'report': MAX_REPORT_BYTES}
            for key, maximum in limits.items():
                value = body.get(key, '')
                if not isinstance(value, str) or len(value) > maximum or '\x00' in value:
                    raise ValueError()
            if body['kind'] not in ('manual', 'error') or not service.parse_release_version(body['version']):
                raise ValueError()
            uuid.UUID(body['installationId'])
            identifier = str(uuid.UUID(body.get('id', str(uuid.uuid4()))))
            report = redact(body['report'].strip())
            size = len(report.encode('utf-8'))
            if not size or size > (MAX_REPORT_BYTES if body['kind'] == 'manual' else 65536):
                raise ValueError()
        except (ValueError, TypeError, KeyError, AttributeError, UnicodeError):
            return service.json_response({'error': '诊断内容或设备信息不正确，完整日志最多 1 MB。'}, 400)
        # Reading a large body yields: recheck live ownership before storing it.
        if device:
            current = service.authenticate_device(request, device['id'])
            if not current or current['class_id'] != device['class_id']:
                return service.json_response({'error': '教室绑定已变化，请重新提交诊断。'}, 401)
        else:
            current = service.require_user(request)
            if isinstance(current, web.Response):
                return current
            if current['id'] != user['id']:
                return service.json_response({'error': '登录已变化，请重新提交诊断。'}, 401)
        existing = db.one('SELECT owner_id FROM client_diagnostics WHERE id=?', (identifier,))
        if existing:
            if existing['owner_id'] != owner:
                return service.json_response({'error': '诊断编号已被使用，请重新提交。'}, 409)
            return service.json_response({'id': identifier, 'status': 'stored'}, 201)
        now = service.now_ms()
        window = 600000 if body['kind'] == 'manual' else 60000
        recent = db.one('SELECT count(*) AS n FROM client_diagnostics WHERE owner_id=? AND kind=? AND received_at>?', (owner, body['kind'], now - window))
        if recent['n'] >= 3:
            return service.json_response({'error': '诊断提交较频繁，请稍后重试。'}, 429)
        with db.transaction():
            db.run('''INSERT INTO client_diagnostics(id,edition,kind,owner_id,installation_id,device_name,device_id,class_id,actor_label,version,summary,report,received_at,byte_size)
                      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                   (identifier, edition, body['kind'], owner, body['installationId'], redact(body['deviceName']),
                    device['id'] if device else None, device['class_id'] if device else None, label,
                    body['version'], redact(body['summary']), report, now, size))
            # A hard storage budget also limits error storms between weekly cleanups.
            db.run('''DELETE FROM client_diagnostics WHERE id IN (
                SELECT id FROM (SELECT id, SUM(byte_size) OVER (ORDER BY received_at DESC, rowid DESC) AS used,
                ROW_NUMBER() OVER (ORDER BY received_at DESC, rowid DESC) AS position FROM client_diagnostics)
                WHERE used>? OR position>2000)''', (MAX_STORED_BYTES,))
        return service.json_response({'id': identifier, 'status': 'stored'}, 201)

    def item(row, detail=False):
        value = dict(id=row['id'], edition=row['edition'], kind=row['kind'], installationId=row['installation_id'],
                     deviceName=row['device_name'], deviceId=row['device_id'], classId=row['class_id'],
                     actor=row['actor_label'], version=row['version'], summary=row['summary'], receivedAt=row['received_at'])
        if detail:
            value['report'] = row['report']
        return value

    @teacher_read('diagnostics', '查看客户端故障日志', fields='edition kind q version since until limit offset', roles=('superadmin',))
    async def listing(request):
        user = admin(request)
        if isinstance(user, web.Response):
            return user
        clauses, arguments = [], []
        try:
            for key in ('edition', 'kind', 'version'):
                if value := request.query.get(key):
                    if len(value) > 40:
                        raise ValueError()
                    clauses.append(key + '=?'); arguments.append(value)
            if query := request.query.get('q', '').strip():
                if len(query) > 100:
                    raise ValueError()
                clauses.append('(actor_label LIKE ? OR device_name LIKE ? OR summary LIKE ?)')
                arguments.extend(['%' + query + '%'] * 3)
            for key, operator in (('since', '>='), ('until', '<')):
                if value := request.query.get(key):
                    clauses.append('received_at' + operator + '?'); arguments.append(int(value))
            limit = max(1, min(50, int(request.query.get('limit', '20'))))
            offset = max(0, int(request.query.get('offset', '0')))
        except ValueError:
            return service.json_response({'error': '筛选条件不正确，请重新选择。'}, 400)
        where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
        total = db.one('SELECT count(*) AS n FROM client_diagnostics' + where, tuple(arguments))['n']
        rows = db.all('SELECT * FROM client_diagnostics' + where + ' ORDER BY received_at DESC,rowid DESC LIMIT ? OFFSET ?', (*arguments, limit, offset))
        return service.json_response({'items': [item(row) for row in rows], 'total': total})

    @teacher_read('diagnostic.detail', '查看客户端诊断详情', roles=('superadmin',))
    async def detail(request):
        user = admin(request)
        if isinstance(user, web.Response):
            return user
        row = db.one('SELECT * FROM client_diagnostics WHERE id=?', (request.match_info['report_id'],))
        return service.json_response(item(row, True)) if row else service.json_response({'error': '日志不存在或已按周清理。'}, 404)

    app.router.add_post('/api/client-diagnostics', submit)
    app.router.add_get('/api/client-diagnostics', listing)
    app.router.add_get('/api/client-diagnostics/{report_id}', detail)

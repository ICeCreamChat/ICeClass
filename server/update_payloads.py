"""Validated update plans and downloads from a content-addressed payload directory."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import stat
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode

from aiohttp import web
from teacher_capabilities import teacher_manual


MAX_FILE_SIZE = 1024 ** 3
MAX_TOTAL_SIZE = 2 * MAX_FILE_SIZE
RESERVED_NAMES = {'CON', 'PRN', 'AUX', 'NUL',
                  *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}


def digest_value(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-fA-F0-9]{64}', value):
        raise ValueError('Invalid SHA-256')
    return value.lower()


def validate_plan(data, executable, parse_version):
    """Validate logical Windows targets independently of the payloads on disk."""
    if not isinstance(data, dict) or parse_version(data.get('version')) is None:
        raise ValueError('Invalid plan version')
    files = data.get('files')
    if not isinstance(files, list) or not 1 <= len(files) <= 128:
        raise ValueError('Invalid file count')
    targets = {}
    total = 0
    validated = []
    for item in files:
        if not isinstance(item, dict):
            raise ValueError('Invalid file entry')
        path = item.get('path')
        if not isinstance(path, str) or not (
                path == executable or (executable == 'ICeClass.exe'
                    and re.fullmatch(r'VoiceResources/[A-Za-z0-9_.\-/]+', path))):
            raise ValueError('Unsupported target path')
        parts = path.split('/')
        for index, part in enumerate(parts):
            if (not part or part in ('.', '..') or part.endswith('.')
                    or part.split('.')[0].upper() in RESERVED_NAMES):
                raise ValueError('Unsafe Windows path')
            prefix = '/'.join(parts[:index + 1])
            key = prefix.casefold()
            is_file = index == len(parts) - 1
            previous = targets.get(key)
            if previous is not None and (previous != (prefix, False) or is_file):
                raise ValueError('Conflicting target paths')
            targets[key] = (prefix, is_file)
        size = item.get('size')
        if type(size) is not int or not 0 < size <= MAX_FILE_SIZE:
            raise ValueError('Invalid file size')
        total += size
        if total > MAX_TOTAL_SIZE:
            raise ValueError('Update exceeds total size limit')
        digest = digest_value(item.get('sha256'))
        deltas = item.get('deltas', [])
        if not isinstance(deltas, list):
            raise ValueError('Invalid deltas')
        patches = []
        for delta in deltas:
            if not isinstance(delta, dict):
                raise ValueError('Invalid delta entry')
            patch_size = delta.get('size')
            if type(patch_size) is not int or not 0 < patch_size < size:
                raise ValueError('Patch must be smaller than its target')
            patches.append({'sourceSha256': digest_value(delta.get('sourceSha256')),
                            'size': patch_size, 'sha256': digest_value(delta.get('sha256'))})
        validated.append({'path': path, 'size': size, 'sha256': digest, 'deltas': patches})
    return {'version': data['version'], 'files': validated}


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def payload_digest(stream):
    digest = hashlib.sha256()
    while chunk := stream.read(1024 * 1024):
        digest.update(chunk)
    return digest.hexdigest()


class UpdatePayloads:
    def __init__(self, root, executable, parse_version):
        self.root = Path(root).resolve()
        self.executable = executable
        self.parse_version = parse_version
        self.verified = {}
        self.lock = asyncio.Lock()

    async def load(self):
        # Serialize first-time verification without blocking the event loop or
        # filling the executor with other requests waiting for the same hash.
        async with self.lock:
            return await asyncio.to_thread(self._load)

    def _load(self):
        try:
            data = json.loads((self.root / 'update-plan.json').read_text(encoding='utf-8-sig'))
            plan = validate_plan(data, self.executable, self.parse_version)
            sizes = {}
            for item in plan['files']:
                for payload in (item, *item['deltas']):
                    digest, size = payload['sha256'], payload['size']
                    if digest in sizes and sizes[digest] != size:
                        raise ValueError('Conflicting payload sizes')
                    sizes[digest] = size
            verified = {}
            for digest, size in sizes.items():
                target = self.root / 'payloads' / digest
                info = target.lstat()
                if (not stat.S_ISREG(info.st_mode) or info.st_size != size
                        or target.resolve(strict=True) != target):
                    raise ValueError('Missing or invalid payload')
                identity = file_identity(info)
                if self.verified.get(digest) != identity:
                    with target.open('rb') as stream:
                        actual = payload_digest(stream)
                    if actual != digest or file_identity(target.stat()) != identity:
                        raise ValueError('Payload integrity check failed')
                verified[digest] = identity
            # Retain only hashes belonging to this complete, current plan.
            self.verified = verified
            return plan, sizes
        except (OSError, UnicodeError, ValueError):
            self.verified = {}
            return None


class PayloadResponse(web.FileResponse):
    async def prepare(self, request):
        # FileResponse otherwise selects .gz/.br siblings, which have not been
        # verified and are not members of the content-addressed allowlist.
        headers = request.headers.copy()
        headers.popall('Accept-Encoding', None)
        return await super().prepare(request.clone(headers=headers))


def install_update_payloads(app, root, *, executable, prefix, reply, parse_version, authenticate=None):
    payloads = UpdatePayloads(root, executable, parse_version)

    async def plan(request):
        device = authenticate(request) if authenticate else None
        if authenticate and not device:
            return reply({'error': '教室身份验证失败。'}, 401)
        current = parse_version(request.query.get('currentVersion', ''))
        if current is None:
            return reply({'error': '当前版本号格式不正确。'}, 400)
        release = await payloads.load()
        if release is None:
            return reply({'available': False})
        data, _ = release
        if parse_version(data['version']) <= current:
            return reply({'available': False, 'version': data['version']})

        def with_url(item):
            query = {'sha256': item['sha256']}
            if device:
                query['deviceId'] = device['id']
            return {**item, 'downloadUrl': f'{prefix}/payload?{urlencode(query)}'}

        files = [{**with_url(item), 'deltas': [with_url(delta) for delta in item['deltas']]}
                 for item in data['files']]
        return reply({'available': True, 'version': data['version'], 'files': files})

    async def payload(request):
        if authenticate and not authenticate(request):
            return reply({'error': '教室身份验证失败。'}, 401)
        try:
            digest = digest_value(request.query.get('sha256'))
        except ValueError:
            return reply({'error': '更新文件不存在。'}, 404)
        release = await payloads.load()
        if release is None or digest not in release[1]:
            return reply({'error': '更新文件不存在。'}, 404)
        return PayloadResponse(payloads.root / 'payloads' / digest, headers={
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': f'attachment; filename="{digest}"',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        })

    app.router.add_get(f'{prefix}/plan', plan)
    app.router.add_get(f'{prefix}/payload', payload)

    if executable == 'ICeClass.exe':
        @teacher_manual('本机语音模型按校验和下载的资源传输协议，不通过班班读取模型文件。')
        async def voice_resource(request):
            try:
                digest = digest_value(request.match_info['sha256'])
            except ValueError:
                return reply({'error': '语音资源不存在。'}, 404)
            release = await payloads.load()
            if release is None or not any(item['path'].startswith('VoiceResources/') and item['sha256'] == digest
                                          for item in release[0]['files']):
                return reply({'error': '语音资源不存在。'}, 404)
            return PayloadResponse(payloads.root / 'payloads' / digest, headers={
                'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            })
        app.router.add_get('/api/voice/resources/{sha256}', voice_resource)


def install_desktop_update_activity(app, service):
    async def activity(request):
        from island import defaults, lessons_on, normalize
        from permissions import scope_sql
        from reading import SHANGHAI, class_grade

        user = service.require_user(request)
        if isinstance(user, web.Response):
            return user
        if user.get('classroom'):
            return service.json_response({'error': '请使用教师账号登录。'}, 403)
        clause, params = scope_sql(user)
        profiles = service.store(request).all(f'''SELECT c.name,p.value FROM classes c
            LEFT JOIN island_profiles p ON p.class_id=c.id WHERE c.enabled=1 AND ({clause})''', params)
        now = service.now_ms()
        today = datetime.fromtimestamp(now / 1000, SHANGHAI).replace(hour=0, minute=0, second=0, microsecond=0)
        valid_until = min(now + 15_000, int((today + timedelta(days=1)).timestamp() * 1000))
        known, in_class = bool(profiles), False
        for profile in profiles:
            try:
                # Match IslandFeature.profile: unsaved classes use the grade's
                # effective school defaults; saved profiles take precedence.
                config = normalize(json.loads(profile['value']) if profile['value'] is not None
                                   else defaults(class_grade(profile['name'])))
                if not config['slots']:
                    raise ValueError('Unavailable timetable')
                lessons = lessons_on(config, today.date())
                # An explicit timetable can legitimately have no lessons today,
                # including Sundays, parity weeks and cancelled lessons.
                for lesson in lessons:
                    start = int((today + timedelta(minutes=lesson['start'])).timestamp() * 1000)
                    end = int((today + timedelta(minutes=lesson['end'])).timestamp() * 1000)
                    in_class |= start <= now < end
                    for boundary in (start, end):
                        if boundary > now:
                            valid_until = min(valid_until, boundary)
            except (TypeError, ValueError, KeyError):
                known = False
                break
        return service.json_response({'known': known, 'inClass': in_class if known else True,
                                      'validUntil': valid_until})

    app.router.add_get('/api/desktop/update/activity', activity)

"""Device-bound student ideas, private review, and a durable daily mail digest."""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import struct
import time
import uuid
import zlib
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr
from pathlib import Path

from aiohttp import web
from aiohttp.multipart import BodyPartReader

from feedback import image_type, mail_settings, send_mail
from teacher_capabilities import teacher_action, teacher_read


MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_MEDIA_BYTES = 2 * 1024 * 1024
MAX_REPORT_BYTES = 24576
MAX_REVIEW_BYTES = 49152
STATUS_LABELS = {'pending': '待评审', 'adopted': '已采纳', 'implementing': '实现中',
                 'launched': '已上线', 'declined': '暂不采纳'}
PUBLIC_STATUSES = {'adopted', 'implementing', 'launched'}
SHANGHAI = timezone(timedelta(hours=8), 'Asia/Shanghai')
RETRY_MS = 5 * 60_000


def now_ms() -> int:
    return int(time.time() * 1000)


def daily_at(timestamp: int, *, following=False) -> int:
    local = datetime.fromtimestamp(timestamp / 1000, SHANGHAI)
    scheduled = local.replace(hour=18, minute=0, second=0, microsecond=0)
    if following:
        scheduled += timedelta(days=1)
    return int(scheduled.timestamp() * 1000)


def next_daily_at(timestamp: int) -> int:
    today = daily_at(timestamp)
    return today if today > timestamp else daily_at(timestamp, following=True)


def text_value(value, maximum: int) -> str:
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError('文字长度或格式不正确。')
    if any(ord(char) < 32 and char not in '\r\n\t' or 0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise ValueError('文字包含无效字符。')
    return value.strip()


def json_object(raw: bytes) -> dict:
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('JSON 字段重复。')
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError('JSON 数值无效。')

    result = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_pairs, parse_constant=invalid_constant)
    if not isinstance(result, dict):
        raise ValueError('内容必须为 JSON 对象。')
    return result


def validate_png_pixels(data: bytes, compressed: list[bytes]) -> None:
    width, height, depth, color, compression, filtering, interlaced = struct.unpack('>IIBBBBB', data[16:29])
    depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
    if color not in depths or depth not in depths[color] or compression or filtering or interlaced not in (0, 1):
        raise ValueError('PNG 像素格式无效。')
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    passes = ((0, 0, 1, 1),) if not interlaced else (
        (0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
        (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2))
    expected = 0
    for x, y, dx, dy in passes:
        columns, rows = max(0, (width - x + dx - 1) // dx), max(0, (height - y + dy - 1) // dy)
        if columns and rows:
            expected += rows * (1 + (columns * depth * channels + 7) // 8)
    decoder, actual = zlib.decompressobj(), 0
    try:
        for part in compressed:
            pending = part
            while pending:
                output = decoder.decompress(pending, 65536)
                actual += len(output)
                if actual > expected or decoder.unused_data:
                    raise ValueError('PNG 像素数据长度无效。')
                pending = decoder.unconsumed_tail
        if not decoder.eof or actual != expected:
            raise ValueError('PNG 像素数据不完整。')
    except zlib.error:
        raise ValueError('PNG 图像压缩数据无效。') from None


def validate_image(data: bytes) -> tuple[str, str]:
    """Use feedback's type detection, then reject incomplete image containers."""
    detected = image_type(data)
    if detected is None:
        raise ValueError('图片需为有效的 PNG、JPG 或 WebP。')
    subtype, extension = detected
    if subtype == 'png':
        offset, compressed, ended = 8, [], False
        while offset + 12 <= len(data):
            size = int.from_bytes(data[offset:offset + 4], 'big')
            kind = data[offset + 4:offset + 8]
            end = offset + 12 + size
            if end > len(data) or zlib.crc32(data[offset + 4:end - 4]) != int.from_bytes(data[end - 4:end], 'big'):
                raise ValueError('PNG 图片不完整。')
            if offset == 8 and (kind != b'IHDR' or size != 13):
                raise ValueError('PNG 图片头无效。')
            if kind == b'IHDR' and offset != 8:
                raise ValueError('PNG 图片头重复。')
            if kind == b'IDAT' and size:
                compressed.append(data[offset + 8:end - 4])
            if kind == b'IEND':
                ended = size == 0 and end == len(data)
                break
            offset = end
        if not compressed or not ended:
            raise ValueError('PNG 图片不完整。')
        validate_png_pixels(data, compressed)
    elif subtype == 'jpeg':
        offset, dimensions, scan = 2, False, False
        while offset < len(data) - 2:
            if data[offset] != 255:
                raise ValueError('JPG 图片结构无效。')
            while offset < len(data) and data[offset] == 255:
                offset += 1
            if offset >= len(data):
                break
            marker = data[offset]
            offset += 1
            if marker in (0, 0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                raise ValueError('JPG 图片结构无效。')
            if offset + 2 > len(data):
                break
            size = int.from_bytes(data[offset:offset + 2], 'big')
            if size < 2 or offset + size > len(data) - 2:
                raise ValueError('JPG 图片不完整。')
            if marker in (0xC0, 0xC1, 0xC2):
                if size < 8:
                    raise ValueError('JPG 图片头无效。')
                height = int.from_bytes(data[offset + 3:offset + 5], 'big')
                width = int.from_bytes(data[offset + 5:offset + 7], 'big')
                dimensions = 0 < width <= 16384 and 0 < height <= 16384 and width * height <= 40_000_000
            offset += size
            if marker == 0xDA:
                scan = offset < len(data) - 2
                break
        if not dimensions or not scan:
            raise ValueError('JPG 图片没有有效图像数据。')
    else:
        offset, pixels = 12, False
        while offset + 8 <= len(data):
            kind = data[offset:offset + 4]
            size = int.from_bytes(data[offset + 4:offset + 8], 'little')
            payload = data[offset + 8:offset + 8 + size]
            end = offset + 8 + size + size % 2
            if end > len(data):
                raise ValueError('WebP 图片不完整。')
            if kind == b'VP8 ' and size >= 10 and payload[3:6] == b'\x9d\x01\x2a':
                width = int.from_bytes(payload[6:8], 'little') & 0x3FFF
                height = int.from_bytes(payload[8:10], 'little') & 0x3FFF
                pixels = 0 < width and 0 < height and width * height <= 40_000_000
            elif kind == b'VP8L' and size >= 5 and payload[0] == 0x2F:
                bits = int.from_bytes(payload[1:5], 'little')
                width, height = (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
                pixels = bits >> 29 == 0 and width * height <= 40_000_000
            offset = end
        if offset != len(data) or not pixels:
            raise ValueError('WebP 图片没有有效图像数据。')
    return 'image/' + subtype, extension


def validate_wav(data: bytes) -> int:
    if len(data) < 44 or data[:4] != b'RIFF' or data[8:12] != b'WAVE' or int.from_bytes(data[4:8], 'little') != len(data) - 8:
        raise ValueError('录音需为完整的 WAV 文件。')
    offset, have_format, audio_size = 12, False, None
    while offset + 8 <= len(data):
        kind = data[offset:offset + 4]
        size = int.from_bytes(data[offset + 4:offset + 8], 'little')
        start, end = offset + 8, offset + 8 + size
        if end + size % 2 > len(data):
            raise ValueError('录音数据不完整。')
        if kind == b'fmt ':
            if have_format or size not in (16, 18):
                raise ValueError('录音格式无效。')
            if struct.unpack_from('<HHIIHH', data, start) != (1, 1, 16000, 32000, 2, 16):
                raise ValueError('录音需为 16 kHz 单声道 PCM16。')
            if size == 18 and data[start + 16:end] != b'\0\0':
                raise ValueError('录音格式无效。')
            have_format = True
        elif kind == b'data':
            if not have_format or audio_size is not None or size == 0 or size % 2 or size > 60 * 32000:
                raise ValueError('录音需在 60 秒内且包含有效音频。')
            audio_size = size
        offset = end + size % 2
    if offset != len(data) or not have_format or audio_size is None:
        raise ValueError('录音数据不完整。')
    return (audio_size * 1000 + 31999) // 32000


class Ideas:
    def __init__(self, app: web.Application, service):
        self.app, self.service = app, service
        self.db = app[service.STORE_KEY]
        self.media_root = Path(self.db.one('PRAGMA database_list')['file']).parent / 'ideas-media'
        self.logger = app[service.LOGGER_KEY]
        self.enabled = os.environ.get('ICECLASS_IDEAS_DIGEST_ENABLED', 'true').strip().lower() not in ('false', '0', 'no', 'off')
        self.digest_lock = asyncio.Lock()
        self.task: asyncio.Task | None = None
        self._schema()

    def _schema(self):
        self.db.db.executescript("""
            CREATE TABLE IF NOT EXISTS ideas_digest_batches (
                id TEXT PRIMARY KEY, scheduled_at INTEGER NOT NULL, body TEXT NOT NULL,
                sent_at INTEGER, created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ideas (
                id TEXT PRIMARY KEY, request_id TEXT NOT NULL, device_id TEXT NOT NULL,
                class_id TEXT NOT NULL, class_name TEXT NOT NULL, title TEXT NOT NULL,
                text TEXT NOT NULL, name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','adopted','implementing','launched','declined')),
                reply TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                version INTEGER NOT NULL DEFAULT 1, published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
                published_title TEXT NOT NULL DEFAULT '', published_text TEXT NOT NULL DEFAULT '',
                digest_batch_id TEXT REFERENCES ideas_digest_batches(id),
                UNIQUE(class_id,device_id,request_id)
            );
            CREATE TABLE IF NOT EXISTS ideas_media (
                id TEXT PRIMARY KEY, idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK(kind IN ('image','audio')), content_type TEXT NOT NULL,
                size INTEGER NOT NULL, duration_ms INTEGER, file_name TEXT NOT NULL UNIQUE,
                sort_order INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ideas_deleted_requests (
                idea_id TEXT PRIMARY KEY, class_id TEXT NOT NULL, device_id TEXT NOT NULL,
                request_id TEXT NOT NULL, created_at INTEGER NOT NULL,
                UNIQUE(class_id,device_id,request_id)
            );
            CREATE TABLE IF NOT EXISTS ideas_digest_state (
                id INTEGER PRIMARY KEY CHECK(id=1), next_at INTEGER NOT NULL,
                last_sent_at INTEGER, last_error TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_ideas_class_time ON ideas(class_id,created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_ideas_device_time ON ideas(device_id,created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_ideas_status_time ON ideas(status,created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_ideas_public_time ON ideas(published,updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_ideas_digest ON ideas(digest_batch_id);
            CREATE INDEX IF NOT EXISTS idx_ideas_media_idea ON ideas_media(idea_id,sort_order);
            CREATE INDEX IF NOT EXISTS idx_ideas_deleted_device_time ON ideas_deleted_requests(device_id,created_at);
        """)
        self.db.run('INSERT OR IGNORE INTO ideas_digest_state(id,next_at) VALUES (1,?)', (daily_at(now_ms()),))

    def reply(self, data, status=200):
        return self.service.json_response(data, status)

    def device(self, request):
        return self.service.authenticate_device(request, request.headers.get('X-ICeClass-Device-Id') or None)

    def has_device_credentials(self, request):
        return (self.service.is_classroom_request(request) or 'Authorization' in request.headers
                or 'X-ICeClass-Device-Id' in request.headers or 'deviceId' in request.query)

    def staff(self, request, *, superadmin=False):
        if self.has_device_credentials(request):
            return self.reply({'error': '请使用真实登录的管理员账号。'}, 401)
        user = self.service.require_user(request)
        if isinstance(user, web.Response):
            return user
        if superadmin and user['role'] != 'superadmin':
            return self.reply({'error': '只有超级管理员可以评审创意。'}, 403)
        return user

    def item(self, row, media=None, *, student=False):
        if media is None:
            media = self.db.all('SELECT * FROM ideas_media WHERE idea_id=? ORDER BY sort_order', (row['id'],))
        return {'id': row['id'], 'title': row['title'], 'text': row['text'], 'name': row['name'],
                'classId': row['class_id'], 'className': row['class_name'], 'status': row['status'],
                'reply': row['reply'], 'createdAt': row['created_at'], 'updatedAt': row['updated_at'],
                'version': row['version'], 'published': bool(row['published']),
                'canDelete': student and row['status'] == 'pending',
                'publishedTitle': row['published_title'], 'publishedText': row['published_text'],
                'media': [{'id': value['id'], 'kind': value['kind'], 'contentType': value['content_type'],
                           'size': value['size'], 'durationMs': value['duration_ms'],
                           'url': '/api/ideas/media/' + value['id']} for value in media]}

    def pagination(self, request):
        try:
            page, size = int(request.query.get('page', '1')), int(request.query.get('pageSize', '20'))
            if not 1 <= page <= 1_000_000 or not 1 <= size <= 100:
                raise ValueError
        except ValueError:
            raise ValueError('分页参数不正确。') from None
        return page, size

    def listing(self, request, where, params, *, public=False, student=False):
        page, size = self.pagination(request)
        total = self.db.one('SELECT COUNT(*) n FROM ideas WHERE ' + where, params)['n']
        fields = 'id,class_name,status,published_title,published_text,updated_at' if public else '*'
        rows = self.db.all('SELECT ' + fields + ' FROM ideas WHERE ' + where
                           + (' ORDER BY updated_at DESC,id DESC' if public else ' ORDER BY created_at DESC,id DESC')
                           + ' LIMIT ? OFFSET ?', (*params, size, (page - 1) * size))
        if public:
            items = [{'id': row['id'], 'className': row['class_name'], 'status': row['status'],
                      'publishedTitle': row['published_title'], 'publishedText': row['published_text'],
                      'updatedAt': row['updated_at']} for row in rows]
        else:
            media = {}
            if rows:
                placeholders = ','.join('?' for _ in rows)
                for value in self.db.all('SELECT * FROM ideas_media WHERE idea_id IN (' + placeholders + ') ORDER BY sort_order',
                                         tuple(row['id'] for row in rows)):
                    media.setdefault(value['idea_id'], []).append(value)
            items = [self.item(row, media.get(row['id'], []), student=student) for row in rows]
        return self.reply({'items': items, 'total': total, 'page': page, 'pageSize': size})

    async def context(self, request):
        device = self.device(request)
        if not device:
            return self.reply({'error': '教室绑定已失效，请重新绑定。'}, 401)
        classroom = self.db.one('SELECT name FROM classes WHERE id=?', (device['class_id'],))
        return self.reply({'classId': device['class_id'], 'className': classroom['name'], 'deviceId': device['id']})

    async def student_list(self, request):
        device = self.device(request)
        if not device:
            return self.reply({'error': '教室绑定已失效，请重新绑定。'}, 401)
        try:
            return self.listing(request, 'class_id=?', (device['class_id'],), student=True)
        except ValueError as error:
            return self.reply({'error': str(error)}, 400)

    async def read_upload(self, request):
        if request.content_type != 'multipart/form-data':
            raise ValueError('请使用表单提交创意。')
        if request.content_length and request.content_length > MAX_UPLOAD_BYTES + 65536:
            raise web.HTTPRequestEntityTooLarge(max_size=MAX_UPLOAD_BYTES, actual_size=request.content_length)
        report, media, seen, total = None, [], set(), 0
        reader = await request.multipart()
        async for part in reader:
            if not isinstance(part, BodyPartReader):
                raise ValueError('不支持嵌套附件。')
            name = part.name
            if name not in ('report', 'image', 'audio') or name != 'image' and name in seen:
                raise ValueError('附件字段无效或重复。')
            if part.headers.get('Content-Transfer-Encoding', '').lower() not in ('', 'binary', '8bit'):
                raise ValueError('附件编码无效。')
            if name == 'image' and sum(value['kind'] == 'image' for value in media) >= 3:
                raise ValueError('最多上传 3 张图片。')
            seen.add(name)
            limit = MAX_REPORT_BYTES if name == 'report' else MAX_MEDIA_BYTES
            data = bytearray()
            while chunk := await part.read_chunk(65536):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise web.HTTPRequestEntityTooLarge(max_size=MAX_UPLOAD_BYTES, actual_size=total)
                if len(data) + len(chunk) > limit:
                    raise ValueError('文字过长或单个附件超过 2 MB。')
                data.extend(chunk)
            raw = bytes(data)
            if name == 'report':
                report = json_object(raw)
            elif name == 'image':
                content_type, extension = validate_image(raw)
                media.append({'kind': 'image', 'data': raw, 'content_type': content_type,
                              'extension': extension, 'duration_ms': None})
            else:
                duration = validate_wav(raw)
                media.append({'kind': 'audio', 'data': raw, 'content_type': 'audio/wav',
                              'extension': 'wav', 'duration_ms': duration})
        if report is None or set(report) - {'requestId', 'text', 'name'}:
            raise ValueError('创意内容格式不正确。')
        request_id = report.get('requestId')
        if not isinstance(request_id, str) or len(request_id) != 36:
            raise ValueError('提交编号无效。')
        request_id = str(uuid.UUID(request_id))
        text, name = text_value(report.get('text', ''), 3000), text_value(report.get('name', ''), 40)
        if not text and not media:
            raise ValueError('请写下创意，或添加图片、录音。')
        return request_id, text, name, media

    async def submit(self, request):
        device = self.device(request)
        if not device:
            return self.reply({'error': '教室绑定已失效，请重新绑定。'}, 401)
        try:
            request_id, text, name, media = await self.read_upload(request)
        except web.HTTPRequestEntityTooLarge:
            return self.reply({'error': '本次上传合计不能超过 8 MB。'}, 413)
        except (ValueError, UnicodeError, AssertionError, KeyError, LookupError, RecursionError):
            return self.reply({'error': '内容或附件不正确；文字最多 3000 字，图片最多 3 张，单个附件最多 2 MB，录音最长 60 秒。'}, 400)
        current = self.device(request)
        if not current or current != device:
            return self.reply({'error': '教室绑定已变化，请重新打开后提交。'}, 401)
        deleted = self.db.one('SELECT 1 FROM ideas_deleted_requests WHERE class_id=? AND device_id=? AND request_id=?',
                              (device['class_id'], device['id'], request_id))
        if deleted:
            return self.reply({'error': '原提交已被删除，请作为新创意重新提交。'}, 410)
        previous = self.db.one('SELECT * FROM ideas WHERE class_id=? AND device_id=? AND request_id=?',
                               (device['class_id'], device['id'], request_id))
        if previous:
            return self.reply({'item': self.item(previous, student=True)}, 201)
        timestamp, item_id, created_paths = now_ms(), str(uuid.uuid4()), []
        recent = self.db.one('''SELECT (SELECT COUNT(*) FROM ideas WHERE device_id=? AND created_at>?)
                            + (SELECT COUNT(*) FROM ideas_deleted_requests WHERE device_id=? AND created_at>?) n''',
                             (device['id'], timestamp - 60_000, device['id'], timestamp - 60_000))['n']
        if recent >= 3:
            return self.reply({'error': '一分钟内最多提交 3 条创意，请稍后再试。'}, 429)
        classroom = self.db.one('SELECT name FROM classes WHERE id=?', (device['class_id'],))
        title = text.splitlines()[0][:80] if text else ('图片与语音创意' if len({value['kind'] for value in media}) == 2
                                                      else '图片创意' if media[0]['kind'] == 'image' else '语音创意')
        try:
            with self.db.transaction():
                self.db.run('''INSERT INTO ideas(id,request_id,device_id,class_id,class_name,title,text,name,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?)''',
                            (item_id, request_id, device['id'], device['class_id'], classroom['name'], title, text, name, timestamp, timestamp))
                if media:
                    self.media_root.mkdir(parents=True, exist_ok=True)
                for index, value in enumerate(media):
                    media_id = str(uuid.uuid4())
                    filename = media_id + '.' + value['extension']
                    path = self.media_root / filename
                    with path.open('xb') as output:
                        created_paths.append(path)
                        output.write(value['data'])
                        output.flush()
                        os.fsync(output.fileno())
                    self.db.run('''INSERT INTO ideas_media(id,idea_id,kind,content_type,size,duration_ms,file_name,sort_order)
                                   VALUES (?,?,?,?,?,?,?,?)''',
                                (media_id, item_id, value['kind'], value['content_type'], len(value['data']),
                                 value['duration_ms'], filename, index))
        except (OSError, sqlite3.Error) as error:
            if self.db.db.in_transaction:
                self.db.db.rollback()
            for path in created_paths:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    self.logger.warning('Ideas media cleanup failed: %s', path.name)
            self.logger.warning('Ideas storage failed: %s', type(error).__name__)
            return self.reply({'error': '创意暂未保存成功，请保留内容后重试。'}, 503)
        return self.reply({'item': self.item(self.db.one('SELECT * FROM ideas WHERE id=?', (item_id,)), student=True)}, 201)

    async def delete_student(self, request):
        device = self.device(request)
        if not device:
            return self.reply({'error': '教室绑定已失效，请重新绑定。'}, 401)
        try:
            raw = bytearray()
            async for chunk in request.content.iter_chunked(1024):
                if len(raw) + len(chunk) > 1024:
                    raise ValueError('删除请求过长。')
                raw.extend(chunk)
            body = json_object(bytes(raw))
            if set(body) != {'version'} or type(body.get('version')) is not int or not 1 <= body['version'] <= 2_147_483_647:
                raise ValueError('删除请求无效。')
        except (ValueError, UnicodeError, RecursionError):
            return self.reply({'error': '请刷新创意后再删除。'}, 400)
        if self.device(request) != device:
            return self.reply({'error': '教室绑定已变化，请重新打开。'}, 401)
        if self.digest_lock.locked():
            return self.reply({'error': '创意摘要正在发送，请稍后再试。'}, 503)
        item_id = request.match_info['idea_id']
        files = []
        async with self.digest_lock:
            try:
                with self.db.transaction():
                    row = self.db.one('SELECT * FROM ideas WHERE id=?', (item_id,))
                    if row is None:
                        deleted = self.db.one('SELECT class_id FROM ideas_deleted_requests WHERE idea_id=?', (item_id,))
                        if deleted and deleted['class_id'] == device['class_id']:
                            return self.reply({'deleted': True})
                        return self.reply({'error': '创意不存在。'}, 404)
                    if row['class_id'] != device['class_id']:
                        return self.reply({'error': '只能删除本班的创意。'}, 403)
                    if row['status'] != 'pending':
                        return self.reply({'error': '这条创意已处理，不能删除。'}, 409)
                    if row['version'] != body['version']:
                        return self.reply({'error': '创意已更新，请刷新后再删除。'}, 409)
                    files = self.db.all('SELECT file_name FROM ideas_media WHERE idea_id=?', (item_id,))
                    self.db.run('''INSERT INTO ideas_deleted_requests(idea_id,class_id,device_id,request_id,created_at)
                                   VALUES (?,?,?,?,?)''',
                                (row['id'], row['class_id'], row['device_id'], row['request_id'], row['created_at']))
                    # Rebuild an unsent digest from its remaining ideas instead of mailing deleted content.
                    if row['digest_batch_id']:
                        batch = self.db.one('SELECT sent_at FROM ideas_digest_batches WHERE id=?', (row['digest_batch_id'],))
                        if batch and batch['sent_at'] is None:
                            self.db.run('UPDATE ideas SET digest_batch_id=NULL WHERE digest_batch_id=?', (row['digest_batch_id'],))
                            self.db.run('DELETE FROM ideas_digest_batches WHERE id=?', (row['digest_batch_id'],))
                    self.db.run('DELETE FROM ideas WHERE id=?', (item_id,))
            except sqlite3.Error as error:
                self.logger.warning('Ideas deletion failed: %s', type(error).__name__)
                return self.reply({'error': '删除暂未完成，请稍后重试。'}, 503)
        for row in files:
            filename = row['file_name']
            if Path(filename).name == filename:
                try:
                    (self.media_root / filename).unlink(missing_ok=True)
                except OSError:
                    self.logger.warning('Deleted idea media cleanup failed: %s', filename)
        return self.reply({'deleted': True})

    async def media(self, request):
        device = self.device(request)
        if not device:
            user = self.staff(request, superadmin=True)
            if isinstance(user, web.Response):
                return user
        row = self.db.one('''SELECT m.*,i.class_id FROM ideas_media m JOIN ideas i ON i.id=m.idea_id WHERE m.id=?''',
                           (request.match_info['media_id'],))
        if row is None:
            return self.reply({'error': '附件不存在。'}, 404)
        if device and row['class_id'] != device['class_id']:
            return self.reply({'error': '只能查看本班的创意附件。'}, 403)
        filename = row['file_name']
        if Path(filename).name != filename or not (self.media_root / filename).is_file():
            return self.reply({'error': '附件暂不可用。'}, 404)
        return web.FileResponse(self.media_root / filename, headers={'Content-Type': row['content_type'],
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})

    async def showcase(self, request):
        if not self.device(request):
            user = self.staff(request)
            if isinstance(user, web.Response):
                return user
        try:
            return self.listing(request, "published=1 AND status IN ('adopted','implementing','launched')", (), public=True)
        except ValueError as error:
            return self.reply({'error': str(error)}, 400)

    @teacher_read('ideas', '查看创意评审列表', fields='status classId page pageSize', roles=('superadmin',))
    async def admin_list(self, request):
        user = self.staff(request, superadmin=True)
        if isinstance(user, web.Response):
            return user
        where, params = ['1=1'], []
        status, class_id = request.query.get('status', ''), request.query.get('classId', '')
        if status:
            if status not in STATUS_LABELS:
                return self.reply({'error': '创意状态无效。'}, 400)
            where.append('status=?')
            params.append(status)
        if class_id:
            if len(class_id) > 100:
                return self.reply({'error': '班级编号无效。'}, 400)
            where.append('class_id=?')
            params.append(class_id)
        try:
            return self.listing(request, ' AND '.join(where), tuple(params))
        except ValueError as error:
            return self.reply({'error': str(error)}, 400)

    @teacher_action('idea.review', '评审创意', fields='status reply published publishedTitle publishedText version',
                    target='idea', roles=('superadmin',), impact='将更新创意评审与回复；公开内容会显示在创意展示中。')
    async def review(self, request):
        user = self.staff(request, superadmin=True)
        if isinstance(user, web.Response):
            return user
        try:
            raw = bytearray()
            async for chunk in request.content.iter_chunked(65536):
                if len(raw) + len(chunk) > MAX_REVIEW_BYTES:
                    raise ValueError('评审内容过长。')
                raw.extend(chunk)
            body = json_object(bytes(raw))
            if set(body) - {'status', 'reply', 'published', 'publishedTitle', 'publishedText', 'version'}:
                raise ValueError('评审字段无效。')
            if type(body.get('version')) is not int or not 1 <= body['version'] <= 2_147_483_647:
                raise ValueError('请刷新创意后重试。')
            if 'status' in body and (not isinstance(body['status'], str) or body['status'] not in STATUS_LABELS):
                raise ValueError('创意状态无效。')
            if 'published' in body and type(body['published']) is not bool:
                raise ValueError('公开状态无效。')
            for key, maximum in (('reply', 3000), ('publishedTitle', 120), ('publishedText', 3000)):
                if key in body:
                    body[key] = text_value(body[key], maximum)
        except (ValueError, UnicodeError, RecursionError):
            return self.reply({'error': '评审内容格式不正确或超出长度限制。'}, 400)
        row = self.db.one('SELECT * FROM ideas WHERE id=?', (request.match_info['idea_id'],))
        if row is None:
            return self.reply({'error': '创意不存在。'}, 404)
        if row['version'] != body['version']:
            return self.reply({'error': '创意已被更新，请刷新后再保存。', 'item': self.item(row)}, 409)
        status = body.get('status', row['status'])
        published = body.get('published', bool(row['published']))
        title, text = body.get('publishedTitle', row['published_title']), body.get('publishedText', row['published_text'])
        if published and (status not in PUBLIC_STATUSES or not title or not text):
            return self.reply({'error': '公开前请选择已采纳、实现中或已上线，并填写公开标题与摘要。'}, 400)
        try:
            changed = self.db.run('''UPDATE ideas SET status=?,reply=?,published=?,published_title=?,published_text=?,
                updated_at=?,version=version+1 WHERE id=? AND version=?''',
                (status, body.get('reply', row['reply']), int(published), title, text, now_ms(), row['id'], body['version'])).rowcount
        except sqlite3.Error as error:
            self.logger.warning('Ideas review failed: %s', type(error).__name__)
            return self.reply({'error': '评审暂未保存成功，请稍后重试。'}, 503)
        latest = self.db.one('SELECT * FROM ideas WHERE id=?', (row['id'],))
        if not changed:
            return self.reply({'error': '创意已被更新，请刷新后再保存。', 'item': self.item(latest)}, 409)
        return self.reply({'item': self.item(latest)})

    def digest_summary(self):
        state = self.db.one('SELECT * FROM ideas_digest_state WHERE id=1')
        return {'enabled': self.enabled, 'configured': mail_settings() is not None,
                'lastSentAt': state['last_sent_at'], 'lastError': state['last_error'],
                'nextAt': state['next_at'] if self.enabled else None}

    @teacher_read('ideas.summary', '查看创意评审概览', roles=('superadmin',))
    async def summary(self, request):
        user = self.staff(request, superadmin=True)
        if isinstance(user, web.Response):
            return user
        counts = self.db.one("SELECT COUNT(*) total,COALESCE(SUM(status='pending'),0) pending,COALESCE(SUM(published),0) published FROM ideas")
        return self.reply({**counts, 'digest': self.digest_summary()})

    def digest_batch(self, timestamp):
        batch = self.db.one('SELECT * FROM ideas_digest_batches WHERE sent_at IS NULL ORDER BY scheduled_at,id LIMIT 1')
        if batch:
            return batch
        rows = self.db.all('SELECT id,class_name,title,status FROM ideas WHERE digest_batch_id IS NULL ORDER BY created_at,id')
        if not rows:
            self.db.run("UPDATE ideas_digest_state SET next_at=?,last_error='' WHERE id=1", (next_daily_at(timestamp),))
            return None
        batch_id = str(uuid.uuid4())
        local = datetime.fromtimestamp(timestamp / 1000, SHANGHAI)
        lines = ['千人创意计划 · 每日摘要', f'日期：{local:%Y-%m-%d}（北京时间）', f'新增创意：{len(rows)} 条', '']
        for index, row in enumerate(rows, 1):
            title = ' '.join(row['title'].split())
            classroom = ' '.join(row['class_name'].split())
            lines.append(f'{index}. {classroom} · {title} · {STATUS_LABELS[row["status"]]}')
            lines.append(f'   创意编号：{row["id"]}')
        lines.extend(['', '请登录班伴超级管理员账号查看和评审创意。'])
        body = '\n'.join(lines)
        with self.db.transaction():
            self.db.run('INSERT INTO ideas_digest_batches(id,scheduled_at,body,created_at) VALUES (?,?,?,?)',
                        (batch_id, timestamp, body, timestamp))
            self.db.db.executemany('UPDATE ideas SET digest_batch_id=? WHERE id=? AND digest_batch_id IS NULL',
                                   ((batch_id, row['id']) for row in rows))
        return self.db.one('SELECT * FROM ideas_digest_batches WHERE id=?', (batch_id,))

    async def deliver_due(self, timestamp=None):
        if not self.enabled:
            return
        async with self.digest_lock:
            timestamp = now_ms() if timestamp is None else timestamp
            state = self.db.one('SELECT * FROM ideas_digest_state WHERE id=1')
            if timestamp < state['next_at']:
                return
            batch = self.digest_batch(timestamp)
            if batch is None:
                return
            settings = mail_settings()
            if settings is None:
                self.db.run('UPDATE ideas_digest_state SET last_error=?,next_at=? WHERE id=1',
                            ('摘要邮箱尚未配置。', timestamp + RETRY_MS))
                return
            message = EmailMessage()
            message['From'] = formataddr(('ICeClass 班伴', settings['SMTP_USER']))
            message['To'] = settings['RECIPIENT']
            message['Subject'] = '[千人创意计划] 每日创意摘要'
            message['Message-ID'] = f'<{batch["id"]}@iceclass.ideas>'
            message.set_content(batch['body'], charset='utf-8')
            sending = asyncio.create_task(asyncio.to_thread(send_mail, settings, message))
            cancelled, error = False, None
            # Cancelling to_thread cannot stop SMTP. Finish and persist its outcome before
            # cleanup_ctx returns, so the application may safely close the connection.
            while True:
                try:
                    await asyncio.shield(sending)
                    break
                except asyncio.CancelledError:
                    cancelled = True
                except Exception as failure:
                    error = failure
                    break
            if error is None:
                with self.db.transaction():
                    self.db.run('UPDATE ideas_digest_batches SET sent_at=? WHERE id=? AND sent_at IS NULL',
                                (timestamp, batch['id']))
                    self.db.run("UPDATE ideas_digest_state SET last_sent_at=?,last_error='',next_at=? WHERE id=1",
                                (timestamp, next_daily_at(timestamp)))
            else:
                self.logger.warning('Ideas digest failed: %s', type(error).__name__)
                self.db.run('UPDATE ideas_digest_state SET last_error=?,next_at=? WHERE id=1',
                            ('摘要邮件暂未发送成功，请等待重试。', timestamp + RETRY_MS))
            if cancelled:
                raise asyncio.CancelledError

    async def run(self):
        while True:
            try:
                await self.deliver_due()
            except (OSError, sqlite3.Error) as error:
                self.logger.warning('Ideas digest storage failed: %s', type(error).__name__)
            await asyncio.sleep(30)

    async def lifecycle(self, app):
        if self.enabled:
            self.task = asyncio.create_task(self.run(), name='ideas-daily-digest')
        yield
        if self.task:
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task


IDEAS_KEY = web.AppKey('ideas', Ideas)


def install_ideas(app: web.Application, service) -> None:
    if IDEAS_KEY in app:
        return
    ideas = Ideas(app, service)
    app[IDEAS_KEY] = ideas
    app.router.add_get('/api/ideas/student/context', ideas.context)
    app.router.add_get('/api/ideas/student', ideas.student_list)
    app.router.add_post('/api/ideas/student', ideas.submit)
    app.router.add_delete('/api/ideas/student/{idea_id}', ideas.delete_student)
    app.router.add_get('/api/ideas/showcase', ideas.showcase)
    app.router.add_get('/api/ideas/admin/summary', ideas.summary)
    app.router.add_get('/api/ideas/admin', ideas.admin_list)
    app.router.add_patch('/api/ideas/admin/{idea_id}', ideas.review)
    app.router.add_get('/api/ideas/media/{media_id}', ideas.media)
    app.cleanup_ctx.append(ideas.lifecycle)

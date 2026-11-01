"""Authenticated teacher feedback delivered to a server-configured mailbox."""
from __future__ import annotations

import asyncio
import json
import os
import re
import smtplib
import ssl
import time
import uuid
from datetime import datetime
from email.message import EmailMessage
from email.utils import formataddr
from urllib.parse import urlsplit, urlunsplit

from aiohttp import web

MAX_LOG_BYTES = 1024 * 1024
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_IMAGE_TOTAL = 3 * 1024 * 1024
MAX_IMAGES = 3
MAX_REPORT_BYTES = 24576


def mail_settings() -> dict[str, str | int] | None:
    values = {name: os.environ.get('ICECLASS_FEEDBACK_' + name, '').strip()
              for name in ('SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'RECIPIENT')}
    try:
        port = int(os.environ.get('ICECLASS_FEEDBACK_SMTP_PORT', '465'))
    except ValueError:
        return None
    if not all(values.values()) or not 1 <= port <= 65535:
        return None
    if any('\r' in value or '\n' in value for value in values.values()):
        return None
    return {**values, 'SMTP_PORT': port}


def image_type(data: bytes) -> tuple[str, str] | None:
    if len(data) >= 45 and data.startswith(b'\x89PNG\r\n\x1a\n') and data[12:16] == b'IHDR' and data[-8:-4] == b'IEND':
        width, height = int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')
        if 0 < width <= 16384 and 0 < height <= 16384 and width * height <= 40_000_000:
            return 'png', 'png'
    if len(data) >= 4 and data.startswith(b'\xff\xd8\xff') and data.endswith(b'\xff\xd9'):
        return 'jpeg', 'jpg'
    if len(data) >= 16 and data[:4] == b'RIFF' and data[8:12] == b'WEBP' and int.from_bytes(data[4:8], 'little') == len(data) - 8:
        return 'webp', 'webp'
    return None


def safe_page(value: str) -> str:
    try:
        url = urlsplit(value)
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
            return ''
        fragment = url.fragment if re.fullmatch(r'[A-Za-z0-9_/-]{0,80}', url.fragment) else ''
        return urlunsplit((url.scheme, url.netloc, url.path, '', fragment))[:500]
    except ValueError:
        return ''


def build_message(settings, user, report, logs, images, report_id):
    now = datetime.now().astimezone()
    account = ' '.join(str(user['displayName']).split())
    message = EmailMessage()
    message['From'] = formataddr(('ICeClass 班伴', settings['SMTP_USER']))
    message['To'] = settings['RECIPIENT']
    message['Subject'] = f'[班伴使用反馈] {account} · {now:%m-%d %H:%M}'
    message['Message-ID'] = f'<{report_id}@iceclass.feedback>'
    message.set_content('\n'.join([
        '班伴使用反馈', f'反馈编号：{report_id}', f'收到时间：{now.isoformat(timespec="seconds")}',
        f'教师：{account}（{user["username"]}）', f'账号角色：{user["role"]}',
        f'联系方式：{report.get("contact") or "未填写"}',
        f'客户端版本：{report.get("version") or "未知"}',
        f'系统：{report.get("system") or "未知"}',
        f'显示缩放：{report.get("scaling") or "未知"}',
        f'发生时间：{report.get("occurredAt") or "未填写"}',
        f'当前页面：{safe_page(report.get("page", "")) or "未提供"}',
        '', '问题描述', report.get('description') or '未填写，请结合附件查验。',
        '', f'诊断日志：{"已附" if logs else "未附"}；截图：{len(images)} 张。',
    ]))
    if logs:
        message.add_attachment(logs, maintype='text', subtype='plain', filename='教师端诊断日志.txt')
    for index, (data, subtype, extension) in enumerate(images, 1):
        message.add_attachment(data, maintype='image', subtype=subtype, filename=f'截图{index}.{extension}')
    return message


def send_mail(settings, message):
    client = smtplib.SMTP_SSL(str(settings['SMTP_HOST']), int(settings['SMTP_PORT']),
                             timeout=15, context=ssl.create_default_context())
    try:
        client.login(settings['SMTP_USER'], settings['SMTP_PASSWORD'])
        refused = client.send_message(message)
        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)
        # DATA was accepted. A failed QUIT must not turn an accepted mail into a failed report.
        try:
            client.quit()
        except (OSError, smtplib.SMTPException):
            pass
    finally:
        client.close()


def install_feedback(app: web.Application, service) -> None:
    attempts: dict[str, list[float]] = {}
    sending: set[str] = set()

    async def submit(request: web.Request) -> web.Response:
        # Feedback is a teacher login feature, not a device-token endpoint.
        if service.is_classroom_request(request):
            return service.json_response({'error': '请先在教师端登录后反馈。'}, 401)
        user = service.require_user(request)
        if isinstance(user, web.Response):
            return user
        if not request.content_type.startswith('multipart/'):
            return service.json_response({'error': '反馈格式不正确。'}, 400)
        if request.content_length and request.content_length > MAX_LOG_BYTES + MAX_IMAGE_TOTAL + MAX_REPORT_BYTES + 8192:
            return service.json_response({'error': '附件过大，请减少截图后重试。'}, 413)
        report, logs, images = None, b'', []
        seen: set[str] = set()
        image_bytes = 0
        try:
            reader = await request.multipart()
            async for part in reader:
                name = part.name
                if name not in ('report', 'logs', 'screenshot') or name != 'screenshot' and name in seen:
                    raise ValueError('反馈附件格式不正确。')
                seen.add(name)
                limit = MAX_LOG_BYTES if name == 'logs' else MAX_IMAGE_BYTES if name == 'screenshot' else MAX_REPORT_BYTES
                if name == 'screenshot' and len(images) >= MAX_IMAGES:
                    raise ValueError('最多附 3 张截图。')
                data = bytearray()
                while chunk := await part.read_chunk(65536):
                    if len(data) + len(chunk) > limit:
                        raise ValueError('附件过大，请减少截图或日志后重试。')
                    data.extend(chunk)
                raw = bytes(data)
                if name == 'report':
                    report = json.loads(raw.decode('utf-8'))
                elif name == 'logs':
                    raw.decode('utf-8')
                    logs = raw if raw.strip() else b''
                else:
                    kind = image_type(raw)
                    if kind is None:
                        raise ValueError('截图需为有效的 PNG、JPG 或 WebP 图片。')
                    image_bytes += len(raw)
                    if image_bytes > MAX_IMAGE_TOTAL:
                        raise ValueError('截图合计不能超过 3 MB。')
                    images.append((raw, *kind))
            limits = {'description': 2000, 'contact': 120, 'version': 40, 'system': 200,
                      'scaling': 40, 'occurredAt': 60, 'page': 500}
            if not isinstance(report, dict) or set(report) - set(limits):
                raise ValueError('反馈内容格式不正确。')
            for name, limit in limits.items():
                value = report.get(name, '')
                if not isinstance(value, str) or len(value) > limit or '\x00' in value:
                    raise ValueError('反馈内容过长或格式不正确。')
                report[name] = value.strip()
            if not report['description'] and not logs and not images:
                raise ValueError('请填写问题描述，或附上日志、截图。')
        except (ValueError, UnicodeError, AssertionError):
            # Parser exceptions do not expose content or credentials in the response.
            return service.json_response({'error': '反馈内容或附件不正确；描述最多 2000 字，截图最多 3 张、合计 3 MB。'}, 400)
        settings = mail_settings()
        if settings is None:
            return service.json_response({'error': '反馈服务暂未配置，请稍后再试。'}, 503)
        now = time.monotonic()
        for key in list(attempts):
            attempts[key] = [stamp for stamp in attempts[key] if stamp > now - 600]
            if not attempts[key]:
                del attempts[key]
        recent = attempts.get(user['id'], [])
        if user['id'] in sending or len(recent) >= 3:
            return service.json_response({'error': '反馈发送较频繁，请稍后再试。'}, 429)
        attempts[user['id']] = [*recent, now]
        sending.add(user['id'])
        report_id = str(uuid.uuid4())
        message = build_message(settings, user, report, logs, images, report_id)
        try:
            await asyncio.to_thread(send_mail, settings, message)
        except (OSError, smtplib.SMTPException) as error:
            request.app[service.LOGGER_KEY].warning('Feedback mail failed: %s', type(error).__name__)
            return service.json_response({'error': '邮件暂未发送成功，内容已保留，请稍后重试。'}, 503)
        finally:
            sending.discard(user['id'])
        return service.json_response({'id': report_id, 'status': 'sent'}, 201)

    app.router.add_post('/api/feedback', submit)

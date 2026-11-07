"""The application's public acknowledgements, maintained by its service owner."""
from __future__ import annotations

import json
from pathlib import Path

from aiohttp import web
from teacher_capabilities import teacher_action, teacher_read


DEFAULT = json.loads((Path(__file__).resolve().parent.parent / 'web_controller' / 'acknowledgements-default.json').read_text(encoding='utf-8'))


def validate(body):
    if not isinstance(body, dict) or set(body) != {'revision', 'sections'}:
        raise ValueError('致谢内容格式不正确。')
    revision = body['revision']
    if type(revision) is not int or not 0 <= revision < 2147483647:
        raise ValueError('版本信息不正确，请重新载入。')
    sections = body['sections']
    if not isinstance(sections, list) or not 1 <= len(sections) <= 8:
        raise ValueError('请保留 1 至 8 组致谢。')
    normalized = []
    for section in sections:
        if not isinstance(section, dict) or set(section) != {'title', 'body'}:
            raise ValueError('每组致谢需要标题和正文。')
        title, text = section['title'], section['body']
        if not isinstance(title, str) or not isinstance(text, str):
            raise ValueError('标题和正文应为文字。')
        title = title.strip()
        text = text.replace('\r\n', '\n').replace('\r', '\n').strip()
        if not 1 <= len(title) <= 80 or any(ord(c) < 32 for c in title):
            raise ValueError('分组标题需为 1 至 80 字，不能换行。')
        if not 1 <= len(text) <= 4000 or any(ord(c) < 32 and c not in '\n\t' for c in text):
            raise ValueError('每组正文需为 1 至 4000 字，不能含无效字符。')
        normalized.append({'title': title, 'body': text})
    if sum(len(s['title']) + len(s['body']) for s in normalized) > 6000:
        raise ValueError('整份致谢最多 6000 字。')
    return revision, normalized


def install_acknowledgements(app, service):
    db = app[service.STORE_KEY]
    db.run('''CREATE TABLE IF NOT EXISTS about_acknowledgements (
        id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
        value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
    )''')

    def payload():
        row = db.one('SELECT revision,value,updated_at FROM about_acknowledgements WHERE id=1')
        return {'revision': row['revision'], 'sections': json.loads(row['value']), 'updatedAt': row['updated_at']} if row else {**DEFAULT, 'updatedAt': None}

    @teacher_read('about.acknowledgements', '查看应用致谢名单')
    async def read(request):
        # This is the same curated public text displayed before a classroom is bound.
        return service.json_response(payload())

    @teacher_action('about.acknowledgements.save', '保存应用致谢名单', fields='revision sections',
                    roles=('superadmin',), impact='所有新版教室端和教师端下次打开关于时显示新的致谢内容。')
    async def save(request):
        if service.is_classroom_request(request) or 'Authorization' in request.headers:
            return service.json_response({'error': '请使用超级管理员账号登录后台修改致谢。'}, 403)
        user = service.require_user(request)
        if isinstance(user, web.Response):
            return user
        if user['role'] != 'superadmin':
            return service.json_response({'error': '仅超级管理员可以修改应用致谢。'}, 403)
        body = await service.read_json(request)
        try:
            expected, sections = validate(body)
        except ValueError as error:
            return service.json_response({'error': str(error)}, 400)
        with db.transaction():
            if payload()['revision'] != expected:
                return service.json_response({'error': '致谢已在其他页面修改。当前编辑已保留，请重新载入后核对。'}, 409)
            db.run('''INSERT INTO about_acknowledgements VALUES(1,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value,
                updated_at=excluded.updated_at,updated_by=excluded.updated_by''',
                   (expected + 1, json.dumps(sections, ensure_ascii=False), service.now_ms(), user['id']))
            service.audit(db, user['id'], 'about.acknowledgements.save', 'application', 'acknowledgements', '更新应用致谢名单')
        return service.json_response(payload())

    app.router.add_get('/api/about/acknowledgements', read)
    app.router.add_put('/api/about/acknowledgements', save)

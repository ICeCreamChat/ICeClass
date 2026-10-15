"""A localhost-only demonstration with its own disposable database."""
from __future__ import annotations

import argparse
import json
import uuid
from datetime import datetime
from pathlib import Path

from aiohttp import web

import app as service
from reading import DEFAULT, SHANGHAI, local_day


def create_preview():
    database = Path(__file__).resolve().parent.parent / '.tools' / 'preview' / 'demo.db'
    app = service.create_app(database)
    async def identify_preview(request, response):
        response.headers['X-ICeClass-Preview'] = '1'
    app.on_response_prepare.append(identify_preview)
    db = app[service.STORE_KEY]
    if db.one("SELECT id FROM users WHERE username='ICe'"):
        return app
    now = service.now_ms()
    with db.transaction():
        for uid, name, display, role, password in [
            ('preview-admin', 'ICe', '演示管理员', 'superadmin', 'LocalDemo2026'),
            ('preview-teacher', 'teacher1', '一班演示教师', 'teacher', 'LocalTeacher2026'),
        ]:
            db.run('INSERT INTO users(id,username,display_name,role,password_hash,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)',
                   (uid, name, display, role, service.hash_password(password), now, now))
        for number in range(1, 4):
            cid, did = str(uuid.uuid4()), str(uuid.uuid4())
            db.run('INSERT INTO classes(id,name,enabled,created_at,updated_at) VALUES(?,?,1,?,?)', (cid, f'高一（{number}）班', now, now))
            db.run('INSERT INTO devices(id,class_id,name,token_hash,enabled,created_at,updated_at) VALUES(?,?,?,?,1,?,?)',
                   (did, cid, '验收演示白板', service.sha256('local-demo-device-' + str(number)), now, now))
            if number == 1:
                db.run('INSERT INTO teacher_classes(user_id,class_id) VALUES(?,?)', ('preview-teacher', cid))
            if number < 3:
                base = int(datetime.now(SHANGHAI).replace(hour=7, minute=20, second=0, microsecond=0).timestamp())
                seconds = 600 if number == 1 else 480
                for index in range(seconds // 10):
                    db.run('INSERT INTO reading_buckets VALUES(?,?,?,?,?)', (cid, local_day(now), base // 10 + index, 1023, 1023 if index % 4 else 255))
                sid = str(uuid.uuid4())
                db.run('INSERT INTO reading_sessions VALUES(?,?,?,?,?,?)', (sid, did, cid, 'classic' if number == 1 else 'carving', base * 1000, (base + seconds) * 1000))
                db.run('INSERT INTO reading_session_days VALUES(?,?)', (sid, local_day(now)))
                for i in range(4 if number == 1 else 2):
                    db.run('INSERT INTO reading_events VALUES(?,?,?,?,?,?,?,1)', (str(uuid.uuid4()), sid, cid, local_day(now), base * 1000 + i * 1000,
                           'carrots' if number == 1 else 'poems', '演示完成量'))
        for grade, count in [('高一', 16), ('高二', 14), ('高三', 14)]:
            for number in range(1, count + 1):
                db.run('INSERT OR IGNORE INTO classes(id,name,enabled,created_at,updated_at) VALUES(?,?,1,?,?)',
                       (str(uuid.uuid4()), f'{grade}（{number}）班', now, now))
        config = {**DEFAULT, 'enabled': True, 'periods': [{'weekdays': [1, 2, 3, 4, 5, 6, 7], 'start': 0, 'end': 1440}]}
        db.run('UPDATE reading_settings SET value=? WHERE id=1', (json.dumps(config),))
    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='ICeClass localhost demonstration')
    parser.add_argument('--port', type=int, default=8837)
    args = parser.parse_args()
    print(f'ICeClass preview: http://127.0.0.1:{args.port}/', flush=True)
    print('Demo administrator: ICe / LocalDemo2026', flush=True)
    print('Demo teacher: teacher1 / LocalTeacher2026', flush=True)
    print('The sample classes and scores are fictional. This server listens only on localhost.', flush=True)
    web.run_app(create_preview(), host='127.0.0.1', port=args.port)

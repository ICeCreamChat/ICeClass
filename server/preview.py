"""A localhost-only demonstration with its own disposable database."""
from __future__ import annotations

import argparse
import io
import json
import sqlite3
import struct
import uuid
import wave
from contextlib import closing
from datetime import datetime, timedelta
from math import pi, sin
from pathlib import Path

from aiohttp import web

import app as service
import homework
import island
import self_study
from card_quiz_events import initial_session, replay
from card_quiz_models import dumps, fingerprint, validate_events, validate_question, validate_session
from reading import DEFAULT, SHANGHAI, local_day


ADMIN, TEACHER = 'preview-admin', 'preview-teacher'
MINUTE = 60_000
DEMO_STUDENT_PASSWORD = '260001'


def initialize_school(app, now):
    db = app[service.STORE_KEY]
    for uid, name, display, role, password in [
        (ADMIN, 'ICe', '演示管理员', 'superadmin', 'LocalDemo2026'),
        (TEACHER, 'teacher1', '一班演示教师', 'teacher', 'LocalTeacher2026'),
    ]:
        db.run('INSERT INTO users(id,username,display_name,role,password_hash,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)',
               (uid, name, display, role, service.hash_password(password), now, now))
    for grade, count in [('高一', 16), ('高二', 14), ('高三', 14)]:
        for number in range(1, count + 1):
            cid = str(uuid.uuid4())
            db.run('INSERT INTO classes(id,name,enabled,created_at,updated_at) VALUES(?,?,1,?,?)',
                   (cid, f'{grade}（{number}）班', now, now))
            if grade == '高一' and number <= 3:
                db.run('INSERT INTO devices(id,class_id,name,token_hash,enabled,created_at,updated_at) VALUES(?,?,?,?,1,?,?)',
                       (str(uuid.uuid4()), cid, '验收演示白板', service.sha256(f'local-demo-device-{number}'), now, now))
                if number == 1:
                    db.run('INSERT INTO teacher_classes(user_id,class_id) VALUES(?,?)', (TEACHER, cid))
    config = {**DEFAULT, 'enabled': True, 'periods': [{'weekdays': list(range(1, 8)), 'start': 0, 'end': 1440}]}
    db.run('UPDATE reading_settings SET value=? WHERE id=1', (dumps(config),))
    app[service.ROOMS_KEY].reading.offline.save_rule(config)


def demo_rooms(db):
    for number in (1, 2):
        room = db.one('''SELECT c.id, c.name, d.id AS device_id FROM classes c JOIN devices d ON d.class_id=c.id
                WHERE c.name=? AND d.token_hash=? AND c.enabled=1 AND d.enabled=1''',
                      (f'高一（{number}）班', service.sha256(f'local-demo-device-{number}')))
        if room:
            yield {**room, 'number': number}


def seed_homework_profile(db, room, now):
    cid = room['id']
    previous = db.one('SELECT revision,value FROM homework_profiles WHERE class_id=?', (cid,))
    value = json.loads(previous['value']) if previous else homework.defaults()
    if (value['students'] or any(s['items'] for t in value['terms'] for s in t['subjects'])
            or any(db.one(f'SELECT 1 FROM {table} WHERE class_id=? LIMIT 1', (cid,)) for table in
                   ('homework_records', 'card_quiz_cards', 'card_quiz_sessions', 'student_accounts'))):
        return None
    students = [{'id': f'preview-student-{i:02}', 'name': f'演示学生 {i:02}'} for i in range(1, 13)]
    value['students'] = students
    term = next(t for t in value['terms'] if t['id'] == value['activeTermId'])
    assignments = {'chinese': [('recite', '课文摘抄'), ('dictation', '词语默写')],
                   'math': [('functions', '一次函数练习')], 'english': [('words', '单元词汇练习')]}
    for subject in term['subjects']:
        subject['items'] = [{'id': 'preview-' + key, 'name': name, 'active': True}
                            for key, name in assignments.get(subject['id'], ())]
    revision = previous['revision'] + 1 if previous else 1
    db.run('''INSERT INTO homework_profiles(class_id,revision,value,updated_at,updated_by) VALUES(?,?,?,?,?)
              ON CONFLICT(class_id) DO UPDATE SET revision=excluded.revision,value=excluded.value,
              updated_at=excluded.updated_at,updated_by=excluded.updated_by''',
           (cid, revision, dumps(homework.validate_profile(value)), now, ADMIN))
    return revision, students


def seed_island(db, room, on, now):
    if db.one('SELECT 1 FROM island_profiles WHERE class_id=?', (room['id'],)):
        return
    config = island.defaults('高一')
    subjects = ['语文', '数学', '英语', '物理', '历史', '地理', '体育', '班会']
    config['lessons'] = [
        {'slotId': f'period-{slot}', 'weekday': day, 'subject': subjects[(slot + day + room['number']) % len(subjects)],
         'teacher': '演示教师'} for day in range(1, 6) for slot in range(1, 9)]
    config['overrides'] = [{'date': (on + timedelta(days=1)).isoformat(), 'slotId': 'period-2',
                            'subject': '演示调课：阅读分享'}]
    config['dutyRotations']['evening'].update(enabled=True, weekAnchor=(on - timedelta(days=on.weekday())).isoformat(),
        lessons=[{'slotId': f'evening-study-{slot}', 'weekday': day, 'cycleWeek': week,
                  'subject': subjects[(day + week + slot) % 6], 'teacher': '演示值班教师'}
                 for week in (1, 2) for day in range(1, 6) for slot in (1, 2)])
    config['components'].extend([
        {'id': 'preview-hint', 'type': 'text', 'title': '本周目标', 'text': '完成函数章节复习'},
        {'id': 'preview-countdown', 'type': 'countdown', 'title': '演示随堂练习', 'date': (on + timedelta(days=14)).isoformat()}])
    db.run('INSERT INTO island_profiles(class_id,revision,value,updated_at,updated_by) VALUES(?,1,?,?,?)',
           (room['id'], dumps(island.normalize(config)), now, ADMIN))


def seed_question_bank(db, room, now):
    questions = [
        ('single', '直线 y = 2x + 1 与 y 轴的交点是哪个？', ['(0, 1)', '(1, 0)', '(0, 2)', '(2, 0)'], 'A', ['一次函数', '截距']),
        ('boolean', 'y = 2x + 1 的值随 x 的增大而增大。', ['正确', '错误'], 'A', ['一次函数', '增减性']),
        ('multiple', '下列哪些点在直线 y = 2x + 1 上？', ['(0, 1)', '(1, 2)', '(2, 5)', '(-1, 0)'], 'AC', ['一次函数', '函数图像']),
    ]
    title = '演示题单 · 一次函数随堂练习'
    published = []
    for owner in (ADMIN, TEACHER):
        if not db.one('SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL', (owner,)):
            continue
        values = []
        for kind, text, options, answer, tags in questions:
            qid = f'{owner}-{kind}'
            question = validate_question({'subjectId': 'math', 'type': kind, 'text': text,
                                          'options': options, 'answer': answer, 'tags': tags})
            value = {**question, 'id': qid, 'ownerId': owner, 'revision': 1}
            encoded = dumps(value)
            db.run('INSERT INTO card_quiz_questions(id,owner_id,revision,value) VALUES(?,?,1,?)', (qid, owner, encoded))
            db.run('INSERT INTO card_quiz_question_versions(question_id,revision,value) VALUES(?,1,?)', (qid, encoded))
            values.append({**value, 'bankId': qid, 'bankVersion': 1})
        db.run('INSERT INTO card_quiz_decks(id,owner_id,revision,title,question_ids) VALUES(?,?,1,?,?)',
               (f'{owner}-deck', owner, title, dumps([q['bankId'] for q in values])))
        if owner == ADMIN:
            published = values
    pid = 'preview-workbench-publication'
    value = {'id': pid, 'classId': room['id'], 'title': title, 'questions': published}
    db.run('INSERT INTO card_quiz_publications(id,owner_id,class_id,value,created_at) VALUES(?,?,?,?,?)',
           (pid, ADMIN, room['id'], dumps(value), now))
    return published


def seed_quiz_session(db, room, roster_revision, roster, questions, now):
    started = now - 100 * MINUTE
    session = initial_session({'schema': 1, 'cardVersion': 'ice-v1', 'id': 'preview-workbench-lesson',
                               'classId': room['id'], 'deviceId': room['device_id'], 'subjectId': 'math',
                               'roster': roster, 'startedAt': started, 'rosterRevision': roster_revision, 'cardRevision': 1})
    events = []

    def event(action, **payload):
        seq = len(events) + 1
        stamp = started + seq * 1000
        events.append({'seq': seq, 'id': f'preview-event-{seq}', 'at': stamp, 'action': action, 'payload': payload,
                       'questionId': session['currentQuestionId'], 'roundId': session['currentRoundId'],
                       'generation': session['generation'], 'sourceId': 'board'})
        return stamp

    attempts = [('A', 'A', 'C', 'A', 'B', 'A', 'A', 'A', 'A', 'D'),
                ('B', 'A', 'A', 'A', 'A', 'A', 'B', 'A', 'A', 'A', 'A'),
                ('AC', 'A', 'AC', 'AD', 'AC', 'AC', 'C', 'AC', 'AC', 'AC', 'AB')]
    for index, (published, responses) in enumerate(zip(questions, attempts), 1):
        question = {**validate_question(published), 'bankId': published['bankId'], 'bankVersion': published['bankVersion']}
        event('add_question', **question)
        qid, rid = f'preview-question-{index}', f'preview-round-{index}'
        session.update(currentQuestionId=qid, currentRoundId=None, generation=session['generation'] + 1)
        stamp = event('start_round', practice=False)
        session.update(currentRoundId=rid, generation=session['generation'] + 1)
        round_value = {'id': rid, 'startedAt': stamp, 'status': 'closed', 'purpose': 'formal',
                       'source': 'board', 'sourceId': 'board', 'answers': {}, 'exempt': []}
        multi = question['type'] == 'multiple'
        for target in ('ABCD' if multi else (None,)):
            if target and target != 'A':
                event('set_multi_option', option=target)
                session['generation'] += 1
            for student, option in zip(roster, responses):
                sid = student['id']
                if multi:
                    if student['cardNumber'] == 3 and target != 'A':
                        continue  # The report shows a partially completed multi-select answer.
                    selected = target in option
                    stamp = event('answer', cardNumber=student['cardNumber'], option='A' if selected else 'B', targetOption=target)
                    choices = {**round_value['answers'].get(sid, {}).get('choices', {}), target: selected}
                    answer = {'choices': choices, 'option': ''.join(k for k, chosen in choices.items() if chosen)}
                else:
                    stamp = event('answer', cardNumber=student['cardNumber'], option=option)
                    answer = {'option': option}
                round_value['answers'][sid] = {**answer, 'confirmedAt': stamp, 'seq': len(events)}
        if index == 1:
            round_value['exempt'] = [roster[-1]['id']]
            event('set_exempt', studentId=roster[-1]['id'], exempt=True)
        if multi:
            round_value['activeOption'] = 'D'
        round_value.update(endedAt=event('end_round'), generation=session['generation'])
        session['generation'] += 1
        event('reveal')
        session['questions'].append({**question, 'id': qid, 'revision': 1, 'revealed': True, 'rounds': [round_value]})
    session.update(endedAt=event('end_session'), seq=len(events), generation=session['generation'] + 1)
    session = validate_session(session)
    events = validate_events(events, 1, session['seq'])
    replay(session, events)
    value = dumps(session)
    db.run('''INSERT INTO card_quiz_sessions(id,class_id,device_id,subject_id,started_at,ended_at,seq,revision,raw_value,value,teacher_id,updated_at)
              VALUES(?,?,?,?,?,?,?,1,?,?,?,?)''',
           (session['id'], room['id'], room['device_id'], 'math', started, session['endedAt'], session['seq'], value, value, ADMIN, now))
    db.db.executemany('INSERT INTO card_quiz_events(session_id,seq,id,value) VALUES(?,?,?,?)',
                      [(session['id'], e['seq'], e['id'], dumps(e)) for e in events])
    db.run('INSERT INTO card_quiz_batches(session_id,seq,fingerprint) VALUES(?,?,?)',
           (session['id'], session['seq'], fingerprint(session)))


def seed_cards_and_students(db, room, profile, questions, now):
    revision, students = profile
    roster = [{**student, 'cardNumber': i} for i, student in enumerate(students, 1)]
    bindings = {s['id']: s['cardNumber'] for s in roster}
    cid = room['id']
    db.run('INSERT INTO card_quiz_cards(class_id,revision,value) VALUES(?,1,?)',
           (cid, dumps({'bindings': bindings, 'used': list(bindings.values())})))
    created = 0
    for student in roster[:3]:
        card = student['cardNumber']
        aid, username = f"preview-account-{room['number']}-{card}", f"261{room['number']:02}{card:02}"
        inserted = db.run('''INSERT INTO student_accounts(id,username,password_hash,class_id,student_id,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?) ON CONFLICT(username) DO NOTHING''',
                          (aid, username, service.hash_password(DEMO_STUDENT_PASSWORD), cid, student['id'], now, now))
        if inserted.rowcount:
            db.run('INSERT INTO student_account_links(class_id,student_id,account_id) VALUES(?,?,?)', (cid, student['id'], aid))
            created += 1
    if created:
        db.run('INSERT INTO student_account_versions(class_id,revision) VALUES(?,1) ON CONFLICT(class_id) DO UPDATE SET revision=revision+1', (cid,))
    seed_quiz_session(db, room, revision, roster, questions, now)


def seed_reading(db, room, on):
    cid, day = room['id'], on.isoformat()
    if (db.one('SELECT 1 FROM reading_buckets WHERE class_id=? AND day=? LIMIT 1', (cid, day))
            or db.one('''SELECT 1 FROM reading_session_days d JOIN reading_sessions s ON s.id=d.session_id
                         WHERE s.class_id=? AND d.day=? LIMIT 1''', (cid, day))):
        return
    started = int(datetime.combine(on, datetime.min.time(), SHANGHAI).replace(hour=7, minute=20).timestamp())
    first = room['number'] == 1
    seconds = (600 if first else 480) + (on.day % 3) * 40
    sid = str(uuid.uuid4())
    db.run('INSERT INTO reading_sessions VALUES(?,?,?,?,?,?)',
           (sid, room['device_id'], cid, 'classic' if first else 'carving', started * 1000, (started + seconds) * 1000))
    db.run('INSERT INTO reading_session_days VALUES(?,?)', (sid, day))
    db.db.executemany('INSERT INTO reading_buckets VALUES(?,?,?,?,?)',
                      [(cid, day, started // 10 + i, 1023, 1023 if i % 4 else 255) for i in range(seconds // 10)])
    db.db.executemany('INSERT INTO reading_events VALUES(?,?,?,?,?,?,?,1)',
                      [(str(uuid.uuid4()), sid, cid, day, (started + (i + 1) * 40) * 1000,
                        'carrots' if first else 'poems', '演示完成量') for i in range(4 if first else 2)])


def seed_homework_day(db, room, on, now):
    cid, day = room['id'], on.isoformat()
    profile = db.one('SELECT value FROM homework_profiles WHERE class_id=?', (cid,))
    if not profile or db.one('SELECT 1 FROM homework_records WHERE class_id=? AND day=? LIMIT 1', (cid, day)):
        return
    value = json.loads(profile['value'])
    students = value['students']
    if not students or not all(s['id'].startswith('preview-student-') and s['name'].startswith('演示学生 ') for s in students):
        return
    term = next(t for t in value['terms'] if t['id'] == value['activeTermId'])
    missing_counts = {'preview-functions': 2 + (on.day + room['number']) % 2, 'preview-words': 0, 'preview-recite': 0}
    stamp = min(now, int(datetime.combine(on, datetime.min.time(), SHANGHAI).replace(hour=7).timestamp() * 1000))
    for subject in term['subjects']:
        for item in subject['items']:
            iid = item['id']
            if not item['active'] or iid not in missing_counts:
                continue
            snapshot = {'classId': cid, 'termId': term['id'], 'termName': term['label'], 'date': day,
                        'subjectId': subject['id'], 'subjectName': subject['name'], 'itemId': iid, 'itemName': item['name'],
                        'students': students, 'status': 'no_homework' if iid == 'preview-recite' else 'submitted',
                        'missing': [s['id'] for s in students[:missing_counts[iid]]]}
            db.run('''INSERT INTO homework_records(class_id,term_id,day,item_id,subject_id,revision,value,updated_at,device_id)
                      VALUES(?,?,?,?,?,1,?,?,?)''', (cid, term['id'], day, iid, subject['id'], dumps(snapshot), stamp, room['device_id']))


def seed_ideas(db, rooms, now):
    samples = [
        ('pending', '增加课前两分钟复习卡', '上课前在白板显示一道上节课的题。', ''),
        ('adopted', '午间阅读角', '把同学推荐的书和阅读心得贴在阅读角。', '已采纳，先在一个班试用。'),
        ('implementing', '作业情况周报', '用简单图形呈现每周作业提交情况。', '正在制作示例周报。'),
        ('launched', '课代表轮值提醒', '在当天的课表旁显示值日提醒。', '已在演示课表中上线。'),
        ('declined', '每节课播放入场音乐', '希望上课铃前播放音乐。', '暂不采纳，避免打扰其他班级。'),
    ]
    # Keep fixtures out of the real mail digest queue.
    batch = 'preview-workbench-ideas'
    db.run('INSERT INTO ideas_digest_batches(id,scheduled_at,body,sent_at,created_at) VALUES(?,?,?,?,?)',
           (batch, now, '本地验收样例', now, now))
    for i, (status, title, body, reply) in enumerate(samples):
        room = rooms[i % len(rooms)]
        uid, created = str(uuid.uuid4()), now - (i + 1) * 60 * MINUTE
        published = status == 'launched'
        db.run('''INSERT INTO ideas(id,request_id,device_id,class_id,class_name,title,text,name,status,reply,
                   created_at,updated_at,published,published_title,published_text,digest_batch_id)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
               (uid, uid, room['device_id'], room['id'], room['name'], title, body, f'演示学生 {i + 1:02}', status, reply,
                created, created if status == 'pending' else created + MINUTE, published,
                title if published else '', body if published else '', batch))


def seed_notifications(db, room, now):
    samples = [
        ('displayed', 'warning', '请在课间将练习册交给课代表。', '教室已确认', True),
        ('displayed', 'info', '下一节课请准备数学课本。', '教室已显示', False),
        ('offline', 'warning', '晚自习前请整理桌面。', '教室电脑当前离线', False),
        ('failed', 'urgent', '请班长到办公室领取资料。', '演示：设备回执超时', False),
    ]
    for i, (status, level, message, detail, confirmed) in enumerate(samples):
        created = now - (i + 2) * 15 * MINUTE
        displayed = status == 'displayed'
        db.run('''INSERT INTO shouts(id,class_id,sender_id,sender_name,text,alert_level,status,status_detail,
                  created_at,expires_at,received_at,displayed_at,acknowledged_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
               (str(uuid.uuid4()), room['id'], ADMIN, '演示管理员', message, level, status, detail, created,
                created + MINUTE, created + 1000 if displayed else None, created + 2000 if displayed else None,
                created + 5000 if confirmed else None))
    if not db.one('SELECT 1 FROM quiet_periods LIMIT 1'):
        db.run('''INSERT INTO quiet_periods(id,name,weekdays,start_minute,end_minute,sort_order,created_at,updated_at)
                  VALUES(?,?,?,?,?,0,?,?)''', (str(uuid.uuid4()), '演示：周末清晨', '6,7', 390, 420, now, now))


def sample_tone():
    rate, duration = 16000, 700
    frames = rate * duration // 1000
    samples = [int(3500 * min(i, frames - i, 240) / 240 * sin(2 * pi * 523 * i / rate)) for i in range(frames)]
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as recording:
        recording.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        recording.writeframes(struct.pack(f'<{frames}h', *samples))
    return buffer.getvalue(), duration


def seed_daily_inbox(app, room, now):
    db = app[service.STORE_KEY]
    cid, did = room['id'], room['device_id']
    waveform, duration = sample_tone()
    for heard in (False, True):
        uid = 'preview-' + str(uuid.uuid4())
        relative = f'classroom/{uid}.wav'
        path = app[service.AUDIO_ROOT_KEY] / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as output:
            output.write(waveform)
        created = now - (12 if heard else 5) * MINUTE
        # Only the generated sample stays available for the full day of acceptance.
        db.run('''INSERT INTO classroom_voice_messages(id,class_id,device_id,audio_path,audio_size,audio_duration_ms,
                  created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)''', (uid, cid, did, relative, len(waveform), duration, created, now + 1440 * MINUTE))
        if heard:
            db.run('INSERT INTO classroom_voice_receipts(message_id,user_id,played_at) VALUES(?,?,?)', (uid, ADMIN, created + MINUTE))
    for handled in (False, True):
        started = now - (50 if handled else 20) * MINUTE
        uid = 'preview-' + str(uuid.uuid4())
        db.run('''INSERT INTO self_study_events(id,class_id,device_id,started_at,last_seen_at,warned_at,reported_at,
                  status,handled_at,handled_by,resolution,revision,session_key,ended_at,confirmations,last_confirmation_at)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)''',
               (uid, cid, did, started, started + 3 * MINUTE, started + MINUTE, started + 3 * MINUTE,
                'resolved' if handled else 'reported', started + 5 * MINUTE if handled else None,
                ADMIN if handled else None, 'false_alarm' if handled else None, f'preview:{local_day(started)}',
                started + 3 * MINUTE, 1, started + 3 * MINUTE))


def seed_workbench(app, now):
    db = app[service.STORE_KEY]
    rooms = list(demo_rooms(db))
    if not rooms:
        return
    on = datetime.fromtimestamp(now / 1000, SHANGHAI).date()
    db.run('CREATE TABLE IF NOT EXISTS preview_samples (name TEXT PRIMARY KEY)')

    def first_visit(key):
        return db.run('INSERT OR IGNORE INTO preview_samples(name) VALUES(?)', (key,)).rowcount != 0

    if first_visit('workbench'):
        primary = rooms[0]
        profile = None
        for room in rooms:
            seeded = seed_homework_profile(db, room, now)
            if seeded and profile is None:
                primary, profile = room, seeded
            seed_island(db, room, on, now)
        questions = seed_question_bank(db, primary, now)
        if profile:
            seed_cards_and_students(db, primary, profile, questions, now)
        for offset in (2, 1):
            previous_day = on - timedelta(days=offset)
            if first_visit(f'day:{previous_day}'):
                for room in rooms:
                    seed_reading(db, room, previous_day)
                    seed_homework_day(db, room, previous_day, now)
        seed_ideas(db, rooms, now)
        seed_notifications(db, rooms[0], now)
        rules = self_study.validate_config({'photoEnabled': False, 'observationSeconds': 15, 'reminderWaitSeconds': 120,
                                            'dailyCalls': 3, 'dailyTokens': 1800})
        db.run('INSERT OR IGNORE INTO self_study_settings(class_id,revision,config) VALUES(?,1,?)', (rooms[0]['id'], dumps(rules)))
    if first_visit(f'day:{on}'):
        for room in rooms:
            seed_reading(db, room, on)
            seed_homework_day(db, room, on, now)
    if first_visit(f'inbox:{on}'):
        seed_daily_inbox(app, rooms[0], now)


def create_preview(database=None):
    database = Path(database) if database is not None else Path(__file__).resolve().parent.parent / '.tools' / 'preview' / 'demo.db'
    if database.is_file() and database.stat().st_size:
        with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)) as existing:
            users = existing.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").fetchone()
            if not users or not existing.execute('SELECT 1 FROM users WHERE id=?', (ADMIN,)).fetchone():
                raise ValueError('已有数据库不是本地验收库，请为预览指定一个新文件。')
    app = service.create_app(database)

    async def identify_preview(request, response):
        response.headers['X-ICeClass-Preview'] = '1'
    app.on_response_prepare.append(identify_preview)
    db = app[service.STORE_KEY]
    try:
        with db.transaction():
            now = service.now_ms()
            if not db.one('SELECT 1 FROM users WHERE id=?', (ADMIN,)):
                initialize_school(app, now)
            seed_workbench(app, now)
    except Exception:
        db.close()
        raise
    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='ICeClass localhost demonstration')
    parser.add_argument('--port', type=int, default=8837)
    parser.add_argument('--database', type=Path, help='Use a separate local demonstration database')
    args = parser.parse_args()
    print(f'ICeClass preview: http://127.0.0.1:{args.port}/', flush=True)
    print('Demo administrator: ICe / LocalDemo2026', flush=True)
    print('Demo teacher: teacher1 / LocalTeacher2026', flush=True)
    print('The sample classes and scores are fictional. This server listens only on localhost.', flush=True)
    web.run_app(create_preview(args.database), host='127.0.0.1', port=args.port)

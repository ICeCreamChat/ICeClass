"""School card quiz feature: private banks, classroom cards and authorized media."""
from __future__ import annotations

import base64
import binascii
import json
import math
import os
import re
import uuid

from aiohttp import web

from card_quiz_models import (DEVICE_REASON, IMAGE_REASON, MAX_BODY, MAX_LIST, MAX_SYNC_BODY, SCHEMA, QuizError,
                              array, dumps, fail, identifier, integer, new_id, obj, revision,
                              string, unique, validate_question)
from card_quiz_recognition import CardQuizRecognition
from card_quiz_relay import RelayHandlers
from card_quiz_sessions import SessionHandlers
from card_quiz_turn import PreviewTurn
from teacher_capabilities import teacher_action, teacher_manual, teacher_read


def creation_id(user, kind, body):
    if 'requestKey' not in body:
        return new_id()
    key = identifier(body['requestKey'])
    return str(uuid.uuid5(uuid.NAMESPACE_URL, dumps(['card-quiz', kind, user['id'], key])))


class CardQuiz(SessionHandlers, RelayHandlers):
    def __init__(self, app, service):
        self.service = service
        self.db = app[service.STORE_KEY]
        self.preview_offers = {}
        self.preview_turn = PreviewTurn(os.environ.get('ICECLASS_VIDEOBOOTH_CONNECT_URL', ''))
        self.db.db.executescript(SCHEMA)
        self.db.run('''CREATE INDEX IF NOT EXISTS idx_card_quiz_history
            ON card_quiz_sessions(class_id,started_at,id)''')
        self.db.run('''CREATE INDEX IF NOT EXISTS idx_card_quiz_subject_history
            ON card_quiz_sessions(class_id,subject_id,started_at,id)''')
        if 'publication_id' not in {row['name'] for row in self.db.all('PRAGMA table_info(card_quiz_sessions)')}:
            self.db.run('ALTER TABLE card_quiz_sessions ADD COLUMN publication_id TEXT REFERENCES card_quiz_publications(id)')
        if 'scan_key_hash' not in {row['name'] for row in self.db.all('PRAGMA table_info(card_quiz_pairs)')}:
            self.db.run('ALTER TABLE card_quiz_pairs ADD COLUMN scan_key_hash TEXT')
        if 'rejection_origin' not in {row['name'] for row in self.db.all('PRAGMA table_info(card_quiz_commands)')}:
            self.db.run('ALTER TABLE card_quiz_commands ADD COLUMN rejection_origin TEXT')

    def reply(self, value, status=200):
        return self.service.json_response(value, status)

    async def body(self, request, maximum=MAX_BODY):
        if request.content_type != 'application/json':
            fail('请使用 JSON 请求。')
        if request.content_length is not None and request.content_length > maximum:
            fail(f'请求内容超过 {maximum} 字节。', 413)
        try:
            raw = await request.read()
            if len(raw) > maximum:
                fail(f'请求内容超过 {maximum} 字节。', 413)

            def finite_float(text):
                number = float(text)
                if not math.isfinite(number):
                    fail('JSON 数字无效。')
                return number

            value = json.loads(raw, parse_float=finite_float, parse_constant=lambda _: fail('JSON 数字无效。'))
            dumps(value).encode('utf-8')
            return obj(value)
        except QuizError:
            raise
        except (ValueError, RecursionError):
            fail('请求 JSON 格式不正确。')

    def staff(self, request):
        if (self.service.is_classroom_request(request) or 'Authorization' in request.headers
                or 'X-ICeClass-Device-Id' in request.headers or 'deviceId' in request.query):
            fail('请使用真实教师账号登录。', 401)
        user = self.service.require_user(request)
        if isinstance(user, web.Response):
            raise QuizError(json.loads(user.text)['error'], user.status)
        if not self.db.one('SELECT 1 FROM users WHERE id=? AND enabled=1 AND deleted_at IS NULL', (user['id'],)):
            fail('请重新登录。', 401)
        return user

    def device(self, request):
        device = self.service.authenticate_device(request, request.headers.get('X-ICeClass-Device-Id') or '')
        if not device or device['class_id'] != request.headers.get('X-ICeClass-Class-Id'):
            fail('教室绑定已失效或发生变化，请重新打开。', 401, 'device_unauthorized')
        return device

    def access(self, user, cid, *, edit=False):
        identifier(cid)
        if not self.service.can_access_class(self.db, user, cid, include_teaching=not edit):
            fail('没有管理这个班级名单的权限。' if edit else '没有查看这个班级的权限。', 403)

    def limited(self, sql, params=(), maximum=MAX_LIST):
        rows = self.db.all(sql + ' LIMIT ?', (*params, maximum + 1))
        if len(rows) > maximum:
            fail(f'结果超过 {maximum} 条，请缩小查询范围。')
        return rows

    def audit(self, user, action, kind, target, detail):
        self.service.audit(self.db, user['id'], action, kind, target, detail)

    def resource_id(self, request, body=None):
        """The capability invoker passes declared IDs in payload/query, without a URL match."""
        matched = request.match_info.get('id')
        supplied = (body or {}).get('id', request.query.get('id'))
        if matched is not None and supplied is not None and matched != supplied:
            fail('请求路径与目标编号不一致。')
        return identifier(matched if matched is not None else supplied)

    def roster(self, cid):
        row = self.db.one('SELECT revision,value FROM homework_profiles WHERE class_id=?', (cid,))
        return (row['revision'], json.loads(row['value'])['students']) if row else (0, [])

    def cards(self, cid):
        row = self.db.one('SELECT revision,value FROM card_quiz_cards WHERE class_id=?', (cid,))
        return (row['revision'], json.loads(row['value'])) if row else (0, {'bindings': {}, 'used': []})

    def cards_payload(self, cid, user=None):
        expected, cards = self.cards(cid)
        _, roster = self.roster(cid)
        return {'classId': cid, 'revision': expected,
                'students': [{**s, 'cardNumber': cards['bindings'].get(s['id'])} for s in roster],
                'canEdit': bool(user and self.service.can_access_class(self.db, user, cid, include_teaching=False))}

    @teacher_read('card-quiz.cards', '查看纸卡编号与班级名单', target='class')
    async def get_cards(self, request):
        user = self.staff(request)
        cid = request.match_info['class_id']
        self.access(user, cid)
        return self.reply(self.cards_payload(cid, user))

    @teacher_action('card-quiz.cards.save', '设置班级纸卡编号', target='class', head_only=True,
                    fields='revision initialize bindings', impact='修改学生纸卡绑定；历史课堂名单保留。')
    async def put_cards(self, request):
        user = self.staff(request)
        cid = request.match_info['class_id']
        self.access(user, cid, edit=True)
        body = await self.body(request)
        expected = revision(body.get('revision'))
        if ('initialize' in body) == ('bindings' in body) or 'initialize' in body and body['initialize'] is not True:
            fail('请选择初始化或明确的纸卡绑定。')
        with self.db.transaction():
            current, value = self.cards(cid)
            if expected != current:
                fail('纸卡设置已被修改，请刷新后核对。', 409)
            _, roster = self.roster(cid)
            active = {s['id'] for s in roster}
            bindings, used = value['bindings'], set(value['used'])
            if body.get('initialize'):
                if len(roster) > 157:
                    fail('当前名单超过 157 人，无法为全部学生初始化纸卡。')
                available = iter(n for n in range(1, 158) if n not in used)
                for student in roster:
                    if bindings.get(student['id']) is None:
                        number = next(available, None)
                        if number is None:
                            fail('未使用纸卡不足，请明确设置绑定；旧号不会自动分给其他学生。')
                        bindings[student['id']] = number
                        used.add(number)
            else:
                changes = array(body['bindings'], 300, '纸卡绑定')
                ids = []
                for binding in changes:
                    sid = identifier(obj(binding, '绑定').get('studentId'))
                    ids.append(sid)
                    if sid not in active or 'cardNumber' not in binding:
                        fail('绑定学生不在当前名单中，或缺少纸卡编号。')
                    number = binding['cardNumber']
                    if number is not None:
                        integer(number, '纸卡编号', 1, 157)
                        # Explicit assignment may reuse a departed student's card.
                        bindings = {k: v for k, v in bindings.items() if k in active or v != number}
                        used.add(number)
                    bindings[sid] = number
                unique(ids, '绑定学生')
            unique([n for n in bindings.values() if n is not None], '纸卡编号')
            self.db.run('''INSERT INTO card_quiz_cards(class_id,revision,value) VALUES(?,?,?)
                ON CONFLICT(class_id) DO UPDATE SET revision=excluded.revision,value=excluded.value''',
                        (cid, expected + 1, dumps({'bindings': bindings, 'used': sorted(used)})))
            self.audit(user, 'card-quiz.cards.save', 'class', cid, '更新纸卡编号')
        return self.reply(self.cards_payload(cid, user))

    def own(self, table, qid, user, *, deleted=False):
        # table is always a literal supplied by this module, never request input.
        row = self.db.one(f'SELECT * FROM {table} WHERE id=?', (identifier(qid),))
        if not row or not deleted and row.get('deleted'):
            fail('记录不存在。', 404)
        if row['owner_id'] != user['id']:
            fail('只能管理自己的私有题库和题单。', 403)
        return row

    def image_owned(self, image, uid):
        if image is None:
            return
        row = self.db.one('SELECT owner_id FROM card_quiz_images WHERE id=?', (identifier(image),))
        if not row or row['owner_id'] != uid:
            fail('只能使用本人上传的图片。', 403)

    def image_refs(self, kind, rid, cid, questions):
        for image in {q['imageId'] for q in questions if q['imageId'] is not None}:
            if not self.db.one('SELECT 1 FROM card_quiz_images WHERE id=?', (image,)):
                fail('题目图片不存在。')
            self.db.run('INSERT OR IGNORE INTO card_quiz_image_refs(image_id,kind,ref_id,class_id) VALUES(?,?,?,?)',
                        (image, kind, rid, cid))

    @teacher_read('card-quiz.questions', '查看本人纸卡题库')
    async def get_questions(self, request):
        user = self.staff(request)
        rows = self.limited('SELECT value FROM card_quiz_questions WHERE owner_id=? AND deleted=0 ORDER BY rowid', (user['id'],))
        return self.reply({'questions': [json.loads(r['value']) for r in rows]})

    def write_question(self, user, value, qid, version):
        clean = validate_question(value)
        self.image_owned(clean['imageId'], user['id'])
        clean.update(id=qid, revision=version, ownerId=user['id'])
        self.db.run('''INSERT INTO card_quiz_questions(id,owner_id,revision,value) VALUES(?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value''',
                    (qid, user['id'], version, dumps(clean)))
        self.db.run('INSERT INTO card_quiz_question_versions(question_id,revision,value) VALUES(?,?,?)',
                    (qid, version, dumps(clean)))
        return clean

    @teacher_action('card-quiz.question.create', '新建私有纸卡题目', fields='value requestKey')
    async def post_question(self, request):
        user = self.staff(request)
        body = await self.body(request)
        qid = creation_id(user, 'question', body)
        with self.db.transaction():
            if 'requestKey' in body:
                row = self.db.one('SELECT owner_id,deleted,value FROM card_quiz_questions WHERE id=?', (qid,))
                if row:
                    saved = json.loads(row['value'])
                    if row['owner_id'] != user['id'] or row['deleted'] or validate_question(saved) != validate_question(body.get('value')):
                        fail('这道草稿已保存，内容已变化。请在我的题库中核对已保存的题目。', 409)
                    return self.reply(saved)
            if self.db.one('SELECT COUNT(*) n FROM card_quiz_questions WHERE owner_id=? AND deleted=0', (user['id'],))['n'] >= MAX_LIST:
                fail(f'私有题库最多 {MAX_LIST} 题。')
            result = self.write_question(user, body.get('value'), qid, 1)
            self.audit(user, 'card-quiz.question.create', 'card-quiz-question', result['id'], '新建题目')
        return self.reply(result)

    @teacher_action('card-quiz.question.save', '修改私有纸卡题目', fields='id revision value')
    async def put_question(self, request):
        user = self.staff(request)
        body = await self.body(request)
        expected = revision(body.get('revision'))
        with self.db.transaction():
            row = self.own('card_quiz_questions', self.resource_id(request, body), user)
            if row['revision'] != expected:
                fail('题目已被修改，请刷新后核对。', 409)
            result = self.write_question(user, body.get('value'), row['id'], expected + 1)
            self.audit(user, 'card-quiz.question.save', 'card-quiz-question', row['id'], '更新题目')
        return self.reply(result)

    @teacher_action('card-quiz.question.delete', '删除私有纸卡题目', fields='id revision',
                    impact='从个人题库删除题目；已发布题单与课堂快照保留。')
    async def delete_question(self, request):
        user = self.staff(request)
        body = await self.body(request)
        expected = revision(body.get('revision'))
        with self.db.transaction():
            row = self.own('card_quiz_questions', self.resource_id(request, body), user)
            if row['revision'] != expected:
                fail('题目已被修改，请刷新后核对。', 409)
            self.db.run('UPDATE card_quiz_questions SET deleted=1 WHERE id=?', (row['id'],))
            self.audit(user, 'card-quiz.question.delete', 'card-quiz-question', row['id'], '删除私有题目')
        return self.reply({'id': row['id']})

    @teacher_manual(IMAGE_REASON)
    async def post_image(self, request):
        user = self.staff(request)
        body = await self.body(request, 3 * 1024 * 1024)
        value = body.get('dataUrl')
        match = re.fullmatch(r'data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})', value) if isinstance(value, str) else None
        if not match:
            fail('图片仅支持 PNG、JPEG 或 WebP data URL。')
        try:
            data = base64.b64decode(match[2], validate=True)
        except (ValueError, binascii.Error):
            fail('图片 Base64 无效。')
        if not data or len(data) > 2 * 1024 * 1024:
            fail('解码后的图片最多 2 MiB。')
        kind = match[1]
        valid = (kind == 'png' and data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 33 and data[12:16] == b'IHDR'
                 or kind == 'jpeg' and data.startswith(b'\xff\xd8\xff') and data.endswith(b'\xff\xd9')
                 or kind == 'webp' and data.startswith(b'RIFF') and len(data) >= 20
                 and data[8:12] == b'WEBP' and data[12:16] in (b'VP8 ', b'VP8L', b'VP8X')
                 and int.from_bytes(data[4:8], 'little') + 8 == len(data))
        if not valid:
            fail('图片真实文件签名与类型不符。')
        iid = creation_id(user, 'image', body)
        inserted = self.db.run('''INSERT INTO card_quiz_images(id,owner_id,mime,data,created_at) VALUES(?,?,?,?,?)
                                  ON CONFLICT(id) DO NOTHING''', (iid, user['id'], 'image/' + kind, data, self.service.now_ms()))
        if not inserted.rowcount and not self.db.one(
                'SELECT 1 FROM card_quiz_images WHERE id=? AND owner_id=? AND mime=? AND data=?',
                (iid, user['id'], 'image/' + kind, data)):
            fail('本次草稿的配图已变化，请核对截图后重新录题。', 409)
        return self.reply({'id': iid})

    def image_allowed(self, iid, *, user=None, device=None):
        row = self.db.one('SELECT owner_id FROM card_quiz_images WHERE id=?', (iid,))
        if not row:
            return False
        if user and row['owner_id'] == user['id']:
            return True
        refs = self.db.all('''SELECT DISTINCT r.class_id FROM card_quiz_image_refs r
            WHERE r.image_id=? AND ((r.kind='publication' AND EXISTS(
                SELECT 1 FROM card_quiz_publications p WHERE p.id=r.ref_id AND p.withdrawn=0))
                OR (r.kind='session' AND EXISTS(SELECT 1 FROM card_quiz_sessions s WHERE s.id=r.ref_id)))''', (iid,))
        return any(device and device['class_id'] == r['class_id'] or user and
                   self.service.can_access_class(self.db, user, r['class_id']) for r in refs)

    @teacher_manual(IMAGE_REASON)
    async def get_image(self, request):
        is_device = 'Authorization' in request.headers or 'X-ICeClass-Device-Id' in request.headers
        device = self.device(request) if is_device else None
        user = None if is_device else self.staff(request)
        iid = identifier(request.match_info['id'])
        row = self.db.one('SELECT mime,data FROM card_quiz_images WHERE id=?', (iid,))
        if not row:
            fail('图片不存在。', 404)
        if not self.image_allowed(iid, user=user, device=device):
            fail('没有查看这张图片的权限。', 403)
        return web.Response(body=row['data'], content_type=row['mime'])

    def deck_value(self, row):
        return {'id': row['id'], 'revision': row['revision'], 'title': row['title'],
                'questionIds': json.loads(row['question_ids'])}

    def deck_fields(self, body, user):
        title = string(body.get('title'), '题单名称', 200)
        ids = [identifier(q) for q in array(body.get('questionIds'), 100, '题单题目')]
        unique(ids, '题单题目')
        for qid in ids:
            self.own('card_quiz_questions', qid, user)
        return title, ids

    @teacher_read('card-quiz.decks', '查看本人纸卡题单')
    async def get_decks(self, request):
        user = self.staff(request)
        rows = self.limited('SELECT * FROM card_quiz_decks WHERE owner_id=? ORDER BY rowid', (user['id'],))
        return self.reply({'decks': [self.deck_value(row) for row in rows]})

    @teacher_action('card-quiz.deck.create', '新建私有纸卡题单', fields='title questionIds')
    async def post_deck(self, request):
        user = self.staff(request)
        body = await self.body(request)
        with self.db.transaction():
            title, ids = self.deck_fields(body, user)
            if self.db.one('SELECT COUNT(*) n FROM card_quiz_decks WHERE owner_id=?', (user['id'],))['n'] >= MAX_LIST:
                fail(f'私有题单最多 {MAX_LIST} 份。')
            did = new_id()
            self.db.run('INSERT INTO card_quiz_decks(id,owner_id,revision,title,question_ids) VALUES(?,?,1,?,?)',
                        (did, user['id'], title, dumps(ids)))
            self.audit(user, 'card-quiz.deck.create', 'card-quiz-deck', did, '新建题单')
        return self.reply({'id': did, 'revision': 1, 'title': title, 'questionIds': ids})

    @teacher_action('card-quiz.deck.save', '修改私有纸卡题单', fields='id revision title questionIds')
    async def put_deck(self, request):
        user = self.staff(request)
        body = await self.body(request)
        expected = revision(body.get('revision'))
        with self.db.transaction():
            row = self.own('card_quiz_decks', self.resource_id(request, body), user)
            if row['revision'] != expected:
                fail('题单已被修改，请刷新后核对。', 409)
            title, ids = self.deck_fields(body, user)
            self.db.run('UPDATE card_quiz_decks SET revision=?,title=?,question_ids=? WHERE id=?',
                        (expected + 1, title, dumps(ids), row['id']))
            self.audit(user, 'card-quiz.deck.save', 'card-quiz-deck', row['id'], '更新题单')
        return self.reply({'id': row['id'], 'revision': expected + 1, 'title': title, 'questionIds': ids})

    @teacher_action('card-quiz.deck.publish', '发布纸卡题单到班级', fields='id revision classId',
                    impact='保存题单快照供所选班级下载；之后修改个人题库不会改变快照。')
    async def publish_deck(self, request):
        user = self.staff(request)
        body = await self.body(request)
        cid, expected = identifier(body.get('classId')), revision(body.get('revision'))
        self.access(user, cid)
        with self.db.transaction():
            row = self.own('card_quiz_decks', self.resource_id(request, body), user)
            if row['revision'] != expected:
                fail('题单已被修改，请刷新后核对。', 409)
            questions = []
            for qid in json.loads(row['question_ids']):
                q = json.loads(self.own('card_quiz_questions', qid, user)['value'])
                questions.append({**q, 'bankId': q['id'], 'bankVersion': q['revision']})
            if not questions:
                fail('空题单不能发布。')
            if len({q['subjectId'] for q in questions}) != 1:
                fail('题单只能发布同一学科的题目，请按学科拆分后再发布。')
            if self.db.one('SELECT COUNT(*) n FROM card_quiz_publications WHERE class_id=? AND withdrawn=0', (cid,))['n'] >= MAX_LIST:
                fail(f'每班最多 {MAX_LIST} 份可用题单。')
            pid = new_id()
            value = {'id': pid, 'classId': cid, 'title': row['title'], 'questions': questions}
            self.db.run('INSERT INTO card_quiz_publications(id,owner_id,class_id,value,created_at) VALUES(?,?,?,?,?)',
                        (pid, user['id'], cid, dumps(value), self.service.now_ms()))
            self.image_refs('publication', pid, cid, questions)
            self.audit(user, 'card-quiz.deck.publish', 'class', cid, '发布纸卡题单')
        return self.reply(value)

    def publications(self, cid):
        return [json.loads(row['value']) for row in self.limited(
            'SELECT value FROM card_quiz_publications WHERE class_id=? AND withdrawn=0 ORDER BY created_at,id', (cid,))]

    @teacher_read('card-quiz.publications', '查看班级已发布纸卡题单', target='class')
    async def get_publications(self, request):
        user = self.staff(request)
        cid = request.match_info['class_id']
        self.access(user, cid)
        return self.reply({'publications': self.publications(cid)})

    @teacher_action('card-quiz.publication.withdraw', '撤回纸卡题单', fields='id', impact='撤回未来使用入口；已开始课堂的快照保留。')
    async def delete_publication(self, request):
        user = self.staff(request)
        body = await self.body(request) if 'id' not in request.match_info else None
        with self.db.transaction():
            row = self.own('card_quiz_publications', self.resource_id(request, body), user)
            self.access(user, row['class_id'])
            self.db.run('UPDATE card_quiz_publications SET withdrawn=1 WHERE id=?', (row['id'],))
            self.audit(user, 'card-quiz.publication.withdraw', 'class', row['class_id'], '撤回纸卡题单')
        return self.reply({'id': row['id']})

    @teacher_manual(DEVICE_REASON)
    async def bootstrap(self, request):
        device = self.device(request)
        cid = device['class_id']
        room = self.db.one('SELECT name FROM classes WHERE id=?', (cid,))
        cards = self.cards_payload(cid)
        roster_version, _ = self.roster(cid)
        publications = self.publications(cid)
        return self.reply({'classId': cid, 'className': room['name'], 'rosterRevision': roster_version,
                           'cardRevision': cards['revision'], 'students': cards['students'],
                           'publications': [{'id': p['id'], 'title': p['title'], 'questionCount': len(p['questions'])} for p in publications]})

    @teacher_manual(DEVICE_REASON)
    async def device_publication(self, request):
        device = self.device(request)
        row = self.db.one('SELECT * FROM card_quiz_publications WHERE id=? AND withdrawn=0',
                          (identifier(request.match_info['id']),))
        if not row:
            fail('题单不存在或已撤回。', 404)
        if row['class_id'] != device['class_id']:
            fail('只能下载当前绑定班级的题单。', 403)
        return self.reply(json.loads(row['value']))


def install(app, service, banban):
    feature = CardQuiz(app, service)
    recognition = CardQuizRecognition(feature, banban)
    app.on_cleanup.append(recognition.close)
    app.on_cleanup.append(feature.preview_turn.close)

    @web.middleware
    async def errors(request, handler):
        if not request.path.startswith('/api/card-quiz/'):
            return await handler(request)
        try:
            if request.path == '/api/card-quiz/device/sync':
                request = request.clone(client_max_size=MAX_SYNC_BODY + 1)
            return await handler(request)
        except QuizError as error:
            return feature.reply({'error': str(error), 'code': error.code}, error.status)
        except web.HTTPException as error:
            return feature.reply({'error': error.reason, 'code': QuizError(error.reason, error.status).code}, error.status)

    app.middlewares.append(errors)
    routes = [
        ('GET', '/classes/{class_id}/cards', feature.get_cards), ('PUT', '/classes/{class_id}/cards', feature.put_cards),
        ('GET', '/questions', feature.get_questions), ('POST', '/questions', feature.post_question),
        ('POST', '/questions/recognize', recognition.recognize),
        ('PUT', '/questions/{id}', feature.put_question), ('DELETE', '/questions/{id}', feature.delete_question),
        ('POST', '/images', feature.post_image), ('GET', '/images/{id}', feature.get_image),
        ('GET', '/decks', feature.get_decks), ('POST', '/decks', feature.post_deck), ('PUT', '/decks/{id}', feature.put_deck),
        ('POST', '/decks/{id}/publish', feature.publish_deck), ('GET', '/classes/{class_id}/publications', feature.get_publications),
        ('DELETE', '/publications/{id}', feature.delete_publication), ('GET', '/device/bootstrap', feature.bootstrap),
        ('GET', '/device/publications/{id}', feature.device_publication), ('POST', '/device/sync', feature.sync),
        ('GET', '/sessions', feature.list_sessions), ('GET', '/sessions/{id}', feature.get_session),
        ('PUT', '/sessions/{id}', feature.put_session), ('GET', '/report', feature.report), ('GET', '/export', feature.export),
        ('POST', '/device/pair', feature.device_pair), ('POST', '/pair', feature.claim_pair),
        ('POST', '/scan', feature.claim_scan), ('POST', '/device/pair/cancel', feature.cancel_pair),
        ('GET', '/pairs/{pair_id}', feature.get_pair), ('POST', '/pairs/{pair_id}/commands', feature.post_command),
        ('POST', '/pairs/{pair_id}/preview', feature.answer_preview),
        ('GET', '/pairs/{pair_id}/commands/{id}', feature.get_command), ('POST', '/device/relay', feature.relay),
        ('POST', '/device/receipt-ids', feature.receipt_ids)]
    for method, path, handler in routes:
        app.router.add_route(method, '/api/card-quiz' + path, handler)
    return feature

"""Storage schema and bounded validation shared by the card quiz handlers."""
from __future__ import annotations

import hashlib
import json
import copy
import uuid


SCHEMA = """
CREATE TABLE IF NOT EXISTS card_quiz_cards (
 class_id TEXT PRIMARY KEY REFERENCES classes(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS card_quiz_images (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
 mime TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS card_quiz_questions (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL, value TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_card_quiz_question_owner ON card_quiz_questions(owner_id,deleted);
CREATE TABLE IF NOT EXISTS card_quiz_question_versions (
 question_id TEXT NOT NULL REFERENCES card_quiz_questions(id), revision INTEGER NOT NULL,
 value TEXT NOT NULL, PRIMARY KEY(question_id,revision));
CREATE TABLE IF NOT EXISTS card_quiz_decks (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL, title TEXT NOT NULL, question_ids TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS card_quiz_publications (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
 class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
 value TEXT NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_card_quiz_publication_class ON card_quiz_publications(class_id,withdrawn);
CREATE TABLE IF NOT EXISTS card_quiz_sessions (
 id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL REFERENCES devices(id), subject_id TEXT NOT NULL,
 started_at INTEGER NOT NULL, ended_at INTEGER, seq INTEGER NOT NULL,
 revision INTEGER NOT NULL, raw_value TEXT NOT NULL, value TEXT NOT NULL,
 teacher_id TEXT REFERENCES users(id), updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_card_quiz_session_class ON card_quiz_sessions(class_id,started_at);
CREATE TABLE IF NOT EXISTS card_quiz_events (
 session_id TEXT NOT NULL REFERENCES card_quiz_sessions(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
 PRIMARY KEY(session_id,seq), UNIQUE(session_id,id));
CREATE TABLE IF NOT EXISTS card_quiz_batches (
 session_id TEXT NOT NULL REFERENCES card_quiz_sessions(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(session_id,seq));
CREATE TABLE IF NOT EXISTS card_quiz_reviews (
 session_id TEXT NOT NULL REFERENCES card_quiz_sessions(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 value TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id,revision));
CREATE TABLE IF NOT EXISTS card_quiz_image_refs (
 image_id TEXT NOT NULL REFERENCES card_quiz_images(id), kind TEXT NOT NULL,
 ref_id TEXT NOT NULL, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
 PRIMARY KEY(image_id,kind,ref_id));
CREATE TABLE IF NOT EXISTS card_quiz_pairs (
 id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE,
 session_id TEXT NOT NULL REFERENCES card_quiz_sessions(id) ON DELETE CASCADE,
 class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL REFERENCES devices(id), code_expires_at INTEGER NOT NULL,
 user_id TEXT REFERENCES users(id), login_hash TEXT, expires_at INTEGER, scan_key_hash TEXT,
 revoked INTEGER NOT NULL DEFAULT 0, activated INTEGER NOT NULL DEFAULT 0,
 state TEXT, last_seen INTEGER, device_polled_at INTEGER, phone_polled_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_card_quiz_pair_session ON card_quiz_pairs(session_id);
CREATE TABLE IF NOT EXISTS card_quiz_relay_states (
 session_id TEXT PRIMARY KEY REFERENCES card_quiz_sessions(id) ON DELETE CASCADE,
 state TEXT NOT NULL, last_seen INTEGER NOT NULL, polled_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS card_quiz_commands (
 pair_id TEXT NOT NULL REFERENCES card_quiz_pairs(id) ON DELETE CASCADE,
 id TEXT NOT NULL, fingerprint TEXT NOT NULL, value TEXT NOT NULL,
 status TEXT NOT NULL, result TEXT, error TEXT, rejection_origin TEXT, created_at INTEGER NOT NULL,
 PRIMARY KEY(pair_id,id));
"""

MAX_LIST = 1000
MAX_EVENTS = 100000
MAX_QUESTIONS = 100
MAX_ROUNDS = 100
MAX_BODY = 8 * 1024 * 1024
MAX_SYNC_BODY = 32 * 1024 * 1024
DEVICE_REASON = '教室端专用设备协议，需要设备令牌及当前班级绑定，不能由教师会话代替。'
PHONE_REASON = '手机须在现场扫描白板邀请并允许相机；旧版配对使用教师登录，收答以白板保存的来源为准。'
IMAGE_REASON = '题目图片由本人选择上传或授权查看，原始文件不传给模型，按作者和班级引用校验权限。'
ACTIONS = {'add_question', 'start_round', 'answer', 'end_round', 'resume_round', 'set_source',
           'edit_question', 'reveal', 'set_exempt', 'end_session', 'recover', 'set_multi_option'}
PHONE_ACTIONS = {'answer', 'start_round', 'resume_round', 'end_round', 'add_question', 'edit_question', 'reveal', 'set_multi_option'}


class QuizError(ValueError):
    def __init__(self, message, status=400, code=None):
        super().__init__(message)
        self.status = status
        self.code = code or {400: 'invalid_command', 401: 'authentication_required',
                             403: 'forbidden', 404: 'not_found', 409: 'stale_context',
                             413: 'invalid_command', 429: 'rate_limited'}.get(status, 'request_failed')


def fail(message, status=400, code=None):
    raise QuizError(message, status, code)


def dumps(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(dumps(value).encode('utf-8')).hexdigest()


def new_id():
    return str(uuid.uuid4())


def string(value, label, maximum=128, *, empty=False):
    if (not isinstance(value, str) or len(value) > maximum or not empty and not value.strip()
            or any(ord(c) < 32 and c not in '\n\r\t' or 0xD800 <= ord(c) <= 0xDFFF for c in value)):
        fail(f'{label}格式不正确，最多 {maximum} 字。')
    return value


def identifier(value):
    value = string(value, '编号')
    if any(ord(c) < 32 for c in value) or value.startswith('data:'):
        fail('编号格式不正确。')
    return value


def integer(value, label='数字', minimum=0, maximum=2_147_483_647):
    if type(value) is not int or not minimum <= value <= maximum:
        fail(f'{label}格式或范围不正确。')
    return value


def revision(value):
    return integer(value, '版本号')


def timestamp(value):
    return integer(value, '时间', maximum=9_007_199_254_740_991)


def array(value, maximum, label):
    if not isinstance(value, list) or len(value) > maximum:
        fail(f'{label}格式不正确，最多 {maximum} 项。')
    return value


def obj(value, label='请求'):
    if not isinstance(value, dict):
        fail(f'{label}格式不正确。')
    return value


def unique(values, label):
    if len(set(values)) != len(values):
        fail(f'{label}重复。')


def bank_link(value):
    bid, version = value.get('bankId'), value.get('bankVersion')
    if bid is None and version is None:
        return None, None
    return identifier(bid), integer(version, '题库版本', 1)


def validate_question(value):
    obj(value, '题目')
    kind = value.get('type')
    if kind not in ('single', 'boolean', 'multiple'):
        fail('题型只支持单选、判断或多选。')
    options = [string(o, '选项', 2000, empty=True) for o in array(value.get('options'), 4, '选项')]
    if not 2 <= len(options) <= (2 if kind == 'boolean' else 4):
        fail('单选和多选需 2-4 个连续选项，判断需 A/B 两项。')
    answer = value.get('answer')
    if answer is not None:
        if (not isinstance(answer, str) or not answer or len(answer) > (len(options) if kind == 'multiple' else 1)
                or len(set(answer)) != len(answer) or any(o not in 'ABCD'[:len(options)] for o in answer)):
            fail('标准答案不在当前选项中或存在重复。')
        answer = ''.join(sorted(answer))
    tags = [string(tag, '标签', 80) for tag in array(value.get('tags'), 50, '标签')]
    unique(tags, '标签')
    image = value.get('imageId')
    if image is not None:
        identifier(image)
    return {'subjectId': identifier(value.get('subjectId')), 'type': kind,
            'text': string(value.get('text'), '题干', 20000, empty=True), 'imageId': image,
            'options': options, 'answer': answer, 'tags': tags}


def source(value):
    if value.get('source') not in ('board', 'phone'):
        fail('采集来源无效。')
    return {'source': value['source'], 'sourceId': identifier(value.get('sourceId')),
            'generation': integer(value.get('generation'), '采集代次')}


def choices_option(choices):
    return ''.join(o for o in 'ABCD' if choices.get(o) is True)


def answer_complete(question, answer, round_value):
    return answer is not None and (question['type'] != 'multiple'
                                   or round_value.get('noCardPolicy') == 'abstain'
                                   or len(answer['choices']) == len(question['options']))


def validate_session(value):
    obj(value, '课堂快照')
    if type(value.get('schema')) is not int or value['schema'] != 1 or value.get('cardVersion') != 'ice-v1':
        fail('课堂或纸卡版本不支持。')
    result = {'schema': 1, 'cardVersion': 'ice-v1', **source(value)}
    for key in ('id', 'classId', 'deviceId', 'subjectId'):
        result[key] = identifier(value.get(key))
    result['seq'] = integer(value.get('seq'), '序号', maximum=MAX_EVENTS)
    result['startedAt'] = timestamp(value.get('startedAt'))
    result['endedAt'] = None if value.get('endedAt') is None else timestamp(value['endedAt'])
    if result['endedAt'] is not None and result['endedAt'] < result['startedAt']:
        fail('课堂结束时间早于开始时间。')
    roster = []
    for student in array(value.get('roster'), 300, '课堂名单'):
        obj(student, '学生')
        number = student.get('cardNumber')
        roster.append({'id': identifier(student.get('id')), 'name': string(student.get('name'), '姓名', 40),
                       'cardNumber': None if number is None else integer(number, '纸卡编号', 1, 157)})
    unique([s['id'] for s in roster], '学生编号')
    unique([s['cardNumber'] for s in roster if s['cardNumber'] is not None], '纸卡编号')
    student_ids = {s['id'] for s in roster}
    result['roster'] = roster
    questions, round_ids, open_rounds = [], [], []
    for q in array(value.get('questions'), MAX_QUESTIONS, '课堂题目'):
        clean = {'id': identifier(obj(q, '课堂题目').get('id')), 'revision': integer(q.get('revision'), '题目版本', 1),
                 **validate_question(q)}
        clean['bankId'], clean['bankVersion'] = bank_link(q)
        if 'ownerId' in q:
            clean['ownerId'] = identifier(q['ownerId'])
        if clean['subjectId'] != result['subjectId'] or type(q.get('revealed')) is not bool:
            fail('题目学科或揭晓状态无效。')
        clean['revealed'], clean['rounds'] = q['revealed'], []
        previous_end = result['startedAt']
        for r in array(q.get('rounds'), MAX_ROUNDS, '答题轮次'):
            obj(r, '答题轮次')
            rid = identifier(r.get('id'))
            round_ids.append(rid)
            started = timestamp(r.get('startedAt'))
            ended = None if r.get('endedAt') is None else timestamp(r['endedAt'])
            status, purpose = r.get('status'), r.get('purpose')
            if (purpose not in ('formal', 'practice') or status not in ('collecting', 'paused', 'closed')
                    or (status == 'closed') != (ended is not None)
                    or started < previous_end or ended is not None and ended < started
                    or result['endedAt'] is not None and (ended is None or ended > result['endedAt'])):
                fail('轮次状态、用途或时间顺序无效。')
            rs = source(r)
            if rs['generation'] > result['generation']:
                fail('轮次采集代次超过课堂代次。')
            if status != 'closed':
                open_rounds.append((clean['id'], rid))
                if (rs['source'], rs['sourceId']) != (result['source'], result['sourceId']) or status == 'collecting' and rs['generation'] != result['generation']:
                    fail('未结束轮次来源与课堂来源不一致。')
            answers = {}
            multi = clean['type'] == 'multiple'
            letters = 'ABCD'[:len(clean['options'])]
            if multi:
                active = r.get('activeOption')
                if not isinstance(active, str) or len(active) != 1 or active not in letters:
                    fail('多选轮次的当前收答项无效。')
            elif 'activeOption' in r:
                fail('非多选轮次不能包含当前收答项。')
            for sid, a in obj(r.get('answers'), '作答').items():
                obj(a, '作答')
                confirmed = timestamp(a.get('confirmedAt'))
                option = a.get('option')
                if (sid not in student_ids or confirmed < started or ended is not None and confirmed > ended):
                    fail('作答学生、选项或确认时间无效。')
                if multi:
                    choices = obj(a.get('choices'), '多选逐项作答')
                    if (not choices or any(k not in letters or len(k) != 1 or type(v) is not bool for k, v in choices.items())
                            or option != choices_option(choices)):
                        fail('多选逐项作答或合成选项无效。')
                elif ('choices' in a or not isinstance(option, str) or len(option) != 1 or option not in letters):
                    fail('作答选项无效。')
                answers[sid] = {'option': option, 'confirmedAt': confirmed,
                                'seq': integer(a.get('seq'), '作答序号', 1, result['seq'])}
                if multi:
                    answers[sid]['choices'] = dict(choices)
            exempt = [identifier(s) for s in array(r.get('exempt'), 300, '免答名单')]
            unique(exempt, '免答学生')
            if not set(exempt).issubset(student_ids):
                fail('免答学生不在课堂名单中。')
            clean['rounds'].append({'id': rid, 'startedAt': started, 'endedAt': ended, 'purpose': purpose,
                                    'status': status, **rs, 'answers': answers, 'exempt': exempt})
            if 'noCardPolicy' in r:
                if r['noCardPolicy'] != 'abstain':
                    fail('轮次未举卡规则无效。')
                clean['rounds'][-1]['noCardPolicy'] = r['noCardPolicy']
            if multi:
                clean['rounds'][-1]['activeOption'] = active
            previous_end = ended if ended is not None else started
        questions.append(clean)
    unique([q['id'] for q in questions], '题目编号')
    unique(round_ids, '轮次编号')
    result['questions'] = questions
    qid, rid = value.get('currentQuestionId'), value.get('currentRoundId')
    if qid is not None:
        identifier(qid)
    if rid is not None:
        identifier(rid)
    current = next((q for q in questions if q['id'] == qid), None)
    if (qid is not None and current is None or rid is not None and
            (current is None or not any(r['id'] == rid for r in current['rounds']))
            or len(open_rounds) > 1 or open_rounds and open_rounds != [(qid, rid)]):
        fail('当前题目或轮次无效。')
    result.update(currentQuestionId=qid, currentRoundId=rid)
    for key in ('rosterRevision', 'cardRevision'):
        if key in value:
            result[key] = revision(value[key])
    return result


def validate_events(events, start, end):
    integer(start, '起始序号', 1, MAX_EVENTS + 1)
    array(events, MAX_EVENTS, '同步事件')
    if len(events) != max(0, end - start + 1) or start > end + 1:
        fail('同步事件缺序或范围无效。')
    cleaned, ids, previous = [], [], 0
    for seq, event in enumerate(events, start):
        obj(event, '事件')
        if (type(event.get('seq')) is not int or event['seq'] != seq
                or not isinstance(event.get('action'), str) or event['action'] not in ACTIONS):
            fail('同步事件缺序或动作无效。')
        stamp = timestamp(event.get('at'))
        if stamp < previous:
            fail('事件时间顺序无效。')
        previous = stamp
        eid = identifier(event.get('id'))
        ids.append(eid)
        payload = obj(event.get('payload'), '事件内容')
        # Finite JSON and a bound per event prevent unbounded nested data retention.
        try:
            size = len(dumps(payload).encode('utf-8'))
        except (ValueError, TypeError, RecursionError):
            fail('事件内容无效。')
        if size > 64 * 1024:
            fail('单个同步事件最多 64 KiB。')
        clean = {'seq': seq, 'id': eid, 'action': event['action'], 'at': stamp, 'payload': payload}
        for key in ('questionId', 'roundId'):
            if key not in event:
                fail('同步事件缺少原命令题目或轮次元数据。')
            clean[key] = None if event[key] is None else identifier(event[key])
        clean['generation'] = integer(event.get('generation'), '事件采集代次')
        clean['sourceId'] = identifier(event.get('sourceId'))
        if 'noCardPolicy' in event:
            if event['action'] != 'start_round' or event['noCardPolicy'] != 'abstain':
                fail('未举卡规则只能在开轮时确定。')
            clean['noCardPolicy'] = event['noCardPolicy']
        if set(event) - set(clean):
            fail('同步事件包含未知字段。')
        cleaned.append(clean)
    unique(ids, '请求编号')
    return cleaned


def validate_transition(old, new, events):
    if not old:
        return
    for key in ('id', 'classId', 'deviceId', 'subjectId', 'startedAt', 'cardVersion', 'roster'):
        if old[key] != new[key]:
            fail('课堂身份或初始名单不能被后续同步替换。', 409)
    if old['endedAt'] is not None:
        fail('已结束课堂不能上传更高序号。', 409)
    if new['generation'] < old['generation']:
        fail('不能回退采集代次。', 409)
    new_questions = {q['id']: q for q in new['questions']}
    for q in old['questions']:
        current = new_questions.get(q['id'])
        if current is None:
            fail('已保存题目不能从课堂移除。', 409)
        if current['subjectId'] != q['subjectId']:
            fail('课堂题目学科不能改变。', 409)
        if q['bankId'] is not None and any(current[key] != q[key] for key in ('type', 'options')):
            fail('关联题库版本的题型和原选项不能改变。', 409)
        if any(r['answers'] for r in q['rounds']) and (
                current['type'] != q['type'] or len(current['options']) != len(q['options'])):
            fail('已有作答不能改变题型或选项范围。', 409)
        new_rounds = {r['id']: r for r in current['rounds']}
        for r in q['rounds']:
            nr = new_rounds.get(r['id'])
            if nr is None or r['status'] == 'closed' and nr != r:
                fail('封存轮次不能被覆盖或删除。', 409)
            if nr['startedAt'] != r['startedAt'] or nr['purpose'] != r['purpose']:
                fail('既有轮次的身份不能改变。', 409)
    new_events = [e for e in events if e['seq'] > old['seq']]
    if (old['source'], old['sourceId']) != (new['source'], new['sourceId']):
        if not any(e['action'] == 'set_source' for e in new_events) or new['generation'] <= old['generation']:
            fail('切换来源必须有对应事件并推进采集代次。', 409)
    for q in old['questions']:
        for r in q['rounds']:
            nr = next(nr for nr in new_questions[q['id']]['rounds'] if nr['id'] == r['id'])
            for sid, answer in r['answers'].items():
                current = nr['answers'].get(sid)
                if current is None or current != answer and current['seq'] <= old['seq']:
                    fail('作答变化必须有新的确认事件。')
    changes = sum(e['action'] in ('add_question', 'start_round', 'end_round', 'end_session',
                                  'recover', 'set_source', 'resume_round', 'set_multi_option') for e in new_events)
    # start/end may also advance the generation on the board.
    if new['generation'] > old['generation'] and not any(
            e['action'] in ('add_question', 'recover', 'set_source', 'resume_round', 'start_round', 'end_round', 'end_session', 'set_multi_option') for e in new_events):
        fail('采集代次变化缺少对应事件。')
    if new_events and new_events[-1]['action'] == 'recover':
        if new['generation'] != old['generation'] + changes:
            fail('恢复必须推进采集代次。')
        if any(r['status'] == 'collecting' for q in new['questions'] for r in q['rounds']):
            fail('进程恢复后未结束轮次必须暂停。')
    if new_events and all(e['action'] == 'recover' for e in new_events):
        expected = copy.deepcopy(old)
        expected.update(seq=new['seq'], generation=old['generation'] + len(new_events))
        for q in expected['questions']:
            for r in q['rounds']:
                if r['status'] != 'closed':
                    actual = next(nr for nr in new_questions[q['id']]['rounds'] if nr['id'] == r['id'])
                    if actual['generation'] not in (r['generation'], expected['generation']):
                        fail('恢复轮次代次无效。')
                    r.update(status='paused', generation=actual['generation'])
        if new != expected:
            fail('恢复仅可暂停未结束轮次并推进序号和代次。')

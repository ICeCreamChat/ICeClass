"""Bounded, authenticated phone-to-board transport; only the board confirms a command."""
from __future__ import annotations

import json
import secrets
from urllib.parse import urlencode

from card_quiz_events import public_state, replay
from card_quiz_models import (DEVICE_REASON, MAX_EVENTS, PHONE_ACTIONS, PHONE_REASON, array, dumps,
                              fail, fingerprint, identifier, integer, new_id, obj, string, unique)
from teacher_capabilities import teacher_manual


PAIR_CODE_MS = 5 * 60 * 1000
PAIR_SESSION_MS = 4 * 60 * 60 * 1000
CONNECTED_MS = 15000
STATE_KEYS = {'sessionId', 'className', 'subjectId', 'questionId', 'questionNumber', 'questionType',
              'optionCount', 'roundId', 'roundStatus', 'source', 'sourceId', 'generation', 'seq',
              'received', 'expected', 'ended'}
MULTIPLE_STATE_KEYS = {'activeOption', 'optionReceived'}
MAX_RECEIPT_BYTES = 16 * 1024


def business_state(value):
    # Class names can change independently of the Journal's business sequence.
    return {key: item for key, item in value.items() if key != 'className'}


def native_json_size(value):
    """Upper bound for default JsonNode.ToJsonString() UTF-8 wire encoding.

    Its Basic Latin encoder escapes non-ASCII and HTML-sensitive characters,
    including quotes inside the canonical fingerprint. Count UTF-16 surrogate
    pairs as two six-byte escapes. Numbers reserve 32 bytes for JS/.NET formats.
    """
    if isinstance(value, str):
        size = 2
        for char in value:
            code = ord(char)
            if char in '\b\f\n\r\t\\':
                size += 2
            elif char in '\"&\'+<>`' or code < 32 or code > 126:
                size += 12 if code > 0xFFFF else 6
            else:
                size += 1
        return size
    if value is None:
        return 4
    if type(value) is bool:
        return 4 if value else 5
    if isinstance(value, (int, float)):
        return max(32, len(dumps(value)))
    if isinstance(value, list):
        return 2 + max(0, len(value) - 1) + sum(native_json_size(item) for item in value)
    return 2 + max(0, len(value) - 1) + sum(
        native_json_size(key) + 1 + native_json_size(item) for key, item in value.items())


def command_receipt_size(command, state):
    # All supported phone actions retain these classroom/source IDs, and only
    # add_question/start_round can introduce a fresh 36-character UUID. Reserve
    # the largest public-state variants, counters and any legal future class name.
    result_state = dict(state)
    for key in ('questionId', 'roundId'):
        result_state[key] = max((state[key], '0' * 36), key=native_json_size)
    result_state.update(className=max((state['className'], '\U0010ffff' * 40), key=native_json_size),
                        questionNumber=100, questionType='multiple', optionCount=4,
                        roundStatus='collecting', seq=MAX_EVENTS, generation=2_147_483_647,
                        received=300, expected=300, ended=False, activeOption='D', optionReceived=300)
    # Python's JSON float notation and JS canonical notation may differ. Each
    # numeric leaf can add at most 32 characters; nested JSON string escaping
    # can expand each added character to six bytes in the native encoder.
    def numbers(value):
        if type(value) in (int, float):
            return 1
        if isinstance(value, list):
            return sum(numbers(item) for item in value)
        if isinstance(value, dict):
            return sum(numbers(item) for item in value.values())
        return 0

    return native_json_size({'id': command['id'], 'fingerprint': dumps(command),
                             'result': {'seq': MAX_EVENTS, 'status': 'confirmed', 'state': result_state}}) + numbers(command) * 32 * 6


class RelayHandlers:
    def login_hash(self, request):
        token = request.cookies.get('iceclass_session')
        if not token:
            fail('请使用真实教师会话。', 401)
        return self.service.sha256(token)

    def relay_state(self, sid):
        return self.db.one('SELECT * FROM card_quiz_relay_states WHERE session_id=?', (sid,))

    @teacher_manual(DEVICE_REASON)
    async def receipt_ids(self, request):
        device = self.device(request)
        body = await self.body(request)
        if set(body) != {'sessionId', 'ids'}:
            fail('命令来源查询只接受课堂编号和请求编号列表。')
        row = self.device_session(identifier(body['sessionId']), device)
        ids = [identifier(cid) for cid in array(body['ids'], 128, '历史请求编号')]
        unique(ids, '历史请求编号')
        if not ids:
            return self.reply({'commandIds': []})
        placeholders = ','.join('?' for _ in ids)
        registered = {command['id'] for command in self.db.all(f'''SELECT c.id FROM card_quiz_commands c
            JOIN card_quiz_pairs p ON p.id=c.pair_id
            WHERE p.session_id=? AND p.device_id=? AND p.class_id=? AND c.id IN ({placeholders})''',
            (row['id'], device['id'], device['class_id'], *ids))}
        return self.reply({'commandIds': [cid for cid in ids if cid in registered]})

    def reject_pending(self, pair_id, error):
        self.db.run("UPDATE card_quiz_commands SET status='rejected',error=?,rejection_origin='transport' WHERE pair_id=? AND status='pending'",
                    (error, pair_id))

    def effective_state(self, row):
        saved = self.public_from_session(json.loads(row['raw_value']))
        relay = self.relay_state(row['id'])
        if not relay:
            return saved, None
        live = json.loads(relay['state'])
        if live['seq'] == saved['seq']:
            if business_state(live) != business_state(saved):
                fail('相同序号的同步与中转状态不一致。', 409)
            return saved, relay
        newer, older = (live, saved) if live['seq'] > saved['seq'] else (saved, live)
        if newer['generation'] < older['generation'] or older['ended'] and not newer['ended']:
            fail('同步与中转状态的采集许可冲突。', 409)
        return {**newer, 'className': saved['className']}, relay

    @teacher_manual(DEVICE_REASON)
    async def device_pair(self, request):
        device = self.device(request)
        sid = identifier((await self.body(request)).get('sessionId'))
        stamp = self.service.now_ms()
        with self.db.transaction():
            row = self.device_session(sid, device, active=True)
            state, _ = self.effective_state(row)
            if state['ended']:
                fail('课堂已经结束。', 409)
            if state['source'] == 'phone' and state['roundStatus'] not in (None, 'closed'):
                fail('请先封存当前轮次，再更换手机。', 409)
            for old in self.db.all('SELECT id FROM card_quiz_pairs WHERE device_id=? AND revoked=0', (device['id'],)):
                self.db.run('UPDATE card_quiz_pairs SET revoked=1 WHERE id=?', (old['id'],))
                self.reject_pending(old['id'], '设备已更换手机配对。')
            pid, code = new_id(), secrets.token_hex(6).upper()
            self.db.run('''INSERT INTO card_quiz_pairs(id,code_hash,session_id,class_id,device_id,code_expires_at)
                VALUES(?,?,?,?,?,?)''', (pid, self.service.sha256(code), sid, device['class_id'], device['id'], stamp + PAIR_CODE_MS))
        url = str(request.url.origin()) + '/card-quiz/phone/?' + urlencode({'code': code})
        return self.reply({'pairId': pid, 'code': code, 'url': url, 'expiresAt': stamp + PAIR_CODE_MS})

    @teacher_manual(PHONE_REASON)
    async def claim_pair(self, request):
        user = self.staff(request)
        code = string((await self.body(request)).get('code'), '配对码', 128)
        login_hash = self.login_hash(request)
        stamp = self.service.now_ms()
        with self.db.transaction():
            pair = self.db.one('SELECT * FROM card_quiz_pairs WHERE code_hash=?', (self.service.sha256(code),))
            if not pair:
                fail('配对码无效。', 404)
            self.access(user, pair['class_id'])
            if pair['revoked'] or pair['user_id'] is not None or pair['code_expires_at'] <= stamp:
                fail('配对码已使用、撤回或过期。', 409)
            device = self.db.one('''SELECT d.id,d.class_id FROM devices d JOIN classes c ON c.id=d.class_id
                WHERE d.id=? AND d.enabled=1 AND d.deleted_at IS NULL AND c.enabled=1''', (pair['device_id'],))
            if not device or device['class_id'] != pair['class_id']:
                fail('设备已停用或改绑。', 403)
            self.device_session(pair['session_id'], device, active=True)
            login = self.db.one('SELECT expires_at FROM sessions WHERE token_hash=?', (login_hash,))
            expires = min(stamp + PAIR_SESSION_MS, login['expires_at'])
            self.db.run('UPDATE card_quiz_pairs SET user_id=?,login_hash=?,expires_at=? WHERE id=?',
                        (user['id'], login_hash, expires, pair['id']))
        return self.reply({'pairId': pair['id'], 'classId': pair['class_id'], 'sessionId': pair['session_id'], 'expiresAt': expires})

    def pair_context(self, request):
        user = self.staff(request)
        pair = self.db.one('SELECT * FROM card_quiz_pairs WHERE id=?', (identifier(request.match_info['pair_id']),))
        if not pair:
            fail('配对不存在。', 404)
        if pair['user_id'] != user['id'] or pair['login_hash'] != self.login_hash(request):
            fail('配对仅限领取配对码的本人登录会话。', 403, 'pair_invalid')
        self.access(user, pair['class_id'])
        if pair['revoked'] or pair['expires_at'] is None or pair['expires_at'] <= self.service.now_ms():
            fail('配对已撤回或过期。', 403, 'pair_invalid')
        device = self.db.one('''SELECT d.id,d.class_id FROM devices d JOIN classes c ON c.id=d.class_id
            WHERE d.id=? AND d.enabled=1 AND d.deleted_at IS NULL AND c.enabled=1''', (pair['device_id'],))
        if not device or device['class_id'] != pair['class_id']:
            fail('配对设备已停用或改绑。', 403, 'pair_invalid')
        session = self.device_session(pair['session_id'], device)
        state, relay = self.effective_state(session)
        matches = state['source'] == 'phone' and state['sourceId'] == pair['id']
        if pair['activated'] and not matches:
            fail('课堂采集来源已撤回或更换。', 403, 'stale_context')
        connected = bool(relay and self.service.now_ms() - relay['last_seen'] <= CONNECTED_MS
                         and matches and not state['ended'] and session['ended_at'] is None)
        return pair, state, connected

    def public_from_session(self, session):
        room = self.db.one('SELECT name FROM classes WHERE id=?', (session['classId'],))
        return public_state(session, room['name'])

    def historical_pair(self, pair_id, session):
        pair = self.db.one('SELECT * FROM card_quiz_pairs WHERE id=?', (pair_id,))
        if (not pair or pair['session_id'] != session['id'] or pair['device_id'] != session['deviceId']
                or pair['class_id'] != session['classId'] or pair['user_id'] is None):
            fail('历史来源不属于本设备、本班、已领取的课堂配对。', 409)
        return pair

    def sync_receipts(self, values):
        receipts = array(values, 128, '历史设备回执')
        ids = []
        for receipt in receipts:
            obj(receipt, '历史设备回执')
            if set(receipt) != {'id', 'fingerprint', 'result'}:
                fail('历史回执必须包含原请求指纹和成功结果。')
            ids.append(identifier(receipt['id']))
            if len(dumps(receipt).encode('utf-8')) > MAX_RECEIPT_BYTES:
                fail('单条设备回执最多 16 KiB。', 413)
            string(receipt['fingerprint'], '原请求指纹', 16 * 1024)
            obj(receipt['result'], '原确认结果')
        unique(ids, '回执编号')
        return receipts

    def prove_command(self, command, event, session):
        obj(command, '原命令')
        if (set(command) - {'id', 'sessionId', 'questionId', 'roundId', 'generation', 'sourceId', 'action', 'payload'}
                or command.get('sessionId') != session['id']
                or type(command.get('generation')) is not int
                or any(command.get(k) != event[k] for k in ('id', 'action', 'questionId', 'roundId', 'generation', 'sourceId'))
                or dumps(command.get('payload', {})) != dumps(event['payload'])):
            fail('历史回执的原命令与持久化事件不一致。', 409)

    def finish_command(self, command, *, result=None, error=None, proven=False):
        status = 'confirmed' if result is not None else 'rejected'
        encoded = dumps(result) if result is not None else None
        if command['status'] != 'pending':
            auto = command['status'] == 'rejected' and command['rejection_origin'] == 'transport'
            explicit_rejection = auto and status == 'rejected'
            if not explicit_rejection and (command['status'], command['result'], command['error']) == (status, encoded, error):
                return
            if not explicit_rejection and not (proven and status == 'confirmed' and auto):
                fail('相同命令的设备回执内容不一致。', 409)
        self.db.run('''UPDATE card_quiz_commands SET status=?,result=?,error=?,rejection_origin=?
            WHERE pair_id=? AND id=?''',
                    (status, encoded, error, 'device' if status == 'rejected' else None, command['pair_id'], command['id']))

    def restore_receipts(self, row, receipts):
        if not receipts:
            return []
        session = json.loads(row['raw_value'])
        events = [json.loads(e['value']) for e in self.db.all(
            'SELECT value FROM card_quiz_events WHERE session_id=? ORDER BY seq', (row['id'],))]
        by_id = {event['id']: event for event in events}
        wanted = []
        for receipt in receipts:
            if receipt['id'] not in by_id:
                fail('历史回执缺少本课堂的持久化事件证明。', 409)
            wanted.append(by_id[receipt['id']]['seq'])
        expected = replay(session, events, wanted=wanted, class_name=self.public_from_session(session)['className'],
                          check_phone=lambda pid: self.historical_pair(pid, session))
        for receipt in receipts:
            event = by_id[receipt['id']]
            try:
                command = json.loads(receipt['fingerprint'])
                dumps(command).encode('utf-8')
            except (ValueError, TypeError, RecursionError, UnicodeError):
                fail('原请求指纹必须是 Journal 规范 JSON 命令字符串。')
            self.prove_command(command, event, session)
            if event['sourceId'] != 'board':
                self.historical_pair(event['sourceId'], session)
            result = receipt['result']
            state = obj(result.get('state'), '原确认状态')
            string(state.get('className'), '班级名称', 40)
            original = expected[event['seq']]
            if dumps({**result, 'state': business_state(state)}) != dumps(
                    {**original, 'state': business_state(original['state'])}):
                fail('历史回执不是该事件的原始确认后状态。', 409)
            registered = self.db.one('''SELECT c.*,p.device_id,p.class_id FROM card_quiz_commands c
                JOIN card_quiz_pairs p ON p.id=c.pair_id WHERE p.session_id=? AND c.id=?''',
                                     (row['id'], event['id']))
            if registered:
                if (registered['device_id'] != row['device_id'] or registered['class_id'] != row['class_id']
                        or registered['pair_id'] != event['sourceId'] or registered['fingerprint'] != fingerprint(command)):
                    fail('历史回执与已注册手机命令不一致。', 409)
                self.finish_command(registered, result=receipt['result'], proven=True)
        return [receipt['id'] for receipt in receipts]

    def pending_commands(self, state, stamp):
        commands = []
        for pair in self.db.all('SELECT * FROM card_quiz_pairs WHERE session_id=?', (state['sessionId'],)):
            valid = (not pair['revoked'] and pair['expires_at'] is not None and pair['expires_at'] > stamp
                     and state['source'] == 'phone' and state['sourceId'] == pair['id'] and not state['ended'])
            if not valid:
                self.reject_pending(pair['id'], '课堂已结束、手机来源已更换或配对已过期。')
                if pair['activated'] and (state['source'] != 'phone' or state['sourceId'] != pair['id']):
                    self.db.run('UPDATE card_quiz_pairs SET revoked=1 WHERE id=?', (pair['id'],))
                continue
            self.db.run('UPDATE card_quiz_pairs SET activated=1 WHERE id=?', (pair['id'],))
            for command in self.db.all("SELECT * FROM card_quiz_commands WHERE pair_id=? AND status='pending' ORDER BY created_at,rowid", (pair['id'],)):
                value = json.loads(command['value'])
                stale = value['generation'] != state['generation'] or any(
                    key in value and value[key] != state[key] for key in ('questionId', 'roundId'))
                stale = stale or value['action'] == 'answer' and state['roundStatus'] != 'collecting'
                if value['action'] == 'set_multi_option':
                    stale = stale or state['questionType'] != 'multiple' or state['roundStatus'] != 'collecting'
                if value['action'] == 'answer' and state['questionType'] == 'multiple':
                    stale = stale or value['payload'].get('targetOption') != state['activeOption']
                if stale:
                    self.db.run("UPDATE card_quiz_commands SET status='rejected',error=?,rejection_origin='transport' WHERE pair_id=? AND id=?",
                                ('题目、轮次或采集代次已变化。', pair['id'], command['id']))
                else:
                    commands.append(value)
        return commands

    def phone_poll(self, pair):
        stamp = self.service.now_ms()
        if pair['phone_polled_at'] is not None and stamp - pair['phone_polled_at'] < 1000:
            fail('手机轮询最多每 1 秒一次，请稍后重试。', 429)
        self.db.run('UPDATE card_quiz_pairs SET phone_polled_at=? WHERE id=?', (stamp, pair['id']))

    @teacher_manual(PHONE_REASON)
    async def get_pair(self, request):
        pair, state, connected = self.pair_context(request)
        self.phone_poll(pair)
        ids = array(request.query.getall('commandId', []), 128, '待确认命令')
        unique([identifier(cid) for cid in ids], '待确认命令')
        receipts = []
        for cid in ids:
            command = self.db.one('SELECT * FROM card_quiz_commands WHERE pair_id=? AND id=?', (pair['id'], cid))
            if command:
                receipts.append({'id': cid, **self.command_result(command)})
        return self.reply({'state': state, 'connected': connected, 'expiresAt': pair['expires_at'], 'receipts': receipts})

    def command_result(self, row, *, post=False):
        if row['status'] == 'confirmed':
            result = json.loads(row['result'])
            return result if post else {'status': 'confirmed', 'result': result}
        if row['status'] == 'rejected':
            return {'status': 'rejected', 'error': row['error'],
                    'code': 'stale_context' if row['rejection_origin'] == 'transport' else 'invalid_command'}
        return {'status': 'pending', **({'id': row['id']} if post else {})}

    @teacher_manual(PHONE_REASON)
    async def post_command(self, request):
        pair, state, connected = self.pair_context(request)
        body = await self.body(request, 16 * 1024)
        cid = identifier(body.get('id'))
        content = fingerprint(body)
        with self.db.transaction():
            old = self.db.one('SELECT * FROM card_quiz_commands WHERE pair_id=? AND id=?', (pair['id'], cid))
            # Lost acknowledgements remain retryable after the board advanced its round/generation.
            if old:
                if old['fingerprint'] != content:
                    fail('相同请求编号的命令内容不一致。', 409, 'invalid_command')
                return self.reply(self.command_result(old, post=True))
            if self.db.one('''SELECT 1 FROM card_quiz_commands c JOIN card_quiz_pairs p ON p.id=c.pair_id
                WHERE p.session_id=? AND c.id=?''', (pair['session_id'], cid)):
                fail('相同请求编号已用于本课堂的其他手机配对。', 409, 'invalid_command')
            if not isinstance(body.get('action'), str) or body['action'] not in PHONE_ACTIONS:
                fail('手机不允许执行这个动作。')
            if set(body) - {'id', 'sessionId', 'questionId', 'roundId', 'generation', 'sourceId', 'action', 'payload'}:
                fail('命令字段无效。')
            if (body.get('sessionId') != pair['session_id'] or body.get('sourceId') != pair['id']
                    or type(body.get('generation')) is not int or body['generation'] != state['generation']):
                fail('课堂、来源或采集代次已经变化。', 409)
            for key in ('questionId', 'roundId'):
                if key in body and body[key] != state[key]:
                    fail('当前题目或轮次已变化。', 409)
            if state['ended'] or state['source'] != 'phone' or state['sourceId'] != pair['id']:
                fail('课堂已结束或尚未保存手机采集来源。', 409)
            if not connected:
                fail('白板连接已超时，本条命令未投递。', 409, 'command_timeout')
            payload = obj(body.get('payload'), '命令内容')
            try:
                receipt_size = command_receipt_size(body, state)
            except RecursionError:
                fail('命令内容嵌套层次过深。')
            if receipt_size > MAX_RECEIPT_BYTES:
                fail('本条命令的完整原指纹、结果和班名回执超过 16 KiB，请缩短命令内容。', 413)
            if body['action'] == 'answer':
                number = integer(payload.get('cardNumber'), '纸卡编号', 1, 157)
                option = payload.get('option')
                if state['roundStatus'] != 'collecting':
                    fail('当前轮次未采集。', 409)
                multi = state['questionType'] == 'multiple'
                if not isinstance(option, str) or len(option) != 1 or option not in ('AB' if multi else 'ABCD'[:state['optionCount']]):
                    fail('答案选项无效。', 409, 'invalid_command')
                if multi and payload.get('targetOption') != state['activeOption']:
                    fail('多选收答项已变化，请刷新后重试。', 409)
                session = json.loads(self.session_row(pair['session_id'])['raw_value'])
                if number not in {s['cardNumber'] for s in session['roster']}:
                    fail('纸卡不在本课堂名单中。')
            elif body['action'] == 'set_multi_option':
                option = payload.get('option')
                if state['questionType'] != 'multiple' or state['roundStatus'] != 'collecting':
                    fail('仅正在收答的多选轮次可以切换收答项。', 409)
                if not isinstance(option, str) or len(option) != 1 or option not in 'ABCD'[:state['optionCount']]:
                    fail('多选收答项无效。', 409, 'invalid_command')
            if self.db.one('''SELECT COUNT(*) n FROM card_quiz_commands c JOIN card_quiz_pairs p ON p.id=c.pair_id
                WHERE p.session_id=? AND c.status='pending' ''', (pair['session_id'],))['n'] >= 128:
                fail('待确认队列已满（128 条），请等待白板确认。', 429)
            if self.db.one('SELECT COUNT(*) n FROM card_quiz_commands WHERE pair_id=?', (pair['id'],))['n'] >= MAX_EVENTS:
                fail('本次手机配对命令数量已达上限。', 429)
            self.db.run('''INSERT INTO card_quiz_commands(pair_id,id,fingerprint,value,status,created_at)
                VALUES(?,?,?,?,'pending',?)''', (pair['id'], cid, content, dumps(body), self.service.now_ms()))
        return self.reply({'status': 'pending', 'id': cid})

    @teacher_manual(PHONE_REASON)
    async def get_command(self, request):
        pair, _, _ = self.pair_context(request)
        row = self.db.one('SELECT * FROM card_quiz_commands WHERE pair_id=? AND id=?',
                          (pair['id'], identifier(request.match_info['id'])))
        if not row:
            fail('命令不存在。', 404)
        self.phone_poll(pair)
        return self.reply(self.command_result(row))

    def validate_public(self, value, row, *, historical=False):
        obj(value, '匿名课堂状态')
        multi = value.get('questionType') == 'multiple'
        if set(value) != STATE_KEYS | (MULTIPLE_STATE_KEYS if multi else set()):
            fail('匿名课堂状态字段不完整或包含不允许公开的内容。')
        room = self.db.one('SELECT name FROM classes WHERE id=?', (row['class_id'],))
        string(value['className'], '班级名称', 40)
        if value['sessionId'] != row['id'] or value['subjectId'] != row['subject_id']:
            fail('匿名状态不属于当前班级或课堂。', 403)
        for key in ('questionId', 'roundId'):
            if value[key] is not None:
                identifier(value[key])
        integer(value['questionNumber'], '题号', 0, 100)
        integer(value['optionCount'], '选项数量', 0, 4)
        integer(value['generation'], '采集代次')
        integer(value['seq'], '序号', 0 if historical else row['seq'], MAX_EVENTS)
        integer(value['expected'], '应答人数', 0, 300)
        integer(value['received'], '已答人数', 0, value['expected'])
        if multi:
            integer(value['optionReceived'], '当前项已答人数', value['received'], value['expected'])
            active = value['activeOption']
            if (value['roundId'] is None and (active is not None or value['optionReceived'] != 0 or value['received'] != 0)
                    or value['roundId'] is not None and (not isinstance(active, str) or len(active) != 1
                                                          or active not in 'ABCD'[:value['optionCount']])):
                fail('多选匿名状态的当前收答项无效。')
        if (value['source'] not in ('board', 'phone') or value['roundStatus'] not in (None, 'collecting', 'paused', 'closed')
                or type(value['ended']) is not bool or value['questionType'] not in (None, 'single', 'boolean', 'multiple')
                or value['questionId'] is None and (value['questionType'] is not None or value['optionCount'] not in (0, 2, 3, 4))
                or value['questionId'] is not None and (value['questionType'] is None or not 2 <= value['optionCount'] <= (2 if value['questionType'] == 'boolean' else 4))
                or value['roundId'] is None and value['roundStatus'] is not None
                or value['ended'] and value['roundStatus'] == 'collecting'):
            fail('匿名状态的题型、轮次或采集来源无效。')
        identifier(value['sourceId'])
        if value['source'] == 'phone':
            if historical:
                self.historical_pair(value['sourceId'], json.loads(row['raw_value']))
                return value
            pair = self.db.one('SELECT * FROM card_quiz_pairs WHERE id=?', (value['sourceId'],))
            if (not pair or pair['session_id'] != row['id'] or pair['device_id'] != row['device_id']
                    or pair['class_id'] != row['class_id'] or pair['revoked'] or pair['user_id'] is None
                    or pair['expires_at'] <= self.service.now_ms()):
                fail('手机来源未配对、已撤回或过期。', 409, 'pair_invalid')
            # Permission and the exact login session must also remain live on device polling.
            user = self.db.one('''SELECT u.id,u.role,ug.grade FROM users u LEFT JOIN user_grades ug ON ug.user_id=u.id
                WHERE u.id=? AND u.enabled=1 AND u.deleted_at IS NULL''', (pair['user_id'],))
            login = self.db.one('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?',
                                (pair['login_hash'], pair['user_id'], self.service.now_ms()))
            if not user or not login or not self.service.can_access_class(self.db, user, row['class_id']):
                fail('手机登录或班级授权已撤销。', 403, 'pair_invalid')
        return value if historical else {**value, 'className': room['name']}

    @teacher_manual(DEVICE_REASON)
    async def relay(self, request):
        device = self.device(request)
        body = await self.body(request)
        sid = identifier(body.get('sessionId'))
        stamp = self.service.now_ms()
        with self.db.transaction():
            row = self.device_session(sid, device)
            state = self.validate_public(body.get('state'), row)
            effective, previous = self.effective_state(row)
            if state['seq'] == effective['seq'] and business_state(state) != business_state(effective):
                fail('相同序号的匿名状态内容不一致。', 409)
            if (state['seq'] < effective['seq'] or state['generation'] < effective['generation']
                    or effective['ended'] and not state['ended']):
                fail('匿名课堂状态不能回退。', 409)
            if (state['questionType'] == effective['questionType'] == 'multiple'
                    and state['roundId'] is not None and state['roundId'] == effective['roundId']
                    and state['activeOption'] != effective['activeOption']
                    and (effective['roundStatus'] != 'collecting' or state['generation'] <= effective['generation'])):
                fail('多选切换收答项必须在采集中推进采集代次。', 409)
            if (state['source'], state['sourceId']) != (effective['source'], effective['sourceId']):
                if effective['roundStatus'] not in (None, 'closed') or state['generation'] <= effective['generation']:
                    fail('只能在封存轮次后切换来源，并推进采集代次。', 409)
            if row['ended_at'] is not None and not state['ended']:
                fail('已结束课堂不能恢复采集。', 409)
            if previous:
                old_state = json.loads(previous['state'])
                if state['seq'] == old_state['seq'] and business_state(state) != business_state(old_state):
                    fail('相同序号的匿名状态内容不一致。', 409)
                if state['seq'] < old_state['seq'] or state['generation'] < old_state['generation'] or old_state['ended'] and not state['ended']:
                    fail('匿名课堂状态不能回退。', 409)
                if (state['source'], state['sourceId']) != (old_state['source'], old_state['sourceId']):
                    if (old_state['roundStatus'] not in (None, 'closed')
                            and json.loads(row['raw_value'])['seq'] <= old_state['seq']
                            or state['generation'] <= old_state['generation']):
                        fail('只能在轮次间切换来源，并推进采集代次。', 409)
            last_poll = self.db.one('''SELECT MAX(r.polled_at) stamp FROM card_quiz_relay_states r
                JOIN card_quiz_sessions s ON s.id=r.session_id WHERE s.device_id=?''', (device['id'],))['stamp']
            if last_poll is not None and stamp - last_poll < 750:
                fail('设备轮询最多每 750 毫秒一次，请稍后重试。', 429)
            receipts = array(body.get('receipts'), 128, '设备回执')
            receipt_ids = []
            durable = []
            for receipt in receipts:
                obj(receipt, '设备回执')
                cid = identifier(receipt.get('id'))
                receipt_ids.append(cid)
                if ('result' in receipt) == ('error' in receipt) or set(receipt) - {'id', 'result', 'error'}:
                    fail('回执必须明确包含结果或错误。')
                if 'result' in receipt:
                    obj(receipt['result'], '回执结果')
                else:
                    string(receipt['error'], '回执错误', 2000)
                if len(dumps(receipt).encode('utf-8')) > MAX_RECEIPT_BYTES:
                    fail('单条设备回执最多 16 KiB。', 413)
                commands = self.db.all('''SELECT c.* FROM card_quiz_commands c JOIN card_quiz_pairs p ON p.id=c.pair_id
                    WHERE p.session_id=? AND p.device_id=? AND c.id=?''', (sid, device['id'], cid))
                if len(commands) != 1:
                    fail('回执命令不存在或编号不唯一。')
                command = commands[0]
                if 'result' in receipt:
                    result = receipt['result']
                    if set(result) != {'seq', 'status', 'state'} or result['status'] != 'confirmed':
                        fail('成功回执必须包含原序号和匿名确认状态。')
                    integer(result['seq'], '确认序号', 1, state['seq'])
                    result_state = self.validate_public(result['state'], row, historical=True)
                    if result_state['seq'] != result['seq'] or result_state['generation'] > state['generation']:
                        fail('成功回执序号或采集代次无效。', 409)
                    event = self.db.one('SELECT 1 FROM card_quiz_events WHERE session_id=? AND id=?', (sid, cid))
                    if event:
                        durable.append({'id': cid, 'fingerprint': command['value'], 'result': result})
                    else:
                        self.finish_command(command, result=result)
                else:
                    self.finish_command(command, error=receipt['error'])
            unique(receipt_ids, '回执编号')
            self.restore_receipts(row, durable)
            self.db.run('''INSERT INTO card_quiz_relay_states(session_id,state,last_seen,polled_at) VALUES(?,?,?,?)
                ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,last_seen=excluded.last_seen,polled_at=excluded.polled_at''',
                        (sid, dumps(state), stamp, stamp))
            commands = self.pending_commands(state, stamp)
        pairings = []
        for pair in self.db.all('SELECT * FROM card_quiz_pairs WHERE session_id=? AND revoked=0', (sid,)):
            claimed = False
            if pair['user_id'] is not None and pair['expires_at'] is not None and pair['expires_at'] > stamp:
                user = self.db.one('SELECT id,role FROM users WHERE id=? AND enabled=1 AND deleted_at IS NULL', (pair['user_id'],))
                login = self.db.one('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?',
                                    (pair['login_hash'], pair['user_id'], stamp))
                claimed = bool(user and login and self.service.can_access_class(self.db, user, pair['class_id']))
            pairings.append({'pairId': pair['id'], 'claimed': claimed,
                             'expiresAt': pair['expires_at'] if claimed else pair['code_expires_at']})
        return self.reply({'commands': commands, 'pairings': pairings})

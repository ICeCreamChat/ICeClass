"""Scheduled self-study incidents, class-owned budgets and private event photos."""
from __future__ import annotations

import asyncio
import base64
import json
import math
import re
import uuid
from datetime import datetime, timedelta

from aiohttp import ClientError, ClientSession, ClientTimeout, DummyCookieJar, web
from banban_connections import upstream_connector
from feedback import image_type
from permissions import scope_sql
from reading import SHANGHAI, local_day
from island import lessons_on
from self_study_ai import RESERVATION, classify, messages_for, has_chat_evidence
from teacher_capabilities import teacher_action, teacher_manual, teacher_read

FEATURE_KEY = web.AppKey('self_study', object)
DEFAULT = {'enabled': False, 'authorized': False, 'aiEnabled': False, 'photoEnabled': True,
           'dailyCalls': 4, 'dailyTokens': 2400, 'sensitivity': 'balanced', 'voiceTriggerMs': 600,
           'observationSeconds': 10, 'reminderWaitSeconds': 90, 'confirmationsAfterReminder': 1}
PHOTO_TTL = 24 * 3600000
EVENT_TTL = 7 * 24 * 3600000
REVIEW_INTERVAL = 90000
WARNING_TTL = 300000
# Conservative veto: explicit learning context wins over a noisy semantic label.
# This deliberately favors missed chatter over interrupting a lesson.
LEARNING_CUES = re.compile(r'这(?:道)?题|第[一二三四五六七八九十百0-9]+题|方程|函数|等式|系数|定理|公式|课文|单词|语法|作业|练习册|'
                           r'\b(?:equation|coefficient|theorem|homework|grammar)\b', re.IGNORECASE)
MAX_PHOTO_BYTES = 320000
SCHEMA = """
CREATE TABLE IF NOT EXISTS self_study_settings(
 class_id TEXT PRIMARY KEY REFERENCES classes(id) ON DELETE CASCADE, revision INTEGER NOT NULL, config TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS self_study_usage(
 class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, day TEXT NOT NULL,
 calls INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, estimated INTEGER NOT NULL DEFAULT 0,
 last_call_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(class_id,day));
CREATE TABLE IF NOT EXISTS self_study_decisions(
 class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, observation_id TEXT NOT NULL,
 device_id TEXT NOT NULL, created_at INTEGER NOT NULL, response TEXT NOT NULL,
 PRIMARY KEY(class_id,observation_id));
CREATE TABLE IF NOT EXISTS self_study_events(
 id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
 device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
 started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, warned_at INTEGER,
 reported_at INTEGER, status TEXT NOT NULL, classification TEXT NOT NULL DEFAULT 'chat',
 photo_status TEXT NOT NULL DEFAULT 'none', photo BLOB, photo_at INTEGER,
 handled_at INTEGER, handled_by TEXT, resolution TEXT, revision INTEGER NOT NULL,
 session_key TEXT NOT NULL, ended_at INTEGER,
 confirmations INTEGER NOT NULL DEFAULT 0, last_confirmation_at INTEGER, expires_at INTEGER);
CREATE INDEX IF NOT EXISTS self_study_events_class ON self_study_events(class_id,started_at DESC);
CREATE TABLE IF NOT EXISTS self_study_status(
 device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
 class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
 state TEXT NOT NULL, detail TEXT NOT NULL, updated_at INTEGER NOT NULL);
"""


def validate_config(body):
    if not isinstance(body, dict) or set(body) - set(DEFAULT):
        raise ValueError('晚自习设置格式不正确。')
    cfg = {**DEFAULT, **body}
    for field in ('enabled', 'authorized', 'aiEnabled', 'photoEnabled'):
        if type(cfg[field]) is not bool:
            raise ValueError('请选择有效的启用选项。')
    if type(cfg['dailyCalls']) is not int or not 0 <= cfg['dailyCalls'] <= 4:
        raise ValueError('每日 AI 请求上限为 0-4 次。')
    if type(cfg['dailyTokens']) is not int or not 1500 <= cfg['dailyTokens'] <= 2400:
        raise ValueError('每日 token 上限为 1500-2400。')
    if cfg['sensitivity'] not in ('low', 'balanced', 'high'):
        raise ValueError('请选择有效的声音灵敏度。')
    for key, low, high in (('voiceTriggerMs', 300, 3000), ('observationSeconds', 10, 30),
                           ('reminderWaitSeconds', 90, 300), ('confirmationsAfterReminder', 1, 3)):
        if type(cfg[key]) is not int or not low <= cfg[key] <= high:
            raise ValueError('请检查观察时长、等待时间和确认次数的范围。')
    if cfg['enabled'] and not cfg['authorized']:
        raise ValueError('启用前请确认学校已完成告知授权。')
    return cfg


def validate_observation(body, now):
    if not isinstance(body, dict):
        raise ValueError('观察数据格式不正确。')
    if not isinstance(body.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,80}', body['id']):
        raise ValueError('观察编号格式不正确。')
    for key in ('revision', 'startAt', 'endAt', 'speechMs', 'segments', 'longestMs'):
        if type(body.get(key)) is not int:
            raise ValueError('观察数据格式不正确。')
    start, end = body['startAt'], body['endAt']
    if not 10000 <= end - start <= 120000 or abs(end - now) > 30000:
        raise ValueError('观察窗口已过期，请重新观察。')
    if not 0 <= body['speechMs'] <= end - start or not 0 <= body['segments'] <= 100:
        raise ValueError('人声统计格式不正确。')
    if not 0 <= body['longestMs'] <= body['speechMs']:
        raise ValueError('人声统计格式不正确。')
    level = body.get('level')
    if type(level) not in (float, int) or not math.isfinite(level) or not 0 <= level <= 100:
        raise ValueError('相对声量格式不正确。')
    text = body.get('text', '')
    if not isinstance(text, str) or len(text) > 120 or any(ord(c) < 32 and c not in '\n\t' for c in text):
        raise ValueError('本次文字片段超出限制。')
    utterances = body.get('utterances')
    if utterances is not None:
        if not isinstance(utterances, list) or not 1 <= len(utterances) <= 6 or len(utterances) != body['segments']:
            raise ValueError('分段数量不正确。')
        previous_end = start
        characters = 0
        for u in utterances:
            if (not isinstance(u, dict) or any(type(u.get(k)) is not int for k in ('startAt', 'endAt', 'speechMs'))
                    or not previous_end <= u['startAt'] < u['endAt'] <= end
                    or not 300 <= u['speechMs'] <= u['endAt'] - u['startAt'] <= 8500
                    or not isinstance(u.get('text'), str) or not u['text'].strip()
                    or any(ord(c) < 32 for c in u['text'])):
                raise ValueError('分段时间或文字不正确。')
            previous_end = u['endAt']
            characters += len(u['text'])
        if (characters > 120 or end - start > 60000 or utterances[0]['startAt'] != start
                or utterances[-1]['endAt'] != end or sum(u['speechMs'] for u in utterances) != body['speechMs']
                or max(u['speechMs'] for u in utterances) != body['longestMs']):
            raise ValueError('分段与统计不一致。')
        utterances = [{k: u[k] for k in ('startAt', 'endAt', 'speechMs', 'text')} for u in utterances]
    return {key: body[key] for key in ('id', 'revision', 'startAt', 'endAt', 'speechMs', 'segments', 'longestMs', 'level')} | {'utterances': utterances}


class SelfStudyFeature:
    def __init__(self, app, service, connections):
        self.s, self.app, self.connections = service, app, connections
        self.db = app[service.STORE_KEY]
        self.db.db.executescript(SCHEMA)
        columns = {row['name'] for row in self.db.all('PRAGMA table_info(self_study_events)')}
        if 'confirmations' not in columns:
            self.db.run('ALTER TABLE self_study_events ADD COLUMN confirmations INTEGER NOT NULL DEFAULT 0')
        if 'last_confirmation_at' not in columns:
            self.db.run('ALTER TABLE self_study_events ADD COLUMN last_confirmation_at INTEGER')
        if 'expires_at' not in columns:
            self.db.run('ALTER TABLE self_study_events ADD COLUMN expires_at INTEGER')
        self.locks = {}
        self.client = None
        self.prune_at = 0
        self.classify = self._classify
        self.cleanup_task = None
        app.on_startup.append(self.start)
        app.on_cleanup.append(self.close)

    async def start(self, _):
        self.prune()
        self.cleanup_task = asyncio.create_task(self.cleanup_loop())

    async def cleanup_loop(self):
        while True:
            await asyncio.sleep(60)
            self.prune()

    async def close(self, _):
        if self.cleanup_task:
            self.cleanup_task.cancel()
            await asyncio.gather(self.cleanup_task, return_exceptions=True)
        if self.client:
            await self.client.close()

    async def _classify(self, cfg, observation):
        if self.client is None or self.client.closed:
            self.client = ClientSession(timeout=ClientTimeout(total=20, connect=5),
                connector=upstream_connector(), cookie_jar=DummyCookieJar())
        return await classify(self.client, cfg, observation)

    def prune(self):
        now = self.s.now_ms()
        if now < self.prune_at:
            return
        self.prune_at = now + 60000
        with self.db.transaction():
            self.db.run("""UPDATE self_study_events SET status='resolved',resolution='evidence_expired',ended_at=?
                WHERE status='warning' AND ended_at IS NULL
                AND COALESCE(expires_at,COALESCE(warned_at,started_at)+?)<=?""", (now, WARNING_TTL, now))
            self.db.run("UPDATE self_study_events SET photo=NULL,photo_status='expired' WHERE photo IS NOT NULL AND photo_at<=?", (now - PHOTO_TTL,))
            self.db.run("UPDATE self_study_events SET photo_status='failed' WHERE photo_status IN ('pending','capturing') AND reported_at<=?", (now - 120000,))
            self.db.run('DELETE FROM self_study_events WHERE started_at<?', (now - EVENT_TTL,))
            self.db.run('DELETE FROM self_study_decisions WHERE created_at<?', (now - EVENT_TTL,))
            self.db.run('DELETE FROM self_study_usage WHERE day<?', (local_day(now - EVENT_TTL),))

    def settings(self, cid):
        row = self.db.one('SELECT revision,config FROM self_study_settings WHERE class_id=?', (cid,))
        return ({**DEFAULT, **json.loads(row['config'])}, row['revision']) if row else (dict(DEFAULT), 0)

    def usage(self, cid):
        return self.db.one('SELECT calls,tokens,estimated,last_call_at FROM self_study_usage WHERE class_id=? AND day=?',
                           (cid, local_day(self.s.now_ms()))) or {'calls': 0, 'tokens': 0, 'estimated': 0, 'last_call_at': 0}

    def schedule(self, cid):
        """Derive effective lessons; never keep a second timetable."""
        row = self.db.one('SELECT revision,value FROM island_profiles WHERE class_id=?', (cid,))
        if not row:
            return []
        cfg = json.loads(row['value'])
        evening = cfg.get('dutyRotations', {}).get('evening', {})
        slots = sorted((s for s in cfg['slots'] if s['id'] in evening.get('slotIds', [])),
                       key=lambda s: s['start'])
        target = slots[1]['id'] if len(slots) == 2 else next(
            (s['id'] for s in cfg['slots'] if s['id'] == 'evening-study-2'
             or re.search(r'晚自习.*(?:第二|第2|二节|2节)', s['label'])), None)
        if target is None:
            return []
        today = datetime.fromtimestamp(self.s.now_ms() / 1000, SHANGHAI).date()
        result = []
        for offset in range(7):
            on = today + timedelta(days=offset)
            for lesson in lessons_on(cfg, on):
                if lesson['id'] != target:
                    continue
                midnight = datetime.combine(on, datetime.min.time(), SHANGHAI)
                start = int((midnight + timedelta(minutes=lesson['start'])).timestamp() * 1000)
                end = int((midnight + timedelta(minutes=lesson['end'])).timestamp() * 1000)
                result.append({'key': f"{on}:{target}:{start}:{end}:{row['revision']}",
                    'startAt': start, 'endAt': end, 'title': lesson['label'],
                    'temporary': lesson['temporary']})
        return result

    def session(self, cid):
        return next((p for p in self.schedule(cid) if p['startAt'] <= self.s.now_ms() < p['endAt']), None)

    def active(self, cid, cfg):
        return cfg['enabled'] and cfg['authorized'] and self.session(cid)

    def connection(self, cid):
        owners = self.db.all("""SELECT u.id,u.role FROM teacher_classes tc JOIN users u ON u.id=tc.user_id
            WHERE tc.class_id=? AND u.role='teacher' AND u.enabled=1 AND u.deleted_at IS NULL LIMIT 2""", (cid,))
        return self.connections.effective(owners[0]) if len(owners) == 1 else {}

    def teacher(self, request, cid=None):
        if self.s.is_classroom_request(request):
            return self.s.json_response({'error': '请在教师端查看自习管理。'}, 403)
        user = self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        if user['role'] == 'subject_teacher' or cid and not self.s.can_access_class(self.db, user, cid, include_teaching=False):
            return self.s.json_response({'error': '只能查看本人带班或管理范围内的班级。'}, 403)
        return user

    def device(self, request):
        return self.s.authenticate_device(request, request.headers.get('X-ICeClass-Device', ''))

    def still_bound(self, request, device):
        current = self.device(request)
        return current and current['class_id'] == device['class_id']

    def payload(self, cid):
        self.prune()
        cfg, revision = self.settings(cid)
        connection = self.connection(cid)
        status = self.db.one("""SELECT s.state,s.detail,s.updated_at,d.name FROM self_study_status s
            JOIN devices d ON d.id=s.device_id WHERE s.class_id=? AND d.enabled=1 AND d.class_id=s.class_id
            ORDER BY s.updated_at DESC LIMIT 1""", (cid,))
        schedule = self.schedule(cid)
        return {'classId': cid, 'config': cfg, 'revision': revision, 'serverTime': self.s.now_ms(), 'schedule': schedule,
                'inPeriod': bool(self.active(cid, cfg)), 'usage': self.usage(cid),
                'aiReady': bool(connection.get('enabled') and connection.get('apiKey')),
                'status': status}

    @teacher_read('self-study.classes', '查看晚自习班级与状态', head_only=True)
    async def classes(self, request):
        user = self.teacher(request)
        if isinstance(user, web.Response):
            return user
        clause, args = scope_sql(user, include_teaching=False)
        rows = self.db.all(f'SELECT c.id,c.name FROM classes c WHERE c.enabled=1 AND {clause}', args)
        return self.s.json_response({'classes': sorted(rows, key=lambda row: self.s.class_sort_key(row['name']))})

    @teacher_read('self-study.settings', '查看晚自习设置', target='class', head_only=True)
    async def get_settings(self, request):
        cid = request.match_info['class_id']
        user = self.teacher(request, cid)
        return user if isinstance(user, web.Response) else self.s.json_response(self.payload(cid))

    @teacher_action('self-study.update', '修改自习管理', target='class', head_only=True,
                    fields='config revision', impact='将修改本班识别规则、照片设置与每日 AI 用量上限。')
    async def save_settings(self, request):
        cid = request.match_info['class_id']
        user = self.teacher(request, cid)
        if isinstance(user, web.Response):
            return user
        try:
            body = await request.json()
            cfg = validate_config(body['config'])
            revision = body['revision']
            if type(revision) is not int:
                raise ValueError('版本格式不正确。')
        except (ValueError, KeyError, TypeError):
            return self.s.json_response({'error': '请检查授权、识别规则和 AI 上限。'}, 400)
        with self.db.transaction():
            _, current = self.settings(cid)
            if revision != current:
                return self.s.json_response({'error': '设置已被其他人修改，请重新载入后再保存。'}, 409)
            self.db.run('INSERT INTO self_study_settings VALUES(?,?,?) ON CONFLICT(class_id) DO UPDATE SET revision=excluded.revision,config=excluded.config',
                        (cid, current + 1, json.dumps(cfg, ensure_ascii=False)))
            self.db.run("UPDATE self_study_events SET ended_at=?,status=CASE WHEN status='warning' THEN 'resolved' ELSE status END WHERE class_id=? AND ended_at IS NULL", (self.s.now_ms(), cid))
            self.s.audit(self.db, user['id'], 'self-study.update', 'class', cid, json.dumps({'revision': current + 1}))
        await self.app[self.s.ROOMS_KEY].broadcast(cid, {'type': 'self_study_config'})
        return self.s.json_response(self.payload(cid))

    @teacher_manual('带设备凭据的晚自习配置和硬件状态协议。')
    async def device_config(self, request):
        device = self.device(request)
        if not device:
            return self.s.json_response({'error': '教室设备凭据已失效。'}, 401)
        return self.s.json_response(self.payload(device['class_id']))

    @teacher_manual('教室端报告麦克风与监测运行状态，不接收音频或转写。')
    async def device_status(self, request):
        device = self.device(request)
        if not device:
            return self.s.json_response({'error': '教室设备凭据已失效。'}, 401)
        try:
            body = await request.json()
            state, detail = body['state'], body.get('detail', '')
            if state not in {'inactive', 'listening', 'observing', 'analyzing', 'teaching', 'warning', 'reported', 'budget', 'ai_paused', 'error', 'paused'}:
                raise ValueError()
            if not isinstance(detail, str) or len(detail) > 160:
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            return self.s.json_response({'error': '运行状态格式不正确。'}, 400)
        if not self.still_bound(request, device):
            return self.s.json_response({'error': '教室绑定已变化。'}, 409)
        self.db.run('INSERT INTO self_study_status VALUES(?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET class_id=excluded.class_id,state=excluded.state,detail=excluded.detail,updated_at=excluded.updated_at',
                    (device['id'], device['class_id'], state, detail, self.s.now_ms()))
        return self.s.json_response({'ok': True})

    def record(self, device, oid, result):
        self.db.run('INSERT INTO self_study_decisions VALUES(?,?,?,?,?)',
                    (device['class_id'], oid, device['id'], self.s.now_ms(), json.dumps(result)))
        return self.s.json_response(result)

    @teacher_manual('教室设备确认连续安静后结束当前观察段，不修改班主任的待处理记录。')
    async def quiet(self, request):
        device = self.device(request)
        if not device:
            return self.s.json_response({'error': '教室设备凭据已失效。'}, 401)
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError()
            if type(body.get('revision')) is not int or body['revision'] != self.settings(device['class_id'])[1]:
                raise ValueError()
            if not isinstance(body.get('eventId'), str) or len(body['eventId']) > 80:
                raise ValueError()
        except (ValueError, TypeError):
            return self.s.json_response({'error': '设置已更新。'}, 409)
        if not self.still_bound(request, device):
            return self.s.json_response({'error': '教室绑定已变化。'}, 409)
        self.db.run("""UPDATE self_study_events SET ended_at=?,
            status=CASE WHEN status='warning' THEN 'resolved' ELSE status END
            WHERE class_id=? AND device_id=? AND id=? AND ended_at IS NULL""",
            (self.s.now_ms(), device['class_id'], device['id'], body['eventId']))
        return self.s.json_response({'ok': True})

    @teacher_manual('设备提交有长度限制的临时疑似文字和人声统计，按班级预算复核；不保存转写。')
    async def observe(self, request):
        device = self.device(request)
        if not device:
            return self.s.json_response({'error': '教室设备凭据已失效。'}, 401)
        try:
            observation = validate_observation(await request.json(), self.s.now_ms())
        except (ValueError, TypeError):
            return self.s.json_response({'error': '观察数据无效、过长或已过期。'}, 400)
        cid = device['class_id']
        async with self.locks.setdefault(cid, asyncio.Lock()):
            # Reauthenticate after waiting. A disabled/rebound device cannot use an old lease.
            fresh_device = self.device(request)
            if not fresh_device or fresh_device['class_id'] != cid:
                return self.s.json_response({'error': '教室绑定已变化。'}, 401)
            cfg, revision = self.settings(cid)
            if observation['revision'] != revision:
                return self.s.json_response({'error': '设置已更新，请同步后重新观察。'}, 409)
            session = self.active(cid, cfg)
            if not session or observation['startAt'] < session['startAt']:
                return self.s.json_response({'action': 'inactive'})
            previous = self.db.one('SELECT response FROM self_study_decisions WHERE class_id=? AND observation_id=?', (cid, observation['id']))
            if previous:
                result = json.loads(previous['response'])
                # Replayed packets cannot request another physical capture or warning.
                return self.s.json_response(result)
            self.prune()
            now = self.s.now_ms()
            if abs(observation['endAt'] - now) > 30000:
                return self.s.json_response({'error': '观察窗口已过期，请重新观察。'}, 400)
            if observation['utterances'] is None:
                return self.record(device, observation['id'], {'action': 'observe', 'cooldownSeconds': 300,
                    'detail': '教室端缺少独立语句证据，请升级教室端后继续监测。'})
            event = self.db.one("SELECT * FROM self_study_events WHERE class_id=? AND session_key=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1", (cid, session['key']))
            if event and not event['reported_at'] and now >= (event['expires_at'] or
                    (event['warned_at'] or event['started_at']) + WARNING_TTL):
                self.db.run("UPDATE self_study_events SET status='resolved',resolution='evidence_expired',ended_at=? WHERE id=?", (now, event['id']))
                event = None
            if LEARNING_CUES.search(' '.join(u['text'] for u in observation['utterances'])):
                if event and not event['reported_at'] and event['device_id'] == device['id']:
                    self.db.run("UPDATE self_study_events SET status='resolved',resolution='not_chat',last_seen_at=?,ended_at=? WHERE id=?", (now, now, event['id']))
                return self.record(device, observation['id'], {'action': 'observe', 'classification': 'study',
                    'cooldownSeconds': 180, 'detail': '片段含学习线索，继续观察，不提醒。'})
            if event and (event['reported_at'] or event['device_id'] != device['id']):
                return self.record(device, observation['id'], {'action': 'observe', 'cooldownSeconds': 300})
            if event and not event['warned_at']:
                return self.record(device, observation['id'], {'action': 'remind', 'eventId': event['id']})
            if event and (observation['startAt'] < max(event['warned_at'], event['last_confirmation_at'] or 0)
                          or now - event['warned_at'] < cfg['reminderWaitSeconds'] * 1000):
                remaining = max(90, math.ceil((event['warned_at'] + cfg['reminderWaitSeconds'] * 1000 - now) / 1000))
                return self.record(device, observation['id'], {'action': 'observe', 'cooldownSeconds': remaining})
            if (observation['segments'] < 3 or observation['speechMs'] < 6000
                    or observation['endAt'] - observation['startAt'] < cfg['observationSeconds'] * 1000):
                return self.record(device, observation['id'], {'action': 'observe'})
            if now - self.usage(cid)['last_call_at'] < REVIEW_INTERVAL:
                return self.record(device, observation['id'], {'action': 'observe', 'cooldownSeconds': 90})
            connection = self.connection(cid)
            if not cfg['aiEnabled'] or not connection.get('enabled') or not connection.get('apiKey'):
                return self.record(device, observation['id'], {'action': 'unavailable', 'detail': '请启用短文本复核并配置班主任的 AI 连接。'})
            try:
                messages_for(observation)
            except ValueError:
                return self.s.json_response({'error': '本次复核内容过长。'}, 400)
            day = local_day(now)
            with self.db.transaction():
                usage = self.usage(cid)
                if usage['calls'] >= cfg['dailyCalls'] or usage['tokens'] + RESERVATION > cfg['dailyTokens']:
                    return self.record(device, observation['id'], {'action': 'budget', 'usage': usage})
                self.db.run('INSERT INTO self_study_usage VALUES(?,?,1,?,1,?) ON CONFLICT(class_id,day) DO UPDATE SET calls=calls+1,tokens=tokens+excluded.tokens,estimated=estimated+1,last_call_at=excluded.last_call_at',
                            (cid, day, RESERVATION, now))
                # Persist before the network request so a process crash cannot replay a paid call.
                self.db.run('INSERT INTO self_study_decisions VALUES(?,?,?,?,?)',
                            (cid, observation['id'], device['id'], now, json.dumps({'action': 'unavailable', 'detail': '本次复核未取得完整结果。'})))
            result = {'action': 'unavailable', 'detail': '本次 AI 复核不可用，未触发拍照或上报。'}
            try:
                decision, counts = await self.classify(connection, observation)
                if counts and all(type(counts.get(k)) is int and counts[k] >= 0 for k in ('inputTokens', 'outputTokens')):
                    actual = counts['inputTokens'] + counts['outputTokens']
                    self.db.run('UPDATE self_study_usage SET tokens=tokens-?+?,estimated=MAX(0,estimated-1) WHERE class_id=? AND day=?',
                                (RESERVATION, actual, cid, day))
                current = self.device(request)
                latest_cfg, latest_revision = self.settings(cid)
                latest_event = self.db.one('SELECT ended_at FROM self_study_events WHERE id=?', (event['id'],)) if event else None
                if (not current or current['class_id'] != cid or latest_revision != revision
                        or not self.active(cid, latest_cfg) or self.session(cid)['key'] != session['key']
                        or event and (not latest_event or latest_event['ended_at'] is not None)):
                    result = {'action': 'inactive'}
                elif event and self.s.now_ms() >= (event['expires_at'] or event['warned_at'] + WARNING_TTL):
                    self.db.run("UPDATE self_study_events SET status='resolved',resolution='evidence_expired',ended_at=? WHERE id=?", (self.s.now_ms(), event['id']))
                    result = {'action': 'observe', 'classification': 'unknown', 'detail': '原提醒已过期，重新观察。'}
                elif not has_chat_evidence(decision, observation):
                    result = {'action': 'observe', 'classification': decision.get('kind') if decision.get('kind') in {'teaching', 'study'} else 'unknown',
                              'cooldownSeconds': 180 if decision.get('kind') in {'teaching', 'study'} else 90}
                    if event:
                        self.db.run("UPDATE self_study_events SET status='resolved',resolution='not_chat',last_seen_at=?,ended_at=? WHERE id=? AND ended_at IS NULL", (now, now, event['id']))
                elif event:
                    confirmations = event['confirmations'] + 1
                    reported = confirmations >= cfg['confirmationsAfterReminder']
                    updated = self.db.run("""UPDATE self_study_events SET confirmations=?,last_confirmation_at=?,
                        last_seen_at=?,status=?,reported_at=?,photo_status=?
                        WHERE id=? AND ended_at IS NULL AND status='warning'""",
                        (confirmations, observation['endAt'], now, 'reported' if reported else 'warning',
                         now if reported else None, 'pending' if reported and cfg['photoEnabled'] else 'none', event['id']))
                    if updated.rowcount != 1:
                        result = {'action': 'inactive'}
                    elif reported:
                        result = {'action': 'report', 'eventId': event['id'], 'captureRequested': cfg['photoEnabled']}
                    else:
                        result = {'action': 'observe', 'classification': 'chat', 'eventId': event['id'],
                                  'confirmations': confirmations, 'cooldownSeconds': 90,
                                  'detail': f"提醒后已确认 {confirmations}/{cfg['confirmationsAfterReminder']} 次，继续观察。"}
                else:
                    eid = str(uuid.uuid4())
                    self.db.run("""INSERT INTO self_study_events
                        (id,class_id,device_id,started_at,last_seen_at,status,revision,session_key) VALUES(?,?,?,?,?,'warning',?,?)""",
                                (eid, cid, device['id'], now, now, revision, session['key']))
                    result = {'action': 'remind', 'eventId': eid, 'cooldownSeconds': cfg['reminderWaitSeconds']}
            except (ValueError, TypeError, KeyError, ClientError, TimeoutError):
                pass
            self.db.run('UPDATE self_study_decisions SET response=? WHERE class_id=? AND observation_id=?',
                        (json.dumps(result), cid, observation['id']))
            return self.s.json_response(result)

    @teacher_manual('设备确认浮岛提醒实际展示，失败回执不会允许升级事件。')
    async def receipt(self, request):
        device = self.device(request)
        if not device:
            return self.s.json_response({'error': '教室设备凭据已失效。'}, 401)
        try:
            body = await request.json()
            cfg, revision = self.settings(device['class_id'])
            if type(body['shown']) is not bool or type(body['revision']) is not int:
                raise ValueError()
            if body['revision'] != revision or not self.active(device['class_id'], cfg):
                return self.s.json_response({'error': '监测已停止或设置已变化。'}, 409)
        except (ValueError, KeyError, TypeError):
            return self.s.json_response({'error': '提醒回执格式不正确。'}, 400)
        if not self.still_bound(request, device):
            return self.s.json_response({'error': '教室绑定已变化。'}, 409)
        event = self.db.one("SELECT * FROM self_study_events WHERE id=? AND class_id=? AND device_id=? AND status='warning'",
                           (request.match_info['event_id'], device['class_id'], device['id']))
        if not event:
            return self.s.json_response({'error': '提醒事件已变化。'}, 404)
        if event['ended_at'] is not None or self.s.now_ms() >= (event['expires_at'] or
                (event['warned_at'] or event['started_at']) + WARNING_TTL):
            return self.s.json_response({'error': '提醒已过期，请重新观察。'}, 409)
        if body['shown']:
            now = self.s.now_ms()
            ttl = max(WARNING_TTL, cfg['reminderWaitSeconds'] * 1000 +
                      (cfg['confirmationsAfterReminder'] - 1) * REVIEW_INTERVAL + 60000)
            self.db.run('UPDATE self_study_events SET warned_at=COALESCE(warned_at,?),last_seen_at=?,expires_at=COALESCE(expires_at,?) WHERE id=?',
                        (now, now, now + ttl, event['id']))
        return self.s.json_response({'ok': True})

    def capture_event(self, request, device, *, claimed=False):
        cfg, revision = self.settings(device['class_id'])
        event = self.db.one("""SELECT id,revision,session_key FROM self_study_events WHERE id=? AND class_id=? AND device_id=?
            AND status='reported' AND ended_at IS NULL AND photo_status=? AND reported_at>?""",
            (request.match_info['event_id'], device['class_id'], device['id'],
             'capturing' if claimed else 'pending', self.s.now_ms() - 120000))
        if (not cfg['photoEnabled'] or not self.active(device['class_id'], cfg)
                or not event or event['revision'] != revision or event['session_key'] != self.session(device['class_id'])['key']):
            return None
        return event

    @teacher_manual('教室端拍照前重新核对授权、时段、配置版本和本次单次拍摄资格。')
    async def capture_check(self, request):
        device = self.device(request)
        if not device:
            return self.s.json_response({'error': '教室设备凭据已失效。'}, 401)
        event = self.capture_event(request, device)
        if event:
            self.db.run("UPDATE self_study_events SET photo_status='capturing' WHERE id=? AND photo_status='pending'", (event['id'],))
        return self.s.json_response({'allowed': bool(event)})

    @teacher_manual('设备为已升级且尚未附图的事件提交一次照片或相机失败回执，照片不发送给 AI。')
    async def photo(self, request):
        device = self.device(request)
        if not device:
            return self.s.json_response({'error': '教室设备凭据已失效。'}, 401)
        event = self.capture_event(request, device, claimed=True)
        if not event:
            return self.s.json_response({'error': '本次附图资格已结束。'}, 409)
        try:
            if request.content_length and request.content_length > 450000:
                raise ValueError()
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError()
            data = None
            if body.get('failed') is not True:
                encoded = body.get('image', '')
                if not isinstance(encoded, str) or len(encoded) > 430000:
                    raise ValueError()
                data = base64.b64decode(encoded, validate=True)
                if len(data) > MAX_PHOTO_BYTES or image_type(data) != ('jpeg', 'jpg'):
                    raise ValueError()
        except (ValueError, TypeError):
            return self.s.json_response({'error': '照片无效或超出大小限制。'}, 400)
        # Recheck after reading the body; settings may have changed meanwhile.
        if not self.still_bound(request, device) or not self.capture_event(request, device, claimed=True):
            return self.s.json_response({'error': '本次附图资格已结束。'}, 409)
        self.db.run("UPDATE self_study_events SET photo=?,photo_status=?,photo_at=? WHERE id=? AND photo_status='capturing'",
                    (data, 'ready' if data else 'failed', self.s.now_ms() if data else None, event['id']))
        return self.s.json_response({'ok': True})

    @teacher_read('self-study.events', '查看晚自习事件', fields='classId limit', head_only=True)
    async def events(self, request):
        cid = request.query.get('classId', '')
        user = self.teacher(request, cid or None)
        if isinstance(user, web.Response):
            return user
        self.prune()
        clause, args = scope_sql(user, include_teaching=False)
        try:
            limit = int(request.query.get('limit', '40'))
            if not 1 <= limit <= 100:
                raise ValueError()
        except ValueError:
            return self.s.json_response({'error': '事件数量范围为 1-100。'}, 400)
        where, bindings = (clause + ' AND c.id=?', (*args, cid)) if cid else (clause, args)
        rows = self.db.all(f"""SELECT e.id,e.class_id,c.name AS class_name,e.started_at,e.warned_at,e.reported_at,
            e.last_seen_at,e.status,e.photo_status,e.photo_at,e.handled_at,e.resolution
            FROM self_study_events e JOIN classes c ON c.id=e.class_id WHERE c.enabled=1 AND {where}
            ORDER BY e.started_at DESC LIMIT ?""", (*bindings, limit))
        return self.s.json_response({'events': rows, 'serverTime': self.s.now_ms(),
            'pending': self.db.one(f"""SELECT COUNT(*) n FROM self_study_events e JOIN classes c ON c.id=e.class_id
                WHERE c.enabled=1 AND {where} AND e.status='reported' AND e.handled_at IS NULL""", bindings)['n']})

    @teacher_manual('需班主任本人在受权限保护的图片查看器中查看，照片不提供给 AI。')
    async def event_photo(self, request):
        row = self.db.one('SELECT class_id,photo,photo_at FROM self_study_events WHERE id=?', (request.match_info['event_id'],))
        user = self.teacher(request, row['class_id'] if row else None)
        if isinstance(user, web.Response):
            return user
        if not row or not row['photo'] or row['photo_at'] <= self.s.now_ms() - PHOTO_TTL:
            return self.s.json_response({'error': '照片尚未拍摄、不可用或已过期。'}, 404)
        return web.Response(body=row['photo'], content_type='image/jpeg', headers={'Cache-Control': 'no-store'})

    @teacher_action('self-study.review', '处理晚自习事件', target='self-study-event', head_only=True,
                    fields='resolution', impact='将记录该事件的人工处理结果。')
    async def review(self, request):
        row = self.db.one('SELECT class_id,reported_at,handled_at FROM self_study_events WHERE id=?', (request.match_info['event_id'],))
        user = self.teacher(request, row['class_id'] if row else None)
        if isinstance(user, web.Response):
            return user
        if not row:
            return self.s.json_response({'error': '事件不存在或已过期。'}, 404)
        if row['reported_at'] is None or row['handled_at'] is not None:
            return self.s.json_response({'error': '这条记录已处理或尚未上报，请重新载入。'}, 409)
        try:
            resolution = (await request.json())['resolution']
            if resolution not in {'handled', 'false_alarm'}:
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            return self.s.json_response({'error': '请选择处理完成或误报。'}, 400)
        if not self.db.one('SELECT id FROM self_study_events WHERE id=? AND handled_at IS NULL',
                           (request.match_info['event_id'],)):
            return self.s.json_response({'error': '记录已由其他人处理，请重新载入。'}, 409)
        self.db.run("UPDATE self_study_events SET handled_at=?,handled_by=?,resolution=?,status='resolved' WHERE id=?",
                    (self.s.now_ms(), user['id'], resolution, request.match_info['event_id']))
        self.s.audit(self.db, user['id'], 'self-study.review', 'self-study-event', request.match_info['event_id'], resolution)
        return self.s.json_response({'ok': True})


def install_self_study(app, service, connections):
    feature = SelfStudyFeature(app, service, connections)
    app[FEATURE_KEY] = feature
    for method, path, handler in (
        ('GET', '/classes', feature.classes),
        ('GET', '/classes/{class_id}', feature.get_settings),
        ('PUT', '/classes/{class_id}', feature.save_settings),
        ('GET', '/events', feature.events),
        ('GET', '/events/{event_id}/photo', feature.event_photo),
        ('POST', '/events/{event_id}/review', feature.review),
        ('GET', '/device/config', feature.device_config),
        ('POST', '/device/status', feature.device_status),
        ('POST', '/device/quiet', feature.quiet),
        ('POST', '/device/observe', feature.observe),
        ('POST', '/device/events/{event_id}/receipt', feature.receipt),
        ('POST', '/device/events/{event_id}/capture', feature.capture_check),
        ('POST', '/device/events/{event_id}/photo', feature.photo),
    ):
        app.router.add_route(method, '/api/self-study' + path, handler)
    return feature

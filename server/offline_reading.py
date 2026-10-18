"""Device-authenticated, idempotent replay of locally recorded reading activity."""
from __future__ import annotations

import bisect
import json
import math
import uuid

from aiohttp import web

DAY = 86_400_000
SCHEMA = """
CREATE TABLE IF NOT EXISTS reading_rule_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT, effective_at INTEGER NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reading_offline_contexts(
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL, closed_at INTEGER);
CREATE INDEX IF NOT EXISTS reading_context_device ON reading_offline_contexts(device_id,created_at);
CREATE TABLE IF NOT EXISTS reading_sync_state(
 device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
 synced_at INTEGER NOT NULL, pending INTEGER NOT NULL, review INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reading_record_resets(
 class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
 first_day TEXT NOT NULL, last_day TEXT NOT NULL, cleared_at INTEGER NOT NULL);
"""


def identifier(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


class OfflineReading:
    def __init__(self, feature):
        self.f = feature
        self.db = feature.db
        self.db.db.executescript(SCHEMA)
        if not self.db.one('SELECT id FROM reading_rule_history LIMIT 1'):
            self.db.run('INSERT INTO reading_rule_history(effective_at,value) VALUES(0,?)',
                        (json.dumps(feature.config()),))

    def save_rule(self, config):
        self.db.run('INSERT INTO reading_rule_history(effective_at,value) VALUES(?,?)',
                    (self.f.clock(), json.dumps(config)))

    def context(self, device):
        row = self.db.one('''SELECT * FROM reading_offline_contexts WHERE device_id=?
            AND closed_at IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 1''', (device['id'],))
        if row and row['class_id'] == device['class_id']:
            return row
        now = self.f.clock()
        if row:
            self.db.run('UPDATE reading_offline_contexts SET closed_at=? WHERE id=?', (now, row['id']))
        # The first upgraded client can have records from before its first successful sync.
        cid = str(uuid.uuid4())
        self.db.run('INSERT INTO reading_offline_contexts VALUES(?,?,?,?,NULL)',
                    (cid, device['id'], device['class_id'], now))
        return self.db.one('SELECT * FROM reading_offline_contexts WHERE id=?', (cid,))

    def remember_sync(self, device, pending, review=0):
        pending = min(10_000_000, max(0, pending)) if type(pending) is int else 0
        review = min(10_000_000, max(0, review)) if type(review) is int else 0
        self.db.run('''INSERT INTO reading_sync_state VALUES(?,?,?,?) ON CONFLICT(device_id)
            DO UPDATE SET synced_at=excluded.synced_at,pending=excluded.pending,review=excluded.review''',
                    (device['id'], self.f.clock(), pending, review))

    async def bootstrap(self, request):
        device = self.f.authenticate(request)
        if not device:
            return self.f.reply({'error': '教室设备未绑定或已停用。'}, 401)
        with self.db.transaction():
            context = self.context(device)
        name = self.db.one('SELECT name FROM classes WHERE id=?', (device['class_id'],))['name']
        return self.f.reply({'contextId': context['id'], 'classId': device['class_id'],
                             'className': name, **self.f.payload()})

    def validate_batch(self, batch, device, now):
        from reading import MODES, EVENTS
        if not isinstance(batch, dict) or not all(identifier(batch.get(k)) for k in ('id', 'sessionId', 'contextId')):
            return '记录标识无效'
        context = self.db.one('SELECT * FROM reading_offline_contexts WHERE id=? AND device_id=?',
                              (batch['contextId'], device['id']))
        if not context or context['class_id'] != batch.get('classId'):
            return '班级绑定不匹配，记录已保留待核实'
        if not isinstance(batch.get('mode'), str) or batch['mode'] not in MODES or type(batch.get('startedAt')) is not int:
            return '活动会话无效'
        samples, events = batch.get('samples'), batch.get('events')
        if not isinstance(samples, list) or not isinstance(events, list) or len(samples) > 90 or len(events) > 100 or not samples and not events:
            return '记录数量无效'
        # Old records are retained by the client for review; never silently truncate an offline queue.
        first = now - 366 * DAY
        last = min(now + 5000, context['closed_at'] or now + 5000)
        if not first <= batch['startedAt'] <= last:
            return '电脑时间或记录日期异常，请管理员核实'
        allowed = {'classic': {'carrots'}, 'carving': {'poems'}, 'particle': {'badges'}, 'rocket': {'energy', 'launches'}}[batch['mode']]
        for item in samples + events:
            if not isinstance(item, dict) or type(item.get('at')) is not int or not max(first, batch['startedAt'] - 1000) <= item['at'] <= last:
                return '电脑时间或记录日期异常，请管理员核实'
        for sample in samples:
            level = sample.get('volume')
            if isinstance(level, bool) or not isinstance(level, (int, float)) or not math.isfinite(level) or not 0 <= level <= 100 or sample.get('active') is not True:
                return '声量记录无效'
        for event in events:
            if not identifier(event.get('id')) or not isinstance(event.get('kind'), str) or event['kind'] not in EVENTS or event['kind'] not in allowed or not isinstance(event.get('title', ''), str):
                return '活动完成记录无效'
        session = self.db.one('SELECT * FROM reading_sessions WHERE id=?', (batch['sessionId'],))
        if session and (session['device_id'] != device['id'] or session['class_id'] != context['class_id'] or session['mode'] != batch['mode'] or session['started_at'] != batch['startedAt']):
            return '活动会话冲突，记录已保留待核实'
        return None

    async def sync(self, request):
        from reading import inside_period, local_day
        device = self.f.authenticate(request)
        if not device:
            return self.f.reply({'error': '教室设备未绑定或已停用。'}, 401)
        try:
            body = await request.json()
        except ValueError:
            body = None
        batches = body.get('batches') if isinstance(body, dict) else None
        if not isinstance(batches, list) or len(batches) > 60:
            return self.f.reply({'error': '每次最多补传 60 组记录。'}, 400)
        now, acknowledged, rejected = self.f.clock(), [], []
        history = self.db.all('SELECT effective_at,value FROM reading_rule_history ORDER BY effective_at,id')
        times = [r['effective_at'] for r in history]
        configs = [json.loads(r['value']) for r in history]
        def config_at(at):
            return configs[max(0, bisect.bisect_right(times, at) - 1)]
        with self.db.transaction():
            for batch in batches:
                error = self.validate_batch(batch, device, now)
                bid = batch.get('id', '') if isinstance(batch, dict) else ''
                if error:
                    rejected.append({'id': bid, 'reason': error})
                    continue
                cid, sid = batch['classId'], batch['sessionId']
                self.db.run('INSERT OR IGNORE INTO reading_sessions VALUES(?,?,?,?,?,?)',
                            (sid, device['id'], cid, batch['mode'], batch['startedAt'], batch['startedAt']))
                resets = self.db.all('SELECT first_day,last_day,cleared_at FROM reading_record_resets WHERE class_id=?', (cid,))
                def cleared(at):
                    day = local_day(at)
                    return any(r['first_day'] <= day <= r['last_day'] and at <= r['cleared_at'] for r in resets)
                for sample in batch['samples']:
                    at = sample['at']; config = config_at(at)
                    if cleared(at) or not inside_period(at, config):
                        continue
                    second, day = at // 1000, local_day(at)
                    bit = 1 << (second % 10)
                    self.db.run('''INSERT INTO reading_buckets VALUES(?,?,?,?,?) ON CONFLICT(class_id,bucket)
                        DO UPDATE SET active_mask=active_mask | excluded.active_mask,effective_mask=effective_mask | excluded.effective_mask''',
                                (cid, day, second // 10, bit, bit if sample['volume'] >= config['threshold'] else 0))
                    self.db.run('INSERT OR IGNORE INTO reading_session_days VALUES(?,?)', (sid, day))
                for event in batch['events']:
                    at = event['at']
                    if cleared(at):
                        continue
                    self.db.run('INSERT OR IGNORE INTO reading_events VALUES(?,?,?,?,?,?,?,?)',
                                (event['id'], sid, cid, local_day(at), at, event['kind'], event.get('title', '')[:100], int(inside_period(at, config_at(at)))))
                    if inside_period(at, config_at(at)):
                        self.db.run('INSERT OR IGNORE INTO reading_session_days VALUES(?,?)', (sid, local_day(at)))
                last = max([batch['startedAt']] + [s['at'] for s in batch['samples'] + batch['events']])
                self.db.run('UPDATE reading_sessions SET last_seen_at=MAX(last_seen_at,?) WHERE id=?', (last, sid))
                acknowledged.append(bid)
            pending = body.get('pendingCount', 0)
            pending = max(0, pending - len(acknowledged) - len(rejected)) if type(pending) is int else 0
            review = body.get('reviewCount', 0)
            self.remember_sync(device, pending, (review if type(review) is int else 0) + len(rejected))
        return self.f.reply({'acknowledged': acknowledged, 'rejected': rejected, 'serverTime': now})

    def report_status(self, cid):
        devices = self.db.all('''SELECT d.id,s.synced_at,s.pending,s.review FROM devices d
            LEFT JOIN reading_sync_state s ON s.device_id=d.id
            WHERE d.class_id=? AND d.enabled=1''', (cid,))
        last = max((d['synced_at'] or 0 for d in devices), default=0) or None
        state = 'unconfirmed'
        if devices and all(d['synced_at'] and self.f.clock() - d['synced_at'] < 120_000 and not d['pending'] and not d['review'] for d in devices):
            state = 'current'
        elif any(d['review'] for d in devices):
            state = 'review'
        elif any(d['pending'] for d in devices):
            state = 'pending'
        return {'state': state, 'lastSyncedAt': last,
                'pendingBatches': sum(d['pending'] or 0 for d in devices),
                'reviewBatches': sum(d['review'] or 0 for d in devices)}

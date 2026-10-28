"""Class-scoped classroom island configuration and delivery (Tencent service)."""
from __future__ import annotations

import json
import re
from datetime import date
from urllib.parse import quote, urlsplit

from aiohttp import web

from reading import class_grade

DUTY_KINDS = {'midday': '午间静校', 'evening': '晚自习'}


def duty_defaults(slots=()):
    ids = {s['id'] for s in slots}
    return {kind: {'enabled': False, 'cycleWeeks': 2, 'weekAnchor': '2026-09-07',
                   'slotIds': [sid for sid in ('evening-study-1', 'evening-study-2') if sid in ids]
                              if kind == 'evening' else [], 'lessons': []}
            for kind in DUTY_KINDS}

SCHEMA = """
CREATE TABLE IF NOT EXISTS island_profiles(
 class_id TEXT PRIMARY KEY REFERENCES classes(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
 updated_by TEXT REFERENCES users(id));
CREATE TABLE IF NOT EXISTS island_delivery(
 device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
 class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, synced_at INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '');
"""


def defaults(grade=None):
    slots = []
    if grade in ('高一', '高二', '高三'):
        # School timetable effective 2026-09-10; saved class profiles take precedence.
        periods = [
            ('morning-reading', '晨读', 450, 473),
            ('period-1', '第一节', 475, 520),
            ('period-2', '第二节', 530, 575),
            ('period-3', '第三节', 605, 650),
            ('period-4', '第四节', 660, 705 if grade == '高一' else 700),
            ('period-5', '第五节', 840, 885),
            ('period-6', '第六节', 895, 940),
            ('period-7', '第七节（眼保健操）', 950, 995),
            ('period-8', '第八节（活动课）', 1005, 1045 if grade == '高三' else 1050),
            ('evening-study-1', '晚自习第一节', 1100, 1190),
            ('evening-study-2', '晚自习第二节', 1200, 1290),
        ]
        slots = [{'id': sid, 'label': label, 'start': start, 'end': end}
                 for sid, label, start, end in periods]
    return {'schemaVersion': 1, 'enabled': True, 'weekAnchor': '2026-09-07',
            'slots': slots, 'lessons': [], 'overrides': [], 'dutyRotations': duty_defaults(slots),
            'reminders': {'enabled': True, 'prepare': True, 'start': True, 'end': True,
                          'prepareMinutes': 2, 'sound': False, 'speech': False, 'volume': 65, 'displaySeconds': 8},
            'appearance': {'position': 'top-center', 'width': 560, 'opacity': 100, 'theme': 'light',
                           'clickThrough': False, 'hideFullscreen': True, 'hideDuringLessons': False,
                           'offsetX': 0, 'offsetY': 0},
            'components': [{'id': 'date', 'type': 'date', 'enabled': True, 'title': '日期', 'text': '', 'date': ''}],
            'rotationSeconds': 8, 'automation': []}


def text(value, label, limit=80, empty=False):
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 for c in value):
        raise ValueError(f'{label}格式不正确（最多 {limit} 字）。')
    value = value.strip()
    if not empty and not value:
        raise ValueError(f'请填写{label}。')
    return value


def integer(value, label, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f'{label}应为 {low}—{high} 的整数。')
    return value


def boolean(value, label):
    if type(value) is not bool:
        raise ValueError(f'{label}应为开关值。')
    return value


def choice(value, label, choices):
    if not isinstance(value, str) or value not in choices:
        raise ValueError(f'{label}无效。')
    return value


def day(value, label):
    try:
        if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
            raise ValueError()
        return value
    except (ValueError, TypeError):
        raise ValueError(f'{label}应为 YYYY-MM-DD 日期。') from None


def items(value, label, maximum):
    if not isinstance(value, list) or len(value) > maximum or any(not isinstance(x, dict) for x in value):
        raise ValueError(f'{label}最多 {maximum} 项。')
    return value


def normalize(value):
    if not isinstance(value, dict) or value.get('schemaVersion', 1) != 1:
        raise ValueError('不支持的教室浮岛配置。')
    result = defaults()
    result['enabled'] = boolean(value.get('enabled', True), '启用教室浮岛')
    result['weekAnchor'] = day(value.get('weekAnchor', result['weekAnchor']), '第一周周一')
    if date.fromisoformat(result['weekAnchor']).weekday() != 0:
        raise ValueError('第一周起始日期必须是周一。')
    ids = set()
    for s in items(value.get('slots', []), '作息', 32):
        sid = text(s.get('id'), '时段标识', 60)
        start, end = integer(s.get('start'), '开始分钟', 0, 1439), integer(s.get('end'), '结束分钟', 1, 1440)
        if sid in ids or start >= end:
            raise ValueError('作息标识重复或结束时间早于开始。')
        ids.add(sid)
        result['slots'].append({'id': sid, 'label': text(s.get('label'), '时段名称', 30), 'start': start, 'end': end})
    result['slots'].sort(key=lambda s: s['start'])
    if any(a['end'] > b['start'] for a, b in zip(result['slots'], result['slots'][1:])):
        raise ValueError('作息时段不能重叠。')
    seen = set()
    for l in items(value.get('lessons', []), '课程', 448):
        sid = text(l.get('slotId'), '课程时段', 60)
        weekday = integer(l.get('weekday'), '星期', 1, 7)
        week = choice(l.get('week', 'all'), '周次', ('all', 'odd', 'even'))
        if sid not in ids:
            raise ValueError('课程引用了不存在的作息时段。')
        for parity in (('odd', 'even') if week == 'all' else (week,)):
            key = (sid, weekday, parity)
            if key in seen:
                raise ValueError('同一星期、时段和周次只能设置一门课程。')
            seen.add(key)
        result['lessons'].append({'slotId': sid, 'weekday': weekday, 'week': week,
            'subject': text(l.get('subject'), '科目', 40), 'teacher': text(l.get('teacher', ''), '教师', 40, True),
            'location': text(l.get('location', ''), '地点', 60, True)})
    seen.clear()
    for o in items(value.get('overrides', []), '临时调课', 500):
        sid, on = text(o.get('slotId'), '调课时段', 60), day(o.get('date'), '调课日期')
        if sid not in ids or (on, sid) in seen:
            raise ValueError('临时调课时段不存在或同日同一时段重复。')
        seen.add((on, sid))
        cancelled = boolean(o.get('cancelled', False), '停课')
        result['overrides'].append({'date': on, 'slotId': sid, 'cancelled': cancelled,
            'subject': text(o.get('subject', ''), '调课科目', 40, cancelled),
            'teacher': text(o.get('teacher', ''), '教师', 40, True), 'location': text(o.get('location', ''), '地点', 60, True)})
    raw_duties = value.get('dutyRotations', {})
    if not isinstance(raw_duties, dict) or any(kind not in DUTY_KINDS for kind in raw_duties):
        raise ValueError('值班安排只支持午间静校和晚自习。')
    result['dutyRotations'] = duty_defaults(result['slots'])
    owned = set()
    for kind, name in DUTY_KINDS.items():
        raw = raw_duties.get(kind, result['dutyRotations'][kind])
        if not isinstance(raw, dict):
            raise ValueError(f'{name}循环设置格式不正确。')
        enabled = boolean(raw.get('enabled', False), name + '循环开关')
        weeks = integer(raw.get('cycleWeeks', 2), name + '循环周数', 1, 20)
        anchor = day(raw.get('weekAnchor', result['weekAnchor']), name + '第一周周一')
        if date.fromisoformat(anchor).weekday() != 0:
            raise ValueError(f'{name}第一周起始日期必须是周一。')
        slot_ids = raw.get('slotIds', [])
        if (not isinstance(slot_ids, list) or len(slot_ids) > (1 if kind == 'midday' else 2)
                or any(not isinstance(sid, str) or sid not in ids for sid in slot_ids)
                or len(set(slot_ids)) != len(slot_ids) or owned.intersection(slot_ids)):
            raise ValueError(f'{name}时段不存在、重复或已被其他值班使用。')
        owned.update(slot_ids)
        if enabled and not slot_ids:
            raise ValueError(f'请先为{name}设置作息时段。')
        if enabled and any(l['slotId'] in slot_ids for l in result['lessons']):
            raise ValueError(f'{name}时段已有固定课程，请先清空该时段的周课表，再启用循环值班。')
        rows, seen = [], set()
        for l in items(raw.get('lessons', []), name + '循环课程', 280):
            sid = text(l.get('slotId'), '值班时段', 60)
            weekday = integer(l.get('weekday'), '值班星期', 1, 7)
            cycle_week = integer(l.get('cycleWeek'), '循环内周次', 1, weeks)
            key = (sid, weekday, cycle_week)
            if sid not in slot_ids or key in seen:
                raise ValueError(f'{name}课程引用了其他时段，或同一周、星期、时段重复。')
            seen.add(key)
            rows.append({'slotId': sid, 'weekday': weekday, 'cycleWeek': cycle_week,
                         'subject': text(l.get('subject'), '值班学科', 40),
                         'teacher': text(l.get('teacher', ''), '值班教师', 40, True),
                         'location': text(l.get('location', ''), '值班地点', 60, True)})
        result['dutyRotations'][kind] = {'enabled': enabled, 'cycleWeeks': weeks,
                                       'weekAnchor': anchor, 'slotIds': slot_ids, 'lessons': rows}
    for group in ('reminders', 'appearance'):
        raw = value.get(group, {})
        if not isinstance(raw, dict):
            raise ValueError('提醒或外观设置格式不正确。')
        for key, default in result[group].items():
            v = raw.get(key, default)
            if type(default) is bool:
                result[group][key] = boolean(v, key)
            elif key in ('position', 'theme'):
                result[group][key] = choice(v, key, ('top-center', 'top-left', 'top-right', 'bottom-center') if key == 'position' else ('dark', 'light', 'system'))
            else:
                lo, hi = {'prepareMinutes': (1, 30), 'volume': (0, 100), 'displaySeconds': (3, 60),
                          'width': (380, 1000), 'opacity': (30, 100), 'offsetX': (-2000, 2000), 'offsetY': (-2000, 2000)}[key]
                result[group][key] = integer(v, key, lo, hi)
    result['rotationSeconds'] = integer(value.get('rotationSeconds', 8), '组件轮播秒数', 3, 120)
    result['components'] = []
    seen.clear()
    for c in items(value.get('components', []), '信息组件', 16):
        cid = text(c.get('id'), '组件标识', 60)
        if cid in seen:
            raise ValueError('组件标识重复。')
        seen.add(cid)
        kind = choice(c.get('type'), '组件类型', ('date', 'countdown', 'text'))
        result['components'].append({'id': cid, 'type': kind, 'enabled': boolean(c.get('enabled', True), '组件开关'),
            'title': text(c.get('title', ''), '组件标题', 40, True), 'text': text(c.get('text', ''), '自定义文字', 240, True),
            'date': day(c.get('date'), '倒数日日期') if kind == 'countdown' else ''})
    seen.clear()
    for rule in items(value.get('automation', []), '自动化规则', 40):
        rid = text(rule.get('id'), '规则标识', 60)
        if rid in seen:
            raise ValueError('自动化规则标识重复。')
        seen.add(rid)
        trigger = choice(rule.get('trigger'), '触发条件', ('time', 'prepare', 'start', 'end'))
        action = choice(rule.get('action'), '执行动作', ('reminder', 'website', 'app', 'reading'))
        weekdays = rule.get('weekdays', [1, 2, 3, 4, 5])
        if not isinstance(weekdays, list) or not weekdays or len(weekdays) > 7 or any(type(x) is not int or not 1 <= x <= 7 for x in weekdays):
            raise ValueError('请选择规则生效的星期。')
        target = text(rule.get('value', ''), '动作内容', 500, action == 'reading')
        if action == 'website':
            url = urlsplit(target)
            if url.scheme != 'https' or not url.hostname or url.username or url.password or any(c.isspace() for c in target):
                raise ValueError('自动打开网页必须使用完整的 HTTPS 地址。')
        if action == 'app' and not re.fullmatch(r'[A-Za-z]:\\[^\x00-\x1f"<>|*?]+\.exe', target, re.I):
            raise ValueError('应用应填写本机 exe 的完整路径，不支持命令或参数。')
        result['automation'].append({'id': rid, 'name': text(rule.get('name'), '规则名称', 60),
            'enabled': boolean(rule.get('enabled', True), '规则开关'), 'trigger': trigger,
            'minute': integer(rule.get('minute', 480), '触发时间', 0, 1439), 'weekdays': sorted(set(weekdays)),
            'action': action, 'value': target})
    return result


def lessons_on(config, on):
    anchor = date.fromisoformat(config['weekAnchor'])
    parity = 'odd' if ((on - anchor).days // 7) % 2 == 0 else 'even'
    overrides = {x['slotId']: x for x in config['overrides'] if x['date'] == on.isoformat()}
    regular = {x['slotId']: x for x in config['lessons'] if x['weekday'] == on.isoweekday() and x['week'] in ('all', parity)}
    for kind, duty in config.get('dutyRotations', {}).items():
        anchor = date.fromisoformat(duty['weekAnchor'])
        if not duty['enabled'] or on < anchor:
            continue
        cycle_week = ((on - anchor).days // 7) % duty['cycleWeeks'] + 1
        for sid in duty['slotIds']:
            regular.pop(sid, None)
        regular.update({l['slotId']: {**l, 'dutyKind': kind} for l in duty['lessons']
                        if l['weekday'] == on.isoweekday() and l['cycleWeek'] == cycle_week})
    result = []
    for slot in config['slots']:
        lesson = overrides.get(slot['id'], regular.get(slot['id']))
        if lesson and not lesson.get('cancelled'):
            result.append({**slot, **lesson, 'temporary': slot['id'] in overrides})
    return result


class IslandFeature:
    def __init__(self, service, app):
        self.s = service
        self.db = app[service.STORE_KEY]
        self.db.db.executescript(SCHEMA)

    def profile(self, cid):
        row = self.db.one('SELECT * FROM island_profiles WHERE class_id=?', (cid,))
        if row:
            config = json.loads(row['value'])
        else:
            classroom = self.db.one('SELECT name FROM classes WHERE id=?', (cid,))
            config = defaults(class_grade(classroom['name']) if classroom else None)
        return {'classId': cid, 'revision': row['revision'] if row else 0,
                'updatedAt': row['updated_at'] if row else None,
                'config': config}

    def authorize(self, request):
        user = self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        cid = request.match_info['class_id']
        if not self.s.can_access_class(self.db, user, cid):
            return self.s.json_response({'error': '没有配置该班教室浮岛的权限。'}, 403)
        return user

    def delivery(self, cid, revision):
        rows = self.db.all('''SELECT d.id,d.name,i.revision,i.synced_at,i.detail FROM devices d
            LEFT JOIN island_delivery i ON i.device_id=d.id AND i.class_id=d.class_id
            WHERE d.class_id=? AND d.enabled=1 ORDER BY d.name''', (cid,))
        return [{**r, 'current': r['revision'] == revision} for r in rows]

    async def get(self, request):
        user = self.authorize(request)
        if isinstance(user, web.Response):
            return user
        p = self.profile(request.match_info['class_id'])
        return self.s.json_response({**p, 'devices': self.delivery(p['classId'], p['revision']), 'serverTime': self.s.now_ms()})

    async def save(self, request):
        user = self.authorize(request)
        if isinstance(user, web.Response):
            return user
        body = await self.s.read_json(request)
        try:
            if not body:
                raise ValueError('配置格式不正确。')
            incoming = body.get('config')
            # An older open editor must not silently erase the newly added rotations.
            if isinstance(incoming, dict) and 'dutyRotations' not in incoming:
                incoming = {**incoming, 'dutyRotations': self.profile(request.match_info['class_id'])['config'].get('dutyRotations', {})}
            config = normalize(incoming)
            expected = integer(body.get('revision'), '配置版本', 0, 2**31-1)
        except ValueError as error:
            return self.s.json_response({'error': str(error)}, 400)
        cid, now = request.match_info['class_id'], self.s.now_ms()
        with self.db.transaction():
            current = self.profile(cid)
            if current['revision'] != expected:
                return self.s.json_response({'error': '其他老师已更新配置，请重新载入后再保存。', 'revision': current['revision']}, 409)
            self.db.run('''INSERT INTO island_profiles VALUES(?,?,?,?,?) ON CONFLICT(class_id) DO UPDATE SET
                revision=excluded.revision,value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by''',
                (cid, expected+1, json.dumps(config, ensure_ascii=False), now, user['id']))
            self.s.audit(self.db, user['id'], 'island.save', 'class', cid, json.dumps({'revision': expected+1}))
        return self.s.json_response({**self.profile(cid), 'devices': self.delivery(cid, expected+1)})

    async def device(self, request):
        device = self.s.authenticate_device(request)
        if not device:
            return self.s.json_response({'error': '教室设备未绑定或已停用。'}, 401)
        p = self.profile(device['class_id'])
        return self.s.json_response({**p, 'serverTime': self.s.now_ms()})

    async def ack(self, request):
        device = self.s.authenticate_device(request)
        if not device:
            return self.s.json_response({'error': '教室设备未绑定或已停用。'}, 401)
        body = await self.s.read_json(request)
        current = self.profile(device['class_id'])
        if not body or type(body.get('revision')) is not int or body['revision'] != current['revision']:
            return self.s.json_response({'error': '配置版本已变化，请重新同步。'}, 409)
        detail = str(body.get('detail', ''))[:500]
        self.db.run('''INSERT INTO island_delivery VALUES(?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET
            class_id=excluded.class_id,revision=excluded.revision,synced_at=excluded.synced_at,detail=excluded.detail''',
            (device['id'], device['class_id'], body['revision'], self.s.now_ms(), detail))
        return self.s.json_response({'ok': True})

    async def export(self, request):
        user = self.authorize(request)
        if isinstance(user, web.Response):
            return user
        from island_xlsx import export_schedule
        cid = request.match_info['class_id']
        classroom = self.db.one('SELECT name FROM classes WHERE id=?', (cid,))
        class_name = classroom['name'] if classroom else ''
        data = export_schedule(self.profile(cid)['config'], class_name=class_name)
        filename = quote('ICeClass-' + (class_name or '班级') + '-课表.xlsx', safe='')
        return web.Response(body=data, content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                            headers={'Content-Disposition': 'attachment; filename="ICeClass-timetable.xlsx"; filename*=UTF-8\'\'' + filename})

    async def import_preview(self, request):
        user = self.authorize(request)
        if isinstance(user, web.Response):
            return user
        from island_xlsx import import_schedule
        try:
            content = await request.read()
            metadata = {}
            config = import_schedule(content, self.profile(request.match_info['class_id'])['config'], metadata=metadata)
            return self.s.json_response({'config': normalize(config), **metadata})
        except (ValueError, KeyError) as error:
            return self.s.json_response({'error': str(error)}, 400)

def install_island(app, service):
    feature = IslandFeature(service, app)
    app.router.add_get('/api/island/classes/{class_id}', feature.get)
    app.router.add_put('/api/island/classes/{class_id}', feature.save)
    app.router.add_get('/api/island/classes/{class_id}/export', feature.export)
    app.router.add_post('/api/island/classes/{class_id}/import', feature.import_preview)
    app.router.add_get('/api/island/device', feature.device)
    app.router.add_post('/api/island/device/ack', feature.ack)

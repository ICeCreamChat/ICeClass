"""Class-scoped classroom island configuration and delivery (Tencent service)."""
from __future__ import annotations

import json
import re
from copy import deepcopy
from datetime import date
from urllib.parse import quote, urlsplit

from aiohttp import web

from reading import class_grade
from permissions import SCHOOL_ROLES
from teacher_capabilities import teacher_action, teacher_read

DUTY_KINDS = {'midday': '午间静校', 'evening': '晚自习'}
SCHOOL_VISIBILITY = {'hideDaytimeLessons': True, 'hideFirstEvening': True}


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
CREATE TABLE IF NOT EXISTS island_visibility(
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
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
            'visibility': {'followSchool': True, 'hiddenSlotIds': []},
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


def normalize_visibility(raw, slots):
    if not isinstance(raw, dict):
        raise ValueError('课堂隐藏规则格式不正确。')
    follow = boolean(raw.get('followSchool', True), '跟随全校隐藏规则')
    selected = raw.get('hiddenSlotIds', [])
    ids = {s['id'] for s in slots}
    if (not isinstance(selected, list) or len(selected) > 32
            or any(not isinstance(sid, str) or (not follow and sid not in ids) for sid in selected)
            or len(set(selected)) != len(selected)):
        raise ValueError('隐藏时段不存在或重复，请从本班作息中选择。')
    # Inherited IDs are resolved for delivery, never persisted as class overrides.
    result = {'followSchool': follow, 'hiddenSlotIds': [] if follow else [s['id'] for s in slots if s['id'] in selected]}
    if boolean(raw.get('lessonsOnly', False), '按课程隐藏') and not follow:
        result['lessonsOnly'] = True
    return result


def class_visibility(config):
    # Preserve the old course-based rule when materializing its slot selection.
    legacy = config.get('appearance', {}).get('hideDuringLessons', False)
    return normalize_visibility(config.get('visibility', {
        'followSchool': not legacy,
        'hiddenSlotIds': [s['id'] for s in config['slots']] if legacy else [],
        'lessonsOnly': legacy}), config['slots'])


def school_hidden_slots(config, policy):
    slots = sorted(config['slots'], key=lambda s: s['start'])
    duties = config.get('dutyRotations', {})
    evening_ids = set(duties.get('evening', {}).get('slotIds', []))
    midday_ids = set(duties.get('midday', {}).get('slotIds', []))
    evening = [s for s in slots if s['id'] in evening_ids or s['id'].startswith('evening-study-')
               or re.search(r'晚自[习修]', s['label'])]
    evening_ids.update(s['id'] for s in evening)
    first_evening = evening[0]['id'] if evening else None
    return [s['id'] for s in slots if
            (policy['hideFirstEvening'] and s['id'] == first_evening) or
            (policy['hideDaytimeLessons'] and s['start'] < 1080 and s['id'] not in evening_ids | midday_ids
             and (re.fullmatch(r'period-\d+', s['id']) or re.match(r'^第\s*[一二三四五六七八九十百0-9]+\s*节', s['label'])))]


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
    result['visibility'] = class_visibility({**value, 'slots': result['slots'], 'appearance': result['appearance']})
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


def bulk_changes(value):
    """Validate only the categories that can be shared without copying class work."""
    if not isinstance(value, dict) or not value or value.keys() - {'enabled', 'slots', 'reminders', 'appearance'}:
        raise ValueError('请选择浮岛开关、作息、提醒或外观。')
    sample = defaults()
    for key, raw in value.items():
        if key in ('reminders', 'appearance') and (
                not isinstance(raw, dict) or not raw or raw.keys() - sample[key].keys()):
            raise ValueError('提醒或外观设置格式不正确。')
        sample[key] = raw
    normalized = normalize(sample)
    if 'slots' in value and not normalized['slots']:
        raise ValueError('批量作息至少需要一个时段。')
    changes = {}
    for key, raw in value.items():
        if key in ('reminders', 'appearance'):
            # The legacy appearance flag is not a replacement for class quiet rules.
            changes[key] = {k: normalized[key][k] for k in raw if k != 'hideDuringLessons'}
        else:
            changes[key] = normalized[key]
    if not any(v != {} for v in changes.values()):
        raise ValueError('请选择需要下发的设置。')
    return changes


def merge_bulk_settings(current, changes):
    """Keep local slot identities and every course/duty reference intact."""
    merged = deepcopy(current)
    for key in ('enabled', 'reminders', 'appearance'):
        if key not in changes:
            continue
        if key == 'enabled':
            merged[key] = changes[key]
        else:
            merged[key].update(changes[key])
    if 'slots' in changes:
        by_id = {s['id']: s for s in merged['slots']}
        label = lambda s: re.sub(r'\s+', '', s['label']).replace('（', '(').replace('）', ')')
        used = set()
        for source in changes['slots']:
            target = by_id.get(source['id'])
            if target is None:
                matches = [s for s in current['slots'] if label(s) == label(source)]
                if len(matches) > 1:
                    raise ValueError(f'“{source["label"]}”有多个同名时段，请先核对本班作息。')
                target = by_id[matches[0]['id']] if matches else None
            if target is not None:
                if target['id'] in used:
                    raise ValueError(f'多个作息对应了“{target["label"]}”，请先核对时段名称。')
                used.add(target['id'])
                target.update(start=source['start'], end=source['end'])
            else:
                merged['slots'].append(deepcopy(source))
                used.add(source['id'])
    return normalize(merged)


class IslandFeature:
    def __init__(self, service, app):
        self.s = service
        self.db = app[service.STORE_KEY]
        self.db.db.executescript(SCHEMA)
        self.db.run('INSERT OR IGNORE INTO island_visibility VALUES(1,0,?)', (json.dumps(SCHOOL_VISIBILITY),))

    def school_visibility(self):
        row = self.db.one('SELECT revision,value FROM island_visibility WHERE id=1')
        return {'revision': row['revision'], 'config': json.loads(row['value'])}

    def profile(self, cid):
        row = self.db.one('SELECT * FROM island_profiles WHERE class_id=?', (cid,))
        if row:
            config = json.loads(row['value'])
        else:
            classroom = self.db.one('SELECT name FROM classes WHERE id=?', (cid,))
            config = defaults(class_grade(classroom['name']) if classroom else None)
        policy = self.school_visibility()
        config['visibility'] = class_visibility(config)
        if config['visibility']['followSchool']:
            config['visibility']['hiddenSlotIds'] = school_hidden_slots(config, policy['config'])
        return {'classId': cid, 'revision': row['revision'] if row else 0,
                'updatedAt': row['updated_at'] if row else None,
                'config': config, 'schoolVisibility': policy}

    @teacher_read('island.visibility', '查看全校浮岛隐藏规则')
    async def get_visibility(self, request):
        user = self.s.require_user(request)
        return user if isinstance(user, web.Response) else self.s.json_response(self.school_visibility())

    @teacher_action('island.visibility.update', '修改全校浮岛隐藏规则', fields='config revision',
                    roles=tuple(sorted(SCHOOL_ROLES)), impact='将更新全校规则，并同步到跟随全校规则的班级浮岛。')
    async def save_visibility(self, request):
        user = self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        if user['role'] not in SCHOOL_ROLES or user.get('classroom'):
            return self.s.json_response({'error': '只有全校管理员可以修改全校隐藏规则。'}, 403)
        body = await self.s.read_json(request)
        try:
            if not body or not isinstance(body.get('config'), dict):
                raise ValueError('全校隐藏规则格式不正确。')
            expected = integer(body.get('revision'), '全校规则版本', 0, 2**31-1)
            policy = {key: boolean(body['config'].get(key, default), key) for key, default in SCHOOL_VISIBILITY.items()}
        except ValueError as error:
            return self.s.json_response({'error': str(error)}, 400)
        with self.db.transaction():
            previous = self.school_visibility()
            if previous['revision'] != expected:
                return self.s.json_response({'error': '全校规则已更新，请重新打开后再保存。'}, 409)
            if policy == previous['config']:
                return self.s.json_response(previous)
            self.db.run('UPDATE island_visibility SET revision=?,value=? WHERE id=1',
                        (expected + 1, json.dumps(policy)))
            now = self.s.now_ms()
            rows = self.db.all('''SELECT c.id,c.name,p.value,p.revision FROM classes c
                LEFT JOIN island_profiles p ON p.class_id=c.id''')
            for row in rows:
                config = json.loads(row['value']) if row['value'] else defaults(class_grade(row['name']))
                if not class_visibility(config)['followSchool']:
                    continue
                self.db.run('''INSERT INTO island_profiles VALUES(?,?,?,?,?) ON CONFLICT(class_id) DO UPDATE SET
                    revision=excluded.revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by''',
                    (row['id'], (row['revision'] or 0) + 1, json.dumps(config, ensure_ascii=False), now, user['id']))
            self.s.audit(self.db, user['id'], 'island.visibility', 'school', '1', json.dumps(policy))
        return self.s.json_response(self.school_visibility())

    def authorize(self, request, *, editing=False):
        user = self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        cid = request.match_info['class_id']
        if not self.s.can_access_class(self.db, user, cid, include_teaching=not editing):
            return self.s.json_response({'error': '本班配置仅限班主任和上级修改。' if editing else '没有查看该班教室浮岛的权限。'}, 403)
        return user

    def delivery(self, cid, revision):
        rows = self.db.all('''SELECT d.id,d.name,i.revision,i.synced_at,i.detail FROM devices d
            LEFT JOIN island_delivery i ON i.device_id=d.id AND i.class_id=d.class_id
            WHERE d.class_id=? AND d.enabled=1 ORDER BY d.name''', (cid,))
        return [{**r, 'current': r['revision'] == revision} for r in rows]

    @teacher_read('island', '查看课表与教室浮岛', target='class')
    async def get(self, request):
        user = self.authorize(request)
        if isinstance(user, web.Response):
            return user
        p = self.profile(request.match_info['class_id'])
        return self.s.json_response({**p, 'devices': self.delivery(p['classId'], p['revision']), 'serverTime': self.s.now_ms(),
            'canEdit': self.s.can_access_class(self.db, user, p['classId'], include_teaching=False)})

    @teacher_action('island.update', '修改课表与教室浮岛', fields='config revision', target='class', head_only=True,
                    impact='将同步课表、提醒、组件及自动化配置到该班教室。')
    async def save(self, request):
        user = self.authorize(request, editing=True)
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
            if isinstance(incoming, dict) and 'visibility' not in incoming:
                incoming = {**incoming, 'visibility': self.profile(request.match_info['class_id'])['config']['visibility']}
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
        return self.s.json_response({**self.profile(cid), 'devices': self.delivery(cid, expected+1), 'canEdit': True})

    @teacher_action('island.bulk.preview', '预览批量浮岛设置', fields='classIds changes',
                    confirm=False, roles=tuple(sorted(SCHOOL_ROLES)))
    async def bulk_preview(self, request):
        return await self.bulk(request, apply=False)

    @teacher_action('island.bulk.update', '批量下发浮岛设置', fields='classIds changes revisions',
                    roles=tuple(sorted(SCHOOL_ROLES)),
                    impact='只更新所选班级的浮岛开关、作息、提醒或外观，保留课表和值班；班主任仍可调整本班。')
    async def bulk_save(self, request):
        return await self.bulk(request, apply=True)

    async def bulk(self, request, *, apply):
        user = self.s.require_user(request)
        if isinstance(user, web.Response):
            return user
        if user['role'] not in SCHOOL_ROLES or user.get('classroom'):
            return self.s.json_response({'error': '只有全校管理员可以批量设置教室浮岛。'}, 403)
        body = await self.s.read_json(request)
        try:
            if not isinstance(body, dict):
                raise ValueError('批量设置格式不正确。')
            ids = body.get('classIds')
            if (not isinstance(ids, list) or not 1 <= len(ids) <= 500
                    or any(not isinstance(cid, str) or not cid or len(cid) > 80 for cid in ids)
                    or len(set(ids)) != len(ids)):
                raise ValueError('请选择 1—500 个不重复的班级。')
            changes = bulk_changes(body.get('changes'))
            expected = body.get('revisions')
            if apply:
                if not isinstance(expected, dict) or set(expected) != set(ids):
                    raise ValueError('请先预览全部所选班级的版本。')
                for revision in expected.values():
                    integer(revision, '配置版本', 0, 2**31-1)
        except ValueError as error:
            return self.s.json_response({'error': str(error)}, 400)
        with self.db.transaction():
            classes = {c['id']: c for c in self.db.all('SELECT id,name FROM classes WHERE enabled=1')}
            if any(cid not in classes for cid in ids):
                return self.s.json_response({'error': '所选班级已停用或不存在，请重新选择。'}, 400)
            results, pending = [], []
            for cid in ids:
                current = self.profile(cid)
                row = {'classId': cid, 'className': classes[cid]['name'], 'revision': current['revision'], 'changed': False}
                try:
                    if apply and expected[cid] != current['revision']:
                        raise ValueError('配置已被其他老师更新，请重新预览。')
                    baseline = normalize(current['config'])
                    merged = merge_bulk_settings(baseline, changes)
                    row['changed'] = merged != baseline
                    row['addedSlots'] = len(merged['slots']) - len(baseline['slots'])
                    if row['changed']:
                        pending.append((cid, current['revision'] + 1, merged))
                except ValueError as error:
                    row['error'] = str(error)
                results.append(row)
            valid = not any('error' in row for row in results)
            if not apply:
                return self.s.json_response({'valid': valid, 'classes': results})
            if not valid:
                return self.s.json_response({'error': '本轮未下发，请核对班级提示后重新预览。', 'classes': results}, 409)
            now = self.s.now_ms()
            for cid, revision, merged in pending:
                self.db.run('''INSERT INTO island_profiles VALUES(?,?,?,?,?) ON CONFLICT(class_id) DO UPDATE SET
                    revision=excluded.revision,value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by''',
                    (cid, revision, json.dumps(merged, ensure_ascii=False), now, user['id']))
            if pending:
                self.s.audit(self.db, user['id'], 'island.bulk', 'school', '1',
                    json.dumps({'classIds': [cid for cid, _, _ in pending], 'fields': list(changes)}, ensure_ascii=False))
        return self.s.json_response({'updated': len(pending), 'unchanged': len(ids) - len(pending), 'classes': results})

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

    @teacher_action('island.export', '导出班级课表', target='class', confirm=False, workflow='download')
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

    @teacher_action('island.import', '预览导入班级课表', target='class', head_only=True,
                    confirm=False, workflow='island-import')
    async def import_preview(self, request):
        user = self.authorize(request, editing=True)
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
    app.router.add_get('/api/island/visibility', feature.get_visibility)
    app.router.add_put('/api/island/visibility', feature.save_visibility)
    app.router.add_post('/api/island/bulk/preview', feature.bulk_preview)
    app.router.add_put('/api/island/bulk', feature.bulk_save)
    app.router.add_get('/api/island/classes/{class_id}', feature.get)
    app.router.add_put('/api/island/classes/{class_id}', feature.save)
    app.router.add_get('/api/island/classes/{class_id}/export', feature.export)
    app.router.add_post('/api/island/classes/{class_id}/import', feature.import_preview)
    app.router.add_get('/api/island/device', feature.device)
    app.router.add_post('/api/island/device/ack', feature.ack)

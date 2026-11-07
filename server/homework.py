"""Class-scoped semester presets and versioned classroom homework registration."""
from __future__ import annotations

import csv
import io
import json
import re
from datetime import date, datetime, timedelta, timezone

from aiohttp import web

from permissions import scope_sql
from teacher_capabilities import teacher_action, teacher_manual, teacher_read

SHANGHAI = timezone(timedelta(hours=8))
SUBJECTS = (('chinese', '语文'), ('math', '数学'), ('english', '英语'), ('physics', '物理'),
            ('chemistry', '化学'), ('biology', '生物'), ('politics', '政治'), ('history', '历史'), ('geography', '地理'))
SUBJECT_NAMES = dict(SUBJECTS)
SCHEMA = """
CREATE TABLE IF NOT EXISTS homework_profiles (
 class_id TEXT PRIMARY KEY REFERENCES classes(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
 updated_by TEXT REFERENCES users(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS homework_records (
 class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
 term_id TEXT NOT NULL, day TEXT NOT NULL, item_id TEXT NOT NULL,
 subject_id TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL,
 updated_at INTEGER NOT NULL, device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
 PRIMARY KEY(class_id, term_id, day, item_id));
CREATE INDEX IF NOT EXISTS idx_homework_day ON homework_records(day, class_id);
"""


def today():
    return datetime.now(SHANGHAI).date().isoformat()


def defaults():
    current = date.fromisoformat(today())
    start = current.year if current.month >= 8 else current.year - 1
    spring = 2 <= current.month < 8
    term_id = f'{start + 1}-spring' if spring else f'{start}-fall'
    return {'activeTermId': term_id, 'students': [], 'terms': [{
        'id': term_id, 'label': f'{start}—{start + 1} 学年' + ('第二学期' if spring else '第一学期'),
        'subjects': [{'id': sid, 'name': name, 'items': []} for sid, name in SUBJECTS]}]}


def text(value, label, maximum=60):
    if (not isinstance(value, str) or not value.strip() or len(value) > maximum
            or any(ord(c) < 32 or 0xD800 <= ord(c) <= 0xDFFF for c in value)):
        raise ValueError(f'{label}不能为空且最多 {maximum} 字。')
    return value.strip()


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', value):
        raise ValueError('编号格式不正确。')
    return value


def revision(value):
    if type(value) is not int or not 0 <= value <= 2_147_483_647:
        raise ValueError('版本号无效，请刷新页面。')
    return value


def day(value):
    try:
        if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError('日期格式应为 YYYY-MM-DD。') from None
    return value


def sequence(value, maximum, label):
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError(f'{label}格式不正确，最多 {maximum} 项。')
    if any(not isinstance(item, dict) for item in value):
        raise ValueError(f'{label}格式不正确。')
    return value


def validate_profile(value):
    if not isinstance(value, dict):
        raise ValueError('请填写学期设置。')
    students, student_ids = [], set()
    for student in sequence(value.get('students'), 300, '学生名单'):
        sid = identifier(student.get('id'))
        if sid in student_ids:
            raise ValueError('学生编号重复。')
        student_ids.add(sid)
        students.append({'id': sid, 'name': text(student.get('name'), '学生姓名', 40)})
    terms, term_ids = [], set()
    for term in sequence(value.get('terms'), 30, '学期'):
        tid = identifier(term.get('id'))
        if tid in term_ids:
            raise ValueError('学期编号重复。')
        term_ids.add(tid)
        subjects, seen, item_ids = [], set(), set()
        for subject in sequence(term.get('subjects'), 9, '学科'):
            sid = subject.get('id')
            if not isinstance(sid, str) or sid not in SUBJECT_NAMES or sid in seen:
                raise ValueError('学科编号无效或重复。')
            seen.add(sid)
            items = []
            for item in sequence(subject.get('items'), 40, '作业项目'):
                iid = identifier(item.get('id'))
                if iid in item_ids or type(item.get('active')) is not bool:
                    raise ValueError('作业编号重复或启用状态无效。')
                item_ids.add(iid)
                items.append({'id': iid, 'name': text(item.get('name'), '作业名称', 50), 'active': item['active']})
            subjects.append({'id': sid, 'name': SUBJECT_NAMES[sid], 'items': items})
        if seen != set(SUBJECT_NAMES):
            raise ValueError('请保留完整的九个学科。')
        terms.append({'id': tid, 'label': text(term.get('label'), '学期名称'), 'subjects': subjects})
    active = identifier(value.get('activeTermId'))
    if active not in term_ids:
        raise ValueError('当前学期不存在。')
    return {'activeTermId': active, 'students': students, 'terms': terms}


class Homework:
    def __init__(self, app, service):
        self.service = service
        self.db = app[service.STORE_KEY]
        self.db.db.executescript(SCHEMA)

    def reply(self, value, status=200):
        return self.service.json_response(value, status)

    def staff(self, request):
        if (self.service.is_classroom_request(request) or 'Authorization' in request.headers
                or 'X-ICeClass-Device-Id' in request.headers or 'deviceId' in request.query):
            return self.reply({'error': '请使用教师账号登录。'}, 401)
        return self.service.require_user(request)

    def device(self, request):
        device = self.service.authenticate_device(request, request.headers.get('X-ICeClass-Device-Id') or '')
        expected_class = request.headers.get('X-ICeClass-Class-Id')
        if not device or not expected_class or device['class_id'] != expected_class:
            return self.reply({'error': '教室绑定已失效或发生变化，请关闭后重新打开班级管理。'}, 401)
        return device

    def profile(self, class_id):
        row = self.db.one('SELECT revision,value FROM homework_profiles WHERE class_id=?', (class_id,))
        return {'revision': row['revision'], 'value': json.loads(row['value'])} if row else {'revision': 0, 'value': defaults()}

    def payload(self, class_id, user=None):
        room = self.db.one('SELECT name FROM classes WHERE id=?', (class_id,))
        return {'classId': class_id, 'className': room['name'], **self.profile(class_id),
                'canEdit': bool(user and self.service.can_access_class(self.db, user, class_id, include_teaching=False))}

    @teacher_read('homework.profile', '查看班级作业预设及名单', target='class')
    async def get_profile(self, request):
        user = self.staff(request)
        if isinstance(user, web.Response):
            return user
        cid = request.match_info['class_id']
        if not self.service.can_access_class(self.db, user, cid):
            return self.reply({'error': '没有查看这个班级的权限。'}, 403)
        return self.reply(self.payload(cid, user))

    @teacher_action('homework.profile.save', '保存班级名单和学期作业预设', target='class', head_only=True,
                    fields='revision value', impact='修改本班教室端使用的名单和作业项目；历史记录保留。')
    async def put_profile(self, request):
        user = self.staff(request)
        if isinstance(user, web.Response):
            return user
        cid = request.match_info['class_id']
        if not self.service.can_access_class(self.db, user, cid, include_teaching=False):
            return self.reply({'error': '仅本班班主任或有管理权限的老师可以修改。'}, 403)
        body = await self.service.read_json(request)
        try:
            if body is None:
                raise ValueError('请求格式不正确。')
            expected, value = revision(body.get('revision')), validate_profile(body.get('value'))
        except ValueError as error:
            return self.reply({'error': str(error)}, 400)
        with self.db.transaction():
            if self.profile(cid)['revision'] != expected:
                return self.reply({'error': '设置已被其他老师修改，请刷新后重新核对。'}, 409)
            self.db.run('''INSERT INTO homework_profiles(class_id,revision,value,updated_at,updated_by) VALUES(?,?,?,?,?)
                ON CONFLICT(class_id) DO UPDATE SET revision=excluded.revision,value=excluded.value,
                updated_at=excluded.updated_at,updated_by=excluded.updated_by''',
                        (cid, expected + 1, json.dumps(value, ensure_ascii=False), self.service.now_ms(), user['id']))
            self.service.audit(self.db, user['id'], 'homework.profile.save', 'class', cid, '更新名单和学期作业预设')
        return self.reply(self.payload(cid, user))

    @teacher_manual('教室端专用设备协议，需要原生宿主附加设备令牌及当前班级绑定。')
    async def classroom(self, request):
        device = self.device(request)
        if isinstance(device, web.Response):
            return device
        try:
            selected = day(request.query.get('date', today()))
        except ValueError as error:
            return self.reply({'error': str(error)}, 400)
        profile = self.payload(device['class_id'])
        records = self.db.all('SELECT revision,value,updated_at FROM homework_records WHERE class_id=? AND term_id=? AND day=?',
                              (device['class_id'], profile['value']['activeTermId'], selected))
        return self.reply({**profile, 'date': selected, 'serverDate': today(),
                           'records': [{**json.loads(r['value']), 'revision': r['revision'], 'updatedAt': r['updated_at']} for r in records]})

    @teacher_manual('课代表现场登记专用设备协议，只允许保存当前绑定班级，带配置及记录版本检查。')
    async def save_record(self, request):
        device = self.device(request)
        if isinstance(device, web.Response):
            return device
        body = await self.service.read_json(request)
        try:
            if body is None:
                raise ValueError('请求格式不正确。')
            expected = revision(body.get('revision'))
            profile_revision = revision(body.get('profileRevision'))
            selected = day(body.get('date'))
            if selected > today():
                raise ValueError('不能提前登记未来日期的作业。')
            tid, iid = identifier(body.get('termId')), identifier(body.get('itemId'))
            sid, status, missing = body.get('subjectId'), body.get('status'), body.get('missing')
            if (not isinstance(sid, str) or sid not in SUBJECT_NAMES or status not in ('submitted', 'no_homework')
                    or not isinstance(missing, list) or len(missing) > 300
                    or any(not isinstance(s, str) for s in missing) or len(set(missing)) != len(missing)
                    or status == 'no_homework' and missing):
                raise ValueError('作业状态或未交名单无效。')
        except ValueError as error:
            return self.reply({'error': str(error)}, 400)
        cid = device['class_id']
        if body.get('classId') != cid:
            return self.reply({'error': '只能登记当前绑定班级的作业。'}, 403)
        with self.db.transaction():
            profile = self.profile(cid)
            value = profile['value']
            if profile['revision'] != profile_revision or not profile_revision or value['activeTermId'] != tid:
                return self.reply({'error': '名单或学期设置已变化，请刷新后重新核对。'}, 409)
            term = next(t for t in value['terms'] if t['id'] == tid)
            subject = next(s for s in term['subjects'] if s['id'] == sid)
            item = next((i for i in subject['items'] if i['id'] == iid and i['active']), None)
            key = (cid, tid, selected, iid)
            old = self.db.one('SELECT revision,value FROM homework_records WHERE class_id=? AND term_id=? AND day=? AND item_id=?', key)
            if (old['revision'] if old else 0) != expected:
                return self.reply({'error': '这份作业已被其他人登记，请刷新后核对，当前选择尚未保存。'}, 409)
            snapshot = json.loads(old['value']) if old else None
            students = snapshot['students'] if snapshot else value['students']
            if (not item or not students or not set(missing).issubset(s['id'] for s in students)
                    or snapshot and snapshot['subjectId'] != sid):
                return self.reply({'error': '作业已停用、名单未设置或学生编号无效，请联系班主任。'}, 400)
            if snapshot is None:
                snapshot = {'classId': cid, 'termId': tid, 'termName': term['label'], 'date': selected,
                            'subjectId': sid, 'subjectName': subject['name'], 'itemId': iid, 'itemName': item['name'],
                            'students': students}
            snapshot.update(status=status, missing=[s['id'] for s in students if s['id'] in missing])
            stamp = self.service.now_ms()
            self.db.run('''INSERT INTO homework_records(class_id,term_id,day,item_id,subject_id,revision,value,updated_at,device_id)
                VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(class_id,term_id,day,item_id) DO UPDATE SET
                revision=excluded.revision,value=excluded.value,updated_at=excluded.updated_at,device_id=excluded.device_id''',
                        (*key, sid, expected + 1, json.dumps(snapshot, ensure_ascii=False), stamp, device['id']))
        return self.reply({'record': {**snapshot, 'revision': expected + 1, 'updatedAt': stamp}})

    def report_data(self, request, user):
        query = request.query
        start, end = day(query.get('start', today())), day(query.get('end', today()))
        if start > end or (date.fromisoformat(end) - date.fromisoformat(start)).days > 365:
            raise ValueError('请选择不超过 366 天的有效日期范围。')
        group = query.get('group', 'assignments')
        if group not in ('assignments', 'students'):
            raise ValueError('统计方式无效。')
        cid, tid, sid = query.get('classId', ''), query.get('termId', ''), query.get('subjectId', '')
        if sid and sid not in SUBJECT_NAMES:
            raise ValueError('学科无效。')
        if tid:
            identifier(tid)
        if cid and not self.service.can_access_class(self.db, user, cid):
            return self.reply({'error': '没有查看这个班级的权限。'}, 403)
        clause, args = scope_sql(user)
        where, params = [clause, 'c.enabled=1', 'r.day>=?', 'r.day<=?'], [*args, start, end]
        for column, value in (('r.class_id', cid), ('r.term_id', tid), ('r.subject_id', sid)):
            if value:
                where.append(column + '=?')
                params.append(value)
        records = self.db.all(f'''SELECT r.*,c.name class_name FROM homework_records r
            JOIN classes c ON c.id=r.class_id WHERE {' AND '.join(where)} ORDER BY r.day DESC,c.name,r.subject_id,r.item_id LIMIT 10001''', tuple(params))
        if len(records) > 10000:
            raise ValueError('记录超过 10000 条，请缩小日期或班级范围后查询。')
        totals = {'assignments': 0, 'expected': 0, 'submitted': 0, 'missing': 0, 'noHomework': 0}
        rows, students = [], {}
        for record in records:
            value = json.loads(record['value'])
            no_homework = value['status'] == 'no_homework'
            expected = 0 if no_homework else len(value['students'])
            missing = set(value['missing'])
            count = 0 if no_homework else len(missing)
            totals['noHomework' if no_homework else 'assignments'] += 1
            totals['expected'] += expected
            totals['missing'] += count
            totals['submitted'] += expected - count
            base = {'classId': record['class_id'], 'className': record['class_name'], 'termId': value['termId'], 'termName': value['termName']}
            if group == 'assignments':
                rows.append({**base, 'date': record['day'], 'subjectId': value['subjectId'], 'subjectName': value['subjectName'],
                             'itemName': value['itemName'], 'status': value['status'], 'expected': expected, 'missing': count,
                             'submitted': expected - count, 'missingNames': [s['name'] for s in value['students'] if s['id'] in missing],
                             'updatedAt': record['updated_at']})
            elif not no_homework:
                for student in value['students']:
                    key = (record['class_id'], value['termId'], student['id'])
                    row = students.setdefault(key, {**base, 'studentId': student['id'], 'studentName': student['name'],
                                                   'expected': 0, 'submitted': 0, 'missing': 0})
                    row['expected'] += 1
                    row['missing' if student['id'] in missing else 'submitted'] += 1
        if group == 'students':
            rows = list(students.values())
            rows.sort(key=lambda r: (-r['missing'], r['className'], r['studentName'], r['studentId']))
        return {'rows': rows, 'totals': totals, 'group': group}

    @teacher_read('homework.report', '查看作业统计', fields='classId termId start end subjectId group page pageSize')
    async def report(self, request):
        user = self.staff(request)
        if isinstance(user, web.Response):
            return user
        try:
            page, size = int(request.query.get('page', '1')), int(request.query.get('pageSize', '50'))
            if not 1 <= page <= 1_000_000 or not 1 <= size <= 200:
                raise ValueError('分页参数无效。')
            data = self.report_data(request, user)
            if isinstance(data, web.Response):
                return data
        except ValueError as error:
            return self.reply({'error': str(error)}, 400)
        rows = data['rows']
        return self.reply({**data, 'total': len(rows), 'page': page, 'pageSize': size, 'rows': rows[(page - 1) * size:page * size]})

    @teacher_action('homework.export', '导出作业统计 CSV', fields='classId termId start end subjectId group',
                    confirm=False, workflow='download')
    async def export(self, request):
        user = self.staff(request)
        if isinstance(user, web.Response):
            return user
        try:
            data = self.report_data(request, user)
            if isinstance(data, web.Response):
                return data
        except ValueError as error:
            return self.reply({'error': str(error)}, 400)
        buffer = io.StringIO(newline='')
        writer = csv.writer(buffer)
        if data['group'] == 'students':
            writer.writerow(['班级', '学期', '学生', '应交次数', '已交次数', '未交次数'])
            keys = ('className', 'termName', 'studentName', 'expected', 'submitted', 'missing')
        else:
            writer.writerow(['班级', '学期', '日期', '学科', '作业', '状态', '应交', '已交', '未交', '未交名单'])
            keys = ('className', 'termName', 'date', 'subjectName', 'itemName', 'status', 'expected', 'submitted', 'missing', 'missingNames')
        for row in data['rows']:
            values = []
            for key in keys:
                value = row[key]
                if key == 'status':
                    value = '今日无作业' if value == 'no_homework' else '已登记'
                if isinstance(value, list):
                    value = '、'.join(value)
                if isinstance(value, str) and value.lstrip().startswith(('=', '+', '-', '@')):
                    value = "'" + value
                values.append(value)
            writer.writerow(values)
        return web.Response(body=('\ufeff' + buffer.getvalue()).encode('utf-8'), content_type='text/csv', charset='utf-8',
                            headers={'Content-Disposition': 'attachment; filename="homework.csv"', 'Cache-Control': 'no-store'})


def install_homework(app, service):
    feature = Homework(app, service)
    app.router.add_get('/api/homework/classes/{class_id}/profile', feature.get_profile)
    app.router.add_put('/api/homework/classes/{class_id}/profile', feature.put_profile)
    app.router.add_get('/api/homework/classroom', feature.classroom)
    app.router.add_put('/api/homework/classroom/records', feature.save_record)
    app.router.add_get('/api/homework/report', feature.report)
    app.router.add_get('/api/homework/export', feature.export)

"""Transactional device uploads, teacher revisions and independently computed reports."""
from __future__ import annotations

import csv
import io
import json

from aiohttp import web

from card_quiz_events import replay
from card_quiz_models import (DEVICE_REASON, MAX_SYNC_BODY, answer_complete, array, bank_link, dumps, fail, fingerprint,
                              identifier, obj, revision, validate_events, validate_question,
                              validate_session, validate_transition)
from teacher_capabilities import teacher_action, teacher_manual, teacher_read


def counts(multiple=False):
    result = dict.fromkeys(('samples', 'correct', 'wrong', 'unanswered', 'abstained', 'exempt', 'ungraded', 'practice'), 0)
    if multiple:
        result['incomplete'] = 0
    return result


def rate(row):
    row['accuracy'] = row['correct'] / row['samples'] if row['samples'] else None
    return row


def official_round(question):
    return next((r for r in reversed(question['rounds']) if r['status'] == 'closed' and r['purpose'] == 'formal'), None)


def observations(session, *, selected=False):
    """Only sealed rounds produce outcomes; the board's is_correct is never consulted."""
    for q in session['questions']:
        official = official_round(q)
        for r in q['rounds']:
            if r['status'] != 'closed' or selected and r['purpose'] == 'formal' and r is not official:
                continue
            for student in session['roster']:
                sid = student['id']
                a = r['answers'].get(sid)
                if sid in r['exempt']:
                    status = 'exempt'
                elif a is None and r.get('noCardPolicy') == 'abstain':
                    status = 'abstained'
                elif q['type'] == 'multiple' and a is not None and not answer_complete(q, a, r):
                    status = 'incomplete'
                elif q['type'] == 'multiple' and a is None:
                    status = 'unanswered'
                elif r['purpose'] == 'practice':
                    status = 'practice'
                elif a is None:
                    status = 'unanswered'
                elif q['answer'] is None:
                    status = 'ungraded'
                else:
                    status = 'correct' if a['option'] == q['answer'] else 'wrong'
                yield q, r, student, a, status


def add_count(row, status):
    row[status] += 1
    if status in ('correct', 'wrong'):
        row['samples'] += 1


def session_knowledge(questions, students_by_round, *, include_students=False):
    """Group sealed formal outcomes by the current question tags and classroom question numbers."""
    topics = {}
    for number, question in enumerate(questions, 1):
        formal = official_round(question)
        if formal is None:
            continue
        for tag in question['tags']:
            if tag not in topics:
                topics[tag] = {'tag': tag, 'questionCount': 0, 'wrongQuestionNumbers': [], **counts(True)}
                if include_students:
                    topics[tag]['students'] = {}
            topic = topics[tag]
            topic['questionCount'] += 1
            wrong_before = topic['wrong']
            for outcome in students_by_round.get(formal['id'], ()):
                status = outcome['status']
                add_count(topic, status)
                if include_students:
                    sid = outcome['studentId']
                    students = topic['students']
                    if sid not in students:
                        students[sid] = {'studentId': sid, 'studentName': outcome['studentName'],
                                         'wrongQuestionNumbers': [], **counts(True)}
                    student = students[sid]
                    add_count(student, status)
                    if status == 'wrong':
                        student['wrongQuestionNumbers'].append(number)
            if topic['wrong'] > wrong_before:
                topic['wrongQuestionNumbers'].append(number)
    for topic in topics.values():
        if include_students:
            topic['students'] = sorted((rate(s) for s in topic['students'].values()), key=lambda s: -s['wrong'])
        rate(topic)
    return list(topics.values())


def session_report(session):
    multiple = any(q['type'] == 'multiple' for q in session['questions'])
    totals = counts(multiple)
    students = {s['id']: {'studentId': s['id'], 'studentName': s['name'], **counts(multiple)} for s in session['roster']}
    questions = []
    lookup = {}
    for q in session['questions']:
        rounds = []
        for r in q['rounds']:
            summary = {'id': r['id'], 'purpose': r['purpose'], 'status': r['status'],
                       'startedAt': r['startedAt'], 'endedAt': r['endedAt'], 'students': [],
                       'distribution': {o: 0 for o in 'ABCD'[:len(q['options'])]}, **counts(q['type'] == 'multiple')}
            if q['type'] == 'multiple':
                summary['combinationDistribution'] = {}
            lookup[r['id']] = summary
            rounds.append(summary)
        questions.append({'id': q['id'], 'text': q['text'], 'answer': q['answer'], 'tags': q['tags'], 'rounds': rounds})
    for q, r, student, answer, status in observations(session):
        row = lookup[r['id']]
        row['students'].append({'studentId': student['id'], 'studentName': student['name'],
                                'option': answer['option'] if answer else None, 'status': status})
        if q['type'] == 'multiple' and answer:
            row['students'][-1]['choices'] = dict(answer['choices'])
        if answer_complete(q, answer, r) and status != 'exempt':
            if q['type'] == 'multiple':
                groups = row['combinationDistribution']
                groups[answer['option']] = groups.get(answer['option'], 0) + 1
            # Existing reporting clients read individual option frequencies from this field.
            for option in answer['option']:
                row['distribution'][option] += 1
        add_count(row, status)
        if r['purpose'] == 'practice' or r is official_round(q):
            for counter in (totals, students[student['id']]):
                add_count(counter, 'practice' if r['purpose'] == 'practice' else status)
    students_by_round = {rid: summary['students'] for rid, summary in lookup.items()}
    return {'totals': rate(totals), 'questions': questions, 'students': [rate(s) for s in students.values()],
            'knowledge': session_knowledge(session['questions'], students_by_round, include_students=True)}


class SessionHandlers:
    def session_row(self, sid):
        row = self.db.one('SELECT * FROM card_quiz_sessions WHERE id=?', (identifier(sid),))
        if not row:
            fail('课堂不存在。', 404)
        return row

    def device_session(self, sid, device, *, active=False):
        row = self.session_row(sid)
        if row['class_id'] != device['class_id'] or row['device_id'] != device['id']:
            fail('只能访问本设备、本班保存的课堂。', 403)
        if active and row['ended_at'] is not None:
            fail('课堂已经结束。', 409)
        return row

    def authorized_bank(self, bid, version, cid, user=None):
        if bid is None:
            return
        row = self.db.one('''SELECT v.value,q.owner_id FROM card_quiz_question_versions v
            JOIN card_quiz_questions q ON q.id=v.question_id WHERE v.question_id=? AND v.revision=?''', (bid, version))
        if not row:
            fail('关联的题库版本不存在。')
        if user and row['owner_id'] == user['id']:
            return json.loads(row['value'])
        # Withdrawn publications still authorize the copy in a classroom already cached offline.
        for published in self.db.all('SELECT value FROM card_quiz_publications WHERE class_id=?', (cid,)):
            if any(q['bankId'] == bid and q['bankVersion'] == version for q in json.loads(published['value'])['questions']):
                return json.loads(row['value'])
        fail('题库版本未授权给这个班级。', 403)

    def validate_snapshot_refs(self, session, old=None):
        cid = session['classId']
        if old is None:
            _, roster = self.roster(cid)
            _, cards = self.cards(cid)
            known = {s['id'] for s in roster} | set(cards['bindings'])
            if not {s['id'] for s in session['roster']}.issubset(known):
                fail('课堂名单含未授权的学生编号。')
        previous_images = {q['imageId'] for q in old['questions']} if old else set()
        for q in session['questions']:
            if q['bankId'] is not None:
                bank = self.authorized_bank(q['bankId'], q['bankVersion'], cid)
                if any(q[k] != bank[k] for k in ('type', 'options', 'subjectId')):
                    fail('课堂题型、选项与关联的题库版本不一致。')
            image = q['imageId']
            if image is not None and image not in previous_images:
                refs = self.db.all('SELECT class_id FROM card_quiz_image_refs WHERE image_id=?', (image,))
                if not any(r['class_id'] == cid for r in refs):
                    fail('图片未授权给这个班级。', 403)

    @teacher_manual(DEVICE_REASON)
    async def sync(self, request):
        device = self.device(request)
        body = await self.body(request, MAX_SYNC_BODY)
        session = validate_session(body.get('session'))
        if session['classId'] != device['class_id'] or session['deviceId'] != device['id']:
            fail('同步只能保存当前设备绑定的班级。', 403)
        events = validate_events(body.get('events'), body.get('fromSeq'), session['seq'])
        receipts = self.sync_receipts(body.get('receipts', []))
        if any(e['at'] < session['startedAt'] or session['endedAt'] is not None and e['at'] > session['endedAt'] for e in events):
            fail('事件时间不在课堂范围内。')
        incoming_fingerprint = fingerprint(body['session'])
        with self.db.transaction():
            row = self.db.one('SELECT * FROM card_quiz_sessions WHERE id=?', (session['id'],))
            if row and (row['class_id'] != device['class_id'] or row['device_id'] != device['id']):
                fail('这个课堂属于其他设备或班级。', 403)
            known_batch = self.db.one('SELECT fingerprint FROM card_quiz_batches WHERE session_id=? AND seq=?',
                                     (session['id'], session['seq']))
            if known_batch and known_batch['fingerprint'] != incoming_fingerprint:
                fail('相同序号的课堂内容不一致。', 409)
            stored_seq = row['seq'] if row else 0
            if body['fromSeq'] > stored_seq + 1:
                fail('同步事件缺序，请从已确认序号的下一项重传。')
            for e in events:
                existing = self.db.one('SELECT value FROM card_quiz_events WHERE session_id=? AND seq=?', (session['id'], e['seq']))
                if e['seq'] <= stored_seq and (not existing or existing['value'] != dumps(e)):
                    fail('重传事件内容不一致。', 409)
                duplicate = self.db.one('SELECT seq FROM card_quiz_events WHERE session_id=? AND id=?', (session['id'], e['id']))
                if duplicate and duplicate['seq'] != e['seq']:
                    fail('相同请求编号不能用于其他事件。', 409)
            if known_batch:
                receipt_ids = self.restore_receipts(row, receipts)
                return self.reply({'syncedSeq': stored_seq, 'receiptIds': receipt_ids})
            if row and session['seq'] <= stored_seq:
                fail('旧批次内容未经确认，不能回退课堂。', 409)
            old = json.loads(row['raw_value']) if row else None
            validate_transition(old, session, events)
            fresh = [e for e in events if e['seq'] > stored_seq]
            if row:
                last = self.db.one('SELECT value FROM card_quiz_events WHERE session_id=? AND seq=?', (session['id'], stored_seq))
                if last and fresh and fresh[0]['at'] < json.loads(last['value'])['at']:
                    fail('跨批次事件时间顺序无效。')
            replay(session, fresh, old=old, check_phone=lambda pid: self.historical_pair(pid, session))
            self.validate_snapshot_refs(session, old)
            encoded = dumps(session)
            self.db.run('''INSERT INTO card_quiz_sessions
                (id,class_id,device_id,subject_id,started_at,ended_at,seq,revision,raw_value,value,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                ended_at=excluded.ended_at,seq=excluded.seq,revision=excluded.revision,
                raw_value=excluded.raw_value,value=excluded.value,updated_at=excluded.updated_at''',
                        (session['id'], device['class_id'], device['id'], session['subjectId'], session['startedAt'],
                         session['endedAt'], session['seq'], row['revision'] + 1 if row else 1, encoded, encoded, self.service.now_ms()))
            for e in events:
                if e['seq'] > stored_seq:
                    self.db.run('INSERT INTO card_quiz_events(session_id,seq,id,value) VALUES(?,?,?,?)',
                                (session['id'], e['seq'], e['id'], dumps(e)))
            self.db.run('INSERT INTO card_quiz_batches(session_id,seq,fingerprint) VALUES(?,?,?)',
                        (session['id'], session['seq'], incoming_fingerprint))
            self.image_refs('session', session['id'], device['class_id'], session['questions'])
            saved = self.session_row(session['id'])
            effective, _ = self.effective_state(saved)
            self.pending_commands(effective, self.service.now_ms())
            receipt_ids = self.restore_receipts(saved, receipts)
        return self.reply({'syncedSeq': session['seq'], 'receiptIds': receipt_ids})

    def summary(self, row):
        value = json.loads(row['value'])
        return {'id': row['id'], 'classId': row['class_id'], 'deviceId': row['device_id'], 'subjectId': row['subject_id'],
                'startedAt': row['started_at'], 'endedAt': row['ended_at'], 'seq': row['seq'], 'revision': row['revision'],
                'teacherId': row['teacher_id'], 'questionCount': len(value['questions']),
                'studentCount': len(value['roster']), 'syncedSeq': row['seq']}

    def selected_sessions(self, request, user):
        cid = identifier(request.query.get('classId'))
        self.access(user, cid)
        subject = request.query.get('subjectId')
        where, args = 'class_id=?', [cid]
        if subject is not None:
            where += ' AND subject_id=?'
            args.append(identifier(subject))
        return self.limited('SELECT * FROM card_quiz_sessions WHERE ' + where + ' ORDER BY started_at,id', tuple(args))

    @teacher_read('card-quiz.sessions', '查看纸卡课堂列表', fields='classId subjectId')
    async def list_sessions(self, request):
        user = self.staff(request)
        return self.reply({'sessions': [self.summary(row) for row in self.selected_sessions(request, user)]})

    def session_payload(self, row):
        value = json.loads(row['value'])
        if row['teacher_id'] is not None:
            value['teacherId'] = row['teacher_id']
        return {'session': value, 'revision': row['revision'], 'report': session_report(value)}

    @teacher_read('card-quiz.session', '查看纸卡课堂逐题与个人明细', fields='id')
    async def get_session(self, request):
        user = self.staff(request)
        row = self.session_row(self.resource_id(request))
        self.access(user, row['class_id'])
        return self.reply(self.session_payload(row))

    @teacher_action('card-quiz.session.review', '修订已结束纸卡课堂', fields='id revision questions teacherId',
                    impact='修改题干、标准答案、标签或认领；按新答案重新计算统计，原始设备记录保留。')
    async def put_session(self, request):
        user = self.staff(request)
        body = await self.body(request)
        expected = revision(body.get('revision'))
        changes = array(body.get('questions'), 100, '课后题目修订')
        if 'teacherId' in body and body['teacherId'] != user['id']:
            fail('只能以当前真实登录账号认领课堂。', 403)
        with self.db.transaction():
            row = self.session_row(self.resource_id(request, body))
            self.access(user, row['class_id'])
            if row['revision'] != expected:
                fail('课堂已被修改，请刷新后核对。', 409)
            if row['ended_at'] is None:
                fail('仅完整同步的已结束课堂可以课后修订。', 409)
            value = json.loads(row['value'])
            questions = {q['id']: q for q in value['questions']}
            seen = set()
            for change in changes:
                obj(change, '题目修订')
                if set(change) - {'id', 'text', 'answer', 'tags', 'bankId', 'bankVersion'}:
                    fail('课后只能修改题干、标准答案、标签和题库关联。')
                qid = identifier(change.get('id'))
                if qid in seen or qid not in questions:
                    fail('修订题目不存在或重复。')
                seen.add(qid)
                q = questions[qid]
                proposed = {**q, **change}
                clean = validate_question(proposed)
                bid, version = bank_link(proposed)
                bank = self.authorized_bank(bid, version, row['class_id'], user)
                if bank and any(q[k] != bank[k] for k in ('type', 'options', 'subjectId')):
                    fail('关联的题库版本与原题型和选项不一致。')
                q.update(clean, bankId=bid, bankVersion=version)
            teacher = user['id'] if 'teacherId' in body else row['teacher_id']
            encoded = dumps(value)
            self.db.run('UPDATE card_quiz_sessions SET value=?,revision=?,teacher_id=?,updated_at=? WHERE id=?',
                        (encoded, expected + 1, teacher, self.service.now_ms(), row['id']))
            self.db.run('INSERT INTO card_quiz_reviews(session_id,revision,user_id,value,created_at) VALUES(?,?,?,?,?)',
                        (row['id'], expected + 1, user['id'], dumps({'session': value, 'teacherId': teacher}), self.service.now_ms()))
            self.audit(user, 'card-quiz.session.review', 'class', row['class_id'], '修订纸卡课堂 ' + row['id'])
        return self.reply(self.session_payload(self.session_row(row['id'])))

    def report_data(self, rows):
        students, latest, knowledge, question_ids = {}, {}, {}, {}
        for row in rows:
            session = json.loads(row['value'])
            multiple = any(q['type'] == 'multiple' for q in session['questions'])
            for s in session['roster']:
                students[(row['class_id'], s['id'])] = students.get((row['class_id'], s['id']), {
                    'classId': row['class_id'], 'studentId': s['id'], 'studentName': s['name'], **counts(multiple)})
                if multiple:
                    students[(row['class_id'], s['id'])].setdefault('incomplete', 0)
            for q, r, s, a, status in observations(session, selected=True):
                student = students[(row['class_id'], s['id'])]
                if r['purpose'] == 'practice':
                    status = 'practice'
                if status not in ('correct', 'wrong', 'ungraded'):
                    add_count(student, status)
                    continue
                identity = (q['bankId'], q['bankVersion']) if q['bankId'] is not None else (session['id'], q['id'])
                key = (row['class_id'], s['id'], session['subjectId'], identity)
                order = (session['startedAt'], a['confirmedAt'], r['endedAt'], session['id'], r['id'])
                if key not in latest or order > latest[key][0]:
                    latest[key] = (order, q, s, status)
        for (cid, sid, subject, identity), (_, q, student, status) in latest.items():
            add_count(students[(cid, sid)], status)
            for tag in q['tags']:
                key = (subject, tag)
                row = knowledge.setdefault(key, {'subjectId': subject, 'tag': tag, 'questionCount': 0,
                                                 'answers': 0, **counts(q['type'] == 'multiple')})
                if q['type'] == 'multiple':
                    row.setdefault('incomplete', 0)
                question_ids.setdefault(key, set()).add(identity)
                row['questionCount'] = len(question_ids[key])
                row['answers'] += 1
                add_count(row, status)
        return {'sessions': [self.summary(row) for row in rows],
                'students': [rate(row) for row in students.values()],
                'knowledge': [rate(row) for row in knowledge.values()]}

    @teacher_read('card-quiz.report', '查看纸卡答题学生与知识点统计', fields='classId subjectId')
    async def report(self, request):
        user = self.staff(request)
        return self.reply(self.report_data(self.selected_sessions(request, user)))

    @teacher_action('card-quiz.export', '导出纸卡答题 CSV', confirm=False, workflow='download', fields='classId subjectId')
    async def export(self, request):
        user = self.staff(request)
        rows = self.selected_sessions(request, user)
        output = io.StringIO(newline='')
        writer = csv.writer(output)
        writer.writerow(['班级编号', '课堂编号', '学科', '题目', '题干', '轮次', '用途', '学生编号', '学生', '作答', '标准答案', '状态', '标签'])
        exported = 0
        for row in rows:
            session = json.loads(row['value'])
            for q, r, student, answer, status in observations(session):
                exported += 1
                if exported > 100000:
                    fail('导出超过 100000 行，请缩小班级或学科范围。')
                answer_text = answer['option'] if answer else '弃权' if status == 'abstained' else ''
                if q['type'] == 'multiple' and answer:
                    if answer_complete(q, answer, r):
                        answer_text = answer['option'] or '全不选'
                    else:
                        answer_text = ' / '.join(o + ':' + ('选' if answer['choices'][o] else '不选')
                                                 if o in answer['choices'] else o + ':未答'
                                                 for o in 'ABCD'[:len(q['options'])])
                values = [row['class_id'], row['id'], session['subjectId'], q['id'], q['text'], r['id'], r['purpose'],
                          student['id'], student['name'], answer_text, q['answer'] or '', status, '、'.join(q['tags'])]
                writer.writerow(["'" + v if isinstance(v, str) and v.lstrip().startswith(('=', '+', '-', '@')) else v for v in values])
        return web.Response(body=('\ufeff' + output.getvalue()).encode('utf-8'), content_type='text/csv', charset='utf-8',
                            headers={'Content-Disposition': 'attachment; filename="card-quiz.csv"'})

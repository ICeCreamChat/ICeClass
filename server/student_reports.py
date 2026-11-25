"""Personal projections of existing sealed classroom records; never expose a class snapshot."""
from __future__ import annotations

import json

from aiohttp import web

from card_quiz_models import dumps, fail, identifier
from card_quiz_sessions import counts, observations, official_round, rate, session_knowledge
from teacher_capabilities import teacher_manual


REASON = '报告与题图须使用学生登录。实名账号按历史名单读取，通用卡按本班、本号和最近一节已结束的通用卡课堂读取。'


class StudentReports:
    def personal_rows(self, account, subject=None):
        if (number := account.get('holder_card_number')) is not None:
            # Select the class's latest finished lesson first. A missing card or different
            # subject must never fall back to an earlier holder's report.
            row = self.db.one('''SELECT * FROM card_quiz_sessions WHERE class_id=? AND ended_at IS NOT NULL
                AND json_extract(value,'$.attendanceMode')='scanned' ORDER BY started_at DESC,id DESC LIMIT 1''',
                              (account['class_id'],))
            if not row or subject is not None and identifier(subject) != row['subject_id']:
                return []
            value = json.loads(row['value'])
            student = next((s for s in value['roster'] if s['cardNumber'] == number), None)
            if not student:
                return []
            position = value['roster'].index(student)
            for question in value['questions']:
                question['rounds'] = [r for r in question['rounds'] if position < r['participantCount']]
                for r in question['rounds']:
                    r['participantCount'] = 1
                if not question['rounds']:
                    question['imageId'] = None
            return [self.filter_student_row(row, value, {student['id']})]
        query = '''SELECT s.* FROM card_quiz_sessions s WHERE s.ended_at IS NOT NULL
            AND json_extract(s.value,'$.attendanceMode') IS NULL AND EXISTS (
            SELECT 1 FROM student_account_links l JOIN json_each(s.value,'$.roster') r
            ON json_extract(r.value,'$.id')=l.student_id
            WHERE l.account_id=? AND l.class_id=s.class_id)'''
        args = [account['id']]
        if subject is not None:
            query += ' AND s.subject_id=?'
            args.append(identifier(subject))
        query += ' ORDER BY s.started_at,s.id'
        rows = self.quiz.limited(query, tuple(args))
        links = {}
        for link in self.db.all('SELECT class_id,student_id FROM student_account_links WHERE account_id=?', (account['id'],)):
            links.setdefault(link['class_id'], set()).add(link['student_id'])
        return [self.filter_student_row(row, json.loads(row['value']), links[row['class_id']]) for row in rows]

    @staticmethod
    def filter_student_row(row, value, ids):
        value['roster'] = [student for student in value['roster'] if student['id'] in ids]
        for question in value['questions']:
            for round_value in question['rounds']:
                round_value['answers'] = {sid: answer for sid, answer in round_value['answers'].items() if sid in ids}
                round_value['exempt'] = [sid for sid in round_value['exempt'] if sid in ids]
        return {**row, 'value': dumps(value)}

    @teacher_manual(REASON)
    async def report(self, request):
        account = self.require_student(request)
        rows = self.personal_rows(account, request.query.get('subjectId'))
        calculated = self.quiz.report_data(rows, include_number_cards=bool(account.get('holder_card_number')))
        totals = counts(True)
        for student in calculated['students']:
            for key in totals:
                totals[key] += student.get(key, 0)
        sessions, records, latest = [], [], {}
        for row in rows:
            value = json.loads(row['value'])
            class_name = self.class_info(row['class_id'])['name']
            question_numbers = {q['id']: number for number, q in enumerate(value['questions'], 1)}
            own_by_round = {}
            for q, r, student, answer, status in observations(value):
                official = r is official_round(q)
                record = {'sessionId': row['id'], 'classId': row['class_id'], 'className': class_name,
                          'subjectId': row['subject_id'], 'questionId': q['id'], 'questionNumber': question_numbers[q['id']],
                          'text': q['text'],
                          'type': q['type'], 'options': q['options'], 'imageId': q['imageId'],
                          'answer': q['answer'], 'tags': q['tags'], 'roundId': r['id'], 'purpose': r['purpose'],
                          'status': status, 'option': answer['option'] if answer else None,
                          'startedAt': r['startedAt'], 'endedAt': r['endedAt'], 'isOfficial': official,
                          'counted': official and status not in ('correct', 'wrong', 'ungraded')}
                if q['type'] == 'multiple' and answer:
                    record['choices'] = dict(answer['choices'])
                if 'noCardPolicy' in r:
                    record['noCardPolicy'] = r['noCardPolicy']
                records.append(record)
                if len(records) > 100000:
                    fail('答题记录超过 100000 条，请选择学科后重试。')
                if official:
                    own_by_round.setdefault(r['id'], []).append(record)
                if official and status in ('correct', 'wrong', 'ungraded'):
                    identity = (q['bankId'], q['bankVersion']) if q['bankId'] is not None else (row['id'], q['id'])
                    key = (row['class_id'], student['id'], row['subject_id'], identity)
                    order = (value['startedAt'], answer['confirmedAt'], r['endedAt'], row['id'], r['id'])
                    if key not in latest or order > latest[key][0]:
                        latest[key] = (order, record)
            sessions.append({'id': row['id'], 'classId': row['class_id'], 'className': class_name,
                             'subjectId': row['subject_id'], 'startedAt': row['started_at'], 'endedAt': row['ended_at'],
                             'knowledge': session_knowledge(value['questions'], own_by_round)})
        for _, record in latest.values():
            record['counted'] = True
        return self.quiz.reply({'accountId': account['id'], 'totals': rate(totals), 'knowledge': calculated['knowledge'],
                                'sessions': sessions, 'records': records})

    @teacher_manual(REASON)
    async def image(self, request):
        account = self.require_student(request)
        image_id = identifier(request.match_info['id'])
        allowed = any(q['imageId'] == image_id for row in self.personal_rows(account)
                      for q in json.loads(row['value'])['questions'])
        if not allowed:
            fail('无法查看此题目图片。', 403)
        row = self.db.one('SELECT mime,data FROM card_quiz_images WHERE id=?', (image_id,))
        if not row:
            fail('题目图片不存在。', 404)
        return web.Response(body=row['data'], content_type=row['mime'])

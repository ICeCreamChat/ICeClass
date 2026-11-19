"""Personal projections of existing sealed classroom records; never expose a class snapshot."""
from __future__ import annotations

import json

from aiohttp import web

from card_quiz_models import dumps, fail, identifier
from card_quiz_sessions import counts, observations, official_round, rate
from teacher_capabilities import teacher_manual


REASON = '学生本人报告与题图，仅按当前学生会话关联的历史名单身份读取，不能使用教师身份代替。'


class StudentReports:
    def personal_rows(self, account, subject=None):
        query = '''SELECT s.* FROM card_quiz_sessions s WHERE s.ended_at IS NOT NULL AND EXISTS (
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
        result = []
        for row in rows:
            value = json.loads(row['value'])
            ids = links[row['class_id']]
            value['roster'] = [student for student in value['roster'] if student['id'] in ids]
            for question in value['questions']:
                for round_value in question['rounds']:
                    round_value['answers'] = {sid: answer for sid, answer in round_value['answers'].items() if sid in ids}
                    round_value['exempt'] = [sid for sid in round_value['exempt'] if sid in ids]
            result.append({**row, 'value': dumps(value)})
        return result

    @teacher_manual(REASON)
    async def report(self, request):
        account = self.require_student(request)
        rows = self.personal_rows(account, request.query.get('subjectId'))
        calculated = self.quiz.report_data(rows)
        totals = counts(True)
        for student in calculated['students']:
            for key in totals:
                totals[key] += student.get(key, 0)
        sessions, records, latest = [], [], {}
        for row in rows:
            value = json.loads(row['value'])
            class_name = self.class_info(row['class_id'])['name']
            sessions.append({'id': row['id'], 'classId': row['class_id'], 'className': class_name,
                             'subjectId': row['subject_id'], 'startedAt': row['started_at'], 'endedAt': row['ended_at']})
            for q, r, student, answer, status in observations(value):
                official = r is official_round(q)
                record = {'sessionId': row['id'], 'classId': row['class_id'], 'className': class_name,
                          'subjectId': row['subject_id'], 'questionId': q['id'], 'text': q['text'],
                          'type': q['type'], 'options': q['options'], 'imageId': q['imageId'],
                          'answer': q['answer'], 'tags': q['tags'], 'roundId': r['id'], 'purpose': r['purpose'],
                          'status': status, 'option': answer['option'] if answer else None,
                          'startedAt': r['startedAt'], 'endedAt': r['endedAt'], 'isOfficial': official,
                          'counted': official and status not in ('correct', 'wrong', 'ungraded')}
                if q['type'] == 'multiple' and answer:
                    record['choices'] = dict(answer['choices'])
                records.append(record)
                if len(records) > 100000:
                    fail('答题记录超过 100000 条，请选择学科后重试。')
                if official and status in ('correct', 'wrong', 'ungraded'):
                    identity = (q['bankId'], q['bankVersion']) if q['bankId'] is not None else (row['id'], q['id'])
                    key = (row['class_id'], student['id'], row['subject_id'], identity)
                    order = (value['startedAt'], answer['confirmedAt'], r['endedAt'], row['id'], r['id'])
                    if key not in latest or order > latest[key][0]:
                        latest[key] = (order, record)
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

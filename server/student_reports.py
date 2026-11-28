"""Personal projections of existing sealed classroom records; never expose a class snapshot."""
from __future__ import annotations

import json
from heapq import merge

from aiohttp import web

from card_quiz_models import dumps, fail, identifier
from card_quiz_sessions import counts, observations, official_round, rate, session_knowledge
from teacher_capabilities import teacher_manual


REASON = '报告与题图须使用学生登录。实名账号按历史名单读取，通用卡按本班、本号和最近一节已结束的通用卡课堂读取。'

# The same historical class and roster link must authorize the report, its images and single-lesson analysis.
NAMED_SESSION = """s.ended_at IS NOT NULL AND json_extract(s.value,'$.attendanceMode') IS NULL AND EXISTS (
    SELECT 1 FROM student_account_links l JOIN json_each(s.value,'$.roster') r
    ON json_extract(r.value,'$.id')=l.student_id WHERE l.account_id=:account AND l.class_id=s.class_id)"""
REPORT_COLUMNS = """s.id,s.class_id,s.subject_id,s.started_at,s.ended_at,s.revision,s.value,s.publication_id,
    CASE WHEN s.publication_id IS NULL THEN (
        SELECT json_group_array(json_array(json_extract(q.value,'$.bankId'),json_extract(q.value,'$.bankVersion')))
        FROM json_each(s.raw_value,'$.questions') q) END AS original_sequence"""
ANALYSIS_COLUMNS = 's.id,s.class_id,s.device_id,s.subject_id,s.revision,s.value'


class StudentReports:
    def latest_number_lesson(self, account, columns, subject=None, session_id=None):
        # Choose the latest finished scanned lesson before testing the requested subject, ID or card.
        row = self.db.one(f'''SELECT {columns} FROM card_quiz_sessions s WHERE class_id=? AND ended_at IS NOT NULL
            AND json_extract(value,'$.attendanceMode')='scanned' ORDER BY started_at DESC,id DESC LIMIT 1''',
                          (account['class_id'],))
        if not row or session_id is not None and session_id != row['id']:
            return None
        if subject is not None and identifier(subject) != row['subject_id']:
            return None
        value = json.loads(row['value'])
        for position, student in enumerate(value['roster']):
            if student['cardNumber'] == account['holder_card_number']:
                break
        else:
            return None
        for question in value['questions']:
            question['rounds'] = [r for r in question['rounds'] if position < r['participantCount']]
            for r in question['rounds']:
                r['participantCount'] = 1
            if not question['rounds']:
                question['imageId'] = None
        return row, self.filter_students(value, {student['id']})

    def visible_lessons(self, account, subject=None, *, session_id=None):
        columns = REPORT_COLUMNS if session_id is None else ANALYSIS_COLUMNS
        if account.get('holder_card_number') is not None:
            lesson = self.latest_number_lesson(account, columns, subject, session_id)
            if lesson is not None:
                yield lesson
            return
        links = {}
        for link in self.db.run('SELECT class_id,student_id FROM student_account_links WHERE account_id=?', (account['id'],)):
            links.setdefault(link['class_id'], set()).add(link['student_id'])
        query = f'SELECT {columns} FROM card_quiz_sessions s WHERE {NAMED_SESSION}'
        params = {'account': account['id']}
        if subject is not None:
            query += ' AND s.subject_id=:subject'
            params['subject'] = identifier(subject)
        if session_id is not None:
            rows = self.db.run(query + ' AND s.id=:sid', {**params, 'sid': session_id})
        else:
            # Each class has an ordered index. Merge the cursors without sorting full snapshots across classes.
            query += ' AND s.class_id=:cid ORDER BY s.started_at,s.id'
            cursors = [self.db.run(query, {**params, 'cid': cid}) for cid in links]
            rows = merge(*cursors, key=lambda row: (row['started_at'], row['id']))
        for row in rows:
            yield row, self.filter_students(json.loads(row['value']), links[row['class_id']])

    def personal_rows(self, account, *, session_id):
        # The single-lesson AI reader consumes zero or one row with a serialized personal snapshot.
        return [{**row, 'value': dumps(value)} for row, value in self.visible_lessons(account, session_id=session_id)]

    @staticmethod
    def filter_students(value, ids):
        value['roster'] = [student for student in value['roster'] if student['id'] in ids]
        for question in value['questions']:
            for round_value in question['rounds']:
                round_value['answers'] = {sid: answer for sid, answer in round_value['answers'].items() if sid in ids}
                round_value['exempt'] = [sid for sid in round_value['exempt'] if sid in ids]
        return value

    def lesson_title(self, row, titles):
        if row['publication_id']:
            key = (row['class_id'], row['publication_id'])
            if key not in titles:
                pub = self.db.one("""SELECT json_extract(value,'$.title') AS title FROM card_quiz_publications
                    WHERE class_id=? AND id=?""", key)
                titles[key] = pub['title'] if pub else ''
            return titles[key]
        # Older whiteboards sent only the question snapshots. Match the complete original sequence;
        # a partial, edited or ambiguous deck cannot establish a course title.
        sequence = json.loads(row['original_sequence'])
        if not sequence or any(bid is None or version is None for bid, version in sequence):
            return ''
        key = (row['class_id'], tuple(map(tuple, sequence)))
        if key not in titles:
            matches = self.db.all("""SELECT DISTINCT json_extract(p.value,'$.title') AS title
                FROM card_quiz_publications p WHERE p.class_id=? AND json_array_length(p.value,'$.questions')=?
                AND json_extract(p.value,'$.questions[0].bankId')=? AND NOT EXISTS (
                    SELECT 1 FROM json_each(p.value,'$.questions') q JOIN json_each(?) s ON s.key=q.key
                    WHERE json_extract(q.value,'$.bankId') IS NOT json_extract(s.value,'$[0]')
                       OR json_extract(q.value,'$.bankVersion') IS NOT json_extract(s.value,'$[1]')) LIMIT 2""",
                                  (row['class_id'], len(sequence), sequence[0][0], row['original_sequence']))
            titles[key] = matches[0]['title'] if len(matches) == 1 else ''
        return titles[key]

    def collect_report_rows(self, lessons, sessions, records):
        """Build the personal response as the shared cross-lesson statistics consume each snapshot."""
        latest, followups, titles, class_names = {}, {}, {}, {}
        for row, value in lessons:
            if row['class_id'] not in class_names:
                class_names[row['class_id']] = self.class_info(row['class_id'])['name']
            class_name = class_names[row['class_id']]
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
                if official and status == 'wrong' and q['bankId'] and q['tags']:
                    key = (q['bankId'], q['bankVersion'])
                    if key not in followups:
                        source = self.db.one('''SELECT f.exercises, json_extract(v.value,'$.answer') AS answer
                            FROM card_quiz_followups f JOIN card_quiz_question_versions v USING(question_id,revision)
                            WHERE f.question_id=? AND f.revision=?''', key)
                        followups[key] = (source['answer'], json.loads(source['exercises'])) if source else (None, [])
                    source_answer, exercises = followups[key]
                    if source_answer == q['answer']:
                        matched = [{k: item[k] for k in ('id', 'tag', 'text', 'options', 'answer', 'explanation')}
                                   for item in exercises if item['tag'] in q['tags'] and record['option'] in item['forAnswers']]
                        if matched:
                            record['exercises'] = matched
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
                             'title': self.lesson_title(row, titles), 'revision': row['revision'],
                             'subjectId': row['subject_id'], 'startedAt': row['started_at'], 'endedAt': row['ended_at'],
                             'knowledge': session_knowledge(value['questions'], own_by_round)})
            yield {'class_id': row['class_id'], 'value': dumps(value)}
        for _, record in latest.values():
            record['counted'] = True

    @teacher_manual(REASON)
    async def report(self, request):
        account = self.require_student(request)
        sessions, records = [], []
        lessons = self.visible_lessons(account, request.query.get('subjectId'))
        rows = self.collect_report_rows(lessons, sessions, records)
        calculated = self.quiz.report_data(rows, include_number_cards=bool(account.get('holder_card_number')))
        totals = counts(True)
        for student in calculated['students']:
            for key in totals:
                totals[key] += student.get(key, 0)
        return self.quiz.reply({'accountId': account['id'], 'totals': rate(totals), 'knowledge': calculated['knowledge'],
                                'sessions': sessions, 'records': records})

    @teacher_manual(REASON)
    async def image(self, request):
        account = self.require_student(request)
        image_id = identifier(request.match_info['id'])
        if account.get('holder_card_number') is not None:
            lesson = self.latest_number_lesson(account, 's.value')
            allowed = lesson is not None and any(q['imageId'] == image_id for q in lesson[1]['questions'])
        else:
            allowed = self.db.one(f'''SELECT 1 FROM card_quiz_sessions s
                WHERE s.class_id IN (SELECT class_id FROM student_account_links WHERE account_id=:account)
                AND EXISTS (SELECT 1 FROM json_each(s.value,'$.questions') q WHERE json_extract(q.value,'$.imageId')=:image)
                AND {NAMED_SESSION} LIMIT 1''', {'account': account['id'], 'image': image_id})
        if not allowed:
            fail('无法查看此题目图片。', 403)
        row = self.db.one('SELECT mime,data FROM card_quiz_images WHERE id=?', (image_id,))
        if not row:
            fail('题目图片不存在。', 404)
        return web.Response(body=row['data'], content_type=row['mime'])

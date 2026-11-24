"""Replay the shared Journal's incoming commands against the submitted snapshot IDs.

Question and round IDs are generated on the classroom. Their insertion order is
the only snapshot input to replay; all mutable values must follow from events.
"""
from __future__ import annotations

import copy

from card_quiz_models import (MAX_QUESTIONS, MAX_ROUNDS, answer_complete, array, bank_link, choices_option, fail, identifier,
                              integer, string, validate_question)


def initial_session(snapshot):
    state = {key: copy.deepcopy(snapshot[key]) for key in
             ('schema', 'id', 'classId', 'deviceId', 'subjectId', 'startedAt', 'cardVersion', 'roster')}
    for key in ('rosterRevision', 'cardRevision'):
        if key in snapshot:
            state[key] = snapshot[key]
    state.update(seq=0, endedAt=None, questions=[], currentQuestionId=None,
                 currentRoundId=None, source='board', sourceId='board', generation=1)
    return state


def public_state(session, class_name):
    q = next((q for q in session['questions'] if q['id'] == session['currentQuestionId']), None)
    r = next((r for r in q['rounds'] if r['id'] == session['currentRoundId']), None) if q else None
    answers = {sid: a for sid, a in r['answers'].items() if sid not in r['exempt']} if r else {}
    result = {'sessionId': session['id'], 'className': class_name, 'subjectId': session['subjectId'],
            'questionId': q['id'] if q else None,
            'questionNumber': session['questions'].index(q) + 1 if q else 0,
            'questionType': q['type'] if q else None, 'optionCount': len(q['options']) if q else 4,
            'roundId': r['id'] if r else None, 'roundStatus': r['status'] if r else None,
            'source': session['source'], 'sourceId': session['sourceId'], 'generation': session['generation'],
            'seq': session['seq'], 'received': sum(answer_complete(q, a, r) for a in answers.values()),
            'expected': len(session['roster']) - len(r['exempt']) if r else len(session['roster']),
            'ended': session['endedAt'] is not None}
    if r and 'noCardPolicy' in r:
        result['noCardPolicy'] = r['noCardPolicy']
    if q and q['type'] == 'multiple':
        result.update(activeOption=r['activeOption'] if r else None,
                      optionReceived=sum(r['activeOption'] in a['choices'] for a in answers.values()) if r else 0)
    return result


def question_value(payload):
    value = dict(payload)
    if value.get('type') == 'boolean':
        value['options'] = ['正确', '错误']
    else:
        value.setdefault('options', ['', '', '', ''])
    value.setdefault('text', '')
    value.setdefault('answer', None)
    value.setdefault('imageId', None)
    tags = [string(tag, '标签', 80) for tag in array(value.get('tags', []), 50, '标签')]
    # The model trims and deduplicates tags before persisting a question.
    value['tags'] = list(dict.fromkeys(tag.strip() for tag in tags))
    return validate_question(value)


def replay(snapshot, events, *, old=None, wanted=(), class_name='', check_phone=None):
    state = copy.deepcopy(old) if old is not None else initial_session(snapshot)
    results, wanted = {}, set(wanted)
    targets = {q['id']: q for q in snapshot['questions']}
    for event in events:
        if event['seq'] != state['seq'] + 1 or state['endedAt'] is not None:
            fail('同步事件不能跳序或在课堂结束后执行。')
        if event['generation'] != state['generation'] or event['sourceId'] != state['sourceId']:
            fail('事件采集来源或代次与当时许可不一致。')
        q = next((q for q in state['questions'] if q['id'] == state['currentQuestionId']), None)
        r = next((r for r in q['rounds'] if r['id'] == state['currentRoundId']), None) if q else None
        action, p, stamp = event['action'], event['payload'], event['at']
        if action in ('start_round', 'answer', 'end_round', 'resume_round', 'edit_question', 'reveal', 'set_exempt', 'set_multi_option'):
            if q is None or event['questionId'] != q['id']:
                fail('事件题目与当时课堂不一致。')
        if action in ('answer', 'end_round', 'resume_round', 'set_exempt', 'set_multi_option'):
            if r is None or event['roundId'] != r['id']:
                fail('事件轮次与当时课堂不一致。')
        if action in ('add_question', 'start_round', 'edit_question', 'reveal'):
            if r is not None and r['status'] != 'closed':
                fail('未结束轮次不能换题、修改题目或切换来源。', 409)
        if action == 'add_question':
            index = len(state['questions'])
            if index >= len(snapshot['questions']) or index >= MAX_QUESTIONS:
                fail('新增题目事件与课堂题目数量不一致。')
            value = question_value({**p, 'subjectId': state['subjectId']})
            bid = p.get('bankId') or p.get('id') or None
            bid, version = bank_link({'bankId': bid, 'bankVersion':
                                      (p.get('bankVersion') or p.get('revision') or 1) if bid else None})
            created = {**value, 'id': snapshot['questions'][index]['id'], 'revision': 1,
                       'bankId': bid, 'bankVersion': version, 'revealed': False, 'rounds': []}
            state['questions'].append(created)
            state.update(currentQuestionId=created['id'], currentRoundId=None,
                         generation=state['generation'] + 1)
        elif action == 'start_round':
            index = len(q['rounds'])
            if index >= len(targets[q['id']]['rounds']) or index >= MAX_ROUNDS:
                fail('开始轮次事件与课堂轮次数量不一致。')
            state['generation'] += 1
            created = {'id': targets[q['id']]['rounds'][index]['id'], 'startedAt': stamp, 'endedAt': None,
                       'purpose': 'practice' if q['revealed'] or p.get('practice') is True else 'formal',
                       'source': state['source'], 'sourceId': state['sourceId'], 'generation': state['generation'],
                       'status': 'collecting', 'answers': {}, 'exempt': []}
            if 'noCardPolicy' in event:
                created['noCardPolicy'] = event['noCardPolicy']
            if q['type'] == 'multiple':
                created['activeOption'] = 'A'
            q['rounds'].append(created)
            state['currentRoundId'] = created['id']
        elif action == 'answer':
            if r['status'] != 'collecting' or r['generation'] != state['generation']:
                fail('确认作答时轮次没有有效采集许可。')
            number = integer(p.get('cardNumber'), '纸卡编号', 1, 157)
            student = next((s for s in state['roster'] if s['cardNumber'] == number), None)
            option = p.get('option')
            multi = q['type'] == 'multiple'
            if not student or not isinstance(option, str) or len(option) != 1 or option not in ('AB' if multi else 'ABCD'[:len(q['options'])]):
                fail('确认事件的纸卡归属或选项无效。')
            answer = {'option': option, 'confirmedAt': stamp, 'seq': event['seq']}
            if multi:
                if p.get('targetOption') != r['activeOption']:
                    fail('多选确认事件的目标项已变化。', 409)
                choices = dict(r['answers'].get(student['id'], {}).get('choices', {}))
                choices[r['activeOption']] = option == 'A'
                answer.update(choices=choices, option=choices_option(choices))
            r['answers'][student['id']] = answer
        elif action == 'set_multi_option':
            option = p.get('option')
            if q['type'] != 'multiple' or r['status'] != 'collecting' or r['generation'] != state['generation']:
                fail('仅正在收答的多选轮次可以切换收答项。', 409)
            if not isinstance(option, str) or len(option) != 1 or option not in 'ABCD'[:len(q['options'])]:
                fail('多选收答项无效。')
            state['generation'] += 1
            r.update(activeOption=option, generation=state['generation'])
        elif action == 'end_round':
            if r['status'] == 'closed':
                fail('已封存轮次不能重复结束。', 409)
            r.update(status='closed', endedAt=stamp)
            state['generation'] += 1
        elif action == 'resume_round':
            if r['status'] != 'paused':
                fail('只有暂停轮次可以恢复采集。')
            state['generation'] += 1
            r.update(status='collecting', generation=state['generation'])
        elif action == 'recover':
            state['generation'] += 1
            if r and r['status'] != 'closed':
                r.update(status='paused', generation=state['generation'])
        elif action == 'set_source':
            if r is not None and r['status'] == 'collecting':
                fail('请先暂停本轮收答，再切换设备。', 409)
            if p.get('source') not in ('board', 'phone'):
                fail('采集来源无效。')
            source_id = identifier(p.get('sourceId'))
            if p['source'] == 'phone' and check_phone:
                check_phone(source_id)
            state.update(source=p['source'], sourceId=source_id, generation=state['generation'] + 1)
            if r is not None and r['status'] == 'paused':
                r.update(source=state['source'], sourceId=source_id, generation=state['generation'])
        elif action == 'edit_question':
            if 'revision' in p:
                if type(p['revision']) is not int or p['revision'] != q['revision']:
                    fail('修改题目版本与当时题目不一致。')
            elif type(p.get('expectedSeq')) is not int or p['expectedSeq'] != state['seq']:
                fail('修改题目需要匹配当时的课堂序号。')
            value = question_value({**q, **p, 'subjectId': state['subjectId']})
            shape_changed = value['type'] != q['type'] or len(value['options']) != len(q['options'])
            if any(r['answers'] for r in q['rounds']) and shape_changed:
                fail('已有作答不能改变题型或选项范围。')
            if q['rounds'] and (q['type'] == 'multiple' or value['type'] == 'multiple') and shape_changed:
                fail('已有收答轮次，改变多选题型或选项范围需要新建题目。')
            q.update(value)
            q['revision'] += 1
        elif action == 'reveal':
            if not p.get('external') and q['answer'] is None:
                fail('揭晓答案需要标准答案或外部讲解标记。')
            q['revealed'] = True
        elif action == 'set_exempt':
            if r['status'] == 'closed':
                fail('已封存轮次不能更改免答。', 409)
            sid = identifier(p.get('studentId'))
            if sid not in {s['id'] for s in state['roster']} or type(p.get('exempt')) is not bool:
                fail('免答事件学生或状态无效。')
            r['exempt'] = [s for s in r['exempt'] if s != sid]
            if p['exempt']:
                r['exempt'].append(sid)
        elif action == 'end_session':
            if r and r['status'] != 'closed':
                r.update(status='closed', endedAt=stamp)
            state.update(endedAt=stamp, generation=state['generation'] + 1)
        state['seq'] = event['seq']
        if state['seq'] in wanted:
            results[state['seq']] = {'seq': state['seq'], 'status': 'confirmed',
                                     'state': public_state(state, class_name)}
    if state != snapshot:
        fail('课堂快照与逐条确认事件产生的结果不一致。')
    return results

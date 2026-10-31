import json
from unittest.mock import patch

import app as service
from banban_agent import BanbanAgent
from test_app import ServerTestCase
from banban_speech import SpokenAnswer
from unittest import TestCase


class VoiceTest(ServerTestCase):
    async def events(self, body):
        response = await self.client.post('/api/banban/chat/stream', json=body, headers=self.headers(csrf=True))
        return response, [json.loads(line) async for line in response.content if line.strip()] if response.status == 200 else await response.json()

    async def test_voice_requires_user_csrf_and_valid_binding(self):
        response, _ = await self.events({'message': '你好', 'voice': {'mode': 'voice'}})
        self.assertEqual(response.status, 401)
        device = await self.enroll_test_device()
        for voice in [[], 'voice', {'mode': 'voice', 'apiKey': 'forbidden'}, {'mode': 'voice', 'classId': device['classId']},
                      {'mode': 'voice', 'deviceId': [], 'classId': device['classId']}]:
            response, _ = await self.events({'message': '你好', 'voice': voice})
            self.assertEqual(response.status, 400, voice)
        for voice in [{'mode': 'voice', 'deviceId': 'missing-device', 'classId': device['classId']},
                      {'mode': 'voice', 'deviceId': device['deviceId'], 'classId': 'another-class'}]:
            response, _ = await self.events({'message': '你好', 'voice': voice})
            self.assertEqual(response.status, 403)
        response, events = await self.events({'message': '你好', 'voice': {'mode': 'voice', 'deviceId': device['deviceId'], 'classId': device['classId']}})
        self.assertEqual(response.status, 200)
        self.assertEqual(events[-1]['type'], 'done')
        db = self.app[service.STORE_KEY]
        db.run('UPDATE devices SET enabled=0 WHERE id=?', (device['deviceId'],))
        response, _ = await self.events({'message': '你好', 'voice': {'mode': 'voice', 'deviceId': device['deviceId'], 'classId': device['classId']}})
        self.assertEqual(response.status, 403)

    async def test_unknown_speech_is_rejected_before_model_history_or_operations(self):
        device = await self.enroll_test_device()
        db = self.app[service.STORE_KEY]
        voice = {'mode': 'voice', 'deviceId': device['deviceId'], 'classId': device['classId']}
        before = {table: db.one(f'SELECT COUNT(*) n FROM {table}')["n"]
                  for table in ('banban_conversations', 'banban_conversation_messages', 'banban_operations')}
        with patch.object(BanbanAgent, 'provider') as provider:
            for message in ['打开<unk>', '确认<UNK>执行', '取消[unk]操作', '< unknown >', '打开\ufffd']:
                response, result = await self.events({'message': message, 'voice': voice})
                self.assertEqual(response.status, 400, message)
                self.assertIn('没听清', result['error'])
            provider.assert_not_called()
        after = {table: db.one(f'SELECT COUNT(*) n FROM {table}')["n"] for table in before}
        self.assertEqual(after, before)

    async def test_bound_class_is_checked_against_teacher_permissions(self):
        device = await self.enroll_test_device()
        _, other = await self.json_request('POST', '/api/classes', {'name': '高二（8）班'}, csrf=True)
        response, _ = await self.json_request('POST', '/api/teachers', {
            'username': 'voice-teacher', 'displayName': '语音验收教师', 'password': 'TeacherPassword123',
            'role': 'teacher', 'classIds': [other['id']]}, csrf=True)
        self.assertEqual(response.status, 201)
        response, login = await self.json_request('POST', '/api/auth/login', {'username': 'voice-teacher', 'password': 'TeacherPassword123'})
        self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]
        self.csrf = login['user']['csrfToken']
        response, _ = await self.events({'message': '打开这台电脑的课件', 'voice': {'mode': 'voice', 'deviceId': device['deviceId'], 'classId': device['classId']}})
        self.assertEqual(response.status, 403)

    async def test_voice_uses_existing_agent_with_short_spoken_policy(self):
        device = await self.enroll_test_device()
        await self.json_request('PUT', '/api/banban/settings', {'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'fixture-only-not-a-secret'}, csrf=True)
        seen = []
        async def provider(agent, config, messages, allow_tools=True):
            seen.append((config, messages))
            yield {'text': '我在，请说。'}
        with patch.object(BanbanAgent, 'provider', provider):
            response, events = await self.events({'message': '用一句话解释等差数列', 'voice': {'mode': 'voice', 'deviceId': device['deviceId'], 'classId': device['classId']}})
        self.assertEqual(response.status, 200)
        self.assertEqual(events[-1]['type'], 'done', events)
        self.assertEqual(events[-1]['message']['content'], '我在，请说。')
        config, messages = seen[0]
        self.assertEqual(config['answerTokens'], 450)
        policy = '\n'.join(m['content'] for m in messages if m['role'] == 'system')
        self.assertIn('本轮为语音对话', policy)
        self.assertIn(device['deviceId'], policy)
        self.assertIn('用户明确说出的执行要求已包含本次操作授权', policy)
        self.assertNotIn(device['deviceToken'], policy)

    async def test_committed_sentences_stream_before_done_without_planning_drafts(self):
        await self.enroll_test_device()
        await self.json_request('PUT', '/api/banban/settings', {'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'fixture-only-not-a-secret'}, csrf=True)
        modes = []
        async def provider(agent, config, messages, allow_tools=True):
            modes.append(allow_tools)
            if len(modes) == 1:
                yield {'text': '这是可能撤回的工具规划草稿。'}
                yield {'tool_calls': [{'index': 0, 'id': 'available',
                    'function': {'name': 'available_operations', 'arguments': '{}'}}]}
            else:
                yield {'text': '早上好。'}
                yield {'text': '今天想先准备哪节课？'}
        with patch.object(BanbanAgent, 'provider', provider):
            response, events = await self.events({'message': '查看这台电脑可用的操作', 'voice': {'mode': 'voice'}})
        self.assertEqual(response.status, 200)
        speech = [e for e in events if e['type'] == 'speech']
        self.assertEqual([s['text'] for s in speech], ['早上好。', '今天想先准备哪节课？', ''])
        self.assertEqual([s['sequence'] for s in speech], [0, 1, 2])
        self.assertTrue(speech[-1]['end'])
        self.assertEqual(modes, ['required', True])
        self.assertNotIn('草稿', ''.join(e.get('text', '') for e in events if e['type'] in {'speech', 'delta'}))
        self.assertLess(events.index(speech[0]), len(events) - 1)
        self.assertEqual(events[-1]['type'], 'done')

    async def test_general_knowledge_is_answered_once_without_a_forced_campus_lookup(self):
        await self.enroll_test_device()
        await self.json_request('PUT', '/api/banban/settings', {'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'fixture-only-not-a-secret'}, csrf=True)
        choices = []
        async def provider(agent, config, messages, allow_tools=True):
            choices.append(allow_tools)
            yield {'text': '前 n 项和等于 n 乘以首项与末项的和，再除以二。'}
        with patch.object(BanbanAgent, 'provider', provider):
            _, events = await self.events({'message': '等差数列的前n项和怎么算', 'voice': {'mode': 'voice'}})
        self.assertEqual(events[-1]['type'], 'done', events)
        self.assertEqual(choices, [True])
        answer = events[-1]['message']['content']
        self.assertIn('除以二', answer)
        self.assertEqual(answer, '前 n 项和等于 n 乘以首项与末项的和，再除以二。')
        self.assertEqual(''.join(e['text'] for e in events if e['type'] == 'speech'),
                         '前恩项和等于恩乘以首项与末项的和，再除以二。')
        self.assertEqual(events[-1]['message']['cards'], [])

    async def test_exit_fullscreen_cannot_claim_success_without_calling_a_tool(self):
        await self.enroll_test_device()
        await self.json_request('PUT', '/api/banban/settings', {
            'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'fixture-only-not-a-secret'}, csrf=True)
        async def provider(agent, config, messages, allow_tools=True):
            yield {'text': '放映已退出，演示文稿窗口已经回到普通视图。'}
        with patch.object(BanbanAgent, 'provider', provider):
            _, events = await self.events({'message': '把这个PPT从全屏化退出。', 'voice': {'mode': 'voice'}})
        self.assertEqual(events[-1]['type'], 'error', events)
        self.assertFalse(any(e['type'] in {'speech', 'delta'} for e in events), events)

    async def test_catalog_is_not_an_execution_receipt(self):
        await self.enroll_test_device()
        await self.json_request('PUT', '/api/banban/settings', {
            'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'fixture-only-not-a-secret'}, csrf=True)
        rounds = 0
        async def provider(agent, config, messages, allow_tools=True):
            nonlocal rounds
            rounds += 1
            if rounds == 1:
                yield {'tool_calls': [{'index': 0, 'id': 'available',
                    'function': {'name': 'available_operations', 'arguments': '{}'}}]}
            else:
                yield {'text': '已关闭希沃白板。'}
        with patch.object(BanbanAgent, 'provider', provider):
            _, events = await self.events({'message': '关闭希沃白板', 'voice': {'mode': 'voice'}})
        self.assertEqual(events[-1]['type'], 'error', events)
        self.assertFalse(any(e['type'] in {'speech', 'delta'} for e in events), events)

    async def test_short_voice_social_replies_do_not_call_the_model(self):
        await self.enroll_test_device()
        with patch.object(BanbanAgent, 'provider') as provider:
            for question in ['您好，班班。', '早上好呀', '谢谢你，班班。', '你在吗']:
                _, events = await self.events({'message': question, 'voice': {'mode': 'voice'}})
                self.assertEqual(events[-1]['type'], 'done', events)
                answer = events[-1]['message']['content']
                self.assertLessEqual(len(answer), 12, (question, answer))
                self.assertNotIn('操作', answer)
                self.assertEqual(events[-1]['message']['cards'], [])
            provider.assert_not_called()

    async def test_formula_speech_keeps_the_original_visible_answer_and_history(self):
        await self.enroll_test_device()
        await self.json_request('PUT', '/api/banban/settings', {'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'fixture-only-not-a-secret'}, csrf=True)
        formula = '前 n 项和，写作 Sₙ = n(a₁+aₙ)/2。'
        async def provider(agent, config, messages, allow_tools=True):
            yield {'text': formula}
        with patch.object(BanbanAgent, 'provider', provider):
            _, events = await self.events({'message': '等差数列的前n项和公式', 'voice': {'mode': 'voice'}})
        self.assertEqual(events[-1]['type'], 'done', events)
        self.assertEqual(events[-1]['message']['content'], formula)
        _, history = await self.json_request('GET', '/api/banban/conversation')
        self.assertEqual(history['messages'][-1]['content'], formula)
        spoken = ''.join(e['text'] for e in events if e['type'] == 'speech')
        self.assertIn('下标', spoken)
        self.assertIn('乘以', spoken)
        self.assertIn('再除以二', spoken)
        self.assertNotRegex(spoken, r'[ₙ₁=+/]')

    async def test_capability_question_is_short_and_does_not_become_an_identity_speech(self):
        await self.enroll_test_device()
        _, events = await self.events({'message': '介绍一下你能做什么', 'voice': {'mode': 'voice'}})
        answer = events[-1]['message']['content']
        self.assertLessEqual(len(answer), 45, answer)
        self.assertIn('电脑', answer)
        self.assertNotIn('创造', answer)

    async def test_disabled_voice_connection_does_not_answer_knowledge_with_campus_statistics(self):
        await self.enroll_test_device()
        _, events = await self.events({'message': '等差数列的前n项和', 'voice': {'mode': 'voice'}})
        self.assertIn('智能连接', events[-1]['message']['content'])
        self.assertEqual(events[-1]['message']['cards'], [])

    async def test_incomplete_voice_generation_is_never_committed_or_spoken(self):
        await self.enroll_test_device()
        await self.json_request('PUT', '/api/banban/settings', {'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'fixture-only-not-a-secret'}, csrf=True)
        async def provider(agent, config, messages, allow_tools=True):
            yield {'text': '这段尚未完整的回答。'}
            raise ValueError('回复中断或未完成。')
        with patch.object(BanbanAgent, 'provider', provider):
            _, events = await self.events({'message': '解释一下等差数列', 'voice': {'mode': 'voice'}})
        self.assertEqual(events[-1]['type'], 'error')
        self.assertFalse(any(e['type'] in {'delta', 'speech', 'done'} for e in events), events)

    async def test_local_voice_answer_has_one_ordered_speech_stream(self):
        await self.enroll_test_device()
        _, events = await self.events({'message': '你是谁', 'voice': {'mode': 'voice'}})
        speech = [e for e in events if e['type'] == 'speech']
        self.assertTrue(speech and speech[-1]['end'])
        self.assertEqual(''.join(e['text'] for e in speech), events[-1]['message']['content'])
        self.assertEqual(len({e['turnId'] for e in speech}), 1)

    async def test_connected_voice_identity_uses_generated_words_for_display_speech_and_history(self):
        await self.enroll_test_device()
        await self.json_request('PUT', '/api/banban/settings', {
            'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'fixture-only-not-a-secret'}, csrf=True)
        answer = '我叫班班，是马鞍山市第二十二中学的校园助手。许斌老师负责开发，他创办的 AI 建模社参与共建。'
        async def provider(agent, config, messages, allow_tools=True):
            for char in answer:
                yield {'text': char}
        with patch.object(BanbanAgent, 'provider', provider):
            response, events = await self.events({'message': '你是谁', 'voice': {'mode': 'voice'}})
        self.assertEqual(response.status, 200)
        self.assertEqual(events[-1]['type'], 'done', events)
        self.assertEqual(events[-1]['message']['mode'], 'deepseek')
        self.assertEqual(events[-1]['message']['content'], answer)
        self.assertEqual(events[-1]['message']['cards'], [])
        self.assertEqual(''.join(e['text'] for e in events if e['type'] == 'delta'), answer)
        speech = [e for e in events if e['type'] == 'speech']
        self.assertTrue(speech and speech[-1]['end'])
        self.assertEqual(''.join(e['text'] for e in speech), answer)
        _, saved = await self.json_request('GET', '/api/banban/conversation')
        self.assertEqual(saved['messages'][-1]['content'], answer)


class SpokenAnswerTest(TestCase):
    def test_sum_formula_reads_subscripts_and_preserves_the_grouped_numerator(self):
        for formula in ['Sₙ = n(a₁+aₙ)/2', 'S_n = n(a_1+a_n)/2',
                        r'$S_n=\frac{n(a_1+a_n)}{2}$',
                        r'\(S_n=\dfrac{n\left(a_1+a_n\right)}{2}\)']:
            with self.subTest(formula=formula):
                self.assertEqual(SpokenAnswer.clean('写作 ' + formula + '。'),
                    '写作 艾斯下标恩等于恩乘以诶下标一与诶下标恩的和，再除以二。')

    def test_formula_operators_powers_roots_and_denominators_have_distinct_readings(self):
        examples = [
            ('S_n=n*a_1', '艾斯下标恩等于恩乘以诶下标一'),
            ('a_n=a_1+(n-1)d', '诶下标恩等于诶下标一加恩与一的差乘以迪'),
            ('x²+y²=z²', '艾克斯的平方加歪的平方等于泽德的平方'),
            ('x=1/(y+1)', '艾克斯等于一除以歪与一的和'),
            ('x>0', '艾克斯大于零'),
            (r'$x=\sqrt{a^2+b^2}$', '艾克斯等于诶的平方与比的平方的和的平方根'),
            (r'$q^{n-1}\geq0$', '丘的括号恩减一括号结束次方大于等于零'),
        ]
        for formula, expected in examples:
            with self.subTest(formula=formula):
                self.assertEqual(SpokenAnswer.clean(formula), expected)

    def test_spoken_formula_does_not_split_at_a_latex_line_break(self):
        answer = SpokenAnswer('c' * 32)
        events = answer.feed('公式是：$$S_n=\\frac{n(a_1+\n')
        self.assertEqual(events, [])
        events += answer.feed('a_n)}{2}$$。', final=True)
        self.assertEqual(''.join(e['text'] for e in events),
            '公式是：艾斯下标恩等于恩乘以诶下标一与诶下标恩的和，再除以二。')
        self.assertTrue(events[-1]['end'])

    def test_non_math_words_paths_versions_and_dates_are_not_algebra(self):
        text = '已打开 Word/Excel，版本2.5.0，日期2026-10-26，路径 C:/Math/lesson.pptx，接口 /api/banban，API key = value。'
        self.assertEqual(SpokenAnswer.clean(text), text)

    def test_letters_explained_after_a_formula_are_read_but_words_and_paths_are_preserved(self):
        self.assertEqual(SpokenAnswer.clean('a²+b²=c²，其中 c 是斜边；保存在 C:/Math/lesson.pptx，用 Word 打开。'),
            '诶的平方加比的平方等于西的平方，其中 西 是斜边；保存在 C:/Math/lesson.pptx，用 Word 打开。')

    def test_formula_is_not_cut_at_the_length_limit_inside_an_index_or_fraction(self):
        answer = SpokenAnswer('d' * 32)
        events = answer.feed('说明' * 46 + r'$S_n=\frac{n(a_1+')
        self.assertFalse(any('看屏幕' in e['text'] or '$' in e['text'] for e in events))
        events += answer.feed(r'a_n)}{2}$', final=True)
        spoken = ''.join(e['text'] for e in events)
        self.assertEqual(spoken, '说明' * 46 + '艾斯下标恩等于恩乘以诶下标一与诶下标恩的和，再除以二')

    def test_formula_grouping_and_negative_powers_keep_their_meaning(self):
        examples = [(r'$x=\frac{a}{b*c}$', '艾克斯等于诶除以括号比乘以西括号结束'),
                    ('$x=-y^2$', '艾克斯等于负歪的平方'),
                    ('$x=(-y)^2$', '艾克斯等于括号负歪括号结束的平方'),
                    ('$x=2^(-1)$', '艾克斯等于二的负一次方')]
        for formula, expected in examples:
            with self.subTest(formula=formula):
                self.assertEqual(SpokenAnswer.clean(formula), expected)

    def test_unsupported_or_incomplete_explicit_math_is_not_silently_misread(self):
        for formula in [r'$\int_0^1 f(x) dx$', r'$\frac{1}{x$']:
            with self.subTest(formula=formula):
                self.assertEqual(SpokenAnswer.clean('公式：' + formula + '。'), '公式：这部分公式请看屏幕。')

    def test_only_campus_data_and_real_operations_require_a_tool(self):
        for question in ['等差数列的前n项和', 'Hello class是什么意思', '讲个笑话', '再简短一点', '解释一下光合作用', '今天天气怎么样', '继续讲', 'What is the type of this sentence?']:
            self.assertFalse(BanbanAgent.needs_data(question), question)
        for question in ['本周晨读情况呢', '再看一下刚才的记录', '那二班呢', '上周呢', '打开Word', '把验收文字改成Hello class', '取消刚才的操作',
                         'Open PowerPoint', 'Please open Word', 'Set the volume to forty percent', 'Next slide',
                         '把这个PPT从全屏化退出', '退出PPT', '结束演示', '全屏显示', '最小化希沃', '还原WPS',
                         '翻到第五页', 'Exit fullscreen', 'Restore PowerPoint', 'Minimize WPS']:
            self.assertTrue(BanbanAgent.needs_data(question), question)

    def test_fragmented_fences_and_markdown_do_not_read_code_or_links(self):
        answer = SpokenAnswer('a' * 32)
        events = answer.feed('已经准备好。```py\nprint(')
        events += answer.feed('"不要朗读代码。")\n```接着看[课表](https://example.com)。', final=True)
        self.assertEqual(''.join(e['text'] for e in events), '已经准备好。接着看课表。')
        self.assertTrue(events[-1]['end'])
        self.assertEqual(answer.feed('重复终止', final=True), [])

    def test_long_answer_and_unclosed_code_have_bounded_speech(self):
        answer = SpokenAnswer('b' * 32)
        events = answer.feed('说明，' * 1200 + '```code不读', final=True)
        self.assertLessEqual(sum(len(e['text']) for e in events), 2500)
        self.assertTrue(all(len(e['text']) <= 100 for e in events))

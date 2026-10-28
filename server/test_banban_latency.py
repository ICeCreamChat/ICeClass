import asyncio
import json
from unittest import TestCase
from unittest.mock import patch

from banban_agent import BanbanAgent
from banban_operations import Operations
from test_app import ServerTestCase
import banban_speech
import test_banban_operations as operation_fixtures


class QuickVoiceCommandTest(TestCase):
    def setUp(self):
        self.observed = {
            'applications': [{'id': 'writer', 'name': 'WPS 文字', 'kind': 'wps-writer'},
                             {'id': 'slides', 'name': 'WPS 演示', 'kind': 'wps-presentation'}],
            'windows': [{'id': 'document', 'title': '教学文稿', 'appId': 'writer', 'kind': 'wps-writer', 'foreground': True},
                        {'id': 'show', 'title': '数学课件', 'appId': 'slides', 'kind': 'wps-presentation',
                         'presentationMode': 'slideshow'}]}

    def test_literal_short_commands_use_observed_ids(self):
        for message, expected in [
            ('请打开WPS文字。', {'action': 'open_app', 'appId': 'writer'}),
            ('帮我把教学文稿最大化', {'action': 'maximize_window', 'targetId': 'document'}),
            ('最小化当前窗口', {'action': 'minimize_window', 'targetId': 'document'}),
            ('还原教学文稿', {'action': 'restore_window', 'targetId': 'document'}),
            ('切到WPS文字', {'action': 'focus_window', 'targetId': 'document'}),
            ('关闭教学文稿', {'action': 'close_window', 'targetId': 'document'}),
            ('下一页', {'action': 'presentation_next', 'targetId': 'show'}),
            ('上一页', {'action': 'presentation_previous', 'targetId': 'show'}),
            ('退出PPT放映', {'action': 'presentation_end', 'targetId': 'show'}),
            ('开始放映', {'action': 'presentation_start', 'targetId': 'show'}),
        ]:
            with self.subTest(message=message):
                self.assertEqual(banban_speech.quick_computer_action(message, self.observed), expected)

    def test_negated_conditional_multistep_and_missing_targets_stay_with_agent(self):
        for message in ['不要打开WPS文字', '如果可以就关闭教学文稿', '先打开WPS文字再打开WPS演示',
                        '打开WPS文字，写你好', '关闭教学文稿并保存', '打开不存在的软件',
                        '打开Word文件', '把教学文稿改成最大化', '下一页，然后退出放映']:
            with self.subTest(message=message):
                self.assertIsNone(banban_speech.quick_computer_action(message, self.observed))

    def test_duplicate_app_window_and_slideshow_candidates_are_not_guessed(self):
        self.observed['applications'].append({'id': 'other-writer', 'name': 'WPS 文字', 'kind': 'wps-writer'})
        self.observed['windows'].extend([
            {'id': 'other-document', 'title': '教学文稿', 'appId': 'writer', 'kind': 'wps-writer', 'foreground': True},
            {'id': 'other-show', 'title': '另一课件', 'kind': 'powerpoint', 'presentationMode': 'slideshow'}])
        for message in ['打开WPS文字', '把教学文稿最大化', '最小化当前窗口', '切到WPS文字', '下一页']:
            with self.subTest(message=message):
                self.assertIsNone(banban_speech.quick_computer_action(message, self.observed))

    def test_popup_and_presentation_editor_cannot_receive_bare_page_commands(self):
        self.observed['windows'][0]['isPopup'] = True
        self.observed['windows'][1]['presentationMode'] = 'editor'
        for message in ['关闭当前窗口', '下一页', '退出放映']:
            with self.subTest(message=message):
                self.assertIsNone(banban_speech.quick_computer_action(message, self.observed))
        self.assertEqual(banban_speech.quick_computer_action('开始放映', self.observed),
                         {'action': 'presentation_start', 'targetId': 'show'})


class VoiceLatencyTest(ServerTestCase):
    setup_device = operation_fixtures.OperationTest.setup_device
    socket = operation_fixtures.OperationTest.socket
    ack = operation_fixtures.OperationTest.ack

    async def configure(self):
        await self.setup_device()
        await self.json_request('PUT', '/api/banban/settings', {
            'enabled': True, 'model': 'fixture', 'apiKey': 'fixture-only'}, csrf=True)

    def voice_context(self):
        return {'mode': 'voice', 'deviceId': self.device['deviceId'], 'classId': self.cid}

    async def events(self, question):
        response = await self.client.post('/api/banban/chat/stream', json={
            'message': question, 'voice': self.voice_context()}, headers=self.headers(csrf=True))
        return [json.loads(line) async for line in response.content if line.strip()]

    async def test_first_model_call_can_act_on_fresh_local_windows_each_turn(self):
        await self.configure()
        ws = await self.socket()
        commands, first_contexts = [], []
        observations = 0

        async def receiver():
            nonlocal observations
            async for message in ws:
                command = json.loads(message.data)
                if command.get('type') != 'device_command':
                    continue
                action = command['parameters']['action']
                commands.append(command)
                if action == 'inspect':
                    observations += 1
                    await self.ack(ws, command,
                        applications=[{'id': 'writer-observed-now', 'name': 'WPS 文字', 'kind': 'wps-writer'}],
                        windows=[{'id': 'current-window-' + str(observations), 'title': '当前独立文稿',
                                  'appId': 'writer-observed-now'}])
                else:
                    await self.ack(ws, command, windows=[{
                        'id': command['parameters']['targetId'], 'title': '当前独立文稿', 'maximized': True}])

        async def provider(agent, cfg, messages, allow_tools=True):
            if messages[-1]['role'] == 'user':
                first_contexts.append(json.dumps(messages, ensure_ascii=False))
                fresh = next(m['content'] for m in messages if m['role'] == 'system' and m['content'].startswith('本轮电脑观察'))
                observed = json.loads(fresh.split('\n', 1)[1])
                self.assertEqual([a['id'] for a in observed['openApplications']], ['writer-observed-now'])
                if 'writer-observed-now' not in first_contexts[-1]:
                    yield {'text': '还没读取当前窗口。'}
                    return
                yield {'tool_calls': [{'index': 0, 'id': 'maximize-current', 'function': {
                    'name': 'operate_computer', 'arguments': json.dumps({
                        'action': 'maximize_window', 'deviceId': self.device['deviceId'], 'classId': self.cid,
                        'targetId': 'current-window-' + str(observations)})}}]}
            else:
                yield {'text': '已最大化当前文稿。'}

        receiving = asyncio.create_task(receiver())
        try:
            with patch.object(BanbanAgent, 'provider', provider):
                for _ in range(2):
                    events = await self.events('把这台电脑的文稿窗口最大化')
                    self.assertEqual(events[-1]['type'], 'done', events)
                    self.assertFalse(any(e['type'] == 'confirmation' for e in events))
            self.assertEqual([c['parameters']['action'] for c in commands],
                             ['inspect', 'maximize_window', 'inspect', 'maximize_window'])
            self.assertEqual([c['parameters']['targetId'] for c in commands if c['parameters']['action'] == 'maximize_window'],
                             ['current-window-1', 'current-window-2'])
            self.assertEqual(len(first_contexts), 2)
            self.assertIn('writer-observed-now', first_contexts[0])
            self.assertIn('current-window-2', first_contexts[1])
        finally:
            receiving.cancel()
            await asyncio.gather(receiving, return_exceptions=True)
            await ws.close()

    async def test_other_class_and_campus_data_do_not_preinspect_local_computer(self):
        await self.configure()
        ws = await self.socket()
        first_contexts = []

        async def provider(agent, cfg, messages, allow_tools=True):
            if messages[-1]['role'] == 'user':
                first_contexts.append(json.dumps(messages, ensure_ascii=False))
                yield {'tool_calls': [{'index': 0, 'id': 'catalog', 'function': {
                    'name': 'available_operations', 'arguments': '{}'}}]}
            else:
                yield {'text': '请说明具体目标。'}

        try:
            with patch.object(BanbanAgent, 'provider', provider):
                for question in ['打开高二（8）班的WPS', '查看今天全校早读统计']:
                    events = await self.events(question)
                    self.assertEqual(events[-1]['type'], 'done', events)
            self.assertEqual(self.db.one("SELECT COUNT(*) n FROM banban_operations WHERE kind='computer'")['n'], 0)
            self.assertTrue(all('本轮电脑观察' not in context for context in first_contexts))
        finally:
            await ws.close()

    async def test_short_voice_commands_execute_and_speak_verified_results_without_a_model(self):
        await self.configure()
        ws = await self.socket()
        commands, model_calls = [], []

        async def receiver():
            async for message in ws:
                command = json.loads(message.data)
                if command.get('type') != 'device_command':
                    continue
                commands.append(command['parameters']['action'])
                await self.ack(ws, command, applications=[{'id': 'writer-now', 'name': 'WPS 文字', 'kind': 'wps-writer'}],
                    windows=[{'id': 'window-now', 'title': '班班验收窗口', 'appId': 'writer-now',
                              'kind': 'wps-writer', 'foreground': True, 'maximized': True}], maximized=True, foreground=True)

        async def provider(agent, cfg, messages, allow_tools=True):
            model_calls.append(True)
            yield {'text': '仍在等待模型判断。'}

        receiving = asyncio.create_task(receiver())
        try:
            with patch.object(BanbanAgent, 'provider', provider):
                for question in ['把班班验收窗口最大化', '请打开WPS文字']:
                    events = await self.events(question)
                    self.assertEqual(events[-1]['type'], 'done', events)
                    self.assertEqual(events[-1]['message']['mode'], 'local')
                    self.assertFalse(any(e['type'] == 'confirmation' for e in events))
                    answer = events[-1]['message']['content']
                    self.assertEqual(''.join(e['text'] for e in events if e['type'] == 'speech' and not e['end']), answer)
            self.assertEqual(commands, ['inspect', 'maximize_window', 'inspect', 'open_app'])
            self.assertFalse(model_calls, 'a unique, literal voice command must not wait for the model')
        finally:
            receiving.cancel()
            await asyncio.gather(receiving, return_exceptions=True)
            await ws.close()

    async def test_unverified_quick_action_returns_to_agent_without_claiming_success(self):
        await self.configure()
        ws = await self.socket()
        commands, model_calls = [], []

        async def receiver():
            async for message in ws:
                command = json.loads(message.data)
                if command.get('type') != 'device_command':
                    continue
                commands.append(command['parameters']['action'])
                if commands[-1] == 'inspect':
                    await self.ack(ws, command, applications=[], windows=[{'id': 'window-now', 'title': '班班验收窗口'}])
                else:
                    await self.ack(ws, command, verified=False, detail='窗口未能最大化。')

        async def provider(agent, cfg, messages, allow_tools=True):
            model_calls.append(messages[-1]['role'])
            yield {'text': '窗口尚未确认最大化，请查看屏幕。'}

        receiving = asyncio.create_task(receiver())
        try:
            with patch.object(BanbanAgent, 'provider', provider):
                events = await self.events('把班班验收窗口最大化')
            self.assertEqual(commands, ['inspect', 'maximize_window'])
            self.assertEqual(model_calls, ['tool'])
            self.assertEqual(events[-1]['type'], 'done', events)
            self.assertEqual(events[-1]['message']['operations'][0]['id'],
                             next(e['operation']['id'] for e in events if e['type'] == 'operation'))
            self.assertNotIn('已最大化', events[-1]['message']['content'])
        finally:
            receiving.cancel()
            await asyncio.gather(receiving, return_exceptions=True)
            await ws.close()

    async def test_quick_action_rechecks_device_permission_after_observation(self):
        await self.configure()
        ws = await self.socket()
        commands = []
        wait_result = Operations.wait_result

        async def receiver():
            async for message in ws:
                command = json.loads(message.data)
                if command.get('type') != 'device_command':
                    continue
                commands.append(command['parameters']['action'])
                await self.ack(ws, command, windows=[{'id': 'window-now', 'title': '班班验收窗口'}])

        async def revoke_after_observation(operations, request, operation_id):
            result = await wait_result(operations, request, operation_id)
            args = json.loads(self.db.one('SELECT args FROM banban_operations WHERE id=?', (operation_id,))['args'])
            if args['action'] == 'inspect':
                self.db.run('UPDATE devices SET enabled=0 WHERE id=?', (self.device['deviceId'],))
            return result

        async def provider(agent, cfg, messages, allow_tools=True):
            yield {'text': '这台电脑已停用，未执行最大化。'}

        receiving = asyncio.create_task(receiver())
        try:
            with patch.object(Operations, 'wait_result', revoke_after_observation), patch.object(BanbanAgent, 'provider', provider):
                events = await self.events('把班班验收窗口最大化')
            self.assertEqual(commands, ['inspect'])
            self.assertEqual(self.db.one("SELECT COUNT(*) n FROM banban_operations WHERE kind='computer'")['n'], 1)
            self.assertEqual(events[-1]['type'], 'done', events)
            self.assertNotIn('已最大化', events[-1]['message']['content'])
        finally:
            receiving.cancel()
            await asyncio.gather(receiving, return_exceptions=True)
            await ws.close()

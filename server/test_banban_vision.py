import base64
import asyncio
import json
import random
import struct
import unittest
import zlib
from unittest.mock import patch

import app as service
from banban_agent import BanbanAgent
from banban_operations import KEY
from banban_vision import extract_frame, image_message
from test_app import ServerTestCase


# A complete 1x1 PNG. The fixture is not a desktop image.
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=')


class VisionPayloadTest(unittest.TestCase):
    def frame(self):
        return {'screenshot': {'id': 'frame-test', 'targetId': 'window-test', 'width': 1, 'height': 1,
                               'dataUrl': 'data:image/png;base64,' + base64.b64encode(PNG).decode('ascii')},
                'verified': True}

    def test_image_is_removed_from_operation_result(self):
        clean, frame = extract_frame(self.frame())
        self.assertNotIn('dataUrl', clean['screenshot'])
        self.assertTrue(frame['dataUrl'].startswith('data:image/png;base64,'))

    def test_dimensions_must_match_encoded_png(self):
        data = self.frame()
        data['screenshot']['width'] = 100
        with self.assertRaises(ValueError):
            extract_frame(data)

    def test_remote_urls_and_invalid_base64_are_rejected(self):
        for value in ('https://example.com/a.png', 'data:image/png;base64,???'):
            data = self.frame()
            data['screenshot']['dataUrl'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                extract_frame(data)

    def test_only_latest_image_remains_in_model_context(self):
        messages = [{'role': 'user', 'content': '请修改标题'}]
        _, first = extract_frame(self.frame())
        image_message(messages, first)
        second = dict(first, id='frame-new')
        image_message(messages, second)
        images = [p for m in messages if isinstance(m.get('content'), list) for p in m['content'] if p['type'] == 'image_url']
        self.assertEqual(len(images), 1)
        self.assertIn('frame-new', messages[-1]['content'][0]['text'])
        self.assertEqual(messages[0]['content'], '请修改标题')


class VisionProtocolTest(ServerTestCase):
    async def prepare(self):
        self.device = await self.enroll_test_device()
        self.ops = self.app[KEY]
        self.db = self.app[service.STORE_KEY]
        self.ws = await self.client.ws_connect('/ws/device?deviceId=' + self.device['deviceId'],
            headers={'Authorization': 'Bearer ' + self.device['deviceToken']})
        await self.ws.receive_json()
        await self.ws.send_json({'type': 'device_status', 'capabilities': ['agent_control_v1']})
        await self.ws.send_json({'type': 'heartbeat'})
        await self.ws.receive_json()
        _, operation = await self.computer('inspect')
        await self.ack(await self.ws.receive_json(), {'windows': [{'id': 'window-test', 'title': '视觉测试窗口'}]})

    async def computer(self, action, **args):
        return await self.json_request('POST', '/api/banban/operations', {'kind': 'computer', 'args': {
            'action': action, 'deviceId': self.device['deviceId'], 'classId': self.device['classId'], **args}}, csrf=True)

    async def ack(self, command, result):
        await self.ws.send_json({'type': 'device_command_ack', 'action': 'agent_control', 'commandId': command['commandId'],
                                 'success': True, 'result': {'verified': True, **result}})
        await self.ws.send_json({'type': 'heartbeat'})
        await self.ws.receive_json()

    def picture(self, image=PNG, width=1, height=1, identity='frame-test'):
        return {'screenshot': {'id': identity, 'targetId': 'window-test', 'width': width, 'height': height,
            'dataUrl': 'data:image/png;base64,' + base64.b64encode(image).decode('ascii')}}

    async def capture(self, **picture):
        _, operation = await self.computer('capture_window', targetId='window-test')
        await self.ack(await self.ws.receive_json(), self.picture(**picture))
        return self.ops.row(operation['id'], {'id': self.db.one("SELECT id FROM users WHERE username='ICe'")['id'], 'role': 'superadmin'})

    async def test_frame_is_authenticated_transient_and_not_in_history_or_receipts(self):
        await self.prepare()
        row = await self.capture()
        self.assertEqual(row['status'], 'succeeded')
        self.assertNotIn('dataUrl', row['result'])
        self.assertNotIn('data:image/', row['result'])
        self.assertGreater(json.loads(row['result'])['screenshot']['capturedAt'], 0)
        with self.assertRaises(ValueError):
            self.ops.take_frame(row['id'], {'id': 'another-user'})
        self.assertIn(row['id'], self.ops.frames)
        frame = self.ops.take_frame(row['id'], {'id': row['actor_id'], 'role': 'superadmin'})
        self.assertTrue(frame['dataUrl'].startswith('data:image/png;base64,'))
        with self.assertRaises(ValueError):
            self.ops.take_frame(row['id'], {'id': row['actor_id'], 'role': 'superadmin'})
        await self.ws.close()

    async def test_old_frame_and_out_of_bounds_input_cannot_dispatch(self):
        await self.prepare()
        await self.capture()
        for coordinate in (-1, 1, True):
            status, _ = await self.computer('click_window', targetId='window-test', screenshotId='frame-test', x=coordinate, y=0)
            self.assertEqual(status.status, 400)
        await self.capture(identity='frame-new')
        status, _ = await self.computer('click_window', targetId='window-test', screenshotId='frame-test', x=0, y=0)
        self.assertEqual(status.status, 400)
        status, _ = await self.computer('press_window_key', targetId='window-test', screenshotId='frame-new', key='win_r')
        self.assertEqual(status.status, 400)
        await self.ws.close()

    async def test_expired_frame_is_not_returned_or_accepted_for_input(self):
        await self.prepare()
        row = await self.capture()
        now = self.ops.s.now_ms()
        with patch.object(self.ops.s, 'now_ms', return_value=now + 61000):
            with self.assertRaises(ValueError):
                self.ops.take_frame(row['id'], {'id': row['actor_id'], 'role': 'superadmin'})
            status, _ = await self.computer('click_window', targetId='window-test', screenshotId='frame-test', x=0, y=0)
            self.assertEqual(status.status, 400)
        await self.ws.close()

    async def test_screenshot_beyond_old_websocket_limit_stays_transient(self):
        await self.prepare()
        width = height = 256
        rng = random.Random(10)
        raw = b''.join(b'\x00' + rng.randbytes(width * 3) for _ in range(height))
        def chunk(kind, value):
            return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value))
        png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
        self.assertGreater(len(png), 64000)
        row = await self.capture(image=png, width=width, height=height)
        self.assertEqual(row['status'], 'succeeded')
        self.assertLess(len(row['result']), 2000)
        self.assertIn(row['id'], self.ops.frames)
        await self.ws.close()

    async def test_invalid_image_fails_without_persisting_payload(self):
        await self.prepare()
        _, operation = await self.computer('capture_window', targetId='window-test')
        data = self.picture()
        data['screenshot']['width'] = 50
        await self.ack(await self.ws.receive_json(), data)
        row = self.db.one('SELECT * FROM banban_operations WHERE id=?', (operation['id'],))
        self.assertEqual(row['status'], 'failed')
        self.assertNotIn('dataUrl', row['result'])
        self.assertNotIn(row['id'], self.ops.frames)
        await self.ws.close()

    async def test_visual_action_supplies_next_image_without_recapture(self):
        await self.prepare()
        await self.json_request('PUT', '/api/banban/settings', {'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'fixture-only'}, csrf=True)
        observed = []

        async def provider(agent, cfg, messages, allow_tools=True):
            images = [m for m in messages if isinstance(m.get('content'), list)]
            if not images:
                args = {'action': 'capture_window', 'targetId': 'window-test', 'deviceId': self.device['deviceId']}
            elif not observed:
                observed.append(images[-1]['content'][0]['text'])
                args = {'action': 'click_window', 'targetId': 'window-test', 'deviceId': self.device['deviceId'],
                        'screenshotId': 'frame-test', 'x': 0, 'y': 0}
            else:
                observed.append(images[-1]['content'][0]['text'])
                self.assertEqual(len(images), 1)
                yield {'text': '新画面已经核对。'}
                return
            yield {'tool_calls': [{'index': 0, 'id': 'step-' + str(len(observed)), 'function': {
                'name': 'operate_computer', 'arguments': json.dumps(args)}}]}

        async def receiver():
            await self.ack(await self.ws.receive_json(), self.picture())
            command = await self.ws.receive_json()
            self.assertEqual(command['parameters']['action'], 'click_window')
            self.assertEqual(command['parameters']['screenshotId'], 'frame-test')
            await self.ack(command, {**self.picture(identity='frame-after-click'), 'inputSent': True, 'effectVerified': False})

        response_task = asyncio.create_task(receiver())
        try:
            with patch.object(BanbanAgent, 'provider', provider):
                response = await self.client.post('/api/banban/chat/stream', json={'message': '看画面并点击目标', 'voice': {'mode': 'voice'}}, headers=self.headers(csrf=True))
                events = [json.loads(line) async for line in response.content if line.strip()]
            await response_task
            self.assertEqual(events[-1]['type'], 'done', events)
            self.assertIn('frame-after-click', observed[-1])
            self.assertFalse(self.ops.frames)
            rows = self.db.all("SELECT args,result FROM banban_operations WHERE kind='computer'")
            self.assertEqual(sum(json.loads(row['args'])['action'] == 'capture_window' for row in rows), 1)
            self.assertNotIn('data:image/', json.dumps(rows))
            clicked = next(e['operation'] for e in events if e['type'] == 'operation' and e['operation']['action'] == 'click_window')
            self.assertNotIn('screenshotId', clicked['parameters'])
            self.assertNotIn('x', clicked['parameters'])
        finally:
            response_task.cancel()
            await self.ws.close()

    async def test_model_receives_real_image_content_and_history_only_text(self):
        await self.prepare()
        await self.json_request('PUT', '/api/banban/settings', {'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'fixture-only'}, csrf=True)
        received = []
        async def provider(agent, cfg, messages, allow_tools=True):
            if isinstance(messages[-1]['content'], list):
                received.append(messages[-1])
                yield {'usage': {'prompt_tokens': 100, 'completion_tokens': 10, 'prompt_cache_hit_tokens': 20}}
                yield {'text': '看到了测试窗口。'}
            else:
                yield {'tool_calls': [{'index': 0, 'id': 'vision-call', 'function': {'name': 'operate_computer', 'arguments': json.dumps({
                    'action': 'capture_window', 'targetId': 'window-test', 'deviceId': self.device['deviceId']})}}]}
        async def receiver():
            await self.ack(await self.ws.receive_json(), self.picture())
        response_task = asyncio.create_task(receiver())
        try:
            with patch.object(BanbanAgent, 'provider', provider):
                response = await self.client.post('/api/banban/chat/stream', json={'message': '看看屏幕上的画面'}, headers=self.headers(csrf=True))
                events = [json.loads(line) async for line in response.content if line.strip()]
            await response_task
            self.assertEqual(events[-1]['type'], 'done', events)
            self.assertEqual(received[0]['content'][1]['type'], 'image_url')
            self.assertEqual(events[-1]['message']['usage'], {'inputTokens': 100, 'outputTokens': 10, 'cachedInputTokens': 20, 'calls': 1})
            _, history = await self.json_request('GET', '/api/banban/conversation')
            self.assertNotIn('data:image/', json.dumps(history))
            self.assertFalse(self.ops.frames)
        finally:
            response_task.cancel()
            await self.ws.close()

    async def test_focus_change_removes_old_screenshot_from_model_context(self):
        await self.prepare()
        await self.json_request('PUT', '/api/banban/settings', {'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'fixture-only'}, csrf=True)
        step = 0
        images_after_focus = []

        async def provider(agent, cfg, messages, allow_tools=True):
            nonlocal step
            images = [m for m in messages if isinstance(m.get('content'), list)]
            if step == 2:
                images_after_focus.extend(images)
                yield {'text': '已切换窗口，需要重新查看当前画面。'}
                return
            action = 'capture_window' if step == 0 else 'focus_window'
            if step == 1:
                self.assertEqual(len(images), 1)
            step += 1
            yield {'tool_calls': [{'index': 0, 'id': 'step-' + str(step), 'function': {'name': 'operate_computer',
                'arguments': json.dumps({'action': action, 'targetId': 'window-test', 'deviceId': self.device['deviceId']})}}]}

        async def receiver():
            await self.ack(await self.ws.receive_json(), self.picture())
            command = await self.ws.receive_json()
            self.assertEqual(command['parameters']['action'], 'focus_window')
            await self.ack(command, {'windows': [{'id': 'window-test', 'title': '视觉测试窗口', 'foreground': True}]})

        task = asyncio.create_task(receiver())
        try:
            with patch.object(BanbanAgent, 'provider', provider):
                response = await self.client.post('/api/banban/chat/stream', json={'message': '查看画面并切换应用', 'voice': {'mode': 'voice'}}, headers=self.headers(csrf=True))
                events = [json.loads(line) async for line in response.content if line.strip()]
            await task
            self.assertEqual(events[-1]['type'], 'done', events)
            self.assertFalse(images_after_focus, 'focus invalidates the old picture; the model must re-observe before clicking')
        finally:
            task.cancel()
            await self.ws.close()

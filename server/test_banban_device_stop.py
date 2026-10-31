import asyncio
import json
from unittest.mock import patch

from banban_agent import BanbanAgent
from test_app import ServerTestCase
from test_banban_operations import OperationTest


class DeviceStopTest(ServerTestCase):
    setup_device = OperationTest.setup_device
    socket = OperationTest.socket
    computer = OperationTest.computer
    create = OperationTest.create
    get = OperationTest.get
    ack = OperationTest.ack

    async def stop(self, device=None, **body):
        device = device or self.device
        response = await self.client.post('/api/receiver/computer/stop?deviceId=' + device['deviceId'],
            headers={'Authorization': 'Bearer ' + device['deviceToken']},
            json={'classId': device['classId'], **body})
        return response, await response.json()

    async def test_local_stop_cancels_pending_operations_and_ignores_late_success(self):
        await self.setup_device()
        ws = await self.socket()
        try:
            _, operation = await self.computer()
            command = await ws.receive_json()
            response, stopped = await self.stop()
            self.assertEqual(response.status, 200, stopped)
            self.assertEqual(stopped['cancelledOperations'], 1)
            self.assertIsInstance(stopped['stoppedThrough'], int)
            self.assertEqual((await self.get(operation))['status'], 'cancelled')
            await self.ack(ws, command)
            self.assertEqual((await self.get(operation))['status'], 'cancelled')
            # Stopping one round must not disable the next user request.
            _, following = await self.computer()
            await self.ack(ws, await ws.receive_json())
            self.assertEqual((await self.get(following))['status'], 'succeeded')
        finally:
            await ws.close()

    async def test_local_stop_interrupts_model_between_device_steps(self):
        await self.setup_device()
        ws = await self.socket()
        await self.json_request('PUT', '/api/banban/settings',
            {'enabled': True, 'model': 'fixture', 'apiKey': 'fixture-only'}, csrf=True)
        entered, cancelled = asyncio.Event(), asyncio.Event()

        async def provider(agent, cfg, messages, allow_tools=True):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
            yield {'text': 'stale answer'}

        async def read(response):
            return [json.loads(line) async for line in response.content if line.strip()]

        try:
            with patch.object(BanbanAgent, 'provider', provider):
                response = await self.client.post('/api/banban/chat/stream', json={
                    'message': '请介绍一个教学建议', 'voice': {'mode': 'voice',
                        'deviceId': self.device['deviceId'], 'classId': self.cid}}, headers=self.headers(csrf=True))
                reader = asyncio.create_task(read(response))
                await asyncio.wait_for(entered.wait(), 3)
                result, stopped = await self.stop()
                self.assertEqual(result.status, 200, stopped)
                self.assertEqual(stopped['cancelledTurns'], 1)
                await asyncio.wait_for(cancelled.wait(), 1)
                events = await asyncio.wait_for(reader, 3)
                self.assertNotIn('stale answer', str(events))
        finally:
            await ws.close()

    async def test_stop_requires_device_proof_and_current_binding(self):
        await self.setup_device()
        response = await self.client.post('/api/receiver/computer/stop?deviceId=' + self.device['deviceId'], json={'classId': self.cid})
        self.assertEqual(response.status, 401)
        response, _ = await self.stop(classId='another-class')
        self.assertEqual(response.status, 409)

    async def test_idle_stop_reports_zero_work(self):
        await self.setup_device()
        response, data = await self.stop()
        self.assertEqual(response.status, 200, data)
        self.assertEqual((data['cancelledOperations'], data['cancelledTurns']), (0, 0))

    async def test_local_stop_does_not_cancel_another_device(self):
        await self.setup_device()
        _, code = await self.json_request('POST', f'/api/classes/{self.cid}/enrollment-code', {}, csrf=True)
        _, other = await self.json_request('POST', '/api/device/enroll', {'code': code['code'], 'deviceName': '另一台测试电脑'})
        ws, other_ws = await self.socket(), await self.socket(other)
        try:
            _, first = await self.computer()
            await ws.receive_json()
            _, second = await self.create('computer', {'action': 'inspect', 'classId': self.cid, 'deviceId': other['deviceId']})
            other_command = await other_ws.receive_json()
            response, _ = await self.stop(deviceId=other['deviceId'])
            self.assertEqual(response.status, 200)
            self.assertEqual((await self.get(first))['status'], 'cancelled')
            self.assertEqual((await self.get(second))['status'], 'running')
            await self.ack(other_ws, other_command)
            self.assertEqual((await self.get(second))['status'], 'succeeded')
        finally:
            await ws.close()
            await other_ws.close()

    async def test_stop_also_cancels_a_turn_started_from_a_teacher_page(self):
        await self.setup_device()
        ws = await self.socket()
        await self.json_request('PUT', '/api/banban/settings', {'enabled': True, 'model': 'fixture', 'apiKey': 'fixture-only'}, csrf=True)
        between_steps = asyncio.Event()

        async def provider(agent, cfg, messages, allow_tools=True):
            if messages[-1]['role'] == 'user':
                yield {'tool_calls': [{'index': 0, 'id': 'inspect-target', 'function': {'name': 'operate_computer',
                    'arguments': json.dumps({'action': 'inspect', 'classId': self.cid, 'deviceId': self.device['deviceId']})}}]}
            else:
                between_steps.set()
                await asyncio.Event().wait()

        async def read(response):
            return [json.loads(line) async for line in response.content if line.strip()]

        try:
            with patch.object(BanbanAgent, 'provider', provider):
                response = await self.client.post('/api/banban/chat/stream', json={'message': '查看目标电脑并整理操作建议'}, headers=self.headers(csrf=True))
                reader = asyncio.create_task(read(response))
                await self.ack(ws, await asyncio.wait_for(ws.receive_json(), 3), windows=[])
                await asyncio.wait_for(between_steps.wait(), 3)
                result, stopped = await self.stop()
                self.assertEqual(result.status, 200, stopped)
                self.assertEqual(stopped['cancelledTurns'], 1)
                events = await asyncio.wait_for(reader, 3)
                self.assertEqual(events[-1]['type'], 'done')
                self.assertIn('已停止', events[-1]['message']['content'])
        finally:
            await ws.close()

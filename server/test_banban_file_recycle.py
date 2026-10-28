import asyncio
import json
from unittest.mock import patch

from banban_agent import BanbanAgent
from test_app import ServerTestCase
import test_banban_operations as fixtures


class FileRecycleTest(ServerTestCase):
    setup_device = fixtures.OperationTest.setup_device
    socket = fixtures.OperationTest.socket
    ack = fixtures.OperationTest.ack
    create = fixtures.OperationTest.create
    computer = fixtures.OperationTest.computer
    confirm = fixtures.OperationTest.confirm
    get = fixtures.OperationTest.get

    async def prime(self, ws, recyclable=True):
        response, operation = await self.computer('list_files', query='验收文稿')
        self.assertEqual(response.status, 200)
        await self.ack(ws, await ws.receive_json(), files=[{
            'id': 'fresh-file', 'name': '验收文稿.docx', 'folder': '桌面',
            'canRecycle': recyclable}])
        return operation

    async def test_file_recycle_uses_observed_identity_and_keeps_endpoint_confirmation(self):
        await self.setup_device()
        ws = await self.socket()
        try:
            await self.prime(ws)
            response, operation = await self.computer('recycle_file', fileId='fresh-file')
            self.assertEqual(response.status, 200, operation)
            self.assertEqual(operation['status'], 'awaiting_confirmation')
            self.assertEqual(operation['parameters']['file'], '验收文稿.docx')
            await self.confirm(operation)
            command = await ws.receive_json()
            self.assertEqual(command['parameters']['fileId'], 'fresh-file')
            self.assertNotIn('path', command['parameters'])
            await self.ack(ws, command)
            self.assertEqual((await self.get(operation))['status'], 'unconfirmed')
            await self.ack(ws, command, recycled=True, fileName='验收文稿.docx')
            self.assertEqual((await self.get(operation))['status'], 'succeeded')
        finally:
            await ws.close()

    async def test_voice_file_recycle_executes_without_a_second_confirmation(self):
        await self.setup_device()
        ws = await self.socket()
        await self.prime(ws)
        await self.json_request('PUT', '/api/banban/settings',
            {'enabled': True, 'model': 'fixture', 'apiKey': 'fixture-only'}, csrf=True)
        received = []

        async def provider(agent, cfg, messages, allow_tools=True):
            if messages[-1]['role'] == 'user':
                yield {'tool_calls': [{'index': 0, 'id': 'recycle-once', 'function': {
                    'name': 'operate_computer', 'arguments': json.dumps({
                        'action': 'recycle_file', 'fileId': 'fresh-file',
                        'deviceId': self.device['deviceId'], 'classId': self.cid})}}]}
            else:
                yield {'text': '已移到回收站。'}

        async def receiver():
            async for message in ws:
                command = json.loads(message.data)
                if command.get('type') != 'device_command':
                    continue
                received.append(command['parameters']['action'])
                await self.ack(ws, command, windows=[], recycled=True)

        receiving = asyncio.create_task(receiver())
        try:
            with patch.object(BanbanAgent, 'provider', provider):
                response = await self.client.post('/api/banban/chat/stream', json={
                    'message': '把刚保存的验收文稿移到回收站', 'voice': {
                        'mode': 'voice', 'deviceId': self.device['deviceId'], 'classId': self.cid}},
                    headers=self.headers(csrf=True))
                events = [json.loads(line) async for line in response.content if line.strip()]
            self.assertFalse(any(e['type'] == 'confirmation' for e in events), events)
            self.assertEqual([a for a in received if a != 'inspect'], ['recycle_file'], events)
            operations = [e['operation'] for e in events if e['type'] == 'operation']
            self.assertEqual(operations[-1]['status'], 'succeeded', events)
        finally:
            receiving.cancel()
            await asyncio.gather(receiving, return_exceptions=True)
            await ws.close()

    async def test_recycle_rejects_unknown_stale_and_nonrecyclable_targets(self):
        await self.setup_device()
        ws = await self.socket()
        try:
            response, _ = await self.computer('recycle_file', fileId='guessed-file')
            self.assertEqual(response.status, 400)
            operation = await self.prime(ws, recyclable=False)
            response, _ = await self.computer('recycle_file', fileId='fresh-file')
            self.assertEqual(response.status, 400)
            operation = await self.prime(ws)
            self.db.run('UPDATE banban_operations SET updated_at=? WHERE id=?',
                        (self.ops.s.now_ms() - 121000, operation['id']))
            response, _ = await self.computer('recycle_file', fileId='fresh-file')
            self.assertEqual(response.status, 400)
        finally:
            await ws.close()

    async def test_recycle_cannot_accept_arbitrary_paths_or_permanent_delete_options(self):
        await self.setup_device()
        ws = await self.socket()
        try:
            await self.prime(ws)
            for extra in [{'path': 'C:/Users/Public/other.docx'}, {'permanent': True}, {'recursive': True}]:
                response, _ = await self.computer('recycle_file', fileId='fresh-file', **extra)
                self.assertEqual(response.status, 400)
        finally:
            await ws.close()

import asyncio
import json
from unittest.mock import patch

from aiohttp import web

import app as service
from banban_operations import KEY, operation_tools
from banban_agent import BanbanAgent
from teacher_capabilities import teacher_action, teacher_read
from test_app import ServerTestCase


class StewardTest(ServerTestCase):
    async def asyncSetUp(self):
        self.saved = []

        @teacher_action('fixture.save', '保存验收便签', fields='value', roles=('superadmin',))
        async def save(request):
            user = service.require_user(request)
            if isinstance(user, web.Response):
                return user
            body = json.loads(await request.read())
            self.saved.append(body['value'])
            return service.json_response({'saved': body['value']})

        @teacher_read('fixture', '查看验收便签', fields='query')
        async def read(request):
            return service.json_response({'value': self.saved, 'query': request.query.get('query', '')})

        original = service.install_ideas

        def install(app, *args, **kwargs):
            original(app, *args, **kwargs)
            app.router.add_put('/api/steward-fixture', save)
            app.router.add_get('/api/steward-fixture', read)

        with patch.object(service, 'install_ideas', install):
            await super().asyncSetUp()
        await self.bootstrap_and_login()
        self.ops = self.app[KEY]

    async def test_late_registered_feature_is_discovered_and_executes_once(self):
        _, catalog = await self.json_request('GET', '/api/banban/operations/catalog')
        self.assertIn('fixture.save', [item['id'] for item in catalog['business']])
        tools = {tool['function']['name']: tool['function'] for tool in operation_tools(self.app)}
        self.assertIn('fixture.save', tools['operate_platform']['parameters']['properties']['operation']['enum'])
        self.assertIn('fixture', tools['inspect_platform']['parameters']['properties']['resource']['enum'])
        body = {'kind': 'platform', 'requestKey': 'test-one',
                'args': {'operation': 'fixture.save', 'payload': {'value': 'new'}}}
        response, operation = await self.json_request('POST', '/api/banban/operations', body, csrf=True)
        self.assertEqual(response.status, 200, operation)
        self.assertEqual(operation['status'], 'awaiting_confirmation')
        self.assertEqual(self.saved, [])
        for _ in range(2):
            _, result = await self.json_request('POST', '/api/banban/operations/' + operation['id'] + '/confirm', {'confirmed': True}, csrf=True)
            self.assertEqual(result['status'], 'succeeded', result)
        self.assertEqual(self.saved, ['new'])
        _, repeated = await self.json_request('POST', '/api/banban/operations', body, csrf=True)
        self.assertEqual(repeated['id'], operation['id'])
        self.assertEqual(self.saved, ['new'])

    async def test_forged_field_or_route_cannot_be_executed(self):
        for payload in ({'value': 1, 'url': '/api/teachers'}, {'password': 'hidden'}):
            response, _ = await self.json_request('POST', '/api/banban/operations', {
                'kind': 'platform', 'args': {'operation': 'fixture.save', 'payload': payload}}, csrf=True)
            self.assertEqual(response.status, 400)
        self.assertEqual(self.saved, [])

    async def test_native_action_needs_live_client_claim_and_receipt(self):
        client = {'clientId': 'fixture-client', 'actions': [
            {'id': 'teacher.about', 'title': '关于班伴', 'fields': [], 'confirmation': False}]}
        response, operation = await self.json_request('POST', '/api/banban/operations', {
            'kind': 'teacher', 'teacherClient': client,
            'args': {'action': 'teacher.about', 'payload': {}}}, csrf=True)
        self.assertEqual(response.status, 200, operation)
        self.assertEqual(operation['status'], 'awaiting_client', operation)
        path = '/api/banban/operations/' + operation['id']
        response, _ = await self.json_request('POST', path + '/client-result', {
            'clientId': 'fixture-client', 'success': True, 'verified': True, 'detail': '已打开'}, csrf=True)
        self.assertEqual(response.status, 400)
        response, _ = await self.json_request('POST', path + '/client-start', {'clientId': 'different'}, csrf=True)
        self.assertEqual(response.status, 403)
        _, claim = await self.json_request('POST', path + '/client-start', {'clientId': 'fixture-client'}, csrf=True)
        self.assertTrue(claim['claimed'])
        _, repeated = await self.json_request('POST', path + '/client-start', {'clientId': 'fixture-client'}, csrf=True)
        self.assertFalse(repeated['claimed'])
        _, receipt = await self.json_request('POST', path + '/client-result', {
            'clientId': 'fixture-client', 'success': True, 'verified': True, 'detail': '已打开关于窗口'}, csrf=True)
        self.assertEqual(receipt['status'], 'succeeded', receipt)
        _, duplicate = await self.json_request('POST', path + '/client-result', {
            'clientId': 'fixture-client', 'success': False, 'verified': False, 'detail': '重复回执'}, csrf=True)
        self.assertEqual(duplicate, receipt)

    async def test_browser_cannot_prepare_native_action_without_client(self):
        response, data = await self.json_request('POST', '/api/banban/operations', {
            'kind': 'teacher', 'args': {'action': 'teacher.about', 'payload': {}}}, csrf=True)
        self.assertEqual(response.status, 400, data)

    async def test_confirmed_native_action_emits_live_dispatch_before_waiting_for_receipt(self):
        await self.json_request('PUT', '/api/banban/settings', {
            'enabled': True, 'model': 'fixture', 'apiKey': 'fixture-only'}, csrf=True)
        client = {'clientId': 'fixture-client', 'actions': [
            {'id': 'teacher.fixture', 'title': '确认后打开验收窗口', 'fields': [], 'confirmation': True}]}

        async def provider(agent, cfg, messages, allow_tools=True):
            if messages[-1]['role'] == 'user':
                yield {'tool_calls': [{'index': 0, 'id': 'native-confirmed', 'function': {
                    'name': 'operate_teacher', 'arguments': json.dumps({'action': 'teacher.fixture'})}}]}
            else:
                self.assertEqual(json.loads(messages[-1]['content'])['status'], 'succeeded')
                yield {'text': '验收窗口已打开。'}

        events, claims = [], []

        async def read_stream(response):
            async for line in response.content:
                if not line.strip():
                    continue
                event = json.loads(line)
                events.append(event)
                if event['type'] != 'operation':
                    continue
                operation = event['operation']
                path = '/api/banban/operations/' + operation['id']
                if operation['status'] == 'awaiting_confirmation':
                    _, confirmed = await self.json_request('POST', path + '/confirm', {'confirmed': True}, csrf=True)
                    self.assertEqual(confirmed['status'], 'awaiting_client')
                elif operation['status'] == 'awaiting_client':
                    _, claim = await self.json_request('POST', path + '/client-start', {'clientId': client['clientId']}, csrf=True)
                    claims.append(claim['claimed'])
                    await self.json_request('POST', path + '/client-result', {
                        'clientId': client['clientId'], 'success': True, 'verified': True,
                        'detail': '已打开验收窗口'}, csrf=True)

        with patch.object(BanbanAgent, 'provider', provider):
            response = await self.client.post('/api/banban/chat/stream', json={
                'message': '确认后打开验收窗口', 'teacherClient': client}, headers=self.headers(csrf=True))
            reader = asyncio.create_task(read_stream(response))
            done, _ = await asyncio.wait({reader}, timeout=2)
            if not done:
                response.close()
                reader.cancel()
                await asyncio.gather(reader, return_exceptions=True)
                self.fail('确认后未收到实时 awaiting_client 事件，本机动作无法领取执行。')
            await reader
        self.assertEqual(claims, [True])
        states = [event['operation']['status'] for event in events if event['type'] == 'operation']
        self.assertEqual(states, ['awaiting_confirmation', 'awaiting_client', 'succeeded'])
        self.assertEqual(events[-1]['type'], 'done', events)

    async def test_missing_native_verification_is_not_reported_as_definite_failure(self):
        client = {'clientId': 'fixture-client', 'actions': [
            {'id': 'teacher.about', 'title': '关于班伴', 'fields': [], 'confirmation': False}]}
        for success, verified, status in ((False, False, 'unconfirmed'), (True, False, 'unconfirmed'),
                                          (False, True, 'failed')):
            _, operation = await self.json_request('POST', '/api/banban/operations', {
                'kind': 'teacher', 'teacherClient': client,
                'args': {'action': 'teacher.about', 'payload': {}}}, csrf=True)
            path = '/api/banban/operations/' + operation['id']
            _, claim = await self.json_request('POST', path + '/client-start', {'clientId': 'fixture-client'}, csrf=True)
            self.assertTrue(claim['claimed'])
            _, receipt = await self.json_request('POST', path + '/client-result', {
                'clientId': 'fixture-client', 'success': success, 'verified': verified,
                'detail': '回执验收'}, csrf=True)
            self.assertEqual(receipt['status'], status, receipt)

    async def test_late_native_receipt_is_accepted_once_after_waiting_ends(self):
        client = {'clientId': 'fixture-client', 'actions': [
            {'id': 'teacher.about', 'title': '关于班伴', 'fields': [], 'confirmation': False}]}
        _, operation = await self.json_request('POST', '/api/banban/operations', {
            'kind': 'teacher', 'teacherClient': client,
            'args': {'action': 'teacher.about', 'payload': {}}}, csrf=True)
        path = '/api/banban/operations/' + operation['id']
        await self.json_request('POST', path + '/client-start', {'clientId': 'fixture-client'}, csrf=True)
        self.ops.db.run('UPDATE banban_operations SET updated_at=? WHERE id=?',
                        (service.now_ms() - 31000, operation['id']))
        _, waiting = await self.json_request('GET', path)
        self.assertEqual(waiting['status'], 'running', waiting)
        self.ops.db.run('UPDATE banban_operations SET updated_at=? WHERE id=?',
                        (service.now_ms() - 91000, operation['id']))
        _, overdue = await self.json_request('GET', path)
        self.assertEqual(overdue['status'], 'unconfirmed', overdue)
        response, receipt = await self.json_request('POST', path + '/client-result', {
            'clientId': 'fixture-client', 'success': True, 'verified': True,
            'detail': '已核实打开窗口'}, csrf=True)
        self.assertEqual(response.status, 200, receipt)
        self.assertEqual(receipt['status'], 'succeeded', receipt)
        _, repeated = await self.json_request('POST', path + '/client-result', {
            'clientId': 'fixture-client', 'success': False, 'verified': False,
            'detail': '不能覆盖已收到的回执'}, csrf=True)
        self.assertEqual(repeated, receipt)

    async def test_unverified_native_receipt_cannot_be_replaced_or_accepted_after_expiry(self):
        client = {'clientId': 'fixture-client', 'actions': [
            {'id': 'teacher.about', 'title': '关于班伴', 'fields': [], 'confirmation': False}]}
        for expired in (False, True):
            _, operation = await self.json_request('POST', '/api/banban/operations', {
                'kind': 'teacher', 'teacherClient': client,
                'args': {'action': 'teacher.about', 'payload': {}}}, csrf=True)
            path = '/api/banban/operations/' + operation['id']
            await self.json_request('POST', path + '/client-start', {'clientId': 'fixture-client'}, csrf=True)
            if expired:
                self.ops.db.run('UPDATE banban_operations SET expires_at=? WHERE id=?',
                                (service.now_ms() - 1, operation['id']))
            else:
                _, first = await self.json_request('POST', path + '/client-result', {
                    'clientId': 'fixture-client', 'success': False, 'verified': False,
                    'detail': '没有收到有效回执'}, csrf=True)
            response, receipt = await self.json_request('POST', path + '/client-result', {
                'clientId': 'fixture-client', 'success': True, 'verified': True,
                'detail': '后续回执'}, csrf=True)
            if expired:
                self.assertEqual(response.status, 400, receipt)
            else:
                self.assertEqual(receipt, first)

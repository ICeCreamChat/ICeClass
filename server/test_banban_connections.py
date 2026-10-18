import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import app as service
import test_banban as fixtures
from banban import Banban
from banban_agent import BanbanAgent
from banban_connections import AccountConnections, PublicResolver, completion_url, normalize_base_url, provider_options
from test_app import ServerTestCase


class ConnectionTest(ServerTestCase):
    seed = fixtures.BanbanTest.seed
    voice = fixtures.BanbanTest.voice
    shout = fixtures.BanbanTest.shout
    scope = fixtures.BanbanTest.scope
    login_staff = fixtures.BanbanTest.login_staff

    async def asyncSetUp(self):
        self.env = patch.dict('os.environ', {'DEEPSEEK_API_KEY': ''})
        self.env.start()
        await super().asyncSetUp()
        self.agent = next(r.handler.__self__ for r in self.app.router.routes()
                          if r.method == 'POST' and r.resource.canonical == '/api/banban/chat/stream')
        self.feature = self.agent.f

    async def asyncTearDown(self):
        await super().asyncTearDown()
        self.env.stop()

    def personal(self, **values):
        return {'source': 'personal', 'baseUrl': 'https://llm.example.org/compatible/v1',
                'apiKey': 'private-key.fixture-123456789', 'model': 'vendor/model:latest', 'enabled': True, **values}

    async def school(self):
        result, data = await self.json_request('PUT', '/api/banban/settings',
            {'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'school-key-private-fixture'}, csrf=True)
        self.assertEqual(result.status, 200, data)

    async def test_account_settings_require_login_csrf_and_never_accept_another_owner(self):
        for method in ['GET', 'PUT']:
            response, _ = await self.json_request(method, '/api/banban/connection', self.personal())
            self.assertEqual(response.status, 401)
        await self.seed()
        response, _ = await self.json_request('PUT', '/api/banban/connection', self.personal())
        self.assertEqual(response.status, 403)
        teacher = await self.login_staff('teacher')
        for values in [{'userId': self.uid}, {'source': 'other'}, {'apiKey': ['wrong']}]:
            response, _ = await self.json_request('PUT', '/api/banban/connection', self.personal(**values), csrf=True)
            self.assertEqual(response.status, 400)
        self.assertFalse(self.feature.connections.own(teacher)[1]['apiKey'])

    async def test_personal_connections_are_owned_persistent_and_keys_never_read_back(self):
        await self.seed()
        await self.school()
        teacher = await self.login_staff('teacher')
        response, original = await self.json_request('GET', '/api/banban/connection')
        self.assertEqual(response.status, 200)
        self.assertEqual(original['source'], 'school')
        self.assertFalse(original['canManageSchool'])
        self.assertNotIn('baseUrl', original['school'])
        response, data = await self.json_request('PUT', '/api/banban/connection', self.personal(), csrf=True)
        self.assertEqual(response.status, 200, data)
        self.assertEqual(data['source'], 'personal')
        self.assertEqual(data['personal']['model'], 'vendor/model:latest')
        self.assertTrue(data['personal']['configured'])
        for path in ['/api/banban/connection', '/api/banban/context']:
            _, visible = await self.json_request('GET', path)
            self.assertNotIn('private-key', json.dumps(visible))
            self.assertNotIn('school-key', json.dumps(visible))
            self.assertNotIn('apiKey', json.dumps(visible))
        reloaded = AccountConnections(self.db, self.feature.config)
        self.assertEqual(reloaded.effective(teacher)['apiKey'], self.personal()['apiKey'])
        other = await self.login_staff('director')
        _, data = await self.json_request('GET', '/api/banban/connection')
        self.assertEqual(data['source'], 'school')
        self.assertFalse(data['personal']['configured'])
        self.assertEqual(self.feature.config(other)['apiKey'], 'school-key-private-fixture')
        self.assertEqual(self.feature.config(teacher)['apiKey'], self.personal()['apiKey'])
        # Even a superadmin sees only their own personal settings.
        self.cookie, self.csrf = self.admin_cookie, self.admin_csrf
        _, data = await self.json_request('GET', '/api/banban/connection')
        self.assertFalse(data['personal']['configured'])

    async def test_switch_back_to_school_keeps_history_and_own_key_without_fallback(self):
        await self.seed()
        await self.school()
        teacher = await self.login_staff('teacher')
        await self.json_request('PUT', '/api/banban/connection', self.personal(), csrf=True)
        with patch.object(Banban, 'complete', AsyncMock(return_value='当前范围已核对。')):
            await self.json_request('POST', '/api/banban/chat', {'message': '分析晨读', 'scope': self.scope()}, csrf=True)
        # Disabled personal connections use overview, never silently use the school key.
        await self.json_request('PUT', '/api/banban/connection', self.personal(enabled=False, apiKey=''), csrf=True)
        with patch.object(Banban, 'complete', AsyncMock()) as complete:
            _, data = await self.json_request('POST', '/api/banban/chat', {'message': '分析晨读', 'scope': self.scope()}, csrf=True)
            self.assertEqual(data['mode'], 'overview')
            complete.assert_not_called()
        _, before = await self.json_request('GET', '/api/banban/conversation')
        response, _ = await self.json_request('PUT', '/api/banban/connection', {'source': 'school'}, csrf=True)
        self.assertEqual(response.status, 200)
        self.assertEqual(self.feature.config(teacher)['apiKey'], 'school-key-private-fixture')
        _, after = await self.json_request('GET', '/api/banban/conversation')
        self.assertEqual(before, after)
        self.assertEqual(self.feature.connections.own(teacher)[1]['apiKey'], self.personal()['apiKey'])

    async def test_url_change_requires_matching_key_and_cannot_redirect_school_key(self):
        await self.seed()
        await self.school()
        await self.login_staff('teacher')
        response, _ = await self.json_request('PUT', '/api/banban/connection', self.personal(apiKey=''), csrf=True)
        self.assertEqual(response.status, 400)
        await self.json_request('PUT', '/api/banban/connection', self.personal(), csrf=True)
        response, data = await self.json_request('PUT', '/api/banban/connection',
            self.personal(baseUrl='https://another.example.org/v1', apiKey=''), csrf=True)
        self.assertEqual(response.status, 400)
        self.assertIn('重新填写', data['error'])
        response, _ = await self.json_request('PUT', '/api/banban/connection', self.personal(apiKey=''), csrf=True)
        self.assertEqual(response.status, 200)
        self.cookie, self.csrf = self.admin_cookie, self.admin_csrf
        response, _ = await self.json_request('PUT', '/api/banban/settings',
            {'enabled': True, 'model': 'custom-model', 'baseUrl': 'https://new.example.org/v1'}, csrf=True)
        self.assertEqual(response.status, 400)
        self.assertEqual(self.feature.config()['apiKey'], 'school-key-private-fixture')

    async def test_teacher_personal_chat_and_stream_keep_class_scope(self):
        await self.seed()
        teacher = await self.login_staff('teacher')
        await self.json_request('PUT', '/api/banban/connection', self.personal(), csrf=True)
        with patch.object(Banban, 'complete', AsyncMock(return_value='只有本班记录。')) as complete:
            response, _ = await self.json_request('POST', '/api/banban/chat', {'message': '分析晨读', 'scope': self.scope()}, csrf=True)
            self.assertEqual(response.status, 200)
            cfg, messages = complete.call_args.args
            self.assertEqual(cfg['apiKey'], self.personal()['apiKey'])
            self.assertEqual(cfg['baseUrl'], self.personal()['baseUrl'])
            self.assertNotIn('高二班级专属通知', json.dumps(messages, ensure_ascii=False))
            response, _ = await self.json_request('POST', '/api/banban/chat', {'message': '分析', 'scope': self.scope(classId=self.other)}, csrf=True)
            self.assertEqual(response.status, 403)
            self.assertEqual(complete.await_count, 1)
        seen = []
        async def provider(agent, cfg, messages, allow_tools=True):
            seen.append(cfg)
            if allow_tools == 'required':
                yield {'tool_calls': [{'index': 0, 'id': 'fixture-query', 'function': {'name': 'query_data', 'arguments': '{"topic":"reading"}'}}]}
            else:
                yield {'text': '已核对。'}
        with patch.object(BanbanAgent, 'provider', provider):
            response = await self.client.post('/api/banban/chat/stream', json={'message': '帮我看看', 'scope': self.scope()}, headers=self.headers(csrf=True))
            events = [json.loads(line) async for line in response.content if line.strip()]
            self.assertEqual(events[-1]['type'], 'done')
        self.assertEqual(seen[0]['apiKey'], self.personal()['apiKey'])
        self.assertEqual(self.feature.config(teacher)['source'], 'personal')

    async def test_connection_test_uses_owner_config_but_school_admin_target_is_restricted(self):
        await self.seed()
        await self.school()
        await self.login_staff('teacher')
        await self.json_request('PUT', '/api/banban/connection', self.personal(), csrf=True)
        seen = []
        async def provider(agent, cfg, messages, allow_tools=True):
            seen.append((cfg, messages, allow_tools))
            yield {'text': '连接成功'}
        with patch.object(BanbanAgent, 'provider', provider):
            response, _ = await self.json_request('POST', '/api/banban/connection/test', {}, csrf=True)
            self.assertEqual(response.status, 200)
            self.assertEqual(seen[0][0]['apiKey'], self.personal()['apiKey'])
            self.assertEqual(len(seen[0][1]), 1)
            self.assertTrue(seen[0][2])
            response, _ = await self.json_request('POST', '/api/banban/connection/test?target=school', {}, csrf=True)
            self.assertEqual(response.status, 403)
            response, _ = await self.json_request('PUT', '/api/banban/settings', {}, csrf=True)
            self.assertEqual(response.status, 403)
            self.cookie, self.csrf = self.admin_cookie, self.admin_csrf
            response, _ = await self.json_request('POST', '/api/banban/connection/test?target=school', {}, csrf=True)
            self.assertEqual(response.status, 200)
            self.assertEqual(seen[-1][0]['apiKey'], 'school-key-private-fixture')

    async def test_upstream_uses_custom_url_model_and_disallows_redirects(self):
        await self.seed()
        cfg = self.personal()
        raw = json.dumps({'choices': [{'message': {'content': '连接成功。'}}]}).encode()
        async def chunks(_): yield raw
        response = SimpleNamespace(status=200, content_length=None, content=SimpleNamespace(iter_chunked=chunks))
        manager = AsyncMock()
        manager.__aenter__.return_value = response
        post = unittest.mock.Mock(return_value=manager)
        session = AsyncMock()
        session.__aenter__.return_value = SimpleNamespace(post=post)
        with patch('banban.ClientSession', return_value=session):
            await self.feature.complete(cfg, [])
        args, kwargs = post.call_args
        self.assertEqual(args[0], 'https://llm.example.org/compatible/v1/chat/completions')
        self.assertFalse(kwargs['allow_redirects'])
        self.assertEqual(kwargs['json']['model'], cfg['model'])
        self.assertNotIn('thinking', kwargs['json'])
        self.assertEqual(kwargs['headers']['Authorization'], 'Bearer ' + cfg['apiKey'])
        response.status = 302
        with patch('banban.ClientSession', return_value=session), self.assertRaises(ValueError):
            await self.feature.complete(cfg, [])

    async def test_dns_results_reject_private_and_mixed_addresses(self):
        resolver = PublicResolver()
        for addresses in [['127.0.0.1'], ['10.0.0.1'], ['169.254.169.254'], ['::1'], ['::ffff:127.0.0.1'],
                          ['64:ff9b::7f00:1'], ['2002:7f00:1::'], ['8.8.8.8', '192.168.1.2']]:
            with patch.object(resolver.resolver, 'resolve', AsyncMock(return_value=[{'host': address} for address in addresses])):
                with self.assertRaises(ValueError):
                    await resolver.resolve('llm.example.org', 443)
        with patch.object(resolver.resolver, 'resolve', AsyncMock(return_value=[{'host': '8.8.8.8'}])):
            self.assertEqual((await resolver.resolve('llm.example.org', 443))[0]['host'], '8.8.8.8')
        await resolver.close()

    async def test_stream_transport_uses_custom_endpoint_and_standard_payload(self):
        cfg = self.personal()
        async def content():
            for event in [{'choices': [{'delta': {'content': '连接成功'}, 'finish_reason': None}]},
                          {'choices': [{'delta': {}, 'finish_reason': 'stop'}]}]:
                yield ('data: ' + json.dumps(event) + '\n\n').encode()
            yield b'data: [DONE]\n\n'
        response = SimpleNamespace(status=200, content=content())
        manager = AsyncMock()
        manager.__aenter__.return_value = response
        post = unittest.mock.Mock(return_value=manager)
        session = AsyncMock()
        session.__aenter__.return_value = SimpleNamespace(post=post)
        with patch('banban_agent.ClientSession', return_value=session):
            events = [event async for event in self.agent.provider(cfg, [], allow_tools=True)]
        self.assertEqual(events, [{'text': '连接成功'}])
        args, kwargs = post.call_args
        self.assertEqual(args[0], 'https://llm.example.org/compatible/v1/chat/completions')
        self.assertEqual(kwargs['json']['model'], 'vendor/model:latest')
        self.assertIn('tools', kwargs['json'])
        self.assertNotIn('thinking', kwargs['json'])
        self.assertFalse(kwargs['allow_redirects'])

    async def test_domestic_provider_payloads_use_supported_options_without_sending_them_to_other_hosts(self):
        cases = [
            ('https://api.deepseek.com', 'deepseek-flash', 'required', {'thinking': {'type': 'disabled'}}),
            ('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus', 'auto', {'enable_thinking': False}),
            ('https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'qwen-plus', 'auto', {'enable_thinking': False}),
            ('https://open.bigmodel.cn/api/paas/v4', 'glm-4.7', 'auto', {'thinking': {'type': 'disabled'}}),
            ('https://api.moonshot.cn/v1', 'kimi-k2.6', 'auto', {'thinking': {'type': 'disabled'}}),
            ('https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-2-1-pro-260915', 'required', {'thinking': {'type': 'disabled'}}),
            ('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-coder-plus', 'auto', {}),
            ('https://open.bigmodel.cn/api/paas/v4', 'glm-5.3', 'auto', {}),
            ('https://ark.cn-beijing.volces.com/api/v3', 'ep-custom-endpoint', 'required', {}),
            ('https://dashscope.aliyuncs.com.example.org/v1', 'qwen-plus', 'required', {}),
            ('https://open.bigmodel.cn.example.org/v1', 'glm-4.7', 'required', {}),
            ('https://llm.example.org/v1', 'kimi-k2.6', 'required', {}),
        ]
        for base, model, choice, options in cases:
            with self.subTest(base=base):
                async def content():
                    yield b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"read-records","function":{"name":"query_data","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n'
                    yield b'data: [DONE]\n\n'
                response = SimpleNamespace(status=200, content=content())
                manager = AsyncMock()
                manager.__aenter__.return_value = response
                post = unittest.mock.Mock(return_value=manager)
                session = AsyncMock()
                session.__aenter__.return_value = SimpleNamespace(post=post)
                messages = [{'role': 'user', 'content': '分析晨读'}]
                with patch('banban_agent.ClientSession', return_value=session):
                    events = [event async for event in self.agent.provider({**self.personal(), 'baseUrl': base, 'model': model}, messages, allow_tools='required')]
                payload = post.call_args.kwargs['json']
                self.assertEqual(payload['tool_choice'], choice)
                self.assertEqual({key: payload[key] for key in ('thinking', 'enable_thinking') if key in payload}, options)
                self.assertEqual(payload['messages'][-1], messages[-1])
                if choice == 'auto':
                    self.assertIn('必须先调用', payload['messages'][0]['content'])
                self.assertEqual(messages, [{'role': 'user', 'content': '分析晨读'}])
                self.assertEqual(events[0]['tool_calls'][0]['function']['name'], 'query_data')

    async def test_auto_only_provider_cannot_answer_a_data_question_without_reading_records(self):
        await self.seed()
        await self.school()
        await self.login_staff('teacher')
        await self.json_request('PUT', '/api/banban/connection', self.personal(baseUrl='https://dashscope.aliyuncs.com/compatible-mode/v1', model='qwen-plus'), csrf=True)
        async def provider(agent, cfg, messages, allow_tools=True):
            yield {'text': '未查询记录而编写的成绩。'}
        with patch.object(BanbanAgent, 'provider', provider):
            response = await self.client.post('/api/banban/chat/stream', json={'message': '分析本班晨读', 'scope': self.scope()}, headers=self.headers(csrf=True))
            events = [json.loads(line) async for line in response.content if line.strip()]
        self.assertEqual(events[-1]['type'], 'error')
        self.assertFalse(any(event['type'] == 'delta' for event in events))


class AddressTest(unittest.TestCase):
    def test_public_https_base_paths_are_preserved_and_full_endpoint_is_normalized(self):
        self.assertEqual(normalize_base_url('https://API.EXAMPLE.ORG:443/compatible/v1/'), 'https://api.example.org/compatible/v1')
        self.assertEqual(normalize_base_url('https://api.example.org/v1/chat/completions/'), 'https://api.example.org/v1')
        self.assertEqual(completion_url({'baseUrl': 'https://api.example.org/v1'}), 'https://api.example.org/v1/chat/completions')
        self.assertEqual(provider_options({'baseUrl': 'https://api.example.org/v1'}), {})

    def test_private_http_credential_and_invalid_addresses_are_rejected(self):
        for address in ['http://api.example.org/v1', 'https://localhost/v1', 'https://127.0.0.1/v1',
                        'https://10.0.0.2', 'https://169.254.169.254', 'https://[::1]',
                        'https://u:secret@api.example.org/v1', 'https://api.example.org/v1?key=secret',
                        'https://api.example.org/v1#fragment', 'https://api.example.org\\@localhost',
                        'https://host.local/v1', 'https://api.example.org:99999/v1']:
            with self.subTest(address=address), self.assertRaises(ValueError):
                normalize_base_url(address)

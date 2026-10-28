import asyncio
import json
import time
from unittest.mock import patch

import app as service
from banban_operations import KEY
from banban_agent import BanbanAgent
from test_app import ServerTestCase
import test_banban as fixtures


class OperationTest(ServerTestCase):
    seed = fixtures.BanbanTest.seed
    voice = fixtures.BanbanTest.voice
    shout = fixtures.BanbanTest.shout
    scope = fixtures.BanbanTest.scope
    login_staff = fixtures.BanbanTest.login_staff

    async def setup_device(self):
        self.device = await self.enroll_test_device()
        self.db = self.app[service.STORE_KEY]
        self.ops = self.app[KEY]
        self.cid = self.device['classId']

    async def socket(self, device=None):
        device = device or self.device
        ws = await self.client.ws_connect('/ws/device?deviceId=' + device['deviceId'],
                                         headers={'Authorization': 'Bearer ' + device['deviceToken']})
        await ws.receive_json()
        await ws.send_json({'type': 'device_status', 'capabilities': ['reading', 'volume', 'agent_control_v1'], 'version': '2.4.0', 'outputVolume': 40})
        await ws.send_json({'type': 'heartbeat'})
        await ws.receive_json()
        return ws

    async def create(self, kind, args, key=None):
        return await self.json_request('POST', '/api/banban/operations',
            {'kind': kind, 'args': args, **({'requestKey': key} if key else {})}, csrf=True)

    async def platform(self, operation, payload=None, **target):
        return await self.create('platform', {'operation': operation, 'payload': payload or {}, **target})

    async def computer(self, action='inspect', **args):
        return await self.create('computer', {'action': action, 'classId': self.cid, 'deviceId': self.device['deviceId'], **args})

    async def confirm(self, operation, **body):
        return await self.json_request('POST', f"/api/banban/operations/{operation['id']}/confirm", {'confirmed': True, **body}, csrf=True)

    async def get(self, operation):
        return (await self.json_request('GET', '/api/banban/operations/' + operation['id']))[1]

    async def ack(self, ws, command, verified=True, **extra):
        await ws.send_json({'type': 'device_command_ack', 'action': 'agent_control', 'commandId': command['commandId'],
                            'success': True, 'result': {'verified': verified, 'detail': '设备实际回报', **extra}})
        await ws.send_json({'type': 'heartbeat'})
        await ws.receive_json()

    async def prime_window(self, ws):
        _, operation = await self.computer()
        command = await ws.receive_json()
        await self.ack(ws, command, windows=[{'id':'window-one', 'title':'测试课件窗口'}])
        return operation

    async def test_live_agent_continues_immediately_after_device_receipt(self):
        await self.setup_device()
        ws = await self.socket()
        await self.json_request('PUT', '/api/banban/settings', {
            'enabled': True, 'model': 'fixture', 'apiKey': 'fixture-only'}, csrf=True)

        async def provider(agent, cfg, messages, allow_tools=True):
            if messages[-1]['role'] == 'user':
                yield {'tool_calls': [{'index': 0, 'id': 'inspect-once', 'function': {
                    'name': 'operate_computer', 'arguments': json.dumps({
                        'action': 'inspect', 'deviceId': self.device['deviceId'], 'classId': self.cid})}}]}
            else:
                yield {'text': '窗口已核对。'}

        async def read(response):
            return [json.loads(line) async for line in response.content if line.strip()]

        try:
            with patch.object(BanbanAgent, 'provider', provider):
                response = await self.client.post('/api/banban/chat/stream', json={
                    'message': '查看这台电脑允许的窗口', 'voice': {'mode': 'voice'}}, headers=self.headers(csrf=True))
                reading = asyncio.create_task(read(response))
                command = await ws.receive_json()
                await asyncio.sleep(.03)  # Let the actual waiter enter its wait.
                received_at = time.perf_counter()
                await self.ack(ws, command, windows=[])
                events = await reading
                elapsed = time.perf_counter() - received_at
                self.assertEqual(events[-1]['type'], 'done', events)
                self.assertLess(elapsed, .2, 'an acknowledged action must not wait for the next 300 ms poll')
        finally:
            await ws.close()

    async def exercise_voice_operation(self, action, **parameters):
        await self.setup_device()
        ws = await self.socket()
        await self.computer()
        await self.ack(ws, await ws.receive_json(),
            applications=[{'id': 'wps-slides', 'name': 'WPS 演示', 'kind': 'wps-presentation'},
                          {'id': 'wps-writer', 'name': 'WPS 文字', 'kind': 'wps-writer'}],
            windows=[{'id': 'window-one', 'title': '验收窗口'}], targetId='window-one',
            controls=[{'id': 'text-one', 'name': '验收文字', 'actions': ['set_control_value']}])
        await self.json_request('PUT', '/api/banban/settings',
            {'enabled': True, 'model': 'test-model', 'apiKey': 'fixture-only'}, csrf=True)
        received = []
        async def provider(agent, cfg, messages, allow_tools=True):
            if messages[-1]['role'] == 'user':
                yield {'tool_calls': [{'index': 0, 'id': 'voice-task', 'function': {
                    'name': 'operate_computer', 'arguments': json.dumps({
                        'action': action, 'deviceId': self.device['deviceId'], 'classId': self.cid, **parameters})}}]}
            else:
                yield {'text': '操作结果已收到。'}
        async def receiver():
            command = await ws.receive_json()
            received.append(command)
            await self.ack(ws, command)
        receiver_task = asyncio.create_task(receiver())
        events = []
        try:
            with patch.object(BanbanAgent, 'provider', provider):
                response = await self.client.post('/api/banban/chat/stream', json={
                    'message': '按我的要求执行这项电脑操作',
                    'voice': {'mode': 'voice', 'deviceId': self.device['deviceId'], 'classId': self.cid}},
                    headers=self.headers(csrf=True))
                async for line in response.content:
                    if not line.strip():
                        continue
                    event = json.loads(line)
                    events.append(event)
                    # End the old confirmation path so a regression fails
                    # promptly rather than waiting for the human's microphone.
                    if event['type'] == 'operation' and event['operation']['status'] == 'awaiting_confirmation':
                        await self.json_request('POST', '/api/banban/operations/' + event['operation']['id'] + '/cancel', {}, csrf=True)
            self.assertFalse(any(e['type'] == 'confirmation' for e in events), events)
            self.assertEqual([c['parameters']['action'] for c in received], [action])
            operations = [e['operation'] for e in events if e['type'] == 'operation']
            self.assertEqual(operations[-1]['status'], 'succeeded', events)
        finally:
            receiver_task.cancel()
            await asyncio.gather(receiver_task, return_exceptions=True)
            await ws.close()

    async def test_voice_creation_runs_without_an_extra_confirmation(self):
        await self.exercise_voice_operation('create_presentation', appId='wps-slides', text='验收')

    async def test_voice_word_creation_runs_without_an_extra_confirmation(self):
        await self.exercise_voice_operation('create_document', appId='wps-writer', text='窗前一束光，照亮求知路。')

    async def test_voice_filling_runs_without_an_extra_confirmation(self):
        await self.exercise_voice_operation('set_control_value', targetId='window-one', controlId='text-one', text='验收')

    async def test_voice_close_runs_without_an_extra_confirmation(self):
        await self.exercise_voice_operation('close_window', targetId='window-one')

    async def test_voice_business_operation_runs_without_an_extra_confirmation(self):
        await self.setup_device()
        await self.json_request('PUT', '/api/banban/settings',
            {'enabled': True, 'model': 'test-model', 'apiKey': 'fixture-only'}, csrf=True)
        async def provider(agent, cfg, messages, allow_tools=True):
            if messages[-1]['role'] == 'user':
                yield {'tool_calls': [{'index': 0, 'id': 'voice-create-class', 'function': {
                    'name': 'operate_platform', 'arguments': json.dumps({
                        'operation': 'class.create', 'payload': {'name': '语音直接创建验收班'}})}}]}
            else:
                yield {'text': '操作结果已收到。'}
        events = []
        with patch.object(BanbanAgent, 'provider', provider):
            response = await self.client.post('/api/banban/chat/stream', json={
                'message': '创建语音直接创建验收班', 'voice': {'mode': 'voice'}}, headers=self.headers(csrf=True))
            async for line in response.content:
                event = json.loads(line)
                events.append(event)
                if event['type'] == 'operation' and event['operation']['status'] == 'awaiting_confirmation':
                    await self.json_request('POST', '/api/banban/operations/' + event['operation']['id'] + '/cancel', {}, csrf=True)
        self.assertFalse(any(e['type'] == 'confirmation' for e in events), events)
        self.assertTrue(self.db.one('SELECT id FROM classes WHERE name=?', ('语音直接创建验收班',)))

    async def test_operation_api_cannot_claim_voice_authorization(self):
        await self.setup_device()
        response, _ = await self.json_request('POST', '/api/banban/operations', {
            'kind': 'platform', 'args': {'operation': 'class.create', 'payload': {'name': '不应创建'}},
            'voiceRequested': True}, csrf=True)
        self.assertEqual(response.status, 400)
        self.assertFalse(self.db.one('SELECT id FROM classes WHERE name=?', ('不应创建',)))

    async def test_auth_csrf_and_invalid_parameters(self):
        response, _ = await self.json_request('GET', '/api/banban/operations/catalog')
        self.assertEqual(response.status, 401)
        await self.setup_device()
        response, _ = await self.json_request('POST', '/api/banban/operations', {})
        self.assertEqual(response.status, 403)
        for kind, args in [('computer', []), ('unknown', {}), ('platform', {'operation': 'execute_sql'}),
            ('platform', {'operation': 'user.password', 'username': {}, 'payload': {}}),
            ('platform', {'operation': 'class.create', 'payload': {'name': '班级', 'sql': 'bad'}}),
            ('computer', {'action': 'set_volume', 'classId': self.cid, 'volume': True}),
            ('computer', {'action': 'shell', 'command': 'whoami'})]:
            response, _ = await self.create(kind, args)
            self.assertIn(response.status, (400, 403), (kind, args))

    async def test_business_confirmation_and_request_deduplication(self):
        await self.setup_device()
        args = {'operation': 'class.create', 'payload': {'name': '高三（8）班'}}
        _, operation = await self.create('platform', args, 'same-request')
        self.assertEqual(operation['status'], 'awaiting_confirmation')
        self.assertFalse(self.db.one('SELECT id FROM classes WHERE name=?', ('高三（8）班',)))
        _, repeated = await self.create('platform', args, 'same-request')
        self.assertEqual(repeated['id'], operation['id'])
        response, _ = await self.create('platform', {**args, 'payload': {'name': '高三（9）班'}}, 'same-request')
        self.assertEqual(response.status, 400)
        _, done = await self.confirm(operation)
        self.assertEqual(done['status'], 'succeeded', done)
        _, again = await self.confirm(operation)
        self.assertEqual(again['status'], 'succeeded')
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM classes WHERE name=?', ('高三（8）班',))['n'], 1)

    async def test_password_only_enters_confirmation_not_model_or_history(self):
        await self.setup_device()
        _, operation = await self.platform('user.create', {'username': 'agentteacher', 'displayName': '测试教师', 'role': 'teacher', 'classIds': [self.cid]})
        self.assertTrue(operation['needsPassword'])
        response, _ = await self.confirm(operation, password='short')
        self.assertEqual(response.status, 400)
        self.assertEqual((await self.get(operation))['status'], 'awaiting_confirmation')
        _, done = await self.confirm(operation, password='AgentPassword123')
        self.assertEqual(done['status'], 'succeeded', done)
        stored = self.db.one('SELECT args,result FROM banban_operations WHERE id=?', (operation['id'],))
        self.assertNotIn('AgentPassword123', json.dumps(stored))
        self.assertNotIn('password', json.dumps(done))
        response, _ = await self.platform('user.create', {'username': 'otheruser', 'password': 'NeverSendPassword123'})
        self.assertEqual(response.status, 400)

    async def test_changed_configuration_and_expired_confirmation_are_rejected(self):
        await self.setup_device()
        _, operation = await self.platform('class.update', {'name': '高一（7）班'}, classId=self.cid)
        await self.json_request('PATCH', '/api/classes/' + self.cid, {'name': '高一（9）班'}, csrf=True)
        _, done = await self.confirm(operation)
        self.assertEqual(done['status'], 'failed')
        self.assertEqual(self.db.one('SELECT name FROM classes WHERE id=?', (self.cid,))['name'], '高一（9）班')
        _, operation = await self.platform('class.update', {'name': '高一（8）班'}, classId=self.cid)
        self.db.run('UPDATE banban_operations SET expires_at=0 WHERE id=?', (operation['id'],))
        _, expired = await self.confirm(operation)
        self.assertEqual(expired['status'], 'expired')

    async def test_quiet_and_reading_settings_reuse_real_validation(self):
        await self.setup_device()
        _, operation = await self.platform('quiet.update', {'periods': [{'name':'上课', 'weekdays':[1], 'startTime':'08:00', 'endTime':'08:40'}]})
        _, done = await self.confirm(operation)
        self.assertEqual(done['status'], 'succeeded', done)
        self.assertEqual(service.quiet_period_rows(self.db)[0]['name'], '上课')
        previous = self.app[service.ROOMS_KEY].reading.config()
        _, operation = await self.platform('reading.update', {'enabled': True, 'threshold': 52, 'periods': [{'weekdays':[1], 'start':450, 'end':500}]})
        _, done = await self.confirm(operation)
        self.assertEqual(done['status'], 'succeeded', done)
        self.assertEqual(self.app[service.ROOMS_KEY].reading.config()['threshold'], 52)
        _, invalid = await self.platform('reading.update', {'threshold': 5000})
        _, failed = await self.confirm(invalid)
        self.assertEqual(failed['status'], 'failed')
        self.assertEqual(self.app[service.ROOMS_KEY].reading.config()['threshold'], 52)

    async def test_class_deletion_returns_its_actual_result(self):
        await self.setup_device()
        _, created = await self.json_request('POST', '/api/classes', {'name': '高三（9）班'}, csrf=True)
        _, operation = await self.platform('class.delete', classId=created['id'])
        _, done = await self.confirm(operation)
        self.assertEqual(done['status'], 'succeeded', done)
        self.assertFalse(self.db.one('SELECT id FROM classes WHERE id=?', (created['id'],)))
        self.assertEqual((await self.get(operation))['status'], 'succeeded')

    async def test_teacher_cannot_escalate_business_or_device_scope(self):
        await self.seed()
        self.ops = self.app[KEY]
        await self.login_staff('teacher')
        _, catalog = await self.json_request('GET', '/api/banban/operations/catalog')
        self.assertFalse(any(a['id'].startswith('user.') or a['id'].startswith('class.') for a in catalog['business']))
        response, _ = await self.platform('class.create', {'name':'高一（7）班'})
        self.assertEqual(response.status, 403)
        response, _ = await self.create('computer', {'action': 'inspect', 'classId': self.other})
        self.assertEqual(response.status, 403)
        response, _ = await self.platform('notice.send', {'text':'不应发送'}, classId=self.other)
        self.assertEqual(response.status, 403)

    async def test_offline_and_old_clients_never_receive_queued_commands(self):
        await self.setup_device()
        response, data = await self.computer()
        self.assertEqual(response.status, 400)
        self.assertIn('离线', data['error'])
        ws = await self.client.ws_connect('/ws/device?deviceId=' + self.device['deviceId'], headers={'Authorization':'Bearer ' + self.device['deviceToken']})
        await ws.receive_json()
        response, data = await self.computer()
        self.assertEqual(response.status, 400)
        self.assertIn('新版', data['error'])
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM banban_operations')['n'], 0)
        await ws.close()

    async def test_device_ack_is_authenticated_scoped_and_explicit(self):
        await self.setup_device()
        ws = await self.socket()
        _, operation = await self.computer()
        self.assertEqual(operation['status'], 'running')
        command = await ws.receive_json()
        self.assertEqual(command['deviceId'], self.device['deviceId'])
        self.assertEqual(command['classId'], self.cid)
        self.assertLessEqual(command['expiresAt'] - command['issuedAt'], 30000)
        self.ops.acknowledge('another-device', self.cid, {'action':'agent_control', 'commandId': operation['id'], 'success':True, 'result':{'verified':True}})
        self.assertEqual((await self.get(operation))['status'], 'running')
        await self.ack(ws, command, windows=[{'id':'window-one', 'title':'课件'}])
        done = await self.get(operation)
        self.assertEqual(done['status'], 'succeeded')
        self.assertEqual(done['result']['windows'][0]['title'], '课件')
        await ws.close()

    async def test_keystrokes_and_missing_verification_are_not_reported_as_success(self):
        await self.setup_device()
        ws = await self.socket()
        await self.prime_window(ws)
        _, operation = await self.computer('presentation_next', targetId='window-one')
        command = await ws.receive_json()
        await self.ack(ws, command, verified=False)
        self.assertEqual((await self.get(operation))['status'], 'unconfirmed')
        await self.ack(ws, command, verified=True)
        self.assertEqual((await self.get(operation))['status'], 'succeeded')
        _, second = await self.computer()
        command = await ws.receive_json()
        await ws.send_json({'type':'device_command_ack','action':'agent_control','commandId':command['commandId'],'success':True})
        await ws.send_json({'type':'heartbeat'}); await ws.receive_json()
        self.assertEqual((await self.get(second))['status'], 'unconfirmed')
        await ws.close()

    async def test_open_app_only_succeeds_when_its_actual_window_is_observed(self):
        await self.setup_device()
        ws = await self.socket()
        _, inspection = await self.computer()
        await self.ack(ws, await ws.receive_json(), applications=[{'id':'allowed-app','name':'PowerPoint'}])
        _, operation = await self.computer('open_app', appId='allowed-app')
        await self.ack(ws, await ws.receive_json(), verified=False,
                       windows=[{'id':'actual-window','appId':'allowed-app','title':'PowerPoint'}])
        self.assertEqual((await self.get(operation))['status'], 'succeeded')
        await ws.close()

    async def test_create_presentation_needs_observed_presentation_app_text_and_confirmation(self):
        await self.setup_device()
        ws = await self.socket()
        _, inspection = await self.computer()
        await self.ack(ws, await ws.receive_json(), applications=[
            {'id': 'wps-slides', 'name': 'WPS 演示', 'kind': 'wps-presentation'},
            {'id': 'writer', 'name': 'WPS 文字', 'kind': 'wps-writer'}])
        for args in [{}, {'appId': 'wps-slides'}, {'appId': 'wps-slides', 'text': '  '},
                     {'appId': 'invented', 'text': '这是测试文件'},
                     {'appId': 'writer', 'text': '这是测试文件'}]:
            response, _ = await self.computer('create_presentation', **args)
            self.assertEqual(response.status, 400)
        response, operation = await self.computer('create_presentation', appId='wps-slides', text='这是测试文件')
        self.assertEqual(response.status, 200)
        self.assertEqual(operation['status'], 'awaiting_confirmation')
        self.assertEqual(operation['parameters']['text'], '这是测试文件')
        await self.confirm(operation)
        command = await ws.receive_json()
        self.assertEqual(command['parameters']['action'], 'create_presentation')
        self.assertEqual(command['parameters']['text'], '这是测试文件')
        await self.ack(ws, command, text='这是测试文件', slideCount=1, saved=False)
        self.assertEqual((await self.get(operation))['status'], 'succeeded')
        await ws.close()

    async def test_create_document_needs_an_observed_writer_and_preserves_optional_text(self):
        await self.setup_device()
        ws = await self.socket()
        await self.computer()
        await self.ack(ws, await ws.receive_json(), applications=[
            {'id': 'writer', 'name': 'WPS 文字', 'kind': 'wps-writer'},
            {'id': 'word', 'name': 'Word', 'kind': 'word'},
            {'id': 'slides', 'name': 'WPS 演示', 'kind': 'wps-presentation'}])
        for args in [{}, {'appId': 'invented'}, {'appId': 'slides'}, {'appId': 'writer', 'text': 1}]:
            response, _ = await self.computer('create_document', **args)
            self.assertEqual(response.status, 400)
        for app_id, parameters in [('writer', {'text': '窗前一束光，\n照亮求知路。'}), ('word', {}), ('writer', {'text': ''})]:
            response, operation = await self.computer('create_document', appId=app_id, **parameters)
            self.assertEqual(response.status, 200)
            self.assertEqual(operation['status'], 'awaiting_confirmation')
            await self.confirm(operation)
            command = await ws.receive_json()
            self.assertEqual(command['parameters']['action'], 'create_document')
            self.assertEqual(command['parameters'].get('text', ''), parameters.get('text', ''))
            await self.ack(ws, command, document='新建文稿', text=parameters.get('text', ''), saved=False)
            self.assertEqual((await self.get(operation))['status'], 'succeeded')
        await ws.close()

    async def test_later_inspection_finishes_only_the_matching_application_launch(self):
        await self.setup_device()
        ws = await self.socket()
        await self.computer()
        await self.ack(ws, await ws.receive_json(), applications=[{'id':'allowed-browser','name':'Edge'}])
        _, launch = await self.computer('open_app', appId='allowed-browser')
        await self.ack(ws, await ws.receive_json(), verified=False, windows=[])
        self.assertEqual((await self.get(launch))['status'], 'unconfirmed')
        _, website = await self.computer('open_website', appId='allowed-browser', url='https://example.org')
        await self.ack(ws, await ws.receive_json(), verified=False, windows=[])
        for verified, app_id in [(True, 'other-app'), (False, 'allowed-browser'), (True, 'allowed-browser')]:
            await self.computer()
            await self.ack(ws, await ws.receive_json(), verified=verified,
                           windows=[{'id':'actual-window','appId':app_id,'title':'Edge'}])
            self.assertEqual((await self.get(launch))['status'], 'succeeded' if verified and app_id == 'allowed-browser' else 'unconfirmed')
            self.assertEqual((await self.get(website))['status'], 'unconfirmed')
        await ws.close()

    async def test_manual_cancellation_reaches_the_same_device(self):
        await self.setup_device()
        ws = await self.socket()
        await self.prime_window(ws)
        _, pending = await self.computer('close_window', targetId='window-one')
        self.assertEqual(pending['status'], 'awaiting_confirmation')
        _, cancelled = await self.json_request('POST', '/api/banban/operations/' + pending['id'] + '/cancel', {}, csrf=True)
        self.assertEqual(cancelled['status'], 'cancelled')
        _, running = await self.computer()
        command = await ws.receive_json()
        _, stopping = await self.json_request('POST', '/api/banban/operations/' + running['id'] + '/cancel', {}, csrf=True)
        self.assertEqual(stopping['status'], 'stopping')
        stop = await ws.receive_json()
        self.assertEqual(stop['parameters']['operationId'], running['id'])
        await ws.send_json({'type':'device_command_ack','action':'agent_control','commandId':command['commandId'],'success':False,'cancelled':True,'result':{'verified':False}})
        await ws.send_json({'type':'heartbeat'}); await ws.receive_json()
        self.assertEqual((await self.get(running))['status'], 'cancelled')
        await ws.close()

    async def test_confirmation_rechecks_device_binding_and_permissions(self):
        await self.setup_device()
        ws = await self.socket()
        await self.prime_window(ws)
        _, pending = await self.computer('close_window', targetId='window-one')
        _, other = await self.json_request('POST','/api/classes',{'name':'高二（2）班'},csrf=True)
        self.db.run('UPDATE devices SET class_id=? WHERE id=?', (other['id'], self.device['deviceId']))
        response, _ = await self.confirm(pending)
        self.assertEqual(response.status, 403)
        await ws.close()

    async def test_notice_only_succeeds_after_display_receipt(self):
        await self.setup_device()
        ws = await self.socket()
        with patch.object(service, 'active_quiet_period', return_value=None):
            _, operation = await self.platform('notice.send', {'text':'请带好课本', 'alertLevel':'info'}, classId=self.cid)
        self.assertEqual(operation['status'], 'unconfirmed', operation)
        payload = await ws.receive_json()
        await ws.send_json({'type':'ack','message_id':payload['message_id'],'status':'displayed'})
        await ws.send_json({'type':'heartbeat'}); await ws.receive_json()
        self.assertEqual((await self.get(operation))['status'], 'succeeded')
        await ws.close()

    async def test_agent_calls_business_tool_and_emits_a_reviewable_action(self):
        await self.seed()
        await self.json_request('PUT', '/api/banban/settings', {'enabled':True,'model':'test-model','apiKey':'sk-test-key'}, csrf=True)
        async def provider(agent, cfg, messages, allow_tools=True):
            if messages[-1]['role'] == 'user':
                yield {'tool_calls':[{'index':0,'id':'create-class','function':{'name':'operate_platform','arguments':json.dumps({'operation':'class.create','payload':{'name':'高三（6）班'}})}}]}
            else:
                self.assertEqual(json.loads(messages[-1]['content']).get('status'), 'succeeded', messages[-1]['content'])
                yield {'text':'已创建高三（6）班。'}
        with patch.object(BanbanAgent, 'provider', provider):
            response = await self.client.post('/api/banban/chat/stream', json={'message':'创建高三（6）班','scope':self.scope()}, headers=self.headers(csrf=True))
            events = []
            async for line in response.content:
                if not line.strip():
                    continue
                event = json.loads(line)
                events.append(event)
                if event['type'] == 'operation' and event['operation']['status'] == 'awaiting_confirmation':
                    self.assertFalse(self.db.one('SELECT id FROM classes WHERE name=?', ('高三（6）班',)))
                    _, confirmed = await self.confirm(event['operation'])
                    self.assertEqual(confirmed['status'], 'succeeded')
        self.assertEqual(events[-1]['type'], 'done', events)
        action = next(e['operation'] for e in events if e['type']=='operation')
        self.assertEqual(action['status'], 'awaiting_confirmation')
        self.assertEqual(events[-1]['message']['operations'][0]['id'], action['id'])
        self.assertTrue(self.db.one('SELECT id FROM classes WHERE name=?', ('高三（6）班',)))
        self.assertTrue(any(e['type'] == 'confirmation' and e['waiting'] for e in events))
        self.assertTrue(any(e['type'] == 'confirmation' and not e['waiting'] for e in events))

    async def test_cancelled_confirmation_cannot_trigger_a_following_write(self):
        await self.seed()
        await self.json_request('PUT', '/api/banban/settings', {'enabled':True,'model':'test-model','apiKey':'sk-test-key'}, csrf=True)
        round_number = 0
        async def provider(agent, cfg, messages, allow_tools=True):
            nonlocal round_number
            round_number += 1
            if round_number <= 2:
                yield {'tool_calls':[{'index':0,'id':str(round_number),'function':{'name':'operate_platform','arguments':json.dumps({'operation':'class.create','payload':{'name':f'高三（{round_number + 5}）班'}})}}]}
            else:
                self.assertIn('error', json.loads(messages[-1]['content']))
                yield {'text':'已取消，没有创建班级。'}
        with patch.object(BanbanAgent, 'provider', provider):
            response = await self.client.post('/api/banban/chat/stream', json={'message':'创建高三（6）班','scope':self.scope()}, headers=self.headers(csrf=True))
            async for line in response.content:
                event = json.loads(line)
                if event['type'] == 'operation' and event['operation']['status'] == 'awaiting_confirmation':
                    await self.json_request('POST', '/api/banban/operations/' + event['operation']['id'] + '/cancel', {}, csrf=True)
        self.assertFalse(self.db.one('SELECT id FROM classes WHERE name IN (?,?)', ('高三（6）班','高三（7）班')))

    async def test_discovery_stays_behind_the_conversation_and_only_the_action_is_saved(self):
        await self.seed()
        ws = await self.socket()
        await self.json_request('PUT', '/api/banban/settings', {'enabled':True,'model':'test-model','apiKey':'sk-test-key'}, csrf=True)
        round_number = 0
        async def provider(agent, cfg, messages, allow_tools=True):
            nonlocal round_number
            round_number += 1
            if round_number < 3:
                args = {'action':'inspect' if round_number == 1 else 'set_volume','classId':self.cid,'deviceId':self.device['deviceId']}
                if round_number == 2:
                    args['volume'] = 35
                yield {'tool_calls':[{'index':0,'id':str(round_number),'function':{'name':'operate_computer','arguments':json.dumps(args)}}]}
            else:
                yield {'text':'已将音量调整为 35。'}
        async def receiver():
            for _ in range(2):
                command = await ws.receive_json()
                await ws.send_json({'type':'device_command_ack','action':'agent_control','commandId':command['commandId'],
                                    'success':True,'result':{'verified':True,'outputVolume':35}})
        device = asyncio.create_task(receiver())
        try:
            with patch.object(BanbanAgent, 'provider', provider):
                response = await self.client.post('/api/banban/chat/stream', json={'message':'调整电脑音量','scope':self.scope()}, headers=self.headers(csrf=True))
                events = [json.loads(line) async for line in response.content if line.strip()]
            await device
            self.assertEqual(events[-1]['type'], 'done', events)
            self.assertEqual({e['operation']['action'] for e in events if e['type'] == 'operation'}, {'set_volume'})
            self.assertEqual(len(events[-1]['message']['operations']), 1)
        finally:
            device.cancel()
            await ws.close()

    async def test_unknown_stale_and_wrong_window_controls_are_rejected(self):
        await self.setup_device()
        ws = await self.socket()
        for action, args in [('close_window', {}), ('open_app', {}), ('open_file', {}),
                             ('open_app', {'appId':'invented'}), ('focus_window', {'targetId':'invented'})]:
            response, _ = await self.computer(action, **args)
            self.assertEqual(response.status, 400, action)
        inspect = await self.prime_window(ws)
        _, controls = await self.computer('inspect_controls', targetId='window-one')
        command = await ws.receive_json()
        await self.ack(ws, command, targetId='window-one', controls=[{'id':'control-one','name':'标题'}])
        response, _ = await self.computer('invoke_control', targetId='window-two', controlId='control-one')
        self.assertEqual(response.status, 400)
        _, pending = await self.computer('invoke_control', targetId='window-one', controlId='control-one')
        self.assertEqual(pending['status'], 'awaiting_confirmation')
        self.db.run('UPDATE banban_operations SET updated_at=0 WHERE id IN (?,?)', (inspect['id'], controls['id']))
        response, _ = await self.computer('inspect_controls', targetId='window-one')
        self.assertEqual(response.status, 400)
        await ws.close()

    async def test_generic_controls_validate_targets_and_action_parameters(self):
        await self.setup_device()
        ws = await self.socket()
        await self.prime_window(ws)
        _, controls = await self.computer('inspect_controls', targetId='window-one')
        command = await ws.receive_json()
        await self.ack(ws, command, targetId='window-one', controls=[{'id': 'control-one', 'name': '课堂记录'}])
        for action, args in [
            ('set_control_toggle', {'checked': 'yes'}), ('set_control_range', {'value': True}),
            ('set_control_range', {'value': float('inf')}), ('scroll_control', {'direction': 'unknown'}),
            ('press_control_key', {'key': 'win+r'}), ('wait_for_control', {'query': ''})]:
            response, _ = await self.computer(action, targetId='window-one', controlId='control-one', **args)
            self.assertEqual(response.status, 400, action)
        response, operation = await self.computer('scroll_control', targetId='window-one', controlId='control-one', direction='down')
        self.assertEqual(response.status, 200)
        self.assertEqual(operation['status'], 'running')
        command = await ws.receive_json()
        self.assertEqual(command['parameters']['direction'], 'down')
        await self.ack(ws, command, targetId='window-one', controls=[{'id': 'control-one', 'name': '课堂记录', 'verticalScroll': 50}])
        self.assertEqual((await self.get(operation))['status'], 'succeeded')
        response, wait = await self.computer('wait_for_control', targetId='window-one', query='课程已保存')
        self.assertEqual(response.status, 200)
        self.assertEqual(wait['status'], 'running')
        command = await ws.receive_json()
        await self.ack(ws, command, targetId='window-one', controls=[{'id': 'status', 'name': '课程已保存'}])
        self.assertEqual((await self.get(wait))['status'], 'succeeded')
        response, pending = await self.computer('set_control_toggle', targetId='window-one', controlId='status', checked=True)
        self.assertEqual(response.status, 200)
        self.assertEqual(pending['status'], 'awaiting_confirmation')
        await ws.close()

    async def test_large_authenticated_computer_snapshot_is_not_silently_dropped(self):
        await self.setup_device()
        ws = await self.socket()
        await self.prime_window(ws)
        _, operation = await self.computer('inspect_controls', targetId='window-one')
        command = await ws.receive_json()
        controls = [{'id': 'field-' + str(i), 'name': '课堂资料' + str(i), 'value': '教学内容' * 30} for i in range(24)]
        self.assertGreater(len(json.dumps(controls)), 4096)
        await self.ack(ws, command, targetId='window-one', controls=controls)
        done = await self.get(operation)
        self.assertEqual(done['status'], 'succeeded')
        self.assertEqual(done['result']['controls'], controls)
        await ws.close()

    async def test_commands_target_one_device_and_overlapping_sockets_are_rejected(self):
        await self.setup_device()
        _, code = await self.json_request('POST', f'/api/classes/{self.cid}/enrollment-code', {}, csrf=True)
        _, other = await self.json_request('POST', '/api/device/enroll', {'code':code['code'],'deviceName':'第二台白板'})
        first, second = await self.socket(), await self.socket(other)
        await self.computer()
        command = await first.receive_json()
        self.assertEqual(command['deviceId'], self.device['deviceId'])
        await second.send_json({'type':'heartbeat'})
        self.assertEqual((await second.receive_json())['type'], 'heartbeat_ack')
        await self.ack(first, command)
        duplicate = await self.socket()
        response, operation = await self.computer()
        self.assertEqual(response.status, 200)
        self.assertEqual(operation['status'], 'failed')
        self.assertIn('切换', operation['result']['detail'])
        self.assertFalse(self.ops.events)
        await duplicate.close(); await first.close(); await second.close()

    async def test_manual_timeout_does_not_replay_and_late_receipt_remains_truthful(self):
        await self.setup_device()
        ws = await self.socket()
        _, operation = await self.computer()
        command = await ws.receive_json()
        self.db.run('UPDATE banban_operations SET updated_at=0 WHERE id=?', (operation['id'],))
        self.assertEqual((await self.get(operation))['status'], 'unconfirmed')
        self.assertFalse(self.ops.events)
        await ws.send_json({'type':'heartbeat'})
        self.assertEqual((await ws.receive_json())['type'], 'heartbeat_ack')
        await self.ack(ws, command, verified=True)
        self.assertEqual((await self.get(operation))['status'], 'succeeded')
        await ws.close()

    async def test_model_repeated_tool_call_is_only_prepared_once(self):
        await self.seed()
        await self.json_request('PUT', '/api/banban/settings', {'enabled':True,'model':'test-model','apiKey':'sk-test-key'}, csrf=True)
        async def provider(agent, cfg, messages, allow_tools=True):
            if messages[-1]['role'] == 'user':
                yield {'tool_calls':[{'index':i,'id':'repeat-'+str(i),'function':{'name':'operate_platform','arguments':json.dumps({'operation':'class.create','payload':{'name':'高三（6）班'}})}} for i in range(2)]}
            else:
                yield {'text':'请核对操作卡。'}
        with patch.object(BanbanAgent, 'provider', provider):
            response = await self.client.post('/api/banban/chat/stream', json={'message':'创建高三（6）班','scope':self.scope()}, headers=self.headers(csrf=True))
            events = []
            async for line in response.content:
                if not line.strip():
                    continue
                event = json.loads(line)
                events.append(event)
                if event['type'] == 'operation' and event['operation']['status'] == 'awaiting_confirmation':
                    await self.confirm(event['operation'])
        self.assertEqual(events[-1]['type'], 'done', events)
        ids = [e['operation']['id'] for e in events if e['type']=='operation']
        self.assertEqual(len(ids), 3)
        self.assertEqual(len(set(ids)), 1)
        self.assertEqual(len(events[-1]['message']['operations']), 1)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM banban_operations')['n'], 1)

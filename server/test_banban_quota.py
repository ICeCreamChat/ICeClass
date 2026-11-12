"""Monthly Banban admission limits use authenticated devices and accounts."""
import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

import app as service
from test_app import ServerTestCase


class BanbanQuotaTest(ServerTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict('os.environ', {'DEEPSEEK_API_KEY': ''})
        self.env.start()
        await super().asyncSetUp()
        self.device = await self.enroll_test_device()
        self.admin = self.headers(csrf=True)
        self.db = self.app[service.STORE_KEY]
        self.feature = next(r.handler.__self__ for r in self.app.router.routes()
                            if r.method == 'POST' and r.resource.canonical == '/api/banban/chat')
        response, teacher = await self.json_request('POST', '/api/teachers', {
            'username': 'quota-teacher', 'displayName': '额度教师', 'password': 'TeacherPassword123',
            'role': 'teacher', 'classIds': [self.device['classId']]}, csrf=True)
        self.assertEqual(response.status, 201, teacher)
        self.teacher_id = teacher['id']
        response = await self.client.post('/api/auth/login', json={
            'username': 'quota-teacher', 'password': 'TeacherPassword123'})
        identity = await response.json()
        self.teacher = {'Cookie': response.headers['Set-Cookie'].split(';', 1)[0],
                        'X-CSRF-Token': identity['user']['csrfToken']}
        self.classroom = {'Authorization': 'Bearer ' + self.device['deviceToken'],
                          'X-ICeClass-Device': self.device['deviceId'],
                          'X-ICeClass-Class': self.device['classId']}
        response = await self.client.get('/api/session', headers=self.classroom)
        self.classroom['X-CSRF-Token'] = (await response.json())['user']['csrfToken']

    async def asyncTearDown(self):
        await super().asyncTearDown()
        self.env.stop()

    async def request(self, method, path, body=None, headers=None):
        response = await self.client.request(method, path, json=body,
                                             headers=self.admin if headers is None else headers)
        data = await response.json() if response.content_type == 'application/json' else await response.text()
        return response, data

    async def policy(self, device=None, account=None, overrides=None):
        response, current = await self.request('GET', '/api/banban/quotas')
        self.assertEqual(response.status, 200, current)
        response, value = await self.request('PUT', '/api/banban/quotas', {
            'revision': current['revision'], 'deviceLimit': device, 'accountLimit': account,
            'overrides': overrides or []})
        self.assertEqual(response.status, 200, value)
        return value

    async def own(self, headers=None):
        response, quota = await self.request('GET', '/api/banban/quota', headers=headers)
        self.assertEqual(response.status, 200, quota)
        return quota

    async def chat(self, headers=None, stream=False, message='你好', **extra):
        response = await self.client.post('/api/banban/chat' + ('/stream' if stream else ''),
            json={'message': message, **extra}, headers=self.admin if headers is None else headers)
        if stream and response.status == 200:
            events = [json.loads(line) async for line in response.content if line.strip()]
            self.assertEqual(events[-1]['type'], 'done', events)
            return response, events
        return response, await response.json()

    async def test_only_superadmin_manages_policy_with_csrf_and_version_checks(self):
        response, initial = await self.request('GET', '/api/banban/quotas')
        self.assertEqual(response.status, 200, initial)
        self.assertIsNone(initial['deviceLimit'])
        self.assertIsNone(initial['accountLimit'])
        body = {'revision': initial['revision'], 'deviceLimit': 20, 'accountLimit': 30, 'overrides': []}
        response, _ = await self.request('PUT', '/api/banban/quotas', body,
                                        headers={'Cookie': self.admin['Cookie']})
        self.assertEqual(response.status, 403)
        for identity in (self.teacher, self.classroom, {}):
            for method in ('GET', 'PUT'):
                response, _ = await self.request(method, '/api/banban/quotas', body, identity)
                self.assertIn(response.status, (401, 403))
        response, principal = await self.request('POST', '/api/teachers', {
            'username': 'quota-principal', 'displayName': '校长', 'password': 'TeacherPassword123',
            'role': 'principal', 'classIds': []})
        self.assertEqual(response.status, 201, principal)
        response = await self.client.post('/api/auth/login', json={
            'username': 'quota-principal', 'password': 'TeacherPassword123'})
        principal = await response.json()
        principal_headers = {'Cookie': response.headers['Set-Cookie'].split(';', 1)[0],
                             'X-CSRF-Token': principal['user']['csrfToken']}
        for method in ('GET', 'PUT'):
            response, _ = await self.request(method, '/api/banban/quotas', body, principal_headers)
            self.assertEqual(response.status, 403)
        response, updated = await self.request('PUT', '/api/banban/quotas', body)
        self.assertEqual(response.status, 200, updated)
        response, _ = await self.request('PUT', '/api/banban/quotas', body)
        self.assertEqual(response.status, 409)
        _, preserved = await self.request('GET', '/api/banban/quotas')
        self.assertEqual(preserved['revision'], updated['revision'])
        self.assertEqual(preserved['deviceLimit'], 20)

    async def test_invalid_policy_is_rejected_without_partial_writes(self):
        current = await self.policy(device=5, account=6)
        body = {key: current[key] for key in ('revision', 'deviceLimit', 'accountLimit', 'overrides')}
        invalid = [dict(body, deviceLimit=value) for value in (-1, True, 1.5, '2', 1_000_001)]
        invalid += [dict(body, overrides=[{'kind': kind, 'id': ident, 'limit': limit}])
                    for kind, ident, limit in [('other', self.teacher_id, 2), ('account', 'missing', 2),
                                               ('device', self.device['deviceId'], False)]]
        invalid += [dict(body, revision=True), dict(body, unexpected=True),
                    dict(body, overrides=[{'kind': 'account', 'id': self.teacher_id, 'limit': 2}] * 2)]
        for value in invalid:
            response, data = await self.request('PUT', '/api/banban/quotas', value)
            self.assertEqual(response.status, 400, data)
        _, after = await self.request('GET', '/api/banban/quotas')
        self.assertEqual(after, current)

    async def test_both_chat_routes_share_device_budget_separate_from_teacher_account(self):
        await self.policy(device=2, account=1)
        response, data = await self.chat(self.classroom)
        self.assertEqual(response.status, 200, data)
        self.assertEqual(data['quota']['remaining'], 1)
        response, events = await self.chat(self.classroom, stream=True)
        self.assertEqual(events[0]['quota']['remaining'], 0)
        for stream in (False, True):
            response, data = await self.chat(self.classroom, stream=stream)
            self.assertEqual(response.status, 429, data)
            self.assertEqual(data['code'], 'banban_quota_exhausted')
            self.assertEqual(data['quota']['used'], 2)
            self.assertGreater(int(response.headers['Retry-After']), 0)
        self.assertEqual((await self.own(self.teacher))['used'], 0)
        response, _ = await self.chat(self.teacher, stream=True,
                                      voice={'mode': 'voice', 'deviceId': self.device['deviceId'],
                                             'classId': self.device['classId']})
        self.assertEqual(response.status, 200)
        response, data = await self.chat(self.teacher)
        self.assertEqual(response.status, 429, data)
        self.assertEqual((await self.own(self.teacher))['used'], 1)
        self.assertEqual((await self.own())['used'], 0)

    async def test_override_inherit_and_limit_changes_keep_monthly_used_count(self):
        await self.policy(account=0, overrides=[{'kind': 'account', 'id': self.teacher_id, 'limit': 2}])
        response, _ = await self.chat(self.teacher)
        self.assertEqual(response.status, 200)
        quota = await self.own(self.teacher)
        self.assertEqual((quota['used'], quota['remaining'], quota['source']), (1, 1, 'custom'))
        await self.policy(account=1)
        quota = await self.own(self.teacher)
        self.assertEqual((quota['used'], quota['remaining'], quota['source']), (1, 0, 'default'))
        await self.policy(account=0, overrides=[{'kind': 'account', 'id': self.teacher_id, 'limit': None}])
        response, _ = await self.chat(self.teacher)
        self.assertEqual(response.status, 200)
        quota = await self.own(self.teacher)
        self.assertEqual(quota['used'], 2)
        self.assertIsNone(quota['remaining'])

    async def test_concurrent_last_credit_is_admitted_once(self):
        await self.policy(account=1)
        results = await asyncio.gather(*(self.chat(self.teacher) for _ in range(4)))
        self.assertEqual(sorted(response.status for response, _ in results), [200, 429, 429, 429])
        self.assertEqual((await self.own(self.teacher))['used'], 1)

    async def test_month_rollover_is_beijing_midnight_including_new_year(self):
        from banban_quota import month_bounds
        before = int(datetime(2026, 12, 31, 15, 59, 59, tzinfo=timezone.utc).timestamp() * 1000)
        boundary = before + 1000
        self.assertEqual(month_bounds(before), ('2026-12', boundary))
        self.assertEqual(month_bounds(boundary)[0], '2027-01')
        await self.policy(account=1)
        with patch.object(self.feature.quotas, 'period', return_value=('2026-12', boundary)):
            self.assertEqual((await self.chat(self.teacher))[0].status, 200)
            self.assertEqual((await self.chat(self.teacher))[0].status, 429)
        with patch.object(self.feature.quotas, 'period', return_value=month_bounds(boundary)):
            self.assertEqual((await self.own(self.teacher))['used'], 0)
            self.assertEqual((await self.chat(self.teacher))[0].status, 200)
            self.assertEqual((await self.own(self.teacher))['used'], 1)

    async def test_standalone_operation_retry_and_confirmation_charge_once(self):
        await self.policy(account=1)
        body = {'kind': 'platform', 'args': {'operation': 'class.create', 'payload': {'name': '额度测试班'}},
                'requestKey': 'one-operation'}
        response, operation = await self.request('POST', '/api/banban/operations', body)
        self.assertEqual(response.status, 200, operation)
        self.assertEqual(operation['status'], 'awaiting_confirmation')
        response, repeated = await self.request('POST', '/api/banban/operations', body)
        self.assertEqual(response.status, 200, repeated)
        self.assertEqual(repeated['id'], operation['id'])
        for _ in range(2):
            response, result = await self.request('POST', '/api/banban/operations/' + operation['id'] + '/confirm',
                                                   {'confirmed': True})
            self.assertEqual(response.status, 200, result)
            self.assertEqual(result['status'], 'succeeded')
        self.assertEqual((await self.own())['used'], 1)
        response, blocked = await self.request('POST', '/api/banban/operations', dict(body, requestKey='second'))
        self.assertEqual(response.status, 429, blocked)
        self.assertEqual(blocked['code'], 'banban_quota_exhausted')

    async def test_invalid_requests_and_history_do_not_consume_and_exhaustion_keeps_safety_paths(self):
        await self.policy(device=1, account=1)
        for stream in (True, False):
            response, _ = await self.chat(self.teacher, stream=stream, message='')
            self.assertEqual(response.status, 400)
        self.assertEqual((await self.own(self.teacher))['used'], 0)
        await self.chat(self.teacher, stream=True)
        for method, path, body in [('GET', '/api/banban/conversation', None),
                                   ('POST', '/api/banban/conversations', {}),
                                   ('POST', '/api/banban/chat/cancel', {})]:
            response, data = await self.request(method, path, body, self.teacher)
            self.assertLess(response.status, 300, data)
        self.assertEqual((await self.own(self.teacher))['used'], 1)
        response, _ = await self.chat(self.teacher)
        self.assertEqual(response.status, 429)
        response, context = await self.request('GET', '/api/banban/context', headers=self.teacher)
        self.assertEqual(response.status, 200, context)
        self.assertEqual(context['quota']['remaining'], 0)

    async def test_settings_and_usage_survive_server_restart(self):
        await self.policy(device=1, account=3)
        await self.chat(self.classroom)
        await self.client.close()
        self.app = service.create_app(Path(self.temp.name) / 'test.db')
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        quota = await self.own(self.classroom)
        self.assertEqual((quota['used'], quota['limit'], quota['remaining']), (1, 1, 0))
        response, data = await self.chat(self.classroom)
        self.assertEqual(response.status, 429, data)
        self.assertEqual((await self.own(self.teacher))['limit'], 3)

    async def test_two_devices_of_one_class_have_independent_quotas(self):
        await self.policy(device=1)
        self.assertEqual((await self.chat(self.classroom))[0].status, 200)
        _, code = await self.request('POST', f"/api/classes/{self.device['classId']}/enrollment-code", {})
        response, device = await self.request('POST', '/api/device/enroll', {
            'code': code['code'], 'deviceName': '第二台测试白板'})
        self.assertEqual(response.status, 200, device)
        headers = {'Authorization': 'Bearer ' + device['deviceToken'], 'X-ICeClass-Device': device['deviceId'],
                   'X-ICeClass-Class': device['classId']}
        _, identity = await self.request('GET', '/api/session', headers=headers)
        headers['X-CSRF-Token'] = identity['user']['csrfToken']
        self.assertEqual((await self.own(headers))['used'], 0)
        self.assertEqual((await self.chat(headers))[0].status, 200)
        self.assertEqual((await self.own(self.classroom))['used'], 1)

    async def test_a_chat_with_multiple_internal_operations_consumes_one_credit(self):
        from banban_agent import BanbanAgent
        await self.request('PUT', '/api/banban/settings', {
            'enabled': True, 'model': 'fixture', 'apiKey': 'fixture-only'})
        await self.policy(account=1)

        async def provider(agent, cfg, messages, allow_tools=True):
            if messages[-1]['role'] == 'user':
                yield {'tool_calls': [{'index': index, 'id': str(index), 'function': {
                    'name': 'operate_platform', 'arguments': json.dumps({
                        'operation': 'quiet.update', 'payload': {'periods': [
                            {'name': f'计次测试{index}', 'weekdays': [1], 'startTime': '08:00', 'endTime': '08:40'}]}})}} for index in range(2)]}
            else:
                yield {'text': '两次修改已完成。'}

        with patch.object(BanbanAgent, 'provider', provider):
            response, events = await self.chat(stream=True, message='连续修改两次禁言设置', voice={'mode': 'voice'})
        self.assertEqual(response.status, 200, events)
        operations = [event['operation'] for event in events if event['type'] == 'operation']
        self.assertEqual(len(operations), 2, events)
        self.assertTrue(all(item['status'] == 'succeeded' for item in operations), operations)
        self.assertIsNotNone(self.db.one('SELECT id FROM quiet_periods WHERE name=?', ('计次测试1',)))
        self.assertEqual((await self.own())['used'], 1)

    async def test_exhaustion_keeps_explicit_device_stop_available(self):
        ws = await self.client.ws_connect('/ws/device?deviceId=' + self.device['deviceId'],
            headers={'Authorization': 'Bearer ' + self.device['deviceToken']})
        await ws.receive_json()
        try:
            await self.policy(account=0)
            response, operation = await self.request('POST', '/api/banban/operations', {
                'kind': 'computer', 'args': {'action': 'stop', 'deviceId': self.device['deviceId'],
                                             'classId': self.device['classId']}})
            self.assertEqual(response.status, 200, operation)
            command = await ws.receive_json()
            self.assertEqual(command['parameters']['action'], 'stop')
            self.assertEqual((await self.own())['used'], 0)
        finally:
            await ws.close()

    async def test_quota_capability_confirmation_names_individual_targets(self):
        from teacher_capabilities import actions, reads
        self.assertEqual(actions(self.app)['banban.quotas.update'].roles, ('superadmin',))
        self.assertEqual(reads(self.app)['banban.quotas'].roles, ('superadmin',))
        _, current = await self.request('GET', '/api/banban/quotas')
        response, operation = await self.request('POST', '/api/banban/operations', {
            'kind': 'platform', 'args': {'operation': 'banban.quotas.update', 'payload': {
                'revision': current['revision'], 'deviceLimit': 5, 'accountLimit': None,
                'overrides': [{'kind': 'account', 'id': self.teacher_id, 'limit': 2}]}}})
        self.assertEqual(response.status, 200, operation)
        self.assertIn('额度教师', json.dumps(operation['parameters'], ensure_ascii=False))
        self.assertNotIn(self.teacher_id, json.dumps(operation['parameters']))
        response, result = await self.request('POST', '/api/banban/operations/' + operation['id'] + '/confirm',
                                               {'confirmed': True})
        self.assertEqual(response.status, 200, result)
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual((await self.own(self.teacher))['limit'], 2)

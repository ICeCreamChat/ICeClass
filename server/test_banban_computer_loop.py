import json
from unittest.mock import patch

from banban_agent import BanbanAgent
from banban_operations import Operations
from test_app import ServerTestCase


class ComputerLoopTest(ServerTestCase):
    async def events(self, body):
        response = await self.client.post('/api/banban/chat/stream', json=body, headers=self.headers(csrf=True))
        return response, [json.loads(line) async for line in response.content if line.strip()]

    # A tool result changes every time the desktop is observed. These are
    # protocol fixtures; the actual Windows behavior is checked natively.
    async def exercise(self, actions, with_interface=False):
        await self.enroll_test_device()
        await self.json_request('PUT', '/api/banban/settings', {
            'enabled': True, 'model': 'deepseek-flash', 'apiKey': 'fixture-only-not-a-secret'}, csrf=True)
        created, results, rows, round_number = [], [], {}, 0

        async def create(operations, request, kind, args, **kwargs):
            created.append(dict(args))
            row = {'id': 'fixture-' + str(len(created)), 'status': 'succeeded',
                   'action': args['action'], 'result': {'observedVersion': len(created)}}
            if with_interface:
                row['result']['controls'] = [{'id': 'list', 'verticalScroll': len(created) * 10}]
            rows[row['id']] = row
            return row

        async def provider(agent, config, messages, allow_tools=True):
            nonlocal round_number
            if messages[-1]['role'] == 'tool':
                results.append(json.loads(messages[-1]['content']))
            if round_number < len(actions):
                action = actions[round_number]
                round_number += 1
                yield {'tool_calls': [{'index': 0, 'id': 'step-' + str(round_number),
                    'function': {'name': 'operate_computer', 'arguments': json.dumps(action)}}]}
            else:
                yield {'text': '这次界面状态已核对。'}

        with patch.object(Operations, 'create', create), patch.object(BanbanAgent, 'provider', provider), \
                patch.object(Operations, 'row', lambda ops, key, user: rows[key]), \
                patch.object(Operations, 'view', lambda ops, row: row):
            _, events = await self.events({'message': '查看当前窗口并按要求滚动', 'voice': {'mode': 'voice'}})
        return created, results, events

    async def test_observations_always_read_fresh_state(self):
        actions = [{'action': 'inspect'}, {'action': 'inspect_controls', 'targetId': 'window'},
                   {'action': 'inspect'}, {'action': 'inspect_controls', 'targetId': 'window'}]
        created, results, events = await self.exercise(actions)
        self.assertEqual(events[-1]['type'], 'done', events)
        self.assertEqual(created, actions)
        self.assertEqual([r['result']['observedVersion'] for r in results], [1, 2, 3, 4])

    async def test_repeated_action_after_fresh_observation_is_a_new_step(self):
        scroll = {'action': 'scroll_control', 'targetId': 'window', 'controlId': 'list', 'direction': 'down'}
        actions = [scroll, {'action': 'inspect_controls', 'targetId': 'window'}, scroll]
        created, _, events = await self.exercise(actions)
        self.assertEqual(events[-1]['type'], 'done', events)
        self.assertEqual(created, actions)

    async def test_multistep_computer_goal_has_room_to_observe_between_steps(self):
        actions = [{'action': 'inspect_controls', 'targetId': 'window', 'query': str(i)} for i in range(10)]
        created, _, events = await self.exercise(actions)
        self.assertEqual(events[-1]['type'], 'done', events)
        self.assertEqual(created, actions)

    async def test_verified_action_receipt_is_also_a_fresh_observation(self):
        scroll = {'action': 'scroll_control', 'targetId': 'window', 'controlId': 'list', 'direction': 'down'}
        created, _, events = await self.exercise([scroll, scroll], with_interface=True)
        self.assertEqual(events[-1]['type'], 'done', events)
        self.assertEqual(created, [scroll, scroll])

    async def test_identical_dispatch_without_fresh_interface_is_not_replayed(self):
        scroll = {'action': 'scroll_control', 'targetId': 'window', 'controlId': 'list', 'direction': 'down'}
        created, results, events = await self.exercise([scroll, scroll])
        self.assertEqual(events[-1]['type'], 'done', events)
        self.assertEqual(created, [scroll])
        self.assertEqual([r['result']['observedVersion'] for r in results], [1, 1])

"""Self-study guard: strict permissions, bounded spend and staged incidents."""
import asyncio
import base64
import copy
import json
import unittest
from datetime import datetime
from unittest.mock import AsyncMock, patch

import app as service
from reading import SHANGHAI
from test_app import ServerTestCase
from self_study import DEFAULT, FEATURE_KEY, validate_config
from self_study_ai import messages_for, parse_result, MAX_INPUT_BYTES, RESERVATION
from island import defaults as island_defaults


class SelfStudyConfigTests(unittest.TestCase):
    def test_classifier_is_bounded_and_rejects_unsafe_or_incomplete_results(self):
        content = messages_for({'text': '测' * 120, 'segments': 6, 'speechMs': 18000, 'longestMs': 4000})
        self.assertLessEqual(len(json.dumps(content, ensure_ascii=False, separators=(',', ':')).encode()), MAX_INPUT_BYTES)
        for body in ({}, {'choices': [None]}, {'choices': [{'finish_reason': 'length'}]},
                     {'choices': [{'finish_reason': 'stop', 'message': {'content': '[]'}}]},
                     {'choices': [{'finish_reason': 'stop', 'message': {'content': '{"kind":"chat","confidence":true}'}}]}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                parse_result(body)
        decision, counts = parse_result({'choices': [{'finish_reason': 'stop', 'message': {
            'content': '{"kind":"unknown","confidence":0.2}'}}], 'usage': {'prompt_tokens': True}})
        self.assertEqual(decision['kind'], 'unknown')
        self.assertEqual(counts, {})
    def test_disabled_default_and_explicit_consent(self):
        self.assertFalse(validate_config(DEFAULT)['enabled'])
        cfg = {**DEFAULT, 'enabled': True}
        with self.assertRaises(ValueError):
            validate_config(cfg)
        cfg['authorized'] = True
        self.assertTrue(validate_config(cfg)['enabled'])

    def test_budget_and_periods_cannot_be_bypassed_with_bool_or_nan(self):
        for field, value in [('dailyCalls', True), ('dailyTokens', -1), ('dailyCalls', 100),
                             ('dailyTokens', float('nan')), ('enabled', 1), ('photoEnabled', 'yes')]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_config({**DEFAULT, field: value})
        for period in [{'weekdays': [True], 'start': 1200, 'end': 1245},
                       {'weekdays': [1], 'start': 1245, 'end': 1200}]:
            with self.assertRaises(ValueError):
                validate_config({**DEFAULT, 'periods': [period]})


class SelfStudyApiTests(ServerTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.device = await self.enroll_test_device()
        self.cid = self.device['classId']
        self.f = self.app[FEATURE_KEY]
        self.now = int(datetime(2026, 11, 9, 20, 5, tzinfo=SHANGHAI).timestamp() * 1000)
        self.clock_patch = patch.object(service, 'now_ms', side_effect=lambda: self.now)
        self.clock_patch.start()
        self.addCleanup(self.clock_patch.stop)
        self.device_headers = {'Authorization': 'Bearer ' + self.device['deviceToken'],
                               'X-ICeClass-Device': self.device['deviceId']}
        self.profile = island_defaults('高一')
        self.profile['lessons'] = [{'slotId': 'evening-study-2', 'weekday': 1, 'week': 'all',
                                   'subject': '晚自习', 'teacher': '值班老师', 'location': ''}]
        self.set_profile()
        self.cfg = {**copy.deepcopy(DEFAULT), 'enabled': True, 'authorized': True, 'aiEnabled': True}
        self.ai = AsyncMock(return_value=({'kind': 'chat', 'confidence': .96}, {'inputTokens': 100, 'outputTokens': 20}))
        self.f.classify = self.ai
        self.f.connection = lambda cid: {'enabled': True, 'apiKey': 'test-only', 'model': 'test', 'baseUrl': 'https://example.com'}
        await self.save(self.cfg)

    def set_profile(self):
        self.f.db.run('INSERT OR REPLACE INTO island_profiles VALUES(?,?,?,?,NULL)',
                      (self.cid, 1, json.dumps(self.profile), self.now))

    async def test_uses_effective_island_timetable_and_cancellations(self):
        _, data = await self.json_request('GET', '/api/self-study/classes/' + self.cid)
        self.assertEqual(data['schedule'][0]['title'], '晚自习第二节')
        self.assertTrue(data['inPeriod'])
        self.profile['overrides'] = [{'slotId': 'evening-study-2', 'date': '2026-11-09', 'cancelled': True}]
        self.set_profile()
        _, result = await self.observe()
        self.assertEqual(result['action'], 'inactive')
        self.assertEqual(self.ai.await_count, 0)

    async def test_quiet_ends_episode_and_reported_episode_does_not_repeat(self):
        _, warning = await self.observe()
        await self.client.post('/api/self-study/device/events/' + warning['eventId'] + '/receipt',
            json={'shown': True, 'revision': self.revision}, headers=self.device_headers)
        self.now += 180000
        _, reported = await self.observe('window-after-001')
        self.assertEqual(reported['action'], 'report')
        self.now += 660000
        _, result = await self.observe('window-after-002')
        self.assertEqual(result['action'], 'observe')
        self.assertEqual(self.ai.await_count, 2)
        response = await self.client.post('/api/self-study/device/quiet',
            json={'revision': self.revision, 'eventId': warning['eventId']}, headers=self.device_headers)
        self.assertEqual(response.status, 200)

    async def save(self, cfg, revision=None):
        response, current = await self.json_request('GET', '/api/self-study/classes/' + self.cid)
        self.assertEqual(response.status, 200, current)
        response, result = await self.json_request('PUT', '/api/self-study/classes/' + self.cid,
            {'config': cfg, 'revision': current['revision'] if revision is None else revision}, csrf=True)
        self.assertEqual(response.status, 200, result)
        self.revision = result['revision']
        return result

    def observation(self, oid='window-00000001'):
        return {'id': oid, 'revision': self.revision, 'startAt': self.now - 60000, 'endAt': self.now,
                'speechMs': 12000, 'segments': 5, 'longestMs': 3200, 'level': 25,
                'text': '放学去哪里；刚才那个游戏；明天再一起玩。'}

    async def observe(self, oid='window-00000001', body=None):
        response = await self.client.post('/api/self-study/device/observe',
            json=body or self.observation(oid), headers=self.device_headers)
        return response, await response.json()

    async def report(self):
        _, warning = await self.observe()
        await self.client.post('/api/self-study/device/events/' + warning['eventId'] + '/receipt',
            json={'shown': True, 'revision': self.revision}, headers=self.device_headers)
        self.now += 180000
        _, result = await self.observe('window-report-02')
        self.assertEqual(result['action'], 'report')
        return result['eventId']

    async def test_capture_claim_is_once_and_private_photo_expires(self):
        eid = await self.report()
        path = '/api/self-study/device/events/' + eid
        response = await self.client.post(path + '/capture', json={}, headers=self.device_headers)
        self.assertTrue((await response.json())['allowed'])
        response = await self.client.post(path + '/capture', json={}, headers=self.device_headers)
        self.assertFalse((await response.json())['allowed'])
        encoded = base64.b64encode(b'\xff\xd8\xff\xe0test\xff\xd9').decode()
        response = await self.client.post(path + '/photo', json={'image': encoded}, headers=self.device_headers)
        self.assertEqual(response.status, 200)
        response = await self.client.post(path + '/photo', json={'image': encoded}, headers=self.device_headers)
        self.assertEqual(response.status, 409)
        response = await self.client.get('/api/self-study/events/' + eid + '/photo', headers=self.headers())
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        response = await self.client.get('/api/self-study/events/' + eid + '/photo', headers=self.device_headers)
        self.assertIn(response.status, (401, 403))
        self.now += 24 * 3600000
        response = await self.client.get('/api/self-study/events/' + eid + '/photo', headers=self.headers())
        self.assertEqual(response.status, 404)

    async def test_photo_upload_rechecks_binding_after_reading_body(self):
        eid = await self.report()
        path = '/api/self-study/device/events/' + eid
        await self.client.post(path + '/capture', json={}, headers=self.device_headers)
        _, other = await self.json_request('POST', '/api/classes', {'name': '高一（9）班'}, csrf=True)
        entered, release = asyncio.Event(), asyncio.Event()
        original = self.f.capture_event
        def capture(*args, **kwargs):
            value = original(*args, **kwargs)
            entered.set()
            return value
        self.f.capture_event = capture
        raw = json.dumps({'image': base64.b64encode(b'\xff\xd8\xff\xe0test\xff\xd9').decode()}).encode()
        async def chunks():
            yield raw[:4]
            await release.wait()
            yield raw[4:]
        task = asyncio.create_task(self.client.post(path + '/photo', data=chunks(),
            headers={**self.device_headers, 'Content-Type': 'application/json'}))
        await asyncio.wait_for(entered.wait(), 3)
        self.f.db.run('UPDATE devices SET class_id=? WHERE id=?', (other['id'], self.device['deviceId']))
        release.set()
        response = await task
        self.assertEqual(response.status, 409)
        self.assertIsNone(self.f.db.one('SELECT photo FROM self_study_events WHERE id=?', (eid,))['photo'])

    async def test_config_change_invalidates_inflight_ai_without_forgetting_spend(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def slow(*_):
            started.set()
            await release.wait()
            return {'kind': 'chat', 'confidence': .99}, {'inputTokens': 100, 'outputTokens': 20}
        self.ai.side_effect = slow
        pending = asyncio.create_task(self.observe())
        await started.wait()
        await self.save({**self.cfg, 'enabled': False})
        release.set()
        _, result = await pending
        self.assertEqual(result['action'], 'inactive')
        self.assertEqual(self.f.usage(self.cid)['calls'], 1)
        self.assertEqual(self.f.db.all('SELECT * FROM self_study_events'), [])

    async def test_quiet_during_classification_cannot_revive_event(self):
        _, warning = await self.observe()
        eid = warning['eventId']
        await self.client.post('/api/self-study/device/events/' + eid + '/receipt',
            json={'shown': True, 'revision': self.revision}, headers=self.device_headers)
        self.now += 180000
        started, release = asyncio.Event(), asyncio.Event()
        async def slow(*_):
            started.set()
            await release.wait()
            return {'kind': 'chat', 'confidence': .99}, {'inputTokens': 100, 'outputTokens': 20}
        self.ai.side_effect = slow
        pending = asyncio.create_task(self.observe('window-quiet-race'))
        try:
            await asyncio.wait_for(started.wait(), 3)
            response = await self.client.post('/api/self-study/device/quiet',
                json={'revision': self.revision, 'eventId': eid}, headers=self.device_headers)
            self.assertEqual(response.status, 200)
        finally:
            release.set()
        _, result = await pending
        self.assertEqual(result['action'], 'inactive')
        event = self.f.db.one('SELECT * FROM self_study_events WHERE id=?', (eid,))
        self.assertEqual(event['status'], 'resolved')
        self.assertIsNone(event['reported_at'])
        self.assertIsNotNone(event['ended_at'])
        self.assertEqual(self.f.usage(self.cid)['calls'], 2)
        response = await self.client.post('/api/self-study/device/events/' + eid + '/capture',
            json={}, headers=self.device_headers)
        self.assertFalse((await response.json())['allowed'])

    async def test_quiet_ends_capture_and_pending_upload(self):
        eid = await self.report()
        path = '/api/self-study/device/events/' + eid
        response = await self.client.post(path + '/capture', json={}, headers=self.device_headers)
        self.assertTrue((await response.json())['allowed'])
        await self.client.post('/api/self-study/device/quiet',
            json={'revision': self.revision, 'eventId': eid}, headers=self.device_headers)
        response = await self.client.post(path + '/photo', json={'failed': True}, headers=self.device_headers)
        self.assertEqual(response.status, 409)
        # An ended report must also reject a still-unclaimed physical capture.
        self.f.db.run("UPDATE self_study_events SET photo_status='pending' WHERE id=?", (eid,))
        response = await self.client.post(path + '/capture', json={}, headers=self.device_headers)
        self.assertFalse((await response.json())['allowed'])

    async def test_config_and_timetable_changes_invalidate_capture(self):
        eid = await self.report()
        self.profile['overrides'] = [{'slotId': 'evening-study-2', 'date': '2026-11-09', 'cancelled': True}]
        self.set_profile()
        response = await self.client.post('/api/self-study/device/events/' + eid + '/capture',
            json={}, headers=self.device_headers)
        self.assertFalse((await response.json())['allowed'])
        self.assertEqual(self.f.db.one('SELECT photo FROM self_study_events WHERE id=?', (eid,))['photo'], None)

    async def test_teacher_scope_and_stale_save_and_no_stored_transcript(self):
        await self.observe()
        response, _ = await self.json_request('PUT', '/api/self-study/classes/' + self.cid,
            {'config': self.cfg, 'revision': 0}, csrf=True)
        self.assertEqual(response.status, 409)
        response, other = await self.json_request('POST', '/api/classes', {'name': '高一（2）班'}, csrf=True)
        self.assertEqual(response.status, 201)
        response, _ = await self.json_request('POST', '/api/teachers',
            {'username': 'scope.teacher', 'displayName': '测试教师', 'password': 'TeacherPassword123',
             'classIds': [other['id']]}, csrf=True)
        self.assertEqual(response.status, 201)
        self.cookie = ''
        response, login = await self.json_request('POST', '/api/auth/login',
            {'username': 'scope.teacher', 'password': 'TeacherPassword123'})
        self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]
        self.csrf = login['user']['csrfToken']
        response, _ = await self.json_request('GET', '/api/self-study/events?classId=' + self.cid)
        self.assertEqual(response.status, 403)
        saved = json.dumps(self.f.db.all('SELECT * FROM self_study_decisions'), ensure_ascii=False)
        self.assertNotIn(self.observation()['text'], saved)

    async def test_remind_requires_real_receipt_then_new_observation_before_report(self):
        response, warning = await self.observe()
        self.assertEqual(response.status, 200, warning)
        self.assertEqual(warning['action'], 'remind')
        self.assertFalse(warning.get('captureRequested', False))
        response, again = await self.observe()
        self.assertEqual(again, warning)
        self.assertEqual(self.ai.await_count, 1)
        receipt = await self.client.post('/api/self-study/device/events/' + warning['eventId'] + '/receipt',
            json={'shown': True, 'revision': self.revision}, headers=self.device_headers)
        self.assertEqual(receipt.status, 200)
        self.now += 180000
        response, reported = await self.observe('window-00000002')
        self.assertEqual(reported['action'], 'report', reported)
        self.assertTrue(reported['captureRequested'])
        response, data = await self.json_request('GET', '/api/self-study/events?classId=' + self.cid)
        self.assertEqual(response.status, 200, data)
        self.assertEqual(len(data['events']), 1)
        self.assertEqual(data['events'][0]['status'], 'reported')
        self.assertNotIn('text', json.dumps(data, ensure_ascii=False))

    async def test_teaching_and_unknown_do_not_warn_or_capture(self):
        for index, kind in enumerate(('teaching', 'study', 'unknown')):
            self.ai.return_value = ({'kind': kind, 'confidence': .99}, {'inputTokens': 100, 'outputTokens': 20})
            self.now += 180000
            response, result = await self.observe('window-kind-' + str(index))
            self.assertEqual(result['action'], 'observe', result)
            self.assertFalse(result.get('captureRequested', False))

    async def test_budget_is_shared_persistent_and_duplicates_are_free(self):
        self.cfg['dailyCalls'] = 1
        await self.save(self.cfg)
        observations = await asyncio.gather(self.observe(), self.observe())
        self.assertEqual(self.ai.await_count, 1)
        await self.client.post('/api/self-study/device/events/' + observations[0][1]['eventId'] + '/receipt',
            json={'shown': True, 'revision': self.revision}, headers=self.device_headers)
        self.now += 180000
        _, result = await self.observe('window-00000002')
        self.assertEqual(result['action'], 'budget')
        self.assertEqual(self.ai.await_count, 1)
        await self.save({**self.cfg, 'enabled': False})
        await self.save(self.cfg)
        self.now += 180000
        _, result = await self.observe('window-00000003')
        self.assertEqual(result['action'], 'budget')

    async def test_disabled_stale_revision_and_outside_period_never_call_ai(self):
        body = self.observation()
        body['revision'] = -1
        response, _ = await self.observe(body=body)
        self.assertEqual(response.status, 409)
        self.now += 7200000
        _, result = await self.observe()
        self.assertEqual(result['action'], 'inactive')
        self.assertEqual(self.ai.await_count, 0)

    async def test_failed_call_is_not_replayed_and_reserves_budget(self):
        self.ai.side_effect = TimeoutError()
        _, result = await self.observe()
        self.assertEqual(result['action'], 'unavailable')
        _, duplicate = await self.observe()
        self.assertEqual(result, duplicate)
        self.assertEqual(self.ai.await_count, 1)
        _, data = await self.json_request('GET', '/api/self-study/classes/' + self.cid)
        self.assertGreater(data['usage']['tokens'], 0)

    async def test_device_cannot_read_teacher_events_or_photos(self):
        response = await self.client.get('/api/self-study/events?classId=' + self.cid, headers=self.device_headers)
        self.assertIn(response.status, (401, 403))

    async def test_no_report_without_display_receipt(self):
        _, warning = await self.observe()
        self.now += 180000
        _, result = await self.observe('window-00000002')
        self.assertEqual(result['action'], 'remind')
        self.assertEqual(result['eventId'], warning['eventId'])
        self.assertEqual(self.ai.await_count, 1)

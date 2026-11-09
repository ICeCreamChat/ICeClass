"""Self-study guard: strict permissions, bounded spend and staged incidents."""
import asyncio
import base64
import copy
import json
import unittest
from datetime import datetime
from unittest.mock import AsyncMock, patch
from aiohttp import web

import app as service
from reading import SHANGHAI
from test_app import ServerTestCase
from self_study import DEFAULT, FEATURE_KEY, SelfStudyFeature, validate_config
from self_study_ai import messages_for, parse_result, MAX_INPUT_BYTES, RESERVATION
from island import defaults as island_defaults


class SelfStudyConfigTests(unittest.TestCase):
    def test_classifier_is_bounded_and_rejects_unsafe_or_incomplete_results(self):
        content = messages_for({'utterances': [{'text': '测' * 20} for _ in range(6)]})
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


    def test_adjustable_rules_validate_ranges_and_fill_existing_settings(self):
        cfg = validate_config({})
        self.assertEqual({k: cfg[k] for k in ('sensitivity', 'voiceTriggerMs', 'observationSeconds',
                         'reminderWaitSeconds', 'confirmationsAfterReminder')},
                         {'sensitivity': 'balanced', 'voiceTriggerMs': 600, 'observationSeconds': 10,
                          'reminderWaitSeconds': 90, 'confirmationsAfterReminder': 1})
        for key, value in [('sensitivity', 'extreme'), ('voiceTriggerMs', True), ('voiceTriggerMs', 299),
                           ('voiceTriggerMs', 3001), ('observationSeconds', 9), ('observationSeconds', 31),
                           ('reminderWaitSeconds', 89), ('reminderWaitSeconds', 301),
                           ('confirmationsAfterReminder', True), ('confirmationsAfterReminder', 0),
                           ('confirmationsAfterReminder', 4)]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                validate_config({key: value})


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
        self.ai = AsyncMock(return_value=({'kind': 'chat', 'confidence': .96, 'evidence': [0, 1]}, {'inputTokens': 100, 'outputTokens': 20}))
        self.f.classify = self.ai
        self.f.connection = lambda cid: {'enabled': True, 'apiKey': 'test-only', 'model': 'test', 'baseUrl': 'https://example.com'}
        await self.save(self.cfg)

    def set_profile(self):
        self.f.db.run('INSERT OR REPLACE INTO island_profiles VALUES(?,?,?,?,NULL)',
                      (self.cid, 1, json.dumps(self.profile), self.now))

    async def test_saved_rules_reach_device_without_using_ai_or_resetting_usage(self):
        _, warning = await self.observe()
        before = self.f.usage(self.cid)
        cfg = {**self.cfg, 'sensitivity': 'high', 'voiceTriggerMs': 1200,
               'observationSeconds': 30, 'reminderWaitSeconds': 180, 'confirmationsAfterReminder': 2}
        await self.save(cfg)
        response = await self.client.get('/api/self-study/device/config', headers=self.device_headers)
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())['config'], cfg)
        self.assertEqual(self.ai.await_count, 1)
        self.assertEqual(self.f.usage(self.cid), before)
        event = self.f.db.one('SELECT status,ended_at FROM self_study_events WHERE id=?', (warning['eventId'],))
        self.assertEqual(event['status'], 'resolved')
        self.assertIsNotNone(event['ended_at'])

    async def test_legacy_settings_and_event_schema_migrate_without_losing_records(self):
        _, warning = await self.observe()
        legacy = {key: self.cfg[key] for key in ('enabled', 'authorized', 'aiEnabled', 'photoEnabled', 'dailyCalls', 'dailyTokens')}
        self.f.db.run('UPDATE self_study_settings SET config=? WHERE class_id=?', (json.dumps(legacy), self.cid))
        before = self.f.db.one('SELECT id,started_at,status,revision FROM self_study_events WHERE id=?', (warning['eventId'],))
        usage = self.f.usage(self.cid)
        for key in ('confirmations', 'last_confirmation_at', 'expires_at'):
            self.f.db.run('ALTER TABLE self_study_events DROP COLUMN ' + key)
        migration_app = web.Application()
        migration_app[service.STORE_KEY] = self.f.db
        for _ in range(2):
            migrated = SelfStudyFeature(migration_app, service, self.f.connections)
            self.assertEqual(migrated.settings(self.cid), (self.cfg, self.revision))
            self.assertEqual(migrated.usage(self.cid), usage)
            self.assertEqual(migrated.db.one('SELECT id,started_at,status,revision FROM self_study_events WHERE id=?', (warning['eventId'],)), before)
            event = migrated.db.one('SELECT confirmations,last_confirmation_at,expires_at FROM self_study_events WHERE id=?', (warning['eventId'],))
            self.assertEqual(event, {'confirmations': 0, 'last_confirmation_at': None, 'expires_at': None})

    async def test_observation_span_respects_saved_rule_before_calling_ai(self):
        await self.save({**self.cfg, 'observationSeconds': 30})
        _, result = await self.observe()
        self.assertEqual(result['action'], 'observe')
        self.assertEqual(self.ai.await_count, 0)
        body = self.observation('longer-window-001')
        body['startAt'] = body['utterances'][0]['startAt'] = self.now - 30000
        body['utterances'][0]['endAt'] = self.now - 26000
        _, result = await self.observe(body=body)
        self.assertEqual(result['action'], 'remind')

    async def test_wait_and_multiple_confirmations_require_new_nonoverlapping_evidence(self):
        await self.save({**self.cfg, 'reminderWaitSeconds': 180, 'confirmationsAfterReminder': 2})
        _, warning = await self.observe()
        eid = warning['eventId']
        await self.client.post('/api/self-study/device/events/' + eid + '/receipt',
            json={'shown': True, 'revision': self.revision}, headers=self.device_headers)
        self.now += 90000
        _, early = await self.observe('early-confirmation-001')
        self.assertEqual(early['action'], 'observe')
        self.assertEqual(self.ai.await_count, 1)
        self.now += 90000
        body = self.observation('confirmation-one-001')
        _, first = await self.observe(body=body)
        self.assertEqual(first['action'], 'observe')
        self.assertEqual(first['confirmations'], 1)
        self.assertEqual(self.f.db.one('SELECT photo_status FROM self_study_events WHERE id=?', (eid,))['photo_status'], 'none')
        _, replay = await self.observe(body=body)
        self.assertEqual(first, replay)
        self.now += 5000
        # A fresh request ID must not turn old clips into another confirmation.
        body['id'] = 'same-evidence-new-id'
        _, overlap = await self.observe(body=body)
        self.assertEqual(overlap['action'], 'observe')
        self.assertEqual(self.ai.await_count, 2)
        self.now += 90000
        _, result = await self.observe('confirmation-two-001')
        self.assertEqual(result['action'], 'report')
        self.assertEqual(result['eventId'], eid)
        self.assertEqual(self.ai.await_count, 3)

    async def test_long_wait_and_three_confirmations_do_not_expire_at_old_fixed_timeout(self):
        await self.save({**self.cfg, 'reminderWaitSeconds': 300, 'confirmationsAfterReminder': 3})
        _, warning = await self.observe()
        await self.client.post('/api/self-study/device/events/' + warning['eventId'] + '/receipt',
            json={'shown': True, 'revision': self.revision}, headers=self.device_headers)
        self.now += 330000
        for i in range(3):
            _, result = await self.observe('long-wait-confirmation-' + str(i))
            self.assertEqual(result['action'], 'report' if i == 2 else 'observe')
            self.now += 90000
        self.assertEqual(self.ai.await_count, 4)
        self.assertEqual(result['eventId'], warning['eventId'])

    async def test_learning_evidence_ends_confirmation_sequence(self):
        await self.save({**self.cfg, 'confirmationsAfterReminder': 2})
        _, warning = await self.observe()
        await self.client.post('/api/self-study/device/events/' + warning['eventId'] + '/receipt',
            json={'shown': True, 'revision': self.revision}, headers=self.device_headers)
        self.now += 90000
        _, first = await self.observe('first-confirmation-001')
        self.assertEqual(first['action'], 'observe')
        self.now += 90000
        body = self.observation('learning-break-001')
        body['utterances'][0]['text'] = '这道题先列方程'
        _, learning = await self.observe(body=body)
        self.assertEqual(learning['classification'], 'study')
        self.now += 180000
        _, next_event = await self.observe('new-chat-sequence-001')
        self.assertEqual(next_event['action'], 'remind')
        self.assertNotEqual(next_event['eventId'], warning['eventId'])

    async def test_live_feedback_status_does_not_create_ai_work_or_events(self):
        for state in ('listening', 'observing', 'analyzing', 'teaching', 'budget', 'ai_paused', 'paused'):
            response = await self.client.post('/api/self-study/device/status',
                json={'state': state, 'detail': '本地声音状态'}, headers=self.device_headers)
            self.assertEqual(response.status, 200)
            row = self.f.db.one('SELECT state FROM self_study_status WHERE device_id=?', (self.device['deviceId'],))
            self.assertEqual(row['state'], state)
        self.assertEqual(self.ai.await_count, 0)
        self.assertEqual(self.f.db.one('SELECT COUNT(*) AS n FROM self_study_events')['n'], 0)

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
        return {'id': oid, 'revision': self.revision, 'startAt': self.now - 24000, 'endAt': self.now,
                'speechMs': 12000, 'segments': 3, 'longestMs': 4000, 'level': 25,
                'utterances': [{'startAt': self.now - 24000 + i * 10000, 'endAt': self.now - 20000 + i * 10000,
                                'speechMs': 4000, 'text': text} for i, text in enumerate(
                                    ['放学去哪里吃饭', '刚才那个游戏真好玩', '明天再一起玩游戏'])]}

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
        for utterance in self.observation()['utterances']:
            self.assertNotIn(utterance['text'], saved)

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

    async def test_legacy_unsegmented_observation_abstains_without_spending(self):
        body = self.observation('legacy-window-001')
        body.pop('utterances', None)
        _, result = await self.observe(body=body)
        self.assertEqual(result['action'], 'observe')
        self.assertIn('升级', result['detail'])
        self.assertEqual(self.ai.await_count, 0)

    async def test_chat_confidence_without_distinct_evidence_never_warns(self):
        self.ai.return_value = ({'kind': 'chat', 'confidence': .99}, {'inputTokens': 100, 'outputTokens': 20})
        _, result = await self.observe()
        self.assertEqual(result['action'], 'observe')
        self.assertEqual(self.f.db.all('SELECT * FROM self_study_events'), [])

    async def test_explicit_learning_context_vetoes_even_a_confident_chat_decision(self):
        body = self.observation('teacher-explaining')
        for u, text in zip(body['utterances'], ['这道题先移项再求解', '为什么这个系数要变号', '等式两边同时除以这个数']):
            u['text'] = text
        _, result = await self.observe(body=body)
        self.assertEqual(result['action'], 'observe')
        self.assertEqual(result['classification'], 'study')
        self.assertEqual(self.ai.await_count, 0)
        self.assertEqual(self.f.db.all('SELECT * FROM self_study_events'), [])

    async def test_invalid_or_repeated_chat_evidence_abstains(self):
        for i, evidence in enumerate(([0, 0], [0, 3], [True, 1], '0,1', [0], None)):
            with self.subTest(evidence=evidence):
                self.f.db.run('DELETE FROM self_study_usage WHERE class_id=?', (self.cid,))
                self.ai.return_value = ({'kind': 'chat', 'confidence': .99, 'evidence': evidence},
                                        {'inputTokens': 100, 'outputTokens': 20})
                self.now += 180000
                _, result = await self.observe('invalid-evidence-' + str(i))
                self.assertEqual(result['action'], 'observe')
        self.assertEqual(self.f.db.all('SELECT * FROM self_study_events'), [])

    async def test_duplicate_or_fragmentary_transcript_is_not_two_distinct_evidence(self):
        body = self.observation()
        body['utterances'][1]['text'] = body['utterances'][0]['text']
        _, result = await self.observe(body=body)
        self.assertEqual(result['action'], 'observe')
        self.now += 180000
        body = self.observation('fragmentary-window')
        body['utterances'][0]['text'] = '好'
        _, result = await self.observe(body=body)
        self.assertEqual(result['action'], 'observe')

    async def test_invalid_clip_timing_and_fabricated_totals_never_spend(self):
        for field in ('overlap', 'future', 'total', 'longest', 'count', 'text', 'speech', 'missing'):
            with self.subTest(field=field):
                body = self.observation('bad-window-' + field)
                if field == 'overlap': body['utterances'][1]['startAt'] = body['utterances'][0]['endAt'] - 1
                if field == 'future': body['utterances'][-1]['endAt'] += 1
                if field == 'total': body['speechMs'] += 1000
                if field == 'longest': body['longestMs'] += 1000
                if field == 'count': body['segments'] += 1
                if field == 'text': body['utterances'][0]['text'] = '字' * 121
                if field == 'speech': body['utterances'][0]['speechMs'] = True
                if field == 'missing': body['utterances'][0].pop('startAt')
                response, _ = await self.observe(body=body)
                self.assertEqual(response.status, 400)
        self.assertEqual(self.ai.await_count, 0)

    async def test_old_warning_expires_instead_of_escalating_unrelated_conversation(self):
        _, warning = await self.observe()
        await self.client.post('/api/self-study/device/events/' + warning['eventId'] + '/receipt',
            json={'shown': True, 'revision': self.revision}, headers=self.device_headers)
        self.now += 360000
        _, result = await self.observe('later-conversation')
        self.assertEqual(result['action'], 'remind')
        self.assertNotEqual(result['eventId'], warning['eventId'])
        old = self.f.db.one('SELECT * FROM self_study_events WHERE id=?', (warning['eventId'],))
        self.assertEqual(old['status'], 'resolved')
        self.assertIsNone(old['reported_at'])

    async def test_pre_warning_audio_cannot_be_reused_to_escalate(self):
        body = self.observation('copied-evidence-window')
        _, warning = await self.observe()
        await self.client.post('/api/self-study/device/events/' + warning['eventId'] + '/receipt',
            json={'shown': True, 'revision': self.revision}, headers=self.device_headers)
        self.now += 90000
        # Pretend the old evidence is fresh by extending only the aggregate window.
        body['endAt'] = self.now
        response, _ = await self.observe(body=body)
        self.assertEqual(response.status, 400)
        self.assertEqual(self.ai.await_count, 1)

    async def test_warning_expiring_during_review_cannot_report(self):
        _, warning = await self.observe()
        await self.client.post('/api/self-study/device/events/' + warning['eventId'] + '/receipt',
            json={'shown': True, 'revision': self.revision}, headers=self.device_headers)
        self.now += 285000
        async def slow(*_):
            self.now += 20000
            return {'kind': 'chat', 'confidence': .99, 'evidence': [0, 1]}, {'inputTokens': 100, 'outputTokens': 20}
        self.ai.side_effect = slow
        _, result = await self.observe('warning-expiring')
        self.assertEqual(result['action'], 'observe')
        self.assertEqual(self.f.db.one('SELECT status FROM self_study_events WHERE id=?', (warning['eventId'],))['status'], 'resolved')

    async def test_expired_warning_is_resolved_without_new_audio(self):
        _, warning = await self.observe()
        self.now += 300000
        self.f.prune()
        event = self.f.db.one('SELECT status,ended_at FROM self_study_events WHERE id=?', (warning['eventId'],))
        self.assertEqual(event['status'], 'resolved')
        self.assertIsNotNone(event['ended_at'])

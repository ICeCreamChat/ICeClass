"""Isolated classroom math review HTTP sessions; never use student material."""
import asyncio
import base64
import io
import json
import threading
from unittest.mock import patch

from aiohttp import TCPConnector, web
from aiohttp.test_utils import TestClient, TestServer

import app as service
from test_app import ServerTestCase


class MathReviewTest(ServerTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict('os.environ', {'DEEPSEEK_API_KEY': 'synthetic-test-key'})
        self.env.start()
        await super().asyncSetUp()
        # web.run_app uses False; TestServer otherwise silently enables True.
        self.client.server.runner.server.handler_cancellation = False
        self.device = await self.enroll_test_device()
        response, teacher = await self.json_request('POST', '/api/teachers', {
            'username': 'math-teacher', 'displayName': '虚构教师', 'password': 'TeacherPassword123',
            'role': 'teacher', 'classIds': [self.device['classId']]}, csrf=True)
        self.assertEqual(response.status, 201, teacher)
        self.teacher_id = teacher['id']
        self.device_headers = {'Authorization': 'Bearer ' + self.device['deviceToken'],
                               'X-ICeClass-Device': self.device['deviceId'],
                               'X-ICeClass-Class': self.device['classId']}
        response = await self.client.get('/api/session', headers=self.device_headers)
        self.device_headers['X-CSRF-Token'] = (await response.json())['user']['csrfToken']

    async def asyncTearDown(self):
        await super().asyncTearDown()
        self.env.stop()

    async def post(self, path='', body=None, headers=None):
        response = await self.client.post('/api/banban/math-reviews' + path,
            json=body, headers=self.device_headers if headers is None else headers)
        data = await response.json() if response.content_type == 'application/json' else await response.text()
        return response, data

    async def prepare(self, key='synthetic-key'):
        response, data = await self.post(body={'requestKey': key})
        self.assertEqual(response.status, 200, data)
        return data

    async def test_preparation_is_idempotent_and_does_not_charge(self):
        first = await self.prepare()
        second = await self.prepare()
        self.assertEqual(set(first), {'reviewId', 'expiresAt', 'quota'})
        self.assertEqual(first, second)
        self.assertEqual(first['quota']['used'], 0)
        response, _ = await self.post(body={'requestKey': 'another-key'})
        self.assertEqual(response.status, 409)

    def reviews(self):
        from banban_math_reviews import KEY
        return self.app[KEY]

    def images(self, color='white'):
        from PIL import Image
        target = io.BytesIO()
        Image.new('RGB', (16, 12), color).save(target, 'PNG')
        image = {'dataUrl': 'data:image/png;base64,' + base64.b64encode(target.getvalue()).decode(),
                 'width': 16, 'height': 12, 'capturedAt': service.now_ms()}
        return {'question': dict(image), 'answer': dict(image)}

    @staticmethod
    def complete():
        return {'state': 'complete', 'verdict': 'correct', 'strength': '等价变形正确。',
                'nextStep': '', 'knowledgePoints': ['等价变形'], 'observations': ['两边同时减去了相同的数。']}

    async def test_parallel_same_images_share_one_charge_and_model_then_terminal_replay_is_gone(self):
        prepared = await self.prepare()
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def infer(cfg, question, answer, selected):
            calls.append((question, answer, selected))
            entered.set()
            await release.wait()
            return self.complete()
        with patch.object(self.reviews(), 'infer', side_effect=infer):
            body = self.images()
            path = '/' + prepared['reviewId'] + '/analyse'
            first = asyncio.create_task(self.post(path, body))
            await entered.wait()
            second = asyncio.create_task(self.post(path, body))
            await asyncio.sleep(.06)
            response, _ = await self.post(path, self.images('red'))
            self.assertEqual(response.status, 409)
            release.set()
            outcomes = await asyncio.gather(first, second)
        self.assertEqual(len(calls), 1)
        for response, data in outcomes:
            self.assertEqual(response.status, 200, data)
            self.assertEqual(data['quota']['used'], 1)
            self.assertEqual(data['result'], self.complete())
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
        response, _ = await self.post(path, body)
        self.assertEqual(response.status, 410)
        record = self.reviews().records[prepared['reviewId']]
        self.assertIsNone(record.question)
        self.assertIsNone(record.answer)
        self.assertIsNone(record.result)

    async def test_selection_crops_original_once_and_does_not_charge(self):
        prepared = await self.prepare()
        seen = []
        async def infer(cfg, question, answer, selected):
            seen.append((question.width, question.height, answer.width, selected))
            return ({'state': 'needs_question_selection', 'reason': '题图包含多道题。'}
                    if not selected else self.complete())
        with patch.object(self.reviews(), 'infer', side_effect=infer):
            path = '/' + prepared['reviewId']
            body = self.images()
            response, initial = await self.post(path + '/analyse', body)
            self.assertEqual(response.status, 200, initial)
            self.assertEqual(initial['result']['state'], 'needs_question_selection')
            response, replay = await self.post(path + '/analyse', body)
            self.assertEqual(replay, initial)
            self.assertEqual(len(seen), 1)
            response, _ = await self.post(path + '/selection',
                {'x': 1, 'y': 2, 'width': 5, 'height': 6, 'answer': body['answer']})
            self.assertEqual(response.status, 400)
            response, result = await self.post(path + '/selection', {'x': 1, 'y': 2, 'width': 5, 'height': 6})
        self.assertEqual(response.status, 200, result)
        self.assertEqual(result['quota']['used'], 1)
        self.assertEqual(seen, [(16, 12, 16, False), (5, 6, 16, True)])

    async def test_cancel_before_prepare_and_old_key_cannot_cancel_new_review(self):
        response, cancelled = await self.post('/cancel', {'requestKey': 'old'})
        self.assertEqual((response.status, cancelled), (200, {'cancelled': True}))
        response, _ = await self.post(body={'requestKey': 'old'})
        self.assertEqual(response.status, 410)
        new = await self.prepare('new')
        await self.post('/cancel', {'requestKey': 'old'})
        self.assertEqual(self.reviews().records[new['reviewId']].state, 'prepared')

    async def test_unknown_restart_and_expired_ids_do_not_charge(self):
        prepared = await self.prepare()
        for suffix in ('analyse', 'selection'):
            response, _ = await self.post('/missing/' + suffix, self.images() if suffix == 'analyse' else {})
            self.assertEqual(response.status, 410)
        self.reviews().records.clear()
        response, _ = await self.post('/' + prepared['reviewId'] + '/analyse', self.images())
        self.assertEqual(response.status, 410)
        # Re-create a genuinely new prepared session, then pass its absolute deadline.
        self.reviews().by_key.clear()
        new = await self.prepare('new')
        with patch.object(service, 'now_ms', return_value=new['expiresAt'] + 1):
            response, _ = await self.post('/' + new['reviewId'] + '/analyse', self.images())
            self.assertEqual(response.status, 410)
        response = await self.client.get('/api/banban/quota', headers=self.device_headers)
        self.assertEqual((await response.json())['used'], 0)

    async def test_image_types_sizes_timestamps_and_body_limit_are_checked_before_charge(self):
        prepared = await self.prepare()
        invalid = []
        for key, value in [('width', True), ('width', 17), ('height', 0), ('capturedAt', True),
                           ('dataUrl', 'data:image/png;base64,YmFk'), ('extra', 1)]:
            body = self.images()
            body['answer'][key] = value
            invalid.append(body)
        body = self.images()
        body['answer']['capturedAt'] += 2001
        invalid.append(body)
        body = self.images()
        body['answer']['dataUrl'] += ' '
        invalid.append(body)
        for body in invalid:
            response, data = await self.post('/' + prepared['reviewId'] + '/analyse', body)
            self.assertEqual(response.status, 400, data)
        response = await self.client.post('/api/banban/math-reviews', data=io.BytesIO(b' ' * (6 * 1024 * 1024 + 1)),
            headers=self.device_headers)
        self.assertEqual(response.status, 400)
        response = await self.client.get('/api/banban/quota', headers=self.device_headers)
        self.assertEqual((await response.json())['used'], 0)

    async def test_all_handlers_require_device_identity_and_manual_declaration(self):
        prepared = await self.prepare()
        for suffix, body in [('', {'requestKey': 'new'}), ('/cancel', {'requestKey': 'new'}),
                ('/' + prepared['reviewId'] + '/analyse', self.images()),
                ('/' + prepared['reviewId'] + '/selection', {'x': 0, 'y': 0, 'width': 1, 'height': 1})]:
            response, _ = await self.post(suffix, body, {})
            self.assertEqual(response.status, 401)
            response, _ = await self.post(suffix, body, self.headers(csrf=True))
            self.assertEqual(response.status, 403)
        for route in self.app.router.routes():
            if route.resource.canonical.startswith('/api/banban/math-reviews'):
                self.assertTrue(getattr(route.handler, '__teacher_manual__', ''))

    async def test_body_cannot_override_device_class_or_teacher_and_wrong_class_header_is_rejected(self):
        prepared = await self.prepare()
        for suffix, body in [('', {'requestKey': 'other', 'deviceId': self.device['deviceId']}),
                ('/cancel', {'requestKey': 'synthetic-key', 'classId': self.device['classId']}),
                ('/' + prepared['reviewId'] + '/analyse', {**self.images(), 'teacherId': self.teacher_id})]:
            response, _ = await self.post(suffix, body)
            self.assertEqual(response.status, 400)
        response, _ = await self.post('/' + prepared['reviewId'] + '/analyse', self.images(),
            {**self.device_headers, 'X-ICeClass-Class': 'another-class'})
        self.assertEqual(response.status, 401)
        self.assertEqual(self.reviews().records[prepared['reviewId']].state, 'prepared')

    async def test_png_real_format_file_limit_and_real_pixel_limits(self):
        from PIL import Image
        prepared = await self.prepare()
        invalid = []
        for format, size, declared in [('JPEG', (16, 12), (16, 12)), ('PNG', (1921, 1), (1920, 1))]:
            target = io.BytesIO()
            Image.new('RGB', size, 'white').save(target, format)
            body = self.images()
            body['question'].update(dataUrl='data:image/png;base64,' + base64.b64encode(target.getvalue()).decode(),
                                    width=declared[0], height=declared[1])
            invalid.append(body)
        body = self.images()
        raw = base64.b64decode(body['answer']['dataUrl'].split(',', 1)[1])
        body['answer']['dataUrl'] = 'data:image/png;base64,' + base64.b64encode(raw + b'x' * (2 * 1024 * 1024)).decode()
        invalid.append(body)
        for body in invalid:
            response, data = await self.post('/' + prepared['reviewId'] + '/analyse', body)
            self.assertEqual(response.status, 400, data)
        self.assertEqual(self.reviews().records[prepared['reviewId']].state, 'prepared')

    async def test_model_output_contract_rejects_unknown_fields_bad_types_lengths_and_missing_evidence(self):
        invalid = [dict(self.complete(), observations=[]), dict(self.complete(), knowledgePoints=[]),
            dict(self.complete(), strength='字' * 121), dict(self.complete(), nextStep=True),
            dict(self.complete(), knowledgePoints=['字' * 25]), dict(self.complete(), knowledgePoints=['甲', '乙', '丙']),
            dict(self.complete(), verdict='incorrect', nextStep=''), dict(self.complete(), observations=['字' * 101]),
            dict(self.complete(), strength='一。二。三。'), {'state': 'needs_question_selection', 'reason': '', 'verdict': 'correct'}]
        for index, result in enumerate(invalid):
            prepared = await self.prepare('invalid-output-' + str(index))
            with patch.object(self.reviews(), 'infer', return_value=result):
                response, data = await self.post('/' + prepared['reviewId'] + '/analyse', self.images())
            self.assertEqual(response.status, 502, data)
            record = self.reviews().records[prepared['reviewId']]
            self.assertEqual(record.state, 'failed')
            self.assertIsNone(record.question)

    async def test_selection_bounds_and_single_continuation_do_not_retain_result_after_shutdown(self):
        prepared = await self.prepare()
        with patch.object(self.reviews(), 'infer', return_value={'state': 'needs_question_selection', 'reason': '多道题。'}):
            await self.post('/' + prepared['reviewId'] + '/analyse', self.images())
        for selection in [dict(x=True, y=0, width=2, height=2), dict(x=-1, y=0, width=2, height=2),
                          dict(x=0, y=0, width=0, height=2), dict(x=15, y=0, width=2, height=2)]:
            response, _ = await self.post('/' + prepared['reviewId'] + '/selection', selection)
            self.assertEqual(response.status, 400)
        record = self.reviews().records[prepared['reviewId']]
        self.assertIsNotNone(record.question)
        await self.client.close()
        self.assertIsNone(record.question)
        self.assertIsNone(record.result)
        self.assertEqual(self.reviews().records, {})

    async def test_cancel_during_inference_erases_images_and_discards_late_return(self):
        prepared = await self.prepare()
        entered = asyncio.Event()
        async def infer(*args):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                return self.complete()
        with patch.object(self.reviews(), 'infer', side_effect=infer):
            first = asyncio.create_task(self.post('/' + prepared['reviewId'] + '/analyse', self.images()))
            await entered.wait()
            response, _ = await self.post('/cancel', {'requestKey': 'synthetic-key'})
            self.assertEqual(response.status, 200)
            response, _ = await first
            self.assertEqual(response.status, 410)
        record = self.reviews().records[prepared['reviewId']]
        self.assertEqual(record.state, 'cancelled')
        self.assertIsNone(record.question)
        self.assertIsNone(record.result)

    async def test_cancel_after_model_completion_before_http_response_discards_result(self):
        prepared = await self.prepare()
        entered, release = asyncio.Event(), asyncio.Event()
        original_wait = self.reviews().wait
        async def delayed_wait(request, user, owner, record, task):
            await task
            entered.set()
            await release.wait()
            return await original_wait(request, user, owner, record, task)
        with patch.object(self.reviews(), 'infer', return_value=self.complete()), \
                patch.object(self.reviews(), 'wait', side_effect=delayed_wait):
            first = asyncio.create_task(self.post('/' + prepared['reviewId'] + '/analyse', self.images()))
            await entered.wait()
            await self.post('/cancel', {'requestKey': 'synthetic-key'})
            release.set()
            response, _ = await first
        self.assertEqual(response.status, 410)

    async def test_invalid_model_output_fails_closed_and_never_persists_images_or_text(self):
        prepared = await self.prepare()
        result = {**self.complete(), 'score': 100}
        with patch.object(self.reviews(), 'infer', return_value=result):
            response, data = await self.post('/' + prepared['reviewId'] + '/analyse', self.images())
        self.assertEqual(response.status, 502)
        self.assertNotIn('score', str(data))
        self.assertEqual(self.reviews().records[prepared['reviewId']].state, 'failed')
        db = self.app[service.STORE_KEY]
        self.assertEqual(db.one('SELECT COUNT(*) n FROM banban_conversation_messages')['n'], 0)
        self.assertEqual(db.one('SELECT COUNT(*) n FROM banban_operations')['n'], 0)
        self.assertFalse(any('math-review' in path.name for path in __import__('pathlib').Path(self.temp.name).rglob('*')))

    async def test_device_stop_cancels_review_and_frees_slot(self):
        prepared = await self.prepare()
        response = await self.client.post('/api/receiver/computer/stop', json={'classId': self.device['classId']},
            headers={**self.device_headers}, params={'deviceId': self.device['deviceId']})
        self.assertEqual(response.status, 200, await response.text())
        response, _ = await self.post('/' + prepared['reviewId'] + '/analyse', self.images())
        self.assertEqual(response.status, 410)
        await self.prepare('after-stop')

    async def additional_device(self):
        response, code = await self.json_request('POST', f"/api/classes/{self.device['classId']}/enrollment-code", {}, csrf=True)
        self.assertEqual(response.status, 200, code)
        response, device = await self.json_request('POST', '/api/device/enroll', {'code': code['code'], 'deviceName': '虚构第二设备'})
        self.assertEqual(response.status, 200, device)
        headers = {'Authorization': 'Bearer ' + device['deviceToken'], 'X-ICeClass-Device': device['deviceId'],
                   'X-ICeClass-Class': device['classId']}
        response = await self.client.get('/api/session', headers=headers)
        headers['X-CSRF-Token'] = (await response.json())['user']['csrfToken']
        return headers

    async def test_other_device_cannot_access_and_teacher_reassignment_cancels_active_inputs(self):
        prepared = await self.prepare()
        other = await self.additional_device()
        for suffix, body in [('analyse', self.images()), ('selection', {'x': 0, 'y': 0, 'width': 1, 'height': 1})]:
            response, _ = await self.post('/' + prepared['reviewId'] + '/' + suffix, body, other)
            self.assertEqual(response.status, 403)
        with patch.object(self.reviews(), 'infer', return_value={'state': 'needs_question_selection', 'reason': '多道题。'}):
            response, _ = await self.post('/' + prepared['reviewId'] + '/analyse', self.images())
            self.assertEqual(response.status, 200)
        self.app[service.STORE_KEY].run('UPDATE users SET updated_at=updated_at+1 WHERE id=?', (self.teacher_id,))
        await asyncio.sleep(.35)
        record = self.reviews().records[prepared['reviewId']]
        self.assertEqual(record.state, 'cancelled')
        self.assertIsNone(record.question)
        response, _ = await self.post('/' + prepared['reviewId'] + '/selection', {'x': 0, 'y': 0, 'width': 1, 'height': 1})
        self.assertEqual(response.status, 401)

    async def test_global_active_limit_and_terminal_capacity_never_evict_valid_markers(self):
        await self.prepare()
        for i in range(7):
            headers = await self.additional_device()
            response, data = await self.post(body={'requestKey': f'other-{i}'}, headers=headers)
            self.assertEqual(response.status, 200, data)
        ninth = await self.additional_device()
        response, _ = await self.post(body={'requestKey': 'ninth'}, headers=ninth)
        self.assertEqual(response.status, 409)
        # Existing cancellation works at every capacity; new tombstones also count.
        await self.post('/cancel', {'requestKey': 'synthetic-key'})
        for i in range(248):
            response, data = await self.post('/cancel', {'requestKey': f'tombstone-{i}'})
            self.assertEqual(response.status, 200, data)
        response, _ = await self.post('/cancel', {'requestKey': 'overflow'})
        self.assertEqual(response.status, 409)
        response, _ = await self.post(body={'requestKey': 'after-cancel'})
        self.assertEqual(response.status, 409)
        response, _ = await self.post('/cancel', {'requestKey': 'synthetic-key'})
        self.assertEqual(response.status, 200)
        self.assertEqual(len(self.reviews().records), 256)

    async def test_quota_checked_at_admission_but_selection_and_cancel_are_free_when_exhausted(self):
        db = self.app[service.STORE_KEY]
        db.run('UPDATE banban_quota_policy SET device_limit=1')
        prepared = await self.prepare()
        with patch.object(self.reviews(), 'infer', return_value={'state': 'needs_question_selection', 'reason': '多道题。'}):
            response, first = await self.post('/' + prepared['reviewId'] + '/analyse', self.images())
        self.assertEqual((response.status, first['quota']['remaining']), (200, 0))
        with patch.object(self.reviews(), 'infer', return_value=self.complete()):
            response, second = await self.post('/' + prepared['reviewId'] + '/selection', {'x': 0, 'y': 0, 'width': 3, 'height': 4})
        self.assertEqual((response.status, second['quota']['used']), (200, 1))
        response, _ = await self.post('/cancel', {'requestKey': 'synthetic-key'})
        self.assertEqual(response.status, 200)
        response, result = await self.post(body={'requestKey': 'exhausted'})
        self.assertEqual(response.status, 429)
        self.assertEqual(result['code'], 'banban_quota_exhausted')
        self.assertGreater(int(response.headers['Retry-After']), 0)
        response, _ = await self.post('/cancel', {'requestKey': 'exhausted'})
        self.assertEqual(response.status, 200)

    async def test_quota_exhausted_between_prepare_and_analyse_never_calls_model(self):
        prepared = await self.prepare()
        self.app[service.STORE_KEY].run('UPDATE banban_quota_policy SET device_limit=0')
        with patch.object(self.reviews(), 'infer', side_effect=AssertionError('must not infer')):
            response, data = await self.post('/' + prepared['reviewId'] + '/analyse', self.images())
        self.assertEqual(response.status, 429, data)
        self.assertEqual(self.reviews().records[prepared['reviewId']].state, 'prepared')

    async def test_selection_parallel_same_crop_joins_and_different_crop_conflicts(self):
        prepared = await self.prepare()
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def infer(cfg, question, answer, selected):
            calls.append(selected)
            if not selected:
                return {'state': 'needs_question_selection', 'reason': '多道题。'}
            entered.set()
            await release.wait()
            # A second ambiguity must terminate, never ask for a third call.
            return {'state': 'needs_question_selection', 'reason': '仍不完整。'}
        with patch.object(self.reviews(), 'infer', side_effect=infer):
            path = '/' + prepared['reviewId']
            images = self.images()
            await self.post(path + '/analyse', images)
            crop = {'x': 0, 'y': 0, 'width': 4, 'height': 3}
            first = asyncio.create_task(self.post(path + '/selection', crop))
            await entered.wait()
            second = asyncio.create_task(self.post(path + '/selection', crop))
            await asyncio.sleep(.06)
            response, _ = await self.post(path + '/selection', {**crop, 'x': 1})
            self.assertEqual(response.status, 409)
            response, _ = await self.post(path + '/analyse', images)
            self.assertEqual(response.status, 409)
            release.set()
            for response, data in await asyncio.gather(first, second):
                self.assertEqual(response.status, 200, data)
                self.assertEqual(data['result']['verdict'], 'uncertain')
                self.assertEqual(data['quota']['used'], 1)
        self.assertEqual(calls, [False, True])

    async def test_timeout_and_malformed_provider_payload_release_inputs_with_sanitized_errors(self):
        for key, error, want in [('timeout', asyncio.TimeoutError('private upstream text'), 504),
                                 ('bad-provider', AttributeError('private upstream text'), 502)]:
            prepared = await self.prepare(key)
            with patch.object(self.reviews(), 'infer', side_effect=error):
                response, data = await self.post('/' + prepared['reviewId'] + '/analyse', self.images())
            self.assertEqual(response.status, want, data)
            self.assertNotIn('private', str(data))
            record = self.reviews().records[prepared['reviewId']]
            self.assertEqual(record.state, 'failed')
            self.assertIsNone(record.question)

    async def test_abnormal_http_disconnect_cancels_wait_and_releases_inputs(self):
        prepared = await self.prepare()
        entered, cancelled = asyncio.Event(), asyncio.Event()
        async def infer(*args):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        with patch.object(self.reviews(), 'infer', side_effect=infer):
            request = asyncio.create_task(self.post('/' + prepared['reviewId'] + '/analyse', self.images()))
            await entered.wait()
            request.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await request
            await asyncio.wait_for(cancelled.wait(), 2)
        record = self.reviews().records[prepared['reviewId']]
        self.assertEqual(record.state, 'cancelled')
        self.assertIsNone(record.question)

    async def wait_until(self, predicate):
        for _ in range(200):
            if predicate():
                return
            await asyncio.sleep(.01)
        self.fail('Expected asynchronous transition did not happen')

    async def disconnected_decode(self, handler_cancellation):
        import banban_math_reviews
        self.client.server.runner.server.handler_cancellation = handler_cancellation
        prepared = await self.prepare()
        record = self.reviews().records[prepared['reviewId']]
        loop = asyncio.get_running_loop()
        entered, finished = asyncio.Event(), asyncio.Event()
        release = threading.Event()
        requests, calls = [], []
        real_decode, real_body = banban_math_reviews.decode_pair, self.reviews().body
        async def capture_body(request):
            requests.append(request)
            return await real_body(request)
        def delayed_decode(body):
            loop.call_soon_threadsafe(entered.set)
            if not release.wait(5):
                raise RuntimeError('test decode gate timed out')
            try:
                return real_decode(body)
            finally:
                loop.call_soon_threadsafe(finished.set)
        async def infer(*args):
            calls.append('model_called')
            await asyncio.Event().wait()
        with patch('banban_math_reviews.decode_pair', side_effect=delayed_decode), \
                patch.object(self.reviews(), 'body', side_effect=capture_body), \
                patch.object(self.reviews(), 'infer', side_effect=infer):
            pending = asyncio.create_task(self.post('/' + prepared['reviewId'] + '/analyse', self.images()))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                pending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await pending
                await self.wait_until(lambda: requests[0].transport is None or requests[0].transport.is_closing())
            finally:
                release.set()
            await asyncio.wait_for(finished.wait(), 2)
            # A False handler can finish the thread before its continuation runs;
            # True cancels the handler immediately, so both need loop turns here.
            await asyncio.sleep(.2)
            quota = self.reviews().f.quotas.status(self.reviews().authorize(requests[0])[0])
            actual = {'handler_cancellation': handler_cancellation, 'used': quota['used'],
                      'calls': len(calls), 'state': record.state}
            self.assertEqual(actual, {'handler_cancellation': handler_cancellation, 'used': 0,
                                      'calls': 0, 'state': 'cancelled'})
            self.assertIsNone(record.question)
            self.assertIsNone(record.answer)
            self.assertIsNone(record.result)
        await self.prepare('after-disconnect')

    async def test_production_disconnect_during_decode_never_charges_or_calls_model(self):
        await self.disconnected_decode(False)

    async def test_handler_cancellation_during_decode_releases_prepared_record(self):
        await self.disconnected_decode(True)

    async def disconnected_upload(self, selection=False):
        prepared = await self.prepare()
        record = self.reviews().records[prepared['reviewId']]
        calls = []
        async def infer(*args):
            calls.append('model_called')
            return {'state': 'needs_question_selection', 'reason': '多道题。'}
        with patch.object(self.reviews(), 'infer', side_effect=infer):
            if selection:
                response, _ = await self.post('/' + prepared['reviewId'] + '/analyse', self.images())
                self.assertEqual(response.status, 200)
            uploaded = asyncio.Event()
            requests = []
            real_body = self.reviews().body
            async def capture_body(request):
                requests.append(request)
                return await real_body(request)
            async def upload():
                yield b'{'
                uploaded.set()
                await asyncio.Event().wait()
            with patch.object(self.reviews(), 'body', side_effect=capture_body):
                pending = asyncio.create_task(self.client.post('/api/banban/math-reviews/' + prepared['reviewId'] +
                    ('/selection' if selection else '/analyse'), data=upload(), headers=self.device_headers))
                await asyncio.wait_for(uploaded.wait(), 2)
                await self.wait_until(lambda: bool(requests))
                pending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await pending
                await self.wait_until(lambda: requests[0].transport is None or requests[0].transport.is_closing())
                await asyncio.sleep(.1)
            quota = self.reviews().f.quotas.status(self.reviews().authorize(requests[0])[0])
            self.assertEqual({'used': quota['used'], 'calls': len(calls), 'state': record.state},
                {'used': 1 if selection else 0, 'calls': 1 if selection else 0, 'state': 'cancelled'})
            self.assertIsNone(record.question)
            self.assertIsNone(record.answer)
            self.assertIsNone(record.result)

    async def test_production_disconnect_during_upload_releases_prepared_record(self):
        await self.disconnected_upload()

    async def test_production_disconnect_during_selection_upload_releases_original_inputs(self):
        await self.disconnected_upload(selection=True)

    async def test_real_service_restart_rejects_prior_id_without_charging(self):
        prepared = await self.prepare()
        await self.client.close()
        self.app = service.create_app(__import__('pathlib').Path(self.temp.name) / 'test.db')
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        for suffix, body in [('analyse', self.images()), ('selection', {'x': 0, 'y': 0, 'width': 1, 'height': 1})]:
            response, _ = await self.post('/' + prepared['reviewId'] + '/' + suffix, body)
            self.assertEqual(response.status, 410)
        response = await self.client.get('/api/banban/quota', headers=self.device_headers)
        self.assertEqual((await response.json())['used'], 0)

    async def test_real_provider_request_labels_two_images_has_no_tools_and_bounds_output(self):
        captured = []
        async def upstream(request):
            captured.append(await request.json())
            return web.json_response({'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(self.complete())}}]})
        app = web.Application()
        app.router.add_post('/chat/completions', upstream)
        upstream_server = TestServer(app)
        await upstream_server.start_server()
        try:
            prepared = await self.prepare()
            body = self.images()
            with patch('banban_math_reviews.completion_url', return_value=str(upstream_server.make_url('/chat/completions'))), \
                    patch('banban_math_reviews.upstream_connector', side_effect=TCPConnector):
                response, data = await self.post('/' + prepared['reviewId'] + '/analyse', body)
            self.assertEqual(response.status, 200, data)
            payload = captured[0]
            self.assertEqual(payload['max_tokens'], 1600)
            self.assertNotIn('tools', payload)
            content = payload['messages'][1]['content']
            self.assertIn('题目', content[0]['text'])
            self.assertIn('学生作答', content[2]['text'])
            self.assertEqual(content[1]['image_url']['url'], body['question']['dataUrl'])
            self.assertEqual(content[3]['image_url']['url'], body['answer']['dataUrl'])
        finally:
            await upstream_server.close()

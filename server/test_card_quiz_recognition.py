"""Screenshot recognition through the school HTTP service, using synthetic images and accounts."""
import asyncio
import base64
import io
import json
import struct
import zlib
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

from aiohttp import ClientTimeout, TCPConnector, web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image, ImageDraw

import app as service
import card_quiz_recognition as recognition
from banban_connections import completion_url
from teacher_capabilities import undeclared_routes
from test_card_quiz import CardQuizHttpCase


PATH = '/questions/recognize'
ROUTE = '/api/card-quiz' + PATH
BOXES = [[25, 25, 900, 250], [25, 350, 850, 250], [25, 675, 900, 300]]


def drafts():
    return [
        {'type': 'single', 'text': '2 + 2 等于多少？', 'options': ['3', '4'], 'answer': 'B',
         'tags': ['整数加法'], 'bounds': BOXES[0], 'reviewNote': ''},
        {'type': 'boolean', 'text': '判断 3 > 1 是否成立。', 'options': ['正确', '错误'], 'answer': 'A',
         'tags': ['整数大小比较'], 'bounds': BOXES[1], 'reviewNote': ''},
        {'type': 'multiple', 'text': '选出小于 5 的数。', 'options': ['2', '7', '4'], 'answer': 'AC',
         'tags': ['整数比较'], 'bounds': BOXES[2], 'reviewNote': ''},
    ]


def envelope(result, finish='stop'):
    return {'choices': [{'finish_reason': finish, 'message': {'role': 'assistant', 'content': json.dumps(result)}}]}


def complete(items):
    return {'state': 'complete', 'questionCount': len(items), 'drafts': items}


def data_url(raw, fmt='png'):
    return 'data:image/' + fmt + ';base64,' + base64.b64encode(raw).decode('ascii')


def screenshot(fmt='PNG', color='white'):
    with Image.new('RGB', (400, 240), color) as image:
        pen = ImageDraw.Draw(image)
        for (x, y, w, h), text in zip(BOXES, ['1. 2 + 2 = ?  A: 3  B: 4', '2. 3 > 1. True / False',
                                              '3. Which numbers are < 5? A: 2  B: 7  C: 4']):
            left, top = x * image.width // 1000, y * image.height // 1000
            pen.rectangle((left, top, left + w * image.width // 1000 - 1, top + h * image.height // 1000 - 1),
                          outline='black')
            pen.text((left + 6, top + 5), text, fill='black')
        output = io.BytesIO()
        image.save(output, format=fmt)
    return data_url(output.getvalue(), fmt.lower())


class RecognitionTests(CardQuizHttpCase):
    async def asyncSetUp(self):
        env = patch.dict('os.environ', {'DEEPSEEK_API_KEY': '', 'ICECLASS_DEEPSEEK_MODEL': 'fixture'})
        env.start()
        self.addCleanup(env.stop)
        await super().asyncSetUp()
        self.uid, self.teacher = await self.account('recognition-teacher', head=[self.cid])
        self.body = {'subjectId': 'math', 'dataUrl': screenshot(), 'requestKey': 'quiz-1'}
        response, data = await self.json_request('PUT', '/api/banban/settings', {
            'enabled': True, 'baseUrl': 'https://school.example.org/v1', 'model': 'school-vision',
            'apiKey': 'synthetic-school'}, csrf=True)
        self.assertEqual(response.status, 200, data)
        self.calls, self.destinations = [], []
        self.envelope = envelope(complete(drafts()))
        self.model_reply = None
        upstream = web.Application(client_max_size=4 * 1024 * 1024)
        upstream.router.add_route('*', '/{path:.*}', self.model_endpoint)
        self.model_server = TestServer(upstream)
        await self.model_server.start_server()
        self.addAsyncCleanup(self.model_server.close)

        def fixture_url(cfg):
            # Validate the actual configured destination before routing the HTTP exchange to the fixture.
            target = completion_url(cfg)
            self.destinations.append(target)
            return str(self.model_server.make_url(urlsplit(target).path))

        for replacement in (patch.object(recognition, 'completion_url', side_effect=fixture_url),
                            patch.object(recognition, 'upstream_connector', side_effect=TCPConnector)):
            replacement.start()
            self.addCleanup(replacement.stop)

    async def model_endpoint(self, request):
        payload = await request.json() if request.method == 'POST' else {}
        self.calls.append((request.headers.get('Authorization'), request.headers.get('Cookie'), payload))
        if self.model_reply:
            return await self.model_reply(request, payload)
        response = web.json_response(self.envelope)
        response.set_cookie('provider-session', 'synthetic-upstream-cookie')
        return response

    @contextmanager
    def paused_model(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def delayed(request, payload):
            entered.set()
            await release.wait()
            return web.json_response(self.envelope)

        self.model_reply = delayed
        try:
            yield entered
        finally:
            release.set()
            self.model_reply = None

    async def quota(self, headers=None):
        response = await self.client.get('/api/banban/quota', headers=headers or self.teacher)
        self.assertEqual(response.status, 200)
        return (await response.json())['used']

    async def personal(self, **changes):
        response = await self.client.put('/api/banban/connection', headers=self.teacher, json={
            'source': 'personal', 'enabled': True, 'model': 'personal-vision',
            'baseUrl': 'https://personal.example.org/custom/v1', 'apiKey': 'synthetic-personal', **changes})
        self.assertEqual(response.status, 200, await response.text())

    async def recognize(self, body=None, *, status=200, headers=None):
        return await self.api('POST', PATH, self.body if body is None else body, status,
                              self.teacher if headers is None else headers)

    async def test_only_logged_in_staff_with_csrf_can_submit(self):
        await self.recognize(status=401, headers={})
        await self.recognize(status=403, headers={'Cookie': self.teacher['Cookie']})
        await self.recognize(status=403, headers={**self.teacher, 'X-CSRF-Token': 'incorrect'})
        await self.recognize(status=401, headers={**self.teacher, **self.dh})
        classroom = {'Authorization': self.dh['Authorization'], 'X-ICeClass-Device': self.device['deviceId'],
                     'X-ICeClass-Class': self.cid}
        response = await self.client.get('/api/session', headers=classroom)
        classroom['X-CSRF-Token'] = (await response.json())['user']['csrfToken']
        await self.recognize(status=401, headers=classroom)
        await self.initialize()
        path = f'/classes/{self.cid}/students'
        state = await self.api('GET', path)
        versions = {key: state[key] for key in ('revision', 'rosterRevision', 'cardRevision')}
        credential = (await self.api('POST', path, {**versions, 'entryYear': 2026, 'classCode': '101'}))['credentials'][0]
        response = await self.client.post('/api/student/login', json={
            'username': credential['username'], 'password': credential['password']})
        await self.recognize(status=401, headers={'Cookie': response.headers['Set-Cookie'].split(';', 1)[0],
                                                  'X-CSRF-Token': (await response.json())['student']['csrfToken']})
        route = next(r for r in self.app.router.routes() if r.method == 'POST' and r.resource.canonical == ROUTE)
        self.assertIn('本人', route.handler.__teacher_manual__)
        self.assertEqual(undeclared_routes(self.app), [])
        self.assertEqual(self.db.all('SELECT * FROM banban_quota_usage'), [])
        self.assertFalse(self.calls)

    async def test_personal_vision_connection_returns_complete_reviewable_drafts_only(self):
        await self.personal()
        items = drafts()
        items[2]['answer'] = 'CA'
        self.envelope = envelope(complete(items))
        result = await self.recognize()
        self.assertEqual(result, {'drafts': drafts()})
        self.assertEqual(self.destinations, ['https://personal.example.org/custom/v1/chat/completions'])
        [(auth, cookie, payload)] = self.calls
        self.assertEqual((auth, cookie, payload['model']), ('Bearer synthetic-personal', None, 'personal-vision'))
        self.assertFalse(payload['stream'])
        self.assertNotIn('tools', payload)
        self.assertGreater(payload['max_tokens'], 0)
        self.assertLessEqual(payload['max_tokens'], 8192)
        prompt, message = payload['messages']
        self.assertEqual((prompt['role'], message['role']), ('system', 'user'))
        instruction, image = message['content']
        self.assertIn('数学', instruction['text'])
        self.assertEqual(image, {'type': 'image_url', 'image_url': {'url': self.body['dataUrl']}})
        self.assertNotIn(self.uid, json.dumps(payload))
        self.assertNotIn(self.teacher['X-CSRF-Token'], json.dumps(payload))
        # Width/height round-trip to three individual, complete bordered regions of the fixture.
        with Image.open(io.BytesIO(base64.b64decode(self.body['dataUrl'].split(',')[1]))) as original:
            for item in result['drafts']:
                x, y, w, h = item['bounds']
                box = (x * original.width // 1000, y * original.height // 1000,
                       (x + w) * original.width // 1000, (y + h) * original.height // 1000)
                with original.crop(box) as crop:
                    self.assertEqual(crop.getpixel((0, 0)), (0, 0, 0))
                    self.assertEqual(crop.getpixel((crop.width - 1, crop.height - 1)), (0, 0, 0))
        self.assertEqual(await self.quota(), 1)
        for table in ('card_quiz_questions', 'card_quiz_question_versions', 'card_quiz_images',
                      'banban_conversation_messages', 'banban_operations'):
            self.assertEqual(self.db.one(f'SELECT COUNT(*) AS n FROM {table}')['n'], 0)
        persisted = '\n'.join(self.db.db.iterdump())
        self.assertNotIn(self.body['dataUrl'].split(',')[1], persisted)
        self.assertNotIn(items[0]['text'], persisted)

    async def test_confirming_a_draft_twice_keeps_one_question_and_one_crop(self):
        key = {'requestKey': 'reviewed-draft-1'}
        upload = {**key, 'dataUrl': self.body['dataUrl']}
        image = await self.api('POST', '/images', upload, headers=self.teacher)
        self.assertEqual(await self.api('POST', '/images', upload, headers=self.teacher), image)
        await self.api('POST', '/images', {**key, 'dataUrl': screenshot(color='gray')}, 409, self.teacher)
        value = {**drafts()[0], 'subjectId': 'math', 'imageId': image['id']}
        question = await self.api('POST', '/questions', {**key, 'value': value}, headers=self.teacher)
        self.assertEqual(await self.api('POST', '/questions', {**key, 'value': value}, headers=self.teacher), question)
        await self.api('POST', '/questions', {**key, 'value': {**value, 'text': '已改题干'}}, 409, self.teacher)
        self.assertEqual((await self.api('GET', '/questions', headers=self.teacher))['questions'], [question])
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM card_quiz_images')['n'], 1)
        other_image = await self.api('POST', '/images', upload)
        self.assertNotEqual(other_image, image)
        other = await self.api('POST', '/questions', {**key, 'value': {**value, 'imageId': other_image['id']}})
        self.assertNotEqual(other['id'], question['id'])

    async def test_same_key_is_scoped_to_teacher_and_bound_to_subject_and_image(self):
        await self.personal()
        _, other = await self.account('another-teacher', teaching=[self.cid])
        first = await self.recognize()
        for change in ({'subjectId': 'physics'}, {'dataUrl': screenshot(color='yellow')}):
            error = await self.recognize({**self.body, **change}, status=409)
            self.assertEqual(error['code'], 'recognition_key_conflict')
        items = drafts()
        items[0]['reviewNote'] = '请核对另一份试题。'
        self.envelope = envelope(complete(items))
        other_result = await self.recognize({**self.body, 'dataUrl': screenshot('JPEG')}, headers=other)
        self.assertEqual(other_result, {'drafts': items})
        self.assertEqual(await self.recognize(), first)
        self.assertEqual([(auth, cookie, body['model']) for auth, cookie, body in self.calls], [
            ('Bearer synthetic-personal', None, 'personal-vision'), ('Bearer synthetic-school', None, 'school-vision')])
        self.assertEqual(self.destinations[-1], 'https://school.example.org/v1/chat/completions')
        self.assertEqual((await self.quota(), await self.quota(other)), (1, 1))

    async def test_concurrent_retries_share_the_paid_request_and_busy_rejections_are_free(self):
        _, other = await self.account('capacity-teacher', teaching=[self.cid])
        with self.paused_model() as entered:
            first = asyncio.create_task(self.recognize())
            await asyncio.wait_for(entered.wait(), 5)
            retry = asyncio.create_task(self.recognize())
            error = await self.recognize({**self.body, 'requestKey': 'other-key'}, status=429)
            self.assertEqual(error['code'], 'recognition_busy')
            response = await self.client.put('/api/banban/connection', headers=self.teacher, json={'source': 'school'})
            self.assertEqual(response.status, 409)
            await self.recognize({**self.body, 'subjectId': 'physics'}, status=409)
            with patch.object(recognition, 'MAX_ACTIVE', 1):
                await self.recognize(headers=other, status=429)
            self.assertEqual((await self.quota(), await self.quota(other)), (1, 0))
        self.assertEqual(await first, await retry)
        self.assertEqual(len(self.calls), 1)
        await self.recognize({**self.body, 'requestKey': 'other-key'})
        self.assertEqual(len(self.calls), 2)

    async def test_config_validation_quota_and_replay_follow_existing_banban_rules(self):
        await self.personal(enabled=False)
        error = await self.recognize(status=409)
        self.assertEqual(error['code'], 'recognition_connection')
        await self.personal()
        self.db.run("UPDATE banban_connections SET base_url='http://127.0.0.1' WHERE user_id=?", (self.uid,))
        error = await self.recognize(status=409)
        self.assertEqual(error['code'], 'recognition_connection')
        self.assertEqual(await self.quota(), 0)
        self.assertFalse(self.calls)
        await self.personal()
        self.db.run('UPDATE banban_quota_policy SET account_limit=1')
        first = await self.recognize()
        response = await self.client.post(ROUTE, json={**self.body, 'requestKey': 'over-quota'}, headers=self.teacher)
        exhausted = await response.json()
        self.assertEqual((response.status, exhausted['code'], exhausted['quota']['remaining']), (429, 'banban_quota_exhausted', 0))
        self.assertGreater(int(response.headers['Retry-After']), 0)
        self.assertEqual(await self.recognize(), first)
        self.assertEqual(len(self.calls), 1)
        self.db.run('UPDATE banban_quota_policy SET account_limit=2')
        await self.recognize({**self.body, 'requestKey': 'over-quota'})
        self.assertEqual(await self.quota(), 2)

    async def test_receipt_write_failure_rolls_back_the_debit_before_any_provider_request(self):
        self.db.run('''CREATE TEMP TRIGGER refuse_receipt BEFORE INSERT ON card_quiz_recognition_requests
                       BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END''')
        with self.assertLogs('iceclass', level='ERROR') as logs:
            await self.recognize(status=500)
        self.assertNotIn(self.body['dataUrl'], str(logs.output))
        self.assertEqual((len(self.calls), await self.quota()), (0, 0))
        self.db.run('DROP TRIGGER refuse_receipt')
        await self.recognize()
        self.assertEqual((len(self.calls), await self.quota()), (1, 1))

    async def test_input_type_bytes_dimensions_and_size_checked_before_quota(self):
        png = base64.b64decode(self.body['dataUrl'].split(',')[1])
        cases = [
            ({'subjectId': 'unknown'}, 400), ({'requestKey': ''}, 400), ({'requestKey': 'x' * 129}, 400),
            ({'userId': self.uid}, 400), ({'apiKey': 'untrusted'}, 400), ({'dataUrl': None}, 400),
            ({'dataUrl': 'https://school.example.org/image'}, 400), ({'dataUrl': 'data:image/png;base64,????'}, 400),
            ({'dataUrl': data_url(png, 'jpeg')}, 400), ({'dataUrl': data_url(png[:40])}, 400),
            ({'dataUrl': data_url(png, 'gif')}, 400), ({'dataUrl': data_url(b'z' * (2 * 1024 * 1024 + 1))}, 413),
        ]
        for change, status in cases:
            with self.subTest(field=next(iter(change)), status=status):
                await self.recognize({**self.body, **change}, status=status)
        with patch.object(recognition, 'MAX_PIXELS', 40):
            await self.recognize(status=400)
        with Image.new('RGB', (12, 12), 'white') as page, Image.new('RGB', (12, 12), 'black') as other:
            frames = io.BytesIO()
            page.save(frames, 'PNG', save_all=True, append_images=[other], duration=100)
            await self.recognize({**self.body, 'dataUrl': data_url(frames.getvalue())}, status=400)
        self.assertEqual(await self.quota(), 0)
        self.assertFalse(self.calls)
        # Valid PNG with an exactly sized ancillary chunk and its actual CRC.
        padding = b' ' * (2 * 1024 * 1024 - len(png) - 12)
        chunk_data = b'paDd' + padding
        padded = png[:-12] + struct.pack('>I', len(padding)) + chunk_data + struct.pack('>I', zlib.crc32(chunk_data)) + png[-12:]
        for key, url in [('limit', data_url(padded)), ('jpeg', screenshot('JPEG')), ('webp', screenshot('WEBP'))]:
            await self.recognize({**self.body, 'requestKey': key, 'dataUrl': url})
        self.assertEqual(await self.quota(), 3)

    async def test_chunked_request_cap_and_invalid_json_are_reported_before_model_admission(self):
        async def oversized_body():
            for _ in range(50):
                yield b' ' * 65536

        headers = {**self.teacher, 'Content-Type': 'application/json'}
        response = await self.client.post(ROUTE, data=oversized_body(), headers=headers)
        self.assertEqual(response.status, 413, await response.text())
        for raw in (b'{}', b'[]', b'{"subjectId":' + b'9' * 5000 + b'}', b'{"dataUrl":"\xff"}'):
            response = await self.client.post(ROUTE, data=raw, headers=headers)
            self.assertEqual(response.status, 400, await response.text())
        self.assertEqual((len(self.calls), await self.quota()), (0, 0))

    async def test_rotated_jpeg_model_uses_the_displayed_original_coordinate_system(self):
        with Image.open(io.BytesIO(base64.b64decode(self.body['dataUrl'].split(',')[1]))) as original:
            with original.transpose(Image.Transpose.ROTATE_90) as stored:
                exif = Image.Exif()
                exif[274] = 6
                output = io.BytesIO()
                stored.save(output, 'JPEG', exif=exif)
        self.assertEqual((await self.recognize({**self.body, 'dataUrl': data_url(output.getvalue(), 'jpeg')}))['drafts'],
                         drafts())
        url = self.calls[0][2]['messages'][1]['content'][1]['image_url']['url']
        with Image.open(io.BytesIO(base64.b64decode(url.split(',')[1]))) as shown:
            self.assertEqual(shown.size, (400, 240))
            self.assertEqual(shown.getexif().get(274, 1), 1)
            self.assertLess(max(shown.getpixel((10, 6))), 90)

    async def test_missing_suggestions_and_complex_notation_keep_each_original_box(self):
        items = drafts()
        items[0].update(text=r'如图，计算 \(\sum_{i=1}^{n}a_i\) 的值。', options=[r'\sqrt{x+y}', '2'],
                        answer=None, tags=[' 数学 ', '选择题'], reviewNote='')
        items[1].update(text='根据原图表格判断命题。', reviewNote='请核对原图表头和单位。')
        items[2].update(text=r'选出满足 \(x \leq \sqrt{9}\) 的数。', options=[r'$\frac{1}{2}$', '7', '2'])
        self.envelope = envelope(complete(items))
        result = (await self.recognize())['drafts']
        self.assertEqual([row['bounds'] for row in result], BOXES)
        self.assertIn('如图', result[0]['text'])
        self.assertIn('原图', result[0]['text'])
        self.assertIn('原图', result[0]['options'][0])
        self.assertNotIn('\\', json.dumps(result, ensure_ascii=False))
        self.assertIsNone(result[0]['answer'])
        self.assertEqual(result[0]['tags'], [])
        for word in ('原图', '答案', '知识点'):
            self.assertIn(word, result[0]['reviewNote'])
        self.assertEqual(result[1], items[1])
        self.assertEqual(result[2]['text'], '选出满足 x ≤ √(9) 的数。')
        self.assertEqual(result[2]['options'], ['(1/2)', '7', '2'])

    async def test_incomplete_mixed_unsupported_or_unreadable_pages_never_return_partial_drafts(self):
        first, second, _ = drafts()
        cases = [
            ({'state': 'unsupported', 'questionIndex': 2}, 'recognition_unsupported'),
            ({'state': 'unreadable', 'questionIndex': 1}, 'recognition_unreadable'),
            ({'state': 'too_many'}, 'recognition_too_many'),
            ({**complete([first]), 'questionCount': 2}, 'recognition_incomplete'),
            (complete([]), 'recognition_unreadable'), (complete([first] * 9), 'recognition_too_many'),
            (complete([first, {**second, 'type': 'essay'}]), 'recognition_unsupported'),
            (complete([{**first, 'options': list('abcde')}]), 'recognition_unsupported'),
            (complete([first, {**second, 'bounds': first['bounds']}]), 'recognition_bounds'),
            (complete([first, {**second, 'bounds': [0, 0, 1000, 1000]}]), 'recognition_bounds'),
        ]
        for i, (output, code) in enumerate(cases):
            with self.subTest(i=i):
                self.envelope = envelope(output)
                body = {**self.body, 'requestKey': str(i)}
                error = await self.recognize(body, status=422)
                self.assertEqual(set(error), {'code', 'error'})
                self.assertEqual(error['code'], code)
                self.assertEqual(await self.recognize(body, status=422), error)
        self.assertEqual((len(self.calls), await self.quota()), (len(cases), len(cases)))

    async def test_eight_questions_return_in_reading_order_with_width_and_height_intact(self):
        items = [{**drafts()[0], 'text': f'第 {i + 1} 题', 'bounds': [10, i * 125, 950, 120]} for i in range(8)]
        self.envelope = envelope(complete(items))
        self.assertEqual(await self.recognize(), {'drafts': items})

    async def test_malformed_model_envelopes_bounds_answers_and_choices_are_recoverable(self):
        first = drafts()[0]
        cases = [(envelope(complete([first]), 'length'), 422), ({'choices': []}, 502),
                 ({'choices': [{'finish_reason': 'stop', 'message': []}]}, 502),
                 ({'choices': [{'finish_reason': 'stop', 'message': {'content': '{'}}]}, 502),
                 (envelope(complete([{**first, 'answer': 'D'}])), 502),
                 (envelope(complete([{**first, 'bounds': [300, 0, 701, 1000]}])), 422),
                 (envelope(complete([{**first, 'bounds': [0, 0, True, 1000]}])), 422),
                 (envelope(complete([{**first, 'bounds': [0, 0, 100, 0]}])), 422),
                 (envelope(complete([{**first, 'extra': 'private-upstream-text'}])), 502)]
        for i, (answer, status) in enumerate(cases):
            self.envelope = answer
            error = await self.recognize({**self.body, 'requestKey': str(i)}, status=status)
            self.assertNotIn('drafts', error)
            self.assertNotIn('private-upstream-text', str(error))
        self.assertEqual(await self.quota(), len(cases))

    async def test_provider_errors_redirect_and_chunked_oversize_are_not_retried_or_logged(self):
        async def reject(request, payload):
            return web.Response(status=401, text='private-upstream-text ' + self.body['dataUrl'])

        async def redirect(request, payload):
            return web.Response(status=307, headers={'Location': '/unexpected'}, text='synthetic-personal')

        async def oversize(request, payload):
            response = web.StreamResponse()
            await response.prepare(request)
            await response.write(b'{' + b' ' * 65536)
            await response.write(b' ' * 65536 + b'}')
            return response

        with self.assertNoLogs('iceclass', level='WARNING'):
            for i, (reply, status) in enumerate([(reject, 502), (redirect, 502), (oversize, 422)]):
                self.model_reply = reply
                body = {**self.body, 'requestKey': str(i)}
                error = await self.recognize(body, status=status)
                self.assertEqual(await self.recognize(body, status=status), error)
                for private in ('private-upstream-text', 'synthetic-personal', 'data:image/'):
                    self.assertNotIn(private, str(error))
        self.assertEqual((len(self.calls), await self.quota()), (3, 3))

    async def test_transport_timeout_is_a_paid_terminal_result_and_a_new_submission_can_recover(self):
        with self.paused_model(), patch.object(recognition, 'ClientTimeout', return_value=ClientTimeout(total=0.25)):
            first = await self.recognize(status=504)
        self.assertEqual(first['code'], 'recognition_timeout')
        self.assertEqual(await self.recognize(status=504), first)
        await self.recognize({**self.body, 'requestKey': 'selected-again'})
        self.assertEqual((len(self.calls), await self.quota()), (2, 2))

    async def test_disconnected_waiter_can_replay_without_resending_the_image_to_the_provider(self):
        with self.paused_model() as entered:
            first = asyncio.create_task(self.recognize())
            await asyncio.wait_for(entered.wait(), 5)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
        result = await self.recognize()
        self.assertEqual(result, {'drafts': drafts()})
        self.assertEqual((len(self.calls), await self.quota()), (1, 1))

    async def test_logged_out_cookie_cannot_receive_the_model_result(self):
        with self.paused_model() as entered:
            first = asyncio.create_task(self.recognize(status=401))
            await asyncio.wait_for(entered.wait(), 5)
            response = await self.client.post('/api/auth/logout', headers=self.teacher, json={})
            self.assertEqual(response.status, 200)
        error = await first
        self.assertNotIn('drafts', error)
        self.assertEqual(len(self.calls), 1)

    async def test_service_restart_keeps_receipt_and_does_not_resend_a_paid_image(self):
        await self.recognize()
        await self.client.close()
        root = Path(self.temp.name)
        self.app = service.create_app(root / 'test.db', root / 'receiver_release', root / 'desktop')
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        error = await self.recognize(status=410)
        self.assertEqual(error['code'], 'recognition_expired')
        await self.recognize({**self.body, 'subjectId': 'physics'}, status=409)
        self.assertEqual((len(self.calls), await self.quota()), (1, 1))
        await self.recognize({**self.body, 'requestKey': 'new-selection'})
        self.assertEqual((len(self.calls), await self.quota()), (2, 2))

    async def test_full_replay_cache_preserves_other_teachers_results_and_expiry_preserves_the_receipt(self):
        _, other = await self.account('cache-teacher', teaching=[self.cid])
        with patch.object(recognition, 'MAX_RECENT', 1):
            first = await self.recognize()
            await self.recognize(headers=other, status=429)
            self.assertEqual(await self.recognize(), first)
        with patch.object(recognition, 'REPLAY_SECONDS', 0):
            await self.recognize(headers=other)
        self.assertEqual((await self.recognize(headers=other, status=410))['code'], 'recognition_expired')
        self.assertEqual(await self.recognize(), first)
        self.assertEqual((len(self.calls), await self.quota(), await self.quota(other)), (2, 1, 1))

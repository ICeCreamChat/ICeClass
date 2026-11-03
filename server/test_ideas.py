from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import smtplib
import sqlite3
import struct
import threading
import uuid
import wave
import zlib
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

from aiohttp import FormData
from aiohttp.test_utils import TestClient, TestServer

import app as service
from test_app import ServerTestCase

import ideas


SETTINGS = {'SMTP_HOST': 'smtp.example.test', 'SMTP_PORT': 465, 'SMTP_USER': 'support@example.test',
            'SMTP_PASSWORD': 'test-only', 'RECIPIENT': 'owner@example.test'}
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=')
NOON = int(datetime(2026, 11, 1, 4, tzinfo=timezone.utc).timestamp() * 1000)
EVENING = NOON + 6 * 3_600_000


def wav_bytes(*, rate=16000, channels=1, width=2, frames=1600):
    output = io.BytesIO()
    with wave.open(output, 'wb') as recording:
        recording.setnchannels(channels)
        recording.setsampwidth(width)
        recording.setframerate(rate)
        recording.writeframes(b'\0' * frames * width * channels)
    return output.getvalue()


class IdeasTests(ServerTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {'ICECLASS_IDEAS_DIGEST_ENABLED': 'false'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.mail = Mock()
        for mocker in (patch.object(ideas, 'mail_settings', return_value=SETTINGS),
                       patch.object(ideas, 'send_mail', self.mail),
                       patch.object(ideas, 'now_ms', return_value=NOON)):
            mocker.start()
            self.addCleanup(mocker.stop)
        await super().asyncSetUp()
        self.engine = self.app[ideas.IDEAS_KEY]
        self.device = await self.enroll_test_device()
        self.admin_headers = self.headers(csrf=True)
        self.db = self.app[service.STORE_KEY]

    def device_headers(self, device=None):
        device = device or self.device
        return {'Authorization': 'Bearer ' + device['deviceToken'],
                'X-ICeClass-Device-Id': device['deviceId']}

    async def submit(self, *, text='希望可以给班级植物记成长日记', name='小林', images=(), audio=None,
                     request_id=None, report=None, device=None, headers=None, extra=()):
        form = FormData()
        form.add_field('report', json.dumps(report if report is not None else {
            'requestId': request_id or str(uuid.uuid4()), 'text': text, 'name': name,
        }), content_type='application/json')
        for data in images:
            form.add_field('image', io.BytesIO(data), filename='../../untrusted.png', content_type='image/png')
        if audio is not None:
            form.add_field('audio', io.BytesIO(audio), filename='voice.wav', content_type='audio/wav')
        for field, data in extra:
            if isinstance(data, bytes):
                form.add_field(field, io.BytesIO(data), filename='extra.bin', content_type='application/octet-stream')
            else:
                form.add_field(field, data, content_type='application/json')
        response = await self.client.post('/api/ideas/student', data=form,
                                          headers=headers if headers is not None else self.device_headers(device))
        return response, await response.json()

    async def another_device(self, class_id=None):
        if class_id is None:
            response, classroom = await self.json_request('POST', '/api/classes', {'name': '高二（2）班'}, csrf=True)
            self.assertEqual(response.status, 201, classroom)
            class_id = classroom['id']
        _, code = await self.json_request('POST', f"/api/classes/{class_id}/enrollment-code", {}, csrf=True)
        response, device = await self.json_request('POST', '/api/device/enroll', {'code': code['code'], 'deviceName': '第二台白板'})
        self.assertEqual(response.status, 200, device)
        return device

    async def review(self, item, **values):
        response = await self.client.patch('/api/ideas/admin/' + item['id'],
            json={'version': item['version'], **values}, headers=self.admin_headers)
        return response, await response.json()

    async def restart(self):
        await self.client.close()
        self.app = service.create_app(Path(self.temp.name) / 'test.db', Path(self.temp.name) / 'receiver_release')
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.db = self.app[service.STORE_KEY]
        self.engine = self.app[ideas.IDEAS_KEY]

    async def test_student_context_uses_authenticated_binding(self):
        response = await self.client.get('/api/ideas/student/context?classId=spoofed', headers=self.device_headers())
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {'classId': self.device['classId'], 'className': '高一（1）班',
                                                 'deviceId': self.device['deviceId']})
        response = await self.client.get('/api/ideas/student/context?deviceId=' + self.device['deviceId'],
            headers={'Authorization': 'Bearer ' + self.device['deviceToken']})
        self.assertEqual(response.status, 200)

    async def test_student_routes_reject_cookie_only_bad_token_and_disabled_binding(self):
        for headers in ({}, self.admin_headers, {**self.device_headers(), 'Authorization': 'Bearer invalid'}):
            response = await self.client.get('/api/ideas/student', headers=headers)
            self.assertEqual(response.status, 401)
        for table, row_id in (('devices', self.device['deviceId']), ('classes', self.device['classId'])):
            self.db.run(f'UPDATE {table} SET enabled=0 WHERE id=?', (row_id,))
            response, _ = await self.submit()
            self.assertEqual(response.status, 401)
            self.db.run(f'UPDATE {table} SET enabled=1 WHERE id=?', (row_id,))

    async def test_text_submission_is_private_and_idempotent_across_restart(self):
        request_id = str(uuid.uuid4())
        response, data = await self.submit(request_id=request_id)
        self.assertEqual(response.status, 201, data)
        item = data['item']
        self.assertEqual((item['status'], item['version'], item['published'], item['media']), ('pending', 1, False, []))
        self.assertEqual(item['classId'], self.device['classId'])
        await self.restart()
        response, retry = await self.submit(request_id=request_id, text='重试时的新内容不会覆盖原记录')
        self.assertEqual(response.status, 201, retry)
        self.assertEqual(retry['item'], item)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM ideas')['n'], 1)

    async def test_request_id_is_bound_to_device_and_class(self):
        request_id = str(uuid.uuid4())
        _, first = await self.submit(request_id=request_id)
        other = await self.another_device()
        response, second = await self.submit(device=other, request_id=request_id)
        self.assertEqual(response.status, 201, second)
        self.assertNotEqual(first['item']['id'], second['item']['id'])
        self.db.run('UPDATE devices SET class_id=? WHERE id=?', (other['classId'], self.device['deviceId']))
        response, rebound = await self.submit(request_id=request_id)
        self.assertEqual(response.status, 201, rebound)
        self.assertEqual(rebound['item']['classId'], other['classId'])
        self.assertNotEqual(rebound['item']['id'], first['item']['id'])

    async def test_rate_limit_is_per_device_persistent_and_does_not_block_retry(self):
        request_id = str(uuid.uuid4())
        for index in range(3):
            response, data = await self.submit(request_id=request_id if index == 0 else None)
            self.assertEqual(response.status, 201, data)
        await self.restart()
        response, _ = await self.submit()
        self.assertEqual(response.status, 429)
        response, _ = await self.submit(request_id=request_id)
        self.assertEqual(response.status, 201)
        with patch.object(ideas, 'now_ms', return_value=NOON + 60_001):
            response, _ = await self.submit()
        self.assertEqual(response.status, 201)

    async def test_student_list_is_class_scoped_and_paginated(self):
        _, first = await self.submit(text='第一条')
        await self.submit(text='第二条')
        other = await self.another_device()
        await self.submit(device=other)
        response = await self.client.get('/api/ideas/student?page=2&pageSize=1&classId=' + other['classId'],
                                          headers=self.device_headers())
        data = await response.json()
        self.assertEqual((response.status, data['total'], data['page'], data['pageSize']), (200, 2, 2, 1))
        self.assertEqual(len(data['items']), 1)
        self.assertTrue(all(item['classId'] == self.device['classId'] for item in data['items']))
        self.assertEqual((await self.client.patch('/api/ideas/student/' + first['item']['id'],
            json={'status': 'launched'}, headers=self.device_headers())).status, 405)

    async def test_delete_requires_current_class_binding(self):
        _, data = await self.submit(images=(PNG,))
        item = data['item']
        url = '/api/ideas/student/' + item['id']
        other = await self.another_device()
        for headers, status in (({}, 401), (self.admin_headers, 401),
                                ({**self.device_headers(), 'Authorization': 'Bearer invalid'}, 401),
                                (self.device_headers(other), 403)):
            response = await self.client.delete(url, json={'version': item['version']}, headers=headers)
            self.assertEqual(response.status, status, await response.text())
        for table, row_id in (('devices', self.device['deviceId']), ('classes', self.device['classId'])):
            self.db.run(f'UPDATE {table} SET enabled=0 WHERE id=?', (row_id,))
            response = await self.client.delete(url, json={'version': item['version']}, headers=self.device_headers())
            self.assertEqual(response.status, 401)
            self.db.run(f'UPDATE {table} SET enabled=1 WHERE id=?', (row_id,))
        self.assertIsNotNone(self.db.one('SELECT id FROM ideas WHERE id=?', (item['id'],)))

    async def test_delete_pending_removes_originals_and_is_idempotent_within_class(self):
        _, data = await self.submit(images=(PNG,), audio=wav_bytes())
        _, kept = await self.submit(text='保留另一份创意', images=(PNG,))
        item = data['item']
        self.assertTrue(item['canDelete'])
        files = {row['file_name'] for row in self.db.all('SELECT file_name FROM ideas_media WHERE idea_id=?', (item['id'],))}
        same_class = await self.another_device(self.device['classId'])
        url = '/api/ideas/student/' + item['id']
        for _ in range(2):
            response = await self.client.delete(url, json={'version': item['version']}, headers=self.device_headers(same_class))
            self.assertEqual(response.status, 200, await response.text())
            self.assertTrue((await response.json())['deleted'])
        self.assertIsNone(self.db.one('SELECT * FROM ideas WHERE id=?', (item['id'],)))
        self.assertEqual(self.db.all('SELECT * FROM ideas_media WHERE idea_id=?', (item['id'],)), [])
        self.assertTrue(all(not (self.engine.media_root / name).exists() for name in files))
        for media in item['media']:
            self.assertEqual((await self.client.get(media['url'], headers=self.device_headers())).status, 404)
        response = await self.client.get('/api/ideas/student', headers=self.device_headers())
        remaining = await response.json()
        self.assertEqual(remaining['total'], 1)
        self.assertEqual(remaining['items'][0]['id'], kept['item']['id'])
        self.assertEqual((await self.client.get(kept['item']['media'][0]['url'], headers=self.device_headers())).status, 200)
        response = await self.client.get('/api/ideas/admin/summary', headers=self.admin_headers)
        self.assertEqual((await response.json())['total'], 1)

    async def test_processed_ideas_cannot_be_deleted_and_stale_pending_version_is_rejected(self):
        _, data = await self.submit(images=(PNG,))
        item = data['item']
        url = '/api/ideas/student/' + item['id']
        _, updated = await self.review(item, reply='已收到，正在核对')
        current = updated['item']
        response = await self.client.delete(url, json={'version': item['version']}, headers=self.device_headers())
        self.assertEqual(response.status, 409)
        for status in ('adopted', 'implementing', 'launched', 'declined'):
            _, updated = await self.review(current, status=status)
            current = updated['item']
            response = await self.client.delete(url, json={'version': current['version']}, headers=self.device_headers())
            self.assertEqual(response.status, 409, status)
            response = await self.client.get('/api/ideas/student', headers=self.device_headers())
            self.assertFalse((await response.json())['items'][0]['canDelete'])
        self.assertEqual((await self.client.get(item['media'][0]['url'], headers=self.device_headers())).status, 200)

    async def test_delete_validates_version_and_streamed_body(self):
        _, data = await self.submit()
        item = data['item']
        url = '/api/ideas/student/' + item['id']
        for body in ({}, [], {'version': True}, {'version': '1'}, {'version': 0},
                     {'version': 2_147_483_648}, {'version': 1, 'classId': 'spoofed'}):
            response = await self.client.delete(url, json=body, headers=self.device_headers())
            self.assertEqual(response.status, 400, body)
        for raw in (b'{"version":1,"version":1}', b'\xff', b' ' * 1025):
            response = await self.client.delete(url, data=raw, headers=self.device_headers())
            self.assertEqual(response.status, 400)
        async def chunks():
            yield b'{"version":'
            await asyncio.sleep(0)
            yield b'1}'
        response = await self.client.delete(url, data=chunks(), headers=self.device_headers())
        self.assertEqual(response.status, 200, await response.text())

    async def test_deleted_submission_cannot_reappear_after_retry_or_restart(self):
        request_id = str(uuid.uuid4())
        _, data = await self.submit(request_id=request_id, images=(PNG,))
        item = data['item']
        url = '/api/ideas/student/' + item['id']
        response = await self.client.delete(url, json={'version': item['version']}, headers=self.device_headers())
        self.assertEqual(response.status, 200)
        await self.restart()
        response, result = await self.submit(request_id=request_id, text='旧请求不能复活')
        self.assertEqual(response.status, 410, result)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM ideas')['n'], 0)
        response = await self.client.delete(url, json={'version': item['version']}, headers=self.device_headers())
        self.assertEqual(response.status, 200)
        marker = self.db.one('SELECT * FROM ideas_deleted_requests WHERE idea_id=?', (item['id'],))
        self.assertEqual(set(marker), {'idea_id', 'class_id', 'device_id', 'request_id', 'created_at'})

    async def test_deleting_does_not_bypass_submission_rate_limit(self):
        for _ in range(3):
            response, data = await self.submit()
            self.assertEqual(response.status, 201)
            item = data['item']
            response = await self.client.delete('/api/ideas/student/' + item['id'],
                json={'version': item['version']}, headers=self.device_headers())
            self.assertEqual(response.status, 200)
        await self.restart()
        response, _ = await self.submit()
        self.assertEqual(response.status, 429)
        with patch.object(ideas, 'now_ms', return_value=NOON + 60_001):
            response, _ = await self.submit()
        self.assertEqual(response.status, 201)

    async def test_delete_storage_failure_rolls_back_before_removing_media(self):
        _, data = await self.submit(images=(PNG,))
        item = data['item']
        original = self.db.run
        def fail(sql, params=()):
            if sql.startswith('DELETE FROM ideas WHERE'):
                raise sqlite3.OperationalError('private database failure')
            return original(sql, params)
        with patch.object(self.db, 'run', side_effect=fail):
            response = await self.client.delete('/api/ideas/student/' + item['id'],
                json={'version': item['version']}, headers=self.device_headers())
        self.assertEqual(response.status, 503)
        self.assertNotIn('private', await response.text())
        self.assertIsNotNone(self.db.one('SELECT id FROM ideas WHERE id=?', (item['id'],)))
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM ideas_deleted_requests')['n'], 0)
        self.assertEqual((await self.client.get(item['media'][0]['url'], headers=self.device_headers())).status, 200)

    async def test_delete_rebuilds_failed_digest_without_deleted_content(self):
        _, first = await self.submit(text='DELETE-THIS-TITLE')
        await self.submit(text='KEEP-THIS-TITLE')
        self.engine.enabled = True
        self.mail.side_effect = smtplib.SMTPServerDisconnected('temporary failure')
        await self.engine.deliver_due(EVENING)
        self.assertIn('DELETE-THIS-TITLE', self.mail.call_args.args[1].get_content())
        response = await self.client.delete('/api/ideas/student/' + first['item']['id'],
            json={'version': first['item']['version']}, headers=self.device_headers())
        self.assertEqual(response.status, 200)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM ideas_digest_batches')['n'], 0)
        self.mail.side_effect = None
        await self.engine.deliver_due(EVENING + ideas.RETRY_MS)
        latest = self.mail.call_args.args[1].get_content()
        self.assertIn('KEEP-THIS-TITLE', latest)
        self.assertNotIn('DELETE-THIS-TITLE', latest)

    async def test_delete_while_digest_is_sending_returns_retry_without_changing_data(self):
        _, data = await self.submit()
        item = data['item']
        await self.engine.digest_lock.acquire()
        try:
            response = await self.client.delete('/api/ideas/student/' + item['id'],
                json={'version': item['version']}, headers=self.device_headers())
            self.assertEqual(response.status, 503)
            self.assertIsNotNone(self.db.one('SELECT id FROM ideas WHERE id=?', (item['id'],)))
        finally:
            self.engine.digest_lock.release()
        response = await self.client.delete('/api/ideas/student/' + item['id'],
            json={'version': item['version']}, headers=self.device_headers())
        self.assertEqual(response.status, 200)

    async def test_empty_spoofed_and_malformed_reports_are_rejected(self):
        invalid = ({'text': '   '}, {'requestId': str(uuid.uuid4()), 'text': '', 'name': ''},
                   {'requestId': str(uuid.uuid4()), 'text': 'x', 'classId': 'spoofed'},
                   {'requestId': str(uuid.uuid4()), 'text': 'x', 'status': 'launched'},
                   {'requestId': 'not-uuid', 'text': 'x'}, {'requestId': str(uuid.uuid4()), 'text': 5},
                   {'requestId': str(uuid.uuid4()), 'text': 'x' * 3001},
                   {'requestId': str(uuid.uuid4()), 'text': 'x', 'name': '名' * 41},
                   {'requestId': str(uuid.uuid4()), 'text': 'x\x00'}, [], None)
        for report in invalid[:-1]:
            response, data = await self.submit(report=report)
            self.assertEqual(response.status, 400, data)
        response = await self.client.post('/api/ideas/student', json={'text': 'x'}, headers=self.device_headers())
        self.assertEqual(response.status, 400)
        response, _ = await self.submit(extra=(('report', '{}'),))
        self.assertEqual(response.status, 400)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM ideas')['n'], 0)

    async def test_maximum_chinese_text_and_name_fit_report(self):
        response, data = await self.submit(text='中' * 3000, name='名' * 40)
        self.assertEqual(response.status, 201, data)
        self.assertEqual(len(data['item']['text']), 3000)

    async def test_photo_and_audio_only_are_durable_and_have_detected_types(self):
        response, photo = await self.submit(text='', name='', images=(PNG,))
        self.assertEqual(response.status, 201, photo)
        response, audio = await self.submit(text='', audio=wav_bytes())
        self.assertEqual(response.status, 201, audio)
        self.assertEqual(audio['item']['media'][0]['durationMs'], 100)
        self.assertEqual(audio['item']['media'][0]['contentType'], 'audio/wav')
        media = photo['item']['media'][0]
        self.assertEqual(media['contentType'], 'image/png')
        await service.cleanup(self.app)
        await self.restart()
        response = await self.client.get(media['url'], headers=self.device_headers())
        self.assertEqual((response.status, await response.read()), (200, PNG))
        self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')

    async def test_private_media_denies_cross_class_staff_and_classroom_impersonation(self):
        _, data = await self.submit(images=(PNG,))
        url = data['item']['media'][0]['url']
        other = await self.another_device()
        response = await self.client.get(url, headers=self.device_headers(other))
        self.assertEqual(response.status, 403)
        response = await self.client.get(url, headers=self.admin_headers)
        self.assertEqual(response.status, 200)
        self.db.run("UPDATE users SET role='principal' WHERE username='ICe'")
        response = await self.client.get(url, headers=self.admin_headers)
        self.assertEqual(response.status, 403)
        self.db.run("UPDATE users SET role='teacher' WHERE username='ICe'")
        self.assertEqual((await self.client.get(url, headers=self.admin_headers)).status, 403)
        self.db.run("UPDATE users SET role='superadmin' WHERE username='ICe'")
        headers = {**self.admin_headers, 'X-ICeClass-Device': self.device['deviceId']}
        self.assertIn((await self.client.get(url, headers=headers)).status, (401, 403))
        self.db.run('UPDATE devices SET enabled=0 WHERE id=?', (self.device['deviceId'],))
        self.assertEqual((await self.client.get(url, headers=self.device_headers())).status, 401)

    async def test_invalid_images_wav_and_duplicate_audio_are_rejected(self):
        malformed = [b'not wav', wav_bytes(rate=8000), wav_bytes(channels=2), wav_bytes(width=1),
                     wav_bytes(frames=0), wav_bytes(frames=960001), wav_bytes()[:-2]]
        for audio in malformed:
            response, data = await self.submit(text='', audio=audio)
            self.assertEqual(response.status, 400, data)
        for image in (PNG[:33], b'<svg></svg>', b'\xff\xd8\xff\xd9'):
            response, data = await self.submit(text='', images=(image,))
            self.assertEqual(response.status, 400, data)
        response, _ = await self.submit(audio=wav_bytes(), extra=(('audio', wav_bytes()),))
        self.assertEqual(response.status, 400)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM ideas')['n'], 0)

    async def test_png_requires_valid_pixel_format_and_complete_deflate_data(self):
        chunks = [(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)),
                  (b'IDAT', zlib.compress(b'\0\xff\xff\xff\xff'))]

        def container(parts):
            return b'\x89PNG\r\n\x1a\n' + b''.join(len(body).to_bytes(4, 'big') + kind + body
                + zlib.crc32(kind + body).to_bytes(4, 'big') for kind, body in (*parts, (b'IEND', b'')))

        invalid = [container([chunks[0], (b'IDAT', b'not deflate')]),
                   container([chunks[0], (b'IDAT', zlib.compress(b'\0'))]),
                   container([(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 7, 6, 0, 0, 0)), chunks[1]])]
        for data in invalid:
            response, body = await self.submit(text='', images=(data,))
            self.assertEqual(response.status, 400, body)
        response, body = await self.submit(text='', images=(container(chunks),))
        self.assertEqual(response.status, 201, body)

    async def test_another_current_device_in_same_class_can_read_class_media(self):
        _, data = await self.submit(images=(PNG,))
        second = await self.another_device(self.device['classId'])
        response = await self.client.get(data['item']['media'][0]['url'], headers=self.device_headers(second))
        self.assertEqual((response.status, await response.read()), (200, PNG))
        response = await self.client.get('/api/ideas/student', headers=self.device_headers(second))
        self.assertEqual((await response.json())['total'], 1)

    async def test_json_duplicate_invalid_utf8_and_oversized_report_are_rejected(self):
        for raw in (b'{"requestId":"' + str(uuid.uuid4()).encode() + b'","text":"one","text":"two"}',
                    b'{"text":NaN}', b'\xff', b'{' + b' ' * 24576 + b'}', b'null', b'[]'):
            form = FormData()
            form.add_field('report', io.BytesIO(raw), filename='report.json', content_type='application/json')
            response = await self.client.post('/api/ideas/student', data=form, headers=self.device_headers())
            self.assertEqual(response.status, 400)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM ideas')['n'], 0)

    async def test_multipart_count_part_and_aggregate_limits(self):
        for arguments in ({'images': (PNG,) * 4}, {'images': (b'x' * (2 * 1024 * 1024 + 1),)},
                          {'audio': b'x' * (2 * 1024 * 1024 + 1)}, {'extra': (('unknown', '{}'),)}):
            response, data = await self.submit(**arguments)
            self.assertIn(response.status, (400, 413), data)
        with patch.object(ideas, 'MAX_UPLOAD_BYTES', 100):
            response, data = await self.submit(images=(PNG,))
        self.assertEqual(response.status, 413, data)

    async def test_real_eight_mib_aggregate_is_rejected_with_individually_valid_parts(self):
        padding = b'a' * (2 * 1024 * 1024 - len(PNG) - 12)
        payload = b'icEd' + padding
        image = PNG[:-12] + len(padding).to_bytes(4, 'big') + payload + zlib.crc32(payload).to_bytes(4, 'big') + PNG[-12:]
        audio = wav_bytes()
        padding_size = 2 * 1024 * 1024 - len(audio) - 8
        audio = (b'RIFF' + (2 * 1024 * 1024 - 8).to_bytes(4, 'little') + audio[8:]
                 + b'JUNK' + padding_size.to_bytes(4, 'little') + b'\0' * padding_size)
        response, data = await self.submit(images=(image,) * 3, audio=audio)
        self.assertEqual(response.status, 413, data)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM ideas')['n'], 0)

    async def test_storage_failure_removes_only_new_files_and_can_retry(self):
        _, previous = await self.submit(images=(PNG,))
        media_path = Path(self.temp.name) / 'ideas-media'
        existing = set(media_path.iterdir())
        request_id = str(uuid.uuid4())
        original = self.db.run

        def fail(sql, params=()):
            if sql.lstrip().startswith('INSERT INTO ideas_media'):
                raise sqlite3.OperationalError('private sqlite failure')
            return original(sql, params)

        with patch.object(self.db, 'run', side_effect=fail):
            response, data = await self.submit(images=(PNG,), request_id=request_id)
        self.assertEqual(response.status, 503, data)
        self.assertEqual(set(media_path.iterdir()), existing)
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM ideas')['n'], 1)
        response, data = await self.submit(images=(PNG,), request_id=request_id)
        self.assertEqual(response.status, 201, data)
        url = previous['item']['media'][0]['url']
        self.assertEqual((await self.client.get(url, headers=self.device_headers())).status, 200)

    async def test_filesystem_failure_is_reported_without_retaining_submission(self):
        with patch.object(Path, 'open', side_effect=OSError('private disk error')):
            response, data = await self.submit(images=(PNG,))
        self.assertEqual(response.status, 503, data)
        self.assertNotIn('private', json.dumps(data))
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM ideas')['n'], 0)

    async def test_admin_access_requires_real_superadmin_and_csrf(self):
        _, data = await self.submit()
        item = data['item']
        for path in ('/api/ideas/admin', '/api/ideas/admin/summary'):
            self.assertEqual((await self.client.get(path, headers=self.device_headers())).status, 401)
            self.db.run("UPDATE users SET role='principal' WHERE username='ICe'")
            self.assertEqual((await self.client.get(path, headers=self.admin_headers)).status, 403)
            self.db.run("UPDATE users SET role='superadmin' WHERE username='ICe'")
            headers = {**self.admin_headers, 'X-ICeClass-Device': self.device['deviceId']}
            self.assertIn((await self.client.get(path, headers=headers)).status, (401, 403))
        response = await self.client.patch('/api/ideas/admin/' + item['id'],
            json={'version': 1, 'status': 'adopted'}, headers=self.headers())
        self.assertEqual(response.status, 403)
        response = await self.client.get('/api/ideas/admin/summary', headers=self.admin_headers)
        summary = await response.json()
        self.assertEqual((summary['total'], summary['pending'], summary['published']), (1, 1, 0))
        self.assertFalse(summary['digest']['enabled'])

    async def test_status_review_publish_guards_and_optimistic_conflict(self):
        _, data = await self.submit(images=(PNG,))
        item = data['item']
        for payload in ({'status': 'invented'}, {'published': True, 'publishedTitle': '标题', 'publishedText': '说明'},
                        {'status': 'adopted', 'published': True}, {'version': True}, {'text': '篡改原文'}):
            response, data = await self.review(item, **payload)
            self.assertEqual(response.status, 400, data)
        response, updated = await self.review(item, status='adopted', reply='谢谢你的想法', published=True,
            publishedTitle='班级植物成长日记', publishedText='新增植物记录功能。')
        self.assertEqual(response.status, 200, updated)
        self.assertEqual((updated['item']['version'], updated['item']['status']), (2, 'adopted'))
        response, _ = await self.review(item, reply='旧页面覆盖')
        self.assertEqual(response.status, 409)
        response, _ = await self.review(updated['item'], status='declined')
        self.assertEqual(response.status, 400)
        item = updated['item']
        for status in ('implementing', 'launched'):
            response, data = await self.review(item, status=status)
            self.assertEqual(response.status, 200, data)
            item = data['item']
        response, data = await self.review(item, status='declined', published=False)
        self.assertEqual(response.status, 200, data)

    async def test_showcase_exposes_only_explicit_public_projection(self):
        _, data = await self.submit(text='原始私密内容', name='学生真实姓名', images=(PNG,), audio=wav_bytes())
        response, review = await self.review(data['item'], status='adopted', reply='内部回复', published=True,
            publishedTitle='公开标题', publishedText='公开摘要')
        self.assertEqual(response.status, 200, review)
        for headers in (self.device_headers(), self.admin_headers):
            response = await self.client.get('/api/ideas/showcase', headers=headers)
            listing = await response.json()
            self.assertEqual((response.status, listing['total']), (200, 1))
            public = listing['items'][0]
            self.assertEqual(set(public), {'id', 'className', 'status', 'publishedTitle', 'publishedText', 'updatedAt'})
            self.assertNotIn('学生真实姓名', json.dumps(public, ensure_ascii=False))
            self.assertNotIn('原始私密内容', json.dumps(public, ensure_ascii=False))
        self.client.session.cookie_jar.clear()
        self.assertEqual((await self.client.get('/api/ideas/showcase')).status, 401)

    async def test_admin_filters_and_invalid_pagination(self):
        _, first = await self.submit()
        await self.review(first['item'], status='declined')
        other = await self.another_device()
        await self.submit(device=other)
        response = await self.client.get('/api/ideas/admin?status=pending&classId=' + other['classId'], headers=self.admin_headers)
        data = await response.json()
        self.assertEqual((response.status, data['total']), (200, 1))
        self.assertEqual(data['items'][0]['classId'], other['classId'])
        for query in ('page=0', 'page=x', 'pageSize=101', 'pageSize=-1'):
            self.assertEqual((await self.client.get('/api/ideas/student?' + query, headers=self.device_headers())).status, 400)
        self.assertEqual((await self.client.get('/api/ideas/admin?status=invalid', headers=self.admin_headers)).status, 400)

    async def test_daily_digest_waits_until_shanghai_18_and_skips_empty(self):
        self.engine.enabled = True
        await self.engine.deliver_due(EVENING - 1)
        self.mail.assert_not_called()
        await self.engine.deliver_due(EVENING)
        self.mail.assert_not_called()
        _, data = await self.submit(text='次日的创意')
        await self.engine.deliver_due(EVENING + 1)
        self.mail.assert_not_called()
        await self.engine.deliver_due(EVENING + 86_400_000)
        self.assertEqual(self.mail.call_count, 1)
        body = self.mail.call_args.args[1].get_content()
        self.assertIn('次日的创意', body)
        self.assertIn('高一（1）班', body)
        self.assertIn('待评审', body)

    async def test_nonempty_digest_at_exact_18_then_next_day_18(self):
        await self.submit(text='切换前创意')
        self.engine.enabled = True
        await self.engine.deliver_due(EVENING - 1)
        self.mail.assert_not_called()
        await self.engine.deliver_due(EVENING)
        self.assertEqual(self.mail.call_count, 1)
        with patch.object(ideas, 'now_ms', return_value=EVENING + 1):
            await self.submit(text='切换后创意')
        await self.restart()
        self.engine.enabled = True
        await self.engine.deliver_due(EVENING + 6 * 3_600_000)
        await self.engine.deliver_due(EVENING + 86_400_000 - 1)
        self.assertEqual(self.mail.call_count, 1)
        await self.engine.deliver_due(EVENING + 86_400_000)
        self.assertEqual(self.mail.call_count, 2)
        body = self.mail.call_args.args[1].get_content()
        self.assertIn('切换后创意', body)
        self.assertNotIn('切换前创意', body)

    async def test_local_disabled_restart_never_sends_or_consumes_due_batch(self):
        await self.submit()
        self.engine.enabled = True
        self.mail.side_effect = smtplib.SMTPServerDisconnected('offline')
        await self.engine.deliver_due(EVENING)
        state = self.db.one('SELECT * FROM ideas_digest_state WHERE id=1')
        batch = self.db.one('SELECT * FROM ideas_digest_batches')
        self.mail.reset_mock(side_effect=True)
        with patch.dict(os.environ, {'ICECLASS_IDEAS_DIGEST_ENABLED': '0'}), patch.object(ideas, 'now_ms', return_value=EVENING + 86_400_000):
            await self.restart()
            self.assertFalse(self.engine.enabled)
            self.assertIsNone(self.engine.task)
            await self.engine.deliver_due(EVENING + 86_400_000)
        self.mail.assert_not_called()
        self.assertEqual(self.db.one('SELECT * FROM ideas_digest_state WHERE id=1'), state)
        self.assertEqual(self.db.one('SELECT * FROM ideas_digest_batches'), batch)
        self.assertIsNone(self.engine.digest_summary()['nextAt'])

    async def test_digest_retry_keeps_message_id_and_restart_does_not_duplicate(self):
        await self.submit(images=(PNG,), audio=wav_bytes())
        self.engine.enabled = True
        self.mail.side_effect = smtplib.SMTPServerDisconnected('private mail detail')
        await self.engine.deliver_due(EVENING)
        first_message = self.mail.call_args.args[1]
        summary = self.engine.digest_summary()
        self.assertIsNone(summary['lastSentAt'])
        self.assertNotIn('private', summary['lastError'])
        self.assertTrue(summary['lastError'])
        await self.restart()
        self.engine.enabled = True
        self.mail.side_effect = None
        await self.engine.deliver_due(EVENING + 600_000)
        self.assertEqual(self.mail.call_count, 2)
        second_message = self.mail.call_args.args[1]
        self.assertEqual(first_message['Message-ID'], second_message['Message-ID'])
        self.assertFalse(second_message.is_multipart())
        self.assertEqual(second_message['To'], 'owner@example.test')
        self.assertIsNotNone(self.engine.digest_summary()['lastSentAt'])
        await self.restart()
        self.engine.enabled = True
        await self.engine.deliver_due(EVENING + 86_400_000)
        self.assertEqual(self.mail.call_count, 2)

    async def test_digest_missing_configuration_and_disabled_mode_do_not_mark_sent(self):
        await self.submit()
        await self.engine.deliver_due(EVENING)
        self.mail.assert_not_called()
        self.engine.enabled = True
        with patch.object(ideas, 'mail_settings', return_value=None):
            await self.engine.deliver_due(EVENING)
            summary = self.engine.digest_summary()
        self.assertFalse(summary['configured'])
        self.assertIsNone(summary['lastSentAt'])
        self.assertTrue(summary['lastError'])
        await self.engine.deliver_due(EVENING + 600_000)
        self.assertEqual(self.mail.call_count, 1)

    async def test_digest_retry_next_morning_keeps_todays_18_schedule(self):
        await self.submit(text='昨日创意')
        self.engine.enabled = True
        self.mail.side_effect = smtplib.SMTPServerDisconnected('offline')
        await self.engine.deliver_due(EVENING)
        self.mail.side_effect = None
        tomorrow_morning = NOON + 86_400_000 - 3_600_000
        await self.engine.deliver_due(tomorrow_morning)
        self.assertEqual(self.engine.digest_summary()['nextAt'], EVENING + 86_400_000)

    async def test_review_accepts_streamed_json_without_rejecting_partial_read(self):
        _, data = await self.submit()
        body = json.dumps({'version': 1, 'status': 'adopted'}).encode()

        async def chunks():
            yield body[:8]
            await asyncio.sleep(0.01)
            yield body[8:]

        response = await self.client.patch('/api/ideas/admin/' + data['item']['id'], data=chunks(),
            headers={**self.admin_headers, 'Content-Type': 'application/json'})
        self.assertEqual(response.status, 200, await response.text())

    async def test_maximum_chinese_review_and_public_fields_fit_json_limit(self):
        _, data = await self.submit()
        response, data = await self.review(data['item'], status='adopted', reply='评' * 3000,
            published=True, publishedTitle='题' * 120, publishedText='文' * 3000)
        self.assertEqual(response.status, 200, data)

    async def test_ideas_arriving_during_digest_are_sent_next_day(self):
        await self.submit(text='第一批')
        started, finish = threading.Event(), threading.Event()

        def send(settings, message):
            started.set()
            if not finish.wait(5):
                raise TimeoutError('test did not release mail')

        self.mail.side_effect = send
        self.engine.enabled = True
        delivery = asyncio.create_task(self.engine.deliver_due(EVENING))
        await asyncio.to_thread(started.wait, 5)
        try:
            await self.submit(text='下一批')
        finally:
            finish.set()
            await delivery
        self.mail.side_effect = None
        await self.engine.deliver_due(EVENING + 86_400_000)
        self.assertEqual(self.mail.call_count, 2)
        body = self.mail.call_args.args[1].get_content()
        self.assertIn('下一批', body)
        self.assertNotIn('第一批', body)

    async def test_digest_shutdown_waits_for_smtp_before_database_close(self):
        await self.submit()
        started, finish = threading.Event(), threading.Event()

        def send(settings, message):
            started.set()
            if not finish.wait(5):
                raise TimeoutError('test did not release mail')

        self.mail.side_effect = send
        self.engine.enabled = True
        with patch.object(ideas, 'now_ms', return_value=EVENING):
            self.engine.task = asyncio.create_task(self.engine.run())
            self.assertTrue(await asyncio.to_thread(started.wait, 5))
            self.engine.task.cancel()
            closing = asyncio.create_task(self.client.close())
            await asyncio.sleep(0)
            self.assertFalse(closing.done())
            finish.set()
            await closing
        reopened = service.Store(Path(self.temp.name) / 'test.db')
        try:
            self.assertIsNotNone(reopened.one('SELECT last_sent_at FROM ideas_digest_state WHERE id=1')['last_sent_at'])
        finally:
            reopened.close()

from __future__ import annotations

import json
import base64
import io
import smtplib
from unittest.mock import Mock, patch

from aiohttp import FormData

import feedback
from test_app import ServerTestCase


SETTINGS = {'SMTP_HOST': 'smtp.example.test', 'SMTP_PORT': 465, 'SMTP_USER': 'support@example.test',
            'SMTP_PASSWORD': 'test-only', 'RECIPIENT': 'owner@example.test'}
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPrsAAAAASUVORK5CYII=')


class FeedbackTests(ServerTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.mail = Mock()
        self.settings_patch = patch.object(feedback, 'mail_settings', return_value=SETTINGS)
        self.mail_patch = patch.object(feedback, 'send_mail', self.mail)
        self.settings_patch.start()
        self.mail_patch.start()

    async def asyncTearDown(self):
        self.mail_patch.stop()
        self.settings_patch.stop()
        await super().asyncTearDown()

    async def send(self, *, description='', logs=b'diagnostic log', image=None, report=None, csrf=True, extra=None):
        form = FormData()
        form.add_field('report', json.dumps(report if report is not None else {
            'description': description, 'version': '2.5.1',
            'page': 'https://school.example/#account', 'occurredAt': '2026-10-31T23:30:00+08:00',
        }), content_type='application/json')
        if logs is not None:
            form.add_field('logs', io.BytesIO(logs), filename='desktop.txt', content_type='text/plain')
        if image is not None:
            form.add_field('screenshot', image, filename='untrusted-name.exe', content_type='image/png')
        if extra:
            form.add_field(*extra)
        response = await self.client.post('/api/feedback', data=form, headers=self.headers(csrf=csrf))
        return response, await response.json()

    async def test_login_and_csrf_are_required(self):
        response, _ = await self.send()
        self.assertEqual(response.status, 401)
        await self.bootstrap_and_login()
        response, _ = await self.send(csrf=False)
        self.assertEqual(response.status, 403)
        self.mail.assert_not_called()

    async def test_classroom_mode_cannot_use_a_teacher_cookie_to_submit(self):
        await self.bootstrap_and_login()
        response = await self.client.post('/api/feedback', headers={**self.headers(csrf=True), 'X-ICeClass-Device': 'device-token'})
        self.assertEqual(response.status, 401)
        self.mail.assert_not_called()

    async def test_maximum_chinese_metadata_fits_json_encoding(self):
        await self.bootstrap_and_login()
        report = {key: '中' * size for key, size in {'description': 2000, 'contact': 120, 'system': 200,
                  'version': 40, 'scaling': 40, 'occurredAt': 60, 'page': 500}.items()}
        response, data = await self.send(report=report, logs=None)
        self.assertEqual(response.status, 201, data)

    async def test_screenshot_count_and_truncated_png_are_rejected(self):
        await self.bootstrap_and_login()
        response, data = await self.send(image=PNG[:33])
        self.assertEqual(response.status, 400, data)
        form = FormData()
        form.add_field('report', '{}', content_type='application/json')
        for _ in range(4):
            form.add_field('screenshot', io.BytesIO(PNG), filename='image.png', content_type='image/png')
        response = await self.client.post('/api/feedback', data=form, headers=self.headers(csrf=True))
        self.assertEqual(response.status, 400)
        self.mail.assert_not_called()

    async def test_mail_uses_authenticated_identity_and_fixed_recipient(self):
        await self.bootstrap_and_login()
        response, data = await self.send(image=PNG)
        self.assertEqual(response.status, 201, data)
        settings, message = self.mail.call_args.args
        self.assertEqual(settings['RECIPIENT'], 'owner@example.test')
        self.assertEqual(message['To'], 'owner@example.test')
        self.assertIn('ICe', message.get_body(preferencelist=('plain',)).get_content())
        self.assertIn(data['id'], message.get_body(preferencelist=('plain',)).get_content())
        attachments = list(message.iter_attachments())
        self.assertEqual(len(attachments), 2)
        self.assertEqual(attachments[0].get_payload(decode=True), b'diagnostic log')
        self.assertEqual(attachments[1].get_filename(), '截图1.png')
        self.assertNotIn('test-only', message.as_string())

    async def test_description_only_is_valid_and_empty_feedback_is_rejected(self):
        await self.bootstrap_and_login()
        response, data = await self.send(description='浮岛日期发虚', logs=None)
        self.assertEqual(response.status, 201, data)
        response, _ = await self.send(logs=None)
        self.assertEqual(response.status, 400)
        self.assertEqual(self.mail.call_count, 1)

    async def test_invalid_images_unknown_fields_and_overlong_content_are_rejected(self):
        await self.bootstrap_and_login()
        for arguments in ({'image': b'not a picture'}, {'report': {'description': 'x' * 2001}},
                          {'report': {'recipient': 'attacker@example.test'}}, {'extra': ('other', 'ignored')}):
            response, data = await self.send(**arguments)
            self.assertEqual(response.status, 400, data)
        self.mail.assert_not_called()

    async def test_oversized_logs_are_rejected(self):
        await self.bootstrap_and_login()
        response, _ = await self.send(logs=b'x' * (feedback.MAX_LOG_BYTES + 1))
        self.assertEqual(response.status, 400)
        self.mail.assert_not_called()

    async def test_missing_mail_configuration_does_not_claim_success(self):
        await self.bootstrap_and_login()
        with patch.object(feedback, 'mail_settings', return_value=None):
            response, _ = await self.send()
        self.assertEqual(response.status, 503)
        self.mail.assert_not_called()

    async def test_mail_failure_is_retryable_without_exposing_smtp_detail(self):
        await self.bootstrap_and_login()
        self.mail.side_effect = smtplib.SMTPAuthenticationError(535, b'private credential detail')
        response, data = await self.send()
        self.assertEqual(response.status, 503)
        self.assertNotIn('private', json.dumps(data))
        self.mail.side_effect = None
        response, data = await self.send()
        self.assertEqual(response.status, 201, data)

    async def test_authenticated_mail_attempts_are_rate_limited(self):
        await self.bootstrap_and_login()
        for _ in range(3):
            response, data = await self.send()
            self.assertEqual(response.status, 201, data)
        response, _ = await self.send()
        self.assertEqual(response.status, 429)
        self.assertEqual(self.mail.call_count, 3)

    def test_accepted_mail_remains_successful_when_quit_fails(self):
        client = Mock()
        client.send_message.return_value = {}
        client.quit.side_effect = smtplib.SMTPServerDisconnected('server closed')
        with patch.object(feedback.smtplib, 'SMTP_SSL', return_value=client):
            # Use the actual function beneath this test fixture's send_mail patch.
            self.mail_patch.stop()
            try:
                feedback.send_mail(SETTINGS, feedback.build_message(SETTINGS,
                    {'displayName': '教师', 'username': 'teacher', 'role': 'teacher'}, {}, b'', [], 'test-id'))
            finally:
                self.mail_patch.start()
        client.close.assert_called_once()

    def test_page_drops_query_credentials_and_non_route_fragment(self):
        self.assertEqual(feedback.safe_page('https://school.example/?token=hidden#account'), 'https://school.example/#account')
        self.assertEqual(feedback.safe_page('https://user:secret@school.example/'), '')
        self.assertEqual(feedback.safe_page('https://school.example/#token=hidden'), 'https://school.example/')

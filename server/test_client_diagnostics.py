from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone, timedelta
from unittest.mock import patch

from test_app import ServerTestCase
import app as service


class ClientDiagnosticTests(ServerTestCase):
    def report(self, **changes):
        return dict(edition='teacher', kind='manual', version='2.5.6',
                    installationId='11111111-1111-1111-1111-111111111111', deviceName='测试电脑',
                    summary='动画检查', report='Windows 动画：开启\npassword=private-password\n', **changes)

    async def test_teacher_upload_requires_login_and_csrf(self):
        response, _ = await self.json_request('POST', '/api/client-diagnostics', self.report())
        self.assertEqual(response.status, 401)
        await self.bootstrap_and_login()
        response, _ = await self.json_request('POST', '/api/client-diagnostics', self.report())
        self.assertEqual(response.status, 403)

    async def test_manual_report_is_stored_redacted_and_filterable(self):
        await self.bootstrap_and_login()
        response, sent = await self.json_request('POST', '/api/client-diagnostics', self.report(), csrf=True)
        self.assertEqual(response.status, 201, sent)
        response, listed = await self.json_request('GET', '/api/client-diagnostics?edition=teacher&kind=manual&q=测试&version=2.5.6')
        self.assertEqual(response.status, 200, listed)
        self.assertEqual(listed['total'], 1)
        self.assertNotIn('report', listed['items'][0])
        response, detail = await self.json_request('GET', '/api/client-diagnostics/' + sent['id'])
        self.assertEqual(response.status, 200, detail)
        self.assertIn('Windows 动画：开启', detail['report'])
        self.assertNotIn('private-', json.dumps(detail))
        _, empty = await self.json_request('GET', '/api/client-diagnostics?version=2.5.5')
        self.assertEqual(empty['total'], 0)

    async def test_device_upload_uses_binding_and_rejects_cookie_fallback(self):
        device = await self.enroll_test_device()
        body = self.report(); body.update(edition='classroom', kind='error')
        headers = {'Authorization': 'Bearer ' + device['deviceToken'], 'X-ICeClass-Device': device['deviceId']}
        response = await self.client.post('/api/client-diagnostics', json=body, headers=headers)
        self.assertEqual(response.status, 201, await response.text())
        _, rows = await self.json_request('GET', '/api/client-diagnostics?edition=classroom')
        self.assertEqual(rows['items'][0]['classId'], device['classId'])
        self.assertEqual(rows['items'][0]['deviceId'], device['deviceId'])
        headers.update(self.headers(csrf=True)); headers['Authorization'] = 'Bearer invalid'
        response = await self.client.post('/api/client-diagnostics', json=body, headers=headers)
        self.assertEqual(response.status, 401)

    async def test_retried_batch_is_idempotent(self):
        await self.bootstrap_and_login()
        body = self.report(id=str(uuid.uuid4()))
        for _ in range(4):
            response, sent = await self.json_request('POST', '/api/client-diagnostics', body, csrf=True)
            self.assertEqual(response.status, 201, sent)
            self.assertEqual(sent['id'], body['id'])
        _, listed = await self.json_request('GET', '/api/client-diagnostics')
        self.assertEqual(listed['total'], 1)

    async def test_device_binding_is_rechecked_before_storing(self):
        device = await self.enroll_test_device()
        body = self.report(); body.update(edition='classroom', kind='error')
        headers = {'Authorization': 'Bearer ' + device['deviceToken'], 'X-ICeClass-Device': device['deviceId']}
        authenticate = service.authenticate_device
        calls = 0
        def revoked_after_body(request, device_id):
            nonlocal calls
            calls += 1
            return authenticate(request, device_id) if calls == 1 else None
        with patch.object(service, 'authenticate_device', side_effect=revoked_after_body):
            response = await self.client.post('/api/client-diagnostics', json=body, headers=headers)
            self.assertEqual(response.status, 401, await response.text())
        self.assertEqual(calls, 2)
        self.assertEqual(self.app[service.STORE_KEY].one('SELECT count(*) AS n FROM client_diagnostics')['n'], 0)

    async def test_only_superadmin_can_read_diagnostics(self):
        await self.bootstrap_and_login()
        _, sent = await self.json_request('POST', '/api/client-diagnostics', self.report(), csrf=True)
        self.app[service.STORE_KEY].run("UPDATE users SET role='principal' WHERE username='ICe'")
        for path in ('/api/client-diagnostics', '/api/client-diagnostics/' + sent['id']):
            response, _ = await self.json_request('GET', path)
            self.assertEqual(response.status, 403)

    async def test_limits_identity_validation_and_rate_limit(self):
        await self.bootstrap_and_login()
        for update in ({'report': 'x' * (1024 * 1024 + 1)}, {'edition': 'classroom'}, {'classId': 'forged'}, {'installationId': '../bad'}):
            body = self.report(); body.update(update)
            response, _ = await self.json_request('POST', '/api/client-diagnostics', body, csrf=True)
            self.assertEqual(response.status, 400)
        for _ in range(3):
            response, _ = await self.json_request('POST', '/api/client-diagnostics', self.report(), csrf=True)
            self.assertEqual(response.status, 201)
        response, _ = await self.json_request('POST', '/api/client-diagnostics', self.report(), csrf=True)
        self.assertEqual(response.status, 429)

    async def test_weekly_cleanup_removes_only_old_client_reports_once(self):
        await self.bootstrap_and_login()
        _, sent = await self.json_request('POST', '/api/client-diagnostics', self.report(), csrf=True)
        from client_diagnostics import cleanup_client_diagnostics
        db = self.app[service.STORE_KEY]
        zone = timezone(timedelta(hours=8))
        monday = int(datetime(2026, 11, 9, 3, tzinfo=zone).timestamp() * 1000)
        db.run('UPDATE client_diagnostic_maintenance SET last_week=0')
        db.run('UPDATE client_diagnostics SET received_at=? WHERE id=?', (monday - 8 * 86400000, sent['id']))
        cleanup_client_diagnostics(db, monday - 3600000)
        # Before this Monday's 03:00 the previous week's cleanup cannot delete a newer report.
        self.assertIsNotNone(db.one('SELECT id FROM client_diagnostics WHERE id=?', (sent['id'],)))
        cleanup_client_diagnostics(db, monday)
        self.assertIsNone(db.one('SELECT id FROM client_diagnostics WHERE id=?', (sent['id'],)))
        db.run("INSERT INTO client_diagnostics(id,edition,kind,owner_id,installation_id,device_name,version,summary,report,received_at,byte_size) VALUES('late','teacher','error','test','test','test','2.5.6','','old',?,3)", (monday - 8 * 86400000,))
        cleanup_client_diagnostics(db, monday + 86400000)
        self.assertIsNotNone(db.one("SELECT id FROM client_diagnostics WHERE id='late'"))

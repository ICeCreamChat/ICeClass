import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from aiohttp.test_utils import TestClient, TestServer
import app as service


class DesktopReleaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'release'
        self.root.mkdir()
        self.bytes = b'disposable desktop update bytes'
        self.manifest = {'version': '2.3.1', 'size': len(self.bytes), 'sha256': hashlib.sha256(self.bytes).hexdigest()}
        self.client = TestClient(TestServer(service.create_app(Path(self.temp.name) / 'test.db', desktop_release_root=self.root)))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.temp.cleanup()

    def publish(self):
        (self.root / 'ICeClass.Desktop.exe').write_bytes(self.bytes)
        (self.root / 'manifest.json').write_text(json.dumps(self.manifest), encoding='utf8')

    async def test_no_release_and_invalid_version(self):
        response = await self.client.get('/api/desktop/update?currentVersion=2.3.0')
        self.assertEqual(await response.json(), {'available': False})
        response = await self.client.get('/api/desktop/update/download')
        self.assertEqual(response.status, 404)
        for invalid in ['', '../file', 'newest', '2.3.0-experimental']:
            response = await self.client.get('/api/desktop/update', params={'currentVersion': invalid})
            self.assertEqual(response.status, 400)

    async def test_public_update_metadata_and_downgrade_prevention(self):
        self.publish()
        response = await self.client.get('/api/desktop/update?currentVersion=2.3.0')
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {'available': True, **self.manifest, 'downloadUrl': '/api/desktop/update/download'})
        for version in ['2.3.1', '2.4.0']:
            response = await self.client.get('/api/desktop/update', params={'currentVersion': version})
            self.assertFalse((await response.json())['available'])

    async def test_download_supports_ranges_and_does_not_require_classroom_identity(self):
        self.publish()
        response = await self.client.get('/api/desktop/update/download')
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.read(), self.bytes)
        self.assertIn('ICeClass.Desktop.exe', response.headers['Content-Disposition'])
        response = await self.client.get('/api/desktop/update/download', headers={'Range': 'bytes=8-'})
        self.assertEqual(response.status, 206)
        self.assertEqual(await response.read(), self.bytes[8:])
        self.assertEqual(response.headers['Content-Range'], f'bytes 8-{len(self.bytes)-1}/{len(self.bytes)}')
        # A desktop executable cannot be obtained from the bound classroom update endpoint.
        response = await self.client.get('/api/receiver/update/download')
        self.assertEqual(response.status, 401)

    async def test_partial_or_invalid_publish_is_not_offered(self):
        self.publish()
        for key, value in [('size', 1), ('size', True), ('sha256', 'bad'), ('version', 'bad')]:
            bad = {**self.manifest, key: value}
            (self.root / 'manifest.json').write_text(json.dumps(bad), encoding='utf8')
            response = await self.client.get('/api/desktop/update?currentVersion=2.3.0')
            self.assertFalse((await response.json())['available'])
            response = await self.client.get('/api/desktop/update/download')
            self.assertEqual(response.status, 404)

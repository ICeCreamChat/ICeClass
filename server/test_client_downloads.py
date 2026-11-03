"""Public installers expose fixed package names and support browser resume."""
from pathlib import Path
import tempfile
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from client_downloads import install_client_downloads


class ClientDownloadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        app = web.Application()
        install_client_downloads(app, self.root, lambda body, status: web.json_response(body, status=status))
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.temporary.cleanup()

    async def test_four_fixed_packages_are_public_and_resumable(self):
        for kind in ('classroom', 'classroom-offline', 'teacher', 'teacher-offline'):
            data = b'PK installer ' + kind.encode()
            (self.root / f'ICeClass-{kind}.zip').write_bytes(data)
            response = await self.client.get('/api/client/download/' + kind, headers={'Range': 'bytes=3-'})
            self.assertEqual(response.status, 206)
            self.assertEqual(await response.read(), data[3:])
            self.assertEqual(response.headers['Content-Type'], 'application/zip')
            self.assertIn(f'ICeClass-{kind}.zip', response.headers['Content-Disposition'])
            response = await self.client.get(f'/download/ICeClass-{kind}.zip')
            self.assertEqual(await response.read(), data)
            response = await self.client.head('/api/client/download/' + kind)
            self.assertEqual(response.status, 200)
            self.assertEqual(int(response.headers['Content-Length']), len(data))

    async def test_missing_package_has_useful_feedback(self):
        response = await self.client.get('/api/client/download/teacher-offline')
        self.assertEqual(response.status, 404)
        self.assertIn('管理员', (await response.json())['error'])

    async def test_arbitrary_files_and_unknown_kinds_are_unavailable(self):
        (self.root / 'secret.zip').write_bytes(b'private')
        for kind in ('secret', 'server', '..%2fsecret'):
            response = await self.client.get('/api/client/download/' + kind)
            self.assertEqual(response.status, 404)
            self.assertNotIn(b'private', await response.read())


if __name__ == '__main__':
    unittest.main()

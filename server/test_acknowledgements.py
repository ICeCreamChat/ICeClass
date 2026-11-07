from __future__ import annotations

from aiohttp.test_utils import TestClient, TestServer

from test_app import ServerTestCase
import app as service


class AcknowledgementTests(ServerTestCase):
    path = '/api/about/acknowledgements'

    def content(self, revision=0):
        return {'revision': revision, 'sections': [
            {'title': '感谢支持与指导', 'body': '测试学校\n测试老师甲、测试老师乙'},
            {'title': '特别感谢', 'body': '测试老师丙'},
        ]}

    async def test_default_groups_are_available_to_unbound_and_classroom_clients(self):
        response = await self.client.get(self.path)
        self.assertEqual(response.status, 200)
        data = await response.json()
        self.assertEqual(data['revision'], 0)
        self.assertEqual([item['title'] for item in data['sections']],
                         ['感谢 AI 建模社', '感谢支持与指导', '特别感谢'])
        self.assertEqual(data['sections'][1]['body'],
                         '马鞍山市第二十二中学\n高琦璐校长、汪冰主任、李善忠干事\n陈胜老师、许斌老师')
        self.assertIn('no-store', response.headers['Cache-Control'])

    async def test_save_is_persistent_and_visible_to_another_classroom(self):
        await self.bootstrap_and_login()
        response, saved = await self.json_request('PUT', self.path, self.content(), csrf=True)
        self.assertEqual(response.status, 200, saved)
        self.assertEqual(saved['revision'], 1)
        self.assertEqual(saved['sections'], self.content()['sections'])
        reopened = service.create_app(service.Path(self.temp.name) / 'test.db')
        async with TestClient(TestServer(reopened)) as another:
            response = await another.get(self.path)
            self.assertEqual(response.status, 200)
            self.assertEqual((await response.json())['sections'], self.content()['sections'])
        events = self.app[service.STORE_KEY].all("SELECT action FROM audit_events WHERE action='about.acknowledgements.save'")
        self.assertEqual(len(events), 1)

    async def test_save_requires_superadmin_session_and_csrf(self):
        response = await self.client.put(self.path, json=self.content())
        self.assertEqual(response.status, 401)
        await self.bootstrap_and_login()
        response, _ = await self.json_request('PUT', self.path, self.content())
        self.assertEqual(response.status, 403)
        self.app[service.STORE_KEY].run("UPDATE users SET role='principal' WHERE username='ICe'")
        response, _ = await self.json_request('PUT', self.path, self.content(), csrf=True)
        self.assertEqual(response.status, 403)

    async def test_device_cannot_save_even_with_a_superadmin_cookie(self):
        await self.enroll_test_device()
        headers = {**self.headers(csrf=True), 'Authorization': 'Bearer invalid', 'X-ICeClass-Device': 'invalid'}
        response = await self.client.put(self.path, json=self.content(), headers=headers)
        self.assertIn(response.status, (401, 403))

    async def test_stale_revision_does_not_overwrite_the_newer_names(self):
        await self.bootstrap_and_login()
        response, _ = await self.json_request('PUT', self.path, self.content(), csrf=True)
        self.assertEqual(response.status, 200)
        old = self.content(); old['sections'][0]['body'] = '旧页面的内容'
        response, _ = await self.json_request('PUT', self.path, old, csrf=True)
        self.assertEqual(response.status, 409)
        response = await self.client.get(self.path)
        self.assertEqual((await response.json())['sections'], self.content()['sections'])

    async def test_invalid_content_never_partially_replaces_the_saved_names(self):
        await self.bootstrap_and_login()
        invalid = [
            {'revision': True, 'sections': self.content()['sections']},
            {'revision': 0, 'sections': []},
            {'revision': 0, 'sections': [{'title': '', 'body': '老师'}]},
            {'revision': 0, 'sections': [{'title': '标题', 'body': ['老师']}]},
            {'revision': 0, 'sections': [{'title': '标题', 'body': 'x' * 4001}]},
            {'revision': 0, 'sections': [{'title': '标题', 'body': '姓名\x00'}]},
            {'revision': 0, 'sections': [{'title': '标题', 'body': '正文', 'html': '<b>姓名</b>'}]},
            {**self.content(), 'deviceId': 'forged'},
        ]
        for body in invalid:
            with self.subTest(body=repr(body)[:100]):
                response, _ = await self.json_request('PUT', self.path, body, csrf=True)
                self.assertEqual(response.status, 400)
        response = await self.client.get(self.path)
        self.assertEqual((await response.json())['revision'], 0)

    async def test_plain_text_and_line_breaks_are_preserved(self):
        await self.bootstrap_and_login()
        body = {'revision': 0, 'sections': [{'title': '新增致谢', 'body': '老师甲\r\n<script>仅文字</script>\r老师乙'}]}
        response, saved = await self.json_request('PUT', self.path, body, csrf=True)
        self.assertEqual(response.status, 200, saved)
        self.assertEqual(saved['sections'][0]['body'], '老师甲\n<script>仅文字</script>\n老师乙')

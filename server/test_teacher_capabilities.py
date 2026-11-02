import unittest

from aiohttp import web

from teacher_capabilities import actions, reads, teacher_action, teacher_read, undeclared_routes


class CapabilityRegistryTest(unittest.TestCase):
    def test_registration_uses_real_route_and_remains_live(self):
        app = web.Application()

        @teacher_action('example.save', '保存示例', fields='value', roles=('superadmin',))
        async def save(request):
            return web.json_response({'ok': True})

        self.assertEqual(actions(app), {})
        app.router.add_put('/api/example', save)
        registered = actions(app)['example.save']
        self.assertEqual((registered.method, registered.path, registered.fields), ('PUT', '/api/example', 'value'))
        self.assertEqual(registered.roles, ('superadmin',))
        self.assertIs(registered.handler, save)

        @teacher_read('example', '示例数据', fields='start end')
        async def get(request):
            return web.json_response({'ok': True})

        app.router.add_get('/api/example', get)
        self.assertEqual(list(reads(app)), ['example'])
        self.assertEqual(undeclared_routes(app, prefixes=('/api/example',)), [])

    def test_new_teacher_route_requires_declaration(self):
        app = web.Application()

        async def missing(request):
            return web.json_response({})

        app.router.add_post('/api/example', missing)
        self.assertEqual(undeclared_routes(app, prefixes=('/api/example',)), ['POST /api/example'])
        self.assertEqual(undeclared_routes(app), ['POST /api/example'])

    def test_duplicate_ids_are_rejected(self):
        app = web.Application()

        @teacher_action('example.save', '保存')
        async def first(request):
            return web.json_response({})

        @teacher_action('example.save', '另一个保存')
        async def second(request):
            return web.json_response({})

        app.router.add_put('/api/one', first)
        app.router.add_put('/api/two', second)
        with self.assertRaisesRegex(ValueError, 'example.save'):
            actions(app)


if __name__ == '__main__':
    unittest.main()

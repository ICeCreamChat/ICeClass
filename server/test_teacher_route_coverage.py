"""The live teacher router is the capability catalog's source of truth."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app as service
from permissions import MANAGER_ROLES, SCHOOL_ROLES
from teacher_capabilities import actions, reads, undeclared_routes


class TeacherRouteCoverageTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        database_path = root / 'capabilities.db'
        database = service.Store(database_path)
        self.addCleanup(database.close)
        with patch.object(service, 'Store', return_value=database):
            self.app = service.create_app(database_path, root / 'receiver', root / 'desktop')

    def test_teacher_business_routes_are_declared(self):
        self.assertEqual(undeclared_routes(self.app), [])

    def test_original_eighteen_action_contracts_are_preserved(self):
        # Compatibility contract for callers already using these action IDs.
        expected = {
            'notice.send': ('发送班级通知', 'POST', '/api/shouts',
                'text alertLevel ttsVolume ttsSpeed displayDurationSec', 'class', False, ''),
            'class.create': ('创建班级', 'POST', '/api/classes', 'name', '', True, ''),
            'class.batch-create': ('批量创建班级', 'POST', '/api/classes/batch', 'grade start end', '', True, ''),
            'class.update': ('修改班级', 'PATCH', '/api/classes/{class_id}', 'name enabled', 'class', True,
                '停用会断开该班设备；更名会同步到教室。'),
            'class.rename-batch': ('批量更名或升班', 'POST', '/api/classes/rename-batch', 'changes', '', True,
                '将同时修改所列班级的名称和管理范围。'),
            'class.delete': ('删除班级', 'DELETE', '/api/classes/{class_id}', '', 'class', True,
                '将按平台规则删除班级及关联记录，无法撤销。'),
            'records.clear': ('清理班级记录', 'DELETE', '/api/classes/{class_id}/records',
                'kind start end allDates', 'class', True, '所选范围的记录会被永久清理，无法撤销。'),
            'user.create': ('创建账号', 'POST', '/api/teachers',
                'username displayName role classIds headClassIds teachingClassIds grade', '', True,
                '请在确认时填写初始密码；密码不会交给班班。'),
            'user.update': ('修改账号与授权', 'PATCH', '/api/teachers/{teacher_id}',
                'displayName role enabled classIds headClassIds teachingClassIds grade', 'user', True,
                '停用或调整权限后，该账号需要重新登录。'),
            'user.password': ('重置账号密码', 'PUT', '/api/teachers/{teacher_id}/password', '', 'user', True,
                '请在确认时填写新密码；原有登录会失效，密码不会交给班班。'),
            'user.delete': ('删除账号', 'DELETE', '/api/teachers/{teacher_id}', '', 'user', True,
                '将撤销账号登录及授权，历史审计仍保留。'),
            'device.update': ('修改设备绑定', 'PATCH', '/api/devices/{device_id}',
                'name classId enabled note verified', 'device', True, '改绑或停用会影响这台教室电脑的连接。'),
            'device.delete': ('移除设备', 'DELETE', '/api/devices/{device_id}', '', 'device', True,
                '将撤销该设备凭证并断开连接，需要重新绑定。'),
            'quiet.update': ('修改禁言时间', 'PUT', '/api/quiet-hours', 'periods', '', True,
                '将替换学校禁言时间表。'),
            'reading.update': ('修改晨读参数', 'PUT', '/api/reading/settings',
                'enabled reminderEnabled threshold periods', '', True, '将修改全校晨读参数；以平台校验结果为准。'),
            'island.update': ('修改课表与教室浮岛', 'PUT', '/api/island/classes/{class_id}',
                'config revision', 'class', True, '将同步课表、提醒、组件及自动化配置到该班教室。'),
            'history.delete': ('删除通知记录', 'DELETE', '/api/history/{message_id}', '', 'history', True,
                '将删除指定通知记录。'),
            'voice.delete': ('删除来音', 'DELETE', '/api/classroom-voice/{message_id}', '', 'voice', True,
                '将删除指定来音和音频文件。'),
        }
        catalog = actions(self.app)
        self.assertEqual(len(expected), 18)
        for capability_id, contract in expected.items():
            with self.subTest(capability=capability_id):
                spec = catalog[capability_id]
                self.assertEqual((spec.title, spec.method, spec.path, spec.fields, spec.target,
                                  spec.confirm, spec.impact), contract)

    def test_read_queries_and_existing_resource_ids(self):
        expected = {
            'classes': ('/api/classes', '', ''),
            'users': ('/api/teachers', '', ''),
            'devices': ('/api/classroom-controls', '', ''),
            'quiet': ('/api/quiet-hours', '', ''),
            'reading': ('/api/reading/settings', '', ''),
            'island': ('/api/island/classes/{class_id}', '', 'class'),
            'history': ('/api/history', 'classId limit offset', ''),
            'voice': ('/api/classroom-voice', 'classId', ''),
            'ideas': ('/api/ideas/admin', 'status classId page pageSize', ''),
            'ideas.summary': ('/api/ideas/admin/summary', '', ''),
            'reading.report': ('/api/reading/report', 'classId start end grades', ''),
            'class.status': ('/api/classes/{class_id}/status', '', 'class'),
        }
        catalog = reads(self.app)
        for capability_id, contract in expected.items():
            with self.subTest(capability=capability_id):
                spec = catalog[capability_id]
                self.assertEqual((spec.path, spec.fields, spec.target), contract)
                self.assertEqual(spec.method, 'GET')
                self.assertFalse(spec.confirm)

    def test_privileged_metadata_matches_handler_authorization(self):
        catalog, resources = actions(self.app), reads(self.app)
        managers = ('class.create', 'class.batch-create', 'class.update', 'class.rename-batch',
                    'class.delete', 'records.clear', 'user.create', 'user.update', 'user.password',
                    'user.delete', 'user.classes', 'device.update', 'device.delete', 'enrollment.class.create')
        for capability_id in managers:
            self.assertEqual(set(catalog[capability_id].roles), MANAGER_ROLES, capability_id)
        for capability_id in ('quiet.update', 'reading.update', 'island.visibility.update',
                              'enrollment.school.create', 'enrollment.school.revoke'):
            self.assertEqual(set(catalog[capability_id].roles), SCHOOL_ROLES, capability_id)
        for capability_id in ('users', 'device.bindings'):
            self.assertEqual(set(resources[capability_id].roles), MANAGER_ROLES, capability_id)
        for capability_id in ('reading', 'enrollment.school'):
            self.assertEqual(set(resources[capability_id].roles), SCHOOL_ROLES, capability_id)
        for spec in (catalog['idea.review'], resources['ideas'], resources['ideas.summary']):
            self.assertEqual(spec.roles, ('superadmin',))
        self.assertEqual(resources['island.visibility'].roles, ())
        for spec in (catalog['island.update'], catalog['island.import'], catalog['voice.delete'], resources['voice']):
            self.assertTrue(spec.head_only, spec.id)
        self.assertEqual(catalog['idea.review'].target, 'idea')
        self.assertEqual(catalog['idea.review'].fields, 'status reply published publishedTitle publishedText version')
        for spec in (*catalog.values(), *resources.values()):
            self.assertIsInstance(spec.roles, tuple, spec.id)

    def test_private_enrollment_results_exclude_secret_input(self):
        catalog, resources = actions(self.app), reads(self.app)
        for capability_id in ('enrollment.class.create', 'enrollment.school.create', 'enrollment.school.revoke'):
            spec = catalog[capability_id]
            self.assertEqual(spec.workflow, 'private-result')
            self.assertNotIn('code', spec.fields.split())
        self.assertEqual(catalog['enrollment.class.create'].target, 'class')
        self.assertEqual(catalog['enrollment.school.create'].fields, 'validDays')
        self.assertEqual(resources['enrollment.school'].workflow, 'private-result')
        for capability_id in ('user.create', 'user.password'):
            self.assertNotIn('password', catalog[capability_id].fields.split())

    def test_file_workflows_match_existing_routes(self):
        catalog = actions(self.app)
        expected = {
            'history.export': ('GET', '/api/history/export', 'classId', '', 'download'),
            'reading.export': ('GET', '/api/reading/export', 'classId start end grades format', '', 'download'),
            'island.export': ('GET', '/api/island/classes/{class_id}/export', '', 'class', 'download'),
            'island.import': ('POST', '/api/island/classes/{class_id}/import', '', 'class', 'island-import'),
        }
        for capability_id, contract in expected.items():
            with self.subTest(capability=capability_id):
                spec = catalog[capability_id]
                self.assertEqual((spec.method, spec.path, spec.fields, spec.target, spec.workflow), contract)
                self.assertFalse(spec.confirm)

    def test_original_handlers_and_assignment_delegate_remain_distinct(self):
        for spec in (*actions(self.app).values(), *reads(self.app).values()):
            route = next(route for route in self.app.router.routes()
                         if (route.method, route.resource.canonical) == (spec.method, spec.path))
            self.assertIs(spec.handler, route.handler)
        catalog = actions(self.app)
        self.assertIs(catalog['user.update'].handler, service.update_teacher)
        self.assertIs(catalog['user.classes'].handler, service.set_teacher_classes)
        self.assertIsNot(catalog['user.update'].handler, catalog['user.classes'].handler)

    def test_audio_and_device_protocols_have_concrete_manual_reasons(self):
        expected = {
            ('GET', '/api/shouts/{message_id}/audio'),
            ('POST', '/api/classroom-voice'),
            ('GET', '/api/classroom-voice/{message_id}/audio'),
            ('GET', '/api/reading/schedule'),
            ('POST', '/api/reading/launch'),
            ('POST', '/api/classes/{class_id}/control'),
        }
        for route in self.app.router.routes():
            key = route.method, route.resource.canonical
            if key not in expected:
                continue
            with self.subTest(route=key):
                reason = getattr(route.handler, '__teacher_manual__', '')
                self.assertGreater(len(reason.strip()), 16)
                self.assertFalse(getattr(route.handler, '__teacher_capabilities__', None))
            expected.remove(key)
        self.assertEqual(expected, set())


if __name__ == '__main__':
    unittest.main()

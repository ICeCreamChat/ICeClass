"""Classroom quiet periods inherit school defaults without locking teachers out."""
import copy
import unittest

import app as service
from island import defaults, normalize
from test_app import ServerTestCase


class VisibilityModelTest(unittest.TestCase):
    def test_legacy_hide_all_is_preserved_and_unknown_slots_are_rejected(self):
        old = defaults('高一')
        old.pop('visibility', None)
        old['appearance']['hideDuringLessons'] = True
        visibility = normalize(old).get('visibility')
        self.assertEqual(visibility, {'followSchool': False, 'hiddenSlotIds': [s['id'] for s in old['slots']]})
        old['visibility'] = {'followSchool': False, 'hiddenSlotIds': ['missing']}
        with self.assertRaises(ValueError):
            normalize(old)

    def test_visibility_selection_rejects_bad_types_and_duplicates(self):
        for invalid in (None, {'followSchool': 'yes'}, {'hiddenSlotIds': None},
                        {'hiddenSlotIds': ['period-1', 'period-1']}, {'hiddenSlotIds': [True]}):
            p = defaults('高一')
            p['visibility'] = invalid
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                normalize(p)


class VisibilityApiTest(ServerTestCase):
    async def setup_class(self):
        device = await self.enroll_test_device()
        return device, '/api/island/classes/' + device['classId']

    async def test_new_and_saved_profiles_resolve_school_defaults_using_class_slots(self):
        device, path = await self.setup_class()
        response, p = await self.json_request('GET', path)
        self.assertEqual(response.status, 200)
        self.assertEqual(p['config'].get('visibility'), {'followSchool': True, 'hiddenSlotIds': [
            'period-1', 'period-2', 'period-3', 'period-4', 'period-5', 'period-6', 'period-7', 'period-8', 'evening-study-1']})
        config = p['config']
        # School classification follows named/custom slots and the configured first evening period.
        config['slots'] = [{'id': 'custom-day', 'label': '第一节', 'start': 480, 'end': 525},
                           {'id': 'mid', 'label': '午间静校', 'start': 750, 'end': 815},
                           {'id': 'late', 'label': '晚自习第二节', 'start': 1200, 'end': 1290},
                           {'id': 'early', 'label': '晚自习第一节', 'start': 1100, 'end': 1190}]
        config['dutyRotations']['evening']['slotIds'] = ['late', 'early']
        config['visibility']['hiddenSlotIds'] = []
        response, saved = await self.json_request('PUT', path, {'revision': 0, 'config': config}, csrf=True)
        self.assertEqual(response.status, 200, saved)
        self.assertEqual(saved['config']['visibility']['hiddenSlotIds'], ['custom-day', 'early'])
        response = await self.client.get('/api/island/device?deviceId=' + device['deviceId'],
            headers={'Authorization': 'Bearer ' + device['deviceToken']})
        self.assertEqual((await response.json())['config'], saved['config'])

    async def test_school_update_invalidates_inherited_delivery_and_preserves_custom_class(self):
        device, path = await self.setup_class()
        _, original = await self.json_request('GET', path)
        _, saved = await self.json_request('PUT', path, {'revision': 0, 'config': original['config']}, csrf=True)
        _, custom_class = await self.json_request('POST', '/api/classes', {'name': '高二（2）班'}, csrf=True)
        custom_path = '/api/island/classes/' + custom_class['id']
        custom = defaults('高二')
        custom['visibility'] = {'followSchool': False, 'hiddenSlotIds': ['period-2']}
        _, custom_saved = await self.json_request('PUT', custom_path, {'revision': 0, 'config': custom}, csrf=True)
        response, school = await self.json_request('GET', '/api/island/visibility')
        self.assertEqual(response.status, 200, school)
        response, school = await self.json_request('PUT', '/api/island/visibility', {
            'revision': school['revision'], 'config': {'hideDaytimeLessons': False, 'hideFirstEvening': True}}, csrf=True)
        self.assertEqual(response.status, 200, school)
        _, inherited = await self.json_request('GET', path)
        self.assertEqual(inherited['revision'], saved['revision'] + 1)
        self.assertEqual(inherited['config']['visibility']['hiddenSlotIds'], ['evening-study-1'])
        self.assertEqual(inherited['config']['slots'], original['config']['slots'])
        self.assertEqual(inherited['schoolVisibility'], school)
        _, still_custom = await self.json_request('GET', custom_path)
        self.assertEqual(still_custom['revision'], custom_saved['revision'])
        self.assertEqual(still_custom['config']['visibility'], custom_saved['config']['visibility'])
        headers = {'Authorization': 'Bearer ' + device['deviceToken']}
        response = await self.client.post('/api/island/device/ack?deviceId=' + device['deviceId'],
            headers=headers, json={'revision': saved['revision']})
        self.assertEqual(response.status, 409)
        response, _ = await self.json_request('PUT', path, {'revision': saved['revision'], 'config': original['config']}, csrf=True)
        self.assertEqual(response.status, 409)
        # A repeated or stale global save must not bump every class again.
        _, unchanged = await self.json_request('PUT', '/api/island/visibility', school, csrf=True)
        self.assertEqual(unchanged['revision'], school['revision'])
        response, _ = await self.json_request('PUT', '/api/island/visibility', {'revision': 0, 'config': school['config']}, csrf=True)
        self.assertEqual(response.status, 409)

    async def test_teacher_overrides_class_but_cannot_write_school_defaults(self):
        device, path = await self.setup_class()
        _, other = await self.json_request('POST', '/api/classes', {'name': '高二（2）班'}, csrf=True)
        await self.json_request('POST', '/api/teachers', {'username': 'quiet.teacher', 'displayName': '教师',
            'password': 'TeacherPassword123', 'classIds': [device['classId']]}, csrf=True)
        response, login = await self.json_request('POST', '/api/auth/login', {'username': 'quiet.teacher', 'password': 'TeacherPassword123'})
        self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]
        self.csrf = login['user']['csrfToken']
        response, school = await self.json_request('GET', '/api/island/visibility')
        self.assertEqual(response.status, 200)
        response, _ = await self.json_request('PUT', '/api/island/visibility', {'revision': 0, 'config': {}}, csrf=True)
        self.assertEqual(response.status, 403)
        _, p = await self.json_request('GET', path)
        p['config']['visibility'] = {'followSchool': False, 'hiddenSlotIds': ['evening-study-2']}
        response, saved = await self.json_request('PUT', path, {'revision': 0, 'config': p['config']}, csrf=True)
        self.assertEqual(response.status, 200, saved)
        self.assertEqual(saved['config']['visibility']['hiddenSlotIds'], ['evening-study-2'])
        older = copy.deepcopy(saved['config'])
        older.pop('visibility')
        older['appearance']['width'] = 600
        response, updated = await self.json_request('PUT', path, {'revision': saved['revision'], 'config': older}, csrf=True)
        self.assertEqual(response.status, 200, updated)
        self.assertEqual(updated['config']['visibility'], saved['config']['visibility'])
        response, _ = await self.json_request('PUT', '/api/island/classes/' + other['id'],
            {'revision': 0, 'config': p['config']}, csrf=True)
        self.assertEqual(response.status, 403)

    async def test_invalid_global_settings_and_missing_csrf_leave_class_untouched(self):
        _, path = await self.setup_class()
        for invalid in (None, {'hideDaytimeLessons': 'true'}, {'hideFirstEvening': 1}):
            response, _ = await self.json_request('PUT', '/api/island/visibility', {'revision': 0, 'config': invalid}, csrf=True)
            self.assertEqual(response.status, 400)
        response, _ = await self.json_request('PUT', '/api/island/visibility', {'revision': 0, 'config': {}})
        self.assertEqual(response.status, 403)
        _, p = await self.json_request('GET', path)
        self.assertEqual(p['revision'], 0)


if __name__ == '__main__':
    unittest.main()

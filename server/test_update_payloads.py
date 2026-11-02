"""HTTP contract and integrity checks for content-addressed application updates."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

import app as service


class UpdatePayloadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.roots = {kind: Path(self.temp.name) / kind for kind in ('receiver', 'desktop')}
        for root in self.roots.values():
            (root / 'payloads').mkdir(parents=True)
        self.content = b'application update content, version 2.5.2'
        self.patch_content = b'patch'
        self.source = hashlib.sha256(b'previous application content').hexdigest()
        self.device_id = 'update-test-device'
        self.headers = {'Authorization': 'Bearer update-test-token'}
        self.app = service.create_app(
            Path(self.temp.name) / 'test.db', self.roots['receiver'], self.roots['desktop'])
        db = self.app[service.STORE_KEY]
        db.run("INSERT INTO classes(id,name,enabled,created_at,updated_at) VALUES ('update-class','update class',1,1,1)")
        db.run("""INSERT INTO devices(id,class_id,name,token_hash,enabled,created_at,updated_at)
                  VALUES (?,'update-class','update device',?,1,1,1)""",
               (self.device_id, service.sha256('update-test-token')))
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.temp.cleanup()

    def payload_file(self, kind, content):
        digest = hashlib.sha256(content).hexdigest()
        (self.roots[kind] / 'payloads' / digest).write_bytes(content)
        return digest

    def publish(self, kind):
        target = self.payload_file(kind, self.content)
        delta = self.payload_file(kind, self.patch_content)
        data = {'version': '2.5.2', 'files': [{
            'path': 'ICeClass.exe' if kind == 'receiver' else 'ICeClass.Desktop.exe',
            'size': len(self.content), 'sha256': target,
            'deltas': [{'sourceSha256': self.source, 'size': len(self.patch_content), 'sha256': delta}],
        }]}
        self.write_plan(kind, data)
        return data

    def write_plan(self, kind, data):
        (self.roots[kind] / 'update-plan.json').write_text(json.dumps(data), encoding='utf-8-sig')

    async def plan(self, kind, current='2.5.1', *, headers=None):
        params = {'currentVersion': current}
        if kind == 'receiver':
            params['deviceId'] = self.device_id
        response = await self.client.get(f'/api/{kind}/update/plan', params=params,
                                         headers=self.headers if headers is None else headers)
        self.assertIn(response.status, (200, 400, 401))
        return response

    async def payload(self, kind, digest, *, headers=None):
        params = {'sha256': digest}
        if kind == 'receiver':
            params['deviceId'] = self.device_id
        return await self.client.get(f'/api/{kind}/update/payload', params=params,
                                     headers=self.headers if headers is None else headers)

    async def assert_unavailable(self, kind, digest):
        response = await self.plan(kind)
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {'available': False})
        response = await self.payload(kind, digest)
        self.assertEqual(response.status, 404)
        await response.read()

    async def test_receiver_plan_returns_bound_target_patch_and_voice_urls(self):
        data = self.publish('receiver')
        voice_hash = self.payload_file('receiver', b'voice model')
        data['files'].append({'path': 'VoiceResources/models/en-US_v2.1/model.bin',
                              'size': 11, 'sha256': voice_hash})
        self.write_plan('receiver', data)
        response = await self.plan('receiver')
        self.assertEqual(response.status, 200)
        plan = await response.json()
        target, voice = plan['files']
        expected_target = copy.deepcopy(data['files'][0])
        expected_target['downloadUrl'] = (
            f"/api/receiver/update/payload?sha256={target['sha256']}&deviceId={self.device_id}")
        expected_target['deltas'][0]['downloadUrl'] = (
            f"/api/receiver/update/payload?sha256={target['deltas'][0]['sha256']}&deviceId={self.device_id}")
        self.assertEqual(plan, {'available': True, 'version': '2.5.2', 'files': [expected_target, {
            'path': 'VoiceResources/models/en-US_v2.1/model.bin', 'size': 11, 'sha256': voice_hash,
            'downloadUrl': f'/api/receiver/update/payload?sha256={voice_hash}&deviceId={self.device_id}',
            'deltas': [],
        }]})
        for item in (target, target['deltas'][0], voice):
            response = await self.client.get(item['downloadUrl'], headers=self.headers)
            self.assertEqual(response.status, 200)
            self.assertEqual(hashlib.sha256(await response.read()).hexdigest(), item['sha256'])

    async def test_desktop_plan_and_payloads_are_public(self):
        self.publish('desktop')
        response = await self.plan('desktop', headers={})
        self.assertEqual(response.status, 200)
        data = await response.json()
        self.assertTrue(data['available'])
        self.assertEqual(data['version'], '2.5.2')
        self.assertEqual(data['files'][0]['path'], 'ICeClass.Desktop.exe')
        for item in (data['files'][0], data['files'][0]['deltas'][0]):
            self.assertEqual(item['downloadUrl'], f"/api/desktop/update/payload?sha256={item['sha256']}")
            response = await self.client.get(item['downloadUrl'])
            self.assertEqual(response.status, 200)
            self.assertEqual(hashlib.sha256(await response.read()).hexdigest(), item['sha256'])

    async def test_missing_plan_does_not_replace_legacy_bootstrap(self):
        for kind in self.roots:
            with self.subTest(kind=kind):
                name = 'ICeClass.exe' if kind == 'receiver' else 'ICeClass.Desktop.exe'
                (self.roots[kind] / name).write_bytes(self.content)
                manifest = {'version': '2.5.2', 'size': len(self.content),
                            'sha256': hashlib.sha256(self.content).hexdigest()}
                (self.roots[kind] / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
                await self.assert_unavailable(kind, manifest['sha256'])
                params = {'currentVersion': '2.5.1'}
                if kind == 'receiver':
                    params['deviceId'] = self.device_id
                response = await self.client.get(f'/api/{kind}/update', params=params, headers=self.headers)
                legacy = await response.json()
                self.assertTrue(legacy['available'])
                self.assertNotIn('files', legacy)
                response = await self.client.get(legacy['downloadUrl'], headers=self.headers)
                self.assertEqual(await response.read(), self.content)

    async def test_current_version_uses_existing_validation(self):
        for kind in self.roots:
            for version in ('', '../file', 'latest', '2.5.1-beta', '1', '1.2.3.4.5', '2147483648.0'):
                with self.subTest(kind=kind, version=version):
                    response = await self.plan(kind, version)
                    self.assertEqual(response.status, 400)
                    self.assertIn('error', await response.json())

    async def test_same_or_newer_current_version_returns_only_available_and_version(self):
        for kind in self.roots:
            self.publish(kind)
            for version in ('2.5.2', '2.5.2.0', '2.6.0'):
                with self.subTest(kind=kind, version=version):
                    response = await self.plan(kind, version)
                    self.assertEqual(response.status, 200)
                    self.assertEqual(await response.json(), {'available': False, 'version': '2.5.2'})

    async def test_receiver_endpoints_require_matching_device_identity_including_head(self):
        data = self.publish('receiver')
        digest = data['files'][0]['sha256']
        for endpoint in ('plan', 'payload'):
            for device_id, headers in ((self.device_id, {}), ('', self.headers),
                                       ('another-device', self.headers),
                                       (self.device_id, {'Authorization': 'Bearer wrong-token'})):
                for method in ('GET', 'HEAD'):
                    with self.subTest(endpoint=endpoint, device=device_id, headers=headers, method=method):
                        response = await self.client.request(method, f'/api/receiver/update/{endpoint}',
                            params={'deviceId': device_id, 'sha256': digest, 'currentVersion': 'invalid'},
                            headers=headers)
                        self.assertEqual(response.status, 401)
                        await response.read()

    async def test_receiver_rechecks_disabled_deleted_devices_and_disabled_classes(self):
        data = self.publish('receiver')
        digest = data['files'][0]['sha256']
        self.assertEqual((await self.plan('receiver')).status, 200)
        db = self.app[service.STORE_KEY]
        for table, field, value, reset in (
                ('devices', 'enabled', 0, 1), ('devices', 'deleted_at', 1, None),
                ('classes', 'enabled', 0, 1)):
            with self.subTest(table=table, field=field):
                db.run(f'UPDATE {table} SET {field}=?', (value,))
                self.assertEqual((await self.plan('receiver')).status, 401)
                self.assertEqual((await self.payload('receiver', digest)).status, 401)
                db.run(f'UPDATE {table} SET {field}=?', (reset,))

    async def test_target_and_patch_downloads_support_ranges_and_security_headers(self):
        for kind in self.roots:
            data = self.publish(kind)
            for item, content in ((data['files'][0], self.content),
                                  (data['files'][0]['deltas'][0], self.patch_content)):
                with self.subTest(kind=kind, digest=item['sha256']):
                    for byte_range, expected_status, expected in (
                            (None, 200, content), ('bytes=2-4', 206, content[2:5]),
                            ('bytes=2-', 206, content[2:]), ('bytes=-2', 206, content[-2:])):
                        headers = dict(self.headers)
                        if byte_range:
                            headers['Range'] = byte_range
                        response = await self.payload(kind, item['sha256'], headers=headers)
                        self.assertEqual(response.status, expected_status)
                        self.assertEqual(await response.read(), expected)
                        self.assertEqual(response.headers['Cache-Control'], 'no-store')
                        self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
                        self.assertEqual(response.headers['Content-Type'], 'application/octet-stream')
                        if byte_range == 'bytes=2-4':
                            self.assertEqual(response.headers['Content-Range'], f'bytes 2-4/{len(content)}')
                    response = await self.payload(kind, item['sha256'],
                        headers={**self.headers, 'Range': f'bytes={len(content)}-'})
                    self.assertEqual(response.status, 416)
                    self.assertEqual(response.headers['Content-Range'], f'bytes */{len(content)}')
                    await response.read()

    async def test_unlisted_hashes_and_source_hashes_cannot_be_downloaded(self):
        for kind in self.roots:
            self.publish(kind)
            extra = self.payload_file(kind, b'unlisted private file')
            self.payload_file(kind, b'previous application content')
            for digest in (extra, self.source):
                with self.subTest(kind=kind, digest=digest):
                    response = await self.payload(kind, digest)
                    self.assertEqual(response.status, 404)
                    self.assertNotIn(b'unlisted private file', await response.read())

    async def test_payload_query_cannot_supply_paths_or_malformed_hashes(self):
        for kind in self.roots:
            self.publish(kind)
            for digest in ('', '../update-plan.json', '..\\manifest.json', '/etc/passwd',
                           'a' * 63, 'a' * 65, 'g' * 64, 'a' * 64 + ':data'):
                with self.subTest(kind=kind, digest=digest):
                    response = await self.payload(kind, digest)
                    self.assertEqual(response.status, 404)
                    await response.read()

    async def test_receiver_rejects_unsafe_or_unsupported_manifest_paths(self):
        original = self.publish('receiver')
        for name in ('../ICeClass.exe', '/ICeClass.exe', 'C:/ICeClass.exe', 'ICeClass.exe:stream',
                     'iceclass.exe', 'ICeClass.Desktop.exe', 'Other.exe', 'VoiceResources',
                     'VoiceResources/', 'VoiceResources//model.bin', 'VoiceResources/./model.bin',
                     'VoiceResources/../model.bin', 'VoiceResources/sub/../../model.bin',
                     'VoiceResources\\model.bin', 'VoiceResources/model.bin:stream',
                     'VoiceResources/model.', 'VoiceResources/model ', 'VoiceResources/CON',
                     'VoiceResources/nul.bin', 'VoiceResources/aux/model.bin',
                     'VoiceResources/PrN.txt', 'VoiceResources/com1.bin', 'VoiceResources/LPT9/model',
                     'VoiceResources/模型.bin', 'VoiceResources/a?b', 'VoiceResources/a%2fb',
                     'VoiceResources/model.bin\x00', 'voiceresources/model.bin'):
            with self.subTest(path=name):
                data = copy.deepcopy(original)
                data['files'][0]['path'] = name
                self.write_plan('receiver', data)
                await self.assert_unavailable('receiver', original['files'][0]['sha256'])

    async def test_desktop_allows_only_its_exact_executable(self):
        original = self.publish('desktop')
        for name in ('ICeClass.exe', 'iceclass.desktop.exe', 'VoiceResources/model.bin',
                     '../ICeClass.Desktop.exe', 'ICeClass.Desktop.exe:stream'):
            with self.subTest(path=name):
                data = copy.deepcopy(original)
                data['files'][0]['path'] = name
                self.write_plan('desktop', data)
                await self.assert_unavailable('desktop', original['files'][0]['sha256'])

    async def test_duplicate_case_conflicting_and_file_directory_targets_are_rejected(self):
        original = self.publish('receiver')
        for names in (('ICeClass.exe', 'ICeClass.exe'),
                      ('VoiceResources/a.bin', 'VoiceResources/a.bin'),
                      ('VoiceResources/A.bin', 'VoiceResources/a.bin'),
                      ('VoiceResources/Model/a.bin', 'VoiceResources/model/b.bin'),
                      ('VoiceResources/model', 'VoiceResources/model/a.bin'),
                      ('VoiceResources/model/a.bin', 'VoiceResources/model')):
            with self.subTest(paths=names):
                data = {'version': '2.5.2', 'files': [
                    {**original['files'][0], 'path': name} for name in names]}
                self.write_plan('receiver', data)
                await self.assert_unavailable('receiver', original['files'][0]['sha256'])

    async def test_distinct_targets_can_share_content_and_omit_or_empty_deltas(self):
        data = self.publish('receiver')
        item = data['files'][0]
        item.pop('deltas')
        data['files'].append({**item, 'path': 'VoiceResources/model-1.bin', 'deltas': []})
        self.write_plan('receiver', data)
        response = await self.plan('receiver')
        self.assertEqual(response.status, 200)
        files = (await response.json())['files']
        self.assertEqual(len(files), 2)
        self.assertEqual([item['deltas'] for item in files], [[], []])

    async def test_invalid_manifest_structure_version_size_and_digest_are_not_offered(self):
        for kind in self.roots:
            original = self.publish(kind)
            malformed = [None, [], {}, {'version': '2.5.2', 'files': []},
                         {'version': '2.5.2', 'files': {}}, {'version': '2.5.2', 'files': [None]}]
            for field, values in (
                    ('version', (None, 2.5, 'bad', '2147483648.0')),
                    ('path', (None, 1, [])),
                    ('size', (None, True, 0, -1, '40', 1.5, 1024 ** 3 + 1)),
                    ('sha256', (None, 1, 'a' * 63, 'a' * 65, 'g' * 64)),
                    ('deltas', (None, {}, [None]))):
                for value in values:
                    data = copy.deepcopy(original)
                    (data if field == 'version' else data['files'][0])[field] = value
                    malformed.append(data)
            for data in malformed:
                with self.subTest(kind=kind, data=data):
                    self.write_plan(kind, data)
                    await self.assert_unavailable(kind, original['files'][0]['sha256'])

    async def test_delta_requires_valid_source_digest_patch_digest_and_smaller_integer_size(self):
        for kind in self.roots:
            original = self.publish(kind)
            for field, values in (
                    ('sourceSha256', (None, '', 1, 'a' * 63, 'g' * 64)),
                    ('sha256', (None, '', 'a' * 65, 'z' * 64)),
                    ('size', (None, True, 0, -1, 1.5, '5', len(self.content), len(self.content) + 1))):
                for value in values:
                    with self.subTest(kind=kind, field=field, value=value):
                        data = copy.deepcopy(original)
                        data['files'][0]['deltas'][0][field] = value
                        self.write_plan(kind, data)
                        await self.assert_unavailable(kind, original['files'][0]['sha256'])

    async def test_file_count_limit_accepts_128_and_rejects_129_targets(self):
        original = self.publish('receiver')
        for count in (128, 129):
            data = {'version': '2.5.2', 'files': [
                {**original['files'][0], 'path': f'VoiceResources/model-{index}.bin', 'deltas': []}
                for index in range(count)]}
            self.write_plan('receiver', data)
            response = await self.plan('receiver')
            self.assertEqual(response.status, 200)
            body = await response.json()
            self.assertEqual(body['available'], count == 128)
            if count == 128:
                self.assertEqual(len(body['files']), 128)

    async def test_invalid_json_and_modified_manifest_revoke_previously_allowed_payloads(self):
        for kind in self.roots:
            data = self.publish(kind)
            digest = data['files'][0]['sha256']
            self.assertTrue((await (await self.plan(kind)).json())['available'])
            for contents in ('{', '\ufeffnot-json', json.dumps({**data, 'files': []})):
                with self.subTest(kind=kind, contents=contents):
                    (self.roots[kind] / 'update-plan.json').write_text(contents, encoding='utf-8')
                    await self.assert_unavailable(kind, digest)
            self.write_plan(kind, data)
            self.assertTrue((await (await self.plan(kind)).json())['available'])
            (self.roots[kind] / 'update-plan.json').unlink()
            await self.assert_unavailable(kind, digest)

    async def test_republishing_plan_revokes_hashes_removed_from_the_allowlist(self):
        for kind in self.roots:
            data = self.publish(kind)
            old_digest = data['files'][0]['sha256']
            self.assertEqual((await self.payload(kind, old_digest)).status, 200)
            data['files'][0]['sha256'] = self.payload_file(kind, b'replaced update application content...')
            data['files'][0]['size'] = len(b'replaced update application content...')
            self.write_plan(kind, data)
            response = await self.payload(kind, old_digest)
            self.assertEqual(response.status, 404)
            await response.read()
            response = await self.payload(kind, data['files'][0]['sha256'])
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.read(), b'replaced update application content...')

    async def test_missing_truncated_or_corrupted_target_or_patch_invalidates_entire_plan(self):
        for kind in self.roots:
            for entry_index in (0, 1):
                for damage in ('missing', 'size', 'digest'):
                    with self.subTest(kind=kind, entry=entry_index, damage=damage):
                        data = self.publish(kind)
                        items = (data['files'][0], data['files'][0]['deltas'][0])
                        response = await self.plan(kind)
                        self.assertTrue((await response.json())['available'])
                        target = self.roots[kind] / 'payloads' / items[entry_index]['sha256']
                        before = target.stat()
                        if damage == 'missing':
                            target.unlink()
                        elif damage == 'size':
                            target.write_bytes(b'x')
                        else:
                            replacement = target.with_suffix('.tmp')
                            replacement.write_bytes(b'x' * items[entry_index]['size'])
                            os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
                            replacement.replace(target)
                        await self.assert_unavailable(kind, items[1 - entry_index]['sha256'])

    async def test_unchanged_payloads_are_not_rehashed_on_each_plan_or_range_request(self):
        for kind in self.roots:
            data = self.publish(kind)
            response = await self.plan(kind)
            self.assertTrue((await response.json())['available'])
            with patch('update_payloads.payload_digest',
                       side_effect=AssertionError('Unchanged payload was rehashed')):
                self.assertTrue((await (await self.plan(kind)).json())['available'])
                response = await self.payload(kind, data['files'][0]['sha256'],
                    headers={**self.headers, 'Range': 'bytes=1-3'})
                self.assertEqual(response.status, 206)
                self.assertEqual(await response.read(), self.content[1:4])

    async def test_precompressed_siblings_cannot_replace_the_listed_payload(self):
        for kind in self.roots:
            data = self.publish(kind)
            digest = data['files'][0]['sha256']
            target = self.roots[kind] / 'payloads' / digest
            target.with_suffix('.gz').write_bytes(b'unlisted gzip bytes')
            target.with_suffix('.br').write_bytes(b'unlisted brotli bytes')
            response = await self.payload(kind, digest,
                headers={**self.headers, 'Accept-Encoding': 'gzip, br'})
            self.assertEqual(response.status, 200)
            self.assertNotIn('Content-Encoding', response.headers)
            self.assertEqual(await response.read(), self.content)

    async def test_payload_verification_supports_the_documented_python_310_runtime(self):
        with patch.object(hashlib, 'file_digest', None, create=True):
            for kind in self.roots:
                self.publish(kind)
                response = await self.plan(kind)
                self.assertEqual(response.status, 200)
                self.assertTrue((await response.json())['available'])


class UpdatePlanLimitTests(unittest.TestCase):
    def test_plan_validates_single_and_total_size_without_reading_gigabyte_fixtures(self):
        from update_payloads import validate_plan

        gib = 1024 ** 3
        for sizes, valid in (((gib,), True), ((gib, gib), True),
                             ((gib + 1,), False), ((gib, gib, 1), False)):
            with self.subTest(sizes=sizes):
                data = {'version': '2.5.2', 'files': [
                    {'path': f'VoiceResources/file-{index}.bin', 'size': size, 'sha256': 'a' * 64}
                    for index, size in enumerate(sizes)]}
                if valid:
                    plan = validate_plan(data, 'ICeClass.exe', service.parse_release_version)
                    self.assertEqual([item['size'] for item in plan['files']], list(sizes))
                else:
                    with self.assertRaises(ValueError):
                        validate_plan(data, 'ICeClass.exe', service.parse_release_version)


class DesktopUpdateActivityTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = UpdatePayloadTests.asyncSetUp
    asyncTearDown = UpdatePayloadTests.asyncTearDown

    def teacher(self, role='teacher'):
        db = self.app[service.STORE_KEY]
        db.run('''INSERT INTO users(id,username,display_name,role,password_hash,enabled,created_at,updated_at)
                  VALUES ('activity-teacher','activity-teacher','teacher',?,'unused',1,1,1)''', (role,))
        db.run('INSERT INTO sessions VALUES (?, ?, ?, ?, 1)',
               (service.sha256('activity-test-session'), 'activity-teacher', 'test-csrf', 9_999_999_999_999))
        table = 'teaching_classes' if role == 'subject_teacher' else 'teacher_classes'
        db.run(f'INSERT INTO {table}(user_id,class_id) VALUES (?, ?)', ('activity-teacher', 'update-class'))
        return {'Cookie': 'iceclass_session=activity-test-session'}

    def schedule(self, cid='update-class', *, start=480, end=520):
        from island import defaults, normalize
        config = defaults()
        config['slots'] = [{'id': 'p1', 'label': 'lesson', 'start': start, 'end': end}]
        config['lessons'] = [{'weekday': 1, 'slotId': 'p1', 'week': 'all',
                              'subject': 'lesson', 'teacher': '', 'location': ''}]
        config = normalize(config)
        self.app[service.STORE_KEY].run('INSERT OR REPLACE INTO island_profiles VALUES (?,1,?,1,NULL)',
                                       (cid, json.dumps(config)))
        return config

    async def activity(self, on, headers):
        from reading import SHANGHAI
        now = int(datetime.fromisoformat(on).replace(tzinfo=SHANGHAI).timestamp() * 1000)
        with patch.object(service, 'now_ms', return_value=now):
            response = await self.client.get('/api/desktop/update/activity', headers=headers)
        return response, now

    async def test_activity_requires_a_live_teacher_session_not_device_bearer(self):
        for headers in ({}, self.headers, {'Cookie': 'iceclass_session=unknown'}):
            response = await self.client.get('/api/desktop/update/activity', headers=headers)
            self.assertEqual(response.status, 401)
            await response.read()
        headers = self.teacher()
        self.schedule()
        self.app[service.STORE_KEY].run("UPDATE users SET enabled=0 WHERE id='activity-teacher'")
        response = await self.client.get('/api/desktop/update/activity', headers=headers)
        self.assertEqual(response.status, 401)

    async def test_server_time_and_lesson_boundaries_define_a_short_activity_lease(self):
        headers = self.teacher()
        self.schedule()
        for on, in_class, remaining in (
                ('2026-11-02T07:59:59.500', False, 500),
                ('2026-11-02T08:00:00', True, 15_000),
                ('2026-11-02T08:39:59.500', True, 500),
                ('2026-11-02T08:40:00', False, 15_000)):
            with self.subTest(on=on):
                response, now = await self.activity(on, headers)
                self.assertEqual(response.status, 200)
                self.assertEqual(await response.json(), {
                    'known': True, 'inClass': in_class, 'validUntil': now + remaining})
                self.assertEqual(response.headers['Cache-Control'], 'no-store')

    async def test_missing_corrupt_or_empty_schedules_fail_closed(self):
        headers = self.teacher()
        for config in (None, '{', json.dumps({'slots': []})):
            if config is not None:
                self.app[service.STORE_KEY].run('INSERT OR REPLACE INTO island_profiles VALUES (?,1,?,1,NULL)',
                                               ('update-class', config))
            response, now = await self.activity('2026-11-02T09:00:00', headers)
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {'known': False, 'inClass': True, 'validUntil': now + 15_000})
        self.schedule()
        response, now = await self.activity('2026-11-03T09:00:00', headers)
        self.assertEqual(await response.json(), {'known': True, 'inClass': False, 'validUntil': now + 15_000})

    async def test_only_authorized_enabled_classes_contribute_to_activity(self):
        headers = self.teacher('subject_teacher')
        self.schedule()
        db = self.app[service.STORE_KEY]
        db.run("INSERT INTO classes VALUES ('outside-class','outside',1,1,1)")
        self.schedule('outside-class', start=540, end=580)
        response, _ = await self.activity('2026-11-02T09:00:00', headers)
        self.assertEqual(await response.json(), {'known': True, 'inClass': False,
            'validUntil': int(datetime.fromisoformat('2026-11-02T01:00:15+00:00').timestamp() * 1000)})
        db.run("INSERT INTO teaching_classes(user_id,class_id) VALUES ('activity-teacher','outside-class')")
        response, _ = await self.activity('2026-11-02T09:00:00', headers)
        self.assertTrue((await response.json())['inClass'])
        db.run("UPDATE classes SET enabled=0 WHERE id='outside-class'")
        response, _ = await self.activity('2026-11-02T09:00:00', headers)
        self.assertFalse((await response.json())['inClass'])

    async def test_admin_uses_effective_grade_defaults_for_43_unsaved_profiles(self):
        headers = self.teacher('superadmin')
        self.schedule()
        db = self.app[service.STORE_KEY]
        for index in range(43):
            db.run('INSERT INTO classes VALUES (?,?,1,1,1)', (f'unconfigured-{index}', f'高二（{index + 1}）班'))
        response, _ = await self.activity('2026-11-02T09:00:00', headers)
        data = await response.json()
        self.assertTrue(data['known'])
        self.assertFalse(data['inClass'])
        response, _ = await self.activity('2026-11-02T08:00:00', headers)
        self.assertTrue((await response.json())['inClass'])

    async def test_corrupt_or_empty_saved_profiles_remain_fail_closed_with_other_valid_profiles(self):
        headers = self.teacher('superadmin')
        self.schedule()
        db = self.app[service.STORE_KEY]
        db.run("INSERT INTO classes VALUES ('second-class','second',1,1,1)")
        self.schedule('second-class')
        for value in ('{', json.dumps({'slots': []})):
            db.run('UPDATE island_profiles SET value=? WHERE class_id=?', (value, 'second-class'))
            response, _ = await self.activity('2026-11-02T09:00:00', headers)
            data = await response.json()
            self.assertFalse(data['known'])
            self.assertTrue(data['inClass'])

    async def test_all_44_grade_defaults_are_known_without_creating_saved_profiles(self):
        headers = self.teacher('superadmin')
        db = self.app[service.STORE_KEY]
        db.run("UPDATE classes SET name='高一（1）班' WHERE id='update-class'")
        for index in range(43):
            db.run('INSERT INTO classes VALUES (?,?,1,1,1)', (f'unconfigured-{index}', f'高三（{index + 1}）班'))
        response, _ = await self.activity('2026-11-02T09:00:00', headers)
        data = await response.json()
        self.assertTrue(data['known'])
        self.assertFalse(data['inClass'])
        self.assertEqual(db.one('SELECT COUNT(*) count FROM island_profiles')['count'], 0)

    async def test_valid_sunday_with_no_lessons_is_a_known_break(self):
        headers = self.teacher()
        self.schedule()
        response, now = await self.activity('2026-11-08T08:00:00', headers)
        self.assertEqual(await response.json(), {'known': True, 'inClass': False, 'validUntil': now + 15_000})

    async def test_no_authorized_classes_remain_unknown_and_midnight_bounds_the_lease(self):
        headers = self.teacher()
        db = self.app[service.STORE_KEY]
        db.run("DELETE FROM teacher_classes WHERE user_id='activity-teacher'")
        response, _ = await self.activity('2026-11-02T09:00:00', headers)
        self.assertFalse((await response.json())['known'])
        db.run("INSERT INTO teacher_classes VALUES ('activity-teacher','update-class')")
        self.schedule()
        response, now = await self.activity('2026-11-02T23:59:59.500', headers)
        self.assertEqual((await response.json())['validUntil'], now + 500)
        response, _ = await self.activity('2026-11-03T00:00:00', headers)
        self.assertTrue((await response.json())['known'])


if __name__ == '__main__':
    unittest.main()

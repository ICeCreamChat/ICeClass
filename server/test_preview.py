"""Acceptance fixtures are visible through the same endpoints as the workbench."""
import json
import sqlite3
import unittest
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import UUID

from aiohttp.test_utils import TestClient, TestServer

import app as service
import homework
from preview import create_preview, demo_rooms, initialize_school
from reading import local_day


class PreviewHttpTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        folder = TemporaryDirectory(prefix='iceclass-acceptance-')
        self.addCleanup(folder.cleanup)
        app = create_preview(Path(folder.name) / 'demo.db')
        self.room = next(demo_rooms(app[service.STORE_KEY]))
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)
        self.staff = await self.sign_in('/api/auth/login', 'ICe', 'LocalDemo2026', 'user')

    async def sign_in(self, route, username, password, identity):
        async with self.client.post(route, json={'username': username, 'password': password}) as response:
            data = await response.json()
            self.assertEqual(response.status, 200, data)
            self.assertEqual(response.headers['X-ICeClass-Preview'], '1')
            return {'Cookie': response.headers['Set-Cookie'].split(';', 1)[0], 'X-CSRF-Token': data[identity]['csrfToken']}

    async def get(self, path, *, headers=None):
        async with self.client.get(path, headers=self.staff if headers is None else headers) as response:
            self.assertEqual(response.status, 200, await response.text())
            return await response.json()

    async def test_homework_reading_and_island_are_ready_on_first_open(self):
        cid = self.room['id']
        homework_report = await self.get('/api/homework/report')
        self.assertEqual({r['className'] for r in homework_report['rows']}, {'高一（1）班', '高一（2）班'})
        self.assertTrue(any(r['missing'] > 0 for r in homework_report['rows']))
        self.assertTrue(any(r['status'] == 'no_homework' for r in homework_report['rows']))
        reading = await self.get('/api/reading/report')
        self.assertEqual(len([r for r in reading['rows'] if r['effectiveSeconds'] > 0]), 2)
        self.assertTrue(any(r['completed']['carrots'] > 0 for r in reading['rows']))
        timetable = (await self.get(f'/api/island/classes/{cid}'))['config']
        self.assertTrue(timetable['lessons'])
        self.assertTrue(timetable['dutyRotations']['evening']['lessons'])
        self.assertEqual({c['type'] for c in timetable['components']}, {'text', 'date', 'countdown'})

    async def test_teacher_report_and_student_card_use_the_same_classroom(self):
        cid = self.room['id']
        teacher = await self.sign_in('/api/auth/login', 'teacher1', 'LocalTeacher2026', 'user')
        types = ['single', 'boolean', 'multiple']
        bank = await self.get('/api/card-quiz/questions', headers=teacher)
        self.assertEqual([q['type'] for q in bank['questions']], types)
        report = await self.get(f'/api/card-quiz/report?classId={cid}', headers=teacher)
        self.assertEqual(len(report['students']), 12)
        first = next(row for row in report['students'] if row['studentId'] == 'preview-student-01')
        self.assertEqual((first['correct'], first['wrong']), (2, 1))
        self.assertTrue(any(r['incomplete'] == 1 for r in report['students']))
        device = {'Authorization': 'Bearer local-demo-device-1', 'X-ICeClass-Device-Id': self.room['device_id'],
                  'X-ICeClass-Class-Id': cid}
        published = (await self.get('/api/card-quiz/device/bootstrap', headers=device))['publications']
        publication_id = published[0]['id']
        self.assertEqual(str(UUID(publication_id)), publication_id)
        deck = await self.get('/api/card-quiz/device/publications/' + publication_id, headers=device)
        self.assertEqual(deck['id'], publication_id)
        self.assertEqual([q['type'] for q in deck['questions']], types)
        self.assertTrue(all(q['id'] == q['bankId'] and q['revision'] == q['bankVersion'] for q in deck['questions']))
        student = await self.sign_in('/api/student/login', '2610101', '260001', 'student')
        personal = await self.get('/api/student/report', headers=student)
        self.assertEqual([record['type'] for record in personal['records']], types)
        self.assertEqual((personal['totals']['correct'], personal['totals']['wrong']), (first['correct'], first['wrong']))
        self.assertNotIn('演示学生 02', json.dumps(personal, ensure_ascii=False))
        async with self.client.post('/api/student/card', headers=student, json={'password': '260001'}) as response:
            self.assertEqual(response.status, 200, await response.text())
            self.assertEqual((await response.json())['card']['cardNumber'], 1)

    async def test_review_and_playback_have_examples_to_operate(self):
        cid = self.room['id']
        events = await self.get(f'/api/self-study/events?classId={cid}')
        self.assertEqual(events['pending'], 1)
        self.assertTrue(any(e['resolution'] == 'false_alarm' for e in events['events']))
        pending = next(e for e in events['events'] if e['status'] == 'reported')
        async with self.client.post(f"/api/self-study/events/{pending['id']}/review", headers=self.staff,
                                    json={'resolution': 'handled'}) as response:
            self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await self.get(f'/api/self-study/events?classId={cid}'))['pending'], 0)
        messages = (await self.get('/api/classroom-voice'))['messages']
        self.assertEqual({m['played_by_me'] for m in messages}, {True, False})
        unheard = next(m for m in messages if not m['played_by_me'])
        async with self.client.get(unheard['audio_url'], headers=self.staff) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(service.validate_wav(await response.read())[0], unheard['audio_duration_ms'])
        self.assertTrue(all(m['played_by_me'] for m in (await self.get('/api/classroom-voice'))['messages']))
        ideas = (await self.get('/api/ideas/admin'))['items']
        self.assertCountEqual([item['status'] for item in ideas], ['pending', 'adopted', 'implementing', 'launched', 'declined'])
        candidate = next(item for item in ideas if item['status'] == 'pending')
        async with self.client.patch(f"/api/ideas/admin/{candidate['id']}", headers=self.staff,
                                     json={'status': 'adopted', 'reply': '通过验收', 'version': candidate['version']}) as response:
            self.assertEqual(response.status, 200, await response.text())
            self.assertEqual((await response.json())['item']['status'], 'adopted')
        history = (await self.get('/api/history'))['history']
        self.assertEqual({r['status'] for r in history}, {'displayed', 'offline', 'failed'})
        self.assertTrue(any(r['acknowledged_at'] for r in history))
        self.assertTrue((await self.get('/api/quiet-hours'))['periods'])


class PreviewPersistenceTest(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory(prefix='iceclass-acceptance-')
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / 'demo.db'

    def test_restart_repairs_legacy_publication_without_reseeding(self):
        legacy_id = 'preview-workbench-publication'
        with closing(create_preview(self.path)[service.STORE_KEY]) as db:
            saved = db.one('SELECT * FROM card_quiz_publications')
            value = json.loads(saved['value'])
            db.run('UPDATE card_quiz_publications SET id=?,value=? WHERE id=?',
                   (legacy_id, json.dumps({**value, 'id': legacy_id}), saved['id']))
            sessions = db.all('SELECT * FROM card_quiz_sessions')
        with closing(create_preview(self.path)[service.STORE_KEY]) as db:
            repaired, = db.all('SELECT * FROM card_quiz_publications')
            self.assertEqual(str(UUID(repaired['id'])), repaired['id'])
            self.assertEqual(json.loads(repaired['value']), {**value, 'id': repaired['id']})
            self.assertEqual({**repaired, 'id': saved['id'], 'value': saved['value']}, saved)
            self.assertEqual(db.all('SELECT * FROM card_quiz_sessions'), sessions)
        with closing(create_preview(self.path)[service.STORE_KEY]) as db:
            self.assertEqual(db.all('SELECT * FROM card_quiz_publications'), [repaired])

    def test_legacy_demo_keeps_existing_roster_and_presets_an_unused_class(self):
        legacy = service.create_app(self.path)
        now = service.now_ms()
        with closing(legacy[service.STORE_KEY]) as db, db.transaction():
            initialize_school(legacy, now)
            first, second = list(demo_rooms(db))
            value = homework.defaults()
            value['students'].append({'id': 'existing-student', 'name': '原有演示学生'})
            db.run('INSERT INTO homework_profiles VALUES(?,5,?,?,?)', (first['id'], json.dumps(value), now, 'preview-admin'))
            saved = db.one('SELECT * FROM homework_profiles WHERE class_id=?', (first['id'],))
        with closing(create_preview(self.path)[service.STORE_KEY]) as db:
            self.assertEqual(db.one('SELECT * FROM homework_profiles WHERE class_id=?', (first['id'],)), saved)
            self.assertIsNone(db.one('SELECT 1 FROM homework_records WHERE class_id=?', (first['id'],)))
            self.assertEqual(db.one('SELECT class_id FROM card_quiz_sessions')['class_id'], second['id'])

    def test_restart_keeps_deletions_and_adds_samples_only_for_the_new_day(self):
        now = service.now_ms()
        with patch.object(service, 'now_ms', return_value=now), closing(create_preview(self.path)[service.STORE_KEY]) as db:
            db.run('DELETE FROM homework_records WHERE day=?', (local_day(now),))
            db.run("UPDATE ideas SET reply='老师修改过' WHERE status='pending'")
            db.run('DELETE FROM self_study_events WHERE handled_at IS NULL')
        with patch.object(service, 'now_ms', return_value=now), closing(create_preview(self.path)[service.STORE_KEY]) as db:
            self.assertIsNone(db.one('SELECT 1 FROM homework_records WHERE day=?', (local_day(now),)))
            self.assertIsNone(db.one('SELECT 1 FROM self_study_events WHERE handled_at IS NULL'))
        tomorrow = now + 86_400_000
        with patch.object(service, 'now_ms', return_value=tomorrow), closing(create_preview(self.path)[service.STORE_KEY]) as db:
            self.assertIsNone(db.one('SELECT 1 FROM homework_records WHERE day=?', (local_day(now),)))
            self.assertIsNotNone(db.one('SELECT 1 FROM homework_records WHERE day=?', (local_day(tomorrow),)))
            self.assertEqual(db.one("SELECT reply FROM ideas WHERE status='pending'")['reply'], '老师修改过')
            self.assertEqual(db.one('SELECT COUNT(*) AS n FROM card_quiz_sessions')['n'], 1)
            self.assertEqual(db.all('PRAGMA foreign_key_check'), [])

    def test_non_preview_database_is_refused_before_schema_changes(self):
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('CREATE TABLE real_data(id INTEGER PRIMARY KEY)')
        with self.assertRaisesRegex(ValueError, '不是本地验收库'):
            create_preview(self.path)
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall(), [('real_data',)])

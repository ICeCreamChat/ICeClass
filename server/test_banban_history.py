import json
from datetime import datetime
from unittest.mock import patch

import app as service
import test_banban as fixtures
from banban_history import BanbanHistory
from reading import SHANGHAI
from test_app import ServerTestCase
import test_banban_agent as agent_fixtures


def stamp(year, month, day, hour=0, minute=0):
    return int(datetime(year, month, day, hour, minute, tzinfo=SHANGHAI).timestamp() * 1000)


class HistoryTest(ServerTestCase):
    seed = fixtures.BanbanTest.seed
    voice = fixtures.BanbanTest.voice
    shout = fixtures.BanbanTest.shout
    scope = fixtures.BanbanTest.scope
    login_staff = fixtures.BanbanTest.login_staff
    events = agent_fixtures.AgentTest.events

    async def asyncSetUp(self):
        self.env = patch.dict('os.environ', {'DEEPSEEK_API_KEY': ''})
        self.env.start()
        await super().asyncSetUp()
        self.agent = next(r.handler.__self__ for r in self.app.router.routes()
                          if r.method == 'POST' and r.resource.canonical == '/api/banban/chat/stream')
        self.history = self.agent.history

    async def asyncTearDown(self):
        await super().asyncTearDown()
        self.env.stop()

    def admin(self):
        return {'id': self.uid, 'role': 'superadmin'}

    def add(self, user, cid, label):
        return self.history.append(user, cid, self.agent.access(user), self.scope(),
            [{'role': 'user', 'content': label}, {'role': 'assistant', 'content': '回复：' + label, 'cards': [], 'mode': 'overview'}])

    async def test_full_messages_beyond_ten_rounds_paging_and_context_budget(self):
        await self.seed()
        user = self.admin()
        cid = self.history.create(user)['id']
        for number in range(27):
            result, events = await self.events({'message': '你是谁？', 'conversationId': cid})
            self.assertEqual(result.status, 200)
            self.assertEqual(events[-1]['conversationId'], cid)
        _, newest = await self.json_request('GET', '/api/banban/conversation?conversationId=' + cid)
        self.assertEqual(newest['messageCount'], 54)
        self.assertEqual(len(newest['messages']), 40)
        self.assertTrue(newest['hasMore'])
        _, older = await self.json_request('GET', f'/api/banban/conversation?conversationId={cid}&before={newest["beforeId"]}')
        self.assertEqual(len(older['messages']), 14)
        self.assertFalse(older['hasMore'])
        self.assertEqual((older['messages'] + newest['messages'])[0]['content'], '你是谁？')
        self.add(user, cid, 'a' * 2000)
        self.add(user, cid, 'b' * 2000)
        self.add(user, cid, 'c' * 2000)
        self.assertLessEqual(sum(len(m['content'][:8000]) for m in self.history.context(user, cid)['messages']), 24000)
        self.assertEqual(self.history.get(user, cid)['message_count'], 60)

    async def test_new_switch_refresh_and_same_account_multiple_threads(self):
        await self.seed()
        _, first = await self.json_request('POST', '/api/banban/conversations', {}, csrf=True)
        self.add(self.admin(), first['id'], '第一段问题')
        _, second = await self.json_request('POST', '/api/banban/conversations', {}, csrf=True)
        self.assertNotEqual(first['id'], second['id'])
        self.add(self.admin(), second['id'], '第二段问题')
        _, listing = await self.json_request('GET', '/api/banban/conversations')
        self.assertEqual({c['title'] for c in listing['conversations']}, {'第一段问题', '第二段问题'})
        _, restored = await self.json_request('POST', f'/api/banban/conversations/{first["id"]}/open', {}, csrf=True)
        self.assertEqual(restored['messages'][0]['content'], '第一段问题')
        _, refreshed = await self.json_request('GET', '/api/banban/conversation')
        self.assertEqual(refreshed['id'], first['id'])
        await self.events({'message': '你是谁？', 'conversationId': first['id']})
        self.assertEqual(self.history.get(self.admin(), second['id'])['message_count'], 2)
        self.assertEqual(self.history.get(self.admin(), first['id'])['message_count'], 4)
        # An already-open page from the old version must not delete history.
        _, fresh = await self.json_request('DELETE', '/api/banban/conversation', {}, csrf=True)
        self.assertEqual(fresh['messages'], [])
        self.assertEqual(self.history.get(self.admin(), first['id'])['message_count'], 4)
        self.assertEqual(self.history.get(self.admin(), second['id'])['message_count'], 2)

    async def test_account_ownership_role_scope_and_policy_permissions(self):
        await self.seed()
        admin = self.admin()
        cid = self.history.create(admin)['id']
        self.add(admin, cid, '管理员专属内容')
        teacher = await self.login_staff('teacher')
        _, listing = await self.json_request('GET', '/api/banban/conversations')
        self.assertEqual(listing['conversations'], [])
        for method, path in [('GET', f'/api/banban/conversation?conversationId={cid}'),
                             ('POST', f'/api/banban/conversations/{cid}/open')]:
            result, body = await self.json_request(method, path, {}, csrf=method == 'POST')
            self.assertEqual(result.status, 404)
            self.assertNotIn('管理员专属内容', json.dumps(body, ensure_ascii=False))
        result, _ = await self.events({'message': '你好', 'conversationId': cid})
        self.assertEqual(result.status, 400)
        for method in ['GET', 'PUT']:
            result, _ = await self.json_request(method, '/api/banban/history-policy', {'cycle':'weekly'}, csrf=True)
            self.assertEqual(result.status, 403)
        own = self.history.create(teacher)['id']
        self.add(teacher, own, '本班记录')
        self.db.run('DELETE FROM teacher_classes WHERE user_id=?', (teacher['id'],))
        self.assertIsNone(self.history.get(teacher, own))
        self.assertEqual(self.history.listing(teacher)['conversations'], [])
        self.assertIsNotNone(self.db.one('SELECT id FROM banban_conversations WHERE id=?', (own,)))

    async def test_monthly_no_daily_expiry_and_background_cleanup(self):
        await self.seed()
        user = self.admin()
        with patch.object(service, 'now_ms', return_value=stamp(2026, 10, 17)):
            self.db.run('UPDATE banban_history_policy SET next_cleanup_at=?', (stamp(2026, 11, 1),))
            cid = self.history.create(user)['id']
            self.add(user, cid, '十月的完整对话')
        for timestamp in [stamp(2026, 10, 19), stamp(2026, 10, 31, 23, 59)]:
            with patch.object(service, 'now_ms', return_value=timestamp):
                await service.cleanup(self.app)
                self.assertEqual(len(self.history.load(user, cid)['messages']), 2)
        reading_count = self.db.one('SELECT COUNT(*) n FROM reading_sessions')['n']
        with patch.object(service, 'now_ms', return_value=stamp(2026, 11, 1)):
            await service.cleanup(self.app)
            self.assertIsNone(self.history.get(user, cid))
            self.assertEqual(self.db.one('SELECT COUNT(*) n FROM banban_conversation_messages')['n'], 0)
            self.assertEqual(self.history.policy()['nextCleanupAt'], stamp(2026, 12, 1))
            self.assertEqual(self.db.one('SELECT COUNT(*) n FROM reading_sessions')['n'], reading_count)
            fresh = self.history.create(user)['id']
            self.add(user, fresh, '新的月份')
            self.assertFalse(self.history.cleanup_due())

    async def test_teacher_permanent_delete_removes_messages_and_active_reference(self):
        await self.seed()
        teacher = await self.login_staff('teacher')
        first = self.history.create(teacher)['id']
        self.add(teacher, first, '教师的第一段对话')
        second = self.history.create(teacher)['id']
        self.add(teacher, second, '保留的对话')
        readings = self.db.one('SELECT COUNT(*) n FROM reading_sessions')['n']
        result, body = await self.json_request('DELETE', '/api/banban/conversations/' + first, csrf=True)
        self.assertEqual(result.status, 200, body)
        self.assertEqual(body['conversation']['id'], second)
        self.assertIsNone(self.db.one('SELECT id FROM banban_conversations WHERE id=?', (first,)))
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM banban_conversation_messages WHERE conversation_id=?', (first,))['n'], 0)
        with self.assertRaises(ValueError):
            self.add(teacher, first, '晚到回复不能恢复已删除的对话')
        result, body = await self.json_request('DELETE', '/api/banban/conversations/' + second, csrf=True)
        self.assertEqual(result.status, 200, body)
        self.assertIsNone(body['conversation']['id'])
        self.assertEqual(body['conversation']['messages'], [])
        self.assertIsNone(self.db.one('SELECT * FROM banban_active_conversations WHERE user_id=?', (teacher['id'],)))
        self.assertEqual(self.history.listing(teacher)['conversations'], [])
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM reading_sessions')['n'], readings)
        result, _ = await self.json_request('POST', '/api/banban/conversations/' + second + '/open', csrf=True)
        self.assertEqual(result.status, 404)
        # The account can continue normally after deleting its last thread.
        result, fresh = await self.json_request('POST', '/api/banban/conversations', csrf=True)
        self.assertEqual(result.status, 201)
        self.assertNotIn(fresh['id'], {first, second})

    async def test_delete_owner_csrf_busy_and_no_administrator_bypass(self):
        path = '/api/banban/conversations/not-a-thread'
        result, _ = await self.json_request('DELETE', path)
        self.assertEqual(result.status, 401)
        await self.seed()
        admin = self.admin()
        admin_thread = self.history.create(admin)['id']
        self.add(admin, admin_thread, '管理员的对话')
        admin_cookie, admin_csrf = self.cookie, self.csrf
        teacher = await self.login_staff('teacher')
        result, body = await self.json_request('DELETE', '/api/banban/conversations/' + admin_thread, csrf=True)
        self.assertEqual(result.status, 404)
        self.assertNotIn('管理员的对话', json.dumps(body, ensure_ascii=False))
        own = self.history.create(teacher)['id']
        self.add(teacher, own, '教师保留的内容')
        result, _ = await self.json_request('DELETE', '/api/banban/conversations/' + own)
        self.assertEqual(result.status, 403)
        self.agent.f.busy.add(teacher['id'])
        try:
            result, _ = await self.json_request('DELETE', '/api/banban/conversations/' + own, csrf=True)
            self.assertEqual(result.status, 409)
            self.assertIsNotNone(self.history.get(teacher, own))
        finally:
            self.agent.f.busy.discard(teacher['id'])
        self.cookie, self.csrf = admin_cookie, admin_csrf
        result, _ = await self.json_request('DELETE', '/api/banban/conversations/' + own, csrf=True)
        self.assertEqual(result.status, 404)
        self.assertIsNotNone(self.history.get(teacher, own))
        self.assertIsNotNone(self.history.get(admin, admin_thread))

    async def test_deleting_active_thread_restores_remaining_history(self):
        await self.seed()
        user = self.admin()
        first = self.history.create(user)['id']
        self.add(user, first, '继续保留')
        active = self.history.create(user)['id']
        self.add(user, active, '删除当前对话')
        result, body = await self.json_request('DELETE', '/api/banban/conversations/' + active, csrf=True)
        self.assertEqual(result.status, 200, body)
        self.assertEqual(body['conversation']['id'], first)
        self.assertEqual(body['conversation']['messages'][0]['content'], '继续保留')
        _, restored = await self.json_request('GET', '/api/banban/conversation')
        self.assertEqual(restored['id'], first)

    async def test_late_restart_does_not_delete_new_period_threads(self):
        await self.seed()
        user = self.admin()
        with patch.object(service, 'now_ms', return_value=stamp(2026, 10, 25)):
            old = self.history.create(user)['id']
            self.add(user, old, '旧周期')
        new_time = stamp(2026, 11, 2)
        self.db.run('INSERT INTO banban_conversations VALUES(?,?,?,?,?,?,?,0)',
                    ('new-period', user['id'], self.history.owner_clause(user)[1], '新周期', '{}', new_time, new_time))
        with patch.object(service, 'now_ms', return_value=new_time):
            self.history.cleanup_due()
            self.assertIsNone(self.history.get(user, old))
            self.assertIsNotNone(self.history.get(user, 'new-period'))
            with self.assertRaises(ValueError):
                self.add(user, old, '清理中的晚到回复不能复活旧对话')

    async def test_weekly_policy_validation_csrf_and_schedule(self):
        await self.seed()
        user = self.admin()
        with patch.object(service, 'now_ms', return_value=stamp(2026, 10, 18, 20)):
            cid = self.history.create(user)['id']
            self.add(user, cid, '不会在改周期时立即删除')
        result, _ = await self.json_request('PUT', '/api/banban/history-policy', {'cycle':'weekly'})
        self.assertEqual(result.status, 403)
        for invalid in [[], {}, {'cycle':[]}, {'cycle':None}, {'cycle':'daily'}]:
            result, _ = await self.json_request('PUT', '/api/banban/history-policy', invalid, csrf=True)
            self.assertEqual(result.status, 400)
        with patch.object(service, 'now_ms', return_value=stamp(2026, 10, 18, 23, 59)):
            result, policy = await self.json_request('PUT', '/api/banban/history-policy', {'cycle':'weekly'}, csrf=True)
            self.assertEqual(result.status, 200)
            self.assertEqual(policy['nextCleanupAt'], stamp(2026, 10, 19))
            self.assertIsNotNone(self.history.get(user, cid))
        with patch.object(service, 'now_ms', return_value=stamp(2026, 10, 19)):
            await service.cleanup(self.app)
            self.assertIsNone(self.history.get(user, cid))
        self.assertEqual(self.history.next_boundary('monthly', stamp(2026, 12, 31)), stamp(2027, 1, 1))
        self.assertEqual(self.history.next_boundary('weekly', stamp(2026, 10, 19)), stamp(2026, 10, 26))

    async def test_thread_cursor_and_message_order_without_duplicates(self):
        await self.seed()
        user = self.admin()
        ids = set()
        for number in range(35):
            cid = self.history.create(user)['id']
            self.add(user, cid, f'对话 {number}')
            ids.add(cid)
        first = self.history.listing(user)
        self.assertEqual(len(first['conversations']), 30)
        cursor = first['nextCursor']
        second = self.history.listing(user, (cursor['updatedAt'], cursor['id']))
        listed = first['conversations'] + second['conversations']
        self.assertEqual(len(listed), 35)
        self.assertEqual({row['id'] for row in listed}, ids)
        self.assertIsNone(second['nextCursor'])

    async def test_legacy_migration_keeps_existing_content_and_is_repeatable(self):
        await self.seed()
        user = self.admin()
        for table in ['banban_active_conversations', 'banban_conversation_messages', 'banban_conversations', 'banban_history_policy']:
            self.db.run('DROP TABLE ' + table)
        self.db.run('''CREATE TABLE banban_conversations(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            access TEXT NOT NULL,messages TEXT NOT NULL,scope TEXT NOT NULL,updated_at INTEGER NOT NULL)''')
        messages = [{'role':'user' if n % 2 == 0 else 'assistant','content':f'原对话 {n}'} for n in range(26)]
        self.db.run('INSERT INTO banban_conversations VALUES(?,?,?,?,?)',
                    (user['id'], json.dumps(self.agent.access(user)), json.dumps(messages), json.dumps(self.scope()), 0))
        migrated = BanbanHistory(self.db, service.now_ms, self.agent.access)
        saved = migrated.load(user)
        self.assertEqual(saved['messages'], messages)
        self.assertEqual(saved['messageCount'], 26)
        again = BanbanHistory(self.db, service.now_ms, self.agent.access)
        self.assertEqual(again.load(user)['id'], saved['id'])
        self.assertEqual(len(again.listing(user)['conversations']), 1)

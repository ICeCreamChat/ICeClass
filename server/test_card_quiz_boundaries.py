"""Device history lookup and complete native-wire receipt acceptance regressions."""
import copy
import json
import shutil
import subprocess
import uuid
from unittest.mock import patch

import app as service
from test_card_quiz import CardQuizHttpCase, PREFIX, STAMP


class CardQuizBoundaryTests(CardQuizHttpCase):
    def original_receipt(self, journal, cid):
        receipt = {'id': cid, **copy.deepcopy(journal['receipts'][cid])}
        receipt['result']['state']['className'] = self.db.one(
            'SELECT name FROM classes WHERE id=?', (self.cid,))['name']
        return receipt

    @staticmethod
    def native_json(value):
        # On Windows exercise exactly JsonNode.ToJsonString(), as used by the
        # native outbox. Other hosts can still exercise the shared JS and HTTP.
        shell = shutil.which('pwsh')
        if not shell:
            return json.dumps(value, ensure_ascii=True, separators=(',', ':'))
        result = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-Command',
            '$raw=[Console]::In.ReadToEnd(); '
            '[System.Text.Json.Nodes.JsonNode]::Parse($raw).ToJsonString()'],
            input=json.dumps(value, ensure_ascii=True), capture_output=True,
            text=True, encoding='utf-8', check=True, timeout=20)
        return result.stdout.strip()

    async def lookup(self, ids, *, sid='session-1', status=200, headers=None):
        return await self.api('POST', '/device/receipt-ids', {'sessionId': sid, 'ids': ids},
                              status, self.dh if headers is None else headers)

    async def test_receipt_ids_only_returns_supplied_registered_commands_without_mutation(self):
        pair, _, _ = await self.active_pair()
        ids = [str(uuid.uuid4()) for _ in range(3)]
        for cid in ids:
            await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', self.command(pair, id=cid))
        self.db.run("UPDATE card_quiz_commands SET status='rejected',error='设备明确拒绝',rejection_origin='device' WHERE id=?", (ids[1],))
        self.db.run("UPDATE card_quiz_commands SET status='confirmed',result='{}' WHERE id=?", (ids[2],))
        before = self.db.all('SELECT * FROM card_quiz_commands ORDER BY id')
        wanted = [ids[2], str(uuid.uuid4()), ids[0], ids[1]]
        self.assertEqual(await self.lookup(wanted), {'commandIds': [ids[2], ids[0], ids[1]]})
        self.assertEqual(await self.lookup([]), {'commandIds': []})
        self.assertEqual(self.db.all('SELECT * FROM card_quiz_commands ORDER BY id'), before)
        self.assertEqual(set((await self.lookup(ids)).keys()), {'commandIds'})

    async def test_receipt_ids_survives_ended_session_expired_pair_and_teacher_logout(self):
        pair, _, body = await self.active_pair()
        cid = str(uuid.uuid4())
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', self.command(pair, id=cid))
        await self.sync(self.advance(body, 'end_session'))
        self.db.run('UPDATE card_quiz_pairs SET revoked=1,expires_at=0 WHERE id=?', (pair['pairId'],))
        self.db.run('DELETE FROM sessions')
        self.assertEqual(await self.lookup([cid]), {'commandIds': [cid]})
        # A command registered for another classroom session is not a match.
        await self.sync(self.session(sid='another-session'))
        self.assertEqual(await self.lookup([cid], sid='another-session'), {'commandIds': []})

    async def test_receipt_ids_requires_current_device_binding_and_exact_session_owner(self):
        await self.initialize()
        await self.sync()
        await self.lookup([], headers=self.admin, status=401)
        await self.lookup([], headers={**self.dh, 'Authorization': 'Bearer invalid'}, status=401)
        await self.lookup([], headers={**self.dh, 'X-ICeClass-Class-Id': 'other-class'}, status=401)
        self.db.run('INSERT INTO devices(id,class_id,name,token_hash,enabled,created_at,updated_at) VALUES(?,?,?,?,1,?,?)',
                    ('other-device', self.cid, '另一设备', service.sha256('other-token'), STAMP, STAMP))
        other_headers = {**self.dh, 'Authorization': 'Bearer other-token', 'X-ICeClass-Device-Id': 'other-device'}
        await self.lookup([], headers=other_headers, status=403)
        other_class = await self.other_class()
        self.db.run('UPDATE devices SET class_id=? WHERE id=?', (other_class, self.device['deviceId']))
        await self.lookup([], headers={**self.dh, 'X-ICeClass-Class-Id': other_class}, status=403)
        self.db.run('UPDATE devices SET enabled=0 WHERE id=?', (self.device['deviceId'],))
        await self.lookup([], headers={**self.dh, 'X-ICeClass-Class-Id': other_class}, status=401)

    async def test_receipt_ids_batch_boundaries_and_invalid_input(self):
        pair, _, _ = await self.active_pair()
        cid = str(uuid.uuid4())
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', self.command(pair, id=cid))
        ids = [cid, *[str(uuid.uuid4()) for _ in range(127)]]
        self.assertEqual(await self.lookup(ids), {'commandIds': [cid]})
        for bad in (ids + [str(uuid.uuid4())], [cid, cid], None, 'ids', [None], [''], ['x' * 129], ['x\n']):
            with self.subTest(ids=bad):
                await self.lookup(bad, status=400)
        await self.api('POST', '/device/receipt-ids', {'sessionId': 'session-1', 'ids': [], 'extra': True}, 400, self.dh)
        await self.lookup([], sid='missing-session', status=404)
        self.assertEqual(self.db.one('SELECT status FROM card_quiz_commands WHERE id=?', (cid,))['status'], 'pending')

    async def near_limit_command(self, pattern):
        pair, _, body = await self.active_pair()
        path = '/pairs/' + pair['pairId'] + '/commands'
        lower, upper, best = 0, 16000 // len(pattern.encode('utf-8')), None
        while lower <= upper:
            size = (lower + upper) // 2
            command = self.command(pair, id=str(uuid.uuid4()), action='edit_question',
                                   payload={'expectedSeq': 6, 'text': pattern * size})
            wire = json.dumps(command, ensure_ascii=False, separators=(',', ':'))
            response = await self.client.post(PREFIX + path, data=wire.encode('utf-8'),
                headers={**self.admin, 'Content-Type': 'application/json'})
            data = await response.json()
            self.assertIn(response.status, (200, 413), data)
            if response.status == 200:
                self.assertEqual(data, {'status': 'pending', 'id': command['id']})
                best, lower = command, size + 1
            else:
                self.assertEqual(data['code'], 'invalid_command')
                self.assertIsNone(self.db.one('SELECT 1 FROM card_quiz_commands WHERE id=?', (command['id'],)))
                upper = size - 1
        self.assertIsNotNone(best)
        # The next payload still fits the old POST cap, but cannot reserve the
        # complete canonical fingerprint, native-encoded result and class name.
        larger = {**best, 'id': str(uuid.uuid4()), 'payload': {**best['payload'], 'text': best['payload']['text'] + pattern}}
        self.assertLess(len(json.dumps(larger, ensure_ascii=False).encode('utf-8')), 16 * 1024)
        await self.api('POST', path, larger, 413)
        journal = self.journal([{'id': best['id'], 'action': best['action'], 'command': best}], base=body['session'])
        receipt = self.original_receipt(journal, best['id'])
        receipt_wire = self.native_json(receipt).encode('utf-8')
        self.assertGreater(len(receipt_wire), 14 * 1024)
        self.assertLessEqual(len(receipt_wire), 16 * 1024)
        self.assertEqual(json.loads(receipt['fingerprint']), best)
        # Send the actual JsonNode serialization through HTTP, not just a byte probe.
        upload = self.native_json(self.batch(journal, 7, [receipt])).encode('utf-8')
        response = await self.client.post(PREFIX + '/device/sync', data=upload,
            headers={**self.dh, 'Content-Type': 'application/json'})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(await response.json(), {'syncedSeq': 7, 'receiptIds': [best['id']]})
        self.assertEqual(await self.sync(self.batch(journal, 8, [receipt])),
                         {'syncedSeq': 7, 'receiptIds': [best['id']]})

    async def test_nr3_near_limit_ascii_canonical_receipt_survives_native_wire_and_http(self):
        await self.near_limit_command('x')

    async def test_nr3_near_limit_unicode_receipt_survives_native_wire_and_http(self):
        await self.near_limit_command('中文😀')

    async def test_nr3_near_limit_quotes_and_escapes_survive_native_wire_and_http(self):
        await self.near_limit_command('"\\<&+`\n中')

    async def test_nr3_local_long_question_then_real_phone_answer_only_acknowledges_registered_ids(self):
        pair, state, body = await self.active_pair()
        local_id, start_id, answer_id = [str(uuid.uuid4()) for _ in range(3)]
        local = self.journal([{'id': local_id, 'action': 'edit_question',
            'payload': {'expectedSeq': 6, 'text': 'x' * 20000}}], base=body['session'])
        self.assertGreater(len(self.native_json(self.original_receipt(local, local_id)).encode('utf-8')), 16 * 1024)
        self.assertEqual(await self.lookup([local_id]), {'commandIds': []})
        await self.sync(self.batch(local, 7))
        tick = service.now_ms()
        state = self.original_receipt(local, local_id)['result']['state']
        with patch.object(service, 'now_ms', return_value=tick + 1000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state, 'receipts': []}, headers=self.dh)
        start = self.command(pair, id=start_id)
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', start)
        started = self.journal([{'id': start_id, 'action': 'start_round', 'command': start}], base=local['session'])
        start_receipt = self.original_receipt(started, start_id)
        await self.sync(self.batch(started, 8, [start_receipt]))
        state = start_receipt['result']['state']
        with patch.object(service, 'now_ms', return_value=tick + 2000):
            await self.api('POST', '/device/relay', {'sessionId': 'session-1', 'state': state, 'receipts': []}, headers=self.dh)
        answer = self.command(pair, id=answer_id, action='answer', generation=state['generation'],
            roundId=state['roundId'], payload={'cardNumber': 1, 'option': 'B'})
        await self.api('POST', '/pairs/' + pair['pairId'] + '/commands', answer)
        answered = self.journal([{'id': answer_id, 'action': 'answer', 'command': answer}], base=started['session'])
        answer_receipt = self.original_receipt(answered, answer_id)
        self.assertEqual(await self.lookup([local_id, start_id, answer_id]), {'commandIds': [start_id, answer_id]})
        self.assertEqual(await self.sync(self.batch(answered, 9, [answer_receipt])),
                         {'syncedSeq': 9, 'receiptIds': [answer_id]})
        self.assertEqual(answered['session']['questions'][0]['text'], 'x' * 20000)
        self.assertEqual(self.db.one('SELECT status FROM card_quiz_commands WHERE id=?', (answer_id,))['status'], 'confirmed')

    async def test_command_errors_have_deterministic_codes_and_do_not_enqueue(self):
        pair, state, _ = await self.active_pair()
        path = '/pairs/' + pair['pairId'] + '/commands'
        for command, status, code in (
                (self.command(pair, action='recover'), 400, 'invalid_command'),
                (self.command(pair, generation=4), 409, 'stale_context')):
            self.assertEqual((await self.api('POST', path, command, status))['code'], code)
        with patch.object(service, 'now_ms', return_value=service.now_ms() + 16000):
            self.assertEqual((await self.api('POST', path, self.command(pair), 409))['code'], 'command_timeout')
        self.assertEqual(self.db.one('SELECT COUNT(*) n FROM card_quiz_commands')['n'], 0)
        denied = await self.lookup([], headers={**self.dh, 'Authorization': 'Bearer wrong'}, status=401)
        self.assertEqual(denied['code'], 'device_unauthorized')
        self.db.run('DELETE FROM sessions')
        denied = await self.api('POST', '/device/relay', {'sessionId': 'session-1',
            'state': state, 'receipts': []}, 403, self.dh)
        self.assertEqual(denied['code'], 'pair_invalid')

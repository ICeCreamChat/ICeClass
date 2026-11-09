"""Replay actual local ASR windows through isolated HTTP APIs and a controlled provider.

Run after --self-study-scenario-checks. No real classroom data, credentials or AI service.
The provider supplies protocol fixtures; these checks do NOT measure model semantics.
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))

from aiohttp import ClientSession, ClientTimeout, web
from aiohttp.test_utils import TestServer
import self_study_ai
from self_study import LEARNING_CUES
from test_self_study import SelfStudyApiTests


class AudioReplay(SelfStudyApiTests):
    async def test_audio_corpus(self):
        await self.run_corpus(self.corpus, self.output)

    async def run_corpus(self, corpus, output):
        records, vulnerabilities, checks, earlier_context = [], [], [], []
        mode = 'unknown'
        requests = []
        redirects_followed = []

        def check(condition, name):
            checks.append({'name': name, 'passed': bool(condition)})
            if not condition:
                raise AssertionError(name)

        async def provider(request):
            body = await request.json()
            # Real HTTP serializer, request builder and response parser stay in the path.
            check(body['max_tokens'] == 64 and body['stream'] is False, 'bounded provider request')
            check(set(body['messages'][1]) == {'role', 'content'}, 'text-only provider message')
            sources = json.loads(body['messages'][1]['content'])
            check(all(set(u) == {'id', 'text'} for u in sources), 'no audio, class or device identity sent to provider')
            requests.append({'mode': mode, 'utterances': sources})
            if mode == 'http-error':
                return web.Response(status=503)
            if mode == 'redirect':
                raise web.HTTPTemporaryRedirect(location='/must-not-follow')
            if mode == 'timeout':
                await asyncio.sleep(.75)
            if mode == 'oversized':
                return web.Response(text='x' * 16001)
            if mode == 'malformed':
                return web.json_response({'choices': [{'finish_reason': 'stop', 'message': {'content': 'not JSON'}}]})
            kind = mode if mode in {'teaching', 'study', 'unknown'} else 'chat'
            evidence = [0, 1]
            if mode == 'duplicate-evidence':
                evidence = [0, 0]
            if mode == 'invalid-evidence':
                evidence = [0, 99]
            if mode == 'missing-evidence':
                evidence = []
            decision = {'kind': kind, 'confidence': .84 if mode == 'low-confidence' else .97, 'evidence': evidence}
            result = {'choices': [{'finish_reason': 'length' if mode == 'truncated-result' else 'stop',
                                  'message': {'content': json.dumps(decision)}}]}
            if mode != 'missing-usage':
                result['usage'] = {'prompt_tokens': 100, 'completion_tokens': 20}
            return web.json_response(result)

        app = web.Application()
        app.router.add_post('/chat/completions', provider)
        async def redirected(request):
            redirects_followed.append(request.path)
            return web.Response(status=503)
        app.router.add_post('/must-not-follow', redirected)
        stub = TestServer(app)
        await stub.start_server()
        self.addAsyncCleanup(stub.close)
        session = ClientSession(timeout=ClientTimeout(total=.5))
        self.addAsyncCleanup(session.close)
        self.f.classify = lambda cfg, obs: self_study_ai.classify(session, cfg, obs)

        def reset():
            # This database belongs to ServerTestCase's TemporaryDirectory.
            for table in ('self_study_events', 'self_study_usage', 'self_study_decisions'):
                self.f.db.run('DELETE FROM ' + table)
            requests.clear()
            redirects_followed.clear()

        def observation(window, oid):
            value = copy.deepcopy(window)
            shift = self.now - value['endAt']
            value.update(id=oid, revision=self.revision,
                         startAt=value['startAt'] + shift, endAt=self.now)
            for utterance in value['utterances']:
                utterance['startAt'] += shift
                utterance['endAt'] += shift
            return value

        async def send(window, oid):
            response, result = await self.observe(body=observation(window, oid))
            check(response.status == 200, oid + ': actual audio payload accepted')
            return result

        with patch.object(self_study_ai, 'completion_url', return_value=str(stub.make_url('/chat/completions'))):
            for scenario in corpus['scenarios']:
                sid, label = scenario['scenario']['id'], scenario['scenario']['label']
                for index, window in enumerate(scenario['windows']):
                    if len(window['utterances']) < 3:
                        records.append({'case': sid, 'window': index, 'result': 'client-abstained', 'providerCalls': 0})
                        continue
                    for adversarial in (False, True):
                        reset()
                        mode = 'chat' if adversarial or label.startswith('chat') else label if label in {'teaching', 'study'} else 'unknown'
                        result = await send(window, f'corpus-{sid}-{index}-{int(adversarial)}')
                        check(result['action'] != 'report' and not result.get('captureRequested'), sid + ': first observation cannot escalate')
                        if not adversarial and label in {'teaching', 'study', 'normal', 'non-speech'}:
                            check(result['action'] == 'observe', sid + ': supplied teaching/study result never warns')
                        row = {'case': sid, 'label': label, 'window': index, 'mode': 'adverse-chat-fixture' if adversarial else 'labeled-fixture',
                               'result': result, 'providerCalls': len(requests)}
                        records.append(row)
                        if adversarial and label in {'teaching', 'study', 'normal'} and result['action'] == 'remind':
                            vulnerabilities.append({'case': sid, 'window': index, 'texts': [u['text'] for u in window['utterances']]})

                for index, window in enumerate(scenario['scheduledWindows']):
                    if len(window['utterances']) < 3:
                        continue
                    # Diagnose context outside the selected suffix, without claiming a model accuracy result.
                    previous = [c for c in scenario['clips'] if c['speechMs'] >= 300 and
                                c['endAt'] <= window['endAt'] and window['endAt'] - c['startAt'] <= 60000][-6:]
                    lost = [c['text'] for c in previous if c['endAt'] <= window['startAt'] and LEARNING_CUES.search(c['text'])]
                    if lost and not LEARNING_CUES.search(' '.join(u['text'] for u in window['utterances'])):
                        reset()
                        mode = 'chat'
                        result = await send(window, f'cadence-context-{sid}-{index}')
                        earlier_context.append({'case': sid, 'window': index, 'earlierTexts': lost,
                                                'texts': [u['text'] for u in window['utterances']], 'adverseFixtureResult': result})

            reset()
            mode = 'chat'
            scheduled = next(s for s in corpus['scenarios'] if s['scenario']['id'] == 'chat-long')['scheduledWindows']
            check(len(scheduled) >= 2 and all(len(w['utterances']) >= 3 for w in scheduled[:2]),
                  'two complete actual audio windows available at production cadence')
            warning = await send(scheduled[0], 'cadence-warning-actual-audio')
            check(warning['action'] == 'remind', 'actual cadence first review can warn')
            response = await self.client.post('/api/self-study/device/events/' + warning['eventId'] + '/receipt',
                json={'shown': True, 'revision': self.revision}, headers=self.device_headers)
            check(response.status == 200, 'actual cadence reminder shown')
            self.now += scheduled[1]['endAt'] - scheduled[0]['endAt']
            result = await send(scheduled[1], 'cadence-followup-actual-audio')
            check(result['action'] == 'report' and result['eventId'] == warning['eventId'],
                  'actual audio at the 90-second cadence completes the HTTP escalation path')

            # Use two different, nonoverlapping actual audio windows for staged lifecycle checks.
            chat = next(s for s in corpus['scenarios'] if s['scenario']['id'] == 'chat-paused')['windows']
            learning = next(s for s in corpus['scenarios'] if s['scenario']['id'] == 'math-paused')['windows'][0]
            first, second = chat[:2]
            reset()
            mode = 'chat'
            warning = await send(first, 'staged-first-window')
            check(warning['action'] == 'remind', 'actual chatter transcript can warn with valid controlled evidence')
            eid = warning['eventId']
            path = '/api/self-study/device/events/' + eid
            response = await self.client.post(path + '/capture', json={}, headers=self.device_headers)
            check(not (await response.json())['allowed'], 'warning cannot claim a photo')
            replay = await send(first, 'staged-first-window')
            check(replay == warning and len(requests) == 1, 'identical observation is idempotent without another provider call')
            self.now += 90000
            unshown = await send(second, 'staged-no-receipt')
            check(unshown['action'] == 'remind' and len(requests) == 1, 'no report before actual display receipt')
            response = await self.client.post(path + '/receipt', json={'shown': True, 'revision': self.revision}, headers=self.device_headers)
            check(response.status == 200, 'display receipt accepted')
            self.now += 89999
            early = await send(second, 'staged-too-early')
            check(early['action'] == 'observe' and len(requests) == 1, '89.999 seconds cannot escalate')
            self.now += 1
            reported = await send(second, 'staged-independent-followup')
            check(reported['action'] == 'report' and reported['eventId'] == eid, 'new actual audio after 90 seconds can report')
            response = await self.client.post(path + '/capture', json={}, headers=self.device_headers)
            check((await response.json())['allowed'], 'valid report permits exactly one capture claim')
            response = await self.client.post(path + '/capture', json={}, headers=self.device_headers)
            check(not (await response.json())['allowed'], 'second capture claim denied')
            self.now += 90000
            repeated = await send(second, 'staged-report-again')
            check(repeated['action'] == 'observe' and len(requests) == 2, 'reported episode does not trigger another AI call or report')

            reset()
            warning = await send(first, 'study-stops-warning')
            response = await self.client.post('/api/self-study/device/events/' + warning['eventId'] + '/receipt',
                json={'shown': True, 'revision': self.revision}, headers=self.device_headers)
            self.now += 90000
            study = await send(learning, 'actual-study-after-chat')
            check(study['action'] == 'observe' and study['classification'] == 'study' and len(requests) == 1,
                  'real decoded learning context ends warning without another provider call')
            event = self.f.db.one('SELECT * FROM self_study_events WHERE id=?', (warning['eventId'],))
            check(event['ended_at'] is not None and event['reported_at'] is None, 'learning context resolves unreported incident')

            reset()
            mode = 'missing-usage'
            warning = await send(first, 'budget-missing-usage-first')
            self.now += 90000
            # Clear the episode via existing quiet API, retaining all usage.
            response = await self.client.post('/api/self-study/device/quiet',
                json={'revision': self.revision, 'eventId': warning['eventId']}, headers=self.device_headers)
            check(response.status == 200, 'quiet endpoint available')
            budget = await send(second, 'budget-missing-usage-second')
            check(budget['action'] == 'budget' and len(requests) == 1, 'missing usage keeps reservation; default budget cannot overspend')

            for mode in ('teaching', 'study', 'unknown', 'low-confidence', 'duplicate-evidence', 'invalid-evidence',
                         'missing-evidence', 'truncated-result', 'malformed', 'http-error', 'redirect', 'timeout', 'oversized'):
                reset()
                result = await send(first, 'provider-fixture-' + mode)
                check(result['action'] in {'observe', 'unavailable'}, mode + ': uncertain or failed provider never warns')
                check(not self.f.db.all('SELECT * FROM self_study_events'), mode + ': no incident or photo created')
                check(len(requests) == 1, mode + ': no automatic retry or redirect follow')
                check(not redirects_followed, mode + ': redirect target never requested')

            # Actual ASR content must not leak into persistent event/usage/decision records.
            reset()
            mode = 'chat'
            await send(first, 'privacy-actual-audio-window')
            serialized = json.dumps({table: [dict(r) for r in self.f.db.all('SELECT * FROM ' + table)]
                for table in ('self_study_events', 'self_study_usage', 'self_study_decisions')}, ensure_ascii=False)
            check(all(u['text'] not in serialized for u in first['utterances']), 'actual ASR text absent from persistent records')

        report = {'completed': True,
                  'scope': 'Actual VAD/ASR corpus -> real isolated authenticated HTTP API -> controlled local HTTP provider fixtures.',
                  'semantics': 'Provider decisions are supplied fixtures, not measured AI accuracy. Adverse fixtures expose model-dependent protection gaps.',
                  'realProviderCalls': 0, 'hardwareCaptures': 0, 'checks': checks, 'corpus': records,
                  'modelDependentLearningWindows': vulnerabilities, 'learningContextOutsideSelectedWindow': earlier_context}
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'Audio HTTP replay: {len(checks)} checks passed; {len(records)} corpus runs; '
              f'{len(vulnerabilities)} learning windows depend on model semantics. Zero real provider calls.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('corpus', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    corpus = json.loads(args.corpus.read_text(encoding='utf-8'))
    if (not isinstance(corpus, dict) or corpus.get('completed') is not True or corpus.get('failures') != []
            or type(corpus.get('expectedScenarioCount')) is not int
            or not isinstance(corpus.get('scenarios'), list)
            or len(corpus['scenarios']) != corpus['expectedScenarioCount']
            or corpus['expectedScenarioCount'] < 1):
        parser.error('Corpus is incomplete or has native failures; rerun the complete acoustic scenario suite first.')
    args.output.write_text(json.dumps({'completed': False, 'corpus': str(args.corpus)}, indent=2), encoding='utf-8')
    test = AudioReplay(methodName='test_audio_corpus')
    test.corpus = corpus
    test.output = args.output
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([test]))
    if not result.wasSuccessful():
        raise SystemExit(1)


if __name__ == '__main__':
    main()

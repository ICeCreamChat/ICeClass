'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const nativeRoot = path.join(root, 'miniprogram/teacher');
const data = () => require('../miniprogram/teacher/lib/paper-data');
const state = changes => ({ sessionId: 'session-a', className: '一班', subjectId: 'math', questionId: 'q1', questionNumber: 1, questionType: 'single', optionCount: 4, roundId: null, roundStatus: null, source: 'phone', sourceId: 'pair-a', generation: 3, seq: 8, received: 0, expected: 2, ended: false, ...changes });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const plain = value => JSON.parse(JSON.stringify(value));
const event = (value, field) => ({ detail: { value }, currentTarget: { dataset: { field } } });

test('phone controls require the actual board source, connection and sealed round', () => {
  const d = data();
  assert.equal(d.flags(state(), 'pair-a', true).canStart, true);
  for (const s of [state({ source: 'board', sourceId: 'board' }), state({ ended: true }), state({ roundId: 'r1', roundStatus: 'paused' })]) {
    assert.equal(d.flags(s, 'pair-a', true).canStart, false);
  }
  assert.equal(d.flags(state(), 'pair-a', false).canStart, false);
  assert.throws(() => d.command(state(), 'pair-a', true, 'end_session', {}, 'id1'));
  assert.throws(() => d.command(state(), 'pair-a', true, 'resume_round', {}, 'id1'));
});

test('commands carry the exact generation/question/round/source and multiple-choice target', () => {
  const s = state({ questionType: 'multiple', roundId: 'r1', roundStatus: 'collecting', activeOption: 'C', optionReceived: 1 });
  const c = data().command(s, 'pair-a', true, 'answer', { cardNumber: 157, option: 'B' }, 'request-1');
  assert.deepEqual(c, { id: 'request-1', sessionId: 'session-a', questionId: 'q1', roundId: 'r1', generation: 3, sourceId: 'pair-a', action: 'answer', payload: { cardNumber: 157, option: 'B', targetOption: 'C' } });
  assert.throws(() => data().command(s, 'pair-a', true, 'answer', { cardNumber: 158, option: 'A' }, 'id2'));
  assert.throws(() => data().command(s, 'pair-a', true, 'answer', { cardNumber: 1, option: 'C' }, 'id2'));
});

test('pair and state responses cannot silently switch the selected class or session', () => {
  assert.throws(() => data().readPair({ pairId: 'p', classId: 'b', sessionId: 's', expiresAt: Date.now() + 1000 }, 'a', ''));
  assert.throws(() => data().readState(state(), 'another-session'));
  assert.throws(() => data().readState(state({ seq: NaN }), 'session-a'));
  assert.equal(data().readState(state(), 'session-a').seq, 8);
});

test('binding edits preserve unrelated students, reject duplicate cards and accept explicit removal', () => {
  const rows = [{ id: 's1', name: '甲', cardNumber: 1 }, { id: 's2', name: '乙', cardNumber: 2 }];
  assert.deepEqual(data().bindingChanges(rows, { s1: '', s2: '2' }), [{ studentId: 's1', cardNumber: null }]);
  assert.throws(() => data().bindingChanges(rows, { s1: '2', s2: '2' }));
  assert.throws(() => data().bindingChanges(rows, { s1: '1e2', s2: '2' }));
});

test('temporary questions normalize answers and edits include the exact public sequence', () => {
  const draft = { type: 'multiple', text: '测试', options: ['甲', '乙', '丙'], answerText: 'ca', tagsText: '函数，几何' };
  assert.equal(data().questionPayload(draft).answer, 'AC');
  assert.throws(() => data().questionPayload({ ...draft, answerText: 'D' }));
  assert.deepEqual(data().editPayload(state(), 'answer', 'b'), { expectedSeq: 8, answer: 'B' });
});

test('native card matrices preserve all 157 checked-in printable marker codes', () => {
  const existing = require('../web_controller/card-quiz/cards');
  for (let number = 1; number <= 157; number++) assert.deepEqual(data().cardMatrix(number), existing.matrix(number));
});

function fixture(name, overrides = {}) {
  const calls = [], timers = new Map(); let page, timerId = 0;
  const actor = { id: 'teacher-a', permissions: {} }; let loggedIn = true;
  const api = { getUser: () => loggedIn ? actor : null, getClassId: () => 'class-a', selectClass() {}, request: async (url, options = {}) => { calls.push({ url, ...plain(options) }); return overrides.request ? overrides.request(url, options) : {}; } };
  const ui = { requireLogin: () => true, relogin() {}, setDirty() {}, toast() {}, query: values => Object.keys(values).filter(key => values[key] !== '' && values[key] != null).map(key => encodeURIComponent(key) + '=' + encodeURIComponent(values[key])).join('&'), confirm: overrides.confirm || (async () => true), fail: (p, error) => { if (error.code !== 'session_changed') p.setData({ error: error.message, sessionExpired: error.status === 401 }); }, loadClasses: async p => { p.setData({ classes: [{ id: 'class-a', name: '一班' }], classNames: ['一班'], classIndex: 0, classId: 'class-a' }); return p.data.classes; }, chooseClass: (p, index) => { const selected = p.data.classes[index]; if (selected) p.setData({ classIndex: Number(index), classId: selected.id }); return selected; } };
  const wx = { stopPullDownRefresh() {}, canIUse: () => true, getPrivacySetting: o => o.success({ needAuthorization: false }), authorize: o => o.success({}), ...overrides.wx };
  const filename = path.join(nativeRoot, 'pages', name, 'index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { Page: value => { page = value; }, require: id => id === '../../lib/api' ? api : id === '../../lib/ui' ? ui : require(path.resolve(path.dirname(filename), id)), wx, setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id), Date, console });
  page.data = plain(page.data); page.setData = (patch, callback) => { for (const [key, value] of Object.entries(patch)) { const parts = key.split('.'); let target = page.data; while (parts.length > 1) { const part = parts.shift(); target = target[part] || (target[part] = {}); } target[parts[0]] = value; } if (callback) callback(); };
  page.onLoad({ classId: 'class-a' }); page.data.classId = 'class-a'; page._visible = true; page._ownerId = actor.id;
  return { page, api, ui, wx, calls, timers, actor, expire() { loggedIn = false; }, restore() { loggedIn = true; } };
}

function connected(f, changes) {
  f.page._pair = { pairId: 'pair-a', classId: 'class-a', sessionId: 'session-a', expiresAt: Date.now() + 60000 };
  f.page.applyState(state(changes), true);
}

test('pending is never shown as confirmed, double taps do not submit a second control', async () => {
  const f = fixture('paper-round', { request: async () => ({ status: 'pending', id: 'ignored' }) }); connected(f);
  await f.page.startRound(); await f.page.startRound();
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.page.data.pendingCount, 1); assert.match(f.page.data.status, /待.*确认/);
  assert.doesNotMatch(f.page.data.status, /已开始|已保存/);
});

test('hiding during a round confirmation prevents the write and cancels foreground reads', async () => {
  const modal = deferred(); const f = fixture('paper-round', { confirm: () => modal.promise }); connected(f);
  const pending = f.page.startRound(); f.page.onHide(); modal.resolve(true); await pending;
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0); assert.equal(f.timers.size, 0);
});

test('an unknown answer is retained for receipt lookup and is never automatically reposted', async () => {
  const f = fixture('paper-round', { request: async () => { throw Object.assign(new Error('结果未知'), { ambiguous: true }); } });
  connected(f, { roundId: 'r1', roundStatus: 'collecting' }); f.page.data.cardNumber = '1'; f.page.data.answerIndex = 0;
  await f.page.manualAnswer(); await f.page.manualAnswer();
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1); assert.equal(f.page.data.pendingCount, 1); assert.equal(f.page.data.cardNumber, '1');
});

test('camera remains absent until explicit consent; leaving while consent waits cannot open it', async () => {
  let permissionCalls = 0; const modal = deferred();
  const f = fixture('paper-round', { confirm: () => modal.promise, wx: { authorize: o => { permissionCalls++; o.success({}); } } }); connected(f, { roundId: 'r1', roundStatus: 'collecting' });
  assert.equal(f.page.data.cameraOn, false); const pending = f.page.startCamera(); f.page.onHide(); modal.resolve(true); await pending;
  assert.equal(permissionCalls, 0); assert.equal(f.page.data.cameraOn, false);
});

test('card saving uses the server revision and preserves drafts on conflict and 401', async () => {
  for (const status of [409, 401]) {
    const f = fixture('paper-cards', { request: async () => { throw Object.assign(new Error('保留草稿'), { status }); } });
    f.page.applyCards({ classId: 'class-a', revision: 7, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: 1 }] });
    f.page.inputCard({ detail: { value: '3' }, currentTarget: { dataset: { id: 's1' } } }); await f.page.saveBindings();
    const write = f.calls.find(c => c.method === 'PUT'); assert.equal(write.data.revision, 7); assert.equal(f.page.data.students[0].draftNumber, '3'); assert.equal(f.page.data.dirty, true);
    assert.equal(f.page.data.sessionExpired, status === 401);
  }
});

test('a confirmed board receipt advances state exactly once; a later stale read cannot rewind it', async () => {
  const f = fixture('paper-round', { request: async () => ({ status: 'pending' }) }); connected(f);
  await f.page.startRound(); const commandId = f.calls[0].data.id;
  const saved = state({ roundId: 'r1', roundStatus: 'collecting', generation: 4, seq: 9 });
  f.page.settle(commandId, { status: 'confirmed', result: { status: 'confirmed', seq: 9, state: saved } });
  assert.equal(f.page.data.pendingCount, 0); assert.equal(f.page.data.state.seq, 9); assert.equal(f.page.data.collecting, true);
  f.page.applyState(state(), true); assert.equal(f.page.data.state.seq, 9);
  f.page.settle(commandId, { status: 'confirmed', result: { state: saved } }); assert.equal(f.page.data.state.seq, 9);
});

test('receipt lookup repeats commandId query parameters, never posts pending commands again', async () => {
  const f = fixture('paper-round', { request: async url => ({ state: state({ roundId: 'r1', roundStatus: 'collecting' }), connected: true, receipts: [] }) });
  connected(f, { roundId: 'r1', roundStatus: 'collecting' });
  for (const id of ['id1', 'id2']) f.page._pending.set(id, { command: { id, action: 'answer', payload: { cardNumber: id === 'id1' ? 1 : 2, option: 'A' } }, phase: 'unknown', createdAt: Date.now() });
  await f.page.refreshRoom(); assert.match(f.calls[0].url, /\?commandId=id1&commandId=id2$/);
  assert.equal(f.calls.some(call => call.method === 'POST'), false); assert.equal(f.page.data.pendingCount, 2);
});

test('receipt reads completed after hide cannot restore connection or camera', async () => {
  const read = deferred(); const f = fixture('paper-round', { request: () => read.promise }); connected(f);
  const pending = f.page.refreshRoom(); f.page.onHide(); read.resolve({ state: state({ seq: 99 }), connected: true, receipts: [] }); await pending;
  assert.equal(f.page.data.connected, false); assert.equal(f.page.data.state.seq, 8); assert.equal(f.page.data.cameraOn, false); assert.equal(f.timers.size, 0);
});

test('unknown card writes block repeat PUT until a successful explicit read', async () => {
  const f = fixture('paper-cards', { request: async () => { throw Object.assign(new Error('响应不可读'), { status: 200 }); } });
  f.page.applyCards({ classId: 'class-a', revision: 0, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: null }] });
  f.page.inputCard({ detail: { value: '1' }, currentTarget: { dataset: { id: 's1' } } }); await f.page.saveBindings(); await f.page.saveBindings();
  assert.equal(f.calls.length, 1); assert.equal(f.page.data.uncertain, true); assert.equal(f.page.data.students[0].draftNumber, '1');
});

test('hiding during card initialization confirmation cancels PUT and retains the original revision', async () => {
  const modal = deferred(); const f = fixture('paper-cards', { confirm: () => modal.promise });
  f.page.applyCards({ classId: 'class-a', revision: 0, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: null }] });
  const pending = f.page.initialize(); f.page.onHide(); modal.resolve(true); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.page.data.revision, 0);
});

test('read-only roster permissions never reach PUT, even via direct handler calls', async () => {
  const f = fixture('paper-cards'); f.page.applyCards({ classId: 'class-a', revision: 0, canEdit: false, students: [{ id: 's1', name: '甲', cardNumber: null }] });
  f.page.inputCard({ detail: { value: '4' }, currentTarget: { dataset: { id: 's1' } } }); await f.page.initialize(); await f.page.saveBindings();
  assert.equal(f.calls.length, 0); assert.equal(f.page.data.dirty, false);
});

test('privacy approval is required before mounting the camera and does not request audio', async () => {
  const permissions = []; const f = fixture('paper-round', { wx: { getPrivacySetting: o => o.success({ needAuthorization: true }), authorize: o => { permissions.push(o.scope); o.success({}); } } });
  connected(f, { roundId: 'r1', roundStatus: 'collecting' }); await f.page.startCamera();
  assert.equal(f.page.data.privacyNeeded, true); assert.equal(f.page.data.cameraOn, false); assert.deepEqual(permissions, []);
  await f.page.agreeCameraPrivacy(); assert.deepEqual(permissions, ['scope.camera']); assert.equal(f.page.data.cameraOn, true);
  f.page.onHide(); assert.equal(f.page.data.cameraOn, false);
});

test('denied camera permission keeps the manual workflow available without mounting camera', async () => {
  const f = fixture('paper-round', { wx: { authorize: o => o.fail({}) } }); connected(f, { roundId: 'r1', roundStatus: 'collecting' });
  await f.page.startCamera(); assert.equal(f.page.data.cameraOn, false); assert.equal(f.page.data.cameraDenied, true); assert.equal(f.page.data.collecting, true);
});

test('account changes during confirmation prevent classroom and card writes', async () => {
  for (const name of ['paper-round', 'paper-cards']) {
    const modal = deferred(); const f = fixture(name, { confirm: () => modal.promise }); let pending;
    if (name === 'paper-round') { connected(f); pending = f.page.startRound(); }
    else { f.page.applyCards({ classId: 'class-a', revision: 0, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: null }] }); pending = f.page.initialize(); }
    f.actor.id = 'teacher-b'; modal.resolve(true); await pending; assert.equal(f.calls.length, 0);
  }
});

test('all native page events resolve and inputs have accessible names', () => {
  for (const name of ['paper-round', 'paper-cards']) {
    const f = fixture(name), folder = path.join(nativeRoot, 'pages', name);
    const wxml = fs.readFileSync(path.join(folder, 'index.wxml'), 'utf8');
    for (const match of wxml.matchAll(/bind(?:tap|input|change|initdone|error|stop|agreeprivacyauthorization)="([^"]+)"/g)) assert.equal(typeof f.page[match[1]], 'function', name + ': ' + match[1]);
    for (const input of wxml.match(/<(?:input|textarea|picker)\b[^>]*>/g) || []) assert.match(input, /aria-label=/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'index.json'), 'utf8')).enablePullDownRefresh, true);
    assert.doesNotMatch(wxml, /web-view|&amp;|&gt;|&lt;/);
  }
});

test('a failed roster refresh cannot attach the previous class draft to a newly selected class', async () => {
  const f = fixture('paper-cards', { request: async () => { throw Object.assign(new Error('读取失败'), { status: 403 }); } });
  f.page.applyCards({ classId: 'class-a', revision: 5, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: 1 }] });
  f.page.inputCard({ detail: { value: '9' }, currentTarget: { dataset: { id: 's1' } } }); f.page._expectedClassId = '';
  f.ui.loadClasses = async p => { p.setData({ classes: [{ id: 'class-b', name: '二班' }], classNames: ['二班'], classId: 'class-b', classIndex: 0 }); return p.data.classes; };
  await f.page.load(true); await f.page.saveBindings();
  assert.equal(f.calls.some(call => call.method === 'PUT'), false); assert.equal(f.page.data.classId, 'class-a'); assert.equal(f.page.data.students[0].draftNumber, '9');
});

test('401 after the API clears authentication remains visible on the originating account page', async () => {
  for (const target of ['round-prepare', 'round-read', 'round-command', 'round-claim', 'cards-classes', 'cards-read', 'cards-write']) {
    let f;
    const request = async () => { f.expire(); throw Object.assign(new Error('学校登录已过期，请重新登录。'), { status: 401 }); };
    f = fixture(target.startsWith('round') ? 'paper-round' : 'paper-cards', { request });
    if (target === 'round-prepare' || target === 'cards-classes') f.ui.loadClasses = () => f.api.request('/api/classes');
    if (target === 'round-prepare') await f.page.prepare();
    if (target === 'round-read') { connected(f); await f.page.refreshRoom(); }
    if (target === 'round-command') { connected(f, { roundId: 'r1', roundStatus: 'collecting' }); f.page.data.cardNumber = '2'; f.page.data.cameraOn = true; await f.page.manualAnswer(); }
    if (target === 'round-claim') { f.page.data.code = '012345ABCDEF'; await f.page.claimPair(); }
    if (target === 'cards-read') await f.page.load();
    if (target === 'cards-classes') await f.page.load(true);
    if (target === 'cards-write') { f.page.applyCards({ classId: 'class-a', revision: 0, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: null }] }); f.page.inputCard({ detail: { value: '4' }, currentTarget: { dataset: { id: 's1' } } }); await f.page.saveBindings(); assert.equal(f.page.data.students[0].draftNumber, '4'); }
    assert.equal(f.page.data.sessionExpired, true, target); assert.match(f.page.data.error, /学校登录已过期/, target);
    if (target.startsWith('round')) assert.equal(f.page.data.cameraOn, false, target);
  }
});

test('a 401 from a hidden page or previous account cannot alter the new account state', async () => {
  for (const leave of ['hide', 'switch']) {
    const pending = deferred(); const f = fixture('paper-round', { request: () => pending.promise }); connected(f);
    const reading = f.page.refreshRoom(); if (leave === 'hide') f.page.onHide(); else f.actor.id = 'teacher-b';
    pending.reject(Object.assign(new Error('旧请求过期'), { status: 401 })); await reading;
    assert.equal(f.page.data.sessionExpired, false); assert.equal(f.page.data.error, '');
  }
});

test('a PUT hidden after dispatch retains the draft and reconciles with GET on return', async () => {
  const writing = deferred(); let updated = false;
  const f = fixture('paper-cards', { request: async (url, options) => {
    if (options.method === 'PUT') return writing.promise;
    return { classId: 'class-a', revision: updated ? 8 : 7, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: updated ? 3 : 1 }] };
  } });
  f.page.applyCards({ classId: 'class-a', revision: 7, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: 1 }] });
  f.page.inputCard({ detail: { value: '3' }, currentTarget: { dataset: { id: 's1' } } }); const saving = f.page.saveBindings();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
  f.page.onHide(); assert.equal(f.page.data.uncertain, true); assert.equal(f.page.data.students[0].draftNumber, '3');
  updated = true; writing.resolve({ classId: 'class-a', revision: 8, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: 3 }] }); await saving;
  await f.page.onShow(); assert.equal(f.calls.filter(call => !call.method).length, 1);
  assert.equal(f.page.data.revision, 8); assert.equal(f.page.data.students[0].draftNumber, '3'); assert.equal(f.page.data.uncertain, false);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
});

test('a foreground receipt read cannot suppress a command 401, and reauthentication restores controls', async () => {
  const writing = deferred(); let stops = 0;
  const f = fixture('paper-round', { request: (url, options) => options.method === 'POST' ? writing.promise : { state: state({ roundId: 'r1', roundStatus: 'collecting' }), connected: true, receipts: [] } });
  connected(f, { roundId: 'r1', roundStatus: 'collecting' });
  f.page.data.cameraOn = true; f.page._scanner = { stop() { stops++; } };
  const saving = f.page.sendCommand('answer', { cardNumber: 1, option: 'A' });
  await f.page.refreshRoom(); f.expire(); writing.reject(Object.assign(new Error('请重新登录'), { status: 401 })); await saving;
  assert.equal(f.page.data.sessionExpired, true); assert.equal(f.page.data.cameraOn, false); assert.equal(stops, 1); assert.equal(f.timers.size, 0);
  f.restore(); f.page.onHide(); f.page._lastReadAt = 0; await f.page.onShow();
  assert.equal(f.page.data.sessionExpired, false); assert.equal(f.page.data.collecting, true); assert.equal(f.page.data.cameraOn, false);
});

test('stale generations, returned pages and changed accounts cannot accept old 401 errors', async () => {
  for (const name of ['paper-round', 'paper-cards']) for (const change of ['read', 'hide-show', 'account']) {
    const reading = deferred(); const f = fixture(name, { request: () => reading.promise });
    if (name === 'paper-round') connected(f);
    const pending = name === 'paper-round' ? f.page.refreshRoom() : f.page.load();
    if (change === 'read') f.page._generation++;
    if (change === 'hide-show') { f.page.onHide(); f.page._visible = true; }
    if (change === 'account') f.actor.id = 'teacher-b'; else f.expire();
    reading.reject(Object.assign(new Error('已失效的401'), { status: 401 })); await pending;
    assert.equal(f.page.data.sessionExpired, false, name + ':' + change); assert.equal(f.page.data.error, '');
  }
});

test('returning before PUT settles keeps the lock, then reads once and retains unsaved draft changes', async () => {
  const writing = deferred();
  const f = fixture('paper-cards', { request: (url, options) => options.method === 'PUT' ? writing.promise : { classId: 'class-a', revision: 8, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: 1 }, { id: 's2', name: '乙', cardNumber: 4 }] } });
  f.page.applyCards({ classId: 'class-a', revision: 7, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: 1 }, { id: 's2', name: '乙', cardNumber: 2 }] });
  f.page.inputCard({ detail: { value: '3' }, currentTarget: { dataset: { id: 's1' } } }); const saving = f.page.saveBindings();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  f.page.onHide(); await f.page.onShow(); await f.page.saveBindings();
  assert.equal(f.calls.length, 1); assert.equal(f.page.data.uncertain, true); assert.equal(f.page.data.busy, true);
  writing.reject(Object.assign(new Error('结果未知'), { ambiguous: true })); await saving;
  assert.equal(f.calls.filter(call => !call.method).length, 1); assert.equal(f.page.data.revision, 8);
  assert.equal(f.page.data.students[0].draftNumber, '3'); assert.equal(f.page.data.students[1].draftNumber, '4');
  assert.equal(f.page.data.dirty, true); assert.equal(f.page.data.uncertain, false); assert.equal(f.page.data.busy, false);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
});

test('failed reconciliation keeps uncertainty and drafts until GET succeeds on the dispatched class', async () => {
  let allowRead = false;
  const f = fixture('paper-cards', { request: (url, options) => {
    if (options.method === 'PUT') throw Object.assign(new Error('结果未知'), { ambiguous: true });
    if (!allowRead) throw Object.assign(new Error('禁止查看当前班级'), { status: 403 });
    assert.equal(url, '/api/card-quiz/classes/class-a/cards');
    return { classId: 'class-a', revision: 9, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: 1 }] };
  } });
  f.page.applyCards({ classId: 'class-a', revision: 7, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: 1 }] });
  f.page.inputCard({ detail: { value: '3' }, currentTarget: { dataset: { id: 's1' } } }); await f.page.saveBindings();
  f.api.getClassId = () => 'class-b'; await f.page.reload(); await f.page.saveBindings();
  assert.equal(f.page.data.uncertain, true); assert.equal(f.page.data.students[0].draftNumber, '3'); assert.equal(f.page.data.error, '禁止查看当前班级');
  allowRead = true; await f.page.reload();
  assert.equal(f.page.data.uncertain, false); assert.equal(f.page.data.dirty, true); assert.equal(f.page.data.students[0].draftNumber, '3');
  assert.equal(f.page.data.revision, 9); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
});

test('initialization hidden after dispatch uses fresh assigned cards instead of restoring old blanks', async () => {
  const writing = deferred(), saved = { classId: 'class-a', revision: 1, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: 3 }] };
  const f = fixture('paper-cards', { request: (url, options) => options.method === 'PUT' ? writing.promise : saved });
  f.page.applyCards({ classId: 'class-a', revision: 0, canEdit: true, students: [{ id: 's1', name: '甲', cardNumber: null }] });
  const saving = f.page.initialize(); for (let i = 0; i < 4; i++) await Promise.resolve();
  f.page.onHide(); writing.resolve(saved); await saving; await f.page.onShow();
  assert.equal(f.page.data.students[0].draftNumber, '3'); assert.equal(f.page.data.dirty, false); assert.equal(f.page.data.uncertain, false);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
});

module.exports = { fixture, connected, state };

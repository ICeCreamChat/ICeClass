'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../miniprogram/teacher/lib/paper-accounts-data');
const root = path.resolve(__dirname, '../miniprogram/teacher');
const clone = value => JSON.parse(JSON.stringify(value));
const event = (value, dataset = {}) => ({ detail: { value }, currentTarget: { dataset } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function snapshot(classId = 'class-a', canEdit = true) {
  return { classId, className: classId === 'class-a' ? '高一（9）班' : '高二（8）班', classCode: '109',
    revision: 0, rosterRevision: 0, cardRevision: 0, canEdit, students: [
      { studentId: 's1', name: '学生甲', cardNumber: 1, accountId: null, username: null, accountRevision: null, activeHere: false },
      { studentId: 's2', name: '学生乙', cardNumber: 2, accountId: 'account-2', username: '2610902', accountRevision: 1, activeHere: true },
      { studentId: 's3', name: '学生丙', cardNumber: null, accountId: null, username: null, accountRevision: null, activeHere: false },
      { studentId: 's4', name: '学生丁', cardNumber: 4, accountId: 'account-4', username: '2510104', accountRevision: 2, activeHere: false }
    ] };
}
function issued(before, action, body) {
  const result = clone(before); result.revision++;
  const ids = action === 'generate' ? before.students.filter(s => s.cardNumber !== null && !s.accountId).map(s => s.studentId) :
    action === 'reset' ? body.studentIds : [body.studentId];
  const rows = ids.map(id => {
    const row = result.students.find(s => s.studentId === id);
    Object.assign(row, { accountId: row.accountId || 'account-' + id, username: action === 'link' ? body.username : row.username || '2610901', activeHere: true, accountRevision: (row.accountRevision || 0) + 1 });
    return { classId: result.classId, className: result.className, studentId: id, accountId: row.accountId, username: row.username, cardNumber: row.cardNumber, password: '000042' };
  });
  if (action !== 'link') result.credentials = rows;
  return result;
}
function harness() {
  const f = { user: { id: 'teacher-1', role: 'subject_teacher', permissions: {} }, selectedClass: 'class-a', states: { 'class-a': snapshot(), 'class-b': snapshot('class-b') },
    calls: [], modals: [], navigation: [], stopped: 0, storage: [], dirty: false };
  f.route = (url, options) => {
    if (url === '/api/classes') return { classes: [{ id: 'class-a', name: '高一（9）班', enabled: 1 }, { id: 'class-b', name: '高二（8）班', enabled: 1 }] };
    const match = /^\/api\/card-quiz\/classes\/([^/]+)\/students(?:\/(reset|link))?$/.exec(url);
    assert.ok(match, 'only teacher account routes are allowed: ' + url);
    const cid = decodeURIComponent(match[1]);
    if ((options.method || 'GET') === 'GET') return clone(f.states[cid]);
    const action = match[2] || 'generate', result = issued(f.states[cid], action, options.data);
    f.states[cid] = clone(result); delete f.states[cid].credentials;
    return result;
  };
  const api = { getUser: () => f.user, getClassId: () => f.selectedClass, selectClass: id => { f.selectedClass = id; },
    request(url, options = {}) {
      assert.equal(options.auth, undefined); assert.equal(options.header, undefined);
      assert.ok(['GET', 'POST'].includes(options.method || 'GET'));
      f.calls.push({ url, options: clone(options) });
      return Promise.resolve().then(() => f.route(url, options)).catch(error => { if (error.status === 401) f.user = null; throw error; });
    }
  };
  const forbidden = () => assert.fail('credentials must never be exported, persisted, copied or shared');
  const runtime = { navigateTo: o => f.navigation.push(o.url), reLaunch: o => f.navigation.push(o.url),
    showModal(o) { f.modals.push(o); if (f.confirm) f.confirm(o); else o.success({ confirm: true }); },
    getStorageSync: () => null, setStorageSync: forbidden, setStorage: forbidden, setClipboardData: forbidden,
    getFileSystemManager: forbidden, shareFileMessage: forbidden, openDocument: forbidden, saveFile: forbidden,
    enableAlertBeforeUnload() { f.dirty = true; }, disableAlertBeforeUnload() { f.dirty = false; }, showToast() {}, stopPullDownRefresh() { f.stopped++; }
  };
  const uiModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib/ui.js'), 'utf8'), { require: () => api, module: uiModule, wx: runtime, getCurrentPages: () => f.page ? [f.page] : [] });
  uiModule.exports.dateISO = () => '2026-11-19';
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/paper-accounts/index.js'), 'utf8'), {
    require(specifier) { return { '../../lib/api': api, '../../lib/ui': uiModule.exports, '../../lib/paper-accounts-data': model }[specifier]; },
    Page(value) { definition = value; }, wx: runtime
  }, { filename: 'paper-accounts/index.js' });
  f.page = { ...definition, data: clone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  f.api = api; f.ui = uiModule.exports; f.page.onLoad({}); return f;
}
const writes = f => f.calls.filter(call => call.options.method === 'POST');
const selectReset = f => f.page.selectStudents(event(['s2']));
const fillLink = f => { f.page.onLinkStudent(event(2)); f.page.onFieldInput(event('2510109', { field: 'username' })); };

test('account view maps current, historical and unassigned states without inventing access', () => {
  const raw = snapshot(); raw.password = 'hidden'; raw.credentials = [{ password: 'hidden' }]; raw.students[0].password = 'hidden';
  const state = model.readAccounts(raw, 'class-a'), rows = model.rows(state, []);
  assert.deepEqual(rows.map(row => row.status), ['待生成或关联', '当前关联', '待分配卡号', '保留历史关联']);
  assert.deepEqual(rows.filter(row => row.resettable).map(row => row.studentId), ['s2']);
  assert.equal(JSON.stringify(state).includes('hidden'), false); assert.equal(JSON.stringify(rows).includes('cardNumber'), false);
});
test('all three zero versions are valid, and booleans, strings or invalid revisions are rejected', () => {
  assert.deepEqual(model.versions(snapshot()), { revision: 0, rosterRevision: 0, cardRevision: 0 });
  for (const key of ['revision', 'rosterRevision', 'cardRevision']) for (const value of [true, -1, '0', 0.1, 2147483648]) {
    const state = snapshot(); state[key] = value; assert.throws(() => model.readAccounts(state, 'class-a'), /版本/);
  }
  assert.throws(() => model.readAccounts(snapshot('wrong'), 'class-a'), /班级/);
});
test('generation includes only unlinked students with saved cards and validates year and class code', () => {
  const state = snapshot(), plan = model.action(state, 'generate', { entryYear: '2026', classCode: '109' });
  assert.equal(plan.targets.length, 1); assert.deepEqual(plan.data, { revision: 0, rosterRevision: 0, cardRevision: 0, entryYear: 2026, classCode: '109' });
  for (const input of [{ entryYear: '1999', classCode: '109' }, { entryYear: '2026.0', classCode: '109' }, { entryYear: '2026', classCode: '100' }, { entryYear: '2026', classCode: '409' }])
    assert.throws(() => model.action(state, 'generate', input));
  assert.throws(() => model.action({ ...state, canEdit: false }, 'generate', { entryYear: '2026', classCode: '109' }), /权限/);
});
test('reset rejects duplicates, historical links, unknown identities and oversized selections', () => {
  for (const studentIds of [[], ['s2', 's2'], ['s4'], ['unknown'], ['s1'], Array(158).fill('s2')])
    assert.throws(() => model.action(snapshot(), 'reset', { studentIds }));
  const plan = model.action(snapshot(), 'reset', { studentIds: ['s2'] }); assert.equal(plan.suffix, '/reset'); assert.match(plan.content, /旧密码.*会话/);
});
test('link uses the explicitly selected unlinked student, exact account and complete version vector', () => {
  const plan = model.action(snapshot(), 'link', { studentId: 's3', username: '2510109' });
  assert.deepEqual(plan.data, { revision: 0, rosterRevision: 0, cardRevision: 0, studentId: 's3', username: '2510109' });
  assert.match(plan.content, /学生丙/); assert.match(plan.content, /原班/); assert.match(plan.content, /密码.*保留/);
  for (const studentId of ['s2', 's4', 'unknown']) assert.throws(() => model.action(snapshot(), 'link', { studentId, username: '2510109' }));
});
test('one-time result validates target identities and preserves all six password digits', () => {
  const before = snapshot(), plan = model.action(before, 'reset', { studentIds: ['s2'] });
  const result = issued(before, 'reset', plan.data), clean = model.readResult(result, before, plan);
  assert.equal(clean.credentials[0].password, '000042'); assert.equal(JSON.stringify(clean.state).includes('000042'), false);
  for (const mutate of [r => { r.credentials[0].classId = 'wrong'; }, r => { r.credentials[0].studentId = 's1'; },
    r => { r.credentials[0].password = 42; }, r => { r.credentials = []; }, r => { r.revision = 0; }, r => { r.cardRevision = 1; }]) {
    const bad = clone(result); mutate(bad); assert.throws(() => model.readResult(bad, before, plan));
  }
});
test('view-only teacher may inspect usernames but direct handlers cannot mutate', async () => {
  const f = harness(); f.states['class-a'].canEdit = false; await f.page.onShow();
  assert.equal(f.page.data.rows[1].username, '2610902'); f.page.onFieldInput(event('2027', { field: 'entryYear' }));
  await f.page.generate(); await f.page.reset(); await f.page.link(); assert.equal(writes(f).length, 0); assert.equal(f.modals.length, 0);
});
for (const action of ['generate', 'reset', 'link']) test(action + ' requires a cancelable explicit confirmation and never writes on cancel', async () => {
  const f = harness(); await f.page.onShow(); if (action === 'reset') selectReset(f); if (action === 'link') fillLink(f);
  f.confirm = o => o.success({ confirm: false }); await f.page[action](); assert.equal(f.modals.length, 1); assert.equal(writes(f).length, 0);
  assert.match(f.modals[0].content, /高一（9）班/); assert.equal(f.page.data.busy, false);
});
test('generation shows passwords only in current-page display and blocks another account action until cleared', async () => {
  const f = harness(); await f.page.onShow(); await f.page.generate();
  assert.equal(writes(f).length, 1); assert.equal(f.page.data.credentials[0].password, '000042');
  assert.equal(JSON.stringify(f.page._accounts).includes('000042'), false);
  selectReset(f); await f.page.reset(); assert.equal(writes(f).length, 1);
  f.page.clearCredentials(); selectReset(f); await f.page.reset(); assert.equal(writes(f).length, 2);
  assert.match(f.modals.at(-1).content, /旧密码.*会话/);
});
test('link result changes the account association without returning a password', async () => {
  const f = harness(); await f.page.onShow(); fillLink(f); await f.page.link();
  const call = writes(f)[0]; assert.match(call.url, /\/students\/link$/); assert.equal(call.options.data.studentId, 's3');
  assert.equal(f.page.data.rows[2].username, '2510109'); assert.equal(f.page.data.credentials.length, 0);
});
test('busy guard locks confirmation, duplicate clicks, inputs, selection, class switching and reads', async () => {
  const f = harness(); await f.page.onShow(); const prompt = deferred(); f.confirm = o => prompt.promise.then(o.success);
  const pending = f.page.generate(); await f.page.generate(); f.page.onFieldInput(event('2027', { field: 'entryYear' }));
  await f.page.changeClass(event(1)); selectReset(f); await f.page.load(true);
  assert.equal(f.page.data.classId, 'class-a'); assert.equal(f.page.data.entryYear, '2026');
  prompt.resolve({ confirm: true }); await pending; assert.equal(writes(f).length, 1);
});
for (const status of [401, 403, 409]) test('write ' + status + ' retains inputs and the actual server message', async () => {
  const f = harness(); await f.page.onShow(); fillLink(f); const normal = f.route;
  f.route = (url, options) => { if (options.method === 'POST') throw Object.assign(new Error('服务提示' + status), { status }); return normal(url, options); };
  await f.page.link(); assert.equal(f.page.data.username, '2510109'); assert.equal(f.page.data.error, '服务提示' + status);
  assert.equal(f.page.data.sessionExpired, status === 401); assert.equal(f.page.data.credentials.length, 0);
  if (status === 401) { f.page.relogin(); assert.match(f.navigation.at(-1), /login/); }
  if (status === 409) { await f.page.link(); assert.equal(writes(f).length, 1); assert.equal(f.page.data.conflict, true); }
});
test('ambiguous writes lock repeated operations until a successful explicit reread', async () => {
  const f = harness(); await f.page.onShow(); const normal = f.route;
  f.route = (url, options) => { if (options.method === 'POST') throw Object.assign(new Error('保存结果不确定'), { ambiguous: true }); return normal(url, options); };
  await f.page.generate(); await f.page.generate(); assert.equal(writes(f).length, 1); assert.equal(f.page.data.uncertain, true);
  await f.page.onShow(); assert.equal(f.page.data.uncertain, true);
  f.route = normal; await f.page.reload(); assert.equal(f.page.data.uncertain, false); assert.equal(writes(f).length, 1);
});
test('hidden or unloaded pages erase passwords from display and private account state', async () => {
  for (const lifecycle of ['onHide', 'onUnload']) {
    const f = harness(); await f.page.onShow(); await f.page.generate(); f.page[lifecycle]();
    assert.equal(f.page.data.credentials.length, 0); assert.equal(JSON.stringify(f.page._accounts).includes('000042'), false);
  }
});
test('a delayed successful response can never restore passwords after hide, even if already shown again', async () => {
  const f = harness(); await f.page.onShow(); const waiting = deferred(), normal = f.route;
  f.route = (url, options) => options.method === 'POST' ? waiting.promise : normal(url, options);
  const pending = f.page.generate(); await flush(); f.page.onHide(); await f.page.onShow();
  waiting.resolve(issued(snapshot(), 'generate', writes(f)[0].options.data)); await pending;
  assert.equal(f.page.data.credentials.length, 0); assert.match(f.page.data.status, /清除|丢弃/); assert.equal(f.page.data.busy, false);
});
test('hiding during confirmation aborts the write', async () => {
  const f = harness(); await f.page.onShow(); const prompt = deferred(); f.confirm = o => prompt.promise.then(o.success);
  const pending = f.page.generate(); f.page.onHide(); prompt.resolve({ confirm: true }); await pending; assert.equal(writes(f).length, 0);
});
test('class switch confirms losing forms and credentials, and stale reads cannot overwrite the new class', async () => {
  const f = harness(); await f.page.onShow(); await f.page.generate(); await f.page.changeClass(event(1));
  assert.match(f.modals.at(-1).content, /清除/); assert.equal(f.page.data.credentials.length, 0); assert.equal(f.page.data.classId, 'class-b');
  const waiting = deferred(), normal = f.route; f.route = (url, options) => url.includes('/classes/class-b/students') ? waiting.promise : normal(url, options);
  const pending = f.page.load(); await flush(); await f.page.changeClass(event(0)); waiting.resolve(snapshot('class-b')); await pending;
  assert.equal(f.page.data.classId, 'class-a'); assert.equal(f.page._accounts.classId, 'class-a');
});
test('failed reload keeps conflict and forms; valid reread updates all versions without submitting', async () => {
  const f = harness(); await f.page.onShow(); fillLink(f); f.page.setData({ conflict: true }); const normal = f.route;
  f.route = () => { throw new Error('离线'); }; await f.page.reload(); assert.equal(f.page.data.conflict, true); assert.equal(f.page.data.username, '2510109');
  f.route = normal; f.states['class-a'].rosterRevision = 5; await f.page.reload(); assert.equal(f.page.data.conflict, false); assert.equal(f.page._accounts.rosterRevision, 5); assert.equal(writes(f).length, 0);
});
test('actual read 401 remains visible after shared API clears the login session', async () => {
  const f = harness(); f.route = () => { throw Object.assign(new Error('真实登录过期'), { status: 401 }); };
  await f.page.onShow(); assert.equal(f.page.data.sessionExpired, true); assert.equal(f.page.data.error, '真实登录过期'); assert.equal(f.page.data.loading, false);
});
test('account switch discards late response and cannot display old secrets or authorize another write', async () => {
  const f = harness(); await f.page.onShow(); const waiting = deferred(), normal = f.route;
  f.route = (url, options) => options.method === 'POST' ? waiting.promise : normal(url, options);
  const pending = f.page.generate(); await flush(); f.user = { id: 'teacher-2' }; f.page.onHide(); waiting.resolve(issued(snapshot(), 'generate', writes(f)[0].options.data)); await pending;
  assert.equal(f.page.data.credentials.length, 0); await f.page.onShow(); assert.match(f.navigation.at(-1), /workbench/); assert.equal(writes(f).length, 1);
});
test('malformed successful credential response is uncertain and never displays partial passwords', async () => {
  const f = harness(); await f.page.onShow(); f.route = () => ({ ...issued(snapshot(), 'generate', {}), credentials: [{ password: '000042' }] });
  await f.page.generate(); assert.equal(f.page.data.uncertain, true); assert.equal(f.page.data.credentials.length, 0); await f.page.generate(); assert.equal(writes(f).length, 1);
});
test('link source permission failure stays a real 403 and does not manufacture transfer credentials', async () => {
  const f = harness(); await f.page.onShow(); fillLink(f);
  f.route = () => { throw Object.assign(new Error('没有原班级的学生管理权限，请由同时管理两个班级的老师关联。'), { status: 403 }); };
  await f.page.link(); assert.match(f.page.data.error, /原班级/); assert.equal(f.page.data.credentials.length, 0); assert.equal(writes(f).length, 1);
});
test('cancelled reread preserves visible one-time passwords and never fetches again', async () => {
  const f = harness(); await f.page.onShow(); await f.page.generate(); const count = f.calls.length;
  f.confirm = o => o.success({ confirm: false }); await f.page.reload();
  assert.equal(f.page.data.credentials[0].password, '000042'); assert.equal(f.calls.length, count); assert.equal(f.page.data.busy, false);
});
test('requested class and reset selection cannot target unknown or historical identities', async () => {
  const f = harness(); f.page.onLoad({ classId: 'unauthorized' }); await f.page.onShow();
  assert.equal(f.calls.length, 1); assert.equal(f.page.data.canEdit, false); assert.match(f.page.data.error, /权限/);
  const h = harness(); await h.page.onShow();
  for (const ids of [['s2', 's2'], ['s4'], ['unknown']]) { h.page.selectStudents(event(ids)); assert.equal(h.page.data.selectedIds.length, 0); }
  await h.page.reset(); assert.equal(writes(h).length, 0);
});
test('read 403 revokes local mutation while preserving the actual error', async () => {
  const f = harness(); await f.page.onShow(); f.route = () => { throw Object.assign(new Error('没有查看这个班级的权限。'), { status: 403 }); };
  await f.page.load(); await f.page.generate(); assert.equal(f.page.data.canEdit, false); assert.equal(writes(f).length, 0);
  assert.equal(f.page.data.error, '没有查看这个班级的权限。');
});
test('login state change during a write retains a reconciliation lock and relogin entry', async () => {
  const f = harness(); await f.page.onShow();
  f.route = () => { f.user = null; throw Object.assign(new Error('会话已变化'), { code: 'session_changed' }); };
  await f.page.generate(); assert.equal(f.page.data.uncertain, true); assert.equal(f.page.data.sessionExpired, true); assert.equal(f.page.data.credentials.length, 0);
});
test('same-owner login recovery retains the exact association draft without automatic resubmission', async () => {
  const f = harness(); await f.page.onShow(); fillLink(f); const normal = f.route;
  f.route = () => { throw Object.assign(new Error('会话失效'), { status: 401 }); }; await f.page.link();
  f.page.onHide(); f.user = { id: 'teacher-1' }; f.route = normal; await f.page.onShow();
  assert.equal(f.page.data.username, '2510109'); assert.equal(f.page.data.linkStudentId, 's3'); assert.equal(f.page.data.sessionExpired, false); assert.equal(writes(f).length, 1);
});
test('page files expose linked accessible controls and no print, copy, export or sharing handlers', () => {
  const directory = path.join(root, 'pages/paper-accounts'), f = harness();
  const markup = fs.readFileSync(path.join(directory, 'index.wxml'), 'utf8');
  for (const [, handler] of markup.matchAll(/bind(?:tap|change|input)="([A-Za-z][A-Za-z0-9_]*)"/g)) assert.equal(typeof f.page[handler], 'function', handler);
  assert.match(markup, /page theme-\{\{appearance\}\}/); assert.doesNotMatch(markup, /&amp;|&gt;|&lt;|open-type="share"/);
  for (const control of markup.matchAll(/<(?:input|picker|checkbox)\b[^>]*\/?>/g)) assert.match(control[0], /aria-label=/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8')).enablePullDownRefresh, true);
  assert.ok(fs.readFileSync(path.join(directory, 'index.wxss'), 'utf8').includes('44px'));
  assert.doesNotMatch(fs.readFileSync(path.join(directory, 'index.js'), 'utf8'), /setStorage|setClipboard|shareFile|writeFile|openDocument/);
});

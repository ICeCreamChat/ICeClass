'use strict';
// All requests and wx calls are simulated. This suite never opens a browser,
// logs in to a school, or contacts a classroom device.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const manage = require('../miniprogram/teacher/lib/manage-data');
const root = path.resolve(__dirname, '..');
const teacherRoot = path.join(root, 'miniprogram/teacher');
const clone = value => JSON.parse(JSON.stringify(value));
const plain = value => clone(value);

function actor(role = 'principal', overrides = {}) {
  return { id: 'actor-1', role, grade: role === 'grade_leader' ? '高一' : null,
    permissions: { schoolAdmin: ['superadmin', 'principal'].includes(role),
      manageUsers: ['superadmin', 'principal', 'director', 'grade_leader'].includes(role),
      manageClasses: ['superadmin', 'principal', 'director', 'grade_leader'].includes(role), controlClassrooms: true }, ...overrides };
}
const classes = [
  { id: 'class-1', name: '高一（1）班', enabled: 1, teacher_count: 1, last_seen_at: 1795050000000 },
  { id: 'class-2', name: '高二（2）班', enabled: 1, teacher_count: 0, last_seen_at: null },
  { id: 'class-disabled', name: '高一（3）班', enabled: 0, teacher_count: 1, last_seen_at: null }
];
function account(overrides = {}) {
  return { id: 'user-1', username: 'head.teacher', display_name: '张老师', role: 'teacher', enabled: 1, canManage: true,
    classes: [classes[0]], headClasses: [classes[0]], teachingClasses: [classes[1]], grade: null, ...overrides };
}
function device(overrides = {}) {
  return { id: 'device-1', name: '教室电脑', class_id: 'class-1', class_name: classes[0].name,
    enabled: 1, online: true, capabilities: ['volume', 'reading'], actual_volume: 40, desired_volume: 30,
    desired_command: 'command-1', command_id: 'command-1', command_error: null, receiver_version: '2.5.14',
    last_seen_at: 1795050000000, reported_at: 1795050000000, verified_at: null, local_addresses: ['192.168.1.2'],
    device_code: 'BB-TEST-0001', class_device_count: 1, ...overrides };
}
const allRoles = ['principal', 'director', 'grade_leader', 'teacher', 'subject_teacher'];
const apiError = (message, status = 0, extras = {}) => Object.assign(new Error(message), { status, ...extras });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function tick() { await new Promise(resolve => setImmediate(resolve)); }

function pageFixture(name, options = {}) {
  let user = options.user === undefined ? actor() : options.user;
  let classId = 'class-1';
  let definition;
  const calls = [], confirmations = [], toasts = [], navigations = [];
  const state = { stops: 0, confirms: true, handler: null };
  const api = {
    getUser: () => user, getClassId: () => classId, selectClass: id => { classId = id; },
    async request(url, opts = {}) {
      const call = { path: url, method: opts.method || 'GET', data: opts.data };
      calls.push(call);
      if (state.handler) {
        const response = state.handler(call);
        if (response !== undefined) return response;
      }
      if (url === '/api/classes') return { classes: clone(classes) };
      if (url === '/api/teachers') return { teachers: [account()], assignableRoles: allRoles.slice() };
      if (url === '/api/classroom-controls') return { devices: [device()] };
      throw new Error('Unexpected simulated request: ' + url);
    }
  };
  const ui = {
    requireLogin() { if (user) return true; navigations.push('login'); return false; },
    relogin() { navigations.push('login'); },
    chooseClass(page, index) {
      const selected = page.data.classes[Number(index)];
      if (!selected) return null;
      api.selectClass(selected.id); page.setData({ classIndex: Number(index), classId: selected.id }); return selected;
    },
    fail(page, error) {
      if (error.code === 'session_changed') return;
      page.setData({ error: error.message, sessionExpired: error.status === 401 });
    },
    confirm(title, content, confirmText) {
      confirmations.push({ title, content, confirmText });
      return typeof state.confirms === 'function' ? state.confirms() : Promise.resolve(state.confirms);
    },
    formatTime: value => value == null ? '-' : '北京时间 ' + value,
    toast: text => toasts.push(text)
  };
  const wx = { stopPullDownRefresh() { state.stops++; } };
  const filename = path.join(teacherRoot, 'pages', name, 'index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page(value) { definition = value; }, wx,
    require(module) {
      if (module === '../../lib/api') return api;
      if (module === '../../lib/ui') return ui;
      if (module === '../../lib/manage-data') return manage;
      throw new Error('Unexpected module: ' + module);
    }
  }, { filename });
  const page = { ...definition, data: clone(definition.data), setData(patch) { Object.assign(this.data, clone(patch)); } };
  return { page, api, calls, state, confirmations, toasts, navigations,
    setUser(value) { user = value; },
    writes: () => calls.filter(call => call.method !== 'GET') };
}
const event = id => ({ currentTarget: { dataset: { id } } });
const change = (value, field) => ({ currentTarget: { dataset: { field } }, detail: { value } });

test('class mapping keeps disabled classes, zero teacher counts, and the actual snake_case fields', () => {
  const rows = manage.classesFrom({ classes });
  assert.equal(rows.length, 3);
  assert.equal(rows[2].isEnabled, false);
  assert.equal(rows[1].teacher_count, 0);
  assert.equal(rows[0].last_seen_at, 1795050000000);
  assert.throws(() => manage.classesFrom({ classes: [{ id: 'x', name: 'x' }] }), /格式异常/);
});

test('grade normalization and class creation match server scope rules', () => {
  assert.equal(manage.gradeOf(' 高１（2）班 '), '高一');
  assert.equal(manage.gradeOf('高12班'), '其他');
  assert.equal(manage.gradeOf('毕业留存班'), '其他');
  assert.deepEqual(manage.classPayload('  高一（1）班  ', actor('grade_leader')), { name: '高一（1）班' });
  assert.throws(() => manage.classPayload('高二（1）班', actor('grade_leader')), /负责年级/);
  assert.throws(() => manage.classPayload('毕业留存班', actor('director')), /负责年级/);
  assert.doesNotThrow(() => manage.classPayload('毕业留存班', actor('principal')));
  assert.throws(() => manage.classPayload('高一（1）班', actor('teacher')), /负责年级/);
  assert.throws(() => manage.classPayload('班', actor()), /2 至 40/);
  assert.throws(() => manage.classPayload('班'.repeat(41), actor()), /2 至 40/);
});

test('assignable roles come from the response and never invent superadmin or fall back to the actor role', () => {
  assert.deepEqual(manage.rolesFrom(['teacher', 'superadmin', 'teacher', 'unknown', 'subject_teacher']), ['teacher', 'subject_teacher']);
  assert.deepEqual(manage.rolesFrom([]), []);
  const rows = manage.usersFrom({ teachers: [account(), account({ id: 'actor-1' }), account({ id: 'u2', canManage: false })], assignableRoles: ['subject_teacher'] }, actor());
  assert.ok(rows.every(row => !row.editable));
  const editable = manage.usersFrom({ teachers: [account()], assignableRoles: ['teacher'] }, actor());
  assert.equal(editable[0].editable, true);
  assert.equal(editable[0].display_name, '张老师');
  assert.equal(editable[0].roleLabel, '班主任');
});

test('user creation sends separate head/teaching assignments and preserves disabled-class choices', () => {
  const draft = { ...manage.userDraft(null, ['teacher']), username: 'new.teacher', displayName: ' 李老师 ', password: 'Password2026',
    headClassIds: ['class-1', 'class-1'], teachingClassIds: ['class-disabled'] };
  const payload = manage.userPayload(draft, { roles: ['teacher'], classes, actor: actor() });
  assert.deepEqual(payload, { username: 'new.teacher', displayName: '李老师', password: 'Password2026', role: 'teacher',
    headClassIds: ['class-1'], teachingClassIds: ['class-disabled'] });
  assert.equal(manage.assignmentChoices(classes, ['class-disabled'])[2].checked, true);
  assert.equal(manage.assignmentChoices(classes, ['class-disabled'])[2].isEnabled, false);
});

test('unchanged user edits omit role and assignments so display-name edits do not revoke sessions', () => {
  const existing = account();
  const draft = manage.userDraft(existing, allRoles);
  const context = { existing, roles: allRoles, classes, actor: actor() };
  assert.deepEqual(manage.userPayload(draft, context), {});
  draft.displayName = '新显示名';
  assert.deepEqual(manage.userPayload(draft, context), { displayName: '新显示名' });
  draft.enabled = false;
  assert.deepEqual(manage.userPayload(draft, context), { displayName: '新显示名', enabled: false });
});

test('switching to subject teacher explicitly clears head assignments and retains teaching assignments', () => {
  const existing = account();
  const draft = { ...manage.userDraft(existing, allRoles), role: 'subject_teacher' };
  const payload = manage.userPayload(draft, { existing, roles: allRoles, classes, actor: actor() });
  assert.deepEqual(payload, { role: 'subject_teacher', headClassIds: [], teachingClassIds: ['class-2'] });
  assert.ok(!('username' in payload));
  assert.ok(!('password' in payload));
});

test('user validation rejects unknown roles, self-management, unreturned classes and cross-grade assignment', () => {
  const existing = account();
  const draft = manage.userDraft(existing, allRoles);
  const context = { existing, roles: ['teacher'], classes, actor: actor() };
  assert.throws(() => manage.userPayload({ ...draft, role: 'principal' }, context), /授予此身份/);
  assert.throws(() => manage.userPayload(draft, { ...context, existing: account({ id: 'actor-1' }) }), /不能修改本人/);
  assert.throws(() => manage.userPayload(draft, { ...context, existing: account({ canManage: 'true' }) }), /管理权限/);
  assert.throws(() => manage.userPayload({ ...draft, teachingClassIds: ['not-returned'] }, context), /不在可授权/);
  assert.throws(() => manage.userPayload({ ...draft, headClassIds: [], teachingClassIds: [] }, { ...context, actor: actor('director') }), /至少选择/);
  assert.throws(() => manage.userPayload({ ...draft, role: 'grade_leader', grade: '高二' },
    { ...context, roles: ['grade_leader'], actor: actor('grade_leader') }), /不能授权其他年级/);
  assert.throws(() => manage.userPayload({ ...draft, role: 'grade_leader', grade: '' }, { ...context, roles: ['grade_leader'] }), /负责年级/);
});

test('password rules match Python: 10-128 code points and both ASCII letters and digits', () => {
  assert.match(manage.passwordError('Abc123456'), /至少/);
  assert.equal(manage.passwordError('Abc1234567'), '');
  assert.match(manage.passwordError('a'.repeat(128) + '1'), /超过/);
  assert.equal(manage.passwordError('a1' + '密'.repeat(126)), '');
  assert.equal(manage.passwordError('a1' + '😀'.repeat(126)), '');
  assert.match(manage.passwordError('1234567890'), /字母和数字/);
  assert.match(manage.passwordError('abcdefghij'), /字母和数字/);
  assert.equal(manage.passwordError('Ab12\n67890'), '');
});

test('volume input accepts zero and rejects blank, fractions, booleans and values outside 0-100', () => {
  assert.deepEqual(manage.volumePayload('0'), { action: 'set_volume', volume: 0 });
  assert.deepEqual(manage.volumePayload('100'), { action: 'set_volume', volume: 100 });
  for (const value of ['', ' ', '1.5', '-1', '101', '1e2', true, null, undefined]) assert.throws(() => manage.volumePayload(value), /0 至 100/);
});

test('device mapping distinguishes unknown volume, muted volume, stale acknowledgments and actual execution', () => {
  const map = changes => manage.devicesFrom({ devices: [device(changes)] })[0];
  assert.equal(map({ actual_volume: null }).actualLabel, '未上报');
  assert.equal(map({ actual_volume: 0 }).actualLabel, '0%');
  assert.equal(map({ desired_volume: 0, actual_volume: 0 }).volumeState, '已应用');
  assert.equal(map({ command_id: null, desired_command: null }).volumeState, '等待教室确认');
  assert.equal(map({ command_error: '旧错误', command_id: 'old' }).volumeState, '等待教室确认');
  assert.equal(map({ command_error: '无法设置音量' }).volumeState, '无法设置音量');
  assert.equal(map({ online: false }).volumeState, '待上线应用');
  assert.equal(map({ actual_volume: 40 }).volumeState, '设备当前音量已变化');
  assert.equal(map({ enabled: 0 }).connectionLabel, '已停用');
  assert.equal(map({ capabilities: [] }).volumeState, '未上报音量控制能力');
});

test('offline and online command responses describe broadcasts, never invent a classroom acknowledgment', () => {
  const result = { commandId: 'command', saved: true, delivered: 0 };
  const volume = manage.controlResult(result, classes[0].name, { action: 'set_volume', volume: 0 });
  assert.match(volume, /0%/); assert.match(volume, /当前尚未送达/); assert.doesNotMatch(volume, /已应用/);
  const reading = manage.controlResult({ ...result, saved: false }, classes[0].name, { action: 'open_reading' });
  assert.match(reading, /未送达/); assert.match(reading, /不会在上线后补发/);
  assert.match(manage.controlResult({ ...result, delivered: 2 }, classes[0].name, { action: 'open_reading' }), /广播至 2 个在线连接/);
  assert.throws(() => manage.controlResult({ delivered: 0 }, '班级', { action: 'set_volume', volume: 0 }), error => error.ambiguous === true);
});

test('class update prepares and confirms the existing server action using only POST', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, ...options });
    return calls.length === 1 ? { id: 'operation-1', kind: 'platform', action: 'class.update', target: classes[0].name,
      status: 'awaiting_confirmation', parameters: { enabled: false } } : { id: 'operation-1', status: 'succeeded' };
  };
  await manage.updateClass(request, classes[0], { enabled: false }, () => true);
  assert.deepEqual(calls.map(call => call.method), ['POST', 'POST']);
  assert.deepEqual(calls[0].data, { kind: 'platform', args: { operation: 'class.update', classId: 'class-1', payload: { enabled: false } } });
  assert.equal(calls[1].url, '/api/banban/operations/operation-1/confirm');
  assert.deepEqual(calls[1].data, { confirmed: true });
});

test('class confirmation refuses a renamed target, changed payload or hidden page', async () => {
  for (const [overrides, current] of [[{ target: '已更名的班级' }, true], [{ parameters: { enabled: true } }, true], [{}, false]]) {
    let calls = 0;
    const request = async () => { calls++; return { id: 'op', kind: 'platform', action: 'class.update', target: classes[0].name,
      status: 'awaiting_confirmation', parameters: { enabled: false }, ...overrides }; };
    await assert.rejects(manage.updateClass(request, classes[0], { enabled: false }, () => current));
    assert.equal(calls, 1);
  }
});

test('class update propagates original 403 and does not retry expired or ambiguous operations', async () => {
  const forbidden = apiError('没有此班级的管理权限。', 403);
  await assert.rejects(manage.updateClass(async () => { throw forbidden; }, classes[0], { enabled: false }, () => true), error => error === forbidden);
  for (const status of ['expired', 'unconfirmed']) {
    let calls = 0;
    await assert.rejects(manage.updateClass(async () => ++calls === 1 ?
      { id: 'op', kind: 'platform', action: 'class.update', target: classes[0].name, status: 'awaiting_confirmation', parameters: { enabled: false } } :
      { id: 'op', status, result: { detail: '目标已变化，请重新核对。' } }, classes[0], { enabled: false }, () => true),
    error => error.message === '目标已变化，请重新核对。' && error.ambiguous === (status === 'unconfirmed'));
    assert.equal(calls, 2);
  }
});

for (const name of ['classes', 'users', 'controls']) {
  test(`${name}: onShow requires login and relogin remains an explicit action`, async () => {
    const f = pageFixture(name, { user: null });
    await f.page.onShow();
    assert.equal(f.calls.length, 0); assert.equal(f.page.data.sessionExpired, true);
    assert.deepEqual(f.navigations, ['login']);
    f.page.relogin(); assert.deepEqual(f.navigations, ['login', 'login']);
  });

  test(`${name}: hiding invalidates all pending reads and ignores their later errors`, async () => {
    const f = pageFixture(name);
    const pending = deferred();
    f.state.handler = call => call.path === (name === 'users' ? '/api/teachers' : '/api/classes') ? pending.promise : undefined;
    const loading = f.page.onShow();
    f.page.onHide();
    pending.reject(apiError('这是隐藏页的旧权限错误', 403));
    await loading;
    assert.equal(f.page.data.error, ''); assert.equal(f.page.data.loading, false);
    assert.equal((f.page.data.users || f.page.data.devices || f.page.data.classes).length, 0);
  });

  test(`${name}: an unloaded read cannot apply a later success or select a shared class`, async () => {
    const f = pageFixture(name);
    const pending = deferred();
    f.api.selectClass('previous-class');
    f.state.handler = call => call.path === '/api/classes' ? pending.promise : undefined;
    const loading = f.page.onShow();
    f.page.onUnload();
    pending.resolve({ classes: clone(classes) });
    await loading;
    assert.equal(f.page.data.classes.length, 0);
    assert.equal(f.api.getClassId(), 'previous-class');
  });

  test(`${name}: pull-down refresh always ends on server errors and missing authentication`, async () => {
    const f = pageFixture(name);
    await f.page.onShow();
    f.state.handler = () => Promise.reject(apiError('只保留服务端提示', 403));
    await f.page.onPullDownRefresh();
    assert.equal(f.state.stops, 1); assert.equal(f.page.data.error, '只保留服务端提示');
    f.setUser(null);
    await f.page.onPullDownRefresh();
    assert.equal(f.state.stops, 2); assert.equal(f.page.data.sessionExpired, true);
  });

  test(`${name}: session_changed is ignored, including a stale read from a different account`, async () => {
    const f = pageFixture(name);
    await f.page.onShow();
    f.state.handler = () => Promise.reject(apiError('账号已切换。', 0, { code: 'session_changed' }));
    await f.page.refresh();
    assert.equal(f.page.data.error, ''); assert.equal(f.page.data.sessionExpired, false);
  });
}

test('classes: read-only teachers never get a management action or a write request', async () => {
  const f = pageFixture('classes', { user: actor('teacher') });
  await f.page.onShow();
  assert.equal(f.page.data.canManage, false);
  assert.ok(f.page.data.classes.every(row => !row.canManage));
  f.page.newClass(); await f.page.toggleClass(event('class-1'));
  assert.equal(f.page.data.editorOpen, false); assert.equal(f.writes().length, 0);
});

test('classes: new-class double taps submit once, and 401 retains the draft without automatic navigation', async () => {
  const f = pageFixture('classes');
  await f.page.onShow();
  f.page.newClass(); f.page.inputName(change('高一（9）班'));
  const pending = deferred();
  f.state.handler = call => call.method === 'POST' ? pending.promise : undefined;
  const saving = f.page.saveClass();
  await tick();
  await f.page.saveClass();
  assert.equal(f.writes().length, 1); assert.equal(f.page.data.busy, true);
  f.setUser(null); pending.reject(apiError('学校会话已过期。', 401)); await saving;
  assert.equal(f.page.data.name, '高一（9）班'); assert.equal(f.page.data.editorOpen, true);
  assert.equal(f.page.data.sessionExpired, true); assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.error, '学校会话已过期。'); assert.equal(f.navigations.length, 0);
});

test('classes: stopping a named class explains device disconnection and operation quota before POST', async () => {
  const f = pageFixture('classes');
  await f.page.onShow();
  f.state.confirms = false;
  await f.page.toggleClass(event('class-1'));
  assert.match(f.confirmations[0].content, /高一（1）班/);
  assert.match(f.confirmations[0].content, /断开.*所有教室设备/);
  assert.match(f.confirmations[0].content, /1 次班班操作次数/);
  assert.equal(f.writes().length, 0); assert.equal(f.page.data.busy, false);
});

test('classes: ambiguous creation blocks repeated submission and keeps the draft for manual reconciliation', async () => {
  const f = pageFixture('classes'); await f.page.onShow();
  f.page.newClass(); f.page.inputName(change('高一（9）班'));
  f.state.handler = call => call.method === 'POST' ? Promise.reject(apiError('结果未确认。', 0, { ambiguous: true })) : undefined;
  await f.page.saveClass(); await f.page.saveClass();
  assert.equal(f.writes().length, 1); assert.equal(f.page.data.uncertain, true);
  assert.equal(f.page.data.name, '高一（9）班'); assert.match(f.page.data.status, /先刷新班级列表/);
});

test('users: a non-manager never requests the privileged teacher list', async () => {
  const f = pageFixture('users', { user: actor('subject_teacher') }); await f.page.onShow();
  assert.equal(f.page.data.canManage, false); assert.equal(f.calls.length, 0);
  f.page.newUser(); assert.equal(f.page.data.editorOpen, false);
});

test('users: the server assignableRoles controls all visible role choices, including when empty', async () => {
  const f = pageFixture('users');
  f.state.handler = call => call.path === '/api/teachers' ? { teachers: [account()], assignableRoles: [] } : undefined;
  await f.page.onShow(); f.page.newUser();
  assert.deepEqual(f.page.data.roles, []); assert.equal(f.page.data.editorOpen, false);
  f.state.handler = call => call.path === '/api/teachers' ? { teachers: [account()], assignableRoles: ['teacher', 'subject_teacher'] } : undefined;
  await f.page.refresh(); f.page.newUser(); f.page.chooseRole(change('99'));
  assert.deepEqual(f.page.data.roleNames, ['班主任', '任课老师']); assert.equal(f.page.data.draft.role, 'teacher');
});

test('users: editing display name uses the actual PUT handler and does not resend or clear assignments', async () => {
  const f = pageFixture('users'); await f.page.onShow();
  f.page.editUser(event('user-1')); f.page.inputField(change('新的显示名', 'displayName'));
  f.state.handler = call => call.method === 'PUT' ? { ok: true } : undefined;
  await f.page.saveUser();
  assert.deepEqual(plain(f.writes()), [{ path: '/api/teachers/user-1/classes', method: 'PUT', data: { displayName: '新的显示名' } }]);
  assert.equal(f.page.data.editorOpen, false); assert.equal(f.page.data.draft, null);
  assert.doesNotMatch(f.confirmations[0].content, /现有登录会失效/);
});

test('users: password reset explicitly names the account and session invalidation while preserving a failed password draft', async () => {
  const f = pageFixture('users'); await f.page.onShow();
  f.page.openReset(event('user-1')); f.page.inputResetPassword(change('NewPassword2026'));
  f.state.handler = call => call.method === 'PUT' ? Promise.reject(apiError('没有此账号的管理权限。', 403)) : undefined;
  await f.page.submitReset();
  assert.equal(f.page.data.error, '没有此账号的管理权限。'); assert.equal(f.page.data.resetPassword, 'NewPassword2026');
  assert.match(f.confirmations[0].content, /张老师（head.teacher）/); assert.match(f.confirmations[0].content, /旧密码和该账号的现有登录会立即失效/);
  assert.doesNotMatch(f.confirmations[0].content, /NewPassword2026/);
  assert.deepEqual(plain(f.writes()[0]), { path: '/api/teachers/user-1/password', method: 'PUT', data: { password: 'NewPassword2026' } });
});

test('users: create is locked during confirmation, and 401 preserves name, password, role and assignments', async () => {
  const f = pageFixture('users'); await f.page.onShow(); f.page.newUser();
  f.page.inputField(change('new.teacher', 'username')); f.page.inputField(change('新教师', 'displayName'));
  f.page.inputField(change('Password2026', 'password')); f.page.chooseAssignments(change(['class-disabled'], 'headClassIds'));
  const modal = deferred(); f.state.confirms = () => modal.promise;
  const saving = f.page.saveUser();
  await f.page.saveUser(); f.page.chooseRole(change('1'));
  assert.equal(f.confirmations.length, 1); assert.equal(f.page.data.draft.role, 'teacher'); assert.equal(f.page.data.busy, true);
  f.state.handler = call => call.method === 'POST' ? Promise.reject(apiError('登录已失效，请重新登录。', 401)) : undefined;
  modal.resolve(true); await saving;
  assert.equal(f.writes().length, 1); assert.equal(f.page.data.sessionExpired, true);
  assert.equal(f.page.data.draft.username, 'new.teacher'); assert.equal(f.page.data.draft.displayName, '新教师');
  assert.equal(f.page.data.draft.password, 'Password2026'); assert.deepEqual(f.page.data.draft.headClassIds, ['class-disabled']);
  assert.doesNotMatch(f.confirmations[0].content, /Password2026/); assert.equal(f.navigations.length, 0);
});

test('users: a permission change found by refresh prevents overwriting the newer assignment', async () => {
  const f = pageFixture('users'); await f.page.onShow(); f.page.editUser(event('user-1'));
  f.page.inputField(change('旧草稿的名称', 'displayName'));
  f.state.handler = call => call.path === '/api/teachers' ? { teachers: [account({ teachingClasses: [classes[2]] })], assignableRoles: allRoles } : undefined;
  await f.page.refresh(); await f.page.saveUser();
  assert.equal(f.writes().length, 0); assert.match(f.page.data.error, /账号或授权已变化/);
  assert.equal(f.page.data.draft.displayName, '旧草稿的名称');
});

test('users: hiding during confirmation prevents sending a management write', async () => {
  const f = pageFixture('users'); await f.page.onShow(); f.page.openReset(event('user-1'));
  f.page.inputResetPassword(change('NewPassword2026'));
  const modal = deferred(); f.state.confirms = () => modal.promise;
  const saving = f.page.submitReset(); f.page.onHide(); modal.resolve(true); await saving;
  assert.equal(f.writes().length, 0); assert.equal(f.page.data.resetPassword, 'NewPassword2026'); assert.equal(f.page.data.busy, false);
});

test('users: server 409 retains the complete edited draft without retrying or replacing it with list data', async () => {
  const f = pageFixture('users'); await f.page.onShow(); f.page.editUser(event('user-1'));
  f.page.inputField(change('保留的显示名', 'displayName'));
  f.page.chooseAssignments(change(['class-disabled'], 'headClassIds'));
  const before = clone(f.page.data.draft);
  f.state.handler = call => call.method === 'PUT' ? Promise.reject(apiError('授权已被其他管理员修改，请重新核对。', 409)) : undefined;
  await f.page.saveUser();
  assert.equal(f.writes().length, 1); assert.equal(f.page.data.busy, false); assert.equal(f.page.data.editorOpen, true);
  assert.deepEqual(f.page.data.draft, before); assert.equal(f.page.data.error, '授权已被其他管理员修改，请重新核对。');
});

test('classes: server confirmation conflicts retain the name draft and do not trigger any retry', async () => {
  const f = pageFixture('classes'); await f.page.onShow(); f.page.editClass(event('class-1'));
  f.page.inputName(change('高一（9）班'));
  f.state.handler = call => {
    if (call.path === '/api/banban/operations') return { id: 'op-1', kind: 'platform', action: 'class.update',
      target: classes[0].name, status: 'awaiting_confirmation', parameters: { name: '高一（9）班' } };
    if (call.path === '/api/banban/operations/op-1/confirm') return { id: 'op-1', status: 'failed',
      result: { detail: '目标或设置已被其他操作修改，请重新读取并提出操作。' } };
  };
  await f.page.saveClass();
  assert.equal(f.writes().length, 2); assert.equal(f.page.data.name, '高一（9）班');
  assert.equal(f.page.data.editorOpen, true); assert.equal(f.page.data.busy, false); assert.match(f.page.data.error, /已被其他操作修改/);
  assert.equal(f.page.data.classes[0].name, classes[0].name);
});

test('controls: changing classes clears old results immediately and ignores old successful reads', async () => {
  const f = pageFixture('controls'); await f.page.onShow();
  f.page.inputVolume(change('27'));
  const old = deferred(), newer = deferred(); let reads = 0;
  f.state.handler = call => call.path === '/api/classroom-controls' ? (++reads === 1 ? old.promise : newer.promise) : undefined;
  const first = f.page.chooseClass(change('0'));
  const second = f.page.chooseClass(change('1'));
  assert.equal(f.page.data.classId, 'class-2'); assert.equal(f.page.data.devices.length, 0); assert.equal(f.page.data.canSend, false);
  newer.resolve({ devices: [device({ id: 'device-2', class_id: 'class-2', desired_volume: 70 })] }); await second;
  assert.equal(f.page.data.devices[0].id, 'device-2'); assert.equal(f.page.data.volumeDraft, '70');
  old.resolve({ devices: [device({ desired_volume: 5 })] }); await first;
  assert.equal(f.page.data.classId, 'class-2'); assert.equal(f.api.getClassId(), 'class-2');
  assert.equal(f.page.data.devices[0].id, 'device-2'); assert.equal(f.page.data.volumeDraft, '70');
  f.state.handler = null; await f.page.chooseClass(change('0'));
  assert.equal(f.page.data.volumeDraft, '27');
});

test('controls: an old class error cannot replace the new class state or expire its session', async () => {
  const f = pageFixture('controls'); await f.page.onShow();
  const old = deferred(); let reads = 0;
  f.state.handler = call => call.path === '/api/classroom-controls' ? (++reads === 1 ? old.promise : { devices: [device({ class_id: 'class-2' })] }) : undefined;
  const first = f.page.chooseClass(change('0')); await f.page.chooseClass(change('1'));
  old.reject(apiError('旧班级的登录错误', 401)); await first;
  assert.equal(f.page.data.error, ''); assert.equal(f.page.data.sessionExpired, false); assert.equal(f.page.data.classId, 'class-2');
});

test('controls: disabled classes, disabled-only devices and explicit permission denial prevent writes', async () => {
  const f = pageFixture('controls'); await f.page.onShow();
  await f.page.chooseClass(change('2')); f.page.inputVolume(change('0')); await f.page.setVolume();
  assert.equal(f.page.data.canSend, false); assert.match(f.page.data.availability, /班级已停用/);
  f.state.handler = call => call.path === '/api/classroom-controls' ? { devices: [device({ enabled: 0 })] } : undefined;
  await f.page.chooseClass(change('0')); await f.page.setVolume();
  assert.equal(f.page.data.canSend, false); assert.match(f.page.data.availability, /没有启用/);
  assert.equal(f.writes().length, 0);
  const denied = pageFixture('controls', { user: actor('teacher', { permissions: { controlClassrooms: false } }) });
  await denied.page.onShow(); assert.equal(denied.page.data.canSend, false); assert.match(denied.page.data.availability, /没有教室控制权限/);
});

test('controls: offline volume zero is saved through the original route and remains distinct from applied volume', async () => {
  const f = pageFixture('controls');
  f.state.handler = call => call.path === '/api/classroom-controls' ? { devices: [device({ online: false })] } : undefined;
  await f.page.onShow(); f.page.inputVolume(change('0'));
  f.state.handler = call => call.method === 'POST' ? { commandId: 'cmd-2', delivered: 0, saved: true } :
    call.path === '/api/classroom-controls' ? { devices: [device({ online: false, desired_volume: 0 })] } : undefined;
  await f.page.setVolume();
  assert.deepEqual(plain(f.writes()), [{ path: '/api/classes/class-1/control', method: 'POST', data: { action: 'set_volume', volume: 0 } }]);
  assert.match(f.page.data.status, /保存 0%/); assert.match(f.page.data.status, /当前尚未送达/);
  assert.equal(f.page.data.devices[0].volumeState, '待上线应用');
  assert.match(f.confirmations[0].content, /高一（1）班/); assert.match(f.confirmations[0].content, /本班所有在线连接广播/);
});

test('controls: early-reading delivery zero is reported as unsent and never as opened', async () => {
  const f = pageFixture('controls'); await f.page.onShow();
  f.state.handler = call => call.method === 'POST' ? { commandId: 'reading-1', saved: false, delivered: 0 } : undefined;
  await f.page.openReading();
  assert.deepEqual(plain(f.writes()[0].data), { action: 'open_reading' });
  assert.match(f.page.data.status, /早读指令未送达/); assert.match(f.page.data.status, /不会在上线后补发/);
  assert.doesNotMatch(f.page.data.status, /已打开/);
});

test('controls: a write locks class changes and double taps; 401 preserves the same class volume draft', async () => {
  const f = pageFixture('controls'); await f.page.onShow(); f.page.inputVolume(change('63'));
  const pending = deferred(); f.state.handler = call => call.method === 'POST' ? pending.promise : undefined;
  const saving = f.page.setVolume(); await tick();
  await f.page.chooseClass(change('1')); await f.page.setVolume();
  assert.equal(f.page.data.classId, 'class-1'); assert.equal(f.writes().length, 1);
  pending.reject(apiError('学校登录已过期。', 401)); await saving;
  assert.equal(f.page.data.volumeDraft, '63'); assert.equal(f.page.data.sessionExpired, true);
  assert.equal(f.page.data.error, '学校登录已过期。'); assert.equal(f.page.data.busy, false); assert.equal(f.navigations.length, 0);
});

test('controls: unknown capabilities retain explicit states and do not invent early-reading support', async () => {
  const f = pageFixture('controls');
  f.state.handler = call => call.path === '/api/classroom-controls' ? { devices: [device({ capabilities: [] })] } : undefined;
  await f.page.onShow();
  assert.equal(f.page.data.canSend, true); assert.equal(f.page.data.canOpenReading, false);
  assert.match(f.page.data.readingHint, /尚未上报早读能力/); assert.match(f.page.data.volumeHint, /以教室端回报为准/);
  await f.page.openReading(); assert.equal(f.writes().length, 0);
});

test('native templates expose names, re-login and 44px controls, with no web-view, HTML entities or destructive device operations', () => {
  for (const name of ['classes', 'users', 'controls']) {
    const folder = path.join(teacherRoot, 'pages', name);
    const markup = fs.readFileSync(path.join(folder, 'index.wxml'), 'utf8');
    const style = fs.readFileSync(path.join(folder, 'index.wxss'), 'utf8');
    const js = fs.readFileSync(path.join(folder, 'index.js'), 'utf8');
    const config = JSON.parse(fs.readFileSync(path.join(folder, 'index.json'), 'utf8'));
    assert.equal(config.enablePullDownRefresh, true); assert.match(markup, /login-required\.wxml/);
    assert.doesNotMatch(markup, /<web-view\b|&amp;|&lt;|&gt;/i);
    for (const input of markup.match(/<(?:input|picker|checkbox)\b[^>]*>/g) || []) assert.match(input, /aria-label="[^"]+"/);
    assert.match(style, /min-height:\s*44px/);
    assert.doesNotMatch(js, /setInterval|method:\s*['"]DELETE['"]|\/api\/devices\//);
  }
});

test('management transport matches the current backend forwarding routes and original authorization guards', () => {
  const app = fs.readFileSync(path.join(root, 'server/app.py'), 'utf8');
  const reading = fs.readFileSync(path.join(root, 'server/reading.py'), 'utf8');
  const operations = fs.readFileSync(path.join(root, 'server/banban_operations.py'), 'utf8');
  assert.match(app, /add_put\("\/api\/teachers\/\{teacher_id\}\/classes", set_teacher_classes\)/);
  assert.match(app, /async def set_teacher_classes\(request[^]*?return await update_teacher\(request\)/);
  assert.match(app, /async def update_teacher\(request[^]*?can_manage_user\(db, user, existing\)/);
  assert.match(app, /async def update_class\(request[^]*?require_manager\(request\)[^]*?can_access_class\(db, user, class_id, include_disabled=True\)/);
  assert.match(operations, /routes\.add_post\('\/api\/banban\/operations', self\.create_endpoint\)/);
  assert.match(operations, /fresh\['baseline'\] != args\.get\('baseline'\)/);
  assert.match(operations, /self\.f\.quotas\.consume\(request, user\)/);
  assert.match(reading, /add_post\("\/api\/classes\/\{class_id\}\/control", feature\.command\)/);
  assert.match(reading, /async def command\(self, request\):[^]*?self\.access\(self\.db, user, class_id\)/);
});

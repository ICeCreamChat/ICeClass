'use strict';
// Only synthetic data and simulated wx/API calls. No school or device
// is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const settings = require('../miniprogram/teacher/lib/settings-data');
const root = path.resolve(__dirname, '..', 'miniprogram', 'teacher');
const clone = value => JSON.parse(JSON.stringify(value));
const error = (message, status = 0, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const event = (key, value) => ({ currentTarget: { dataset: { [key]: value } } });
const input = (value, dataset = {}) => ({ currentTarget: { dataset }, detail: { value } });
const actor = (role = 'principal', extra = {}) => ({ id: 'actor', role,
  permissions: { manageUsers: ['principal', 'superadmin', 'director', 'grade_leader'].includes(role) }, ...extra });
const classes = [{ id: 'c1', name: '高一（1）班', enabled: 1 }, { id: 'c2', name: '高二（2）班', enabled: 1 },
  { id: 'old', name: '毕业留存班', enabled: 0 }];
const device = (extra = {}) => ({ id: 'd1', name: '前门电脑', class_id: 'c1', class_name: classes[0].name, enabled: 1,
  online: true, device_code: 'BB-TEST-001', computer_name: 'DEMO-PC', os_version: '测试系统', local_addresses: ['192.0.2.10'],
  binding_note: '前门', verified_at: 1000, last_seen_at: 2000, identity_seen_at: 2000, class_device_count: 1, ...extra });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(name, user = actor()) {
  let definition;
  const calls = [], confirmations = [], toasts = [];
  const state = { user, handler: null, consent: true, dirty: false, stops: 0, logins: 0, requires: 0,
    devices: [device()], classes: clone(classes), prepared: null };

  const api = {
    getUser: () => state.user,
    async request(url, opts = {}) {
      const call = { path: url, method: opts.method || 'GET', data: opts.data === undefined ? undefined : clone(opts.data) };
      calls.push(call);
      if (state.handler) { const result = state.handler(call); if (result !== undefined) return result; }
      if (call.method === 'GET') {
        if (url === '/api/devices') return { devices: clone(state.devices) };
        if (url === '/api/classes') return { classes: clone(state.classes) };
      }
      if (url === '/api/banban/operations') {
        state.prepared = call.data.args;
        const row = state.devices.find(item => item.id === call.data.args.targetId);
        const parameters = clone(call.data.args.payload);
        if ('classId' in parameters) { parameters.targetClassName = state.classes.find(item => item.id === parameters.classId).name; delete parameters.classId; }
        return { id: 'op1', kind: 'platform', action: 'device.update', target: row.name, status: 'awaiting_confirmation', parameters };
      }
      if (url === '/api/banban/operations/op1/confirm') {
        const row = state.devices.find(item => item.id === state.prepared.targetId), payload = state.prepared.payload;
        for (const [key, field] of [['name', 'name'], ['note', 'binding_note'], ['classId', 'class_id'], ['enabled', 'enabled']]) {
          if (key in payload) row[field] = payload[key];
        }
        if ('verified' in payload) row.verified_at = payload.verified ? 3000 : null;
        row.class_name = state.classes.find(item => item.id === row.class_id).name;
        return { id: 'op1', status: 'succeeded', result: { ok: true } };
      }
      if (url === '/api/banban/operations/op1/cancel') return { id: 'op1', status: 'cancelled' };
      throw new Error('Unexpected simulated request: ' + call.method + ' ' + url);
    }
  };
  const ui = {
    requireLogin() { state.requires++; if (state.user) return true; state.logins++; return false; },
    relogin() { state.logins++; },
    fail(page, err) { if (err.code !== 'session_changed') page.setData({ error: err.message, sessionExpired: err.status === 401 }); },
    confirm(title, content, confirmText) {
      confirmations.push({ title, content, confirmText });
      return typeof state.consent === 'function' ? state.consent() : Promise.resolve(state.consent);
    },
    formatTime: value => value == null ? '-' : `北京时间 ${value}`,
    toast: text => toasts.push(text), setDirty(value) { state.dirty = value; }
  };
  const filename = path.join(root, 'pages', name, 'index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { Page(value) { definition = value; },
    wx: { stopPullDownRefresh() { state.stops++; } }, require(module) {
      if (module === '../../lib/api') return api;
      if (module === '../../lib/ui') return ui;
      if (module === '../../lib/settings-data') return settings;
      throw new Error('Unexpected module: ' + module);
    }
  }, { filename });
  const page = { ...definition, data: clone(definition.data), setData(patch) { Object.assign(this.data, clone(patch)); } };
  return { page, state, api, calls, confirmations, toasts, writes: () => calls.filter(call => call.method !== 'GET') };
}
async function editDevice(f) {
  await f.page.onShow(); f.page.openDevice(event('id', 'd1')); f.page.inputField(input('更改后的电脑', { field: 'name' }));
}
test('real manager roles also require the server capability', () => {
  for (const role of ['superadmin', 'principal', 'director', 'grade_leader']) assert.equal(settings.manager(actor(role)), true);
  assert.equal(settings.manager(actor('teacher', { permissions: { manageUsers: true } })), false);
  assert.equal(settings.manager(actor('principal', { permissions: {} })), false);
});

test('device projection preserves real identity fields and disabled devices without copying unknown credentials', () => {
  const row = settings.devicesFrom({ devices: [device({ enabled: 0, token: 'synthetic-secret', local_addresses: ['192.0.2.1', null] })] })[0];
  assert.equal(row.connectionLabel, '已停用'); assert.deepEqual(row.local_addresses, ['192.0.2.1']);
  assert.equal(row.verified_at, 1000); assert.equal(row.computer_name, 'DEMO-PC'); assert.ok(!('token' in row));
  assert.throws(() => settings.devicesFrom({ devices: [{ id: 'd1' }] }), /格式异常/);
});

test('device baseline ignores live telemetry but catches binding, enablement, note and verification changes', () => {
  const row = settings.devicesFrom({ devices: [device()] })[0];
  assert.equal(settings.deviceBaseline(row), settings.deviceBaseline({ ...row, online: false, last_seen_at: 4000 }));
  for (const patch of [{ class_id: 'c2' }, { enabled: false }, { binding_note: '后门' }, { verified_at: 4000 }]) {
    assert.notEqual(settings.deviceBaseline(row), settings.deviceBaseline({ ...row, ...patch }));
  }
});

test('device payload contains only changed supported fields and rebind clears verification', () => {
  const row = settings.devicesFrom({ devices: [device()] })[0], options = settings.classesFrom({ classes });
  assert.deepEqual(settings.devicePayload(settings.deviceDraft(row), row, options), {});
  assert.deepEqual(settings.devicePayload({ ...settings.deviceDraft(row), classId: 'c2', verified: false, note: '' }, row, options),
    { classId: 'c2', verified: false, note: '' });
  assert.throws(() => settings.devicePayload({ ...settings.deviceDraft(row), classId: 'old' }, row, options), /启用/);
  assert.throws(() => settings.devicePayload({ ...settings.deviceDraft(row), name: ' ' }, row, options), /80/);
});

test('devices page does not request privileged endpoints for non-managers', async () => {
  const f = fixture('device-settings', actor('teacher')); await f.page.onShow(); await f.page.save();
  assert.equal(f.page.data.allowed, false); assert.equal(f.calls.length, 0);
});

test('binding picker includes the current disabled class but does not change global selected class', async () => {
  const f = fixture('device-settings'); f.state.devices = [device({ class_id: 'old', class_name: '毕业留存班' })];
  await f.page.onShow(); f.page.openDevice(event('id', 'd1'));
  assert.deepEqual(f.page.data.classChoices.map(row => row.id), ['c1', 'c2', 'old']);
  f.page.changeClass(input('1')); assert.equal(f.page.data.draft.classId, 'c2'); assert.equal(f.page.data.draft.verified, false);
});

test('device save uses the exact existing prepare/confirm protocol and translated target class name', async () => {
  const f = fixture('device-settings'); await editDevice(f); f.page.changeClass(input('1'));
  await f.page.save();
  assert.deepEqual(f.writes().map(call => call.path), ['/api/banban/operations', '/api/banban/operations/op1/confirm']);
  assert.equal(f.writes()[0].data.args.operation, 'device.update'); assert.equal(f.writes()[0].data.args.targetId, 'd1');
  assert.equal(f.writes()[0].data.args.payload.classId, 'c2'); assert.equal(f.page.data.dirty, false);
  assert.match(f.confirmations[0].content, /断开.*早读/); assert.match(f.confirmations[0].content, /1 次.*不退回/);
  assert.equal(f.state.devices[0].class_id, 'c2');
});

test('device save locks duplicate taps and class controls before confirmation', async () => {
  const f = fixture('device-settings'); await editDevice(f); const gate = deferred(); f.state.consent = () => gate.promise;
  const work = f.page.save(); await f.page.save(); f.page.changeClass(input('1')); f.page.inputField(input('不能覆盖', { field: 'name' }));
  assert.equal(f.confirmations.length, 1); assert.equal(f.page.data.draft.classId, 'c1'); assert.equal(f.page.data.draft.name, '更改后的电脑');
  gate.resolve(false); await work; assert.equal(f.writes().length, 0); assert.equal(f.page.data.busy, false);
});

test('device mismatch between editor and fresh server snapshot aborts confirmation and preserves draft', async () => {
  const f = fixture('device-settings'); await editDevice(f); f.state.devices[0].binding_note = '他人已改';
  await f.page.save(); assert.deepEqual(f.writes().map(call => call.path), ['/api/banban/operations', '/api/banban/operations/op1/cancel']);
  assert.equal(f.page.data.conflict, true);
  assert.equal(f.page.data.draft.name, '更改后的电脑'); await f.page.save(); assert.equal(f.writes().length, 2);
});

test('device confirmation refuses an altered operation view', async () => {
  const f = fixture('device-settings'); await editDevice(f);
  f.state.handler = call => call.path === '/api/banban/operations' ? { id: 'op1', kind: 'platform', action: 'device.update',
    target: '其他电脑', status: 'awaiting_confirmation', parameters: call.data.args.payload } : undefined;
  await f.page.save(); assert.equal(f.writes().filter(call => call.path.endsWith('/confirm')).length, 0); assert.equal(f.page.data.conflict, true);
});

test('failed device preflight cleanup preserves the original conflict and never confirms or retries', async () => {
  const f = fixture('device-settings'); await editDevice(f); f.state.devices[0].binding_note = '其他页面已改';
  f.state.handler = call => { if (call.path.endsWith('/cancel')) throw error('模拟清理连接中断', 0, { ambiguous: true }); };
  await f.page.save(); assert.equal(f.page.data.conflict, true); assert.match(f.page.data.error, /设备绑定已在其他页面修改/);
  assert.equal(f.writes().filter(call => call.path.endsWith('/cancel')).length, 1);
  assert.equal(f.writes().filter(call => call.path.endsWith('/confirm')).length, 0);
});

test('device draft controls are locked while an explicitly confirmed reload is reading', async () => {
  const f = fixture('device-settings'); await editDevice(f); const gate = deferred();
  f.state.handler = call => call.path === '/api/devices' ? gate.promise : undefined;
  const work = f.page.refresh(); await tick(); assert.equal(f.page.data.loading, true);
  f.page.inputField(input('读取期间的新输入', { field: 'name' })); f.page.changeClass(input('1'));
  assert.equal(f.page.data.draft.name, '更改后的电脑'); assert.equal(f.page.data.draft.classId, 'c1');
  gate.resolve({ devices: [device()] }); await work; assert.equal(f.page.data.draft, null);
});

test('server device baseline conflict retains the real message and prevents blind resubmission', async () => {
  const f = fixture('device-settings'); await editDevice(f);
  f.state.handler = call => call.path.endsWith('/confirm') ? { id: 'op1', status: 'failed', result: { detail: '目标或设置已被其他操作修改，请重新读取并提出操作。' } } : undefined;
  await f.page.save(); assert.match(f.page.data.error, /目标或设置/); assert.equal(f.page.data.conflict, true); assert.equal(f.page.data.uncertain, false);
});

for (const [status, message] of [[401, '请先登录。'], [403, '没有此设备的管理权限。']]) {
  test(`device ${status} retains drafts and original server feedback`, async () => {
    const f = fixture('device-settings'); await editDevice(f);
    f.state.handler = call => { if (call.method === 'POST') { if (status === 401) f.state.user = null; throw error(message, status); } };
    await f.page.save(); assert.equal(f.page.data.error, message); assert.equal(f.page.data.sessionExpired, status === 401);
    assert.equal(f.page.data.draft.name, '更改后的电脑'); assert.equal(f.page.data.dirty, true); assert.equal(f.page.data.busy, false);
  });
}

test('device ambiguous response blocks duplicate writes until an explicit successful reload', async () => {
  const f = fixture('device-settings'); await editDevice(f);
  f.state.handler = call => { if (call.path.endsWith('/confirm')) throw error('网络中断，结果未知。', 0, { ambiguous: true }); };
  await f.page.save(); await f.page.save(); assert.equal(f.writes().length, 2); assert.equal(f.page.data.uncertain, true);
  f.state.handler = null; await f.page.refresh(); assert.equal(f.page.data.uncertain, false); assert.equal(f.page.data.draft, null);
});

test('device reads completing after hide cannot populate the page', async () => {
  const f = fixture('device-settings'), gate = deferred();
  f.state.handler = call => call.path === '/api/devices' ? gate.promise : undefined;
  const work = f.page.onShow(); f.page.onHide(); gate.resolve({ devices: [device()] }); await work;
  assert.equal(f.page.data.devices.length, 0); assert.equal(f.page.data.loading, false);
});

test('leaving during device preparation prevents later confirmation and keeps an uncertain draft', async () => {
  const f = fixture('device-settings'); await editDevice(f); const gate = deferred();
  f.state.handler = call => call.path === '/api/banban/operations' ? gate.promise : undefined;
  const work = f.page.save(); await tick(); f.page.onHide();
  gate.resolve({ id: 'op1', kind: 'platform', action: 'device.update', target: '前门电脑', status: 'awaiting_confirmation', parameters: { name: '更改后的电脑' } });
  await work; assert.equal(f.writes().length, 1); assert.equal(f.page.data.uncertain, true); assert.equal(f.page.data.dirty, true);
});

for (const name of ['device-settings']) {
  test(`${name} ignores a read completed after unload`, async () => {
    const f = fixture(name, actor('superadmin')), gate = deferred(); let first = true;
    f.state.handler = () => { if (first) { first = false; return gate.promise; } };
    const work = f.page.onShow(); f.page.onUnload();
    gate.resolve({ devices: [device()] });
    await work; assert.equal(f.page.data.draft, null); assert.equal(f.page.data.loading, false);
  });
  test(`${name} preserves an existing draft when an explicit reload gets 401`, async () => {
    const f = fixture(name, actor('superadmin'));
    await editDevice(f);
    const before = clone(f.page.data.draft);
    f.state.handler = call => { if (call.method === 'GET') { f.state.user = null; throw error('请先登录。', 401); } };
    await f.page.refresh(); assert.deepEqual(f.page.data.draft, before); assert.equal(f.page.data.sessionExpired, true);
    assert.equal(f.page.data.dirty, true); assert.equal(f.page.data.busy, false); assert.equal(f.page.data.loading, false);
  });
  test(`${name} checks login on show and always ends pull-down refresh`, async () => {
    const f = fixture(name, null); await f.page.onShow(); await f.page.onPullDownRefresh(); assert.equal(f.state.requires, 2); assert.equal(f.state.stops, 1);
    f.state.user = actor('superadmin'); f.state.handler = () => { throw error('测试读取失败', 403); };
    await f.page.onShow(); await f.page.onPullDownRefresh(); assert.equal(f.state.stops, 2); assert.equal(f.page.data.error, '测试读取失败');
  });
  test(`${name} has complete native page files, accessible fields, valid handlers and no background polling`, () => {
    const dir = path.join(root, 'pages', name), config = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(config.enablePullDownRefresh, true); assert.ok(config.navigationBarTitleText);
    const source = fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), markup = fs.readFileSync(path.join(dir, 'index.wxml'), 'utf8');
    assert.ok(fs.readFileSync(path.join(dir, 'index.wxss'), 'utf8').length > 0);
    assert.doesNotMatch(markup, /web-view|&amp;&amp;|&gt;|&lt;/); assert.doesNotMatch(source, /setInterval|setTimeout|console\.|wx\.(setStorage|request|connectSocket)/);
    for (const tag of markup.matchAll(/<(input|picker|checkbox)\b[^>]*>/g)) assert.match(tag[0], /aria-label=/);
    const f = fixture(name);
    for (const handler of markup.matchAll(/bind(?:tap|input|change)="([A-Za-z]+)"/g)) assert.equal(typeof f.page[handler[1]], 'function', handler[1]);
    assert.match(markup, /login-required\.wxml/); assert.match(source, /ui\.requireLogin\(\)/); assert.match(source, /settings\.invalidate\(this\)/);
  });
}

test('each page ignores reads from a previous account and previous generation', async () => {
  for (const name of ['device-settings']) {
    const f = fixture(name, actor('superadmin')), gate = deferred(); let first = true;
    f.state.handler = () => { if (first) { first = false; return gate.promise; } };
    const work = f.page.onShow(); f.state.user = actor('superadmin', { id: 'other-actor' });
    gate.resolve(name === 'device-settings' ? { devices: [device()] } : name === 'connection-settings' ? connection() : usage());
    await work;
    assert.equal(f.page.data.draft, null); assert.equal(f.writes().length, 0);
  }
});

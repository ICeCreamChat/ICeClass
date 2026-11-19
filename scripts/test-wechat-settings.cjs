'use strict';
// Only synthetic data and simulated wx/API calls. No school, device or provider
// is contacted, and all key strings below are artificial test fixtures.
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
const connection = () => ({ source: 'personal', configured: true, enabled: true,
  personal: { enabled: true, configured: true, baseUrl: 'https://provider.example/v1', model: 'demo-model' },
  school: { enabled: true, configured: true }, canManageSchool: true });
const school = () => ({ enabled: true, configured: true, baseUrl: 'https://school.example/v1', model: 'school-model' });
const quota = () => ({ revision: 7, deviceLimit: 100, accountLimit: 200, month: '2026-11', resetsAt: 1796054400000,
  overrides: [{ kind: 'device', id: 'shared', limit: 0 }, { kind: 'account', id: 'shared', limit: null }, { kind: 'account', id: 'disabled', limit: 77 }],
  targets: [
    { kind: 'device', id: 'shared', name: '测试电脑', detail: classes[0].name, enabled: 1, used: 11, limit: 0, source: 'custom' },
    { kind: 'account', id: 'shared', name: '测试老师', detail: 'demo.teacher', enabled: 1, used: 13, limit: null, source: 'custom' },
    { kind: 'account', id: 'disabled', name: '停用老师', detail: 'disabled.teacher', enabled: 0, used: 15, limit: 77, source: 'custom' },
    { kind: 'account', id: 'actor', name: '测试管理员', detail: 'admin.demo', enabled: 1, used: 5, limit: 200, source: 'default' }
  ] });
const usage = () => ({ kind: 'account', month: '2026-11', used: 5, limit: 200, remaining: 195, resetsAt: 1796054400000, source: 'default' });
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
    devices: [device()], classes: clone(classes), account: connection(), school: school(), quota: quota(), usage: usage(), prepared: null };
  state.account.canManageSchool = ['superadmin', 'principal'].includes(user && user.role);
  const api = {
    getUser: () => state.user,
    async request(url, opts = {}) {
      const call = { path: url, method: opts.method || 'GET', data: opts.data === undefined ? undefined : clone(opts.data) };
      calls.push(call);
      if (state.handler) { const result = state.handler(call); if (result !== undefined) return result; }
      if (call.method === 'GET') {
        if (url === '/api/devices') return { devices: clone(state.devices) };
        if (url === '/api/classes') return { classes: clone(state.classes) };
        if (url === '/api/banban/connection') return clone(state.account);
        if (url === '/api/banban/settings') return clone(state.school);
        if (url === '/api/banban/quota') return clone(state.usage);
        if (url === '/api/banban/quotas') return clone(state.quota);
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
      if (call.method === 'PUT' && url === '/api/banban/connection') {
        const body = call.data;
        state.account.source = body.source;
        if (body.source === 'personal') state.account.personal = { enabled: body.enabled, baseUrl: body.baseUrl, model: body.model,
          configured: body.clearKey ? false : Boolean(body.apiKey) || state.account.personal.configured };
        const effective = body.source === 'school' ? state.account.school : state.account.personal;
        state.account.enabled = effective.enabled; state.account.configured = effective.configured;
        return clone(state.account);
      }
      if (call.method === 'PUT' && url === '/api/banban/settings') {
        state.school = { enabled: call.data.enabled, baseUrl: call.data.baseUrl, model: call.data.model,
          configured: call.data.clearKey ? false : Boolean(call.data.apiKey) || state.school.configured };
        return clone(state.school);
      }
      if (call.method === 'PUT' && url === '/api/banban/quotas') {
        const body = call.data;
        state.quota = { ...state.quota, ...body, revision: body.revision + 1 };
        state.quota.targets = state.quota.targets.map(row => {
          const rule = body.overrides.find(item => settings.keyOf(item) === settings.keyOf(row));
          return { ...row, source: rule ? 'custom' : 'default', limit: rule ? rule.limit : body[row.kind + 'Limit'] };
        });
        return clone(state.quota);
      }
      if (call.method === 'POST' && url.startsWith('/api/banban/connection/test')) return { ok: true };
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
async function editConnection(f) {
  await f.page.onShow(); f.page.inputField(input('new-demo-model', { field: 'model' }));
}
async function editQuota(f) {
  await f.page.onShow(); f.page.inputDefault(input('300', { kind: 'account' }));
}

test('real manager roles also require the server capability; quota administration excludes principals and classroom accounts', () => {
  for (const role of ['superadmin', 'principal', 'director', 'grade_leader']) assert.equal(settings.manager(actor(role)), true);
  assert.equal(settings.manager(actor('teacher', { permissions: { manageUsers: true } })), false);
  assert.equal(settings.manager(actor('principal', { permissions: {} })), false);
  assert.equal(settings.quotaAdmin(actor('principal')), false);
  assert.equal(settings.quotaAdmin(actor('superadmin', { classroom: { deviceId: 'd1' } })), false);
  assert.equal(settings.quotaAdmin(actor('superadmin')), true);
  assert.equal(settings.schoolAdmin(actor('teacher'), true), false);
  assert.equal(settings.schoolAdmin(actor('principal'), false), false);
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

test('connection projections discard raw keys from both personal and school snapshots', () => {
  const value = connection(); value.apiKey = 'synthetic-key'; value.personal.apiKey = 'synthetic-key';
  const mapped = settings.accountConnection(value);
  assert.equal(JSON.stringify(mapped).includes('synthetic-key'), false);
  assert.equal(JSON.stringify(settings.publicConfig({ ...school(), apiKey: 'synthetic-key' })).includes('synthetic-key'), false);
  assert.equal(settings.connectionDraft(mapped, 'account').apiKey, '');
});

test('school source payload preserves personal config and never sends hidden personal fields or owner IDs', () => {
  const cfg = settings.accountConnection(connection()), draft = { ...settings.connectionDraft(cfg, 'account'), source: 'school', apiKey: 'synthetic-key', clearKey: true };
  assert.deepEqual(settings.connectionPayload(draft, 'account', cfg), { source: 'school' });
});

test('connection validators match supported model/key fields and keep URL safety authoritative on server', () => {
  const cfg = connection(), draft = settings.connectionDraft(cfg, 'account');
  assert.deepEqual(settings.connectionPayload(draft, 'account', cfg), { source: 'personal', enabled: true, baseUrl: cfg.personal.baseUrl, model: cfg.personal.model });
  for (const baseUrl of ['http://provider.example', 'https://name:key@provider.example', 'https://provider.example?key=test', 'https://provider.example/#key']) {
    assert.throws(() => settings.connectionPayload({ ...draft, baseUrl }, 'account', cfg), /HTTPS/);
  }
  assert.throws(() => settings.connectionPayload({ ...draft, model: 'a model' }, 'account', cfg), /模型/);
  assert.throws(() => settings.connectionPayload({ ...draft, apiKey: 'key with spaces' }, 'account', cfg), /API Key/);
  assert.throws(() => settings.connectionPayload({ ...draft, apiKey: 'key', clearKey: true }, 'account', cfg), /分别/);
  assert.throws(() => settings.connectionPayload({ ...draft, clearKey: true }, 'account', cfg), /自己的 API Key/);
});

test('quota kind plus id is the identity; explicit unlimited is different from inheriting default', () => {
  const cfg = settings.quotasFrom(quota()), draft = settings.quotaDraft(cfg), target = cfg.targets[0];
  const inherited = settings.setOverride(draft, target, 'inherit', '');
  assert.ok(!inherited.overrides.some(row => row.kind === 'device' && row.id === 'shared'));
  assert.deepEqual(inherited.overrides.find(row => row.kind === 'account' && row.id === 'shared'), { kind: 'account', id: 'shared', limit: null });
  const unlimited = settings.setOverride(inherited, target, 'unlimited', '');
  assert.deepEqual(unlimited.overrides.find(row => row.kind === 'device'), { kind: 'device', id: 'shared', limit: null });
  assert.ok(unlimited.overrides.some(row => row.id === 'disabled' && row.limit === 77));
});

test('quota payload is exact, preserves revision and every untouched override, validates integer boundaries', () => {
  const cfg = settings.quotasFrom(quota()), draft = settings.quotaDraft(cfg);
  const body = settings.quotaPayload(draft);
  assert.deepEqual(Object.keys(body).sort(), ['accountLimit', 'deviceLimit', 'overrides', 'revision']);
  assert.equal(body.revision, 7); assert.deepEqual(body.overrides, cfg.overrides);
  for (const value of ['-1', '1.5', '1000001', '', 'Infinity', '1e3']) assert.throws(() => settings.quotaPayload({ ...draft, deviceValue: value }), /整数/);
  assert.equal(settings.quotaPayload({ ...draft, deviceValue: '1000000' }).deviceLimit, 1000000);
  assert.equal(settings.quotaPayload({ ...draft, deviceMode: 'unlimited' }).deviceLimit, null);
  assert.equal(settings.quotaPayload({ ...draft, deviceMode: 'paused' }).deviceLimit, 0);
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

test('connection account loads without requesting school config or testing the provider', async () => {
  const f = fixture('connection-settings', actor('teacher')); await f.page.onShow();
  assert.deepEqual(f.calls.map(call => call.path), ['/api/banban/connection']); assert.equal(f.page.data.canManageSchool, false);
  await f.page.changeWorkspace(event('workspace', 'school')); assert.equal(f.calls.length, 1);
});

test('forged school flag does not grant a teacher school connection management', async () => {
  const f = fixture('connection-settings', actor('teacher')); f.state.account.canManageSchool = true;
  await f.page.onShow(); await f.page.changeWorkspace(event('workspace', 'school')); assert.equal(f.page.data.workspace, 'account');
});

test('school effective key status is distinct from the saved personal key status', async () => {
  const f = fixture('connection-settings'); f.state.account.source = 'school'; f.state.account.personal.configured = false;
  await f.page.onShow(); f.page.changeSource(event('source', 'personal'));
  assert.equal(f.page.data.configured, true); assert.equal(f.page.data.keyConfigured, false);
  await f.page.save(); assert.equal(f.writes().length, 0); assert.match(f.page.data.error, /自己的 API Key/);
});

test('personal connection save sends supported fields only and clears entered key after success', async () => {
  const f = fixture('connection-settings'); await editConnection(f); f.page.inputField(input('synthetic-new-key', { field: 'apiKey' }));
  await f.page.save(); assert.equal(f.writes().length, 1);
  assert.deepEqual(f.writes()[0], { path: '/api/banban/connection', method: 'PUT', data: { source: 'personal', enabled: true,
    baseUrl: 'https://provider.example/v1', model: 'new-demo-model', apiKey: 'synthetic-new-key' } });
  assert.equal(f.page.data.draft.apiKey, ''); assert.equal(f.page.data.dirty, false);
  assert.equal(f.confirmations[0].content.includes('synthetic-new-key'), false);
});

test('blank key preserves saved key instead of sending an empty replacement', async () => {
  const f = fixture('connection-settings'); await editConnection(f); await f.page.save();
  assert.ok(!('apiKey' in f.writes()[0].data)); assert.ok(!('clearKey' in f.writes()[0].data));
});

test('switching account to school sends only source even if a hidden personal draft has a key', async () => {
  const f = fixture('connection-settings'); await editConnection(f); f.page.inputField(input('synthetic-draft-key', { field: 'apiKey' }));
  f.page.changeSource(event('source', 'school')); await f.page.save(); assert.deepEqual(f.writes()[0].data, { source: 'school' });
  assert.equal(f.state.account.personal.model, 'demo-model'); assert.match(f.confirmations[0].content, /个人连接草稿不会写入/);
});

test('clearing saved key requires an explicit flag and confirmation naming the effect', async () => {
  const f = fixture('connection-settings'); await f.page.onShow(); f.page.changeFlags(input(['clearKey'])); await f.page.save();
  assert.equal(f.writes()[0].data.clearKey, true); assert.equal(f.writes()[0].data.enabled, false);
  assert.match(f.confirmations[0].content, /清除已保存的 API Key/); assert.equal(f.state.account.personal.configured, false);
});

test('school settings save uses the admin endpoint without account source or owner fields', async () => {
  const f = fixture('connection-settings'); await f.page.onShow(); await f.page.changeWorkspace(event('workspace', 'school'));
  f.page.inputField(input('new-school-model', { field: 'model' })); await f.page.save();
  assert.equal(f.writes()[0].path, '/api/banban/settings'); assert.equal(f.writes()[0].method, 'PUT');
  assert.deepEqual(Object.keys(f.writes()[0].data).sort(), ['baseUrl', 'enabled', 'model']); assert.match(f.confirmations[0].content, /影响所有选择学校连接/);
});

test('separate account and school drafts survive switching workspaces', async () => {
  const f = fixture('connection-settings'); await editConnection(f); f.page.inputField(input('synthetic-draft', { field: 'apiKey' }));
  await f.page.changeWorkspace(event('workspace', 'school')); f.page.inputField(input('unsaved-school-model', { field: 'model' }));
  await f.page.changeWorkspace(event('workspace', 'account')); assert.equal(f.page.data.draft.model, 'new-demo-model'); assert.equal(f.page.data.draft.apiKey, 'synthetic-draft');
  await f.page.changeWorkspace(event('workspace', 'school')); assert.equal(f.page.data.draft.model, 'unsaved-school-model'); assert.equal(f.writes().length, 0);
});

test('connection testing is explicit, mentions provider cost, and is blocked with unsaved changes', async () => {
  const f = fixture('connection-settings'); await editConnection(f); await f.page.testConnection(); assert.equal(f.writes().length, 0);
  f.state.consent = false; await f.page.refresh(); assert.equal(f.page.data.dirty, true);
  f.state.consent = true; await f.page.refresh(); f.state.consent = false; await f.page.testConnection(); assert.equal(f.writes().length, 0);
  assert.match(f.confirmations.at(-1).content, /服务商费用.*不发送班级数据/);
  f.state.consent = true; await f.page.testConnection(); assert.deepEqual(f.writes().map(call => call.path), ['/api/banban/connection/test']);
});

test('school connection test targets school and sends no key or school data', async () => {
  const f = fixture('connection-settings'); await f.page.onShow(); await f.page.changeWorkspace(event('workspace', 'school')); await f.page.testConnection();
  assert.deepEqual(f.writes()[0], { path: '/api/banban/connection/test?target=school', method: 'POST', data: {} });
});

test('connection preflight conflicts never perform PUT or replace a dirty draft', async () => {
  const f = fixture('connection-settings'); await editConnection(f); f.state.account.personal.model = 'changed-elsewhere';
  await f.page.save(); assert.equal(f.writes().length, 0); assert.equal(f.page.data.conflict, true); assert.equal(f.page.data.draft.model, 'new-demo-model');
});

test('connection write lock covers the modal and disables source/workspace changes', async () => {
  const f = fixture('connection-settings'); await editConnection(f); const gate = deferred(); f.state.consent = () => gate.promise;
  const work = f.page.save(); await f.page.save(); f.page.changeSource(event('source', 'school')); await f.page.changeWorkspace(event('workspace', 'school'));
  assert.equal(f.confirmations.length, 1); assert.equal(f.page.data.draft.source, 'personal'); assert.equal(f.page.data.workspace, 'account');
  gate.resolve(false); await work; assert.equal(f.writes().length, 0);
});

test('connection 401 keeps in-memory key draft, sanitizes feedback, and exposes relogin', async () => {
  const f = fixture('connection-settings'); await editConnection(f); f.page.inputField(input('synthetic-private-key', { field: 'apiKey' }));
  f.state.handler = call => { if (call.method === 'PUT') { f.state.user = null; throw error('凭证失效 synthetic-private-key', 401); } };
  await f.page.save(); assert.equal(f.page.data.sessionExpired, true); assert.equal(f.page.data.draft.apiKey, 'synthetic-private-key');
  assert.equal(f.page.data.error.includes('synthetic-private-key'), false); f.page.relogin(); assert.equal(f.state.logins, 1);
});

test('connection 403 preserves the original permission message and draft', async () => {
  const f = fixture('connection-settings'); await editConnection(f);
  f.state.handler = call => { if (call.method === 'PUT') throw error('没有执行此操作的权限。', 403); };
  await f.page.save(); assert.equal(f.page.data.error, '没有执行此操作的权限。'); assert.equal(f.page.data.dirty, true);
});

test('connection busy 409 and ambiguous save do not retry automatically', async () => {
  for (const err of [error('请等待本次回答完成。', 409), error('保存结果未知。', 0, { ambiguous: true })]) {
    const f = fixture('connection-settings'); await editConnection(f);
    f.state.handler = call => { if (call.method === 'PUT') throw err; };
    await f.page.save(); await f.page.save(); assert.equal(f.writes().length, 1); assert.equal(f.page.data.dirty, true);
    assert.equal(f.page.data.conflict, err.status === 409); assert.equal(f.page.data.uncertain, Boolean(err.ambiguous));
  }
});

test('malformed connection save receipt preserves draft and blocks duplicate submission', async () => {
  const f = fixture('connection-settings'); await editConnection(f); f.state.handler = call => call.method === 'PUT' ? { ok: true } : undefined;
  await f.page.save(); assert.equal(f.page.data.uncertain, true); assert.equal(f.page.data.draft.model, 'new-demo-model');
});

test('late account response cannot overwrite the school workspace', async () => {
  const f = fixture('connection-settings'); await f.page.onShow(); const gate = deferred(); let pending = true;
  f.state.handler = call => { if (pending && call.path === '/api/banban/connection') { pending = false; return gate.promise; } };
  const refresh = f.page.refresh(); await tick(); await f.page.changeWorkspace(event('workspace', 'school'));
  gate.resolve(connection()); await refresh; assert.equal(f.page.data.workspace, 'school'); assert.equal(f.page.data.draft.model, 'school-model');
});

test('safe feedback removes keys, bearer credentials and URLs without copying error data', () => {
  const err = settings.safeError(error('fail synthetic-key Bearer synthetic-token https://provider.example/key', 403, { data: { apiKey: 'synthetic-key' } }), ['synthetic-key']);
  assert.equal(err.status, 403); assert.ok(!err.message.includes('synthetic-key')); assert.ok(!err.message.includes('synthetic-token'));
  assert.ok(!err.message.includes('provider.example')); assert.equal(err.data, undefined);
});

for (const user of [actor('teacher'), actor('principal'), actor('superadmin', { classroom: { deviceId: 'd1', classId: 'c1' } })]) {
  test(`quota own usage only for ${user.role}${user.classroom ? ' classroom' : ''}`, async () => {
    const f = fixture('quota-settings', user); await f.page.onShow(); await f.page.save();
    assert.equal(f.page.data.canManage, false); assert.deepEqual(f.calls.map(call => call.path), ['/api/banban/quota']); assert.equal(f.page.data.usage.used, 5);
  });
}

test('quota editor preserves opposite-kind and disabled-object overrides when applying a single rule', async () => {
  const f = fixture('quota-settings', actor('superadmin')); await f.page.onShow(); f.page.openTarget(event('key', 'device:shared'));
  f.page.changeTargetMode(input('0')); f.page.applyTarget();
  f.page.changeWorkspace(event('workspace', 'account')); assert.equal(f.page.data.rows.length, 3);
  const body = settings.quotaPayload(f.page.data.draft);
  assert.equal(body.overrides.some(row => row.kind === 'device' && row.id === 'shared'), false);
  assert.ok(body.overrides.some(row => row.kind === 'account' && row.id === 'shared' && row.limit === null));
  assert.ok(body.overrides.some(row => row.id === 'disabled' && row.limit === 77));
  await f.page.save(); assert.equal(f.writes()[0].data.overrides.length, 2); assert.equal(f.page.data.dirty, false);
});

test('quota in-progress target input must be applied before the whole policy can save', async () => {
  const f = fixture('quota-settings', actor('superadmin')); await editQuota(f); f.page.openTarget(event('key', 'device:shared'));
  f.page.changeTargetMode(input('1')); f.page.inputTarget(input('123')); await f.page.save(); assert.equal(f.writes().length, 0);
  f.page.applyTarget(); await f.page.save(); assert.equal(f.writes()[0].data.overrides.find(row => row.kind === 'device').limit, 123);
});

test('quota save sends exact revision contract, advances revision, and retains monthly usage', async () => {
  const f = fixture('quota-settings', actor('superadmin')); await editQuota(f); await f.page.save();
  const body = f.writes()[0].data;
  assert.deepEqual(Object.keys(body).sort(), ['accountLimit', 'deviceLimit', 'overrides', 'revision']); assert.equal(body.revision, 7);
  assert.equal(body.accountLimit, 300); assert.deepEqual(body.overrides, quota().overrides);
  assert.equal(f.page.data.draft.revision, 8); assert.equal(f.page.data.usage.used, 5); assert.equal(f.page.data.usage.remaining, 295);
  assert.match(f.confirmations[0].content, /保留当月已用次数/);
});

test('quota 409 keeps draft and original revision and blocks resubmission', async () => {
  const f = fixture('quota-settings', actor('superadmin')); await editQuota(f);
  f.state.handler = call => { if (call.method === 'PUT') throw error('次数设置已在其他页面修改，请重新载入后核对。', 409); };
  await f.page.save(); await f.page.save(); assert.equal(f.writes().length, 1); assert.equal(f.page.data.draft.revision, 7);
  assert.equal(f.page.data.draft.accountValue, '300'); assert.equal(f.page.data.conflict, true);
  f.state.consent = false; await f.page.refresh(); assert.equal(f.page.data.draft.accountValue, '300');
  f.state.handler = null; f.state.quota.revision = 9; f.state.consent = true; await f.page.refresh();
  assert.equal(f.page.data.conflict, false); assert.equal(f.page.data.draft.revision, 9); assert.equal(f.page.data.dirty, false);
});

test('quota 401 preserves defaults, overrides and original revision', async () => {
  const f = fixture('quota-settings', actor('superadmin')); await editQuota(f);
  f.state.handler = call => { if (call.method === 'PUT') { f.state.user = null; throw error('请先登录。', 401); } };
  await f.page.save(); assert.equal(f.page.data.sessionExpired, true); assert.equal(f.page.data.draft.revision, 7);
  assert.equal(f.page.data.draft.accountValue, '300'); assert.deepEqual(f.page.data.draft.overrides, quota().overrides);
});

test('quota busy lock covers confirmation, inputs, target editing and workspace changes', async () => {
  const f = fixture('quota-settings', actor('superadmin')); await editQuota(f); const gate = deferred(); f.state.consent = () => gate.promise;
  const work = f.page.save(); await f.page.save(); f.page.inputDefault(input('999', { kind: 'account' }));
  f.page.changeWorkspace(event('workspace', 'account')); f.page.openTarget(event('key', 'device:shared'));
  assert.equal(f.page.data.draft.accountValue, '300'); assert.equal(f.page.data.workspace, 'device'); assert.equal(f.page.data.editor, null);
  assert.equal(f.confirmations.length, 1); gate.resolve(false); await work; assert.equal(f.writes().length, 0);
});

test('quota ambiguous or malformed receipt cannot silently replace draft', async () => {
  const f = fixture('quota-settings', actor('superadmin')); await editQuota(f);
  f.state.handler = call => call.method === 'PUT' ? quota() : undefined;
  await f.page.save(); await f.page.save(); assert.equal(f.page.data.uncertain, true); assert.equal(f.page.data.draft.revision, 7); assert.equal(f.writes().length, 1);
});

for (const name of ['device-settings', 'connection-settings', 'quota-settings']) {
  test(`${name} ignores a read completed after unload`, async () => {
    const f = fixture(name, actor('superadmin')), gate = deferred(); let first = true;
    f.state.handler = () => { if (first) { first = false; return gate.promise; } };
    const work = f.page.onShow(); f.page.onUnload();
    gate.resolve(name === 'device-settings' ? { devices: [device()] } : name === 'connection-settings' ? connection() : usage());
    await work; assert.equal(f.page.data.draft, null); assert.equal(f.page.data.loading, false);
    if (name === 'quota-settings') assert.equal(f.page.data.usage, null);
  });
  test(`${name} preserves an existing draft when an explicit reload gets 401`, async () => {
    const f = fixture(name, actor('superadmin'));
    await (name === 'device-settings' ? editDevice(f) : name === 'connection-settings' ? editConnection(f) : editQuota(f));
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
    assert.match(markup, /bindtap="relogin"/); assert.match(source, /ui\.requireLogin\(\)/); assert.match(source, /settings\.invalidate\(this\)/);
  });
}

test('each page ignores reads from a previous account and previous generation', async () => {
  for (const name of ['device-settings', 'connection-settings', 'quota-settings']) {
    const f = fixture(name, actor('superadmin')), gate = deferred(); let first = true;
    f.state.handler = () => { if (first) { first = false; return gate.promise; } };
    const work = f.page.onShow(); f.state.user = actor('superadmin', { id: 'other-actor' });
    gate.resolve(name === 'device-settings' ? { devices: [device()] } : name === 'connection-settings' ? connection() : usage());
    await work;
    assert.equal(f.page.data.draft, null); assert.equal(f.writes().length, 0);
  }
});

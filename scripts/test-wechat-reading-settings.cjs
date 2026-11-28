'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const reading = require('../miniprogram/teacher/lib/reading-settings');
const reports = require('../miniprogram/teacher/lib/report-data');
const root = path.resolve(__dirname, '../miniprogram/teacher');
const copy = value => JSON.parse(JSON.stringify(value));
const now = Date.parse('2026-11-19T11:00:00Z');
const flush = () => new Promise(setImmediate);
const failure = (message, fields = {}) => Object.assign(Error(message), fields);
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const event = (field, value, key) => ({ currentTarget: { dataset: { field, key } }, detail: { value } });
const admin = () => ({ id: 'teacher', role: 'principal', permissions: { schoolAdmin: true } });
function readingProfile() {
  return { config: { enabled: true, reminderEnabled: true, threshold: 30, periods: [{ weekdays: [1, 2, 3, 4, 5], start: 440, end: 470 }],
    classic: { duration: 25, targetCount: 12 }, rocket: { duration: 15, targetCount: 10 }, carving: { speed: 0.7 }, particle: { speed: 1 } },
  serverTime: now, inPeriod: false };
}

// Actual page + feature helpers + shared UI, with only API transport and WeChat
// calls simulated. No network, device action, real file sharing, or polling.
function fixture(name = 'reading-settings') {
  const f = { user: name === 'reading-settings' ? admin() : { id: 'teacher', role: 'teacher', permissions: {} },
    selected: 'a', calls: [], confirmations: [], navigation: [], timers: [], stopped: 0, confirmResult: true, dirty: false,
    reading: readingProfile() };
  let epoch = 0;
  f.setUser = user => { f.user = user; ++epoch; };
  f.reply = (url, options) => {
    const method = options.method || 'GET';
    if (url === '/api/classes') return { classes: [{ id: 'a', name: '一班', enabled: 1 }, { id: 'b', name: '二班', enabled: 1 }] };
    if (url === '/api/reading/settings') {
      if (method === 'PUT') f.reading = { ...f.reading, config: { ...f.reading.config, ...copy(options.data) } };
      return f.reading;
    }
    if (url.startsWith('/api/reading/report?')) return { rows: [], daily: [] };
    throw Error('Unexpected simulated endpoint: ' + method + ' ' + url);
  };
  const api = {
    getUser: () => f.user, getClassId: () => f.selected, selectClass: id => { f.selected = id; },
    async request(url, options = {}) {
      const requestEpoch = epoch;
      f.calls.push({ url, ...copy(options) });
      try {
        const response = await f.reply(url, options);
        if (requestEpoch !== epoch) throw failure('账号已切换。', { code: 'session_changed' });
        return copy(response);
      } catch (error) {
        if (requestEpoch !== epoch) throw failure('账号已切换。', { code: 'session_changed' });
        if (error.status === 401) { f.user = null; ++epoch; }
        throw error;
      }
    }
  };
  const runtime = {
    navigateTo: options => { f.navigation.push(options.url); }, reLaunch: options => { f.navigation.push(options.url); },
    stopPullDownRefresh: () => { ++f.stopped; }, getStorageSync: () => null,
    setNavigationBarColor() {}, setBackgroundColor() {}, showToast: options => { f.toast = options.title; },
    enableAlertBeforeUnload: () => { f.dirty = true; }, disableAlertBeforeUnload: () => { f.dirty = false; },
    showModal(options) {
      f.confirmations.push({ title: options.title, content: options.content, confirmText: options.confirmText });
      const answer = typeof f.confirmResult === 'function' ? f.confirmResult(options) : f.confirmResult;
      Promise.resolve(answer).then(confirm => options.success({ confirm }), options.fail);
    },
    shareFileMessage() { throw Error('No actual sharing is permitted'); }
  };
  const uiModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib/ui.js'), 'utf8'), {
    module: uiModule, require: id => { assert.equal(id, './api'); return api; }, wx: runtime,
    getCurrentPages: () => f.page ? [f.page] : []
  }, { filename: 'ui.js' });
  const ui = uiModule.exports;
  let definition;
  const imports = { '../../lib/api': api, '../../lib/ui': ui,
    '../../lib/reading-settings': reading, '../../lib/report-data': reports };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages', name, 'index.js'), 'utf8'), {
    require(id) { assert.ok(Object.hasOwn(imports, id), 'Unexpected import: ' + id); return imports[id]; },
    Page(value) { definition = value; }, wx: runtime,
    setTimeout(callback, delay) { f.timers.push({ callback, delay }); return f.timers.length; }, clearTimeout() {},
    setInterval() { throw Error('Background polling is forbidden'); }
  }, { filename: name + '/index.js' });
  f.page = { ...definition, data: copy(definition.data), setData(patch) { Object.assign(this.data, copy(patch)); } };
  if (f.page.onLoad) f.page.onLoad();
  f.api = api; f.ui = ui;
  f.writes = () => f.calls.filter(call => ['POST', 'PUT', 'DELETE'].includes(call.method));
  return f;
}

test('reading payload uses only four actual editable fields and preserves 24:00 and normalized weekdays', () => {
  const draft = reading.draftFrom(readingProfile().config); draft.periods[0].endTime = '24:00'; draft.periods[0].weekdays = [7, 1, 7];
  const payload = reading.payload(draft);
  assert.deepEqual(Object.keys(payload), ['enabled', 'reminderEnabled', 'threshold', 'periods']);
  assert.deepEqual(payload.periods, [{ weekdays: [1, 7], start: 440, end: 1440 }]);
  assert.equal(reading.minute('24:00'), 1440); assert.equal(reading.minute('24:01'), null);
  assert.equal(reading.periodRows(draft)[0].endPickerValue, '23:59'); assert.match(reading.confirmation(payload), /全校所有班级/);
});

test('reading validation mirrors the real bounds, enabled-empty rule, days and cross-day restrictions', () => {
  const config = reading.configFrom(readingProfile().config);
  for (const patch of [{ threshold: 4 }, { threshold: 91 }, { threshold: true }, { periods: [] },
    { periods: Array(31).fill(config.periods[0]) }, { periods: [{ weekdays: [], start: 440, end: 470 }] },
    { periods: [{ weekdays: [true], start: 440, end: 470 }] }, { periods: [{ weekdays: [8], start: 440, end: 470 }] },
    { periods: [{ weekdays: [1], start: 470, end: 440 }] }, { periods: [{ weekdays: [1], start: 1440, end: 1440 }] }]) {
    assert.throws(() => reading.configFrom({ ...config, ...patch }));
  }
  assert.equal(reading.configFrom({ ...config, enabled: false, periods: [] }).periods.length, 0);
  const draft = reading.draftFrom(config); draft.threshold = '';
  assert.throws(() => reading.payload(draft), /不能留空/); assert.equal(reading.dirty(draft, config), true);
});

test('reading settings permission requires the server school role and capability, with no view writes', async () => {
  for (const user of [{ id: 'teacher', role: 'teacher', permissions: { schoolAdmin: true } },
    { id: 'teacher', role: 'principal', permissions: { schoolAdmin: false } }]) {
    const f = fixture('reading-settings'); f.setUser(user); await f.page.onShow(); f.page.onAdd(); await f.page.onSave();
    assert.equal(f.calls.length, 0); assert.equal(f.page.data.canEdit, false); assert.match(f.page.data.error, /校长/);
  }
  const f = fixture('reading-settings'); await f.page.onShow(); assert.equal(f.calls.length, 1); assert.equal(f.writes().length, 0); assert.equal(f.timers.length, 0);
  assert.equal(f.page.data.canEdit, true); assert.equal(f.page.data.config.threshold, 30);
});

test('reading period controls keep invalid drafts, stable keys, day selection and midnight semantics', async () => {
  const f = fixture('reading-settings'); await f.page.onShow(); f.page.onAdd();
  const key = f.page.data.periods[1].key;
  f.page.onDays(event('', [], key)); f.page.onMidnight(event('', true, key)); await f.page.onSave();
  assert.equal(f.writes().length, 0); assert.match(f.page.data.error, /星期/); assert.equal(f.page.data.periods[1].key, key);
  f.page.onDays(event('', ['7', '1'], key)); f.page.onTime(event('startTime', '22:00', key));
  assert.equal(f.page.data.periods[1].endTime, '24:00'); assert.deepEqual(f.page.data.periods[1].weekdays, [7, 1]);
  f.page.onDelete(event('', '', key)); assert.equal(f.page.data.periods.length, 1);
  for (let i = 0; i < 30; ++i) f.page.onAdd(); assert.equal(f.page.data.periods.length, 30); assert.match(f.page.data.error, /最多 30/);
});

test('reading confirmation cancellation and repeated taps do not issue an unchecked write', async () => {
  const f = fixture('reading-settings'); await f.page.onShow(); f.page.onThreshold(event('', '42'));
  f.confirmResult = false; await f.page.onSave(); assert.equal(f.calls.length, 1); assert.equal(f.writes().length, 0);
  const pending = deferred(); f.confirmResult = () => pending.promise;
  const save = f.page.onSave(); await f.page.onSave(); f.page.onThreshold(event('', '50'));
  assert.equal(f.page.data.draft.threshold, '42'); assert.equal(f.page.data.busy, true);
  pending.resolve(true); await save; assert.equal(f.writes().length, 1);
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'GET', 'PUT']);
  assert.equal(f.writes()[0].data.threshold, 42); assert.equal(f.writes()[0].data.revision, undefined); assert.equal(f.writes()[0].data.classic, undefined);
  assert.equal(f.reading.config.classic.duration, 25); assert.equal(f.page.data.dirty, false); assert.match(f.page.data.status, /所有班级/);
});

test('reading save preflight detects another administrator update and preserves every draft field', async () => {
  const f = fixture('reading-settings'); await f.page.onShow(); f.page.onThreshold(event('', '44')); f.page.onAdd();
  f.reading.config.periods[0].end = 480; await f.page.onSave(); await f.page.onSave();
  assert.equal(f.writes().length, 0); assert.equal(f.page.data.conflict, true); assert.equal(f.page.data.draft.threshold, '44');
  assert.equal(f.page.data.periods.length, 2); assert.match(f.page.data.error, /未提交保存/);
  await f.page.onDiscard(); assert.equal(f.page.data.conflict, false); assert.equal(f.page.data.draft.threshold, '30');
  assert.equal(f.page.data.periods[0].endTime, '08:00');
});

test('reading 401 keeps draft through same-user recovery and always offers relogin', async () => {
  const f = fixture('reading-settings'); const base = f.reply; await f.page.onShow(); f.page.onThreshold(event('', '48'));
  f.reply = (url, options) => { if (options.method === 'PUT') throw failure('请重新登录后保存早读规则', { status: 401 }); return base(url, options); };
  await f.page.onSave(); assert.equal(f.page.data.sessionExpired, true); assert.equal(f.page.data.draft.threshold, '48');
  f.page.relogin(); assert.equal(f.navigation.at(-1), '/pages/login/index'); f.page.onHide(); f.setUser(admin()); f.reply = base; await f.page.onShow();
  assert.equal(f.page.data.draft.threshold, '48'); assert.equal(f.page.data.dirty, true); assert.equal(f.page.data.sessionExpired, false);
});

test('reading 403 retains the original service explanation and prevents another write', async () => {
  const f = fixture('reading-settings'); const base = f.reply; await f.page.onShow(); f.page.onThreshold(event('', '46'));
  f.reply = (url, options) => { if (options.method === 'PUT') throw failure('没有执行此操作的权限。', { status: 403 }); return base(url, options); };
  await f.page.onSave(); await f.page.onSave(); assert.equal(f.page.data.error, '没有执行此操作的权限。');
  assert.equal(f.page.data.draft.threshold, '46'); assert.equal(f.page.data.canEdit, false); assert.equal(f.writes().length, 1);
});

test('reading revocation during confirmation prevents PUT after the final permission check', async () => {
  const f = fixture('reading-settings'); await f.page.onShow(); f.page.onThreshold(event('', '46'));
  f.confirmResult = () => { f.user.permissions.schoolAdmin = false; return true; };
  await f.page.onSave(); assert.equal(f.writes().length, 0); assert.equal(f.page.data.canEdit, false); assert.match(f.page.data.error, /编辑权限/);
});

test('reading ambiguous write blocks retries, refresh confirms result and keeps later edits', async () => {
  const f = fixture('reading-settings'); const base = f.reply; await f.page.onShow(); f.page.onThreshold(event('', '40'));
  f.reply = (url, options) => { if (options.method === 'PUT') { base(url, options); throw failure('保存结果未知', { ambiguous: true }); } return base(url, options); };
  await f.page.onSave(); await f.page.onSave(); assert.equal(f.writes().length, 1); assert.equal(f.page.data.uncertain, true);
  f.page.onThreshold(event('', '45')); await f.page.onRefresh();
  assert.equal(f.page.data.config.threshold, 40); assert.equal(f.page.data.draft.threshold, '45'); assert.equal(f.page.data.dirty, true); assert.equal(f.page.data.uncertain, false);
});

test('unconfirmed reading timeout remains blocked after unchanged GET; discard is explicit', async () => {
  const f = fixture('reading-settings'); const base = f.reply; await f.page.onShow(); f.page.onThreshold(event('', '40'));
  f.reply = (url, options) => { if (options.method === 'PUT') throw failure('保存结果未知', { ambiguous: true }); return base(url, options); };
  await f.page.onSave(); await f.page.onRefresh(); await f.page.onSave();
  assert.equal(f.page.data.uncertain, true); assert.equal(f.writes().length, 1); assert.equal(f.page.data.draft.threshold, '40');
  f.confirmResult = false; await f.page.onDiscard(); assert.equal(f.page.data.draft.threshold, '40');
  f.confirmResult = true; await f.page.onDiscard(); assert.equal(f.page.data.uncertain, false); assert.equal(f.page.data.draft.threshold, '30');
});

test('reverting to the old baseline after an ambiguous save is retained when that save is confirmed', async () => {
  const f = fixture('reading-settings'), base = f.reply; await f.page.onShow();
  f.page.onThreshold(event('', '40'));
  f.reply = (url, options) => { if (options.method === 'PUT') { base(url, options); throw failure('保存结果未知', { ambiguous: true }); } return base(url, options); };
  await f.page.onSave(); f.page.onThreshold(event('', '30')); await f.page.onRefresh();
  assert.equal(f.page.data.dirty, true); assert.equal(f.page.data.uncertain, false);
  assert.equal(f.page.data.draft.threshold, '30'); assert.equal(f.page.data.config.threshold, 40);
});

test('late reading response after hide never changes saved truth or unsaved draft', async () => {
  const f = fixture('reading-settings'); await f.page.onShow(); f.page.onThreshold(event('', '42'));
  const pending = deferred(); f.reply = () => pending.promise;
  const refresh = f.page.onRefresh(); f.page.onHide(); const newer = readingProfile(); newer.config.threshold = 75; pending.resolve(newer); await refresh;
  assert.equal(f.page.data.config.threshold, 30); assert.equal(f.page.data.draft.threshold, '42'); assert.equal(f.page.data.conflict, false);
});

test('hiding reading during preflight prevents PUT, and another user cannot operate the old page', async () => {
  const f = fixture('reading-settings'); const base = f.reply; await f.page.onShow(); f.page.onThreshold(event('', '43'));
  const pending = deferred(); f.reply = (url, options) => options.method === 'GET' ? pending.promise : base(url, options);
  const save = f.page.onSave(); await flush(); f.page.onHide(); pending.resolve(readingProfile()); await save;
  assert.equal(f.writes().length, 0); assert.equal(f.page.data.draft.threshold, '43');
  f.setUser({ ...admin(), id: 'other' }); await f.page.onShow(); await f.page.onSave();
  assert.equal(f.writes().length, 0); assert.equal(f.navigation.at(-1), '/pages/workbench/index');
});

test('reading report offers role-gated settings navigation without adding settings API reads', async () => {
  const f = fixture('reading'); await f.page.onShow(); f.page.openSettings(); assert.equal(f.navigation.length, 0); assert.equal(f.page.data.canManageReading, false);
  f.user.role = 'principal'; f.user.permissions.schoolAdmin = true; await f.page.onShow(); f.page.openSettings();
  assert.equal(f.navigation.at(-1), '/pages/reading-settings/index'); assert.equal(f.page.data.canManageReading, true);
  assert.ok(f.calls.every(call => call.url !== '/api/reading/settings')); assert.equal(f.writes().length, 0);
});

test('reading settings pull refresh stops its native spinner on success and expired sessions', async () => {
  const f = fixture('reading-settings'); await f.page.onShow(); await f.page.onPullDownRefresh(); assert.equal(f.stopped, 1);
  f.setUser(null); await f.page.onPullDownRefresh(); assert.equal(f.stopped, 2); assert.equal(f.page.data.sessionExpired, true);
  assert.equal(f.navigation.length, 0);
  f.page.relogin();
  assert.equal(f.navigation.at(-1), '/pages/login/index');
});

test('affected native templates use raw operators, named controls, native components and pull refresh', () => {
  for (const name of ['reading', 'reading-settings']) {
    const template = fs.readFileSync(path.join(root, 'pages', name, 'index.wxml'), 'utf8');
    for (const expression of template.match(/\{\{[\s\S]*?\}\}/g) || []) assert.doesNotMatch(expression, /&(?:amp|lt|gt|quot|apos|#\d+);/, name);
    for (const tag of template.match(/<(?:input|picker|checkbox|checkbox-group|switch)\b[^>]*>/g) || []) assert.match(tag, /aria-label=/, name + ': unnamed control');
    assert.doesNotMatch(template, /<web-view\b|<canvas\b|<script\b/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'pages', name, 'index.json'), 'utf8')).enablePullDownRefresh, true);
  }
});

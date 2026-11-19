'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const study = require('../miniprogram/teacher/lib/study-settings');
const reading = require('../miniprogram/teacher/lib/reading-settings');
const classroom = require('../miniprogram/teacher/lib/classroom-data');
const reports = require('../miniprogram/teacher/lib/report-data');
const root = path.resolve(__dirname, '../miniprogram/teacher');
const copy = value => JSON.parse(JSON.stringify(value));
const now = Date.parse('2026-11-19T11:00:00Z');
const flush = () => new Promise(setImmediate);
const failure = (message, fields = {}) => Object.assign(Error(message), fields);
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const event = (field, value, key) => ({ currentTarget: { dataset: { field, key } }, detail: { value } });
const admin = () => ({ id: 'teacher', role: 'principal', permissions: { schoolAdmin: true } });
function studyProfile(classId = 'a', revision = 0) {
  return { classId, revision, serverTime: now, config: study.configFrom({ enabled: true, authorized: true, aiEnabled: true }),
    schedule: [{ key: 'lesson-' + classId, title: '第二节晚自习', startAt: now - 60000, endAt: now + 3600000, temporary: false }],
    usage: { calls: 0, tokens: 0, estimated: 0, last_call_at: 0 }, inPeriod: true, aiReady: true,
    status: { state: 'listening', detail: '', updated_at: now, name: '教室电脑' } };
}
function readingProfile() {
  return { config: { enabled: true, reminderEnabled: true, threshold: 30, periods: [{ weekdays: [1, 2, 3, 4, 5], start: 440, end: 470 }],
    classic: { duration: 25, targetCount: 12 }, rocket: { duration: 15, targetCount: 10 }, carving: { speed: 0.7 }, particle: { speed: 1 } },
  serverTime: now, inPeriod: false };
}

// Actual page + feature helpers + shared UI, with only API transport and WeChat
// calls simulated. No network, device action, real file sharing, or polling.
function fixture(name = 'study') {
  const f = { user: name === 'reading-settings' ? admin() : { id: 'teacher', role: 'teacher', permissions: {} },
    selected: 'a', calls: [], confirmations: [], navigation: [], downloads: [], timers: [], stopped: 0, confirmResult: true, dirty: false,
    study: { a: studyProfile('a', 0), b: studyProfile('b', 4) }, reading: readingProfile() };
  let epoch = 0;
  f.setUser = user => { f.user = user; ++epoch; };
  f.reply = (url, options) => {
    const method = options.method || 'GET';
    if (url === '/api/self-study/classes' || url === '/api/classes') return { classes: [{ id: 'a', name: '一班', enabled: 1 }, { id: 'b', name: '二班', enabled: 1 }] };
    if (url.startsWith('/api/self-study/classes/')) {
      const id = decodeURIComponent(url.split('/').at(-1));
      if (method === 'PUT') {
        if (options.data.revision !== f.study[id].revision) throw failure('设置已被其他人修改，请重新载入后再保存。', { status: 409 });
        f.study[id] = { ...f.study[id], revision: f.study[id].revision + 1, config: copy(options.data.config) };
      }
      return f.study[id];
    }
    if (url.startsWith('/api/self-study/events?')) {
      const id = new URL(url, 'https://simulation.invalid').searchParams.get('classId');
      return { events: [{ id: 'event-' + id, class_id: id, status: 'reported', reported_at: now, started_at: now, handled_at: null, photo_status: 'ready', photo_at: now }], pending: 1, serverTime: now };
    }
    if (url.endsWith('/review') && method === 'POST') return { ok: true };
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
    },
    async download(url) { f.downloads.push(url); return f.downloadReply ? f.downloadReply(url) : 'wxfile://simulated-private-photo.jpg'; }
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
  const imports = { '../../lib/api': api, '../../lib/ui': ui, '../../lib/study-settings': study,
    '../../lib/reading-settings': reading, '../../lib/classroom-data': classroom, '../../lib/report-data': reports };
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

test('self-study payload retains revision zero, all real rules and millisecond precision', () => {
  const profile = studyProfile();
  const draft = study.draftFrom(profile.config);
  draft.voiceTriggerSeconds = '0.301'; draft.dailyCalls = '0';
  const result = study.payload(profile, draft);
  assert.equal(result.revision, 0); assert.equal(result.config.voiceTriggerMs, 301); assert.equal(result.config.dailyCalls, 0);
  assert.deepEqual(Object.keys(result.config), Object.keys(study.configFrom({})));
  assert.equal(result.config.voiceTriggerSeconds, undefined);
  for (const revision of [undefined, null, '0', -1, 0.5]) assert.throws(() => study.payload({ revision }, draft), /版本/);
});

test('blank and out-of-range rule fields never silently become zero or defaults', () => {
  const draft = study.draftFrom(studyProfile().config);
  for (const [field, values] of Object.entries({ dailyCalls: ['', '-1', '5', '1.5'], dailyTokens: ['', '1499', '2401'],
    voiceTriggerSeconds: ['', '0.299', '3.001', '0.3001'], observationSeconds: ['', '9', '31'],
    reminderWaitSeconds: ['', '89', '301'], confirmationsAfterReminder: ['', '0', '4'] })) {
    for (const value of values) assert.throws(() => study.draftConfig({ ...draft, [field]: value }), field + '=' + value);
  }
  assert.throws(() => study.draftConfig({ ...draft, sensitivity: 'invented' }), /灵敏度/);
  assert.throws(() => study.draftConfig({ ...draft, enabled: true, authorized: false }), /授权/);
  assert.equal(study.dirty({ ...draft, dailyCalls: '' }, studyProfile().config), true);
});

test('runtime uses saved rules, freshness, real AI pause meaning and next effective period', () => {
  const profile = studyProfile();
  assert.equal(study.runtime(profile).stateText, '正在感知教室声音');
  assert.equal(study.runtime(profile, now + 90000).stateText, '等待教室端同步');
  profile.status.state = 'ai_paused';
  assert.match(study.runtime(profile).runtimeNote, /本地声波继续显示/);
  profile.status.state = 'budget'; assert.match(study.runtime(profile).runtimeNote, /提醒与上报暂停/);
  profile.config.enabled = false; assert.equal(study.runtime(profile).stateText, '尚未启用');
  assert.equal(study.runtime(profile).nextPeriod.key, 'lesson-a');
  assert.equal(study.runtime(profile, now + 3600000).nextPeriod, null);
  assert.match(study.budgetNote({ dailyCalls: '0', confirmationsAfterReminder: '3' }), /至少需要 4 次/);
});

test('self-study profile rejects mismatched classes, malformed schedules and missing revision', () => {
  const profile = studyProfile();
  assert.throws(() => study.profileFrom(profile, 'b'), /版本/);
  assert.throws(() => study.profileFrom({ ...profile, revision: undefined }, 'a'), /版本/);
  assert.throws(() => study.profileFrom({ ...profile, schedule: [{ ...profile.schedule[0], endAt: now - 60000 }] }, 'a'), /安排/);
  assert.deepEqual(study.profileFrom(profile, 'a'), profile);
});

test('viewing study performs GETs only, has no canEdit field dependency and never fetches a photo', async () => {
  const f = fixture(); await f.page.onShow();
  assert.equal(f.calls[0].url, '/api/self-study/classes'); assert.equal(f.writes().length, 0);
  assert.equal(f.page.data.canEdit, true); assert.equal(f.page.data.revision, 0);
  assert.equal(f.page.data.usage.calls, 0); assert.equal(f.page.data.usage.tokens, 0);
  assert.equal(f.downloads.length, 0); assert.equal(f.timers.length, 0);
  f.page.onOption(event('enabled', false));
  assert.equal(f.page.data.draft.enabled, false); assert.equal(f.page.data.config.enabled, true);
  assert.equal(f.page.data.stateText, '正在感知教室声音'); assert.equal(f.writes().length, 0);
  f.page.openTimetable(); assert.equal(f.navigation.at(-1), '/pages/island/index'); assert.equal(f.api.getClassId(), 'a');
});

test('study save locks confirmation and class controls, writes original revision once and reports success', async () => {
  const f = fixture(); await f.page.onShow(); f.page.onRuleInput(event('voiceTriggerSeconds', '0.75'));
  const confirmation = deferred(); f.confirmResult = () => confirmation.promise;
  const save = f.page.onSave(); await f.page.onSave(); await f.page.onClassChange({ detail: { value: 1 } });
  f.page.onRuleInput(event('voiceTriggerSeconds', '2'));
  assert.equal(f.writes().length, 0); assert.equal(f.page.data.busy, true); assert.equal(f.page.data.classId, 'a');
  assert.equal(f.page.data.draft.voiceTriggerSeconds, '0.75');
  confirmation.resolve(true); await save;
  assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].data.revision, 0); assert.equal(f.writes()[0].data.config.voiceTriggerMs, 750);
  assert.equal(f.page.data.savedRevision, 1); assert.equal(f.page.data.dirty, false); assert.equal(f.page.data.busy, false);
  assert.match(f.confirmations[0].content, /一班/); assert.match(f.confirmations[0].content, /今日用量和历史记录保留/);
});

test('study cancelled confirmation keeps draft and does not write', async () => {
  const f = fixture(); await f.page.onShow(); f.page.onRuleInput(event('dailyCalls', '0'));
  f.confirmResult = false; await f.page.onSave();
  assert.equal(f.writes().length, 0); assert.equal(f.page.data.dirty, true); assert.equal(f.page.data.draft.dailyCalls, '0');
});

test('study invalid blank input is reported before confirmation or write', async () => {
  const f = fixture(); await f.page.onShow(); f.page.onRuleInput(event('dailyCalls', '')); await f.page.onSave();
  assert.match(f.page.data.error, /不能留空/); assert.equal(f.confirmations.length, 0); assert.equal(f.writes().length, 0);
});

test('study keeps each class draft and baseline while refreshed runtime detects newer revisions', async () => {
  const f = fixture(); await f.page.onShow(); f.page.onRuleInput(event('observationSeconds', '12'));
  await f.page.onClassChange({ detail: { value: 1 } }); f.page.onRuleInput(event('observationSeconds', '16'));
  await f.page.onClassChange({ detail: { value: 0 } });
  assert.equal(f.page.data.draft.observationSeconds, '12'); assert.equal(f.page.data.revision, 0);
  f.study.a.revision = 2; f.study.a.status.state = 'warning'; await f.page.onRefresh();
  assert.equal(f.page.data.savedRevision, 2); assert.equal(f.page.data.revision, 0); assert.equal(f.page.data.conflict, true);
  assert.equal(f.page.data.draft.observationSeconds, '12'); assert.equal(f.page.data.stateText, '已提醒安静');
  await f.page.onSave(); assert.equal(f.writes().length, 0);
  await f.page.onDiscard(); assert.equal(f.page.data.revision, 2); assert.equal(f.page.data.dirty, false);
  await f.page.onClassChange({ detail: { value: 1 } }); assert.equal(f.page.data.draft.observationSeconds, '16');
});

test('study 409 preserves original error, draft and version and blocks a blind second save', async () => {
  const f = fixture(); await f.page.onShow(); f.page.onRuleInput(event('observationSeconds', '14')); f.study.a.revision = 1;
  await f.page.onSave(); await f.page.onSave();
  assert.equal(f.writes().length, 1); assert.equal(f.page.data.revision, 0); assert.equal(f.page.data.conflict, true);
  assert.equal(f.page.data.draft.observationSeconds, '14'); assert.equal(f.page.data.error, '设置已被其他人修改，请重新载入后再保存。');
});

test('study 401 preserves draft through same-account relogin and exposes recovery', async () => {
  const f = fixture(); const base = f.reply; await f.page.onShow(); f.page.onRuleInput(event('observationSeconds', '18'));
  f.reply = (url, options) => { if (options.method === 'PUT') throw failure('会话已失效，请重新登录', { status: 401 }); return base(url, options); };
  await f.page.onSave(); assert.equal(f.page.data.sessionExpired, true); f.page.relogin(); assert.equal(f.navigation.at(-1), '/pages/login/index');
  f.page.onHide(); f.setUser({ id: 'teacher', role: 'teacher', permissions: {} }); f.reply = base; await f.page.onShow();
  assert.equal(f.page.data.draft.observationSeconds, '18'); assert.equal(f.page.data.dirty, true); assert.equal(f.dirty, true);
});

test('study retains actual sibling 401 when the other read becomes session_changed', async () => {
  const f = fixture(); const base = f.reply, config = deferred(), records = deferred();
  f.reply = (url, options) => url === '/api/self-study/classes/a' ? config.promise : url.startsWith('/api/self-study/events?') ? records.promise : base(url, options);
  const show = f.page.onShow(); await flush(); records.reject(failure('登录已过期，记录不可读', { status: 401 })); await flush();
  config.resolve(studyProfile()); await show;
  assert.equal(f.api.getUser(), null); assert.equal(f.page.data.sessionExpired, true); assert.equal(f.page.data.error, '登录已过期，记录不可读');
});

test('study 403 preserves the school message and draft and disables writes', async () => {
  const f = fixture(); const base = f.reply; await f.page.onShow(); f.page.onRuleInput(event('observationSeconds', '20'));
  f.reply = (url, options) => { if (options.method === 'PUT') throw failure('只能查看本人带班或管理范围内的班级。', { status: 403 }); return base(url, options); };
  await f.page.onSave(); await f.page.onSave();
  assert.equal(f.page.data.error, '只能查看本人带班或管理范围内的班级。'); assert.equal(f.page.data.canEdit, false);
  assert.equal(f.page.data.draft.observationSeconds, '20'); assert.equal(f.writes().length, 1);
});

test('study handlers reject subject teachers even if an old profile is still visible', async () => {
  const f = fixture(); await f.page.onShow(); f.page.onRuleInput(event('dailyCalls', '2'));
  f.user.role = 'subject_teacher'; f.page.onRuleInput(event('dailyCalls', '3')); await f.page.onSave();
  assert.equal(f.page.data.draft.dailyCalls, '2'); assert.equal(f.writes().length, 0);
});

test('study rechecks permission after confirmation and does not PUT for a newly revoked role', async () => {
  const f = fixture(); await f.page.onShow(); f.page.onRuleInput(event('dailyCalls', '2'));
  f.confirmResult = () => { f.user.role = 'subject_teacher'; return true; };
  await f.page.onSave(); assert.equal(f.writes().length, 0); assert.equal(f.page.data.canEdit, false);
  assert.equal(f.page.data.draft.dailyCalls, '2'); assert.match(f.page.data.error, /任课权限/);
});

test('study ambiguous saved configuration is reconciled without losing edits made after timeout', async () => {
  const f = fixture(); const base = f.reply; await f.page.onShow(); f.page.onRuleInput(event('observationSeconds', '14'));
  f.reply = (url, options) => { if (options.method === 'PUT') { base(url, options); throw failure('结果未知，请刷新核对', { ambiguous: true }); } return base(url, options); };
  await f.page.onSave(); assert.equal(f.page.data.uncertain, true); await f.page.onSave(); assert.equal(f.writes().length, 1);
  f.page.onRuleInput(event('observationSeconds', '22')); await f.page.onRefresh();
  assert.equal(f.page.data.revision, 1); assert.equal(f.page.data.draft.observationSeconds, '22');
  assert.equal(f.page.data.dirty, true); assert.equal(f.page.data.uncertain, false); assert.equal(f.page.data.conflict, false);
});

test('study malformed successful write response requires refresh rather than duplicate submission', async () => {
  const f = fixture(); const base = f.reply; await f.page.onShow(); f.page.onRuleInput(event('dailyCalls', '1'));
  f.reply = (url, options) => options.method === 'PUT' ? { ok: true } : base(url, options);
  await f.page.onSave(); await f.page.onSave(); assert.equal(f.writes().length, 1);
  assert.equal(f.page.data.dirty, true); assert.equal(f.page.data.uncertain, true); assert.match(f.page.data.error, /无法核对/);
});

test('late study read after hiding cannot overwrite the next class, its draft or selected ID', async () => {
  const f = fixture(); const base = f.reply; await f.page.onShow(); f.page.onRuleInput(event('dailyCalls', '2'));
  const late = deferred(); let first = true;
  f.reply = (url, options) => { if (url === '/api/self-study/classes/a' && first) { first = false; return late.promise; } return base(url, options); };
  const refresh = f.page.onRefresh(); await flush(); f.page.onHide(); f.page.data.classId = 'b'; f.api.selectClass('b'); await f.page.onShow();
  late.resolve(studyProfile('a', 8)); await refresh;
  assert.equal(f.page.data.classId, 'b'); assert.equal(f.page.data.loadedClassId, 'b'); assert.equal(f.page.data.revision, 4);
  assert.equal(f.page._drafts.a.draft.dailyCalls, '2');
});

test('hiding study during save confirmation cancels the write; returning while busy reloads safely', async () => {
  const f = fixture(); await f.page.onShow(); f.page.onRuleInput(event('dailyCalls', '2'));
  const confirmation = deferred(); f.confirmResult = () => confirmation.promise;
  const save = f.page.onSave(); f.page.onHide(); await f.page.onShow(); confirmation.resolve(true); await save;
  assert.equal(f.writes().length, 0); assert.equal(f.page.data.busy, false); assert.equal(f.page.data.draft.dailyCalls, '2'); assert.equal(f.page.data.loading, false);
});

test('manual photo download and review confirmation remain explicit, bounded and generation guarded', async () => {
  const f = fixture(); await f.page.onShow();
  await f.page.onPhoto({ currentTarget: { dataset: { id: 'event-a' } } });
  assert.equal(f.downloads[0], '/api/self-study/events/event-a/photo'); assert.equal(f.timers.length, 1);
  assert.ok(f.timers[0].delay > 0 && f.timers[0].delay <= classroom.PHOTO_TTL); f.page.onHide(); assert.equal(f.page.data.photoPath, '');
  await f.page.onShow(); const review = { currentTarget: { dataset: { id: 'event-a', resolution: 'false_alarm' } } };
  f.confirmResult = false; await f.page.onReview(review); assert.equal(f.writes().length, 0);
  f.confirmResult = true; await f.page.onReview(review); assert.equal(f.writes().length, 1);
  assert.deepEqual(f.writes()[0].data, { resolution: 'false_alarm' });
});

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
  for (const name of ['study', 'reading-settings']) {
    const f = fixture(name), base = f.reply; await f.page.onShow();
    const edit = value => name === 'study' ? f.page.onRuleInput(event('observationSeconds', value)) : f.page.onThreshold(event('', value));
    edit(name === 'study' ? '14' : '40');
    f.reply = (url, options) => { if (options.method === 'PUT') { base(url, options); throw failure('保存结果未知', { ambiguous: true }); } return base(url, options); };
    await f.page.onSave(); edit(name === 'study' ? '10' : '30'); await f.page.onRefresh();
    assert.equal(f.page.data.dirty, true); assert.equal(f.page.data.uncertain, false);
    assert.equal(name === 'study' ? f.page.data.draft.observationSeconds : f.page.data.draft.threshold, name === 'study' ? '10' : '30');
    assert.equal(name === 'study' ? f.page.data.config.observationSeconds : f.page.data.config.threshold, name === 'study' ? 14 : 40);
  }
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

test('pull refresh stops its native spinner on success and expired sessions for both settings pages', async () => {
  for (const name of ['study', 'reading-settings']) {
    const f = fixture(name); await f.page.onShow(); await f.page.onPullDownRefresh(); assert.equal(f.stopped, 1);
    f.setUser(null); await f.page.onPullDownRefresh(); assert.equal(f.stopped, 2); assert.equal(f.page.data.sessionExpired, true);
    assert.equal(f.navigation.at(-1), '/pages/login/index');
  }
});

test('affected native templates use raw operators, named controls, native components and pull refresh', () => {
  for (const name of ['study', 'reading', 'reading-settings']) {
    const template = fs.readFileSync(path.join(root, 'pages', name, 'index.wxml'), 'utf8');
    for (const expression of template.match(/\{\{[\s\S]*?\}\}/g) || []) assert.doesNotMatch(expression, /&(?:amp|lt|gt|quot|apos|#\d+);/, name);
    for (const tag of template.match(/<(?:input|picker|checkbox|checkbox-group|switch)\b[^>]*>/g) || []) assert.match(tag, /aria-label=/, name + ': unnamed control');
    assert.doesNotMatch(template, /<web-view\b|<canvas\b|<script\b/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'pages', name, 'index.json'), 'utf8')).enablePullDownRefresh, true);
  }
});

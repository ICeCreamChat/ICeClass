'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const data = require('../miniprogram/teacher/lib/classroom-data');
const studySettings = require('../miniprogram/teacher/lib/study-settings');

const copy = value => JSON.parse(JSON.stringify(value));
const now = Date.parse('2026-11-19T11:00:00Z');
function profile(classId = 'a', revision = 7) {
  return { classId, revision, canEdit: true, updatedAt: now, devices: [], config: {
    schemaVersion: 1, enabled: true, weekAnchor: '2026-09-07',
    slots: [{ id: 'p1', label: '第一节', start: 480, end: 525 }],
    lessons: [{ slotId: 'p1', weekday: 1, week: 'all', subject: '语文', teacher: '原教师', location: '教室', future: { flag: true } }],
    dutyRotations: {}, overrides: [{ date: '2026-11-20', slotId: 'p1', subject: '调课' }],
    appearance: { material: 'glass', future: 3 }, automation: [{ futureAction: 9 }],
    futureRoot: { nested: [0, false, '未知字段'] }
  } };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(name) {
  let definition;
  const calls = [], confirmations = [], previews = [], downloads = [];
  let user = { id: 't1', role: 'teacher', permissions: {} }, selected = 'a';
  const f = { calls, confirmations, previews, downloads, confirmResult: true, dirty: false };
  const api = {
    getUser: () => user, getClassId: () => selected, selectClass: id => { selected = id; },
    request: async (url, options = {}) => {
      calls.push({ url, ...options });
      try { return await f.reply(url, options); }
      catch (error) { if (error.status === 401) user = null; throw error; }
    },
    download: async url => { downloads.push(url); return f.downloadReply ? f.downloadReply(url) : 'wxfile://private-photo.jpg'; }
  };
  const ui = {
    requireLogin: () => Boolean(user), relogin: () => { f.relogin = true; },
    chooseClass(page, index) { const item = page.data.classes[Number(index)]; if (!item) return null; selected = item.id; page.setData({ classIndex: Number(index), classId: item.id }); return item; },
    fail(page, error) { if (error.code !== 'session_changed') page.setData({ error: error.message, sessionExpired: error.status === 401 }); },
    query: obj => Object.keys(obj).map(key => `${key}=${encodeURIComponent(obj[key])}`).join('&'),
    confirm: async (...args) => { confirmations.push(args); return typeof f.confirmResult === 'function' ? f.confirmResult(...args) : f.confirmResult; },
    formatTime: value => value == null ? '-' : String(value), dateISO: () => '2026-11-19',
    toast: message => { f.toast = message; }, setDirty: value => { f.dirty = value; }
  };
  const filename = path.resolve(__dirname, `../miniprogram/teacher/pages/${name}/index.js`);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: value => { definition = value; },
    require: id => id.endsWith('/api') ? api : id.endsWith('/ui') ? ui : id.endsWith('/classroom-data') ? data : id.endsWith('/study-settings') ? studySettings : (() => { throw Error('Unexpected import: ' + id); })(),
    wx: { stopPullDownRefresh() {}, previewImage(options) { previews.push(options); if (options.success) options.success({}); } },
    setInterval() { throw Error('Unconditional polling is forbidden'); },
    setTimeout(callback, delay) { f.photoExpiry = { callback, delay }; return 1; }, clearTimeout() {},
    console
  }, { filename });
  const page = { ...definition, data: copy(definition.data), setData(values) { Object.assign(this.data, copy(values)); } };
  page.onLoad();
  f.page = page; f.api = api; f.setUser = value => { user = value; };
  f.reply = url => {
    if (url === '/api/classes' || url === '/api/self-study/classes') return { classes: [{ id: 'a', name: '高一1班', enabled: 1 }, { id: 'b', name: '高一2班', enabled: 1 }] };
    if (url.startsWith('/api/island/classes/')) return profile(url.split('/').at(-1));
    if (url.startsWith('/api/self-study/classes/')) return { classId: url.split('/').at(-1), revision: 2, config: studySettings.configFrom({ enabled: true, authorized: true, aiEnabled: true }), schedule: [], usage: { calls: 0, tokens: 0, estimated: 0, last_call_at: 0 }, serverTime: now, inPeriod: false, aiReady: true, status: null };
    if (url.startsWith('/api/self-study/events?')) return { events: [{ id: 'e1', class_id: 'a', status: 'reported', reported_at: now, handled_at: null, photo_status: 'ready', photo_at: now, started_at: now }], pending: 1, serverTime: now };
    if (url === '/api/quiet-hours') return { timezone: 'Asia/Shanghai', serverTime: now, activePeriod: null, periods: [{ id: '11111111-1111-1111-1111-111111111111', name: '上课', weekdays: [1, 2], startTime: '08:00', endTime: '09:00' }] };
    throw Error('Unexpected endpoint: ' + url);
  };
  return f;
}
const input = (key, value, field = 'subject') => ({ currentTarget: { dataset: { key, field } }, detail: { value } });

test('editing a lesson preserves unknown root, nested, lesson and sibling configuration', () => {
  const original = profile();
  const row = data.lessonRows(original.config, 1)[0];
  const draft = data.patchLesson(original.config, row, 'teacher', '新教师');
  const payload = data.configPayload(original, draft);
  assert.equal(payload.revision, 7);
  const expected = copy(original.config); expected.lessons[0].teacher = '新教师';
  assert.deepEqual(payload.config, expected);
  assert.equal(original.config.lessons[0].teacher, '原教师');
  payload.config.futureRoot.nested.push('mutated');
  assert.equal(draft.futureRoot.nested.length, 3);
});

test('revision zero is retained; missing, negative and fractional revisions are rejected', () => {
  assert.equal(data.configPayload(profile('a', 0), profile().config).revision, 0);
  for (const revision of [undefined, -1, 1.2, '7']) assert.throws(() => data.configPayload({ revision }, profile().config), /版本/);
});

test('odd and even lessons remain separate and empty counterparts can be filled', () => {
  const config = profile().config; config.lessons[0].week = 'odd';
  const rows = data.lessonRows(config, 1);
  assert.deepEqual(rows.map(row => row.week), ['odd', 'even']);
  const updated = data.patchLesson(config, rows[1], 'subject', '数学');
  assert.equal(updated.lessons[0].week, 'odd');
  assert.equal(updated.lessons[1].week, 'even');
  assert.equal(updated.lessons[1].subject, '数学');
  assert.throws(() => data.patchLesson(config, rows[0], 'location', '不允许的字段'), /字段/);
});

test('enabled rotation slots expose cycle lessons without inserting conflicting weekly lessons', () => {
  const config = profile().config; config.lessons = [];
  config.dutyRotations.evening = { enabled: true, cycleWeeks: 2, slotIds: ['p1'], future: 'keep', lessons: [{ slotId: 'p1', weekday: 1, cycleWeek: 2, subject: '晚自习', teacher: '王老师', location: '本班', future: 8 }] };
  const rows = data.lessonRows(config, 1);
  assert.equal(rows.length, 2);
  const draft = data.patchLesson(config, rows[1], 'teacher', '李老师');
  assert.equal(draft.lessons.length, 0);
  assert.equal(draft.dutyRotations.evening.lessons[0].teacher, '李老师');
  assert.equal(draft.dutyRotations.evening.lessons[0].future, 8);
  assert.equal(draft.dutyRotations.evening.future, 'keep');
});

test('empty required subjects and control characters are rejected before saving', () => {
  const p = profile(); p.config.lessons[0].subject = ' ';
  assert.throws(() => data.configPayload(p, p.config), /科目/);
  p.config.lessons[0].subject = '数学'; p.config.lessons[0].teacher = '教师\n姓名';
  assert.throws(() => data.configPayload(p, p.config), /教师/);
});

test('event mapping distinguishes automatic resolution, manual handling and false alarms', () => {
  assert.equal(data.studyEvent({ status: 'warning', handled_at: null }, now).statusText, '已提醒');
  assert.equal(data.studyEvent({ status: 'reported', handled_at: null }, now).needsReview, true);
  const automatic = data.studyEvent({ status: 'resolved', handled_at: null, resolution: 'not_chat' }, now);
  assert.equal(automatic.statusText, '已结束'); assert.equal(automatic.needsReview, false);
  assert.equal(data.studyEvent({ status: 'resolved', handled_at: 0, resolution: 'handled' }, now).statusText, '人工处理完成');
  assert.equal(data.studyEvent({ status: 'resolved', handled_at: now, resolution: 'false_alarm' }, now).statusText, '已确认误报');
  assert.match(data.studyEvent({ status: 'new_future_state', handled_at: null }, now).statusText, /未知/);
});

test('photos require ready metadata and a server-clock lifetime under 24 hours', () => {
  const event = { photo_status: 'ready', photo_at: now - 86400000 };
  assert.equal(data.studyEvent(event, now).canViewPhoto, false);
  event.photo_at += 1;
  assert.equal(data.studyEvent(event, now).canViewPhoto, true);
  event.photo_status = 'capturing';
  assert.equal(data.studyEvent(event, now).canViewPhoto, false);
});

test('quiet validation matches service weekdays, clock limits, name length and 24:00 ending', () => {
  const periods = [{ id: 'keep-id', name: ' 晚自习 ', weekdays: [7, 1, 1], startTime: '19:00', endTime: '24:00', future: { keep: true } }];
  const result = data.quietPayload(periods);
  assert.deepEqual(result.periods[0].weekdays, [1, 7]);
  assert.equal(result.periods[0].name, '晚自习');
  assert.deepEqual(result.periods[0].future, { keep: true });
  assert.equal(periods[0].name, ' 晚自习 ');
  for (const patch of [{ weekdays: [] }, { weekdays: [true] }, { startTime: '24:00' }, { endTime: '18:00' }, { name: '长'.repeat(41) }, { startTime: '19:99' }]) {
    assert.throws(() => data.quietPayload([{ ...periods[0], ...patch }]));
  }
  assert.throws(() => data.quietPayload(Array(101).fill(periods[0])), /100/);
});

test('quiet signatures compare fields independent of property and weekday ordering', () => {
  const one = [{ id: 'a', name: '上课', weekdays: [2, 1], startTime: '08:00', endTime: '09:00' }];
  const two = [{ endTime: '09:00', startTime: '08:00', weekdays: [1, 2], name: '上课', id: 'a' }];
  assert.equal(data.quietSignature(one), data.quietSignature(two));
  two[0].endTime = '10:00'; assert.notEqual(data.quietSignature(one), data.quietSignature(two));
  assert.match(data.quietImpact(one), /全校/); assert.match(data.quietImpact(one), /08:00-09:00/);
  assert.match(data.quietImpact([]), /清空/);
});

test('island writes full config with the original revision and blocks duplicate taps', async () => {
  const f = fixture('island'); await f.page.onShow();
  f.page.onLessonInput(input(f.page.data.rows[0].key, '新教师', 'teacher'));
  const pending = deferred(); const base = f.reply;
  f.reply = (url, options) => options.method === 'PUT' ? pending.promise : base(url, options);
  const save = f.page.onSave(); await f.page.onSave();
  const writes = f.calls.filter(call => call.method === 'PUT');
  assert.equal(writes.length, 1); assert.equal(writes[0].data.revision, 7);
  assert.deepEqual(writes[0].data.config.futureRoot, profile().config.futureRoot);
  pending.resolve({ ...profile(), revision: 8, config: writes[0].data.config }); await save;
  assert.equal(f.page.data.revision, 8); assert.equal(f.page.data.dirty, false);
});

test('island 409 preserves draft and blocks blind resubmission', async () => {
  const f = fixture('island'); await f.page.onShow();
  f.page.onLessonInput(input(f.page.data.rows[0].key, '草稿语文'));
  f.reply = () => { throw Object.assign(Error('其他老师已更新配置，请重新载入后再保存。'), { status: 409 }); };
  await f.page.onSave(); await f.page.onSave();
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(f.page.data.rows[0].subject, '草稿语文'); assert.equal(f.page.data.conflict, true);
  assert.match(f.page.data.error, /其他老师/);
});

test('island 401 keeps draft through same-account relogin and exposes login recovery', async () => {
  const f = fixture('island'); const base = f.reply; await f.page.onShow();
  f.page.onLessonInput(input(f.page.data.rows[0].key, '待保存'));
  f.reply = (url, options) => { if (options.method === 'PUT') throw Object.assign(Error('会话已失效'), { status: 401 }); return base(url, options); };
  await f.page.onSave(); assert.equal(f.page.data.sessionExpired, true);
  f.page.relogin(); assert.equal(f.relogin, true);
  f.setUser({ id: 't1', role: 'teacher', permissions: {} });
  f.page.onHide(); await f.page.onShow();
  assert.equal(f.page.data.rows[0].subject, '待保存'); assert.equal(f.page.data.dirty, true);
});

test('late island responses after hide cannot overwrite the next visible class', async () => {
  const f = fixture('island'); const base = f.reply; const old = deferred(); let count = 0;
  f.reply = (url, options) => url === '/api/island/classes/a' && count++ === 0 ? old.promise : base(url, options);
  const first = f.page.onShow(); await new Promise(setImmediate);
  f.page.onHide(); f.api.selectClass('b'); f.page.data.classId = 'b'; await f.page.onShow();
  old.resolve(profile('a')); await first;
  assert.equal(f.page.data.classId, 'b');
  assert.equal(f.page.data.loadedClassId, 'b');
});

test('read-only island permissions block editing and writes at handlers', async () => {
  const f = fixture('island'); const base = f.reply;
  f.reply = (url, options) => url.startsWith('/api/island/classes/') ? { ...profile(), canEdit: false } : base(url, options);
  await f.page.onShow(); f.page.onLessonInput(input(f.page.data.rows[0].key, '禁止')); await f.page.onSave();
  assert.equal(f.page.data.rows[0].subject, '语文'); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
});

test('study uses head-only classes and does not automatically download photos', async () => {
  const f = fixture('study'); await f.page.onShow();
  assert.equal(f.calls[0].url, '/api/self-study/classes'); assert.equal(f.downloads.length, 0);
  assert.equal(f.page.data.pending, 1);
  await f.page.onPhoto({ currentTarget: { dataset: { id: 'e1' } } });
  assert.deepEqual(f.downloads, ['/api/self-study/events/e1/photo']);
  assert.equal(f.page.data.photoPath, 'wxfile://private-photo.jpg');
  assert.ok(f.photoExpiry.delay > 0 && f.photoExpiry.delay <= 86400000);
  f.page.onHide(); assert.equal(f.page.data.photoPath, '');
});

test('study reviews require explicit confirmation and post the real resolution once', async () => {
  const f = fixture('study'); await f.page.onShow(); const base = f.reply;
  f.reply = (url, options) => options.method === 'POST' ? { ok: true } : base(url, options);
  const event = { currentTarget: { dataset: { id: 'e1', resolution: 'false_alarm' } } };
  f.confirmResult = false; await f.page.onReview(event);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  f.confirmResult = true; await f.page.onReview(event);
  const writes = f.calls.filter(call => call.method === 'POST'); assert.equal(writes.length, 1);
  assert.equal(writes[0].url, '/api/self-study/events/e1/review'); assert.equal(writes[0].data.resolution, 'false_alarm');
  assert.match(f.confirmations.at(-1)[1], /误报/);
});

test('study 409 keeps server conflict and removes stale review action until refresh', async () => {
  const f = fixture('study'); await f.page.onShow(); const base = f.reply;
  f.reply = (url, options) => { if (options.method === 'POST') throw Object.assign(Error('这条记录已处理或尚未上报，请重新载入。'), { status: 409 }); return base(url, options); };
  const event = { currentTarget: { dataset: { id: 'e1', resolution: 'handled' } } };
  await f.page.onReview(event); await f.page.onReview(event);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1); assert.match(f.page.data.error, /重新载入/);
});

test('study 403 displays the real error without fetching class details', async () => {
  const f = fixture('study'); f.reply = () => { throw Object.assign(Error('只能查看本人带班或管理范围内的班级。'), { status: 403 }); };
  await f.page.onShow(); assert.match(f.page.data.error, /本人带班/); assert.equal(f.calls.length, 1);
});

test('quiet read access never grants edit access without schoolAdmin', async () => {
  const f = fixture('quiet'); await f.page.onShow();
  assert.equal(f.page.data.canEdit, false); f.page.onAdd(); await f.page.onSave();
  assert.equal(f.page.data.periods.length, 1); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
});

async function quietAdmin() {
  const f = fixture('quiet'); f.setUser({ id: 't1', role: 'principal', permissions: { schoolAdmin: true } });
  await f.page.onShow(); return f;
}
test('quiet cancelled confirmation sends no write and retains the edited draft', async () => {
  const f = await quietAdmin(); f.page.onName(input('11111111-1111-1111-1111-111111111111', '草稿时段'));
  f.confirmResult = false; await f.page.onSave();
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(f.page.data.periods[0].name, '草稿时段'); assert.equal(f.page.data.dirty, true);
  assert.match(f.confirmations[0][1], /全校/); assert.match(f.confirmations[0][1], /草稿时段/);
});

test('quiet detects remote changes before replacing the school schedule', async () => {
  const f = await quietAdmin(); f.page.onName(input('11111111-1111-1111-1111-111111111111', '草稿时段'));
  const base = f.reply; f.reply = (url, options) => { const result = base(url, options); result.periods[0].endTime = '10:00'; return result; };
  await f.page.onSave(); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(f.page.data.conflict, true); assert.equal(f.page.data.periods[0].name, '草稿时段');
});

test('quiet slow refresh preserves a draft made before the response', async () => {
  const f = await quietAdmin(); f.page.onName(input('11111111-1111-1111-1111-111111111111', '保留草稿'));
  const request = deferred(); f.reply = () => request.promise;
  const reload = f.page.onRefresh();
  request.resolve({ timezone: 'Asia/Shanghai', periods: [{ id: '11111111-1111-1111-1111-111111111111', name: '远端', weekdays: [1], startTime: '08:00', endTime: '09:00' }], serverTime: now });
  await reload; assert.equal(f.page.data.periods[0].name, '保留草稿'); assert.equal(f.page.data.dirty, true);
});

test('quiet 401 and ambiguous writes retain drafts without automatic retries', async () => {
  for (const error of [Object.assign(Error('请重新登录'), { status: 401 }), Object.assign(Error('结果未知，请先核对'), { ambiguous: true })]) {
    const f = await quietAdmin(); f.page.onName(input('11111111-1111-1111-1111-111111111111', '待保存'));
    const base = f.reply; f.reply = (url, options) => { if (options.method === 'PUT') throw error; return base(url, options); };
    await f.page.onSave(); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
    assert.equal(f.page.data.periods[0].name, '待保存'); assert.equal(f.page.data.dirty, true);
    if (error.status === 401) assert.equal(f.page.data.sessionExpired, true);
    else { await f.page.onSave(); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1); }
  }
});

test('quiet successful save sends full periods without an invented revision and reports success', async () => {
  const f = await quietAdmin();
  f.page.onName(input('11111111-1111-1111-1111-111111111111', '新时段'));
  const base = f.reply;
  f.reply = (url, options) => options.method === 'PUT' ? { ...base(url, {}), periods: copy(options.data.periods) } : base(url, options);
  await f.page.onSave();
  const writes = f.calls.filter(call => call.method === 'PUT');
  assert.equal(writes.length, 1); assert.deepEqual(Object.keys(writes[0].data), ['periods']);
  assert.equal(writes[0].data.periods[0].id, '11111111-1111-1111-1111-111111111111');
  assert.equal(f.page.data.dirty, false); assert.equal(f.page.data.error, ''); assert.match(f.page.data.status, /已保存/);
});

test('island keeps separate class drafts and original revisions across class switches', async () => {
  const f = fixture('island'); await f.page.onShow();
  f.page.onLessonInput(input(f.page.data.rows[0].key, '一班草稿'));
  await f.page.onClassChange({ detail: { value: 1 } });
  assert.equal(f.page.data.loadedClassId, 'b');
  f.page.onLessonInput(input(f.page.data.rows[0].key, '二班草稿'));
  await f.page.onClassChange({ detail: { value: 0 } });
  assert.equal(f.page.data.rows[0].subject, '一班草稿'); assert.equal(f.page.data.revision, 7); assert.equal(f.page.data.dirty, true);
});

test('island refresh detects a newer revision while preserving unsaved fields and sync truth', async () => {
  const f = fixture('island'); await f.page.onShow();
  f.page.onLessonInput(input(f.page.data.rows[0].key, '未保存科目'));
  const base = f.reply;
  f.reply = (url, options) => url.startsWith('/api/island/classes/') ? { ...profile('a', 8), devices: [{ id: 'd', name: '教室', revision: 8, synced_at: now }] } : base(url, options);
  await f.page.onRefresh();
  assert.equal(f.page.data.rows[0].subject, '未保存科目'); assert.equal(f.page.data.revision, 7);
  assert.equal(f.page.data.conflict, true); assert.equal(f.page.data.devices[0].syncText, '已同步'); assert.equal(f.page.data.syncRevision, 8);
});

test('study detail 401 still offers relogin after the shared client clears authentication', async () => {
  const f = fixture('study'); const base = f.reply;
  f.reply = (url, options) => { if (url.startsWith('/api/self-study/classes/')) throw Object.assign(Error('登录已失效'), { status: 401 }); return base(url, options); };
  await f.page.onShow(); assert.equal(f.api.getUser(), null); assert.equal(f.page.data.sessionExpired, true); assert.match(f.page.data.error, /登录已失效/);
});

test('a photo downloaded after hiding the study page cannot be displayed', async () => {
  const f = fixture('study'); await f.page.onShow(); const late = deferred(); f.downloadReply = () => late.promise;
  const viewing = f.page.onPhoto({ currentTarget: { dataset: { id: 'e1' } } });
  f.page.onHide(); late.resolve('wxfile://late-photo.jpg'); await viewing;
  assert.equal(f.page.data.photoPath, ''); assert.equal(f.photoExpiry, undefined);
});

test('a late quiet read after hide never replaces current draft or status', async () => {
  const f = await quietAdmin(); f.page.onName(input('11111111-1111-1111-1111-111111111111', '原草稿'));
  const late = deferred(); const base = f.reply; f.reply = () => late.promise;
  const reading = f.page.onRefresh(); f.page.onHide();
  const response = base('/api/quiet-hours', {}); response.periods[0].name = '过期响应'; late.resolve(response); await reading;
  assert.equal(f.page.data.periods[0].name, '原草稿'); assert.equal(f.page.data.dirty, true);
});

test('old-owner island and study handlers cannot write using a different signed-in account', async () => {
  for (const name of ['island', 'study']) {
    const f = fixture(name); await f.page.onShow();
    if (name === 'island') f.page.onLessonInput(input(f.page.data.rows[0].key, '旧账号草稿'));
    f.setUser({ id: 'different-user', role: 'principal', permissions: { schoolAdmin: true } });
    if (name === 'island') await f.page.onSave();
    else await f.page.onReview({ currentTarget: { dataset: { id: 'e1', resolution: 'handled' } } });
    assert.equal(f.calls.filter(call => call.method === 'PUT' || call.method === 'POST').length, 0);
  }
});

test('clearing an entry in an empty weekly slot removes it and restores the savable config', () => {
  for (const field of ['subject', 'teacher']) {
    const original = profile(); original.config.lessons = [];
    const row = data.lessonRows(original.config, 1)[0];
    const filled = data.patchLesson(original.config, row, field, '临时输入');
    assert.equal(filled.lessons.length, 1);
    for (const value of ['', '  ']) {
      const cleared = data.patchLesson(filled, row, field, value);
      assert.deepEqual(cleared, original.config);
      assert.deepEqual(data.configPayload(original, cleared), { revision: 7, config: original.config });
    }
    assert.equal(filled.lessons[0][field], '临时输入');
  }
});

test('clearing an empty rotation slot removes only that cycle entry for both duty kinds', () => {
  for (const kind of ['midday', 'evening']) {
    const original = profile(); original.config.lessons = [];
    const other = { slotId: 'p1', weekday: 1, cycleWeek: 2, subject: '自习', teacher: '王老师', location: '', future: { keep: true } };
    original.config.dutyRotations[kind] = { enabled: true, cycleWeeks: 2, slotIds: ['p1'], future: 'keep', lessons: [other] };
    const row = data.lessonRows(original.config, 1).find(item => item.cycleWeek === 1);
    let draft = data.patchLesson(original.config, row, 'subject', '临时科目');
    draft = data.patchLesson(draft, row, 'teacher', '临时教师');
    draft = data.patchLesson(draft, row, 'subject', '');
    assert.equal(draft.dutyRotations[kind].lessons.length, 2);
    draft = data.patchLesson(draft, row, 'teacher', '');
    assert.deepEqual(draft, original.config);
    assert.deepEqual(data.configPayload(original, draft).config.dutyRotations[kind].lessons, [other]);
  }
});

test('clearing a subject retains entries that still contain a teacher or location', () => {
  for (const remaining of [{ teacher: '保留教师', location: '' }, { teacher: '', location: '保留地点' }]) {
    const original = profile(); Object.assign(original.config.lessons[0], remaining);
    const row = data.lessonRows(original.config, 1)[0];
    const draft = data.patchLesson(original.config, row, 'subject', '');
    assert.equal(draft.lessons.length, 1);
    assert.equal(draft.lessons[0].teacher, remaining.teacher);
    assert.equal(draft.lessons[0].location, remaining.location);
    assert.deepEqual(draft.lessons[0].future, { flag: true });
    assert.throws(() => data.configPayload(original, draft), /科目/);
  }
});

test('island can save other settings after typing and clearing an originally empty slot', async () => {
  const f = fixture('island'); const base = f.reply;
  f.reply = (url, options) => {
    if (options.method === 'PUT') return { ...profile('a', 8), config: copy(options.data.config) };
    const response = base(url, options);
    if (url.startsWith('/api/island/classes/')) response.config.lessons = [];
    return response;
  };
  await f.page.onShow();
  const key = f.page.data.rows[0].key;
  f.page.onLessonInput(input(key, '临时科目'));
  f.page.onLessonInput(input(key, ''));
  assert.equal(f.page.data.dirty, false);
  f.page.onEnabledChange({ detail: { value: false } });
  await f.page.onSave();
  const writes = f.calls.filter(call => call.method === 'PUT');
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].data.config.lessons, []);
  assert.equal(writes[0].data.revision, 7); assert.equal(f.page.data.error, ''); assert.equal(f.page.data.dirty, false);
});

test('study prioritizes the events 401 when the concurrent settings request becomes session_changed', async () => {
  const f = fixture('study'); const base = f.reply, settings = deferred(), events = deferred();
  f.reply = (url, options) => url.startsWith('/api/self-study/classes/') ? settings.promise
    : url.startsWith('/api/self-study/events?') ? events.promise : base(url, options);
  const loading = f.page.onShow(); await new Promise(setImmediate);
  events.reject(Object.assign(Error('事件会话已失效，请重新登录'), { status: 401 }));
  await new Promise(setImmediate); assert.equal(f.api.getUser(), null);
  settings.reject(Object.assign(Error('旧会话结果已丢弃'), { code: 'session_changed' }));
  await loading;
  assert.equal(f.page.data.sessionExpired, true);
  assert.equal(f.page.data.error, '事件会话已失效，请重新登录');
  assert.equal(f.page.data.loaded, false); assert.equal(f.page.data.loading, false);
  f.page.relogin(); assert.equal(f.relogin, true);
  assert.equal(f.calls.length, 3);
});

test('study also preserves settings 401 when the events request becomes session_changed', async () => {
  const f = fixture('study'); const base = f.reply, settings = deferred(), events = deferred();
  f.reply = (url, options) => url.startsWith('/api/self-study/classes/') ? settings.promise
    : url.startsWith('/api/self-study/events?') ? events.promise : base(url, options);
  const loading = f.page.onShow(); await new Promise(setImmediate);
  settings.reject(Object.assign(Error('配置会话已失效，请重新登录'), { status: 401 }));
  await new Promise(setImmediate); assert.equal(f.api.getUser(), null);
  events.reject(Object.assign(Error('旧会话结果已丢弃'), { code: 'session_changed' }));
  await loading;
  assert.equal(f.page.data.sessionExpired, true); assert.equal(f.page.data.error, '配置会话已失效，请重新登录');
  assert.equal(f.page.data.loading, false); assert.equal(f.calls.length, 3);
});

test('island revision zero is synced only for an actual matching device revision zero', async () => {
  const f = fixture('island'); const base = f.reply;
  f.reply = (url, options) => url.startsWith('/api/island/classes/') ? { ...profile('a', 0), devices: [
    { id: 'zero', name: '已回执默认配置', revision: 0 },
    { id: 'none', name: '尚无回执', revision: null },
    { id: 'missing', name: '缺少回执' },
    { id: 'other', name: '不同版本', revision: 1 }
  ] } : base(url, options);
  await f.page.onShow();
  assert.equal(f.page.data.syncRevision, 0);
  assert.equal(f.page.data.devices[0].syncText, '已同步');
  for (const device of f.page.data.devices.slice(1)) assert.equal(device.syncText, '等待同步');
});

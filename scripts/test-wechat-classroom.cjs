'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const data = require('../miniprogram/teacher/lib/classroom-data');

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
  const calls = [], confirmations = [];
  let user = { id: 't1', role: 'teacher', permissions: {} }, selected = 'a';
  const f = { calls, confirmations, confirmResult: true, dirty: false };
  const api = {
    getUser: () => user, getClassId: () => selected, selectClass: id => { selected = id; },
    request: async (url, options = {}) => {
      calls.push({ url, ...options });
      try { return await f.reply(url, options); }
      catch (error) { if (error.status === 401) user = null; throw error; }
    }
  };
  const ui = {
    requireLogin: () => Boolean(user), relogin: () => { f.relogin = true; },
    async loadClasses(page, current) {
      const response = await api.request('/api/classes');
      if (!current()) return;
      const classes = response.classes;
      page.setData({ classes, classNames: classes.map(item => item.name) });
      ui.chooseClass(page, Math.max(0, classes.findIndex(item => item.id === selected)));
    },
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
    require: id => id.endsWith('/api') ? api : id.endsWith('/ui') ? ui : id.endsWith('/classroom-data') ? data : (() => { throw Error('Unexpected import: ' + id); })(),
    wx: { stopPullDownRefresh() {} },
    setInterval() { throw Error('Unconditional polling is forbidden'); },
    console
  }, { filename });
  const page = { ...definition, data: copy(definition.data), setData(values) { Object.assign(this.data, copy(values)); } };
  if (page.onLoad) page.onLoad();
  f.page = page; f.api = api; f.setUser = value => { user = value; };
  f.reply = url => {
    if (url === '/api/classes') return { classes: [{ id: 'a', name: '高一1班', enabled: 1 }, { id: 'b', name: '高一2班', enabled: 1 }] };
    if (url.startsWith('/api/island/classes/')) return profile(url.split('/').at(-1));
    if (url === '/api/quiet-hours') return { timezone: 'Asia/Shanghai', serverTime: now, activePeriod: null, periods: [{ id: '11111111-1111-1111-1111-111111111111', name: '上课', weekdays: [1, 2], startTime: '08:00', endTime: '09:00' }] };
    throw Error('Unexpected endpoint: ' + url);
  };
  return f;
}
const input = (key, value, field = 'subject') => ({ currentTarget: { dataset: { key, field } }, detail: { value } });

test('odd and even lessons display separately even with an empty counterpart', () => {
  const config = profile().config; config.lessons[0].week = 'odd';
  const rows = data.lessonRows(config, 1);
  assert.deepEqual(rows.map(row => row.week), ['odd', 'even']);
  assert.deepEqual(rows.map(row => row.subject), ['语文', '']);
});

test('enabled rotation slots display cycle lessons and empty weeks', () => {
  const config = profile().config; config.lessons = [];
  config.dutyRotations.evening = { enabled: true, cycleWeeks: 2, slotIds: ['p1'], future: 'keep', lessons: [{ slotId: 'p1', weekday: 1, cycleWeek: 2, subject: '晚自习', teacher: '王老师', location: '本班', future: 8 }] };
  const rows = data.lessonRows(config, 1);
  assert.deepEqual(rows.map(row => [row.cycleWeek, row.subject, row.teacher]), [[1, '', ''], [2, '晚自习', '王老师']]);
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

test('a late quiet read after hide never replaces current draft or status', async () => {
  const f = await quietAdmin(); f.page.onName(input('11111111-1111-1111-1111-111111111111', '原草稿'));
  const late = deferred(); const base = f.reply; f.reply = () => late.promise;
  const reading = f.page.onRefresh(); f.page.onHide();
  const response = base('/api/quiet-hours', {}); response.periods[0].name = '过期响应'; late.resolve(response); await reading;
  assert.equal(f.page.data.periods[0].name, '原草稿'); assert.equal(f.page.data.dirty, true);
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

test('island class and weekday changes show the current schedule and send only reads, including for managers', async () => {
  const f = fixture('island'); f.setUser({ id: 'manager', role: 'principal', permissions: { schoolAdmin: true } });
  await f.page.onShow();
  assert.equal(f.page.data.rows[0].subject, '语文');
  f.page.onWeekdayChange({ detail: { value: '1' } });
  assert.equal(f.page.data.rows[0].subject, '');
  await f.page.onClassChange({ detail: { value: '1' } });
  assert.equal(f.page.data.classId, 'b'); assert.equal(f.page.data.loaded, true);
  assert.equal(f.calls.at(-1).url, '/api/island/classes/b');
  assert.equal(f.page.onSave, undefined);
  assert.ok(f.calls.every(call => !call.method || call.method === 'GET'));
});

test('island ignores stale class reads after leaving and exposes relogin for a current 401', async () => {
  const f = fixture('island'); const base = f.reply, waiting = deferred();
  f.reply = url => url === '/api/island/classes/a' ? waiting.promise : base(url);
  const previous = f.page.onShow(); await new Promise(setImmediate); f.page.onHide();
  waiting.resolve(profile('a')); await previous;
  assert.equal(f.page.data.loaded, false);
  f.reply = url => { if (url === '/api/island/classes/a') throw Object.assign(Error('登录已失效'), { status: 401 }); return base(url); };
  await f.page.onShow();
  assert.equal(f.page.data.sessionExpired, true); assert.match(f.page.data.error, /登录已失效/);
});

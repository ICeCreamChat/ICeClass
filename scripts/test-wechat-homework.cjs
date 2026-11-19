'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const homework = require('../miniprogram/teacher/lib/homework-data');
const reports = require('../miniprogram/teacher/lib/report-data');
const root = path.resolve(__dirname, '../miniprogram/teacher');
const clone = value => JSON.parse(JSON.stringify(value));
const event = (value, dataset = {}) => ({ detail: { value }, currentTarget: { dataset } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function profile(classId = 'class-a', canEdit = true, revision = 0) {
  return { classId, className: classId === 'class-a' ? '一班' : '二班', canEdit, revision, value: {
    activeTermId: 'term-1', extension: { retained: true }, students: [{ id: 'student-1', name: '学生甲', extra: '保留' }],
    terms: [{ id: 'term-1', label: '2026-2027 学年第一学期', extra: { retained: true }, subjects: homework.SUBJECTS.map(s => ({ ...s,
      items: s.id === 'math' ? [{ id: 'math-book', name: '练习册', active: true, extra: 7 }] : [] })) }]
  } };
}
function harness(pageName = 'homework-manage') {
  const f = { user: { id: 'teacher-1', role: 'subject_teacher', permissions: {} }, selected: 'class-a', calls: [], modals: [], navigation: [], dirty: false, stopped: 0, downloads: [] };
  f.route = (url, options) => {
    const parsed = new URL(url, 'https://mock.invalid');
    if (parsed.pathname === '/api/classes') return { classes: [{ id: 'class-a', name: '一班', enabled: 1 }, { id: 'class-b', name: '二班', enabled: 1 }] };
    if (/^\/api\/homework\/classes\/[^/]+\/profile$/.test(parsed.pathname)) {
      const cid = decodeURIComponent(parsed.pathname.split('/')[4]);
      if (options.method === 'PUT') return { ...profile(cid), revision: options.data.revision + 1, value: clone(options.data.value) };
      return profile(cid);
    }
    if (parsed.pathname === '/api/homework/report') return { group: parsed.searchParams.get('group'), totals: { assignments: 0, expected: 0, submitted: 0, missing: 0, noHomework: 0 }, rows: [], total: 0, page: Number(parsed.searchParams.get('page')), pageSize: 30 };
    throw new Error('Unexpected simulated API: ' + url);
  };
  const api = { getUser: () => f.user, getClassId: () => f.selected, selectClass: id => { f.selected = id; },
    request(url, options = {}) {
      assert.ok(url === '/api/classes' || /^\/api\/homework\/(classes\/[^/]+\/profile|report\?)/.test(url), 'only teacher routes may be used');
      assert.ok(['GET', 'PUT'].includes(options.method || 'GET'));
      assert.equal(options.auth, undefined); assert.equal(options.header, undefined);
      f.calls.push({ url, options: clone(options) });
      return Promise.resolve().then(() => f.route(url, options)).catch(error => { if (error.status === 401) f.user = null; throw error; });
    }, download(url) { f.downloads.push(url); return Promise.resolve('wxfile://local-homework.csv'); }
  };
  const runtime = { navigateTo: options => f.navigation.push(options), reLaunch: options => f.navigation.push(options),
    showModal(options) { f.modals.push(options); if (f.confirm) f.confirm(options); else options.success({ confirm: true }); },
    enableAlertBeforeUnload() { f.dirty = true; }, disableAlertBeforeUnload() { f.dirty = false; }, showToast() {},
    stopPullDownRefresh() { f.stopped++; }, shareFileMessage(options) { options.success(); }
  };
  const uiModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib/ui.js'), 'utf8'), { require: () => api, module: uiModule, wx: runtime, getCurrentPages: () => f.page ? [f.page] : [] });
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages', pageName, 'index.js'), 'utf8'), {
    require(specifier) { return { '../../lib/api': api, '../../lib/ui': uiModule.exports, '../../lib/homework-data': homework, '../../lib/report-data': reports }[specifier]; },
    Page(value) { definition = value; }, wx: runtime
  }, { filename: pageName + '.js' });
  f.page = { ...definition, data: clone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  f.api = api; f.ui = uiModule.exports;
  return f;
}
const writes = f => f.calls.filter(c => c.options.method === 'PUT');
const changeName = (f, name = '学生甲改名') => f.page.onStudentInput(event(name, { id: 'student-1' }));

test('save payload retains complete data and IDs, clones deeply, and accepts revision zero', () => {
  const source = profile(), draft = clone(source.value); draft.students[0].name = '新姓名';
  const payload = homework.savePayload(source, draft);
  assert.equal(payload.revision, 0); assert.equal(payload.value.students[0].id, 'student-1');
  assert.deepEqual(payload.value.extension, { retained: true }); assert.equal(payload.value.students[0].extra, '保留');
  assert.equal(payload.value.terms[0].subjects[1].items[0].extra, 7);
  payload.value.terms[0].extra.retained = false;
  assert.equal(draft.terms[0].extra.retained, true); assert.equal(source.value.students[0].name, '学生甲');
  for (const revision of [-1, true, '0', 0.5, 2147483648, undefined]) assert.throws(() => homework.savePayload({ ...source, revision }, draft), /版本/);
});
test('validation keeps all nine subjects, unique term-wide item IDs and strict booleans', () => {
  for (const mutate of [v => v.terms[0].subjects.pop(), v => v.terms[0].subjects[0].items.push({ id: 'math-book', name: '冲突', active: true }),
    v => { v.terms[0].subjects[1].items[0].active = 'true'; }, v => { v.activeTermId = 'missing'; },
    v => v.students.push({ id: 'student-1', name: '重复编号' }), v => { v.terms[0].subjects[0].id = 'unknown'; }]) {
    const p = profile(); mutate(p.value); assert.throws(() => homework.savePayload(p, p.value));
  }
});
test('name validation follows server character limits and rejects controls or lone surrogates', () => {
  for (const name of ['', ' ', 'x'.repeat(41), '甲\n乙', '\ud800']) {
    const p = profile(); p.value.students[0].name = name; assert.throws(() => homework.savePayload(p, p.value), /姓名/);
  }
  const p = profile(); p.value.students[0].name = '😀'.repeat(40);
  assert.equal(homework.savePayload(p, p.value).value.students[0].name, '😀'.repeat(40));
});
test('batch roster rejects duplicates and overflow without changing original data', () => {
  const p = profile(), initial = clone(p);
  for (const raw of ['学生甲', '学生乙\n学生乙', 'x'.repeat(41), Array.from({ length: 300 }, (_, i) => '姓名' + i).join('\n')])
    assert.throws(() => homework.appendStudents(p.value, raw));
  assert.deepEqual(p, initial);
  const value = homework.appendStudents(p.value, '学生乙\r\n\n学生丙', (() => { let i = 1; return () => 'new-' + i++; })());
  assert.deepEqual(value.students.map(s => s.name), ['学生甲', '学生乙', '学生丙']); assert.equal(p.value.students.length, 1);
});
test('new semester copies every subject and preset using new IDs without switching active semester', () => {
  const p = profile(), initial = clone(p); let i = 0;
  const value = homework.copyTerm(p.value, 'term-1', '2026—2027 学年第二学期', () => 'new-' + ++i);
  const term = value.terms[1]; assert.equal(value.activeTermId, 'term-1'); assert.equal(term.subjects.length, 9);
  assert.equal(term.label, '2026-2027 学年第二学期'); assert.notEqual(term.id, 'term-1');
  assert.notEqual(term.subjects[1].items[0].id, 'math-book'); assert.equal(term.subjects[1].items[0].name, '练习册');
  assert.deepEqual(p, initial); assert.throws(() => homework.copyTerm(p.value, 'term-1', p.value.terms[0].label), /同名/);
});
test('server collection limits accept their maxima and reject overflow', () => {
  const p = profile(); p.value.students = Array.from({ length: 300 }, (_, i) => ({ id: 's-' + i, name: '学生' + i }));
  const template = clone(p.value.terms[0]);
  p.value.terms = Array.from({ length: 30 }, (_, i) => ({ ...clone(template), id: i ? 'term-' + (i + 1) : 'term-1' }));
  p.value.terms[0].subjects[1].items = Array.from({ length: 40 }, (_, i) => ({ id: 'assignment-' + i, name: '作业' + i, active: true }));
  assert.doesNotThrow(() => homework.savePayload(p, p.value));
  for (const mutate of [v => v.students.push({ id: 'overflow', name: '超出' }), v => v.terms.push({ ...clone(template), id: 'overflow' }),
    v => v.terms[0].subjects[1].items.push({ id: 'overflow', name: '超出', active: true })]) {
    const value = clone(p.value); mutate(value); assert.throws(() => homework.savePayload(p, value), /最多/);
  }
});
test('save confirmation counts removed items within each term even when terms reuse item IDs', () => {
  const p = profile(); p.value.terms.push({ ...clone(p.value.terms[0]), id: 'term-2', label: '第二学期' });
  const value = clone(p.value); value.terms[0].subjects[1].items = [];
  assert.doesNotThrow(() => homework.savePayload(p, value));
  assert.match(homework.summary(p, value), /移除 1 个/);
});
test('view permission permits reading but direct handler calls cannot change or save', async () => {
  const f = harness(), normal = f.route; f.route = (url, options) => url.includes('/profile') ? profile('class-a', false) : normal(url, options);
  await f.page.onShow(); changeName(f); f.page.onPendingNames(event('乙')); f.page.addStudents(); await f.page.save();
  assert.equal(f.page.data.canEdit, false); assert.equal(f.page.data.students[0].name, '学生甲'); assert.equal(writes(f).length, 0);
});
test('server canEdit authorizes configuration without guessing teacher roles', async () => {
  const f = harness(); await f.page.onShow(); changeName(f); assert.equal(f.dirty, true);
  await f.page.save(); assert.equal(writes(f).length, 1); assert.equal(writes(f)[0].options.data.revision, 0);
  assert.match(f.modals[0].content, /一班/); assert.match(f.modals[0].content, /历史/);
  assert.equal(f.page.data.revision, 1); assert.equal(f.page.data.students[0].name, '学生甲改名'); assert.equal(f.dirty, false);
});
test('cancelled save keeps draft and never writes', async () => {
  const f = harness(); await f.page.onShow(); changeName(f); f.confirm = options => options.success({ confirm: false }); await f.page.save();
  assert.equal(writes(f).length, 0); assert.equal(f.page.data.dirty, true); assert.equal(f.page.data.busy, false);
});
test('pending roster or semester input must be added before saving', async () => {
  const f = harness(); await f.page.onShow(); f.page.onPendingNames(event('学生乙')); await f.page.save();
  assert.equal(writes(f).length, 0); assert.match(f.page.data.error, /添加|创建/); f.page.addStudents();
  f.page.onPendingTerm(event('第二学期')); await f.page.save(); assert.equal(writes(f).length, 0);
  f.page.addTerm(); await f.page.save(); assert.equal(writes(f).length, 1);
});
test('term selection, active semester, subject filtering and preset edits reach complete configuration', async () => {
  const f = harness(); await f.page.onShow(); f.page.onPendingTerm(event('第二学期')); f.page.addTerm();
  f.page.onActiveTermChange(event(1)); f.page.onSubjectChange(event(1));
  const id = f.page.data.items[0].id; f.page.onItemInput(event('新作业', { id })); f.page.onItemActive(event(false, { id }));
  await f.page.save(); const value = writes(f)[0].options.data.value;
  assert.equal(value.activeTermId, value.terms[1].id); assert.equal(value.terms[1].subjects[1].items[0].name, '新作业');
  assert.equal(value.terms[1].subjects[1].items[0].active, false); assert.equal(value.terms[0].subjects[1].items[0].name, '练习册');
});
test('per-class drafts survive switching and returning, and pull refresh cannot overwrite edits', async () => {
  const f = harness(); await f.page.onShow(); changeName(f);
  await f.page.onClassChange(event(1)); assert.equal(f.page.data.students[0].name, '学生甲');
  await f.page.onClassChange(event(0)); assert.equal(f.page.data.students[0].name, '学生甲改名');
  await f.page.onPullDownRefresh(); assert.equal(f.page.data.students[0].name, '学生甲改名'); assert.equal(f.stopped, 1);
});
test('old profile reads cannot overwrite new class or hidden pages', async () => {
  const f = harness(), old = deferred(), normal = f.route;
  f.route = (url, options) => url.includes('/classes/class-a/profile') ? old.promise : normal(url, options);
  const pending = f.page.onShow(); await flush(); await f.page.onClassChange(event(1));
  old.resolve(profile()); await pending; assert.equal(f.page.data.classId, 'class-b'); assert.equal(f.page.data.profileClassId, 'class-b');
  const next = deferred(); f.route = () => next.promise; const loading = f.page.load(); f.page.onHide(); next.resolve(profile('class-b')); await loading;
  assert.equal(f.page.data.loading, false);
});
test('save lock covers confirmation, input, class changes and request to prevent duplicate writes', async () => {
  const f = harness(); await f.page.onShow(); changeName(f); const prompt = deferred(); f.confirm = o => prompt.promise.then(o.success);
  const pending = f.page.save(); await f.page.save(); changeName(f, '不应生效'); await f.page.onClassChange(event(1));
  assert.equal(f.page.data.classId, 'class-a'); assert.equal(f.page.data.students[0].name, '学生甲改名');
  prompt.resolve({ confirm: true }); await pending; assert.equal(writes(f).length, 1);
});
for (const status of [401, 403, 409]) test('save ' + status + ' preserves draft and server error', async () => {
  const f = harness(); await f.page.onShow(); changeName(f); const normal = f.route;
  f.route = (url, options) => { if (options.method === 'PUT') throw Object.assign(new Error('服务原始提示' + status), { status }); return normal(url, options); };
  await f.page.save(); assert.equal(f.page.data.students[0].name, '学生甲改名'); assert.equal(f.page.data.dirty, true);
  assert.equal(f.page.data.error, '服务原始提示' + status); assert.equal(f.page.data.sessionExpired, status === 401);
  if (status === 401) { f.page.relogin(); assert.match(f.navigation.at(-1).url, /login/); }
  if (status === 403) assert.equal(f.page.data.canEdit, false);
  if (status === 409) { assert.equal(f.page.data.conflict, true); await f.page.save(); assert.equal(writes(f).length, 1); }
});
test('ambiguous or malformed successful writes require explicit reload and never retry automatically', async () => {
  for (const response of [Object.assign(new Error('结果不确定'), { ambiguous: true }), { ...profile(), revision: 0 }, { ...profile('class-b'), revision: 1 }]) {
    const f = harness(); await f.page.onShow(); changeName(f); const normal = f.route;
    f.route = (url, options) => { if (options.method !== 'PUT') return normal(url, options); if (response instanceof Error) throw response; return response; };
    await f.page.save(); await f.page.save(); assert.equal(writes(f).length, 1); assert.equal(f.page.data.uncertain, true); assert.equal(f.page.data.dirty, true);
    await f.page.onPullDownRefresh(); assert.equal(f.page.data.students[0].name, '学生甲改名');
    await f.page.reload(); assert.equal(f.page.data.uncertain, false); assert.equal(f.page.data.dirty, false); assert.equal(writes(f).length, 1);
  }
});
test('failed confirmed reload retains draft and conflict protection', async () => {
  const f = harness(); await f.page.onShow(); changeName(f); f.route = () => { throw new Error('本地模拟离线'); };
  await f.page.reload(); assert.equal(f.page.data.students[0].name, '学生甲改名'); assert.equal(f.page.data.dirty, true);
});
test('a hidden save settles once, retaining result when the same owner returns', async () => {
  const f = harness(); await f.page.onShow(); changeName(f); const pendingWrite = deferred(), normal = f.route;
  f.route = (url, options) => options.method === 'PUT' ? pendingWrite.promise : normal(url, options);
  const pending = f.page.save(); await flush(); f.page.onHide(); await f.page.onShow(); assert.equal(f.page.data.busy, true);
  pendingWrite.resolve({ ...profile(), revision: 1, value: writes(f)[0].options.data.value }); await pending;
  assert.equal(writes(f).length, 1); assert.equal(f.page.data.dirty, false);
});
test('account switch blocks mutation and late profile response', async () => {
  const f = harness(), pendingRead = deferred(), normal = f.route;
  f.route = (url, options) => url.includes('/profile') ? pendingRead.promise : normal(url, options);
  const pending = f.page.onShow(); await flush(); f.user = { id: 'teacher-2' }; pendingRead.resolve(profile()); await pending;
  assert.equal(f.page.data.profileClassId, ''); changeName(f); await f.page.save(); assert.equal(writes(f).length, 0);
  await f.page.onShow(); assert.match(f.navigation.at(-1).url, /workbench/);
});
test('login recovery retains the same owner draft and requires a fresh explicit save', async () => {
  const f = harness(); await f.page.onShow(); changeName(f); const normal = f.route;
  f.route = (url, options) => { if (options.method === 'PUT') throw Object.assign(new Error('会话失效'), { status: 401 }); return normal(url, options); };
  await f.page.save(); f.page.onHide(); f.user = { id: 'teacher-1', role: 'teacher' }; f.route = normal; await f.page.onShow();
  assert.equal(f.page.data.students[0].name, '学生甲改名'); assert.equal(f.page.data.sessionExpired, false); assert.equal(writes(f).length, 1);
  await f.page.save(); assert.equal(writes(f).length, 2); assert.equal(f.page.data.dirty, false);
});
test('cancelled or failed reload retains modifications, and hidden confirmation never submits', async () => {
  const f = harness(); await f.page.onShow(); changeName(f); f.confirm = o => o.success({ confirm: false }); await f.page.reload();
  assert.equal(f.page.data.dirty, true);
  const prompt = deferred(); f.confirm = o => prompt.promise.then(o.success); const saving = f.page.save();
  f.page.onHide(); prompt.resolve({ confirm: true }); await saving; assert.equal(writes(f).length, 0); assert.equal(f.page.data.busy, false);
});
test('adding and removing presets or students updates only the intended objects', async () => {
  const f = harness(); await f.page.onShow(); f.page.onSubjectChange(event(1));
  f.page.addItem(); const item = f.page.data.items[1]; await f.page.save(); assert.equal(writes(f).length, 0); assert.match(f.page.data.error, /作业名称/);
  f.page.onItemInput(event('课堂练习', { id: item.id })); f.page.removeItem(event('', { id: 'math-book' }));
  f.page.onPendingNames(event('学生乙')); f.page.addStudents(); f.page.removeStudent(event('', { id: 'student-1' })); await f.page.save();
  const value = writes(f)[0].options.data.value; assert.equal(value.terms[0].subjects[1].items.length, 1);
  assert.equal(value.terms[0].subjects[1].items[0].id, item.id); assert.equal(value.students[0].name, '学生乙'); assert.notEqual(value.students[0].id, 'student-1');
});
test('stale class-list response cannot select or overwrite the newer class', async () => {
  const f = harness(); await f.page.onShow(); const pendingClasses = deferred(), normal = f.route;
  f.route = (url, options) => url === '/api/classes' ? pendingClasses.promise : normal(url, options);
  const pending = f.page.load(true); await flush(); await f.page.onClassChange(event(1));
  pendingClasses.resolve({ classes: [{ id: 'class-a', name: '过时班级' }] }); await pending;
  assert.equal(f.page.data.classId, 'class-b'); assert.equal(f.selected, 'class-b'); assert.equal(f.page.data.classes.length, 2);
});
test('requested class is checked against accessible classes and malformed profiles stay non-editable', async () => {
  const f = harness(); f.page.onLoad({ classId: 'class-b' }); await f.page.onShow(); assert.equal(f.page.data.classId, 'class-b');
  const bad = harness(); bad.page.onLoad({ classId: 'unauthorized' }); await bad.page.onShow();
  assert.equal(bad.calls.some(call => call.url.includes('/profile')), false); assert.equal(bad.page.data.canEdit, false); assert.match(bad.page.data.error, /权限/);
  for (const mutate of [p => { p.classId = 'wrong'; }, p => p.value.terms[0].subjects.pop(), p => { p.revision = true; }]) {
    const h = harness(), normal = h.route; h.route = (url, options) => { if (!url.includes('/profile')) return normal(url, options); const p = profile(); mutate(p); return p; };
    await h.page.onShow(); assert.equal(h.page.data.canEdit, false); assert.ok(h.page.data.error);
  }
});
test('read failures show actual 401 or 403, preserving a previously edited draft', async () => {
  for (const status of [401, 403]) {
    const f = harness(); await f.page.onShow(); changeName(f); f.route = () => { throw Object.assign(new Error('真实读取错误' + status), { status }); };
    await f.page.load(true); assert.equal(f.page.data.error, '真实读取错误' + status); assert.equal(f.page.data.sessionExpired, status === 401);
    assert.equal(f.page.data.students[0].name, '学生甲改名'); assert.equal(f.page.data.loading, false);
  }
});
test('session change during a write keeps a reconciliation lock and a login entry', async () => {
  const f = harness(); await f.page.onShow(); changeName(f);
  f.route = () => { f.user = null; throw Object.assign(new Error('登录状态发生变化'), { code: 'session_changed' }); };
  await f.page.save(); assert.equal(f.page.data.uncertain, true); assert.equal(f.page.data.sessionExpired, true); assert.equal(f.page.data.dirty, true);
});
test('all-class report and export omit class and term filters while retaining subject, dates and group', async () => {
  const f = harness('homework'); await f.page.onShow(); f.page.onTermChange(event(1));
  f.page.onSubjectChange(event(2)); await f.page.allClasses(); await f.page.queryReport(); await f.page.exportReport();
  for (const url of [f.calls.filter(c => c.url.startsWith('/api/homework/report?')).at(-1).url, f.downloads.at(-1)]) {
    const q = new URL(url, 'https://mock.invalid').searchParams; assert.equal(q.has('classId'), false); assert.equal(q.has('termId'), false);
    assert.equal(q.get('subjectId'), 'math'); assert.equal(q.get('group'), 'assignments'); assert.ok(q.get('start')); assert.ok(q.get('end'));
  }
  await f.page.onClassChange(event(1)); assert.equal(f.page.data.allScope, false); assert.equal(f.page.data.classId, 'class-b');
});
test('all-class reports accept accessible classes and reject rows outside the authorized class list', async () => {
  const f = harness('homework'); await f.page.onShow(); const normal = f.route;
  f.route = (url, options) => {
    const result = normal(url, options);
    if (!url.startsWith('/api/homework/report?')) return result;
    result.rows = ['class-a', 'class-b'].map(classId => ({ classId, className: classId, termName: '学期', itemName: '作业', status: 'no_homework', missingNames: [], expected: 0, submitted: 0, missing: 0 }));
    result.total = 2; return result;
  };
  await f.page.allClasses(); assert.equal(f.page.data.report.rows.length, 2);
  const accessible = f.route;
  f.route = (url, options) => { const result = accessible(url, options); if (url.startsWith('/api/homework/report?')) result.rows[0].classId = 'unauthorized'; return result; };
  await f.page.queryReport(); assert.equal(f.page.data.report, null); assert.match(f.page.data.error, /班级/);
});
test('report management entry carries the selected class using the announced registration path', async () => {
  const f = harness('homework'); await f.page.onShow(); f.page.manageHomework();
  assert.equal(f.navigation.at(-1).url, '/pages/homework-manage/index?classId=class-a');
});
test('all-class scope can return to its original class without needing a changed picker index', async () => {
  const f = harness('homework'); await f.page.onShow(); await f.page.allClasses(); await f.page.singleClass();
  assert.equal(f.page.data.allScope, false); assert.equal(f.page.data.classId, 'class-a'); assert.equal(f.page.data.terms.length, 2);
  const url = f.calls.filter(call => call.url.startsWith('/api/homework/report?')).at(-1).url;
  assert.equal(new URL(url, 'https://mock.invalid').searchParams.get('classId'), 'class-a');
});
test('management page has all four files, linked handlers and native accessible form controls', () => {
  const directory = path.join(root, 'pages/homework-manage');
  const markup = fs.readFileSync(path.join(directory, 'index.wxml'), 'utf8');
  const f = harness();
  for (const [, handler] of markup.matchAll(/bind(?:tap|change|input)="([A-Za-z][A-Za-z0-9_]*)"/g)) assert.equal(typeof f.page[handler], 'function', handler);
  for (const control of markup.matchAll(/<(?:input|textarea|picker|switch)\b[^>]*\/?>/g)) assert.match(control[0], /aria-label=/);
  assert.doesNotMatch(markup, /&amp;|&gt;|&lt;/);
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'));
  assert.equal(config.enablePullDownRefresh, true); assert.ok(fs.readFileSync(path.join(directory, 'index.wxss'), 'utf8').includes('44px'));
});

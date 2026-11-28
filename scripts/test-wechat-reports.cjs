'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const reports = require('../miniprogram/teacher/lib/report-data');
const root = path.resolve(__dirname, '../miniprogram/teacher');
const pageNames = ['paper', 'homework', 'reading'];
const count = overrides => ({ samples: 0, correct: 0, wrong: 0, unanswered: 0, exempt: 0, ungraded: 0, practice: 0, ...overrides });
const metricValue = (metrics, key) => metrics.find(row => row.key === key)?.value;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const event = (value, dataset = {}) => ({ detail: { value: String(value) }, currentTarget: { dataset } });
const completed = () => ({ carrots: 0, poems: 0, badges: 0, launches: 0, energy: 0 });

function paperPayload(classId = 'class-a') {
  const roster = Array.from({ length: 5 }, (_, i) => ({ id: 'student-' + i, name: '学生' + (i + 1) }));
  const student = (i, status, option, choices) => ({ studentId: roster[i].id, studentName: roster[i].name, status, option, ...(choices ? { choices } : {}) });
  const students = [student(0, 'correct', 'AC', { A: true, B: false, C: true }),
    student(1, 'wrong', '', { A: false, B: false, C: false }),
    student(2, 'incomplete', 'A', { A: true, B: false }), student(3, 'unanswered', null),
    student(4, 'exempt', 'A', { A: true })];
  const round = (id, values, extra = {}) => ({ id, purpose: 'formal', status: 'closed', startedAt: 1, endedAt: 2,
    distribution: { A: 1, B: 0, C: 1 }, ...count({ incomplete: 0 }), students: values, ...extra });
  const latest = round('latest', students, { samples: 2, correct: 1, wrong: 1, incomplete: 1, unanswered: 1, exempt: 1 });
  const history = round('history', roster.map((_, i) => student(i, 'correct', 'AC', { A: true, B: false, C: true })),
    { samples: 5, correct: 5, distribution: { A: 5, B: 0, C: 5 } });
  const practice = round('practice', students.map(s => ({ ...s, status: ['correct', 'wrong'].includes(s.status) ? 'practice' : s.status })),
    { purpose: 'practice', practice: 2, incomplete: 1, unanswered: 1, exempt: 1 });
  const boolean = round('boolean-round', [student(0, 'ungraded', 'A'), student(1, 'ungraded', 'B'),
    student(2, 'unanswered', null), student(3, 'exempt', null), student(4, 'unanswered', null)],
  { ...count({ ungraded: 2, unanswered: 2, exempt: 1 }), distribution: { A: 1, B: 1 } });
  delete boolean.incomplete;
  const open = round('open-round', [], { status: 'paused', endedAt: null, distribution: { A: 0, B: 0 } });
  delete open.incomplete;
  const questions = [
    { id: 'multiple', type: 'multiple', text: '选出符合条件的选项', options: ['甲', '乙', '丙'], answer: 'AC', tags: ['组合判断'], imageId: null },
    { id: 'boolean', type: 'boolean', text: '判断命题是否正确', options: ['正确', '错误'], answer: null, tags: [], imageId: null },
    { id: 'single', type: 'single', text: '', options: ['甲', '乙'], answer: 'A', tags: [], imageId: 'image-1' }
  ];
  return {
    session: { id: 'session-' + classId, classId, subjectId: 'math', startedAt: 1, endedAt: null, roster, questions },
    revision: 1,
    report: {
      totals: { ...count({ samples: 2, correct: 1, wrong: 1, incomplete: 1, unanswered: 3, exempt: 2, ungraded: 2, practice: 5 }), accuracy: .5 },
      questions: questions.map((q, i) => ({ id: q.id, text: q.text, answer: q.answer, tags: q.tags, rounds: i === 0 ? [history, practice, latest] : i === 1 ? [boolean] : [open] })),
      students: roster.map((s, i) => ({ studentId: s.id, studentName: s.name,
        ...count({ incomplete: 0, practice: 1, ...(i === 0 ? { samples: 1, correct: 1, ungraded: 1 } : i === 1 ? { samples: 1, wrong: 1, ungraded: 1 } : i === 2 ? { incomplete: 1, unanswered: 1 } : i === 3 ? { unanswered: 1, exempt: 1 } : { exempt: 1, unanswered: 1 }) }),
        accuracy: i === 0 ? 1 : i === 1 ? 0 : null }))
    }
  };
}

function homeworkPayload(classId = 'class-a', page = 1, group = 'assignments') {
  const all = Array.from({ length: 65 }, (_, i) => ({ classId, className: classId, termId: 'term-' + classId, termName: '2026-2027 学年第一学期',
    ...(group === 'students' ? { studentId: 'student-' + i, studentName: '学生' + i } : {
      date: '2026-11-19', subjectId: 'math', subjectName: '数学', itemName: '练习' + i,
      status: i === 0 ? 'no_homework' : 'submitted', missingNames: i === 1 ? ['学生甲'] : [], updatedAt: 1
    }), expected: i === 0 ? 0 : 2, submitted: i === 0 ? 0 : i === 1 ? 1 : 2, missing: i === 1 ? 1 : 0 }));
  return { group, totals: { assignments: 64, expected: 128, submitted: 127, missing: 1, noHomework: 1 },
    rows: all.slice((page - 1) * 30, page * 30), total: all.length, page, pageSize: 30 };
}

function readingPayload(classId = 'class-a', overrides = {}) {
  return { start: '2026-11-13', end: '2026-11-19', grades: [], rows: [{ classId, className: classId, enabled: 1,
    activeSeconds: 60, effectiveSeconds: 30, sessions: 1, days: 1, ratio: 50, rank: 1, modes: ['classic'], completed: completed(),
    sync: { state: 'current', lastSyncedAt: 1, pendingBatches: 0, reviewBatches: 0 }, ...overrides }],
  daily: [{ className: classId, day: '2026-11-19', activeSeconds: 60, effectiveSeconds: 30, sessions: 1, completed: completed() }] };
}

// Use the real shared ui.js with a simulated transport and WeChat runtime; no real requests or shares.
function harness(name) {
  const f = { user: { id: 'teacher', role: 'teacher', permissions: {} }, selectedClass: 'class-a',
    calls: [], downloads: [], shares: [], navigation: [], stopped: 0 };
  f.route = url => {
    const parsed = new URL(url, 'https://mock.invalid');
    const classId = parsed.searchParams.get('classId') || f.selectedClass;
    if (parsed.pathname === '/api/classes') return { classes: [{ id: 'class-a', name: '一班', enabled: 1 }, { id: 'class-b', name: '二班', enabled: 1 }] };
    if (/^\/api\/homework\/classes\/[^/]+\/profile$/.test(parsed.pathname)) {
      const cid = decodeURIComponent(parsed.pathname.split('/')[4]);
      return { classId: cid, value: { activeTermId: 'term-' + cid, terms: [{ id: 'term-' + cid, label: '学期 ' + cid, subjects: [] }], students: [] }, revision: 1, canEdit: false };
    }
    if (parsed.pathname === '/api/card-quiz/sessions') return { sessions: [{ id: 'session-' + classId, classId, subjectId: 'math', startedAt: 1, endedAt: null, questionCount: 3, studentCount: 5 }] };
    if (parsed.pathname.startsWith('/api/card-quiz/sessions/')) return paperPayload(decodeURIComponent(parsed.pathname.slice('/api/card-quiz/sessions/session-'.length)));
    if (parsed.pathname === '/api/homework/report') return homeworkPayload(classId, Number(parsed.searchParams.get('page')), parsed.searchParams.get('group'));
    if (parsed.pathname === '/api/reading/report') return readingPayload(classId);
    throw new Error('Unexpected simulated API: ' + url);
  };
  const api = {
    getUser: () => f.user, getClassId: () => f.selectedClass, selectClass: id => { f.selectedClass = id; },
    request(url, options = {}) {
      assert.equal(options.method || 'GET', 'GET', 'report pages must use read endpoints');
      f.calls.push({ url, options });
      return Promise.resolve().then(() => f.route(url, options)).catch(error => {
        if (error.status === 401) f.user = null;
        throw error;
      });
    },
    download(url) { f.downloads.push(url); return f.download ? f.download(url) : Promise.resolve('wxfile://simulated-report'); }
  };
  const runtime = {
    stopPullDownRefresh: () => { f.stopped++; },
    navigateTo: options => f.navigation.push(options), reLaunch: options => f.navigation.push(options),
    shareFileMessage(options) { f.shares.push(options); if (f.share) f.share(options); else options.success(); },
    showToast() {}
  };
  const uiModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib/ui.js'), 'utf8'), {
    require(specifier) { assert.equal(specifier, './api'); return api; }, module: uiModule,
    wx: runtime, getCurrentPages: () => f.page ? [f.page] : []
  }, { filename: 'shared-ui.js' });
  const ui = uiModule.exports;
  ui.dateISO = (offset = 0) => new Date(Date.parse('2026-11-19T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages', name, 'index.js'), 'utf8'), {
    require(specifier) {
      if (specifier === '../../lib/api') return api;
      if (specifier === '../../lib/ui') return ui;
      if (specifier === '../../lib/report-data') return reports;
      throw new Error('Unexpected page import: ' + specifier);
    },
    Page(value) { definition = value; }, wx: runtime
  }, { filename: name + '-page.js' });
  f.page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  f.api = api; f.ui = ui; f.runtime = runtime;
  return f;
}

test('paper mapping preserves sealed official totals, zero accuracy and ungraded answers', () => {
  const raw = paperPayload();
  const mapped = reports.paperDetail(raw, String);
  assert.equal(metricValue(mapped.header.metrics, 'samples'), '2');
  assert.equal(metricValue(mapped.header.metrics, 'practice'), '5');
  assert.equal(metricValue(mapped.header.metrics, 'accuracy'), '50.0%');
  assert.equal(metricValue(mapped.students[1].metrics, 'accuracy'), '0.0%');
  assert.equal(metricValue(mapped.students[2].metrics, 'accuracy'), '未判定');
  assert.equal(metricValue(mapped.questions[1].rounds[0].metrics, 'accuracy'), '未判定');
  assert.equal(mapped.questions[1].rounds[0].students[0].answerText, 'A（正确）');
  assert.equal(mapped.questions[1].rounds[0].students[0].statusText, '未判定');
  assert.match(mapped.questions[0].rounds[0].contribution, /不计入/);
  assert.equal(mapped.questions[0].rounds[2].contribution, '计入本课正式汇总');
  assert.equal(metricValue(mapped.questions[0].rounds[1].metrics, 'accuracy'), '练习不计入正式正确率');
  assert.deepEqual(mapped.questions[2].rounds[0].metrics, []);
  assert.deepEqual(mapped.questions[2].rounds[0].students, []);
  assert.match(mapped.questions[2].text, /图片题/);
  assert.equal(raw.report.totals.practice, 5);
});

test('multiple answers retain false choices, all-unselected, partial and missing distinctions', () => {
  const round = reports.paperDetail(paperPayload(), String).questions[0].rounds[2];
  assert.equal(round.students[0].answerText, 'AC');
  assert.equal(round.students[1].answerText, '全不选');
  assert.equal(round.students[2].answerText, 'A 选 · B 不选 · C 未答');
  assert.equal(round.students[2].statusText, '未完成');
  assert.equal(round.students[3].answerText, '未收到作答');
  assert.equal(round.students[3].statusText, '未答');
  assert.equal(round.students[4].statusText, '免答');
  assert.equal(round.participationText, '2/4（50.0%）');
  assert.equal(round.distribution[0].percent, '50.0%');
  assert.equal(round.distribution[1].count, '0');
  assert.equal(round.distribution[1].percent, '0.0%');
});

test('scanned lessons use the sealed cohort and group raise-only multiple answers in the mini program', () => {
  const raw=paperPayload();
  raw.session.attendanceMode='scanned';
  const latest=raw.report.questions[0].rounds[2];
  raw.session.questions[0].rounds=[{id:latest.id,noCardPolicy:'abstain',participantCount:4}];
  latest.students=[{studentName:'1 号卡',option:'AC',choices:{A:true,C:true},status:'correct'},
    {studentName:'2 号卡',option:'',choices:{B:false},status:'wrong'},
    {studentName:'3 号卡',option:null,status:'abstained'},{studentName:'4 号卡',option:null,status:'exempt'}];
  Object.assign(latest,{combinationDistribution:{'':1,AC:1},incomplete:0,unanswered:0,abstained:1,exempt:1});
  const view=reports.paperDetail(raw,String).questions[0].rounds[2];
  assert.equal(view.participationText,'本题已答 2 人 · 截至本轮已参与 4 人');
  assert.deepEqual(view.distribution.map(row=>[row.letter,row.count,row.percent]),[['AC','1','50.0%'],['全不选','1','50.0%']]);
  assert.deepEqual(view.students.map(s=>s.statusText),['正确','错误','弃权','免答']);
});

test('multiple option shares may sum above 100%, without normalizing or inventing recognition scores', () => {
  const raw = paperPayload();
  const round = reports.paperDetail(raw, String).questions[0].rounds[0];
  assert.deepEqual(round.distribution.map(row => row.percent), ['100.0%', '0.0%', '100.0%']);
  assert.equal(metricValue(reports.paperMetrics(count({ accuracy: null })), 'accuracy'), '未判定');
  assert.equal(reports.numberText(null), '未提供');
  assert.equal(reports.numberText(0), '0');
  assert.equal(reports.fractionText(undefined), '未判定');
  assert.equal(reports.paperMetrics(count()).some(row => row.key === 'incomplete'), false);
});

test('homework totals are independent of the visible page and no-homework is not a zero grade', () => {
  const first = reports.homeworkReport(homeworkPayload(), String);
  assert.equal(first.rows[0].statusText, '今日无作业');
  assert.equal(first.rows[0].expected, '0');
  assert.equal(first.rows[0].missingNamesText, '无需上交');
  assert.equal(first.rows[1].missingNamesText, '学生甲');
  assert.equal(first.rows[2].missingNamesText, '无');
  assert.equal(metricValue(first.metrics, 'expected'), '128');
  assert.equal(metricValue(first.metrics, 'rate'), '99.2%');
  const last = reports.homeworkReport(homeworkPayload('class-a', 3), String);
  assert.equal(last.rows.length, 5);
  assert.equal(last.pages, 3);
  assert.equal(metricValue(last.metrics, 'expected'), '128');
  const empty = homeworkPayload();
  empty.totals = { assignments: 0, expected: 0, submitted: 0, missing: 0, noHomework: 1 };
  assert.equal(metricValue(reports.homeworkReport(empty, String).metrics, 'rate'), '无应交');
});

test('reading ratios already use percent units, and missing activity never becomes 0%', () => {
  const mapped = reports.readingReport(readingPayload(), String).rows[0];
  assert.equal(metricValue(mapped.metrics, 'ratio'), '50.0%');
  assert.equal(metricValue(mapped.completed, 'carrots'), '0');
  assert.equal(mapped.modesText, '兔拔萝卜');
  const zero = reports.readingReport(readingPayload('class-a', { activeSeconds: 0, effectiveSeconds: 0, sessions: 0, days: 0, ratio: null,
    sync: { state: 'pending', lastSyncedAt: null, pendingBatches: 2, reviewBatches: 0 } }), String).rows[0];
  assert.equal(metricValue(zero.metrics, 'ratio'), '暂无运行记录');
  assert.equal(metricValue(zero.metrics, 'active'), '0 分 0 秒');
  assert.equal(zero.syncLabel, '待补传');
  assert.equal(zero.pendingText, '2');
  assert.match(zero.syncNote, /可能不完整/);
  assert.equal(zero.syncedText, '尚无同步确认');
  assert.equal(metricValue(reports.readingReport(readingPayload('class-a', { ratio: 0 }), String).rows[0].metrics, 'ratio'), '0.0%');
});

test('date validation uses the actual service boundaries and rejects invalid calendar dates', () => {
  assert.equal(reports.dateRangeError('2026-01-01', '2027-01-01', 365), '');
  assert.notEqual(reports.dateRangeError('2026-01-01', '2027-01-02', 365), '');
  assert.equal(reports.dateRangeError('2026-01-01', '2027-01-02', 366), '');
  assert.notEqual(reports.dateRangeError('2026-02-30', '2026-03-01', 365), '');
  assert.notEqual(reports.dateRangeError('2026-11-20', '2026-11-19', 365), '');
  assert.equal(reports.dateRangeError('2028-02-29', '2028-02-29', 365), '');
  assert.equal(reports.paginate([], 99).page, 1);
  assert.equal(reports.paginate(Array.from({ length: 31 }, (_, i) => i), 2).rows[0], 30);
});

for (const name of pageNames) {
  test(name + ': onShow requires login and preserves filter drafts', async () => {
    const f = harness(name); f.user = null;
    f.page.data.start = '2026-10-01';
    await f.page.onShow();
    assert.equal(f.calls.length, 0);
    assert.equal(f.navigation.length, 0);
    assert.equal(f.page.data.start, '2026-10-01');
    f.page.relogin();
    assert.equal(f.navigation[0].url, '/pages/login/index');
  });

  test(name + ': class changes clear old results and ignore slow responses', async () => {
    const f = harness(name), old = deferred(), normal = f.route;
    const reportPath = name === 'paper' ? '/api/card-quiz/sessions?' : '/api/' + name + '/report?';
    f.route = url => url.startsWith(reportPath) && url.includes('classId=class-a') ? old.promise : normal(url);
    const first = f.page.onShow();
    await flush();
    assert.equal(f.page.data.classId, 'class-a');
    const second = f.page.onClassChange(event(1));
    assert.equal(name === 'paper' ? f.page.data.detail : f.page.data.report, null);
    await second;
    assert.equal(f.page.data.classId, 'class-b');
    old.resolve(name === 'paper' ? { sessions: [{ id: 'old', classId: 'class-a', subjectId: 'math', startedAt: 1, endedAt: 2, questionCount: 0, studentCount: 0 }] }
      : name === 'homework' ? homeworkPayload() : readingPayload());
    await first;
    assert.equal(f.page.data.classId, 'class-b');
    if (name === 'paper') assert.equal(f.page.data.sessionRows[0].id, 'session-class-b');
    else if (name === 'homework') assert.equal(f.page.data.report.rows[0].className, 'class-b');
    else assert.equal(f.page.data.report.classId, 'class-b');
    assert.equal(f.page.data.loading, false);
  });

  test(name + ': hiding or unloading invalidates pending reads and class-loader setData', async () => {
    for (const lifecycle of ['onHide', 'onUnload']) {
      const f = harness(name), waiting = deferred(), normal = f.route;
      f.route = url => url === '/api/classes' ? waiting.promise : normal(url);
      const pending = f.page.onShow(); await flush();
      f.page[lifecycle]();
      waiting.resolve({ classes: [{ id: 'class-a', name: '过期名单', enabled: 1 }] });
      await pending;
      assert.equal(f.page.data.classNames.length, 0);
      assert.equal(f.page.data.loading, false);
      assert.equal(f.calls.length, 1);
    }
  });

  test(name + ': 401 preserves drafts without navigating; 403 keeps the server message', async () => {
    for (const status of [401, 403]) {
      const f = harness(name), normal = f.route;
      f.page.data.start = '2026-10-01'; f.page.data.end = '2026-10-02';
      f.page.data.subjectId = 'math';
      f.route = url => url === '/api/classes' ? normal(url) : Promise.reject(Object.assign(new Error('服务原始权限提示'), { status }));
      await f.page.onShow();
      assert.equal(f.page.data.error, '服务原始权限提示');
      assert.equal(f.page.data.sessionExpired, status === 401);
      assert.equal(f.page.data.start, '2026-10-01');
      assert.equal(f.page.data.subjectId, 'math');
      assert.equal(f.navigation.length, 0);
      assert.equal(f.page.data.loading, false);
    }
  });

  test(name + ': session_changed errors are ignored and pull-down refresh always stops', async () => {
    const f = harness(name);
    await f.page.onShow();
    const normal = f.route;
    f.route = url => url === '/api/classes' ? normal(url) : Promise.reject(Object.assign(new Error('过期错误'), { code: 'session_changed' }));
    await f.page.onPullDownRefresh();
    assert.equal(f.page.data.error, '');
    assert.equal(f.page.data.loading, false);
    assert.equal(f.stopped, 1);
    f.route = () => Promise.reject(Object.assign(new Error('没有该班级权限'), { status: 403 }));
    await f.page.onPullDownRefresh();
    assert.equal(f.stopped, 2);
    assert.equal(f.page.data.error, '没有该班级权限');
  });

  test(name + ': empty classes do not issue unscoped school-wide report reads', async () => {
    const f = harness(name);
    f.route = url => { assert.equal(url, '/api/classes'); return { classes: [] }; };
    await f.page.onShow();
    assert.equal(f.page.data.classId, '');
    assert.equal(f.calls.length, 1);
    assert.equal(f.page.data.loading, false);
  });

  test(name + ': export uses a download, locks repeated clicks and class changes, and never auto-shares', async () => {
    const f = harness(name);
    await f.page.onShow();
    assert.equal(f.downloads.length, 0);
    assert.equal(f.shares.length, 0);
    const file = deferred(); f.download = () => file.promise;
    const exporting = f.page.exportReport();
    await f.page.exportReport();
    await f.page.onClassChange(event(1));
    assert.equal(f.page.data.classId, 'class-a');
    assert.equal(f.page.data.exporting, true);
    assert.equal(f.downloads.length, 1);
    file.resolve('wxfile://simulated-report');
    await exporting;
    assert.equal(f.shares.length, 1);
    assert.equal(f.shares[0].filePath, 'wxfile://simulated-report');
    assert.match(f.shares[0].fileName, name === 'reading' ? /\.xlsx$/ : /\.csv$/);
    const url = new URL(f.downloads[0], 'https://mock.invalid');
    assert.equal(url.searchParams.get('classId'), 'class-a');
    assert.equal(url.searchParams.has('page'), false);
    assert.equal(url.searchParams.has('pageSize'), false);
    if (name === 'reading') assert.equal(url.searchParams.get('format'), 'xlsx');
    assert.equal(f.page.data.exporting, false);
  });

  test(name + ': leaving during download prevents a later file share', async () => {
    const f = harness(name); await f.page.onShow();
    const file = deferred(); f.download = () => file.promise;
    const pending = f.page.exportReport();
    f.page.onHide();
    file.resolve('wxfile://simulated-report');
    await pending;
    assert.equal(f.shares.length, 0);
    assert.equal(f.page.data.exporting, false);
  });

  test(name + ': export failure releases the lock and preserves filters', async () => {
    const f = harness(name); await f.page.onShow();
    const before = { start: f.page.data.start, end: f.page.data.end, subjectId: f.page.data.subjectId };
    f.download = () => Promise.reject(Object.assign(new Error('原始导出权限提示'), { status: 403 }));
    await f.page.exportReport();
    assert.equal(f.page.data.error, '原始导出权限提示');
    assert.equal(f.page.data.exporting, false);
    assert.equal(f.shares.length, 0);
    for (const key of Object.keys(before)) assert.equal(f.page.data[key], before[key]);
  });
}

test('paper: selecting questions and rounds presents readable answers and ignores an old detail response', async () => {
  const f = harness('paper'); await f.page.onShow();
  await f.page.openSession(event('', { id: 'session-class-a' }));
  assert.equal(f.page.data.question.multiple, true);
  assert.equal(f.page.data.answerRows[2].statusText, '未完成');
  f.page.onRoundChange(event(1));
  assert.match(metricValue(f.page.data.round.metrics, 'accuracy'), /练习/);
  f.page.onQuestionChange(event(1));
  assert.equal(f.page.data.answerRows[0].answerText, 'A（正确）');
  f.page.onQuestionChange(event(2));
  assert.equal(f.page.data.round.closed, false);
  assert.equal(f.page.data.answerRows.length, 0);
  const old = deferred(), normal = f.route;
  f.route = url => url === '/api/card-quiz/sessions/session-class-a' ? old.promise : normal(url);
  const pending = f.page.loadSession('session-class-a');
  await f.page.onClassChange(event(1));
  old.resolve(paperPayload()); await pending;
  assert.equal(f.page.data.detail, null);
  assert.equal(f.page.data.classId, 'class-b');
});

test('homework: a stale profile cannot overwrite new terms or start a report request', async () => {
  const f = harness('homework'), old = deferred(), normal = f.route;
  f.route = url => url.includes('/classes/class-a/profile') ? old.promise : normal(url);
  const pending = f.page.onShow(); await flush();
  await f.page.onClassChange(event(1));
  old.resolve({ classId: 'class-a', value: { terms: [{ id: 'old', label: '过期学期' }] } });
  await pending;
  assert.equal(f.page.data.terms[1].id, 'term-class-b');
  assert.equal(f.calls.some(call => call.url.startsWith('/api/homework/report?') && call.url.includes('classId=class-a')), false);
});

test('homework: filters reset pagination, paging retains totals, export retains the complete filter', async () => {
  const f = harness('homework'); await f.page.onShow();
  f.page.onTermChange(event(1)); f.page.onSubjectChange(event(2));
  f.page.onDateChange(event('2026-11-01', { field: 'start' }));
  assert.equal(f.page.data.report, null);
  await f.page.queryReport();
  await f.page.nextPage();
  assert.equal(f.page.data.page, 2);
  assert.equal(metricValue(f.page.data.report.metrics, 'expected'), '128');
  let params = new URL(f.calls.at(-1).url, 'https://mock.invalid').searchParams;
  assert.equal(params.get('page'), '2'); assert.equal(params.get('pageSize'), '30');
  assert.equal(params.get('termId'), 'term-class-a'); assert.equal(params.get('subjectId'), 'math');
  await f.page.exportReport();
  params = new URL(f.downloads[0], 'https://mock.invalid').searchParams;
  assert.equal(params.get('start'), '2026-11-01');
  assert.equal(params.get('termId'), 'term-class-a'); assert.equal(params.get('subjectId'), 'math');
  assert.equal(params.has('page'), false);
  f.page.onGroupChange(event(1));
  assert.equal(f.page.data.page, 1);
  assert.equal(f.page.data.report, null);
  await f.page.queryReport();
  assert.equal(f.page.data.report.group, 'students');
  assert.equal(f.page.data.report.rows[0].name, '学生0');
});

test('editing a date invalidates an in-flight report and invalid dates are never sent', async () => {
  for (const name of ['homework', 'reading']) {
    const f = harness(name); await f.page.onShow();
    const old = deferred(), normal = f.route;
    f.route = url => url.startsWith('/api/' + name + '/report?') ? old.promise : normal(url);
    const pending = f.page.queryReport(); await flush();
    f.page.onDateChange(event('2026-11-20', { field: 'start' }));
    old.resolve(name === 'homework' ? homeworkPayload() : readingPayload()); await pending;
    assert.equal(f.page.data.report, null);
    const before = f.calls.length;
    await f.page.queryReport();
    assert.match(f.page.data.error, /开始日期/);
    assert.equal(f.calls.length, before);
  }
});

test('file sharing cancellation and unsupported clients have explicit outcomes', async () => {
  assert.equal(await reports.shareFile({ shareFileMessage: options => options.fail({ errMsg: 'shareFileMessage:fail cancel' }) }, 'temp', '统计.csv'), false);
  await assert.rejects(reports.shareFile({}, 'temp', '统计.csv'), /更新微信/);
  await assert.rejects(reports.shareFile({ shareFileMessage: options => options.fail({ errMsg: 'share failed' }) }, 'temp', '统计.csv'), /文件分享失败/);
});

test('native templates have valid handlers, accessible filters and unescaped WXML operators', () => {
  for (const name of pageNames) {
    const f = harness(name), dir = path.join(root, 'pages', name);
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    const markup = fs.readFileSync(path.join(dir, 'index.wxml'), 'utf8');
    const style = fs.readFileSync(path.join(dir, 'index.wxss'), 'utf8');
    assert.equal(config.enablePullDownRefresh, true);
    assert.ok(config.navigationBarTitleText);
    assert.doesNotMatch(markup, /<web-view\b|<canvas\b|<img\b|<iframe\b/);
    for (const expression of markup.matchAll(/\{\{([\s\S]*?)\}\}/g)) assert.doesNotMatch(expression[1], /&(?:amp|lt|gt);/);
    for (const handler of markup.matchAll(/bind(?:tap|change)="([^"]+)"/g)) assert.equal(typeof f.page[handler[1]], 'function', name + ': ' + handler[1]);
    for (const picker of markup.matchAll(/<picker\b[^>]*?(?=>)/g)) assert.match(picker[0], /aria-label=/);
    assert.match(markup, /login-required\.wxml/);
    assert.match(style, /min-height:\s*44px/);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), /setInterval\s*\(|setTimeout\s*\(/);
  }
});

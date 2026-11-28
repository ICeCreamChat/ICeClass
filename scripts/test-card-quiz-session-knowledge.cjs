'use strict';

const assert = require('node:assert/strict');
const {after, before, test} = require('node:test');
const {chromium} = require('playwright');
const {open, navigate} = require('./test-teacher-ui.cjs');

let browser;
before(async () => { browser = await chromium.launch({channel: 'msedge', headless: true}); });
after(async () => { await browser?.close(); });

const startedAt = Date.UTC(2026, 10, 20, 1);
const tag = '交集 <A & B>';
const zero = {samples: 0, correct: 0, wrong: 0, exempt: 0, abstained: 0, ungraded: 0, accuracy: null};
const reportPath = '/api/card-quiz/report';
async function fitsPage(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
}

test('教师可用键盘按需展开 60 人的本节知识点明细', async t => {
  const roster = Array.from({length: 60}, (_, i) => ({id: 's' + i, name: '虚构学生' + (i + 1), cardNumber: i + 1}));
  const students = roster.map((s, i) => ({
    studentId: s.id, studentName: s.name, ...zero, wrongQuestionNumbers: i === 0 ? [1] : [],
    samples: i < 2 ? 1 : 0, wrong: Number(i === 0), correct: Number(i === 1),
    exempt: Number(i === 2), abstained: Number(i > 2)
  }));
  const totals = {...zero, samples: 2, correct: 1, wrong: 1, accuracy: 0.5, exempt: 1, abstained: 57};
  const round = {id: 'r1', purpose: 'formal', status: 'closed', noCardPolicy: 'abstain', ...totals,
    students: students.map((s, i) => ({...s, status: ['wrong', 'correct', 'exempt'][i] || 'abstained',
      option: ['B', 'A'][i] || null}))};
  const q = {id: 'q1', text: '两集合的交集', type: 'single', tags: [tag, '集合'], answer: 'A',
    options: ['甲', '乙'], rounds: [round]};
  const session = {id: 'lesson', subjectId: 'math', startedAt, endedAt: startedAt + 1000, roster, questions: [q]};
  const knowledge = q.tags.map(tag => ({tag, questionCount: 1, ...totals, students, wrongQuestionNumbers: [1]}));
  const {page, context, requests, errors} = await open(browser, {handle: ({url}) => {
    if (url.pathname === reportPath) return {json: {sessions: [{...session, questionCount: 1}], students: [], knowledge: []}};
    if (url.pathname === '/api/card-quiz/sessions/lesson') return {json: {session, revision: 1,
      report: {totals, questions: [q], students, knowledge}}};
  }});
  t.after(() => context.close());
  await navigate(page, 'card-quiz');
  await page.getByRole('button', {name: '课堂报告'}).click();
  await page.getByRole('button', {name: '查看与修订'}).click();
  const topics = page.locator('details[data-cq-topic]');
  const summary = topics.first().locator('summary');
  assert.match(await summary.innerText(), /交集 <A & B> · 仅 1 题 · 正确 1 \/ 已判定 2 · 错误 1/);
  assert.equal(await topics.locator('table').count(), 0);
  await summary.press('Enter');
  const region = page.getByRole('region', {name: tag + '的学生明细'});
  await region.waitFor();
  assert.equal(await region.locator('tbody tr').count(), 60);
  assert.match(await region.locator('tbody tr').first().innerText(), /虚构学生1.*1 号[\s\S]*第 1 题/);
  assert.match(await region.locator('tbody tr').nth(2).innerText(), /暂无判定样本[\s\S]*免答 1/);
  assert.match(await region.locator('tbody tr').last().innerText(), /弃权 1/);
  assert.equal(await topics.last().locator('table').count(), 0);
  await fitsPage(page);
  await page.setViewportSize({width: 390, height: 844});
  await summary.focus();
  await page.keyboard.press('Tab');
  assert.ok(await region.evaluate(node => document.activeElement === node));
  await fitsPage(page);
  await summary.press('Space');
  await region.waitFor({state: 'hidden'});
  await summary.press('Enter');
  assert.equal(await region.locator('table').count(), 1);
  assert.equal(requests.filter(r => r.path === '/api/card-quiz/sessions/lesson').length, 1);
  assert.deepEqual(errors, []);
});

test('学生切换课堂时只更新本节证据，跨课统计及原题号可核对', async t => {
  const identity = {id: 'own', username: '2610101', className: '测试班', cardNumber: 1};
  const latest = {id: 'recent', subjectId: 'math', className: '测试班', startedAt, knowledge: [
    {tag, questionCount: 1, ...zero, abstained: 1, wrongQuestionNumbers: []}]};
  const earlier = {...latest, id: 'earlier', startedAt: startedAt - 86400000, knowledge: [
    {tag: '数轴', questionCount: 2, ...zero, correct: 1, samples: 2, wrong: 1, wrongQuestionNumbers: [3]}]};
  const empty = {...earlier, id: 'empty', startedAt: earlier.startedAt - 86400000, knowledge: []};
  const record = {sessionId: earlier.id, questionNumber: 3, text: '数轴上的点', type: 'single', options: ['甲', '乙'],
    tags: ['数轴'], purpose: 'formal', status: 'wrong', answer: 'B', option: 'A', isOfficial: true,
    counted: false, startedAt: earlier.startedAt};
  const report = {accountId: 'own', totals: {...zero, samples: 1, correct: 1, accuracy: 1},
    knowledge: [{tag: '跨课标签', subjectId: 'math', questionCount: 1, samples: 1, correct: 1, accuracy: 1}],
    records: [record], sessions: [empty, earlier, latest]};
  const {page, context, requests, errors} = await open(browser, {authenticated: false, width: 390, handle: ({url}) => {
    if (url.pathname === '/api/student/session') return {json: {authenticated: true, student: identity}};
    if (url.pathname === '/api/student/report') return {json: report};
    if (url.pathname === '/api/student/report/earlier/analysis') return {json: {accountId: identity.id, sessionId: earlier.id, status: 'insufficient'}};
  }});
  t.after(() => context.close());
  const priorRequests = requests.length;
  await page.goto('http://127.0.0.1/card-quiz/student.html');
  await page.getByRole('button', {name: '所有作答记录'}).click();
  const recordText = await page.locator('.student-record summary').innerText();
  assert.match(recordText, /第 3 题.*数轴上的点/);
  assert.match(recordText, /本节正式记录 · 跨课汇总已采用后续作答/);
  await page.getByRole('button', {name: '知识点统计'}).press('Enter');
  const select = page.getByRole('combobox', {name: '选择课堂'});
  const lesson = page.locator('#student-lesson-knowledge');
  assert.equal(await select.inputValue(), latest.id);
  assert.match(await lesson.innerText(), /仅 1 题 · 正确 0 \/ 已判定 0 · 错误 0 · 弃权 1/);
  await select.press('ArrowDown');
  assert.equal(await select.inputValue(), earlier.id);
  assert.match(await lesson.innerText(), /数轴[\s\S]*2 题 · 正确 1 \/ 已判定 2 · 错误 1（第 3 题）/);
  await fitsPage(page);
  await select.press('End');
  assert.match(await lesson.innerText(), /暂无带知识点标签的已封存正式题/);
  assert.match(await page.getByRole('region', {name: '本人知识点统计'}).innerText(), /跨课标签/);
  assert.ok(requests.slice(priorRequests).every(r => r.path.startsWith('/api/student/')));
  assert.deepEqual(errors, []);
});

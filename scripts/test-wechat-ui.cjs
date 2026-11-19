'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appRoot = path.resolve(__dirname, '../miniprogram/teacher');

function loadPage(name, supplied = {}) {
  let definition;
  const actions = [];
  const api = Object.assign({ getUser: () => ({ id: 'test-teacher', permissions: {} }), getPersistenceWarning: () => '', request: async () => ({}) }, supplied.api);
  const ui = Object.assign({ requireLogin: () => true, confirm: async () => true, setDirty() {}, fail(page, error) { page.setData({ error: error.message }); }, relogin() {}, query: () => '', formatTime: () => '', toast() {} }, supplied.ui);
  const runtime = Object.assign({ navigateBack: () => actions.push('back'), navigateTo: options => actions.push(options.url), reLaunch: options => actions.push(options.url), stopPullDownRefresh() {} }, supplied.wx);
  const filename = path.join(appRoot, 'pages', name, 'index.js');
  const context = vm.createContext({ Page: value => { definition = value; }, wx: runtime, getCurrentPages: () => [null, definition], console, setTimeout, clearTimeout, require: name => name.endsWith('/api') ? api : name.endsWith('/ui') ? ui : require(path.resolve(path.dirname(filename), name)) });
  new vm.Script(fs.readFileSync(filename, 'utf8'), { filename }).runInContext(context);
  definition.data = JSON.parse(JSON.stringify(definition.data || {}));
  definition.setData = values => {
    for (const [key, value] of Object.entries(values)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
      let target = definition.data;
      parts.slice(0, -1).forEach(part => { target = target[part]; });
      target[parts.at(-1)] = value;
    }
  };
  return { page: definition, actions, api, ui, runtime };
}

test('all registered native pages and template event handlers exist', () => {
  const config = JSON.parse(fs.readFileSync(path.join(appRoot, 'app.json')));
  for (const route of config.pages) {
    const name = route.split('/')[1];
    const { page } = loadPage(name);
    const template = fs.readFileSync(path.join(appRoot, route + '.wxml'), 'utf8');
    for (const match of template.matchAll(/(?:bind|catch):?(?:tap|input|change|submit|confirm|blur|focus|longpress)="([A-Za-z_$][\w$]*)"/g)) {
      assert.equal(typeof page[match[1]], 'function', `${route}: missing ${match[1]}`);
    }
    assert.ok(!/<web-view\b/.test(template));
  }
});

test('teacher login preserves password characters and returns to the retained page', async () => {
  let credentials;
  const { page, actions } = loadPage('login', { api: { login: async (...args) => { credentials = args; } } });
  page.setData({ username: ' teacher ', password: ' aPassword123 ' });
  await page.submit();
  assert.deepEqual(credentials, [' teacher ', ' aPassword123 ']);
  assert.equal(page.data.password, '');
  assert.deepEqual(actions, ['back']);
});

test('a paper question conflict retains the draft and blocks repeated save until reloaded', async () => {
  let count = 0;
  const error = Object.assign(new Error('其他教师已修改题目。'), { status: 409 });
  const { page } = loadPage('questions', { api: { request: async () => { count++; throw error; } } });
  const draft = require('../miniprogram/teacher/lib/question-data').draft();
  draft.id = 'q-1'; draft.revision = 2; draft.text = '尚未保存的修改';
  page.setData({ editor: draft, dirty: true });
  await page.saveQuestion();
  assert.equal(page.data.editor.text, '尚未保存的修改');
  assert.equal(page.data.conflict, true);
  await page.saveQuestion(); assert.equal(count, 1);
});

test('an ambiguous new question save preserves its draft and blocks a duplicate creation', async () => {
  let count = 0;
  const error = Object.assign(new Error('未能确认操作结果。'), { ambiguous: true });
  const { page } = loadPage('questions', { api: { request: async () => { count++; throw error; } } });
  const draft = require('../miniprogram/teacher/lib/question-data').draft(); draft.text = '尚未确认的题目';
  page.setData({ editor: draft, dirty: true });
  await page.saveQuestion(); await page.saveQuestion();
  assert.equal(count, 1); assert.equal(page.data.uncertain, true); assert.equal(page.data.editor.text, draft.text);
});

test('leaving during publication or deletion confirmation cannot dispatch those writes', async () => {
  for (const action of ['publish', 'deleteQuestion', 'withdraw']) {
    let finish; let count = 0;
    const { page } = loadPage('questions', { api: { request: async () => { count++; } }, ui: { confirm: () => new Promise(resolve => { finish = resolve; }) } });
    page.setData({ classId: 'class-1', classNames: ['测试班'], decks: [{ id: 'item-1', title: '测试题单', questionIds: ['q1'], revision: 1 }], bank: [{ id: 'item-1', text: '测试题目', revision: 1 }], publications: [{ id: 'item-1', title: '测试发布' }] });
    const pending = page[action]({ currentTarget: { dataset: { id: 'item-1' } } });
    page.onHide(); finish(true); await pending;
    assert.equal(count, 0, action); assert.equal(page.data.busy, false);
  }
});

test('classroom analysis waits for the current class context before using AI quota', async () => {
  let count = 0;
  const { page } = loadPage('banban', { api: { request: async () => { count++; } } });
  page.setData({ classId: 'class-1', input: '分析本班', loading: true });
  await page.send();
  assert.equal(count, 0); assert.equal(page.data.input, '分析本班');
});

test('Banban requires the teacher to review changed operation parameters', async () => {
  const { operationView } = require('../miniprogram/teacher/lib/banban-data');
  const raw = { id: 'op-1', kind: 'platform', title: '设置通知', target: '演示班', impact: '发送前确认通知', status: 'awaiting_confirmation', parameters: { text: '最初内容' } };
  let confirmations = 0, writes = 0;
  const { page } = loadPage('banban', {
    api: { request: async (_, options) => {
      if (options?.method === 'POST') writes++;
      return { ...raw, parameters: { text: '内容已改变' } };
    } },
    ui: { confirm: async () => { confirmations++; return true; } }
  });
  page._visible = true; page._generation = 1;
  page.setData({ operations: [operationView(raw, String)], reviewingId: raw.id });
  await page.commitOperation({ currentTarget: { dataset: { id: raw.id, decision: 'confirm' } } });
  assert.match(page.data.operationWarning, /重新核对/);
  assert.equal(page.data.operations[0].fields[0].value, '内容已改变');
  assert.equal(confirmations, 0);
  assert.equal(writes, 0);
});

test('Banban protects a confirmation with no response until a fresh service status arrives', async () => {
  const { operationView } = require('../miniprogram/teacher/lib/banban-data');
  const raw = { id: 'op-1', kind: 'platform', title: '设置通知', target: '演示班', impact: '发送前确认通知', status: 'awaiting_confirmation', parameters: { text: '通知内容' } };
  let writes = 0;
  const { page } = loadPage('banban', { api: { request: async (url, options) => {
    if (options?.method === 'POST') {
      writes++;
      throw Object.assign(new Error('未能确认操作结果'), { ambiguous: true });
    }
    return url.endsWith('/operations') ? { operations: [{ ...raw, status: 'succeeded' }] } : raw;
  } } });
  page._visible = true; page._generation = 1;
  page.setData({ operations: [operationView(raw, String)], reviewingId: raw.id });
  const event = { currentTarget: { dataset: { id: raw.id, decision: 'confirm' } } };
  await page.commitOperation(event);
  assert.equal(page.data.uncertainOperationId, raw.id);
  await page.commitOperation(event);
  assert.equal(writes, 1);
  await page.refreshOperations();
  assert.equal(page.data.operations[0].statusText, '已完成');
  assert.equal(page.data.uncertainOperationId, '');
  await page.commitOperation(event);
  assert.equal(writes, 1);
});

test('a classroom voice confirmation is locked and cancelled when the page is hidden', async () => {
  let finish; let count = 0;
  const { page } = loadPage('voice', { api: { request: async () => { count++; } }, ui: { confirm: () => new Promise(resolve => { finish = resolve; }) } });
  page.setData({ messages: [{ id: 'voice-1', class_name: '测试班', time: '12:00' }] });
  const event = { currentTarget: { dataset: { id: 'voice-1' } } };
  const pending = page.remove(event); page.onHide(); await page.remove(event);
  assert.equal(page.data.busy, true);
  finish(true); await pending;
  assert.equal(count, 0); assert.equal(page.data.busy, false);
});

test('invalid new password is rejected locally before contacting the server', async () => {
  let count = 0;
  const { page } = loadPage('account', { api: { request: async () => { count++; } } });
  for (const password of ['abc12345', 'abcdefghijk', '12345678901']) {
    page.setData({ currentPassword: 'validOld123', newPassword: password, repeatPassword: password });
    await page.password();
    assert.ok(page.data.error); assert.equal(count, 0);
  }
});

test('password confirmation locks repeated taps and cannot submit after leaving the account page', async () => {
  let confirm;
  let count = 0;
  let confirmations = 0;
  const { page } = loadPage('account', { api: { request: async () => { count++; } }, ui: { confirm: () => { confirmations++; return new Promise(resolve => { confirm = resolve; }); } } });
  page.onShow();
  page.setData({ currentPassword: 'oldPassword123', newPassword: 'newPassword123', repeatPassword: 'newPassword123' });
  const pending = page.password();
  await page.password();
  assert.equal(confirmations, 1); assert.equal(page.data.busy, true);
  page.onHide(); confirm(true); await pending;
  assert.equal(count, 0); assert.equal(page.data.newPassword, 'newPassword123'); assert.equal(page.data.busy, false);
});

test('home navigation is limited to registered local pages', () => {
  const { page, actions } = loadPage('workbench');
  page.open({ currentTarget: { dataset: { page: 'paper' } } });
  page.open({ currentTarget: { dataset: { page: 'https://example.com' } } });
  assert.deepEqual(actions, ['/pages/paper/index']);
});

function sharedUi(api, runtime, pages) {
  const module = { exports: {} };
  const filename = path.join(appRoot, 'lib/ui.js');
  const context = vm.createContext({ require: () => api, module, wx: runtime, getCurrentPages: () => pages });
  new vm.Script(fs.readFileSync(filename, 'utf8'), { filename }).runInContext(context);
  return module.exports;
}

test('returning to an existing page after switching account opens a fresh workbench', () => {
  const actions = [];
  const ui = sharedUi({ getUser: () => ({ id: 'new' }) }, { reLaunch: options => actions.push(options.url) }, [{ _iceclassOwner: 'old' }]);
  assert.equal(ui.requireLogin(), false);
  assert.deepEqual(actions, ['/pages/workbench/index']);
});

test('stale class reads cannot update hidden pages or change the shared selection', async () => {
  let finish;
  let selected = 'new-class';
  let updates = 0;
  const api = { getUser: () => ({ id: 'teacher' }), getClassId: () => selected, selectClass: value => { selected = value; }, request: () => new Promise(resolve => { finish = resolve; }) };
  const ui = sharedUi(api, {}, []);
  const page = { _generation: 1, data: {}, setData: () => { updates++; } };
  const promise = ui.loadClasses(page);
  page._generation++;
  finish({ classes: [{ id: 'old-class', name: '旧班级', enabled: true }] });
  await promise;
  assert.equal(updates, 0); assert.equal(selected, 'new-class');

  let active = true;
  const proxy = { data: {}, setData: () => { updates++; } };
  const pending = ui.loadClasses(proxy, () => active);
  active = false;
  finish({ classes: [{ id: 'old-class', name: '旧班级', enabled: true }] });
  await pending;
  assert.equal(updates, 0); assert.equal(selected, 'new-class');
});

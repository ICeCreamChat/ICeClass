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
  const ui = Object.assign({ requireLogin: () => true, confirm: async () => true, setDirty() {}, fail(page, error) { page.setData({ error: error.message }); }, relogin() {}, openAgreement() {}, applyAppearance() {}, query: () => '', formatTime: () => '', toast() {} }, supplied.ui);
  const runtime = Object.assign({ navigateBack: () => actions.push('back'), navigateTo: options => actions.push(options.url), reLaunch: options => actions.push(options.url), stopPullDownRefresh() {} }, supplied.wx);
  const filename = path.join(appRoot, 'pages', name, 'index.js');
  const context = vm.createContext({ Page: value => { definition = value; }, wx: runtime, getCurrentPages: supplied.getCurrentPages || (() => [null, definition]), console, setTimeout, clearTimeout, require: name => name.endsWith('/api') ? api : name.endsWith('/ui') ? ui : require(path.resolve(path.dirname(filename), name)) });
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
    const filename = path.join(appRoot, route + '.wxml');
    const template = fs.readFileSync(filename, 'utf8').replace(/<include src="([^"]+)"\s*\/>/g,
      (_, relative) => fs.readFileSync(path.resolve(path.dirname(filename), relative), 'utf8'));
    for (const match of template.matchAll(/(?:bind|catch):?(?:tap|input|change|submit|confirm|blur|focus|longpress|agreeprivacyauthorization)="([A-Za-z_$][\w$]*)"/g)) {
      assert.equal(typeof page[match[1]], 'function', `${route}: missing ${match[1]}`);
    }
    assert.ok(!/<web-view\b/.test(template));
  }
});

const tap = dataset => ({ currentTarget: { dataset } });
const consent = (page, accepted = true) => page.changeConsent({ detail: { value: accepted ? ['agree'] : [] } });

test('login waits for an unchecked-by-default consent choice before contacting the school', async () => {
  let submissions = 0;
  const { page } = loadPage('login', { api: { login: async () => { submissions++; } } });
  page.setData({ username: 'school-teacher', password: 'school-password' });
  assert.equal(page.data.accepted, false);
  await page.submit();
  assert.match(page.data.error, /先阅读协议并勾选同意/);
  consent(page); consent(page, false);
  await page.submit();
  assert.equal(submissions, 0);
});

test('teacher login preserves password characters and returns to the retained page', async () => {
  let credentials;
  const { page, actions } = loadPage('login', { api: { login: async (...args) => { credentials = args; } } });
  page.setData({ username: ' teacher ', password: ' aPassword123 ' });
  consent(page);
  await page.submit();
  assert.deepEqual(credentials.slice(0, 2), [' teacher ', ' aPassword123 ']);
  assert.equal(credentials[2](), false);
  assert.equal(page.data.password, '');
  assert.deepEqual(actions, ['back']);
});

test('both agreements open independently before login without checking consent', () => {
  const targets = [];
  const shared = sharedUi({}, { navigateTo: options => targets.push(options.url) }, []);
  const { page } = loadPage('login', { ui: shared });
  page.openAgreement(tap({ document: 'terms' }));
  page.openAgreement(tap({ document: 'privacy' }));
  assert.deepEqual(targets, ['/pages/privacy/index?document=terms', '/pages/privacy/index']);
  for (const document of ['terms', 'privacy']) {
    const { page: agreement } = loadPage('privacy');
    agreement.onLoad({ document });
    assert.equal(agreement.data.terms, document === 'terms');
  }
  assert.equal(page.data.accepted, false);
});

test('logged out workbench stays public after cancelling or backing out of login', () => {
  let restores = 0, opens = 0;
  const { page: home, actions } = loadPage('workbench', {
    api: { getUser: () => null, restoreSession: () => { restores++; } },
    ui: { relogin: () => { opens++; } }
  });
  home.onShow(); home.onPullDownRefresh();
  home.relogin();
  const { page: login, actions: loginActions } = loadPage('login');
  login.leave();
  home.onShow();
  home.relogin();
  const { page: nextLogin } = loadPage('login');
  nextLogin.onHide(); nextLogin.onUnload(); home.onShow();
  home.open(tap({ page: 'notices' }));
  assert.equal(opens, 2);
  assert.equal(restores, 0);
  assert.equal(home.data.user, null);
  assert.equal(home.data.classes.length, 0);
  assert.deepEqual(loginActions, ['back']);
  assert.deepEqual(actions, []);
});

test('a login entered as the first page can still be cancelled to the public workbench', () => {
  const { page, actions } = loadPage('login', { getCurrentPages: () => [{}] });
  page.leave();
  assert.deepEqual(actions, ['/pages/workbench/index']);
});

test('cancelling or leaving before a login response never persists the late session', async () => {
  const { createClient } = require('../miniprogram/teacher/lib/api');
  for (const exit of ['button', 'system-back', 'hidden']) {
    let response;
    const storage = new Map();
    const api = createClient({
      getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
      request: options => { response = options; }
    });
    const { page, actions } = loadPage('login', { api });
    page.setData({ username: 'teacher', password: 'secret' });
    consent(page);
    const pending = page.submit();
    if (exit === 'button') page.leave();
    else { page.onHide(); if (exit === 'system-back') page.onUnload(); }
    response.success({ statusCode: 200, cookies: ['iceclass_session=test-cookie; Max-Age=600'],
      data: { user: { id: 'teacher', csrfToken: 'test-csrf' } } });
    await pending;
    assert.equal(page.data.password, '');
    assert.equal(api.getUser(), null);
    assert.equal(storage.size, 0);
    assert.deepEqual(actions, exit === 'button' ? ['back'] : []);
  }
});

test('only one login navigation happens while a tap is still being handled', () => {
  let count = 0;
  let complete;
  const pages = [{ route: 'pages/workbench/index' }];
  const ui = sharedUi({}, { navigateTo: options => { count++; complete = options.complete; } }, pages);
  ui.relogin(); ui.relogin();
  assert.equal(count, 1);
  pages.push({ route: 'pages/login/index' }); complete();
  ui.relogin();
  assert.equal(count, 1);
});

test('workbench clears previous class data when a restored session expires', async () => {
  let current = { id: 'teacher' };
  const { page, actions } = loadPage('workbench', { api: { getUser: () => current, restoreSession: async () => current },
    ui: { loadClasses: async () => { current = null; throw Object.assign(new Error('Expired'), { status: 401 }); } } });
  page.setData({ user: current, classes: [{ id: 'private' }], classNames: ['上次班级'], classId: 'private' });
  await page.load();
  assert.equal(page.data.user, null);
  assert.equal(page.data.classId, '');
  assert.equal(page.data.classNames.length, 0);
  assert.deepEqual(actions, []);
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

test('question photo selection never sends a file without permission and upload confirmation', async () => {
  const model = require('../miniprogram/teacher/lib/question-data');
  for (const stop of ['privacy', 'picker', 'confirm', 'leave-during-read', 'success']) {
    let reads = 0, picked = 0, uploaded = 0, finishRead;
    const { page } = loadPage('questions', {
      api: { request: async (url, options) => {
        assert.equal(url, '/api/card-quiz/images');
        assert.equal(options.data.dataUrl, 'data:image/png;base64,YQ==');
        uploaded++; return { id: 'new-image' };
      } },
      ui: { confirm: async () => stop !== 'confirm' },
      wx: {
        getPrivacySetting: options => options.success({ needAuthorization: stop === 'privacy' }),
        chooseMessageFile(options) {
          picked++;
          if (stop === 'picker') options.fail({ errMsg: 'chooseMessageFile:fail cancel' });
          else options.success({ tempFiles: [{ path: '/test/file.png', name: 'file.png', size: 10 }] });
        },
        getFileSystemManager: () => ({ readFile(options) {
          reads++;
          if (stop === 'leave-during-read') finishRead = options.success;
          else options.success({ data: 'YQ==' });
        } })
      }
    });
    const draft = model.draft();
    draft.text = '原题目'; draft.imageId = 'old-image';
    page.setData({ editor: draft, dirty: true });
    const pending = page.image();
    await new Promise(setImmediate);
    if (stop === 'privacy') { assert.equal(page.data.privacyNeeded, true); page.cancelDevicePrivacy(); }
    if (stop === 'leave-during-read') { page.onHide(); finishRead({ data: 'YQ==' }); }
    await pending;
    assert.equal(picked, stop === 'privacy' ? 0 : 1, stop);
    assert.equal(reads, ['leave-during-read', 'success'].includes(stop) ? 1 : 0, stop);
    assert.equal(uploaded, stop === 'success' ? 1 : 0, stop);
    assert.equal(page.data.editor.text, '原题目');
    assert.equal(page.data.editor.imageId, stop === 'success' ? 'new-image' : 'old-image');
    assert.equal(page.data.busy, false);
  }
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

test('teachers and administrators get the same classroom tools with management still scoped to their role', async () => {
  for (const user of [{ id: 'teacher', role: 'teacher' }, { id: 'admin', role: 'superadmin', permissions: { manageClasses: true, manageUsers: true, controlClassrooms: true } }]) {
    const { page, actions } = loadPage('workbench', { api: { restoreSession: async () => user }, ui: { loadClasses: async () => [] } });
    await page.load();
    for (const entry of ['paper', 'questions', 'notices', 'reading', 'homework', 'island']) {
      page.open({ currentTarget: { dataset: { page: entry } } });
      assert.equal(actions.at(-1), '/pages/' + entry + '/index');
    }
    for (const entry of ['banban', 'study', 'connection-settings', 'quota-settings']) page.open({ currentTarget: { dataset: { page: entry } } });
    assert.equal(actions.length, 6);
    assert.equal(page.data.management.length, user.role === 'superadmin' ? 3 : 0);
  }
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
  const page = { _iceclassOwner: 'old', data: {}, setData(values) { Object.assign(this.data, values); } };
  const ui = sharedUi({ getUser: () => ({ id: 'new' }) }, { reLaunch: options => actions.push(options.url) }, [page]);
  assert.equal(ui.requireLogin(), false);
  assert.equal(page.data.sessionExpired, true);
  assert.deepEqual(actions, ['/pages/workbench/index']);
});

test('an expired protected page allows same-account re-login without losing its draft', () => {
  let user = { id: 'teacher' };
  const page = { route: 'pages/notices/index', data: { text: '待发送草稿' }, setData(values) { Object.assign(this.data, values); } };
  const ui = sharedUi({ getUser: () => user }, {}, [page]);
  assert.equal(ui.requireLogin(), true);
  user = null;
  assert.equal(ui.requireLogin(), false);
  assert.equal(page.data.sessionExpired, true);
  ui.fail(page, new Error('Some older asynchronous error'));
  assert.equal(page.data.sessionExpired, true);
  user = { id: 'teacher' };
  assert.equal(ui.requireLogin(), true);
  assert.equal(page.data.sessionExpired, false);
  assert.equal(page.data.text, '待发送草稿');
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

'use strict';

// node --test scripts/test-banban-steward.cjs — real frontend modules, isolated DOM and API, no live business data.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web_controller/banban-operations.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(__dirname, '../web_controller/banban.js'), 'utf8');
const clone = value => structuredClone(value);
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent(event) { for (const fn of this.listeners.get(event.type) || []) fn(event); }
  emit(type) { return Promise.all([...this.listeners.get(type) || []].map(fn => fn({type, target:this, currentTarget:this}))); }
}
class Element extends Events {
  constructor(tag, document) {
    super(); Object.assign(this, {tagName:tag.toUpperCase(), document, children:[], dataset:{}, attributes:new Map(), className:'', value:'', _text:'', disabled:false, hidden:false, open:false});
    this.classList = {
      contains: value => this.className.split(/\s+/).includes(value),
      add: value => { if (!this.classList.contains(value)) this.className = `${this.className} ${value}`.trim(); },
      remove: value => { this.className = this.className.split(/\s+/).filter(v => v !== value).join(' '); }
    };
  }
  get isConnected() { return this === this.document.body || Boolean(this.parentElement?.isConnected); }
  get textContent() { return this._text + this.children.map(e => e.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...items) {
    for (const item of items) {
      if (item.parentElement) item.parentElement.children = item.parentElement.children.filter(e => e !== item);
      item.parentElement = this; this.children.push(item);
    }
  }
  replaceChildren(...items) {
    if (this.contains(this.document.activeElement)) this.document.activeElement = this.document.body;
    for (const item of this.children) item.parentElement = null;
    this.children = []; this._text = ''; this.append(...items);
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  matches(selector) {
    return selector.split(',').some(value => {
      value = value.trim();
      if (value.startsWith('.')) return this.classList.contains(value.slice(1));
      if (value.startsWith('#')) return this.id === value.slice(1);
      const match = value.match(/^([a-z]+)?(?:\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\])?$/i);
      if (!match) return false;
      const [, tag, key, expected] = match;
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      if (!key) return Boolean(tag);
      const actual = key.startsWith('data-') ? this.dataset[key.slice(5)] : this[key] ?? this.getAttribute(key);
      return expected === undefined ? actual !== undefined && actual !== null && actual !== false : actual === expected;
    });
  }
  querySelectorAll(selector) { return this.children.flatMap(e => [...(e.matches(selector) ? [e] : []), ...e.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  contains(other) { return this === other || this.children.some(e => e.contains(other)); }
  focus() { if (!this.disabled && this.isConnected) this.document.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  getClientRects() { return this.hidden || this.closest('.hidden') ? [] : [{}]; }
  click() { if (!this.disabled) return this.emit('click'); }
}
const clientId = 'teacher-client-1234', documentId = 'browser-document-1234';
const action = {id:'teacher.settings', title:'打开教师端设置', fields:[], confirmation:false};
const nativeOperation = (id = 'native-one', extra = {}) => ({id, kind:'teacher', action:action.id, title:action.title, clientId, status:'awaiting_client', parameters:{}, updatedAt:1, expiresAt:Date.now() + 300000, ...extra});
const importOperation = (id = 'import-one') => ({id, kind:'platform', action:'island.import', title:'导入课表', input:'island-import', status:'awaiting_input', parameters:{}, updatedAt:1, expiresAt:Date.now() + 300000});

function setup(options = {}) {
  const document = new Events(); document.hidden = false;
  document.createElement = tag => new Element(tag, document);
  document.body = document.createElement('body'); document.activeElement = document.body;
  const root = document.createElement('section'); document.body.append(root);
  const nav = document.createElement('nav'); nav.id = 'mainNav'; document.body.append(nav);
  document.getElementById = id => document.body.querySelector(`#${id}`);
  document.querySelectorAll = selector => selector === '#mainNav button[data-view]' ? nav.querySelectorAll('button[data-view]') : document.body.querySelectorAll(selector);
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  const window = new Events(), server = new Map(), calls = [], executions = [], events = [], timers = new Map();
  let nextTimer = 0, refreshes = 0, catalogCalls = 0;
  window.location = {origin:'http://127.0.0.1:8891', href:'http://127.0.0.1:8891/'};
  window.crypto = {randomUUID:() => documentId};
  window.getComputedStyle = () => ({visibility:'visible'});
  window.addEventListener('banban-operation-updated', event => events.push(clone(event.detail)));
  window.ICeClass = {state:{user:{id:'local-teacher'}, csrf:'local-csrf'}, refreshManagement:async () => { refreshes++; }, api:async (url, settings = {}) => {
    calls.push({url, ...settings});
    const segments = url.split('/'), id = decodeURIComponent(segments[4]), endpoint = segments[5];
    const previous = server.get(id);
    const payload = typeof settings.body === 'string' ? JSON.parse(settings.body) : null;
    if (options.intercept) {
      const intercepted = options.intercept({url, settings, id, endpoint, previous, payload, server});
      if (intercepted !== undefined) return intercepted;
    }
    if (!previous) throw new Error('操作不存在。');
    const save = update => { const result = {...previous, updatedAt:previous.updatedAt + 1, ...update}; server.set(id, result); return clone(result); };
    if (endpoint === 'client-start') {
      const claimed = previous.status === 'awaiting_client';
      return {claimed, operation:claimed ? save({status:'running'}) : clone(previous)};
    }
    if (endpoint === 'client-result') return save({status:!payload.verified ? 'unconfirmed' : payload.success ? 'succeeded' : 'failed', result:{detail:payload.detail}});
    if (endpoint === 'file') return save({status:'awaiting_confirmation', input:undefined, action:'island.update', parameters:{revision:'revision-2', config:{lessons:[{subject:'语文', teacher:'林老师'}]}}});
    if (endpoint === 'confirm') return save({status:previous.kind === 'teacher' ? 'awaiting_client' : 'succeeded'});
    if (endpoint === 'cancel') return save({status:'cancelled'});
    if (endpoint === 'private-result') return {code:'sensitive-654321'};
    return clone(previous);
  }};
  if (options.native !== false) window.ICeClassTeacherHost = {
    catalog:async () => { catalogCalls++; return options.catalog ? options.catalog() : {clientId, actions:[action]}; },
    execute:async (...args) => { executions.push(clone(args)); return options.execute ? options.execute(...args) : {success:true, verified:true, detail:'已打开设置。'}; }
  };
  const context = vm.createContext({window, document, URL, Date, Intl, CustomEvent:class {constructor(type, {detail}) {this.type = type; this.detail = detail;}},
    setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout(id) {timers.delete(id);} });
  vm.runInContext(source, context);
  const module = window.ICeClassBanbanOperations; module.mount(root);
  function render(operation, container = root) { server.set(operation.id, clone(operation)); return module.render(container, clone(operation)); }
  function page(view, title, {hidden = false, disabled = false, guard = false} = {}) {
    const control = document.createElement('button'); control.type = 'button'; control.dataset.view = view; control.textContent = title; control.disabled = disabled;
    if (hidden) control.className = 'hidden';
    nav.append(control);
    const surface = document.createElement('section'); surface.id = `view-${view}`; surface.className = 'view hidden'; document.body.append(surface);
    control.addEventListener('click', () => {
      if (guard) return;
      nav.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
      control.classList.add('active'); surface.classList.remove('hidden');
      module.invalidate(); // Same integration as banban.js's mainNav listener.
    });
    return {control, surface};
  }
  return {module, root, nav, document, window, server, calls, executions, events, timers, render, page, context,
    get refreshes() {return refreshes;}, get catalogCalls() {return catalogCalls;},
    async poll() { const entry = timers.entries().next().value; assert.ok(entry, 'pending operation schedules a poll'); timers.delete(entry[0]); await entry[1](); },
    control(card, key) { return card.querySelectorAll('button').find(e => e.dataset.control === key); }};
}

test('render, history hydration and polling never claim or execute native operations', async () => {
  const h = setup(), operation = nativeOperation(); h.render(operation);
  const history = h.document.createElement('div'); h.root.append(history);
  await h.module.hydrate(history, [{id:operation.id}]); await h.poll();
  assert.equal(h.root.querySelectorAll('.bb-operation').length, 2);
  assert.equal(h.calls.every(c => !c.method || c.method === 'GET'), true);
  assert.equal(h.catalogCalls, 0); assert.equal(h.executions.length, 0);
});

test('a live operation is claimed, executed and reported exactly once despite simultaneous duplicate events', async () => {
  const gate = defer(), h = setup({execute:() => gate.promise}), operation = nativeOperation('once', {parameters:{enabled:true}});
  h.render(operation);
  const running = h.module.live(operation); await flush();
  await Promise.all([h.module.live(operation), h.module.live(operation)]);
  assert.equal(h.executions.length, 1); assert.deepEqual(h.executions[0], [action.id, {enabled:true}, 'once']);
  gate.resolve({success:true, verified:true, detail:'已打开设置。'}); await running;
  await h.module.live(operation);
  assert.equal(h.calls.filter(c => c.url.endsWith('/client-start')).length, 1);
  const reports = h.calls.filter(c => c.url.endsWith('/client-result'));
  assert.equal(reports.length, 1);
  assert.deepEqual(JSON.parse(reports[0].body), {clientId, success:true, verified:true, detail:'已打开设置。'});
});

test('confirming a native action waits for a fresh live dispatch instead of executing from its card or polling', async () => {
  const h = setup(), operation = nativeOperation('confirmed-native', {status:'awaiting_confirmation'});
  const card = h.render(operation);
  await h.module.live(operation);
  assert.equal(h.executions.length, 0);
  await h.control(card, 'confirm').click();
  assert.equal(h.server.get(operation.id).status, 'awaiting_client');
  await h.poll();
  assert.equal(h.executions.length, 0);
  assert.equal(h.calls.filter(c => c.url.endsWith('/client-start')).length, 0);
  const ready = clone(h.server.get(operation.id));
  h.module.render(h.root, ready);
  await h.module.live(ready);
  await h.module.live(ready);
  assert.equal(h.executions.length, 1);
  assert.equal(h.calls.filter(c => c.url.endsWith('/client-start')).length, 1);
  assert.equal(h.server.get(operation.id).status, 'succeeded');
});

test('equal-millisecond or older pending events cannot replace a cached terminal result or start a new live dispatch', async () => {
  for (const status of ['succeeded', 'cancelled', 'unconfirmed']) {
    const h = setup(), finished = nativeOperation(`final-${status}`, {status, updatedAt:20, result:{detail:'已收到最终回执。'}});
    const card = h.render(finished);
    for (const updatedAt of [19, 20]) {
      const stale = nativeOperation(finished.id, {updatedAt});
      h.module.render(h.root, stale); await h.module.live(stale);
      assert.equal(card.dataset.state, status); assert.match(card.textContent, /已收到最终回执/);
    }
    assert.equal(h.calls.length, 0); assert.equal(h.catalogCalls, 0); assert.equal(h.executions.length, 0);
  }
});

test('a terminal update arriving during the catalog lookup prevents a later claim', async () => {
  const gate = defer(), h = setup({catalog:() => gate.promise}), operation = nativeOperation(); h.render(operation);
  const pending = h.module.live(operation);
  h.module.render(h.root, {...operation, status:'cancelled', result:{detail:'已取消。'}});
  gate.resolve({clientId, actions:[action]}); await pending;
  assert.equal(h.calls.length, 0); assert.equal(h.executions.length, 0);
});

test('wrong window, missing host, unavailable catalog and unsupported actions cannot claim a native action', async () => {
  for (const variant of ['wrong', 'missing', 'empty', 'unsupported']) {
    const h = setup({native:variant !== 'missing', catalog:variant === 'empty' ? () => ({clientId, actions:[]}) : undefined});
    const operation = nativeOperation(variant, variant === 'wrong' ? {clientId:'another-client-1234'} : variant === 'unsupported' ? {action:'teacher.unknown'} : {});
    h.render(operation); await h.module.live(operation);
    assert.equal(h.calls.length, 0, variant); assert.equal(h.executions.length, 0, variant);
  }
});

test('claimed false and a changed canonical claim cannot execute', async () => {
  for (const variant of ['unclaimed', 'changed']) {
    const h = setup({intercept:({endpoint, previous}) => endpoint === 'client-start'
      ? {claimed:variant !== 'unclaimed', operation:{...previous, status:'running', ...(variant === 'changed' ? {action:'teacher.changed'} : {})}} : undefined});
    const operation = nativeOperation(); h.render(operation); await h.module.live(operation);
    assert.equal(h.executions.length, 0);
    assert.equal(h.calls.filter(c => c.url.endsWith('/client-result')).length, variant === 'changed' ? 1 : 0);
  }
});

test('execution errors and ambiguous claims report unverified results without retrying the action', async () => {
  for (const variant of ['execute', 'claim', 'invalid-receipt']) {
    const h = setup({execute:() => { if (variant === 'execute') throw new Error('closed'); return {}; },
      intercept:({endpoint}) => { if (variant === 'claim' && endpoint === 'client-start') throw new Error('connection lost'); }});
    const operation = nativeOperation(); h.render(operation); await h.module.live(operation); await h.module.live(operation);
    assert.equal(h.calls.filter(c => c.url.endsWith('/client-start')).length, 1);
    const report = h.calls.find(c => c.url.endsWith('/client-result'));
    assert.ok(report, variant); assert.equal(JSON.parse(report.body).verified, false); assert.equal(JSON.parse(report.body).success, false);
    assert.equal(h.executions.length, variant === 'claim' ? 0 : 1);
  }
});

test('a failed result upload stays unconfirmed and never replays the successful host action', async () => {
  const h = setup({intercept:({endpoint}) => { if (endpoint === 'client-result') throw new Error('offline'); }}), operation = nativeOperation();
  const card = h.render(operation); await h.module.live(operation); await h.module.live(operation);
  assert.equal(h.executions.length, 1); assert.equal(card.dataset.state, 'unconfirmed');
  assert.match(card.textContent, /不会自动重试/);
});

test('dispose and navigation invalidate catalog and claim continuations before execution', async () => {
  for (const boundary of ['catalog', 'claim']) for (const leave of ['dispose', 'invalidate']) {
    const gate = defer(), h = setup({catalog:boundary === 'catalog' ? () => gate.promise : undefined,
      intercept:({endpoint}) => boundary === 'claim' && endpoint === 'client-start' ? gate.promise : undefined});
    const operation = nativeOperation(); h.render(operation); const pending = h.module.live(operation); await flush();
    h.module[leave](); gate.resolve(boundary === 'catalog' ? {clientId, actions:[action]} : {claimed:true, operation:{...operation, status:'running'}});
    await pending; assert.equal(h.executions.length, 0, `${boundary}/${leave}`);
    assert.equal(h.calls.filter(c => c.url.endsWith('/client-result')).length, boundary === 'claim' ? 1 : 0);
  }
});

test('an account change cannot receive an old execution receipt', async () => {
  const gate = defer(), h = setup({execute:() => gate.promise}), operation = nativeOperation();
  h.render(operation); const pending = h.module.live(operation); await flush();
  h.module.dispose(); h.window.ICeClass.state.user = {id:'another-account'};
  gate.resolve({success:true, verified:true, detail:'opened'}); await pending;
  assert.equal(h.calls.some(c => c.url.endsWith('/client-result')), false);
});

test('live replay protection is bounded and retained across remounts', async () => {
  const h = setup({native:false});
  for (let i = 0; i < 256; i++) await h.module.live(nativeOperation(`replay-${i}`));
  h.module.dispose(); h.module.mount(h.root);
  const operation = nativeOperation('over-limit'), card = h.render(operation); await h.module.live(operation);
  assert.match(card.textContent, /已达上限/); assert.equal(h.calls.length, 0);
});

test('page catalog contains actual visible enabled buttons and uses a document identity without a native host', async () => {
  const h = setup({native:false});
  h.page('ideas', '创意计划'); h.page('classroom-voice', '教室来音'); h.page('teachers', '用户管理', {hidden:true}); h.page('classes', '班级管理', {disabled:true});
  const first = await h.module.clientCatalog(), second = await h.module.clientCatalog();
  assert.equal(first.clientId, documentId); assert.equal(second.clientId, documentId);
  assert.deepEqual(Array.from(first.actions, a => a.id), ['teacher.page.ideas', 'teacher.page.classroom.voice']);
  assert.equal(first.actions[0].title, '创意计划'); assert.deepEqual(Array.from(first.actions[0].fields), []);
  assert.equal(first.actions[0].confirmation, false);
  const native = setup(); native.page('ideas', '创意计划');
  assert.equal((await native.module.clientCatalog()).clientId, clientId);
  assert.deepEqual(Array.from((await native.module.clientCatalog()).actions, a => a.id), [action.id, 'teacher.page.ideas']);
});

test('a browser page action uses the existing click handler and survives its legitimate navigation', async () => {
  const h = setup({native:false}), page = h.page('ideas', '创意计划'); let clicks = 0;
  page.control.addEventListener('click', () => {clicks++;});
  const operation = nativeOperation('open-ideas', {clientId:documentId, action:'teacher.page.ideas', title:'创意计划'}), card = h.render(operation);
  await h.module.live(operation); await h.module.live(operation);
  assert.equal(clicks, 1); assert.equal(h.executions.length, 0); assert.equal(page.control.classList.contains('active'), true);
  assert.equal(page.surface.classList.contains('hidden'), false); assert.equal(card.dataset.state, 'succeeded');
  assert.equal(JSON.parse(h.calls.find(c => c.url.endsWith('/client-result')).body).detail, '已打开创意计划。');
});

test('page guards, revoked visibility and blocked or disposed navigation never claim an opened page', async () => {
  for (const variant of ['guard', 'hidden-after-claim', 'logout']) {
    const h = setup({native:false, intercept:({endpoint, previous}) => {
      if (endpoint !== 'client-start') return;
      if (variant === 'hidden-after-claim') page.control.classList.add('hidden');
      return {claimed:true, operation:{...previous, status:'running'}};
    }}), page = h.page('ideas', '创意计划', {guard:variant === 'guard'});
    if (variant === 'logout') page.control.addEventListener('click', () => h.module.dispose());
    const operation = nativeOperation(variant, {clientId:documentId, action:'teacher.page.ideas'}); h.render(operation);
    await h.module.live(operation);
    const report = JSON.parse(h.calls.find(c => c.url.endsWith('/client-result')).body);
    assert.equal(report.success, false, 'a guarded, unavailable or disposed page is never reported opened');
    assert.equal(h.executions.length, 0);
  }
});

test('XLSX input and focus survive polling; upload keeps one id and requires explicit preview confirmation', async () => {
  const h = setup(), operation = importOperation(), card = h.render(operation), input = card.querySelector('input[type=file]');
  const file = {name:'课表.xlsx', size:1024, bytes:'private-file-bytes'}; input.files = [file]; input.focus();
  h.server.set(operation.id, {...operation, updatedAt:5}); await h.poll();
  assert.equal(card.querySelector('input[type=file]'), input); assert.equal(h.document.activeElement, input);
  await h.control(card, 'preview').click();
  const request = h.calls.find(c => c.url.endsWith('/file'));
  assert.equal(request.body, file); assert.equal(request.headers['X-CSRF-Token'], 'local-csrf');
  assert.match(request.headers['Content-Type'], /spreadsheetml.sheet/);
  assert.equal(card.dataset.operationId, operation.id); assert.equal(card.dataset.state, 'awaiting_confirmation');
  assert.equal(h.calls.some(c => c.url.endsWith('/confirm')), false); assert.match(card.textContent, /语文/); assert.match(card.textContent, /revision-2/);
  assert.equal(JSON.stringify(h.events).includes(file.bytes), false);
  await h.control(card, 'confirm').click(); await flush();
  assert.equal(card.dataset.state, 'succeeded'); assert.equal(h.refreshes, 1);
});

test('imports reject missing, empty, oversized and non-XLSX files without uploading', async () => {
  for (const file of [null, {name:'课表.csv', size:20}, {name:'课表.xlsx', size:0}, {name:'课表.xlsx', size:5 * 1024 * 1024 + 1}]) {
    const h = setup(), card = h.render(importOperation()), input = card.querySelector('input[type=file]'); input.files = file ? [file] : [];
    await h.control(card, 'preview').click(); assert.equal(h.calls.length, 0);
    assert.equal(input.getAttribute('aria-invalid'), 'true'); assert.equal(h.document.activeElement, card.querySelector('.bb-operation-feedback'));
  }
});

test('new pending statuses poll and cancel without executing and stop polling when cancelled', async () => {
  for (const operation of [importOperation(), nativeOperation()]) {
    const h = setup(), card = h.render(operation); await h.poll(); await h.control(card, 'cancel').click();
    assert.equal(card.dataset.state, 'cancelled'); assert.equal(h.timers.size, 0); assert.equal(h.executions.length, 0);
  }
});

test('download links allow only the authenticated same-origin endpoint and never fetch automatically', () => {
  const id = 'download-one', valid = `/api/banban/operations/${id}/download`;
  for (const url of [valid, `http://127.0.0.1:8891${valid}`, 'https://outside.test/file', '//outside.test/file', 'javascript:alert(1)', '/api/auth/logout', `${valid}?token=secret`, `${valid}#secret`, '/api/banban/operations/other/download', `http://user:pass@127.0.0.1:8891${valid}`]) {
    const h = setup(), card = h.render({id, kind:'platform', status:'succeeded', title:'导出记录', result:{detail:'下载已就绪，请保存文件。', downloadUrl:url, fileName:'记录.xlsx'}});
    const link = card.querySelector('a');
    assert.equal(Boolean(link), url === valid || url === `http://127.0.0.1:8891${valid}`, url);
    if (link) { assert.equal(link.href, valid); assert.equal(link.download, '记录.xlsx'); }
    assert.equal(h.calls.length, 0); assert.equal(h.refreshes, 0);
  }
});

test('private results are explicitly fetched into the card only and can be hidden or cleared on disposal', async () => {
  const h = setup(), operation = {id:'private-one', kind:'platform', status:'succeeded', title:'生成绑定码', updatedAt:1, result:{privateUrl:'/api/banban/operations/private-one/private-result'}};
  const card = h.render(operation); assert.equal(h.calls.length, 0);
  const control = h.control(card, 'private'); await control.click();
  assert.match(card.textContent, /sensitive-654321/); assert.equal(h.calls[0].cache, 'no-store'); assert.equal(JSON.stringify(h.events).includes('654321'), false);
  h.module.render(h.root, {...operation, updatedAt:2}); assert.match(card.textContent, /sensitive-654321/);
  await control.click(); assert.equal(card.textContent.includes('654321'), false);
  await control.click(); h.module.dispose(); assert.equal(card.textContent.includes('654321'), false);
});

test('delayed private results cannot reveal after navigation, and foreign private URLs are rejected', async () => {
  const gate = defer(), h = setup({intercept:({endpoint}) => endpoint === 'private-result' ? gate.promise : undefined});
  const card = h.render({id:'private-one', kind:'platform', status:'succeeded', title:'绑定码', result:{privateUrl:'/api/banban/operations/private-one/private-result'}});
  const pending = h.control(card, 'private').click(); h.module.invalidate(); gate.resolve({code:'secret-late'}); await pending;
  assert.equal(card.textContent.includes('secret-late'), false);
  const other = h.render({id:'private-other', status:'succeeded', title:'绑定码', result:{privateUrl:'https://outside.test/private'}});
  assert.equal(h.control(other, 'private'), undefined);
});

test('polling preserves password entry, selection and button focus while relevant form changes clear the password', async () => {
  const h = setup(), operation = {id:'password-one', title:'创建账号', kind:'platform', status:'awaiting_confirmation', needsPassword:true, parameters:{username:'local'}, updatedAt:1};
  const card = h.render(operation), input = card.querySelector('input[type=password]'); input.value = 'new-secret'; input.setSelectionRange(2, 5); input.focus();
  h.server.set(operation.id, {...operation, updatedAt:3, result:{detail:'核对账号'}}); await h.poll();
  assert.equal(card.querySelector('input[type=password]'), input); assert.equal(input.value, 'new-secret'); assert.equal(h.document.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 5]);
  const cancel = h.control(card, 'cancel'); cancel.focus(); h.module.render(h.root, {...operation, updatedAt:4, result:{detail:'继续核对'}});
  assert.equal(h.document.activeElement.dataset.control, 'cancel');
  h.module.render(h.root, {...operation, updatedAt:5, parameters:{username:'changed'}});
  assert.equal(card.querySelector('input[type=password]').value, '');
});

test('successful business polling refreshes management once; historical success never refreshes it', async () => {
  const h = setup(), operation = {id:'business-one', kind:'platform', status:'running', title:'修改班级', updatedAt:1}; h.render(operation);
  h.server.set(operation.id, {...operation, status:'succeeded', updatedAt:2}); await h.poll(); await flush();
  h.module.render(h.root, {...operation, status:'succeeded', updatedAt:3}); await flush(); assert.equal(h.refreshes, 1);
  h.render({...operation, id:'history-only', status:'succeeded'}); await flush(); assert.equal(h.refreshes, 1);
});

test('voice confirmation and cancellation support the new states without dispatching from confirmation', async () => {
  const h = setup(), operation = nativeOperation('voice', {status:'awaiting_confirmation'}); h.render(operation);
  const confirmed = await h.module.confirmVoice(operation); assert.equal(confirmed.status, 'awaiting_client'); assert.equal(h.executions.length, 0);
  const input = importOperation(); h.render(input); const cancelled = await h.module.cancelVoice([operation.id, input.id]);
  assert.deepEqual(Array.from(cancelled, o => o.status), ['cancelled', 'cancelled']);
});

test('chat sends only the fresh client catalog and an aborted catalog continuation never submits chat', async () => {
  const start = chatSource.indexOf('  async function streamQuestion('), end = chatSource.indexOf('  function navigate(', start);
  const streamSource = chatSource.slice(start, end) + '\nwindow.streamQuestion = streamQuestion;';
  for (const abort of [false, true]) {
    const h = setup({native:false}), gate = defer(), requests = []; h.page('ideas', '创意计划');
    h.window.ICeClassBanbanOperations.clientCatalog = () => gate.promise;
    Object.assign(h.context, {scope:{}, conversationId:'local-conversation', navigationRevision:0, disposed:false, voice:null, TextDecoder,
      fetch:async (url, settings) => {
        requests.push({url, settings}); let sent = false;
        return {ok:true, headers:{get:() => 'application/x-ndjson'}, body:{getReader:() => ({
          read:async () => sent ? {done:true} : (sent = true, {done:false, value:new TextEncoder().encode('{"type":"done"}\n')}), cancel:async () => {}, releaseLock() {}
        })}};
      }});
    vm.runInContext(streamSource, h.context);
    const controller = new AbortController(), pending = h.window.streamQuestion('打开创意计划', controller.signal, () => {});
    if (abort) controller.abort(); gate.resolve({clientId:documentId, actions:[{id:'teacher.page.ideas', title:'创意计划', fields:[], confirmation:false}]});
    if (abort) await assert.rejects(pending); else await pending;
    assert.equal(requests.length, abort ? 0 : 1);
    if (!abort) assert.equal(JSON.parse(requests[0].settings.body).teacherClient.actions[0].id, 'teacher.page.ideas');
  }
  assert.equal((chatSource.match(/\.live\(event\.operation/g) || []).length, 1, 'only the live operation event calls the executor');
});

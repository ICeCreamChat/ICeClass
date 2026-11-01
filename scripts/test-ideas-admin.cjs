'use strict';

// Run with: node --test scripts/test-ideas-admin.cjs
// Exercise the actual module through a small DOM host; no live service or email is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../web_controller/ideas-admin.js'), 'utf8');
const pause = () => new Promise(resolve => setImmediate(resolve));
const clone = value => structuredClone(value);

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  emit(type, values = {}) {
    const event = {
      type, target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...values
    };
    for (const callback of this.listeners.get(type) || []) {
      callback(event);
      if (event.stopped) break;
    }
    return event;
  }
}

class Element extends Events {
  constructor(tag, document) {
    super();
    this.tagName = tag.toUpperCase();
    this.document = document;
    this.children = [];
    this.attributes = new Map();
    this._text = '';
    this.className = '';
    this.value = '';
    this.hidden = this.disabled = this.checked = false;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => { if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim(); },
      remove: name => { this.className = this.className.split(/\s+/).filter(item => item !== name).join(' '); },
      toggle: (name, value) => {
        const enabled = value === undefined ? !this.classList.contains(name) : value;
        this.classList[enabled ? 'add' : 'remove'](name);
        return enabled;
      }
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(item => item.textContent).join(''); }
  get childElementCount() { return this.children.length; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name) || name === 'hidden' && this.hidden; }
  append(...items) {
    for (const item of items) {
      item.parentElement = this;
      this.children.push(item);
    }
  }
  prepend(...items) {
    for (const item of items) item.parentElement = this;
    this.children.unshift(...items);
  }
  replaceChildren(...items) {
    for (const item of this.children) item.parentElement = null;
    this.children = [];
    this._text = '';
    this.append(...items);
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const value = part.trim();
      if (value.startsWith('.')) return this.classList.contains(value.slice(1));
      if (value.startsWith('[')) {
        const [, name, expected] = value.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) || [];
        return name && (expected === undefined ? this.hasAttribute(name) : this.getAttribute(name) === expected);
      }
      return this.tagName.toLowerCase() === value;
    });
  }
  querySelectorAll(selector) {
    return this.children.flatMap(item => [ ...(item.matches(selector) ? [item] : []), ...item.querySelectorAll(selector) ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  contains(other) { return this === other || this.children.some(item => item.contains(other)); }
  focus() { if (!this.disabled) this.document.activeElement = this; }
  click() { if (!this.disabled) return this.emit('click'); }
  pause() { this.paused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  scrollIntoView() { this.scrolledIntoView = true; }
}

function idea(id, overrides = {}) {
  return {
    id, title: `创意 ${id}`, text: `学生提出的想法 ${id}`, name: '小林', classId: 'class-1',
    className: '高一 1 班', status: 'pending', reply: '', version: 1,
    createdAt: 1793491200000, updatedAt: 1793491200000,
    published: false, publishedTitle: '', publishedText: '', media: [], ...overrides
  };
}

function host(options = {}) {
  const document = new Events();
  document.createElement = tag => new Element(tag, document);
  const root = document.createElement('section');
  root.id = 'ideasView';
  document.getElementById = id => options.rootAvailable === false ? null : find(root, item => item.id === id);
  document.querySelector = selector => selector === '#ideasView' ? root : root.querySelector(selector);
  const server = { items: options.items || [idea('one'), idea('two')], summary: options.summary };
  const calls = [], confirmations = [];
  const window = new Events();
  window.location = { origin: 'http://127.0.0.1:8870', href: 'http://127.0.0.1:8870/' };
  window.matchMedia = () => ({ matches: Boolean(options.narrow) });
  window.confirm = message => { confirmations.push(message); return Boolean(options.confirm?.()); };
  if (options.classroom) window.ICeClassVoiceHost = { classroomAccount: true };
  const api = async (url, settings = {}) => {
    calls.push({ url, ...settings });
    if (options.intercept) {
      const result = options.intercept(url, settings, server);
      if (result !== undefined) return result;
    }
    if (url.endsWith('/summary')) return server.summary || {
      total: server.items.length,
      pending: server.items.filter(item => item.status === 'pending').length,
      published: server.items.filter(item => item.published).length,
      digest: { enabled: true, configured: true, nextAt: 1793527200000, lastSentAt: null, lastError: '' }
    };
    if (settings.method === 'PATCH') {
      const id = decodeURIComponent(url.split('/').pop());
      const previous = server.items.find(item => item.id === id);
      const payload = JSON.parse(settings.body);
      assert.equal(payload.version, previous.version, 'PATCH uses the current version');
      const updated = { ...previous, ...payload, version: previous.version + 1, updatedAt: previous.updatedAt + 1000 };
      server.items = server.items.map(item => item.id === id ? updated : item);
      return { item: clone(updated) };
    }
    const query = new URL(url, window.location.origin).searchParams;
    const filtered = server.items.filter(item => (!query.get('status') || item.status === query.get('status'))
      && (!query.get('classId') || item.classId === query.get('classId')));
    const page = Number(query.get('page') || 1), size = Number(query.get('pageSize') || 20);
    return { items: clone(filtered.slice((page - 1) * size, page * size)), total: filtered.length, page, pageSize: size };
  };
  window.ICeClass = {
    api, state: {
      user: options.sessionPending ? null : options.user || { id: 'admin', role: 'superadmin' },
      classes: [{ id: 'class-1', name: '高一 1 班' }, { id: 'class-2', name: '高一 2 班' }]
    }
  };
  vm.runInNewContext(source, { window, document, URL, URLSearchParams, Intl, Date, Set, Map, JSON });
  const module = window.ICeClassIdeasAdmin;
  return {
    module, root, document, window, calls, server, confirmations,
    start: () => module.load(),
    byId: id => document.getElementById(id),
    all: selector => root.querySelectorAll(selector),
    text: () => root.textContent
  };
}

function find(element, predicate) {
  if (predicate(element)) return element;
  for (const child of element.children) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

function control(h, id, value, type = 'input') {
  const element = h.byId(id);
  assert.ok(element, `Control ${id} exists`);
  if (typeof value === 'boolean') element.checked = value;
  else element.value = value;
  element.emit(type);
  return element;
}

function submit(h) { h.all('form')[0].emit('submit'); }
function action(h, label) { return h.all('button').find(item => item.textContent === label); }
function patches(h) { return h.calls.filter(item => item.method === 'PATCH'); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function logoutHandler(h) {
  const html = fs.readFileSync(path.join(__dirname, '../web_controller/index.html'), 'utf8');
  const handler = html.match(/\$\("logoutButton"\)\.addEventListener\("click", async \(\) => \{([\s\S]*?)\r?\n        \}\);/);
  assert.ok(handler, 'Exercise the actual logout handler from index.html');
  const requests = [];
  let reloads = 0;
  const click = vm.runInNewContext(`(async () => {${handler[1]}\n})`, {
    window: h.window,
    api: async (url, options) => { requests.push({ url, ...options }); return {}; },
    location: { reload() { reloads++; } }
  });
  return { click, requests, reloads: () => reloads };
}

test('global app integration renders private text safely, counts, labels, and pagination', async () => {
  const h = host({ items: [idea('one', { title: '<img src=x onerror=alert(1)>', text: '<script>private()</script>' })] });
  assert.deepEqual(Object.keys(h.module).sort(), ['canLeave', 'canLogout', 'destroy', 'init', 'load', 'suspend']);
  await h.start();
  assert.equal(h.root.getAttribute('aria-label'), '创意计划');
  assert.match(h.text(), /创意计划/);
  assert.match(h.text(), /待评审 1 · 共 1 条 · 已公开 0 条/);
  assert.match(h.text(), /<script>private\(\)<\/script>/);
  assert.equal(h.all('script').length, 0);
  assert.equal(h.all('img').length, 1, 'Only the empty lightbox image is present');
  assert.equal(h.all('.ideas-entry')[0].getAttribute('aria-current'), 'true');
  for (const id of ['ideasStatusFilter', 'ideasClassFilter', 'ideasReviewStatus', 'ideasReply', 'ideasPublicTitle', 'ideasPublicText']) {
    assert.ok(h.all('label').some(label => label.htmlFor === id), `${id} has an explicit label`);
  }
  assert.equal(action(h, '上一页').disabled, true);
  assert.equal(action(h, '下一页').disabled, true);
  assert.equal(action(h, '保存评审').disabled, true);
  assert.equal(h.calls[0].url, '/api/ideas/admin?page=1&pageSize=20');
});

test('only a real superadmin can load private ideas, including explicit init', async () => {
  for (const options of [
    { user: { id: 'teacher', role: 'teacher' } },
    { user: { id: 'principal', role: 'principal' } },
    { user: { id: 'admin', role: 'superadmin', classroom: { deviceId: 'device' } } },
    { classroom: true }
  ]) {
    const h = host(options);
    await h.start();
    assert.equal(h.calls.length, 0);
    assert.match(h.text(), /仅超级管理员/);
  }
  const h = host({ user: { id: 'teacher', role: 'teacher' } });
  let requested = 0;
  h.module.init({ root: h.root, user: { id: 'real-admin', role: 'superadmin' }, classes: [], api: async url => {
    requested++;
    return url.endsWith('/summary') ? { pending: 0, total: 0, published: 0, digest: {} } : { items: [], total: 0 };
  } });
  await h.start();
  assert.equal(requested, 2);
  assert.match(h.text(), /没有符合条件的创意/);
});

test('late defer execution mounts an already-ready app without fetching before navigation', async () => {
  const h = host();
  assert.ok(h.byId('ideasStatusFilter'), 'The module finds an existing authenticated app immediately');
  assert.equal(h.calls.length, 0, 'Lifecycle mounting does not fetch private data in the background');
  h.document.emit('DOMContentLoaded');
  h.window.emit('iceclass-ready');
  assert.equal(h.calls.length, 0);
  await h.start();
  assert.equal(h.calls.length, 2);
});

test('iceclass-ready mounts when enterApp finishes after the module and repeated init retains the editor', async () => {
  const h = host({ sessionPending: true });
  assert.equal(h.byId('ideasStatusFilter'), null);
  h.window.ICeClass.state.user = { id: 'admin', role: 'superadmin' };
  h.window.emit('iceclass-ready');
  assert.ok(h.byId('ideasStatusFilter'));
  assert.equal(h.calls.length, 0);
  await h.start();
  control(h, 'ideasReply', '生命周期初始化不丢失');
  const original = h.byId('ideasReply');
  assert.equal(h.module.init({
    root: h.root, api: h.window.ICeClass.api,
    user: h.window.ICeClass.state.user, classes: h.window.ICeClass.state.classes
  }), true);
  h.document.emit('DOMContentLoaded');
  h.window.emit('iceclass-ready');
  assert.equal(h.byId('ideasReply'), original, 'Repeated initialization does not replace form controls');
  assert.equal(h.byId('ideasReply').value, '生命周期初始化不丢失');
  assert.equal(h.confirmations.length, 0);
});

test('DOMContentLoaded retries discovery when the root did not exist during script execution', async () => {
  const options = { rootAvailable: false };
  const h = host(options);
  assert.equal(h.root.childElementCount, 0);
  options.rootAvailable = true;
  h.document.emit('DOMContentLoaded');
  assert.ok(h.byId('ideasStatusFilter'));
  assert.equal(h.calls.length, 0);
  await h.start();
  assert.equal(h.all('.ideas-entry').length, 2);
});

test('status/class filters and pagination send the agreed query and reset the page', async () => {
  const data = Array.from({ length: 42 }, (_, index) => idea(String(index), { classId: index % 2 ? 'class-2' : 'class-1' }));
  const h = host({ items: data });
  await h.start();
  action(h, '下一页').click();
  await pause();
  assert.match(h.calls.at(-1).url, /page=2/);
  control(h, 'ideasClassFilter', 'class-2', 'change');
  await pause();
  assert.match(h.calls.at(-1).url, /page=1&pageSize=20&classId=class-2$/);
  assert.equal(h.all('.ideas-entry').length, 20);
  control(h, 'ideasStatusFilter', 'launched', 'change');
  await pause();
  assert.match(h.calls.at(-1).url, /status=launched&classId=class-2/);
  assert.match(h.text(), /没有符合条件的创意/);
});

test('save keeps the same detail when the new status leaves the filter, and refreshes totals', async () => {
  const h = host();
  await h.start();
  control(h, 'ideasStatusFilter', 'pending', 'change');
  await pause();
  control(h, 'ideasReviewStatus', 'adopted', 'change');
  control(h, 'ideasReply', '谢谢，已纳入计划。');
  submit(h);
  await pause();
  assert.equal(patches(h).length, 1);
  assert.deepEqual(JSON.parse(patches(h)[0].body), {
    status: 'adopted', reply: '谢谢，已纳入计划。', published: false,
    publishedTitle: '', publishedText: '', version: 1
  });
  assert.equal(h.byId('ideasReply').value, '谢谢，已纳入计划。');
  assert.equal(h.byId('ideasReviewStatus').value, 'adopted');
  assert.match(h.all('.ideas-detail')[0].textContent, /创意 one/);
  assert.equal(h.all('.ideas-entry').length, 1);
  assert.match(h.all('.ideas-entry')[0].textContent, /创意 two/);
  assert.match(h.text(), /待评审 1 · 共 2 条/);
  assert.match(h.text(), /评审已保存/);
  assert.equal(action(h, '保存评审').disabled, true);
  control(h, 'ideasReply', '谢谢，排期有调整。');
  assert.equal(h.byId('ideasReviewFeedback').textContent, '', 'Editing removes the old success message');
  assert.match(h.all('.ideas-save-status')[0].textContent, /有未保存的修改/);
  assert.equal(action(h, '保存评审').disabled, false);
});

test('publication requires explicit public copy and is removed by pending/declined states', async () => {
  const h = host();
  await h.start();
  assert.equal(h.byId('ideasPublished').disabled, true);
  control(h, 'ideasReviewStatus', 'adopted', 'change');
  control(h, 'ideasPublished', true, 'change');
  assert.equal(h.byId('ideasPublicTitle').value, '', 'Private original copy is never copied into a public field');
  submit(h);
  await pause();
  assert.equal(patches(h).length, 0);
  assert.equal(h.document.activeElement.id, 'ideasPublicTitle');
  assert.equal(h.byId('ideasPublicTitle').getAttribute('aria-invalid'), 'true');
  control(h, 'ideasPublicTitle', '更方便的课间工具');
  control(h, 'ideasPublicText', '计划增加学生建议的工具入口。');
  submit(h);
  await pause();
  assert.equal(JSON.parse(patches(h)[0].body).published, true);
  control(h, 'ideasReviewStatus', 'pending', 'change');
  assert.equal(h.byId('ideasPublished').checked, false);
  assert.equal(h.byId('ideasPublished').disabled, true);
  assert.equal(h.all('.ideas-public-fields')[0].hidden, true);
  control(h, 'ideasReviewStatus', 'declined', 'change');
  submit(h);
  await pause();
  assert.equal(JSON.parse(patches(h)[1].body).published, false);
});

test('409 retains every draft, reloads across class pages without the old status filter, then uses the latest version', async () => {
  let conflict = true;
  const h = host({ intercept(url, settings) {
    if (settings.method === 'PATCH' && conflict) {
      conflict = false;
      return Promise.reject(Object.assign(new Error('版本冲突'), { status: 409 }));
    }
  } });
  await h.start();
  control(h, 'ideasStatusFilter', 'pending', 'change');
  await pause();
  control(h, 'ideasReviewStatus', 'adopted', 'change');
  control(h, 'ideasReply', '保留这段回复');
  control(h, 'ideasPublished', true, 'change');
  control(h, 'ideasPublicTitle', '我的公开标题');
  control(h, 'ideasPublicText', '我的公开摘要');
  submit(h);
  await pause();
  assert.match(h.text(), /草稿已保留/);
  assert.equal(h.byId('ideasReply').value, '保留这段回复');
  assert.equal(action(h, '保存评审').disabled, true);
  submit(h);
  await pause();
  assert.equal(patches(h).length, 1, 'A stale version cannot be blindly saved again');
  const latest = idea('one', { status: 'launched', reply: '其他管理员的回复', version: 8 });
  h.server.items = [...Array.from({ length: 20 }, (_, index) => idea(`extra-${index}`)), latest];
  const before = h.calls.length;
  action(h, '载入最新版本').click();
  await pause();
  const reads = h.calls.slice(before).filter(item => !item.method);
  assert.equal(reads.length, 2);
  assert.ok(reads.every(item => item.url.endsWith('classId=class-1') && !item.url.includes('status=')));
  assert.equal(h.byId('ideasReply').value, '保留这段回复');
  assert.equal(h.byId('ideasReviewStatus').value, 'adopted');
  assert.equal(h.byId('ideasPublicTitle').value, '我的公开标题');
  assert.equal(h.byId('ideasPublicText').value, '我的公开摘要');
  assert.match(h.all('.ideas-latest-review')[0].textContent, /已上线.*其他管理员的回复/);
  assert.equal(action(h, '保存评审').disabled, false);
  assert.equal(patches(h).length, 1, 'Loading a version never saves it');
  submit(h);
  await pause();
  assert.equal(JSON.parse(patches(h)[1].body).version, 8);
  assert.equal(h.byId('ideasReply').value, '保留这段回复');
});

test('selection, filters, pagination and unload protect unsaved edits; navigation keeps the draft', async () => {
  let accept = false;
  const h = host({ items: Array.from({ length: 21 }, (_, index) => idea(String(index))), confirm: () => accept });
  await h.start();
  control(h, 'ideasReply', '未保存的回复');
  h.all('.ideas-entry')[1].click();
  assert.equal(h.byId('ideasReply').value, '未保存的回复');
  assert.match(h.all('.ideas-detail')[0].textContent, /创意 0/);
  const before = h.calls.length;
  control(h, 'ideasStatusFilter', 'adopted', 'change');
  assert.equal(h.byId('ideasStatusFilter').value, '');
  action(h, '下一页').click();
  await pause();
  assert.equal(h.calls.length, before);
  assert.equal(h.window.emit('beforeunload').defaultPrevented, true);
  assert.equal(h.module.canLeave(), false);
  accept = true;
  assert.equal(h.module.canLeave(), true);
  assert.match(h.confirmations.at(-1), /草稿仍会保留在本页/);
  h.module.suspend();
  await h.module.load();
  assert.equal(h.byId('ideasReply').value, '未保存的回复', 'Returning to the page preserves the unsaved editor');
  h.all('.ideas-entry')[1].click();
  assert.equal(h.byId('ideasReply').value, '');
  assert.equal(h.window.emit('beforeunload').defaultPrevented, false);
});

test('cancelling logout retains the draft and prevents both logout request and reload', async () => {
  const h = host({ confirm: () => false });
  await h.start();
  control(h, 'ideasReply', '取消退出后继续评审');
  const original = h.byId('ideasReply');
  const logout = logoutHandler(h);
  await logout.click();
  assert.equal(logout.requests.length, 0);
  assert.equal(logout.reloads(), 0);
  assert.equal(h.byId('ideasReply'), original);
  assert.equal(h.byId('ideasReply').value, '取消退出后继续评审');
  assert.match(h.confirmations[0], /退出登录将丢弃当前未保存的评审草稿/);
  assert.match(h.confirmations[0], /无法恢复/);
  assert.doesNotMatch(h.confirmations[0], /仍会保留/);
  assert.equal(h.window.emit('beforeunload').defaultPrevented, true);
});

test('confirming logout explicitly discards the draft and completes the actual logout handler', async () => {
  const h = host({ confirm: () => true });
  await h.start();
  control(h, 'ideasReply', '明确确认丢弃这份草稿');
  const logout = logoutHandler(h);
  await logout.click();
  assert.deepEqual(logout.requests, [{ url: '/api/auth/logout', method: 'POST' }]);
  assert.equal(logout.reloads(), 1);
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0], /丢弃.*无法恢复/);
  assert.equal(h.root.childElementCount, 0);
  assert.equal(h.window.emit('beforeunload').defaultPrevented, false);
});

test('logout proceeds without confirmation when there are no unsaved reviews', async () => {
  const h = host();
  await h.start();
  const logout = logoutHandler(h);
  await logout.click();
  assert.equal(h.confirmations.length, 0);
  assert.deepEqual(logout.requests, [{ url: '/api/auth/logout', method: 'POST' }]);
  assert.equal(logout.reloads(), 1);
});

test('suspend stops audio and closes the lightbox; destroy invalidates pending responses', async () => {
  let delayed = false;
  const response = deferred();
  const h = host({
    narrow: true,
    items: [idea('one', { media: [
      { id: 'photo-1', kind: 'image', url: '/api/ideas/media/photo-1' },
      { id: 'audio-1', kind: 'audio', url: '/api/ideas/media/audio-1' }
    ] }), idea('two')],
    intercept(url) { if (delayed && url.includes('/admin?')) return response.promise; }
  });
  await h.start();
  h.all('.ideas-photo')[0].click();
  const audio = h.all('audio')[0], lightbox = h.all('dialog')[0];
  h.module.suspend();
  assert.equal(audio.paused, true);
  assert.equal(lightbox.open, false);
  h.all('.ideas-entry')[1].click();
  assert.equal(h.all('.ideas-detail')[0].scrolledIntoView, true, 'Narrow screens bring the selected detail into view');
  delayed = true;
  const pending = h.module.load();
  h.module.destroy();
  response.resolve({ items: [idea('late')], total: 1 });
  await pending;
  assert.equal(h.root.childElementCount, 0, 'A late response cannot remount a destroyed session');
  assert.equal(h.window.emit('beforeunload').defaultPrevented, false);
});

test('a failed PATCH leaves a retryable draft and a failed list offers recovery', async () => {
  let saveFails = true, listFails = false;
  const h = host({ intercept(url, settings) {
    if (settings.method === 'PATCH' && saveFails) return Promise.reject(new Error('连接中断，请重试。'));
    if (url.includes('/admin?') && listFails) return Promise.reject(new Error('创意列表暂时不可用。'));
  } });
  await h.start();
  control(h, 'ideasReply', '网络失败也保留');
  submit(h);
  await pause();
  assert.equal(h.byId('ideasReply').value, '网络失败也保留');
  assert.match(h.text(), /连接中断/);
  assert.equal(action(h, '保存评审').disabled, false);
  saveFails = false;
  submit(h);
  await pause();
  assert.match(h.text(), /评审已保存/);
  listFails = true;
  await h.module.load();
  assert.match(h.text(), /创意列表暂时不可用/);
  listFails = false;
  action(h, '重试').click();
  await pause();
  assert.equal(h.all('.ideas-entry').length, 2);
});

test('late filter responses cannot replace the newer selection or filter', async () => {
  let defer = false;
  const adopted = deferred(), pending = deferred();
  const h = host({ intercept(url) {
    if (defer && url.includes('status=adopted')) return adopted.promise;
    if (defer && url.includes('status=pending')) return pending.promise;
  } });
  await h.start();
  defer = true;
  control(h, 'ideasStatusFilter', 'adopted', 'change');
  control(h, 'ideasStatusFilter', 'pending', 'change');
  pending.resolve({ items: [idea('newer')], total: 1 });
  await pause();
  adopted.resolve({ items: [idea('older', { status: 'adopted' })], total: 1 });
  await pause();
  assert.equal(h.byId('ideasStatusFilter').value, 'pending');
  assert.match(h.all('.ideas-detail')[0].textContent, /创意 newer/);
  assert.doesNotMatch(h.text(), /创意 older/);
});

test('editing during a refresh retains the draft and saving blocks a second submission', async () => {
  let delayed = false;
  const read = deferred(), write = deferred();
  const h = host({ intercept(url, settings) {
    if (settings.method === 'PATCH') return write.promise;
    if (delayed && url.includes('/admin?')) return read.promise;
  } });
  await h.start();
  delayed = true;
  const loading = h.module.load();
  control(h, 'ideasReply', '刷新期间输入');
  read.resolve({ items: [idea('one', { reply: '服务器回复' })], total: 1 });
  await loading;
  assert.equal(h.byId('ideasReply').value, '刷新期间输入');
  submit(h);
  submit(h);
  assert.equal(patches(h).length, 1);
  assert.equal(h.module.canLeave(), false);
  const logout = logoutHandler(h);
  await logout.click();
  assert.equal(logout.requests.length, 0, 'An in-flight review cannot be interrupted by logout');
  assert.equal(logout.reloads(), 0);
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.byId('ideasReply').disabled, true);
  write.resolve({ item: idea('one', { reply: '刷新期间输入', version: 2 }) });
  await pause();
  assert.equal(h.byId('ideasReply').value, '刷新期间输入');
});

test('media uses protected same-origin paths, lazy photos, keyboard-ready lightbox and native audio controls', async () => {
  const h = host({ items: [idea('one', { media: [
    { id: 'photo-1', kind: 'image', url: '/api/ideas/media/photo-1' },
    { id: 'audio-1', kind: 'audio', durationMs: 3500, url: '/api/ideas/media/audio-1' },
    { id: 'external', kind: 'image', url: 'https://other.invalid/api/ideas/media/external' },
    { id: 'script', kind: 'image', url: 'javascript:alert(1)' },
    { id: 'query', kind: 'image', url: '/api/ideas/media/photo-1?token=secret' }
  ] })] });
  await h.start();
  assert.equal(h.all('.ideas-photo').length, 1);
  const image = h.all('.ideas-photo')[0].children[0];
  assert.equal(image.loading, 'lazy');
  const audio = h.all('audio')[0];
  assert.equal(audio.controls, true);
  assert.equal(audio.preload, 'none');
  assert.equal(audio.src, '/api/ideas/media/audio-1');
  assert.match(h.text(), /学生语音 · 4 秒/);
  h.all('.ideas-photo')[0].click();
  const lightbox = h.all('dialog')[0];
  assert.equal(lightbox.open, true);
  assert.equal(lightbox.getAttribute('aria-labelledby'), 'ideasPhotoTitle');
  assert.equal(h.all('img')[1].src, '/api/ideas/media/photo-1');
  h.all('img')[1].emit('error');
  assert.match(lightbox.textContent, /照片暂时无法显示/);
  action(h, '关闭').click();
  assert.equal(lightbox.open, false);
  audio.emit('error');
  assert.match(h.text(), /语音暂时无法播放/);
});

test('digest shows schedule and configuration/error feedback without exposing service secrets', async () => {
  const h = host({ summary: { total: 2, pending: 2, published: 0, digest: {
    enabled: true, configured: false, lastSentAt: 1793491200000,
    lastError: 'smtp://account:super-secret@mail.invalid:465 failed'
  } } });
  await h.start();
  assert.match(h.text(), /每日 18:00 汇总 · 待配置邮件服务/);
  assert.match(h.text(), /最近发送失败/);
  assert.doesNotMatch(h.text(), /super-secret|mail\.invalid|smtp:\/\//);
});

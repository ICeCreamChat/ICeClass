'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { encodePcm16Wav, mediaPath, isRetryUncertain, newRequestId } = require('../web_controller/ideas/ideas.js');
const source = fs.readFileSync(path.join(__dirname, '../web_controller/ideas/ideas.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../web_controller/ideas/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../web_controller/ideas/ideas.css'), 'utf8');

const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const item = (text = '希望班伴提醒学习用品', id = 'idea-1') => ({ id, title: text, text, name: '', status: 'pending', version: 1, canDelete: true, reply: '', createdAt: 1793500000000, updatedAt: 1793500000000, media: [] });

class Element {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.attrs = {}; this.dataset = {};
    this.handlers = new Map(); this.className = ''; this._text = ''; this.value = ''; this.hidden = false;
    this.disabled = false; this.checked = false; this.open = false; this.files = []; this.videoWidth = 1920; this.videoHeight = 1080;
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
      toggle: (name, force) => { const names = new Set(this.className.split(' ').filter(Boolean)); if (force === undefined ? !names.has(name) : force) names.add(name); else names.delete(name); this.className = [...names].join(' '); }
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  get childElementCount() { return this.children.length; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; if (name === 'src') this.src = ''; }
  addEventListener(type, fn, options = {}) { const handlers = this.handlers.get(type) || []; handlers.push({ fn, once: options.once }); this.handlers.set(type, handlers); }
  removeEventListener(type, fn) { this.handlers.set(type, (this.handlers.get(type) || []).filter(handler => handler.fn !== fn)); }
  fire(type, fields = {}) {
    const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...fields };
    for (const handler of [...(this.handlers.get(type) || [])]) { handler.fn(event); if (handler.once) this.removeEventListener(type, handler.fn); }
    return event;
  }
  querySelectorAll(selector) {
    const tags = selector.split(',').map(tag => tag.trim().toUpperCase());
    return this.children.flatMap(child => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  focus() { this.focused = true; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  click() { this.fire('click'); }
  pause() { this.paused = true; }
  async play() { this.paused = false; }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  getContext() { return { fillRect() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {} }; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 319.875 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  toBlob(callback, type) { queueMicrotask(() => callback(new Blob(['jpeg-data'], { type }))); }
}

function indexedDatabase(records, options) {
  let transactions = Promise.resolve();
  const db = {
    close() {}, createObjectStore() {},
    transaction() {
      const tx = {};
      tx.objectStore = () => {
        const run = (action, key, value) => {
          const operation = {};
          options.storageCalls.push({ action, key });
          transactions = transactions.then(async () => {
            try {
              const before = options[`before${action[0].toUpperCase()}${action.slice(1)}`];
              if (before) await before(key, value);
              if (action === 'delete' && options.failDelete?.()) throw new Error('delete transaction aborted');
              if (action === 'get') operation.result = structuredClone(records.get(key));
              else if (action === 'put') records.set(key, structuredClone(value));
              else records.delete(key);
              tx.oncomplete();
            } catch { tx.onabort(); }
          });
          return operation;
        };
        return {
          get: key => run('get', key),
          put: (value, key) => run('put', key, value),
          delete: key => run('delete', key)
        };
      };
      return tx;
    }
  };
  return { open() { const opening = { result: db }; queueMicrotask(() => opening.onsuccess()); return opening; } };
}

function harness(options = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1], match[2]);
    element.hidden = /\bhidden\b/.test(match[0]); element.disabled = /\bdisabled\b/.test(match[0]);
    element.checked = /\bchecked\b/.test(match[0]);
    element.type = /\btype="([^"]+)"/.exec(match[0])?.[1] || '';
    element.name = /\bname="([^"]+)"/.exec(match[0])?.[1] || '';
    elements.set(match[2], element);
  }
  const document = new Element('document'); document.hidden = false; document.readyState = 'loading';
  document.getElementById = id => { assert.ok(elements.has(id), `HTML must declare #${id}`); return elements.get(id); };
  document.createElement = tag => new Element(tag);
  document.querySelectorAll = selector => {
    const tags = selector.split(',').map(tag => tag.trim().toUpperCase());
    return [...new Set([...elements.values()].flatMap(element => [...(tags.includes(element.tagName) ? [element] : []), ...element.querySelectorAll(selector)]))];
  };
  const calls = [], permissionCalls = [], recorders = [], tracks = [], revoked = [], storageCalls = [], paperCalls = [], nativeMessages = [];
  const records = options.records || new Map();
  const timers = new Set(), scheduled = [];
  let objectId = 0;
  class BrowserURL extends URL {
    static createObjectURL() { return `blob:https://classroom.test/${++objectId}`; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const stream = () => {
    const track = { stopped: 0, stop() { this.stopped += 1; }, getSettings() { return { deviceId: 'camera-1' }; } }; tracks.push(track);
    return { getTracks: () => [track], getVideoTracks: () => [track] };
  };
  class Recorder extends Element {
    static isTypeSupported(type) { return type.startsWith('audio/webm'); }
    constructor(mediaStream, recorderOptions) { super(); this.stream = mediaStream; this.mimeType = recorderOptions?.mimeType || 'audio/webm'; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.fire('dataavailable', { data: new Blob(['encoded-audio']) }); this.fire('stop'); }); }
  }
  let decodeError = false;
  class AudioContext {
    async decodeAudioData() {
      if (options.decodeAudio) await options.decodeAudio();
      if (decodeError) throw new Error('无法读取这段录音。');
      return { duration: .25, numberOfChannels: 2 };
    }
    async close() {}
  }
  class OfflineAudioContext {
    constructor(channels, length, rate) { assert.equal(channels, 1); assert.equal(rate, 16000); this.length = length; }
    createBufferSource() { return { connect() {}, start() {} }; }
    async startRendering() { return { getChannelData: channel => { assert.equal(channel, 0); return new Float32Array(this.length).fill(.25); } }; }
  }
  const window = new Element('window');
  window.location = { href: `https://classroom.test/ideas/${options.query || ''}` };
  window.history = { replaceState(_state, _title, url) { window.location.href = String(url); } };
  window.indexedDB = options.storageUnavailable ? undefined : indexedDatabase(records, { ...options, storageCalls });
  window.MediaRecorder = Recorder; window.AudioContext = AudioContext; window.OfflineAudioContext = OfflineAudioContext;
  let cancelPaper = null;
  window.ICeClassIdeasPaper = {
    open(source) {
      paperCalls.push(source);
      return new Promise((resolve, reject) => {
        cancelPaper = () => resolve(null);
        Promise.resolve(options.paperOpen ? options.paperOpen(source) : new Blob(['cropped-paper'], { type: 'image/jpeg' })).then(resolve, reject);
      });
    },
    cancel() { cancelPaper?.(); cancelPaper = null; }
  };
  window.chrome = { webview: new Element('native') };
  window.ICeClassIdeasDesktop = { send: message => { nativeMessages.push(message); options.nativeSend?.(message); } };
  const sandbox = {
    window, document, URL: BrowserURL, Blob, FormData, Uint8Array, Float32Array, ArrayBuffer, DataView, Intl, Date,
    crypto: webcrypto, performance, AbortController, console, btoa,
    CustomEvent: class { constructor(type, config) { this.type = type; this.detail = config.detail; } },
    navigator: { mediaDevices: {
      getUserMedia(constraints) { permissionCalls.push(constraints); return options.media ? options.media(constraints, stream) : Promise.resolve(stream()); },
      async enumerateDevices() { return [{ kind: 'videoinput', deviceId: 'camera-1', label: '教室摄像头' }]; }
    } },
    createImageBitmap: options.imageBitmap || (async () => ({ width: 1200, height: 800, close() {} })),
    setTimeout(fn, delay) { const timer = setTimeout(fn, delay); timer.unref(); timers.add(timer); scheduled.push({ fn, delay }); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    setInterval(fn, delay) { const timer = setInterval(fn, delay); timer.unref(); timers.add(timer); return timer; },
    clearInterval(timer) { clearInterval(timer); timers.delete(timer); },
    async fetch(url, config) {
      calls.push({ url, ...config });
      if (options.fetch) { const result = await options.fetch(url, config); if (result !== undefined) return result; }
      if (url === '/api/ideas/student/context') return response(options.context || { classId: 'class-1', className: '一年级一班', deviceId: 'device-1' });
      if (url.startsWith('/api/ideas/student?') || url.startsWith('/api/ideas/showcase?')) return response({ items: [], total: 0, page: Number(new URL(url, 'https://classroom.test').searchParams.get('page')), pageSize: 20 });
      if (url === '/api/ideas/student' && config.method === 'POST') return response({ item: item(JSON.parse(config.body.get('report')).text) }, 201);
      throw new Error(`Unexpected API: ${url}`);
    }
  };
  // DispatchEvent has a browser event signature, separate from the test convenience .fire().
  document.dispatchEvent = event => { document.fire(event.type, { detail: event.detail }); return true; };
  const ready = []; document.addEventListener('iceclass-ideas-ready', event => ready.push(event.detail));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web_controller/ideas/ideas-ink.js'), 'utf8'), sandbox, { filename: 'ideas-ink.js' });
  vm.runInNewContext(source, sandbox, { filename: 'ideas.js' });
  return {
    window, document, calls, permissionCalls, recorders, tracks, records, revoked, ready, stream, scheduled, storageCalls, paperCalls, nativeMessages,
    nativeReply(data) { window.chrome.webview.fire('message', { data }); },
    $: id => elements.get(id),
    setDecodeError(value) { decodeError = value; },
    async start() { document.readyState = 'interactive'; document.fire('DOMContentLoaded'); await flush(); },
    async click(id) {
      const element = elements.get(id);
      if (element.type === 'radio' && !element.disabled) {
        const changed = !element.checked;
        for (const other of elements.values()) if (other.type === 'radio' && other.name === element.name) other.checked = other === element;
        element.fire('click'); if (changed) element.fire('change');
      } else element.fire('click');
      await flush();
    },
    input(id, value) { const element = elements.get(id); element.value = value; element.setSelectionRange(value.length, value.length); element.fire('input'); },
    async openSubmit() { elements.get('submitIdea').fire('click'); await flush(); },
    async submit() {
      if (elements.get('reviewFields').hidden || !elements.get('submitIdea').hidden) { elements.get('submitIdea').fire('click'); await flush(); }
      if (!elements.get('reviewActions').hidden) { elements.get('ideaForm').fire('submit'); await flush(); }
    },
    cleanup() { for (const timer of timers) { clearTimeout(timer); clearInterval(timer); } }
  };
}

test('WAV is PCM16 mono 16 kHz, clips samples, and never exceeds 60 seconds / 2 MiB', async () => {
  const blob = encodePcm16Wav(new Float32Array([-2, -1, -.5, 0, .5, 1, 2, NaN]));
  const bytes = await blob.arrayBuffer(); const view = new DataView(bytes);
  assert.equal(blob.type, 'audio/wav'); assert.equal(blob.size, 60);
  assert.equal(Buffer.from(bytes).subarray(0, 4).toString(), 'RIFF');
  assert.equal(view.getUint16(20, true), 1); assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000); assert.equal(view.getUint16(34, true), 16);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -32768, -16384, 0, 16384, 32767, 32767, 0]);
  const long = encodePcm16Wav(new Float32Array(16000 * 61));
  assert.equal(long.size, 44 + 16000 * 60 * 2); assert.ok(long.size <= 2 * 1024 * 1024);
});

test('request ids are UUIDs and private media stays on its agreed same-origin route', () => {
  assert.match(newRequestId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(mediaPath('/api/ideas/media/abc-123'), '/api/ideas/media/abc-123');
  for (const unsafe of ['https://other.test/api/ideas/media/id', '//other.test/x', 'javascript:alert(1)', '/api/ideas/media/a?token=secret', '/api/ideas/media/a/../../other', '/api/ideas/media/..', '/api/ideas/media/%2f..', '/api/ideas/media/\\evil', null]) assert.equal(mediaPath(unsafe), null);
  for (const status of [0, 408, 409, 500, 503]) assert.equal(isRetryUncertain(status), true);
  for (const status of [400, 401, 403, 413, 429]) assert.equal(isRetryUncertain(status), false);
  assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage|Authorization|Bearer/);
  assert.match(html, /<link[^>]*nonce="__CSP_NONCE__"/);
  assert.match(html, /<script[^>]*nonce="__CSP_NONCE__"/);
});

test('DOMContentLoaded boot needs device context and never requests media permissions', async t => {
  const h = harness({ fetch: url => url.endsWith('/context') ? response({ error: 'unauthorized' }, 401) : undefined }); t.after(() => h.cleanup());
  assert.equal(h.window.ICeClassIdeas, undefined); await h.start();
  assert.equal(typeof h.window.ICeClassIdeas.suspend, 'function');
  assert.equal(h.window.ICeClassIdeas.suspend, h.window.ICeClassIdeas.prepareToLeave);
  assert.match(h.$('connectionMessage').textContent, /请从已绑定教室端打开/);
  assert.equal(h.$('draftFields').disabled, true); assert.equal(h.permissionCalls.length, 0);
  assert.equal(h.ready.length, 1); assert.equal(h.ready[0].authenticated, false);
  await h.click('tab-class'); assert.equal(h.calls.length, 1);
});

test('name alone is invalid; ambiguous POST locks and persists the exact payload, then retries idempotently', async t => {
  const pending = deferred(); let postCount = 0;
  const h = harness({ fetch: (url, config) => {
    if (config.method === 'POST') { postCount += 1; return postCount === 1 ? pending.promise : response({ item: item('保留这份创意') }, 201); }
  } }); t.after(() => h.cleanup()); await h.start();
  h.input('ideaName', '小同学'); await h.submit(); assert.equal(postCount, 0);
  h.input('ideaText', '保留这份创意');
  h.$('submitIdea').fire('click'); h.$('submitIdea').fire('click'); await flush();
  assert.equal(postCount, 0);
  h.$('ideaForm').fire('submit'); h.$('ideaForm').fire('submit'); await flush();
  assert.equal(postCount, 1); assert.equal(h.$('draftFields').disabled, true);
  pending.reject(new Error('response lost')); await flush();
  assert.equal(h.$('draftFields').disabled, true); assert.equal(h.$('submitIdea').disabled, false);
  assert.match(h.$('submitError').textContent, /结果尚未确认/);
  const first = JSON.parse(h.calls.find(call => call.method === 'POST').body.get('report'));
  const stored = [...h.records.values()][0]; assert.equal(stored.pending, true); assert.equal(stored.requestId, first.requestId);
  await h.submit();
  const reports = h.calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body.get('report')));
  assert.deepEqual(reports[1], reports[0]);
  assert.equal(h.$('ideaText').value, ''); assert.equal(h.$('ideaName').value, '');
  assert.equal(h.$('panel-class').hidden, false); assert.match(h.$('recentSubmission').textContent, /保留这份创意/);
  assert.equal(h.records.size, 0); assert.match(h.$('globalNotice').textContent, /已提交/);
  assert.ok(h.calls.every(call => call.credentials === 'same-origin' && !call.headers));
});

test('a known validation rejection keeps an editable draft and its request id', async t => {
  let count = 0;
  const h = harness({ fetch: (_url, config) => config.method === 'POST' && ++count === 1 ? response({ error: '请修改内容。' }, 400) : undefined }); t.after(() => h.cleanup());
  await h.start(); h.input('ideaText', '班伴新功能'); await h.submit();
  assert.equal(h.$('reviewFields').disabled, false); assert.equal(h.$('ideaText').value, '班伴新功能');
  const first = JSON.parse(h.calls.find(call => call.method === 'POST').body.get('report'));
  await h.click('cancelSubmit');
  assert.equal(h.$('draftFields').disabled, false);
  h.input('ideaText', '修改后的班伴功能'); await h.submit();
  const second = JSON.parse(h.calls.filter(call => call.method === 'POST')[1].body.get('report'));
  assert.equal(second.requestId, first.requestId); assert.equal(second.text, '修改后的班伴功能');
});

test('unknown submission survives reopening and draft storage is scoped to class and device', async t => {
  const records = new Map();
  const one = harness({ records, fetch: (_url, config) => { if (config.method === 'POST') throw new Error('offline'); } }); t.after(() => one.cleanup());
  await one.start(); one.input('ideaText', '网络断开也保留'); await one.submit();
  await one.window.ICeClassIdeas.suspend();
  const requestId = [...records.values()][0].requestId;
  const two = harness({ records }); t.after(() => two.cleanup()); await two.start();
  assert.equal(two.$('ideaText').value, '网络断开也保留'); assert.equal(two.$('draftFields').disabled, true);
  await two.submit(); assert.equal(JSON.parse(two.calls.find(call => call.method === 'POST').body.get('report')).requestId, requestId);
  one.input('ideaText', ''); // Locked, so the original request remains untouched.
  await one.window.ICeClassIdeas.suspend();
  const other = harness({ records, context: { classId: 'class-2', className: '其他班级', deviceId: 'device-1' } }); t.after(() => other.cleanup()); await other.start();
  assert.equal(other.$('ideaText').value, ''); assert.equal(other.$('draftFields').disabled, false);
});

test('leave waits for context and restores the existing draft before taking a snapshot', async t => {
  const context = deferred();
  const key = JSON.stringify(['class-1', 'device-1']);
  const records = new Map([[key, { requestId: newRequestId(), text: '等待连接时也不覆盖草稿', name: '', images: [], audio: null, pending: false }]]);
  const h = harness({ records, fetch: url => url.endsWith('/context') ? context.promise : undefined }); t.after(() => h.cleanup());
  await h.start();
  let finished = false;
  const leaving = h.window.ICeClassIdeas.prepareToLeave().then(result => { finished = true; return result; });
  await flush(); const finishedBeforeContext = finished;
  context.resolve(response({ classId: 'class-1', className: '一年级一班', deviceId: 'device-1' }));
  const result = await leaving; await flush();
  assert.equal(finishedBeforeContext, false);
  assert.equal(result.saved, true); assert.equal(result.hasDraft, true);
  assert.equal(records.get(key).text, '等待连接时也不覆盖草稿');
  assert.equal(h.$('ideaText').value, records.get(key).text);
});

test('leave during a delayed IndexedDB restore cannot enqueue an empty snapshot', async t => {
  const reading = deferred();
  const key = JSON.stringify(['class-1', 'device-1']);
  const records = new Map([[key, { requestId: newRequestId(), text: '仍在读取的草稿', name: '同学', images: [], audio: null, pending: false }]]);
  const h = harness({ records, beforeGet: () => reading.promise }); t.after(() => h.cleanup());
  await h.start(); assert.equal(h.$('draftFields').disabled, true);
  const leaving = h.window.ICeClassIdeas.suspend(); await flush();
  const writesBeforeRestore = h.storageCalls.filter(call => call.action === 'put').length;
  reading.resolve(); const result = await leaving; await flush();
  assert.equal(writesBeforeRestore, 0);
  assert.equal(result.saved, true); assert.equal(result.hasDraft, true);
  assert.equal(records.get(key).text, '仍在读取的草稿'); assert.equal(records.get(key).name, '同学');
  assert.equal(h.$('ideaText').value, records.get(key).text);
});

test('class pagination requests one bounded page and keyboard tabs support Home/End', async t => {
  const h = harness({ query: '?view=class', fetch: url => {
    if (url.startsWith('/api/ideas/student?')) { const page = Number(new URL(url, 'https://classroom.test').searchParams.get('page')); return response({ items: [item(`第${page}页创意`)], total: 21, page, pageSize: 20 }); }
  } }); t.after(() => h.cleanup()); await h.start();
  assert.equal(h.$('panel-class').hidden, false); assert.equal(h.$('classNext').disabled, false);
  await h.click('classNext'); assert.match(h.$('classList').textContent, /第2页创意/); assert.equal(h.$('classNext').disabled, true);
  assert.equal(h.calls.filter(call => call.url.startsWith('/api/ideas/student?')).length, 2);
  assert.ok(h.calls.filter(call => call.url.includes('?')).every(call => new URL(call.url, 'https://classroom.test').searchParams.get('pageSize') === '20'));
  const event = h.$('tab-class').fire('keydown', { key: 'Home' }); assert.equal(event.defaultPrevented, true);
  assert.equal(h.$('panel-submit').hidden, false); assert.equal(h.$('tab-submit').focused, true);
});

function deleteButton(h, container = 'classList') {
  return h.$(container).querySelectorAll('button').find(button => button.className.includes('ideas-item-remove'));
}

test('only pending ideas offer delete; cancelling and Escape send no request', async t => {
  const h = harness({ query: '?view=class', fetch: url => url.startsWith('/api/ideas/student?')
    ? response({ items: [item(), { ...item('已采纳的创意', 'idea-2'), status: 'adopted', canDelete: false }], total: 2, page: 1, pageSize: 20 }) : undefined });
  t.after(() => h.cleanup()); await h.start();
  const buttons = h.$('classList').querySelectorAll('button').filter(button => button.className.includes('ideas-item-remove'));
  assert.equal(buttons.length, 1); buttons[0].fire('click'); await flush();
  assert.equal(h.$('deleteDialog').open, true); assert.match(h.$('deleteIdeaTitle').textContent, /学习用品/);
  assert.equal(h.calls.some(call => call.method === 'DELETE'), false);
  await h.click('cancelDelete'); assert.equal(h.$('deleteDialog').open, false); assert.equal(buttons[0].focused, true);
  buttons[0].fire('click'); const event = h.$('deleteDialog').fire('cancel'); await flush();
  assert.equal(event.defaultPrevented, true); assert.equal(h.$('deleteDialog').open, false);
  assert.equal(h.calls.some(call => call.method === 'DELETE'), false);
});

test('delete confirmation sends one versioned request and refreshes the list only after success', async t => {
  const pending = deferred(); let deleted = false;
  const h = harness({ query: '?view=class', fetch: (url, config) => {
    if (config.method === 'DELETE') return pending.promise.then(() => { deleted = true; return response({ deleted: true }); });
    if (url.startsWith('/api/ideas/student?')) return response({ items: deleted ? [] : [item()], total: deleted ? 0 : 1, page: 1, pageSize: 20 });
  } }); t.after(() => h.cleanup()); await h.start();
  deleteButton(h).fire('click'); h.$('confirmDelete').fire('click'); h.$('confirmDelete').fire('click'); await flush();
  const requests = h.calls.filter(call => call.method === 'DELETE');
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/ideas/student/idea-1');
  assert.deepEqual(JSON.parse(requests[0].body), { version: 1 }); assert.equal(h.$('cancelDelete').disabled, true);
  assert.equal(h.$('classList').childElementCount, 1);
  pending.resolve(); await flush();
  assert.equal(h.$('deleteDialog').open, false); assert.equal(h.$('classList').childElementCount, 0);
  assert.equal(h.$('classTotal').textContent, '共 0 条'); assert.match(h.$('globalNotice').textContent, /已删除/);
  assert.equal(h.$('refreshClass').focused, true);
});

test('delete failure keeps the idea and confirmation open for an idempotent retry', async t => {
  let attempts = 0, deleted = false;
  const h = harness({ query: '?view=class', fetch: (url, config) => {
    if (config.method === 'DELETE') {
      if (++attempts === 1) return response({ error: '暂时无法删除，请重试。' }, 503);
      deleted = true; return response({ deleted: true });
    }
    if (url.startsWith('/api/ideas/student?')) return response({ items: deleted ? [] : [item()], total: deleted ? 0 : 1, page: 1, pageSize: 20 });
  } }); t.after(() => h.cleanup()); await h.start();
  deleteButton(h).fire('click'); await h.click('confirmDelete');
  assert.equal(h.$('deleteDialog').open, true); assert.match(h.$('deleteError').textContent, /重试/);
  assert.equal(h.$('confirmDelete').disabled, false); assert.equal(h.$('classList').childElementCount, 1);
  await h.click('confirmDelete'); assert.equal(attempts, 2); assert.equal(h.$('deleteDialog').open, false);
  assert.equal(h.$('classList').childElementCount, 0);
});

test('a review conflict keeps the record and refreshes away its delete action', async t => {
  let reviewed = false;
  const h = harness({ query: '?view=class', fetch: (url, config) => {
    if (config.method === 'DELETE') { reviewed = true; return response({ error: '这条创意已处理，不能删除。' }, 409); }
    if (url.startsWith('/api/ideas/student?')) return response({ items: [reviewed ? { ...item(), status: 'adopted', version: 2, canDelete: false } : item()], total: 1, page: 1, pageSize: 20 });
  } }); t.after(() => h.cleanup()); await h.start();
  deleteButton(h).fire('click'); await h.click('confirmDelete');
  assert.equal(h.$('deleteDialog').open, true); assert.match(h.$('deleteError').textContent, /已处理/);
  assert.equal(h.$('confirmDelete').disabled, true); assert.equal(deleteButton(h), undefined);
  assert.match(h.$('classList').textContent, /已采纳/); await h.click('cancelDelete');
  assert.equal(h.$('refreshClass').focused, true);
});

test('deleting the only item on the last page returns to the preceding valid page', async t => {
  let deleted = false;
  const h = harness({ query: '?view=class', fetch: (url, config) => {
    if (config.method === 'DELETE') { deleted = true; return response({ deleted: true }); }
    if (url.startsWith('/api/ideas/student?')) {
      const page = Number(new URL(url, 'https://classroom.test').searchParams.get('page'));
      return response({ items: [item(`第${page}页`, `idea-${page}`)], total: deleted ? 20 : 21, page, pageSize: 20 });
    }
  } }); t.after(() => h.cleanup()); await h.start(); await h.click('classNext');
  deleteButton(h).fire('click'); await h.click('confirmDelete');
  assert.match(h.$('classList').textContent, /第1页/); assert.equal(h.$('classPrevious').disabled, true);
  assert.equal(h.$('classTotal').textContent, '共 20 条');
});

test('deleting a recent submission after a failed list load does not restore it as a fallback', async t => {
  let deleted = false;
  const h = harness({ fetch: (url, config) => {
    if (config.method === 'DELETE') { deleted = true; return response({ deleted: true }); }
    if (url.startsWith('/api/ideas/student?')) {
      if (!deleted) throw new Error('offline');
      return response({ items: [], total: 0, page: 1, pageSize: 20 });
    }
  } }); t.after(() => h.cleanup()); await h.start(); h.input('ideaText', '删除刚提交的创意'); await h.submit();
  assert.equal(h.$('recentSubmission').hidden, false); deleteButton(h, 'recentSubmission').fire('click'); await h.click('confirmDelete');
  assert.equal(h.$('recentSubmission').hidden, true); assert.equal(h.$('classList').childElementCount, 0);
});

test('a deleted ambiguous submission unlocks its retained draft with a new request id', async t => {
  let attempts = 0;
  const h = harness({ fetch: (_url, config) => {
    if (config.method === 'POST') {
      attempts += 1;
      if (attempts === 1) throw new Error('response lost');
      if (attempts === 2) return response({ error: '原提交已被删除。' }, 410);
    }
  } }); t.after(() => h.cleanup()); await h.start(); h.input('ideaText', '保留原稿'); writeStroke(h); await h.submit();
  const original = JSON.parse(h.calls.find(call => call.method === 'POST').body.get('report')).requestId;
  await h.submit();
  assert.equal(h.$('draftFields').disabled, false); assert.equal(h.$('ideaText').value, '保留原稿');
  assert.equal(h.$('inkEmpty').hidden, true); assert.match(h.$('submitError').textContent, /原提交已被删除/);
  const saved = [...h.records.values()][0]; assert.equal(saved.pending, false); assert.notEqual(saved.requestId, original);
  await h.submit(); assert.equal(attempts, 3);
  const latest = JSON.parse(h.calls.filter(call => call.method === 'POST')[2].body.get('report'));
  assert.equal(latest.requestId, saved.requestId);
});

test('a late delete response cannot remove records from a newly bound class', async t => {
  const pending = deferred(); let otherClass = false;
  const h = harness({ query: '?view=class', fetch: (url, config) => {
    if (url.endsWith('/context') && otherClass) return response({ classId: 'class-2', className: '二班', deviceId: 'device-1' });
    if (config.method === 'DELETE') return pending.promise;
    if (url.startsWith('/api/ideas/student?')) return response({ items: [item(otherClass ? '二班创意' : '一班创意')], total: 1, page: 1, pageSize: 20 });
  } }); t.after(() => h.cleanup()); await h.start();
  deleteButton(h).fire('click'); await h.click('confirmDelete');
  otherClass = true; await h.click('retryContext'); await h.click('refreshClass');
  pending.resolve(response({ deleted: true })); await flush();
  assert.match(h.$('classList').textContent, /二班创意/); assert.equal(h.$('classTotal').textContent, '共 1 条');
  assert.equal(h.$('deleteDialog').open, false); assert.doesNotMatch(h.$('globalNotice').textContent, /已删除/);
});

test('showcase uses curated fields only, including when a server erroneously sends private fields', async t => {
  const h = harness({ query: '?view=showcase', fetch: url => url.startsWith('/api/ideas/showcase?') ? response({ items: [{ ...item('PRIVATE-TEXT'), name: 'PRIVATE-NAME', media: [{ kind: 'image', url: '/api/ideas/media/private' }], className: '一年级一班', publishedTitle: '<img src=x onerror=alert(1)>', publishedText: '已上线用品提醒' }], total: 1, page: 1, pageSize: 20 }) : undefined }); t.after(() => h.cleanup());
  await h.start();
  assert.match(h.$('showcaseList').textContent, /已上线用品提醒/); assert.match(h.$('showcaseList').textContent, /<img/);
  assert.doesNotMatch(h.$('showcaseList').textContent, /PRIVATE/); assert.equal(h.$('showcaseList').querySelectorAll('img, audio').length, 0);
  assert.equal(h.calls.some(call => call.url.startsWith('/api/ideas/student?')), false);
});

test('suspend cancels a pending camera start and stops a stream arriving after cancellation', async t => {
  const permission = deferred(); const h = harness({ media: () => permission.promise }); t.after(() => h.cleanup()); await h.start();
  assert.equal(h.permissionCalls.length, 0); await h.click('openCamera'); assert.equal(h.permissionCalls.length, 1);
  assert.equal(h.$('cameraPanel').open, true); assert.equal(h.$('capturePhoto').disabled, true);
  await h.window.ICeClassIdeas.suspend(); assert.equal(h.$('cameraPanel').open, false);
  permission.resolve(h.stream()); await flush(); assert.equal(h.tracks[0].stopped, 1); assert.equal(h.$('cameraVideo').srcObject, null);
});

test('closing the camera while permission is pending restores focus and keeps the draft', async t => {
  const permission = deferred(); const h = harness({ media: () => permission.promise }); t.after(() => h.cleanup()); await h.start();
  writeStroke(h); h.input('ideaText', '已有创意');
  await h.click('openCamera'); assert.equal(h.$('cameraPanel').open, true);
  await h.click('closeCamera');
  assert.equal(h.$('cameraPanel').open, false); assert.equal(h.$('openCamera').focused, true);
  assert.equal(h.$('openCamera').disabled, false); assert.equal(h.$('inkPen').disabled, false);
  assert.equal(h.$('ideaText').value, '已有创意'); assert.equal(h.$('inkEmpty').hidden, true);
  permission.resolve(h.stream()); await flush();
  assert.equal(h.tracks[0].stopped, 1); assert.equal(h.$('cameraVideo').srcObject, null);
  assert.equal(h.$('cameraPanel').open, false); assert.equal(h.calls.some(call => call.method === 'POST'), false);
});

test('Escape closes the camera dialog and releases the active stream', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); await h.click('openCamera');
  assert.equal(h.$('cameraPanel').open, true); assert.equal(h.$('capturePhoto').disabled, false);
  const event = h.$('cameraPanel').fire('cancel'); await flush();
  assert.equal(event.defaultPrevented, true); assert.equal(h.$('cameraPanel').open, false);
  assert.equal(h.tracks[0].stopped, 1); assert.equal(h.$('cameraVideo').srcObject, null);
  assert.equal(h.$('openCamera').focused, true); assert.equal(h.records.size, 0);
});

test('camera permission failure offers retry inside the same dialog', async t => {
  let attempts = 0;
  const h = harness({ media: (_constraints, stream) => ++attempts === 1
    ? Promise.reject(Object.assign(new Error('Denied'), { name: 'NotAllowedError' })) : Promise.resolve(stream()) });
  t.after(() => h.cleanup()); await h.start(); await h.click('openCamera');
  assert.equal(h.$('cameraPanel').open, true); assert.match(h.$('cameraStatus').textContent, /未获允许/);
  assert.equal(h.$('retryCamera').hidden, false); assert.equal(h.$('capturePhoto').disabled, true);
  await h.click('retryCamera');
  assert.equal(attempts, 2); assert.equal(h.$('cameraPanel').open, true);
  assert.equal(h.$('retryCamera').hidden, true); assert.equal(h.$('capturePhoto').disabled, false);
  assert.ok(h.$('cameraVideo').srcObject); assert.doesNotMatch(h.$('cameraStatus').textContent, /未获允许/);
  await h.click('closeCamera'); assert.equal(h.tracks[0].stopped, 1);
});

test('native camera dialog close releases capture and a stale close event cannot stop a reopened camera', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); await h.click('openCamera');
  h.$('cameraPanel').close(); await flush();
  assert.equal(h.tracks[0].stopped, 1); assert.equal(h.$('openCamera').disabled, false);
  await h.click('openCamera');
  h.$('cameraPanel').fire('close'); await flush();
  assert.equal(h.$('cameraPanel').open, true); assert.equal(h.tracks[1].stopped, 0);
  assert.ok(h.$('cameraVideo').srcObject); assert.equal(h.$('capturePhoto').disabled, false);
  await h.click('closeCamera'); assert.equal(h.tracks[1].stopped, 1);
});

test('hiding the page dismisses the camera dialog and stops capture without requesting focus', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); writeStroke(h); await h.click('openCamera');
  h.document.hidden = true; h.document.fire('visibilitychange'); await flush();
  assert.equal(h.$('cameraPanel').open, false); assert.equal(h.tracks[0].stopped, 1);
  assert.equal(h.$('cameraVideo').srcObject, null); assert.notEqual(h.$('openCamera').focused, true);
  assert.equal([...h.records.values()][0].ink.length, 1);
});

test('camera capture releases tracks before review and an image alone can be submitted', async t => {
  const crop = deferred(); const h = harness({ paperOpen: () => crop.promise }); t.after(() => h.cleanup()); await h.start(); await h.click('openCamera');
  assert.equal(h.permissionCalls.length, 1); await h.click('capturePhoto');
  assert.equal(h.tracks[0].stopped, 1); assert.equal(h.$('cameraVideo').srcObject, null);
  assert.equal(h.$('cameraPanel').open, false);
  assert.equal(h.paperCalls.length, 1); assert.equal(h.$('imageAttachments').childElementCount, 0); assert.equal(h.records.size, 0);
  const frame = h.paperCalls[0]; assert.equal(frame.width, 1920);
  crop.resolve(new Blob(['confirmed-paper'], { type: 'image/jpeg' })); await flush();
  assert.equal(frame.width, 0); assert.equal(frame.height, 0);
  assert.equal(h.$('cameraPanel').open, false); assert.equal(h.$('imageAttachments').childElementCount, 1);
  await h.submit(); const form = h.calls.find(call => call.method === 'POST').body;
  assert.equal(JSON.parse(form.get('report')).text, ''); assert.equal(form.getAll('image').length, 1); assert.equal(form.get('image').type, 'image/jpeg');
});

test('page hiding cancels a pending microphone start without creating a recorder', async t => {
  const permission = deferred(); const h = harness({ media: () => permission.promise }); t.after(() => h.cleanup()); await h.start();
  await h.click('recordVoice'); assert.equal(h.permissionCalls.length, 1);
  h.document.hidden = true; h.document.fire('visibilitychange'); await flush();
  permission.resolve(h.stream()); await flush(); assert.equal(h.tracks[0].stopped, 1); assert.equal(h.recorders.length, 0);
  assert.equal(h.$('voicePanel').hidden, true);
});

test('native prepareToLeave stops recording, waits for WAV conversion, and preserves audio-only submission', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); await h.click('recordVoice');
  assert.equal(h.recorders[0].state, 'recording');
  const result = await h.window.ICeClassIdeas.prepareToLeave();
  assert.equal(result.saved, true); assert.equal(result.hasDraft, true); assert.equal(h.recorders[0].state, 'inactive');
  assert.ok(h.tracks[0].stopped >= 1); assert.equal(h.$('audioAttachment').hidden, false);
  const saved = [...h.records.values()][0]; assert.equal(saved.audio.durationMs, 250); assert.equal(saved.audio.blob.type, 'audio/wav');
  await h.submit(); const form = h.calls.find(call => call.method === 'POST').body; assert.equal(form.get('audio').type, 'audio/wav');
  const data = new DataView(await form.get('audio').arrayBuffer()); assert.equal(data.getUint32(24, true), 16000); assert.equal(data.getUint16(22, true), 1);
});

test('failed re-recording retains the previous audio, and unavailable storage is reported honestly', async t => {
  const h = harness({ storageUnavailable: true }); t.after(() => h.cleanup()); await h.start(); await h.click('recordVoice');
  let result = await h.window.ICeClassIdeas.suspend(); assert.equal(result.saved, false);
  assert.match(h.$('draftNotice').textContent, /当前窗口/);
  const firstUrl = h.$('audioAttachment').querySelectorAll('audio')[0].src;
  h.setDecodeError(true); await h.click('recordVoice'); result = await h.window.ICeClassIdeas.suspend();
  assert.equal(result.hasDraft, true); assert.match(h.$('attachmentMessage').textContent, /原有录音已保留/);
  assert.equal(h.$('audioAttachment').querySelectorAll('audio')[0].src, firstUrl);
});

test('conversion failure blocks native leave and submission while retaining the original recording for retry', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start();
  h.setDecodeError(true); await h.click('recordVoice');
  const result = await h.window.ICeClassIdeas.prepareToLeave();
  assert.equal(result.saved, false); assert.equal(result.hasDraft, true);
  assert.equal(h.recorders[0].state, 'inactive'); assert.ok(h.tracks.every(track => track.stopped >= 1));
  const saved = [...h.records.values()][0];
  assert.equal(saved.rawAudio.type, 'audio/webm;codecs=opus'); assert.equal(await saved.rawAudio.text(), 'encoded-audio');
  assert.equal(h.$('submitIdea').disabled, true); await h.submit(); assert.equal(h.calls.some(call => call.method === 'POST'), false);
  assert.equal(h.$('backButton'), undefined);
  assert.equal((await h.window.ICeClassIdeas.prepareToLeave()).saved, false);
  const reopened = harness({ records: h.records }); t.after(() => reopened.cleanup()); await reopened.start();
  assert.equal(reopened.permissionCalls.length, 0); assert.equal(reopened.$('submitIdea').disabled, true);
  const retry = reopened.$('audioAttachment').querySelectorAll('button').find(button => button.textContent === '重试保存录音');
  assert.ok(retry); retry.fire('click'); await flush();
  assert.equal(reopened.permissionCalls.length, 0); assert.equal(reopened.recorders.length, 0);
  const retried = [...h.records.values()][0]; assert.equal(retried.rawAudio, null); assert.equal(retried.audio.blob.type, 'audio/wav');
  assert.equal(retried.requestId, saved.requestId);
  assert.equal((await reopened.window.ICeClassIdeas.suspend()).saved, true);
  await reopened.submit();
  const post = reopened.calls.find(call => call.method === 'POST'); assert.equal(post.body.get('audio').type, 'audio/wav');
  assert.equal(JSON.parse(post.body.get('report')).requestId, saved.requestId);
});

test('failed replacement conversion keeps both recordings and can be explicitly discarded without losing the old audio', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); await h.click('recordVoice');
  assert.equal((await h.window.ICeClassIdeas.suspend()).saved, true);
  const original = h.$('audioAttachment').querySelectorAll('audio')[0].src;
  h.setDecodeError(true); await h.click('recordVoice');
  const failed = await h.window.ICeClassIdeas.suspend(); assert.equal(failed.saved, false); assert.equal(failed.hasDraft, true);
  assert.equal(h.$('audioAttachment').querySelectorAll('audio')[0].src, original); assert.equal(h.revoked.includes(original), false);
  const retained = [...h.records.values()][0]; assert.equal(retained.audio.blob.type, 'audio/wav'); assert.ok(retained.rawAudio instanceof Blob);
  const discard = h.$('audioAttachment').querySelectorAll('button').find(button => button.textContent === '删除未保存录音');
  assert.ok(discard); discard.fire('click'); await flush();
  assert.equal((await h.window.ICeClassIdeas.suspend()).saved, true);
  assert.equal(h.$('audioAttachment').querySelectorAll('audio')[0].src, original);
  assert.equal([...h.records.values()][0].rawAudio, null);
});

test('leave during a conversion retry waits for its outcome without cancelling it or requesting the microphone', async t => {
  let decoding;
  const h = harness({ decodeAudio: () => decoding?.promise }); t.after(() => h.cleanup()); await h.start();
  h.setDecodeError(true); await h.click('recordVoice'); await h.window.ICeClassIdeas.suspend();
  const requestId = [...h.records.values()][0].requestId;
  decoding = deferred(); h.setDecodeError(false);
  h.$('audioAttachment').querySelectorAll('button').find(button => button.textContent === '重试保存录音').fire('click'); await flush();
  let finished = false;
  const leaving = h.window.ICeClassIdeas.prepareToLeave().then(result => { finished = true; return result; });
  await flush(); const finishedBeforeDecode = finished;
  decoding.resolve(); const result = await leaving;
  assert.equal(finishedBeforeDecode, false); assert.equal(result.saved, true); assert.equal(result.hasDraft, true);
  assert.equal(h.permissionCalls.length, 1); assert.equal(h.recorders.length, 1);
  assert.ok(h.tracks.every(track => track.stopped >= 1));
  const saved = [...h.records.values()][0]; assert.equal(saved.requestId, requestId); assert.equal(saved.rawAudio, null);
  assert.equal(saved.audio.blob.type, 'audio/wav');
});

test('confirmed crop is retained with combined media on an uncertain submit', async t => {
  const h = harness({ fetch: (_url, config) => { if (config.method === 'POST') throw new Error('connection lost'); } });
  t.after(() => h.cleanup()); await h.start();
  h.$('imageInput').files = [new Blob(['source-image'], { type: 'image/png' })]; h.$('imageInput').fire('change');
  await flush();
  const saved = await h.window.ICeClassIdeas.prepareToLeave(); assert.equal(saved.hasDraft, true); assert.equal([...h.records.values()][0].images.length, 1);
  await h.click('recordVoice'); await h.window.ICeClassIdeas.suspend();
  h.input('ideaText', '配上图片和录音'); await h.submit();
  const form = h.calls.find(call => call.method === 'POST').body;
  assert.equal(form.getAll('image').length, 1); assert.equal(form.get('audio').type, 'audio/wav');
  const draft = [...h.records.values()][0]; assert.equal(draft.images.length, 1); assert.equal(draft.audio.blob.type, 'audio/wav'); assert.equal(draft.pending, true);
  assert.equal(h.$('imageAttachments').childElementCount, 1); assert.equal(h.$('audioAttachment').hidden, false);
});

test('a concurrent native leave cannot write a successful draft back after its deletion', async t => {
  const deleting = deferred(); let deletionStarted = false;
  const h = harness({ beforeDelete: () => { deletionStarted = true; return deleting.promise; } }); t.after(() => h.cleanup()); await h.start();
  h.input('ideaText', '成功后不复活旧草稿'); await h.submit(); assert.equal(deletionStarted, true);
  const leaving = h.window.ICeClassIdeas.suspend();
  deleting.resolve(); await leaving; await flush();
  assert.equal(h.$('ideaText').value, ''); assert.equal(h.records.size, 0);
});

test('a failed draft delete retains confirmed submission and retries cleanup once without another POST', async t => {
  let failDelete = true;
  const h = harness({ failDelete: () => failDelete }); t.after(() => h.cleanup()); await h.start();
  h.input('ideaText', '已送达后清理失败'); await h.submit();
  assert.equal(h.$('ideaText').value, '已送达后清理失败'); assert.equal(h.$('draftFields').disabled, true);
  assert.equal(h.$('submitIdea').disabled, false); assert.equal(h.$('submitIdea').textContent, '重试清理草稿');
  assert.match(h.$('submitError').textContent, /已提交.*清理失败/); assert.doesNotMatch(h.$('submitError').textContent, /结果尚未确认/);
  assert.equal(h.$('globalNotice').textContent, ''); assert.equal(h.$('panel-submit').hidden, false);
  assert.equal([...h.records.values()][0].completed.id, 'idea-1');
  const leaving = await h.window.ICeClassIdeas.suspend(); assert.equal(leaving.saved, false); assert.equal(leaving.hasDraft, true);
  assert.equal(h.storageCalls.filter(call => call.action === 'delete').length, 1);
  const reopened = harness({ records: h.records }); t.after(() => reopened.cleanup()); await reopened.start();
  assert.match(reopened.$('submitError').textContent, /已提交.*清理失败/);
  assert.doesNotMatch(reopened.$('submitError').textContent, /结果尚未确认/);
  failDelete = false; await reopened.submit();
  assert.equal(reopened.calls.some(call => call.method === 'POST'), false);
  assert.equal(reopened.storageCalls.filter(call => call.action === 'delete').length, 1);
  assert.equal(reopened.records.size, 0); assert.equal(reopened.$('ideaText').value, '');
  assert.equal(reopened.$('panel-class').hidden, false); assert.match(reopened.$('recentSubmission').textContent, /已送达后清理失败/);
});

test('delete and confirmation-marker failure never clears the form or repeats cleanup on leave', async t => {
  let unavailable = true;
  const h = harness({ failDelete: () => unavailable, beforePut: (_key, value) => { if (unavailable && value.completed) throw new Error('disk unavailable'); } });
  t.after(() => h.cleanup()); await h.start(); h.input('ideaText', '本机故障也不重复发送'); await h.submit();
  assert.equal(h.$('ideaText').value, '本机故障也不重复发送'); assert.match(h.$('submitError').textContent, /已提交.*清理失败/);
  assert.equal(h.$('globalNotice').textContent, '');
  const leaving = await h.window.ICeClassIdeas.suspend(); assert.equal(leaving.saved, false); assert.equal(leaving.hasDraft, true);
  assert.equal(h.storageCalls.filter(call => call.action === 'delete').length, 1);
  unavailable = false; await h.submit();
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(h.storageCalls.filter(call => call.action === 'delete').length, 2);
  assert.equal(h.records.size, 0); assert.equal(h.$('ideaText').value, '');
});

test('details summaries use an inset keyboard focus ring that survives clipped list containers', () => {
  const rule = css.match(/\.ideas-app \.ideas-item summary:focus-visible\s*\{([^}]+)\}/);
  assert.ok(rule, 'A summary-specific focus rule must cover both lists and the recent submission');
  assert.match(rule[1], /outline:\s*[2-9]px solid/);
  assert.match(rule[1], /outline-offset:\s*-[3-9]px/);
});

test('recording stops automatically at its 60-second limit', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); await h.click('recordVoice');
  const limit = h.scheduled.find(timer => timer.delay === 60000); assert.ok(limit);
  limit.fn(); await flush(); assert.equal(h.recorders[0].state, 'inactive');
  assert.equal(h.$('audioAttachment').hidden, false); assert.equal(h.$('voicePanel').hidden, true);
});

test('image selection enforces the count, size and format limits without losing valid files', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start();
  const add = async blobs => { h.$('imageInput').files = blobs; h.$('imageInput').fire('change'); await flush(); };
  await add([new Blob(['<svg/>'], { type: 'image/svg+xml' }), new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/png' })]);
  assert.equal(h.$('imageAttachments').childElementCount, 0); assert.match(h.$('attachmentMessage').textContent, /2 MB/);
  await add(Array.from({ length: 4 }, () => new Blob(['image'], { type: 'image/png' })));
  assert.equal(h.$('imageAttachments').childElementCount, 3); assert.match(h.$('attachmentMessage').textContent, /最多添加 3 张/);
  assert.equal(h.$('addImages').disabled, true); assert.equal(h.permissionCalls.length, 0);
});

function writeStroke(h) {
  const canvas = h.$('inkCanvas');
  canvas.fire('pointerdown', { pointerId: 1, button: 0, isPrimary: true, clientX: 60, clientY: 64 });
  canvas.fire('pointermove', { pointerId: 1, clientX: 360, clientY: 224 });
  canvas.fire('pointerup', { pointerId: 1 });
}

test('handwritten original survives reopen and submits as an image without OCR', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); writeStroke(h);
  assert.equal(h.$('submitIdea').disabled, false);
  assert.equal(h.$('inkEmpty').hidden, true);
  assert.equal((await h.window.ICeClassIdeas.prepareToLeave()).saved, true);
  const stored = [...h.records.values()][0]; assert.equal(stored.ink.length, 1);
  assert.equal(stored.text, ''); assert.equal(stored.images.length, 0);
  const reopened = harness({ records: h.records }); t.after(() => reopened.cleanup()); await reopened.start();
  assert.equal(reopened.$('inkEmpty').hidden, true);
  await reopened.submit();
  const form = reopened.calls.find(call => call.method === 'POST').body;
  assert.equal(form.getAll('image').length, 1); assert.equal(form.get('image').type, 'image/jpeg');
  assert.equal(JSON.parse(form.get('report')).text, '');
  assert.equal(reopened.records.size, 0);
});

test('cropping an imported image is required before it enters drafts or uploads', async t => {
  const crop = deferred(); const h = harness({ paperOpen: () => crop.promise }); t.after(() => h.cleanup()); await h.start();
  const original = new Blob(['private-full-camera-picture'], { type: 'image/png' });
  h.$('imageInput').files = [original]; h.$('imageInput').fire('change'); await flush();
  assert.equal(h.paperCalls.length, 1); assert.equal(h.$('imageAttachments').childElementCount, 0);
  assert.equal(h.records.size, 0); assert.equal(h.calls.some(call => call.method === 'POST'), false);
  crop.resolve(new Blob(['only-the-paper'], { type: 'image/jpeg' })); await flush();
  await h.window.ICeClassIdeas.prepareToLeave();
  assert.equal(await [...h.records.values()][0].images[0].text(), 'only-the-paper');
  await h.submit(); assert.equal(await h.calls.find(call => call.method === 'POST').body.get('image').text(), 'only-the-paper');
});

test('closing while cropping discards the original and ignores a later crop result', async t => {
  const crop = deferred(); const h = harness({ paperOpen: () => crop.promise }); t.after(() => h.cleanup()); await h.start();
  h.$('imageInput').files = [new Blob(['private-original'], { type: 'image/png' })]; h.$('imageInput').fire('change'); await flush();
  const leaving = await h.window.ICeClassIdeas.prepareToLeave();
  assert.equal(leaving.saved, true); assert.equal(leaving.hasDraft, false);
  crop.resolve(new Blob(['late-crop'], { type: 'image/jpeg' })); await flush();
  assert.equal(h.$('imageAttachments').childElementCount, 0);
  assert.ok([...h.records.values()].every(record => record.images.length === 0));
});

test('local transcription keeps original audio and adds confirmed text to the combined submission', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start();
  h.input('ideaText', '原有补充'); await h.click('recordVoice'); await h.window.ICeClassIdeas.suspend();
  const audio = h.$('audioAttachment').querySelectorAll('audio')[0].src;
  await h.click('transcribeVoice');
  const request = h.nativeMessages.find(message => message.type === 'ideas-transcribe');
  assert.ok(request); assert.match(request.audioBase64, /^UklGR/);
  assert.equal(h.calls.some(call => call.url.includes('transcri')), false);
  h.nativeReply({ type: 'ideas-transcription', requestId: request.requestId, text: '希望课间有护眼提醒', error: '' }); await flush();
  assert.equal(h.$('ideaText').value, '原有补充\n\n希望课间有护眼提醒');
  assert.equal(h.$('textEditor').hidden, false);
  assert.equal(h.$('audioAttachment').querySelectorAll('audio')[0].src, audio);
  await h.submit(); const form = h.calls.find(call => call.method === 'POST').body;
  assert.equal(JSON.parse(form.get('report')).text, '原有补充\n\n希望课间有护眼提醒');
  assert.equal(form.get('audio').type, 'audio/wav');
});

test('cancelled transcription cannot overwrite a later recording or its draft', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); await h.click('recordVoice'); await h.window.ICeClassIdeas.suspend();
  await h.click('transcribeVoice'); const request = h.nativeMessages.find(message => message.type === 'ideas-transcribe');
  assert.ok(request); await h.click('cancelTranscription');
  assert.ok(h.nativeMessages.some(message => message.type === 'ideas-transcribe-cancel' && message.requestId === request.requestId));
  await h.click('recordVoice'); await h.window.ICeClassIdeas.suspend();
  h.nativeReply({ type: 'ideas-transcription', requestId: request.requestId, text: '旧录音的迟到文字', error: '' }); await flush();
  assert.equal(h.$('ideaText').value, ''); assert.equal(h.$('submitIdea').disabled, false);
  await h.window.ICeClassIdeas.prepareToLeave(); assert.equal([...h.records.values()][0].transcript, '');
});

test('uncertain handwritten submission restores and retries the exact encoded image', async t => {
  const h = harness({ fetch: (_url, config) => { if (config.method === 'POST') throw new Error('lost response'); } });
  t.after(() => h.cleanup()); await h.start(); writeStroke(h);
  let encodes = 0;
  h.$('inkCanvas').toBlob = (callback, type) => { encodes += 1; callback(new Blob([`original-ink-${encodes}`], { type })); };
  await h.submit();
  const first = h.calls.find(call => call.method === 'POST').body;
  const saved = [...h.records.values()][0]; assert.equal(saved.pending, true); assert.equal(await saved.inkImage.text(), 'original-ink-1');
  const reopened = harness({ records: h.records }); t.after(() => reopened.cleanup()); await reopened.start();
  reopened.$('inkCanvas').toBlob = () => { throw new Error('must use the persisted original'); };
  await reopened.submit();
  const second = reopened.calls.find(call => call.method === 'POST').body;
  assert.equal(first.get('report'), second.get('report'));
  assert.equal(await second.get('image').text(), await first.get('image').text());
  assert.equal(encodes, 1); assert.equal(reopened.records.size, 0);
});

test('handwriting and photos share the attachment limit without discarding any original', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start();
  h.$('imageInput').files = Array.from({ length: 3 }, () => new Blob(['photo'], { type: 'image/png' }));
  h.$('imageInput').fire('change'); await flush(); writeStroke(h);
  assert.equal(h.$('imageAttachments').childElementCount, 3); assert.equal(h.$('submitIdea').disabled, true);
  await h.submit(); assert.equal(h.calls.some(call => call.method === 'POST'), false); assert.match(h.$('submitError').textContent, /合计最多 3/);
  const remove = h.$('imageAttachments').querySelectorAll('button').find(button => button.textContent === '删除图片 1');
  remove.fire('click'); await flush(); assert.equal(h.$('imageAttachments').childElementCount, 2);
  await h.submit(); const form = h.calls.find(call => call.method === 'POST').body;
  assert.equal(form.getAll('image').length, 3); assert.equal(form.getAll('image')[0].name, 'idea-handwriting.jpg');
});

test('failed re-recording keeps edited transcription and transcription errors allow retry', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); await h.click('recordVoice'); await h.window.ICeClassIdeas.suspend();
  await h.click('transcribeVoice'); let request = h.nativeMessages.findLast(message => message.type === 'ideas-transcribe');
  h.nativeReply({ type: 'ideas-transcription', requestId: request.requestId, text: '', error: '没有识别到文字' }); await flush();
  assert.match(h.$('transcriptionStatus').textContent, /没有识别/); assert.equal(h.$('transcribeVoice').disabled, false);
  await h.click('transcribeVoice'); request = h.nativeMessages.findLast(message => message.type === 'ideas-transcribe');
  h.nativeReply({ type: 'ideas-transcription', requestId: request.requestId, text: '识别内容', error: '' }); await flush();
  h.input('ideaText', '学生修改过的内容');
  h.setDecodeError(true); await h.click('recordVoice'); await h.window.ICeClassIdeas.suspend();
  assert.equal(h.$('ideaText').value, '学生修改过的内容');
  assert.equal([...h.records.values()][0].text, '学生修改过的内容');
  h.input('ideaText', ''); assert.equal(h.$('textEditor').hidden, false);
});

test('one text editor validates combined content before moving to review', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start();
  h.input('ideaText', '字'.repeat(3001));
  assert.equal(h.$('textEditor').hidden, false); assert.equal(h.$('inkTools').hidden, false);
  await h.submit(); assert.equal(h.calls.some(call => call.method === 'POST'), false); assert.match(h.$('submitError').textContent, /合计最多 3000/);
  h.input('ideaText', '字'.repeat(2999)); await h.submit(); assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

test('closing during camera crop clears its full frame without saving or uploading it', async t => {
  const crop = deferred(); const h = harness({ paperOpen: () => crop.promise }); t.after(() => h.cleanup()); await h.start();
  await h.click('openCamera'); await h.click('capturePhoto'); const frame = h.paperCalls[0];
  const result = await h.window.ICeClassIdeas.prepareToLeave();
  assert.equal(result.hasDraft, false); assert.equal(frame.width, 0); assert.equal(frame.height, 0);
  crop.resolve(new Blob(['stale crop'], { type: 'image/jpeg' })); await flush();
  assert.equal(h.$('imageAttachments').childElementCount, 0); assert.equal(h.calls.some(call => call.method === 'POST'), false);
  assert.ok([...h.records.values()].every(draft => draft.images.length === 0));
});

test('switching away from the draft cancels transcription and rejects its late result', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start();
  await h.click('recordVoice'); await h.window.ICeClassIdeas.suspend(); await h.click('transcribeVoice');
  const request = h.nativeMessages.find(message => message.type === 'ideas-transcribe'); assert.ok(request);
  await h.click('tab-class');
  assert.ok(h.nativeMessages.some(message => message.type === 'ideas-transcribe-cancel' && message.requestId === request.requestId));
  assert.equal(h.$('submitIdea').disabled, false);
  h.nativeReply({ type: 'ideas-transcription', requestId: request.requestId, text: '迟到结果', error: '' }); await flush();
  assert.equal(h.$('ideaText').value, '');
});

test('next step shows original handwriting and naming inline; returning preserves the draft without a POST', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); writeStroke(h);
  await h.openSubmit();
  assert.equal(h.$('reviewFields').hidden, false); assert.equal(h.$('draftFields').hidden, true);
  assert.match(h.$('reviewSummary').textContent, /手写 1 份/);
  assert.equal(h.$('reviewContent').querySelectorAll('img').length, 1);
  assert.equal(h.$('step-review').attrs['aria-current'], 'step'); assert.equal(h.$('reviewTitle').focused, true);
  assert.equal(h.$('signAnonymous').checked, true); assert.equal(h.$('signatureFields').hidden, true);
  assert.equal(h.calls.some(call => call.method === 'POST'), false);
  await h.click('cancelSubmit'); assert.equal(h.$('reviewFields').hidden, true);
  assert.equal(h.$('inkUndo').disabled, false);
  await h.openSubmit();
  await h.click('cancelSubmit');
  assert.equal(h.$('reviewFields').hidden, true); assert.equal(h.calls.some(call => call.method === 'POST'), false);
  await h.submit();
  const form = h.calls.find(call => call.method === 'POST').body;
  assert.equal(JSON.parse(form.get('report')).name, ''); assert.equal(form.getAll('image').length, 1);
});

test('named submission requires a name, trims it, and preserves its selected identity across uncertain retry', async t => {
  const h = harness({ fetch: (_url, config) => { if (config.method === 'POST') throw new Error('lost confirmation'); } });
  t.after(() => h.cleanup()); await h.start(); h.input('ideaText', '希望早读能提示下一节课');
  await h.openSubmit(); await h.click('signNamed');
  assert.equal(h.$('signAnonymous').checked, false); assert.equal(h.$('signatureFields').hidden, false);
  h.$('ideaForm').fire('submit'); await flush();
  assert.match(h.$('signatureError').textContent, /名字/); assert.equal(h.$('ideaName').attrs['aria-invalid'], 'true');
  assert.equal(h.calls.some(call => call.method === 'POST'), false);
  h.input('ideaName', '  小林  '); assert.equal(h.$('signatureError').hidden, true);
  h.$('ideaForm').fire('submit'); await flush();
  const first = h.calls.find(call => call.method === 'POST').body.get('report');
  assert.equal(JSON.parse(first).name, '小林');
  assert.equal([...h.records.values()][0].signed, true);
  const reopened = harness({ records: h.records }); t.after(() => reopened.cleanup()); await reopened.start();
  await reopened.submit();
  assert.equal(reopened.$('reviewFields').hidden, true);
  assert.equal(reopened.calls.find(call => call.method === 'POST').body.get('report'), first);
});

test('choosing anonymous does not leak an earlier name and saved named drafts restore the choice', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); h.input('ideaText', '在班伴里增加校园活动');
  await h.openSubmit(); await h.click('signNamed'); h.input('ideaName', '小周'); await h.click('cancelSubmit');
  await h.window.ICeClassIdeas.prepareToLeave();
  const reopened = harness({ records: h.records }); t.after(() => reopened.cleanup()); await reopened.start();
  await reopened.openSubmit(); assert.equal(reopened.$('signNamed').checked, true); assert.equal(reopened.$('ideaName').value, '小周');
  await reopened.click('signAnonymous'); assert.equal(reopened.$('signatureFields').hidden, true);
  reopened.$('ideaForm').fire('submit'); await flush();
  assert.equal(JSON.parse(reopened.calls.find(call => call.method === 'POST').body.get('report')).name, '');
});

test('a pre-upgrade pending draft retries its exact name and content without a new naming choice', async t => {
  const record = { requestId: newRequestId(), text: '原始创意', name: '  原署名  ', images: [], audio: null, pending: true };
  const records = new Map([[JSON.stringify(['class-1', 'device-1']), record]]);
  const h = harness({ records }); t.after(() => h.cleanup()); await h.start(); await h.submit();
  const report = JSON.parse(h.calls.find(call => call.method === 'POST').body.get('report'));
  assert.equal(report.name, record.name); assert.equal(report.text, record.text); assert.equal(report.requestId, record.requestId);
  assert.equal(h.$('reviewFields').hidden, true);
});

test('ending speech automatically transcribes into the one text editor and retains original audio', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start();
  h.input('ideaText', '希望早读有更多活动'); writeStroke(h);
  await h.click('recordVoice');
  assert.equal(h.$('voicePanel').hidden, false);
  assert.equal(h.$('recordVoiceLabel').textContent, '结束录音'); assert.equal(h.$('ideaText').disabled, true);
  await h.click('recordVoice');
  assert.equal(h.tracks.every(track => track.stopped > 0), true);
  const request = h.nativeMessages.find(message => message.type === 'ideas-transcribe'); assert.ok(request);
  assert.equal(h.$('submitIdea').disabled, true);
  h.nativeReply({ type: 'ideas-transcription', requestId: request.requestId, text: '再加一个用品提醒', error: '' }); await flush();
  assert.equal(h.$('ideaText').value, '希望早读有更多活动\n\n再加一个用品提醒');
  assert.equal(h.$('ideaText').disabled, false); assert.equal(h.$('textEditor').hidden, false);
  assert.equal(h.$('audioAttachment').hidden, false); assert.equal(h.$('inkEmpty').hidden, true);
  await h.openSubmit();
  assert.match(h.$('reviewContent').textContent, /再加一个用品提醒/);
  assert.equal(h.$('reviewContent').querySelectorAll('audio').length, 1);
  assert.equal(h.$('reviewContent').querySelectorAll('img').length, 1);
  await h.submit();
  const form = h.calls.find(call => call.method === 'POST').body;
  assert.equal(form.get('audio').type, 'audio/wav'); assert.equal(form.getAll('image').length, 1);
});

test('review shows all media, and returning allows editing unified text without losing the recording or photos', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start();
  h.$('imageInput').files = [new Blob(['paper'], { type: 'image/png' })]; h.$('imageInput').fire('change'); await flush();
  writeStroke(h); await h.click('recordVoice'); await h.click('recordVoice');
  const original = h.$('audioAttachment').querySelectorAll('audio')[0].src;
  const request = h.nativeMessages.findLast(message => message.type === 'ideas-transcribe');
  h.nativeReply({ type: 'ideas-transcription', requestId: request.requestId, text: '第一条创意', error: '' }); await flush();
  await h.openSubmit(); assert.equal(h.calls.some(call => call.method === 'POST'), false);
  assert.equal(h.$('reviewContent').querySelectorAll('img').length, 2);
  assert.equal(h.$('reviewContent').querySelectorAll('audio')[0].src, original);
  const previewUrl = h.$('reviewContent').querySelectorAll('img')[0].src;
  await h.click('cancelSubmit'); assert.equal(h.revoked.includes(previewUrl), true);
  h.input('ideaText', '第一条创意，再加一个提醒');
  assert.equal(h.$('audioAttachment').querySelectorAll('audio')[0].src, original);
  await h.openSubmit(); assert.match(h.$('reviewContent').textContent, /第一条创意，再加一个提醒/);
  await h.submit();
  const form = h.calls.find(call => call.method === 'POST').body;
  assert.equal(JSON.parse(form.get('report')).text, '第一条创意，再加一个提醒');
  assert.equal(form.get('audio').type, 'audio/wav'); assert.equal(form.getAll('image').length, 2);
});

test('name dictation fills the confirmation field; closing it rejects late results', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); writeStroke(h); await h.openSubmit(); await h.click('signNamed');
  await h.click('dictateName'); await h.click('dictateName');
  let request = h.nativeMessages.findLast(message => message.type === 'ideas-transcribe'); assert.ok(request);
  h.nativeReply({ type: 'ideas-transcription', requestId: request.requestId, text: '林同学', error: '' }); await flush();
  assert.equal(h.$('ideaName').value, '林同学'); assert.equal(h.$('reviewFields').hidden, false);
  await h.click('dictateName'); await h.click('dictateName');
  request = h.nativeMessages.findLast(message => message.type === 'ideas-transcribe');
  await h.click('cancelSubmit');
  assert.ok(h.nativeMessages.some(message => message.type === 'ideas-transcribe-cancel' && message.requestId === request.requestId));
  h.nativeReply({ type: 'ideas-transcription', requestId: request.requestId, text: '迟到姓名', error: '' }); await flush();
  assert.equal(h.$('ideaName').value, '林同学'); assert.equal(h.calls.some(call => call.method === 'POST'), false);
  await h.submit(); assert.equal(JSON.parse(h.calls.find(call => call.method === 'POST').body.get('report')).name, '林同学');
});

test('cancel, returning to editing, and native close discard name dictation without touching content', async t => {
  const decoding = deferred(); let holdDecode = false;
  const h = harness({ decodeAudio: () => holdDecode ? decoding.promise : undefined }); t.after(() => h.cleanup());
  await h.start(); h.input('ideaText', '保留正文'); await h.openSubmit(); await h.click('signNamed');
  await h.click('dictateName'); await h.click('cancelDictateName');
  assert.equal(h.nativeMessages.some(message => message.type === 'ideas-transcribe'), false);
  assert.equal(h.$('dictateNameLabel').textContent, '说出名字'); assert.equal(h.tracks.every(track => track.stopped > 0), true);
  await h.click('dictateName'); await h.click('dictateName');
  const request = h.nativeMessages.findLast(message => message.type === 'ideas-transcribe');
  await h.click('cancelSubmit');
  h.nativeReply({ type: 'ideas-transcription', requestId: request.requestId, text: '不该填入的内容', error: '' }); await flush();
  assert.equal(h.$('ideaText').value, '保留正文');
  await h.openSubmit(); await h.click('dictateName'); holdDecode = true; await h.click('dictateName');
  const leaving = await h.window.ICeClassIdeas.suspend(); assert.equal(leaving.saved, true);
  decoding.resolve(); await flush();
  assert.equal(h.nativeMessages.filter(message => message.type === 'ideas-transcribe').length, 1);
  const draft = [...h.records.values()][0]; assert.equal(draft.text, '保留正文'); assert.equal(draft.audio, null); assert.equal(draft.rawAudio, null);
});

test('switching the naming choice stops the microphone while its permission is pending', async t => {
  const permission = deferred(); const h = harness({ media: () => permission.promise }); t.after(() => h.cleanup());
  await h.start(); h.input('ideaText', '我的创意'); await h.openSubmit(); await h.click('signNamed'); await h.click('dictateName');
  await h.click('signAnonymous');
  const late = h.stream(); permission.resolve(late); await flush();
  assert.equal(h.recorders.length, 0); assert.equal(h.tracks[0].stopped, 1); assert.equal(h.$('signatureFields').hidden, true);
  h.$('ideaForm').fire('submit'); await flush();
  assert.equal(JSON.parse(h.calls.find(call => call.method === 'POST').body.get('report')).name, '');
});

test('name dictation reports permission, conversion and recognition errors without changing the draft', async t => {
  let allowMicrophone = false;
  const h = harness({ media: (_constraints, stream) => allowMicrophone ? Promise.resolve(stream()) : Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) });
  t.after(() => h.cleanup()); await h.start(); h.input('ideaText', '原文'); await h.openSubmit(); await h.click('signNamed');
  await h.click('dictateName');
  assert.match(h.$('dictationNameStatus').textContent, /未获允许/); assert.equal(h.$('dictateName').disabled, false);
  allowMicrophone = true; h.setDecodeError(true); await h.click('dictateName'); await h.click('dictateName');
  assert.match(h.$('dictationNameStatus').textContent, /无法读取/); assert.equal(h.$('dictateName').disabled, false);
  h.setDecodeError(false); await h.click('dictateName'); await h.click('dictateName');
  const request = h.nativeMessages.findLast(message => message.type === 'ideas-transcribe');
  h.nativeReply({ type: 'ideas-transcription', requestId: request.requestId, text: '', error: '没有识别到文字' }); await flush();
  assert.match(h.$('dictationNameStatus').textContent, /没有识别/); assert.equal(h.$('dictateName').disabled, false);
  assert.equal(h.$('ideaText').value, '原文'); assert.equal(h.$('audioAttachment').hidden, true);
  const result = await h.window.ICeClassIdeas.prepareToLeave(); assert.equal(result.saved, true);
});

test('name dictation rejects too-long results, changed names, and times out with an enabled retry', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); h.input('ideaText', '创意'); await h.openSubmit(); await h.click('signNamed');
  h.input('ideaName', '名'.repeat(39));
  await h.click('dictateName'); await h.click('dictateName');
  let request = h.nativeMessages.findLast(message => message.type === 'ideas-transcribe');
  h.nativeReply({ type: 'ideas-transcription', requestId: request.requestId, text: '增加两个字', error: '' }); await flush();
  assert.equal(h.$('ideaName').value.length, 39); assert.match(h.$('dictationNameStatus').textContent, /40/);
  h.input('ideaName', '原名'); await h.click('dictateName'); await h.click('dictateName');
  request = h.nativeMessages.findLast(message => message.type === 'ideas-transcribe'); h.input('ideaName', '后来修改');
  h.nativeReply({ type: 'ideas-transcription', requestId: request.requestId, text: '迟到结果', error: '' }); await flush();
  assert.equal(h.$('ideaName').value, '后来修改'); assert.match(h.$('dictationNameStatus').textContent, /已修改/);
  await h.click('dictateName'); await h.click('dictateName');
  request = h.nativeMessages.findLast(message => message.type === 'ideas-transcribe');
  h.scheduled.findLast(timer => timer.delay === 120000).fn(); await flush();
  assert.match(h.$('dictationNameStatus').textContent, /超时/); assert.equal(h.$('dictateName').disabled, false);
  assert.ok(h.nativeMessages.some(message => message.type === 'ideas-transcribe-cancel' && message.requestId === request.requestId));
});

test('selecting each ink tool updates both its pressed state and the canvas cursor state', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start();
  await h.click('inkEraser'); assert.equal(h.$('inkEraser').attrs['aria-pressed'], 'true'); assert.equal(h.$('inkCanvas').dataset.tool, 'eraser');
  await h.click('inkPen'); assert.equal(h.$('inkPen').attrs['aria-pressed'], 'true'); assert.equal(h.$('inkEraser').attrs['aria-pressed'], 'false');
  assert.equal(h.$('inkCanvas').dataset.tool, 'pen');
});

test('failed automatic transcription retains audio, offers a retry, and permits audio-only confirmation', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start();
  await h.click('recordVoice'); await h.click('recordVoice');
  const audioUrl = h.$('audioAttachment').querySelectorAll('audio')[0].src;
  const first = h.nativeMessages.findLast(message => message.type === 'ideas-transcribe'); assert.ok(first);
  h.nativeReply({ type: 'ideas-transcription', requestId: first.requestId, text: '', error: '暂时无法识别，请重试。' }); await flush();
  assert.equal(h.$('transcribeVoice').hidden, false); assert.equal(h.$('submitIdea').disabled, false);
  await h.click('transcribeVoice');
  const second = h.nativeMessages.findLast(message => message.type === 'ideas-transcribe'); assert.notEqual(first.requestId, second.requestId);
  assert.equal(second.audioBase64, first.audioBase64);
  await h.click('cancelTranscription');
  assert.equal(h.$('audioAttachment').querySelectorAll('audio')[0].src, audioUrl);
  await h.openSubmit(); assert.equal(h.$('reviewContent').querySelectorAll('audio')[0].src, audioUrl);
  assert.match(h.$('reviewSummary').textContent, /录音 1 段/);
  await h.submit(); const form = h.calls.find(call => call.method === 'POST').body;
  assert.equal(form.get('audio').type, 'audio/wav'); assert.equal(JSON.parse(form.get('report')).text, '');
});

test('editing successfully transcribed text cannot append the same recording a second time after reopen', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start();
  await h.click('recordVoice'); await h.click('recordVoice');
  const request = h.nativeMessages.findLast(message => message.type === 'ideas-transcribe');
  h.nativeReply({ type: 'ideas-transcription', requestId: request.requestId, text: '同学的想法', error: '' }); await flush();
  assert.equal(h.$('transcribeVoice').hidden, true);
  h.input('ideaText', '同学修改后的想法'); await h.window.ICeClassIdeas.prepareToLeave();
  const reopened = harness({ records: h.records }); t.after(() => reopened.cleanup()); await reopened.start();
  assert.equal(reopened.$('ideaText').value, '同学修改后的想法'); assert.equal(reopened.$('transcribeVoice').hidden, true);
  await reopened.click('transcribeVoice'); assert.equal(reopened.nativeMessages.length, 0);
  await reopened.submit();
  assert.equal(JSON.parse(reopened.calls.find(call => call.method === 'POST').body.get('report')).text, '同学修改后的想法');
});

test('legacy text and transcript appear in one editor and retain the exact combined payload on an uncertain retry', async t => {
  const draft = { requestId: newRequestId(), text: '原正文', transcript: '原语音文字', name: '  原署名  ', signed: true, images: [], pending: true };
  const records = new Map([[JSON.stringify(['class-1', 'device-1']), draft]]);
  const h = harness({ records }); t.after(() => h.cleanup()); await h.start();
  assert.equal(h.$('textEditor').hidden, false); assert.equal(h.$('ideaText').value, '原正文\n\n原语音文字');
  await h.submit();
  assert.deepEqual(JSON.parse(h.calls.find(call => call.method === 'POST').body.get('report')),
    { requestId: draft.requestId, text: '原正文\n\n原语音文字', name: draft.name });
});

test('a delayed handwriting preview can be cancelled on leave without reopening review or posting', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); writeStroke(h);
  let encode;
  h.$('inkCanvas').toBlob = callback => { encode = callback; };
  await h.openSubmit(); assert.equal(h.$('submitIdea').disabled, true);
  await h.openSubmit(); assert.equal(h.calls.some(call => call.method === 'POST'), false);
  const leaving = await h.window.ICeClassIdeas.prepareToLeave(); assert.equal(leaving.saved, true);
  encode(new Blob(['late-ink'], { type: 'image/jpeg' })); await flush();
  assert.equal(h.$('reviewFields').hidden, true); assert.equal(h.$('draftFields').hidden, false);
  assert.equal(h.$('submitIdea').disabled, false); assert.equal(h.calls.some(call => call.method === 'POST'), false);
  assert.equal([...h.records.values()][0].ink.length, 1);
});

test('handwriting changed after returning regenerates the reviewed original before final confirmation', async t => {
  const h = harness(); t.after(() => h.cleanup()); await h.start(); writeStroke(h);
  let encoded = 0;
  h.$('inkCanvas').toBlob = (callback, type) => callback(new Blob([`handwriting-${++encoded}`], { type }));
  await h.openSubmit(); await h.click('cancelSubmit'); writeStroke(h); await h.openSubmit();
  assert.equal(encoded, 2); assert.equal(h.calls.some(call => call.method === 'POST'), false);
  await h.submit();
  assert.equal(await h.calls.find(call => call.method === 'POST').body.get('image').text(), 'handwriting-2');
});

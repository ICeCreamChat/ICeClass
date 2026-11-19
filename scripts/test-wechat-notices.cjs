'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const data = require('../miniprogram/teacher/lib/notice-data');

const root = path.resolve(__dirname, '../miniprogram/teacher');
const classes = [{ id: 'class-a', name: '高一（1）班', enabled: 1 }, { id: 'class-b', name: '高二（2）班', enabled: 1 }];
const quietPeriod = { id: 'period-1', name: '上课', startTime: '08:00', endTime: '08:40', weekdays: [1, 2, 3, 4, 5] };
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function apiError(message, status, extra = {}) { return Object.assign(new Error(message), { status, ...extra }); }
function historyRow(id = 'notice-1', extra = {}) {
  return {
    id, class_id: 'class-a', class_name: '高一（1）班', sender_name: '测试教师', text: '请准备上课',
    alert_level: 'warning', status: 'sent', status_detail: '', created_at: 1000,
    received_at: null, displayed_at: null, acknowledged_at: null, content_type: 'text',
    audio_duration_ms: null, quiet_override: 0, ...extra
  };
}
function wav({ rate = 16000, duration = 1, channels = 1, bits = 16, encoding = 1 } = {}) {
  const audioSize = Math.round(rate * duration) * channels * bits / 8;
  const buffer = Buffer.alloc(44 + audioSize);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(encoding, 20);
  buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * channels * bits / 8, 28); buffer.writeUInt16LE(channels * bits / 8, 32);
  buffer.writeUInt16LE(bits, 34); buffer.write('data', 36); buffer.writeUInt32LE(audioSize, 40);
  return buffer;
}

function fixture(name = 'notices', options = {}) {
  const calls = [], confirmations = [], uploads = [], navigations = [], toasts = [];
  let currentUser = { id: 'teacher-1', role: 'teacher', permissions: {} }, selectedClassId = 'class-a';
  let definition, stopped = 0, logins = 0;
  const runtime = {
    stopPullDownRefresh() { stopped += 1; },
    navigateTo(value) { navigations.push(value.url); if (value.success) value.success(); },
    chooseMessageFile(value) {
      if (options.chooseMessageFile) return options.chooseMessageFile(value);
      value.success({ tempFiles: [{ name: '教师原声.wav', path: '/mock/voice.wav', size: wav().length }] });
    },
    getFileSystemManager() { return { readFile(value) {
      if (options.readFile) return options.readFile(value);
      value.success({ data: wav() });
    } }; }
  };
  const api = {
    getUser: () => currentUser,
    getClassId: () => selectedClassId,
    selectClass: id => { selectedClassId = id; },
    async request(url, request = {}) {
      calls.push({ url, ...request });
      if (options.request) return options.request(url, request);
      if (url === '/api/quiet-hours') return { activePeriod: null };
      if (url === '/api/shouts') return { id: 'notice-new', status: 'sent' };
      if (url.startsWith('/api/history?')) return { history: [], hasMore: false, offset: 0 };
      if (url.endsWith('/status')) return { online: true };
      throw new Error(`Unexpected mock request: ${url}`);
    },
    async upload(url, filePath, formData) {
      uploads.push({ url, filePath, formData });
      return options.upload ? options.upload(url, filePath, formData) : { id: 'voice-new', status: 'sent' };
    }
  };
  const ui = {
    requireLogin() { if (currentUser) return true; logins += 1; return false; },
    async loadClasses(page) {
      const items = options.loadClasses ? await options.loadClasses() : classes;
      const index = Math.max(0, items.findIndex(item => item.id === selectedClassId));
      page.setData({ classes: items, classNames: items.map(item => item.name), classIndex: items.length ? index : -1, classId: items[index] ? items[index].id : '' });
      return items;
    },
    chooseClass(page, index) {
      const item = page.data.classes[index];
      selectedClassId = item.id;
      page.setData({ classIndex: index, classId: item.id });
      return item;
    },
    fail(page, error) {
      if (error.code === 'session_changed') return;
      page.setData({ error: error.message, sessionExpired: error.status === 401 });
    },
    query(values) {
      return Object.entries(values).filter(([, value]) => value !== '' && value !== undefined && value !== null)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
    },
    async confirm(title, content, confirmText) {
      assert.ok(Array.from(confirmText || '确定').length <= 4, '微信确认弹窗按钮最多四个字符');
      confirmations.push({ title, content, confirmText });
      return options.confirm ? options.confirm(title, content, confirmText) : true;
    },
    formatTime: value => `北京时间:${value}`,
    relogin() { logins += 1; },
    toast: value => toasts.push(value),
    setDirty() {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages', name, 'index.js'), 'utf8'), {
    Page(value) { definition = value; }, wx: runtime,
    require(id) {
      if (id === '../../lib/api') return api;
      if (id === '../../lib/ui') return ui;
      if (id === '../../lib/notice-data') return data;
      if (id === '../../lib/notice-audio') return require('../miniprogram/teacher/lib/notice-audio');
      throw new Error(`Unexpected module: ${id}`);
    }
  }, { filename: `pages/${name}/index.js` });
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  page.onLoad(options.route || {});
  return {
    page, api, ui, runtime, calls, confirmations, uploads, navigations, toasts,
    get stopped() { return stopped; }, get logins() { return logins; },
    setUser(value) { currentUser = value; },
    async ready() { await page.onShow(); return page; },
    writes() { return calls.filter(value => value.method === 'POST' || value.method === 'PUT' || value.method === 'DELETE'); }
  };
}

test('text payload matches the real server fields, trims content and keeps silent notices silent', () => {
  const notice = data.buildNotice({ classId: 'class-a', modeIndex: 0, text: '  请准备上课\n ', levelIndex: 0, durationIndex: 1, speedIndex: 3, volumeIndex: 4 }, classes[0]);
  assert.deepEqual(notice.values, { classId: 'class-a', alertLevel: 'info', ttsVolume: 0, ttsSpeed: 0, displayDurationSec: 8, text: '请准备上课' });
  assert.equal(notice.originalText, '  请准备上课\n ');
  assert.throws(() => data.buildNotice({ classId: 'class-b' }, classes[0]), /目标班级/);
  assert.throws(() => data.buildNotice({ classId: 'class-a', modeIndex: 0, text: ' ', levelIndex: 0, durationIndex: 1, speedIndex: 1, volumeIndex: 4 }, classes[0]), /1-500/);
});

test('audio requires an actual file and a sound-capable level', () => {
  const draft = { classId: 'class-a', modeIndex: 1, text: '文字草稿', levelIndex: 0, durationIndex: 3, speedIndex: 3, volumeIndex: 3 };
  assert.throws(() => data.buildNotice(draft, classes[0]), /重要.*紧急/);
  assert.throws(() => data.buildNotice({ ...draft, levelIndex: 1 }, classes[0]), /WAV/);
  const notice = data.buildNotice({ ...draft, levelIndex: 1, audioFile: { path: '/mock/a.wav', name: 'a.wav', durationMs: 1000 } }, classes[0]);
  assert.equal(notice.values.ttsSpeed, 0);
  assert.equal(notice.values.ttsVolume, 0.75);
  assert.ok(!Object.hasOwn(notice.values, 'text'));
});

test('WAV validation accepts server sample rates and duration boundaries, including ArrayBuffer', () => {
  for (const rate of [8000, 16000, 22050, 44100, 48000]) {
    for (const duration of [0.5, 30]) assert.equal(data.validateWav(wav({ rate, duration })).durationMs, duration * 1000);
  }
  const input = wav();
  assert.equal(data.validateWav(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)).durationMs, 1000);
});

test('WAV validation rejects renamed MP3, stereo, compressed, short and truncated files', () => {
  assert.throws(() => data.validateWav(Buffer.alloc(100)), /不是 WAV/);
  for (const input of [wav({ channels: 2 }), wav({ bits: 8 }), wav({ encoding: 3 }), wav({ rate: 11025 })]) assert.throws(() => data.validateWav(input), /PCM/);
  assert.throws(() => data.validateWav(wav({ duration: 0.2 })), /0.5-30/);
  assert.throws(() => data.validateWav(wav({ duration: 31 })), /0.5-30/);
  assert.throws(() => data.validateWav(wav().subarray(0, 60)), /不完整/);
});

test('history uses acknowledged_at, preserves failed/offline status, and shows only actual receipt times', () => {
  const map = row => data.mapHistoryItem(row, value => `t:${value}`);
  assert.equal(map(historyRow('1', { status: 'displayed' })).statusLabel, '已展示，待知晓');
  const acknowledged = map(historyRow('2', { status: 'displayed', received_at: 1100, displayed_at: 1200, acknowledged_at: 1400 }));
  assert.equal(acknowledged.status, 'acknowledged');
  assert.equal(acknowledged.statusLabel, '教室已知晓');
  assert.deepEqual(acknowledged.timeline.map(item => item.label), ['发出', '收到', '展示', '知晓']);
  assert.equal(map(historyRow('3', { status: 'failed', received_at: 1100 })).statusLabel, '处理失败');
  assert.equal(map(historyRow('4', { status: 'offline' })).statusLabel, '教室离线');
  assert.equal(map(historyRow('5', { status: 'received' })).statusLabel, '教室已收到');
  assert.equal(map(historyRow('6', { status: 'sent' })).timeline.length, 1);
  assert.equal(map(historyRow('7', { status: 'future-status' })).statusLabel, '未知状态');
  const voice = map(historyRow('8', { content_type: 'audio', audio_duration_ms: 1500, quiet_override: 1 }));
  assert.equal(voice.text, '教师原声'); assert.equal(voice.audioDuration, '1.5 秒'); assert.equal(voice.quietOverride, true);
});

test('cancelled send confirmation makes no write and preserves the exact text draft', async () => {
  const f = fixture('notices', { confirm: () => false }); await f.ready();
  f.page.onTextInput({ detail: { value: ' 原样保留\n正文 ' } });
  await f.page.sendNotice();
  assert.equal(f.writes().length, 0); assert.equal(f.page.data.text, ' 原样保留\n正文 ');
  assert.match(f.confirmations[0].content, /高一（1）班/); assert.match(f.confirmations[0].content, /静音展示/);
  assert.match(f.confirmations[0].content, /原样保留\n正文/); assert.equal(f.page.data.busy, false);
});

test('send locks duplicate clicks and class/parameter controls until the write finishes', async () => {
  const pending = deferred();
  const f = fixture('notices', { request(url) {
    if (url === '/api/shouts') return pending.promise;
    if (url === '/api/quiet-hours') return { activePeriod: null };
    if (url.endsWith('/status')) return { online: true };
    return { history: [], hasMore: false };
  } });
  await f.ready(); f.page.onTextInput({ detail: { value: '通知一' } });
  const send = f.page.sendNotice(); await tick();
  await f.page.sendNotice(); f.page.onClassChange({ detail: { value: '1' } });
  f.page.onTextInput({ detail: { value: '修改' } }); f.page.onLevelChange({ detail: { value: '2' } });
  assert.equal(f.writes().length, 1); assert.equal(f.page.data.classId, 'class-a'); assert.equal(f.page.data.text, '通知一'); assert.equal(f.page.data.levelIndex, 0);
  pending.resolve({ id: 'one', status: 'sent' }); await send;
  assert.equal(f.page.data.text, ''); assert.equal(f.page.data.busy, false);
  assert.match(f.page.data.lastResult.label, /尚未确认送达/);
});

test('known quiet hours require an explicit warning before quietAcknowledged is true', async () => {
  const f = fixture('notices', { request(url) {
    if (url === '/api/quiet-hours') return { activePeriod: quietPeriod };
    if (url === '/api/shouts') return { id: 'quiet', status: 'sent' };
    return url.endsWith('/status') ? { online: true } : { history: [] };
  } });
  await f.ready(); f.page.onTextInput({ detail: { value: '请安静' } }); await f.page.sendNotice();
  assert.equal(f.writes()[0].data.quietAcknowledged, true);
  assert.equal(f.confirmations[0].confirmText, '仍然发送'); assert.match(f.confirmations[0].content, /08:00-08:40/);
});

test('quiet 409 never retries without a second explicit confirmation', async () => {
  let writes = 0;
  const f = fixture('notices', {
    confirm: () => f.confirmations.length === 1,
    request(url) {
      if (url === '/api/quiet-hours') return { activePeriod: null };
      if (url === '/api/shouts') { writes += 1; throw apiError('当前是禁言上课时间，请确认后再发送。', 409, { code: 'quiet_confirmation_required', data: { quietPeriod } }); }
      return url.endsWith('/status') ? { online: true } : { history: [] };
    }
  });
  await f.ready(); f.page.onTextInput({ detail: { value: '请安静' } }); await f.page.sendNotice();
  assert.equal(writes, 1); assert.equal(f.writes()[0].data.quietAcknowledged, false);
  assert.equal(f.confirmations.length, 2); assert.equal(f.confirmations[1].confirmText, '仍然发送');
  assert.equal(f.page.data.text, '请安静'); assert.match(f.page.data.error, /禁言/);
});

test('an explicitly accepted quiet 409 sends once more with quietAcknowledged true', async () => {
  let writes = 0;
  const f = fixture('notices', { request(url) {
    if (url === '/api/quiet-hours') return { activePeriod: null };
    if (url === '/api/shouts') {
      writes += 1;
      if (writes === 1) throw apiError('请确认禁言时间发送。', 409, { data: { code: 'quiet_confirmation_required', quietPeriod } });
      return { id: 'quiet', status: 'sent' };
    }
    return url.endsWith('/status') ? { online: true } : { history: [] };
  } });
  await f.ready(); f.page.onTextInput({ detail: { value: '明确确认' } }); await f.page.sendNotice();
  assert.deepEqual(f.writes().map(item => item.data.quietAcknowledged), [false, true]);
  assert.equal(f.confirmations.length, 2); assert.equal(f.page.data.text, '');
});

test('offline results preserve drafts and clearly say no replay after reconnecting', async () => {
  const f = fixture('notices', { request(url) {
    if (url === '/api/shouts') return { id: 'offline-1', status: 'offline', detail: '教室连接刚刚断开。' };
    if (url === '/api/quiet-hours') return { activePeriod: null };
    return url.endsWith('/status') ? { online: false } : { history: [] };
  } });
  await f.ready(); f.page.onTextInput({ detail: { value: '离线草稿' } }); await f.page.sendNotice();
  assert.equal(f.page.data.text, '离线草稿'); assert.match(f.page.data.lastResult.detail, /不会补播.*草稿已保留/);
  assert.equal(f.writes().length, 1);
});

test('ambiguous writes preserve text and prevent repeat sends until record review and explicit unlock', async () => {
  const f = fixture('notices', { request(url) {
    if (url === '/api/shouts') throw apiError('发送超时，请核对记录。', 0, { code: 'timeout', ambiguous: true });
    if (url === '/api/quiet-hours') return { activePeriod: null };
    return url.endsWith('/status') ? { online: true } : { history: [] };
  } });
  await f.ready(); f.page.onTextInput({ detail: { value: '超时草稿' } }); await f.page.sendNotice();
  assert.equal(f.page.data.text, '超时草稿'); assert.equal(f.page.data.uncertain, true);
  await f.page.sendNotice(); await f.page.resolveUncertain(); assert.equal(f.writes().length, 1); assert.equal(f.page.data.uncertain, true);
  f.page.openHistory(); assert.match(f.navigations[0], /classId=class-a/);
  await f.page.resolveUncertain(); assert.equal(f.page.data.uncertain, false); assert.equal(f.writes().length, 1);
  assert.match(f.confirmations.at(-1).content, /确认未发出/);
});

test('401 preserves text and provides relogin; 403 preserves the original server message', async () => {
  for (const status of [401, 403]) {
    const message = status === 401 ? '登录已过期，请重新登录。' : '没有此班级的发送权限。';
    const f = fixture('notices', { request(url) {
      if (url === '/api/quiet-hours') return { activePeriod: null };
      if (url === '/api/shouts') { if (status === 401) f.setUser(null); throw apiError(message, status); }
      return url.endsWith('/status') ? { online: true } : { history: [] };
    } });
    await f.ready(); f.page.onTextInput({ detail: { value: '认证失败草稿' } }); await f.page.sendNotice();
    assert.equal(f.page.data.error, message); assert.equal(f.page.data.text, '认证失败草稿'); assert.equal(f.page.data.sessionExpired, status === 401);
    assert.equal(f.navigations.length, 0); f.page.relogin(); assert.equal(f.logins, 1);
  }
});

test('WAV is checked before upload; multipart uses the real fields as strings and preserves text on success', async () => {
  const f = fixture(); await f.ready();
  f.page.onTextInput({ detail: { value: '保留另一种方式的草稿' } }); f.page.onModeChange({ detail: { value: '1' } });
  await f.page.chooseWav(); assert.equal(f.page.data.audioFile.durationMs, 1000); assert.equal(f.uploads.length, 0);
  await f.page.sendNotice();
  assert.equal(f.uploads.length, 1); assert.equal(f.writes().length, 0);
  assert.deepEqual(plain(f.uploads[0]), { url: '/api/shouts', filePath: '/mock/voice.wav', formData: { classId: 'class-a', alertLevel: 'warning', ttsVolume: '1', ttsSpeed: '0', displayDurationSec: '12', quietAcknowledged: 'false' } });
  assert.equal(f.page.data.audioFile, null); assert.equal(f.page.data.text, '保留另一种方式的草稿');
});

test('invalid or cancelled file choices preserve the previously selected WAV', async () => {
  for (const cancel of [false, true]) {
    const previous = { path: '/mock/previous.wav', name: 'previous.wav', durationMs: 1000 };
    const f = fixture('notices', {
      chooseMessageFile(value) {
        if (cancel) value.fail({ errMsg: 'chooseMessageFile:fail cancel' });
        else value.success({ tempFiles: [{ name: 'renamed.wav', path: '/mock/not-wav.wav', size: 100 }] });
      },
      readFile(value) { value.success({ data: Buffer.alloc(100) }); }
    });
    await f.ready(); f.page.setData({ audioFile: previous }); await f.page.chooseWav();
    assert.equal(f.page.data.audioFile.path, previous.path); assert.equal(f.uploads.length, 0); assert.equal(f.page.data.fileBusy, false);
    assert.equal(Boolean(f.page.data.error), !cancel);
  }
});

test('offline and ambiguous audio uploads keep the selected file without retrying', async () => {
  for (const ambiguous of [false, true]) {
    const f = fixture('notices', { upload() {
      if (ambiguous) throw apiError('上传结果未确认。', 0, { ambiguous: true });
      return { id: 'offline-voice', status: 'offline' };
    } });
    await f.ready(); f.page.onModeChange({ detail: { value: '1' } }); await f.page.chooseWav(); await f.page.sendNotice();
    assert.equal(f.page.data.audioFile.path, '/mock/voice.wav'); assert.equal(f.page.data.uncertain, ambiguous);
    assert.equal(f.uploads.length, 1);
    if (ambiguous) { await f.page.sendNotice(); assert.equal(f.uploads.length, 1); }
  }
});

test('class switch drops late presence and recent-history results from the previous class', async () => {
  const presence = deferred(), recent = deferred();
  const f = fixture('notices', { request(url) {
    if (url.includes('/class-a/status')) return presence.promise;
    if (url.startsWith('/api/history?') && url.includes('classId=class-a')) return recent.promise;
    return url.endsWith('/status') ? { online: false } : { history: [historyRow('b', { class_id: 'class-b', class_name: '高二（2）班' })] };
  } });
  const initial = f.page.onShow(); await tick();
  const changed = f.page.onClassChange({ detail: { value: '1' } });
  assert.equal(f.page.data.recent.length, 0); assert.equal(f.page.data.presence, ''); await changed;
  presence.resolve({ online: true }); recent.resolve({ history: [historyRow('old')] }); await initial;
  assert.equal(f.page.data.recent[0].id, 'b'); assert.match(f.page.data.presence, /教室离线/);
});

test('leaving during preflight or send confirmation cannot dispatch a notice', async () => {
  for (const phase of ['preflight', 'confirmation']) {
    const pending = deferred();
    const f = fixture('notices', {
      confirm: () => phase === 'confirmation' ? pending.promise : true,
      request(url) {
        if (url === '/api/quiet-hours') return phase === 'preflight' ? pending.promise : { activePeriod: null };
        return url.endsWith('/status') ? { online: true } : { history: [] };
      }
    });
    await f.ready(); f.page.onTextInput({ detail: { value: '不可后台发送' } });
    const sending = f.page.sendNotice(); await tick(); f.page.onHide();
    pending.resolve(phase === 'preflight' ? { activePeriod: null } : true); await sending;
    assert.equal(f.writes().length, 0); assert.equal(f.page.data.text, '不可后台发送'); assert.equal(f.page.data.busy, false);
  }
});

test('hidden pages ignore late class reads and both pages always stop pull-down refresh', async () => {
  for (const name of ['notices', 'history']) {
    const pending = deferred(); const f = fixture(name, { loadClasses: () => pending.promise });
    const initial = f.page.onShow(); await tick(); f.page.onHide(); pending.resolve(classes); await initial;
    assert.equal(f.page.data.classes.length, 0); assert.equal(f.calls.length, 0);
    f.setUser(null); await f.page.onPullDownRefresh(); assert.equal(f.stopped, 1);
  }
});

test('history supports all visible classes, actual hasMore/offset and duplicate-safe pagination', async () => {
  let reads = 0;
  const f = fixture('history', { request(url) {
    assert.ok(!url.includes('classId=')); reads += 1;
    return reads === 1 ? { history: [historyRow('one'), historyRow('two')], hasMore: true, offset: 0 } :
      { history: [historyRow('two'), historyRow('three')], hasMore: false, offset: 2 };
  } });
  await f.ready(); await f.page.loadMore();
  assert.match(f.calls[0].url, /limit=20.*offset=0/); assert.match(f.calls[1].url, /offset=2/);
  assert.deepEqual(plain(f.page.data.items.map(item => item.id)), ['one', 'two', 'three']);
  assert.equal(f.page.data.offset, 4); assert.equal(f.page.data.hasMore, false);
  await f.page.loadMore(); assert.equal(reads, 2);
});

test('history opens the composing class, clears old rows immediately and rejects old-page append results', async () => {
  const pending = deferred();
  const f = fixture('history', { route: { classId: 'class-a' }, request(url) {
    if (url.includes('classId=class-b')) return { history: [historyRow('b', { class_id: 'class-b' })], hasMore: false };
    if (url.includes('offset=1')) return pending.promise;
    return { history: [historyRow('a')], hasMore: true };
  } });
  await f.ready(); assert.equal(f.page.data.filterIndex, 1);
  const more = f.page.loadMore(); const changed = f.page.onClassChange({ detail: { value: '2' } });
  assert.equal(f.page.data.items.length, 0); await changed;
  pending.resolve({ history: [historyRow('old-more')], hasMore: true }); await more;
  assert.equal(f.page.data.items.length, 1); assert.equal(f.page.data.items[0].id, 'b'); assert.equal(f.page.data.offset, 1);
});

test('history preserves loaded rows on paging errors, reports 403 verbatim, and retries the same offset', async () => {
  let paging = 0;
  const f = fixture('history', { request(url) {
    if (url.includes('offset=1')) {
      paging += 1; if (paging === 1) throw apiError('没有更多记录的查看权限。', 403);
      return { history: [historyRow('two')], hasMore: false };
    }
    return { history: [historyRow('one')], hasMore: true };
  } });
  await f.ready(); await f.page.loadMore();
  assert.equal(f.page.data.error, '没有更多记录的查看权限。'); assert.equal(f.page.data.items[0].id, 'one'); assert.equal(f.page.data.offset, 1);
  await f.page.loadMore(); assert.equal(f.page.data.items.length, 2); assert.equal(f.page.data.error, '');
});

test('history does not infer extra pages from a full response and handles no assigned classes', async () => {
  const f = fixture('history', { loadClasses: () => [], request: () => ({ history: [], hasMore: false, offset: 0 }) });
  await f.ready(); assert.equal(f.page.data.filterIndex, 0); assert.equal(f.page.data.items.length, 0);
  assert.equal(f.page.data.error, ''); await f.page.loadMore(); assert.equal(f.calls.length, 1);
  const notices = fixture('notices', { loadClasses: () => [] }); await notices.ready();
  assert.equal(notices.calls.length, 0); assert.equal(notices.page.data.loading, false);
});

test('page lifecycle requires login and keeps all tests isolated from live endpoints', async () => {
  for (const name of ['notices', 'history']) {
    const f = fixture(name); f.setUser(null); await f.page.onShow(); assert.equal(f.logins, 1); assert.equal(f.calls.length, 0);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'pages', name, 'index.json'), 'utf8'));
    assert.equal(config.enablePullDownRefresh, true);
    const wxml = fs.readFileSync(path.join(root, 'pages', name, 'index.wxml'), 'utf8');
    assert.doesNotMatch(wxml, /web-view|<webview/i); assert.match(wxml, /bindtap="relogin"/);
    const controls = wxml.match(/<(?:input|textarea|picker|checkbox-group)\b[^>]*>/g) || [];
    controls.forEach(control => assert.match(control, /aria-label="[^"]+"/));
  }
});

test('preflight failure keeps drafts and cannot mark an unsent notice as an ambiguous write', async () => {
  const f = fixture('notices', { request(url) {
    if (url === '/api/quiet-hours') throw apiError('无法读取禁言时间。', 0, { ambiguous: true });
    return url.endsWith('/status') ? { online: true } : { history: [] };
  } });
  await f.ready(); f.page.onTextInput({ detail: { value: '尚未发送' } }); await f.page.sendNotice();
  assert.equal(f.writes().length, 0); assert.equal(f.page.data.uncertain, false); assert.equal(f.page.data.text, '尚未发送');
  assert.equal(f.page.data.error, '无法读取禁言时间。');
});

test('late preflight errors after hiding are discarded along with late successful reads', async () => {
  const pending = deferred();
  const f = fixture('notices', { request(url) {
    if (url === '/api/quiet-hours') return pending.promise;
    return url.endsWith('/status') ? { online: true } : { history: [] };
  } });
  await f.ready(); f.page.onTextInput({ detail: { value: '保留正文' } });
  const send = f.page.sendNotice(); f.page.onHide(); pending.reject(apiError('旧读取错误', 403)); await send;
  assert.equal(f.page.data.error, ''); assert.equal(f.writes().length, 0); assert.equal(f.page.data.text, '保留正文');
});

test('cancelled send preparation does not invalidate concurrent class status/history reads', async () => {
  const pendingPresence = deferred(), pendingHistory = deferred();
  const f = fixture('notices', { confirm: () => false, request(url) {
    if (url === '/api/quiet-hours') return { activePeriod: null };
    if (url.endsWith('/status')) return pendingPresence.promise;
    return pendingHistory.promise;
  } });
  const initial = f.page.onShow(); await tick();
  f.page.onTextInput({ detail: { value: '取消不影响读取' } }); await f.page.sendNotice();
  pendingPresence.resolve({ online: true }); pendingHistory.resolve({ history: [historyRow('concurrent')] }); await initial;
  assert.equal(f.page.data.presence, '教室在线'); assert.equal(f.page.data.recent[0].id, 'concurrent'); assert.equal(f.writes().length, 0);
});

test('history suppresses duplicate paging clicks and discards results/errors after unload', async () => {
  for (const fail of [false, true]) {
    const pending = deferred();
    const f = fixture('history', { request(url) {
      return url.includes('offset=1') ? pending.promise : { history: [historyRow('initial')], hasMore: true };
    } });
    await f.ready(); const more = f.page.loadMore(); await f.page.loadMore();
    assert.equal(f.calls.length, 2); f.page.onUnload();
    if (fail) pending.reject(apiError('已离开页面的错误', 403));
    else pending.resolve({ history: [historyRow('late')], hasMore: false });
    await more;
    assert.equal(f.page.data.error, ''); assert.equal(f.page.data.items.length, 1); assert.equal(f.page.data.items[0].id, 'initial');
  }
});

test('a repeated quiet 409 is shown without a third write or a new implicit confirmation', async () => {
  const f = fixture('notices', { request(url) {
    if (url === '/api/quiet-hours') return { activePeriod: null };
    if (url === '/api/shouts') throw apiError('仍需确认禁言时间。', 409, { code: 'quiet_confirmation_required', data: { quietPeriod } });
    return url.endsWith('/status') ? { online: true } : { history: [] };
  } });
  await f.ready(); f.page.onTextInput({ detail: { value: '不循环重试' } }); await f.page.sendNotice();
  assert.equal(f.writes().length, 2); assert.equal(f.confirmations.length, 2); assert.equal(f.page.data.error, '仍需确认禁言时间。');
});

test('old-session responses cannot become visible errors or overwrite drafts', async () => {
  const f = fixture('notices', { request(url) {
    if (url.endsWith('/status')) throw apiError('旧账号响应', 0, { code: 'session_changed' });
    if (url === '/api/quiet-hours') throw apiError('旧账号响应', 0, { code: 'session_changed' });
    return { history: [] };
  } });
  await f.ready(); assert.equal(f.page.data.presence, ''); assert.equal(f.page.data.error, '');
  f.page.onTextInput({ detail: { value: '旧响应不清草稿' } }); await f.page.sendNotice();
  assert.equal(f.page.data.error, ''); assert.equal(f.page.data.text, '旧响应不清草稿');
});

test('audio quiet 409 requires explicit consent and multipart sends the backend-accepted string true', async () => {
  let uploads = 0;
  const f = fixture('notices', { upload() {
    uploads += 1;
    if (uploads === 1) throw apiError('原声在禁言时间内播放，请确认。', 409, { code: 'quiet_confirmation_required', data: { quietPeriod } });
    return { id: 'voice-quiet', status: 'sent' };
  } });
  await f.ready(); f.page.onModeChange({ detail: { value: '1' } }); await f.page.chooseWav(); await f.page.sendNotice();
  assert.equal(f.confirmations.length, 2); assert.equal(f.confirmations[1].confirmText, '仍然发送');
  assert.deepEqual(f.uploads.map(item => item.formData.quietAcknowledged), ['false', 'true']);
  assert.ok(f.uploads.every(item => item.url === '/api/shouts' && item.filePath === '/mock/voice.wav'));
  assert.match(f.page.data.lastResult.label, /尚未确认送达/);
});

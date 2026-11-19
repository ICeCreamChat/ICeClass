'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../miniprogram/teacher/lib/api.js');

function fixture() {
  const storage = new Map();
  const calls = [];
  const runtime = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    request: options => calls.push(options)
  };
  return { api: createClient(runtime), calls, storage, runtime };
}
function user(id = 'teacher-1') {
  return { id, username: id, displayName: '测试教师', role: 'teacher', csrfToken: 'csrf-1', permissions: {} };
}
async function signedIn(f, id) {
  const promise = f.api.login('teacher', 'never-store-this');
  f.calls.at(-1).success({ statusCode: 200, cookies: ['iceclass_session=session-token; Path=/; Max-Age=3600; Secure; HttpOnly'], data: { user: user(id) } });
  await promise;
}

test('login retains only the school session cookie, never the password', async () => {
  const f = fixture();
  await signedIn(f);
  const request = f.api.request('/api/classes');
  assert.equal(f.calls.at(-1).url, 'https://iceclass.icecreamchat.top/api/classes');
  assert.equal(f.calls.at(-1).header.Cookie, 'iceclass_session=session-token');
  assert.ok(!JSON.stringify([...f.storage]).includes('never-store-this'));
  f.calls.at(-1).success({ statusCode: 200, data: { classes: [] } });
  assert.deepEqual(await request, { classes: [] });
});

test('writes include CSRF and reads do not need a CSRF header', async () => {
  const f = fixture(); await signedIn(f);
  const promise = f.api.request('/api/shouts', { method: 'POST', data: { text: '测试' } });
  assert.equal(f.calls.at(-1).header['X-CSRF-Token'], 'csrf-1');
  f.calls.at(-1).success({ statusCode: 202, data: { status: 'offline' } });
  assert.equal((await promise).status, 'offline');
});

test('cross-origin URLs and path traversal are rejected before a request', async () => {
  const f = fixture();
  for (const path of ['https://example.com/api/classes', '//example.com/api/classes', '/api/../auth', '/api/classes\r\nCookie: bad']) {
    await assert.rejects(f.api.request(path, { auth: false }));
  }
  assert.equal(f.calls.length, 0);
});

test('a successful JSON login without the actual session cookie is rejected', async () => {
  const f = fixture();
  const promise = f.api.login('teacher', 'pass');
  f.calls[0].success({ statusCode: 200, data: { user: user() } });
  await assert.rejects(promise, /会话/);
  assert.equal(f.api.getUser(), null);
});

test('Set-Cookie header fallback reads only the named cookie', async () => {
  const f = fixture(); const promise = f.api.login('teacher', 'pass');
  f.calls[0].success({ statusCode: 200, header: { 'Set-Cookie': 'iceclass_session=header-token; Path=/; Secure; Max-Age=60' }, data: { user: user() } });
  await promise;
  const next = f.api.request('/api/classes');
  assert.equal(f.calls.at(-1).header.Cookie, 'iceclass_session=header-token');
  f.calls.at(-1).success({ statusCode: 200, data: {} }); await next;
});

test('401 clears authentication and 403 leaves the current session intact', async () => {
  const f = fixture(); await signedIn(f);
  let promise = f.api.request('/api/classes');
  f.calls.at(-1).success({ statusCode: 403, data: { error: '没有此班级权限。' } });
  await assert.rejects(promise, { status: 403, message: '没有此班级权限。' });
  assert.ok(f.api.getUser());
  promise = f.api.request('/api/classes');
  f.calls.at(-1).success({ statusCode: 401, data: { error: '登录已过期。' } });
  await assert.rejects(promise, { status: 401 });
  assert.equal(f.api.getUser(), null);
});

test('write timeout is ambiguous and never triggers an automatic retry', async () => {
  const f = fixture(); await signedIn(f);
  const count = f.calls.length;
  const promise = f.api.request('/api/shouts', { method: 'POST', data: { text: '测试' } });
  f.calls.at(-1).fail({ errMsg: 'request:fail timeout' });
  await assert.rejects(promise, error => error.ambiguous === true && /核对/.test(error.message));
  assert.equal(f.calls.length, count + 1);
});

test('truncated successful writes and gateway failures require reconciliation without a retry', async () => {
  const f = fixture(); await signedIn(f);
  for (const response of [
    { statusCode: 200, data: '{"id":' },
    { statusCode: 200, data: 'null' },
    { statusCode: 200, data: [] },
    { statusCode: 502, data: '<html>Bad Gateway</html>' },
    { statusCode: 503, data: { error: 'upstream unavailable' } }
  ]) {
    const count = f.calls.length;
    const promise = f.api.request('/api/card-quiz/questions', { method: 'POST', data: {} });
    f.calls.at(-1).success(response);
    await assert.rejects(promise, error => error.ambiguous === true && error.status === response.statusCode && /核对/.test(error.message));
    assert.equal(f.calls.length, count + 1);
  }
  let transfer;
  f.runtime.uploadFile = value => { transfer = value; };
  const uploaded = f.api.upload('/api/shouts', 'local.wav', {});
  transfer.success({ statusCode: 200, data: '{"status":' });
  await assert.rejects(uploaded, error => error.ambiguous === true);
});

test('a non-JSON 401 still clears authentication and exposes re-login', async () => {
  const f = fixture(); await signedIn(f);
  const promise = f.api.request('/api/classes');
  f.calls.at(-1).success({ statusCode: 401, data: '<html>Sign in</html>' });
  await assert.rejects(promise, error => error.status === 401 && error.ambiguous === false);
  assert.equal(f.api.getUser(), null);
});

test('quiet-hours conflict preserves code and payload for explicit confirmation', async () => {
  const f = fixture(); await signedIn(f);
  const promise = f.api.request('/api/shouts', { method: 'POST', data: { text: '测试' } });
  f.calls.at(-1).success({ statusCode: 409, data: { error: '当前为禁言时段', code: 'quiet_confirmation_required', period: { name: '上课' } } });
  await assert.rejects(promise, error => error.code === 'quiet_confirmation_required' && error.data.period.name === '上课');
});

test('a stale response cannot clear a newer account session', async () => {
  const f = fixture(); await signedIn(f, 'old');
  const old = f.api.request('/api/classes'); const oldCall = f.calls.at(-1);
  const rejection = assert.rejects(old);
  await signedIn(f, 'new');
  oldCall.success({ statusCode: 401, data: {} });
  await rejection;
  assert.equal(f.api.getUser().id, 'new');
});

test('a stale successful read is rejected after account switching', async () => {
  const f = fixture(); await signedIn(f, 'old');
  const old = f.api.request('/api/classes'); const oldCall = f.calls.at(-1);
  const rejection = assert.rejects(old, error => error.code === 'session_changed');
  await signedIn(f, 'new');
  oldCall.success({ statusCode: 200, data: { classes: [{ id: 'old-class' }] } });
  await rejection;
});

test('logout calls the server with authentication before clearing local state', async () => {
  const f = fixture(); await signedIn(f); f.api.selectClass('class-1');
  const promise = f.api.logout();
  assert.equal(f.calls.at(-1).url.endsWith('/api/auth/logout'), true);
  assert.equal(f.calls.at(-1).method, 'POST');
  assert.equal(f.calls.at(-1).header['X-CSRF-Token'], 'csrf-1');
  f.calls.at(-1).success({ statusCode: 200, data: { ok: true } }); await promise;
  assert.equal(f.api.getUser(), null); assert.equal(f.api.getClassId(), '');
});

test('session restore rejects authenticated:false and clears stored state', async () => {
  const f = fixture(); await signedIn(f);
  const restored = createClient(f.runtime);
  const promise = restored.restoreSession();
  f.calls.at(-1).success({ statusCode: 200, data: { authenticated: false } });
  assert.equal(await promise, null); assert.equal(restored.getUser(), null);
});

test('expired saved cookies are not sent', async () => {
  const f = fixture(); await signedIn(f);
  for (const [key, value] of f.storage) if (value && value.cookie) f.storage.set(key, { ...value, expiresAt: 1 });
  const restored = createClient(f.runtime);
  assert.equal(restored.getUser(), null);
  assert.equal(await restored.restoreSession(), null);
});

test('late upload and download failures cannot affect a newly signed-in account', async () => {
  const f = fixture(); await signedIn(f, 'old');
  const transfers = [];
  f.runtime.uploadFile = value => transfers.push(value);
  f.runtime.downloadFile = value => transfers.push(value);
  const upload = f.api.upload('/api/shouts', 'local.wav', { classId: 'old-class' });
  const download = f.api.download('/api/classroom-voice/voice-1/audio');
  const assertions = [upload, download].map(promise => assert.rejects(promise, error => error.code === 'session_changed'));
  await signedIn(f, 'new');
  transfers.forEach(transfer => transfer.fail());
  await Promise.all(assertions);
  assert.equal(f.api.getUser().id, 'new');
});

test('login and logout continuations cannot overwrite a newer login attempt', async () => {
  const f = fixture();
  const first = f.api.login('old', 'not-stored');
  const firstRejected = assert.rejects(first, error => error.code === 'session_changed');
  f.calls.at(-1).success({ statusCode: 200, cookies: ['iceclass_session=old-token; Max-Age=3600'], data: { user: user('old') } });
  await signedIn(f, 'new');
  await firstRejected;
  assert.equal(f.api.getUser().id, 'new');

  const logout = f.api.logout();
  const logoutRejected = assert.rejects(logout, error => error.code === 'session_changed');
  f.calls.at(-1).success({ statusCode: 200, data: {} });
  await signedIn(f, 'newer');
  await logoutRejected;
  assert.equal(f.api.getUser().id, 'newer');
});

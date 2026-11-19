'use strict';
// Exercises the actual API against the explicitly started localhost demonstration only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, BASE_URL } = require('../miniprogram/teacher/lib/api');
const homework = require('../miniprogram/teacher/lib/homework-data');
const paper = require('../miniprogram/teacher/lib/paper-data');
const paperAccounts = require('../miniprogram/teacher/lib/paper-accounts-data');
const study = require('../miniprogram/teacher/lib/study-settings');
const reading = require('../miniprogram/teacher/lib/reading-settings');
const settings = require('../miniprogram/teacher/lib/settings-data');
const previewPort = Number(process.env.ICECLASS_WECHAT_TEST_PORT || 8843);
assert.ok(Number.isInteger(previewPort) && previewPort >= 1024 && previewPort <= 65535, 'Invalid local preview port.');
const ORIGIN = `http://127.0.0.1:${previewPort}`;
test.before(async () => {
  const response = await fetch(ORIGIN + '/api/session', { redirect: 'error' });
  assert.equal(response.headers.get('x-iceclass-preview'), '1', 'Start the isolated demonstration server before any test writes.');
  assert.equal(response.status, 200);
});
function client() {
  const storage = new Map();
  return createClient({
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    request(options) {
      assert.ok(options.url.startsWith(BASE_URL + '/api/'));
      const target = new URL(options.url);
      fetch(ORIGIN + target.pathname + target.search, { method: options.method, headers: options.header, body: options.data === undefined ? undefined : JSON.stringify(options.data), redirect: 'error' })
        .then(async response => {
          assert.equal(response.headers.get('x-iceclass-preview'), '1', 'Only the isolated demonstration server is allowed.');
          options.success({ statusCode: response.status, data: options.dataType === 'text' ? await response.text() : await response.json(), header: { 'Set-Cookie': response.headers.get('set-cookie') || '' } });
        })
        .catch(error => options.fail({ errMsg: error.message }));
    }
  });
}

test('mobile Banban receives a complete platform turn and restores it from school history', async () => {
  const api = client();
  await api.login('teacher1', 'LocalTeacher2026');
  const prior = await api.request('/api/banban/conversation');
  const events = [];
  await api.request('/api/banban/chat/stream', {
    method: 'POST', data: { message: '你是谁？', scope: {}, ...(prior.id ? { conversationId: prior.id } : {}) },
    onEvent: event => events.push(event)
  });
  const complete = events.at(-1);
  assert.equal(complete.type, 'done');
  assert.equal(typeof complete.message.content, 'string');
  assert.ok(complete.message.content.length > 0);
  const saved = await api.request('/api/banban/conversation?conversationId=' + complete.conversationId);
  assert.deepEqual(saved.messages.slice(-2).map(message => message.role), ['user', 'assistant']);
  assert.equal(saved.messages.at(-2).content, '你是谁？');
  await api.logout();
});

test('native login, role scope, teaching reports and offline notice use the real isolated school handlers', async () => {
  const api = client();
  const user = await api.login('teacher1', 'LocalTeacher2026');
  assert.equal(user.id, 'preview-teacher');
  assert.equal((await api.restoreSession()).id, user.id);
  const classes = (await api.request('/api/classes')).classes;
  assert.ok(classes.length > 0);
  const cid = classes.find(item => item.canEditIsland).id;
  const responses = await Promise.all([
    api.request('/api/quiet-hours'),
    api.request('/api/island/classes/' + cid),
    api.request('/api/homework/classes/' + cid + '/profile'),
    api.request('/api/reading/report?classId=' + cid),
    api.request('/api/card-quiz/report?classId=' + cid),
    api.request('/api/card-quiz/questions'),
    api.request('/api/card-quiz/decks'),
    api.request('/api/history?classId=' + cid + '&limit=5&offset=0')
  ]);
  assert.ok(Array.isArray(responses[0].periods));
  assert.ok(responses[1].config);
  assert.ok(Array.isArray(responses[5].questions));
  assert.ok(Array.isArray(responses[6].decks));
  let result;
  try { result = await api.request('/api/shouts', { method: 'POST', data: { classId: cid, text: '隔离演示库内的微信接口验证', alertLevel: 'info', displayDurationSec: 10 } }); }
  catch (error) {
    assert.equal(error.code, 'quiet_confirmation_required');
    result = await api.request('/api/shouts', { method: 'POST', data: { classId: cid, text: '隔离演示库内的微信接口验证', alertLevel: 'info', displayDurationSec: 10, quietAcknowledged: true } });
  }
  assert.equal(result.status, 'offline');
  await api.logout(); assert.equal(api.getUser(), null);
});

test('native question and deck operations preserve actual revision conflicts', async () => {
  const api = client(); await api.login('teacher1', 'LocalTeacher2026');
  const cid = (await api.request('/api/classes')).classes.find(item => item.canEditIsland).id;
  const value = { subjectId: 'math', type: 'multiple', text: '微信接口验证：选择奇数', imageId: null, options: ['1', '2', '3', '4'], answer: 'AC', tags: ['原生接口验证'] };
  const q = await api.request('/api/card-quiz/questions', { method: 'POST', data: { value } });
  assert.equal(q.answer, 'AC');
  const updated = await api.request('/api/card-quiz/questions/' + q.id, { method: 'PUT', data: { revision: q.revision, value: { ...value, text: value.text + '（修订）' } } });
  await assert.rejects(api.request('/api/card-quiz/questions/' + q.id, { method: 'PUT', data: { revision: q.revision, value } }), { status: 409 });
  const deck = await api.request('/api/card-quiz/decks', { method: 'POST', data: { title: '微信原生接口验证题单', questionIds: [q.id] } });
  const publication = await api.request('/api/card-quiz/decks/' + deck.id + '/publish', { method: 'POST', data: { revision: deck.revision, classId: cid } });
  assert.equal(publication.questions[0].answer, 'AC');
  await api.request('/api/card-quiz/publications/' + publication.id, { method: 'DELETE' });
  await api.request('/api/card-quiz/questions/' + q.id, { method: 'DELETE', data: { revision: updated.revision } });
  await api.logout();
});

test('native management pages can read their real school responses without widening teacher permissions', async () => {
  const api = client();
  await api.login('teacher1', 'LocalTeacher2026');
  try {
    const { classes } = await api.request('/api/self-study/classes');
    const cid = classes[0].id;
    const [homeworkProfile, cards, studentAccounts, studyProfile, connection] = await Promise.all([
      api.request('/api/homework/classes/' + cid + '/profile'),
      api.request('/api/card-quiz/classes/' + cid + '/cards'),
      api.request('/api/card-quiz/classes/' + cid + '/students'),
      api.request('/api/self-study/classes/' + cid),
      api.request('/api/banban/connection')
    ]);
    assert.equal(homework.readProfile(homeworkProfile, cid).canEdit, true);
    assert.equal(paper.readCards(cards, cid).canEdit, true);
    assert.equal(paperAccounts.readAccounts(studentAccounts, cid).canEdit, true);
    assert.equal(study.profileFrom(studyProfile, cid).classId, cid);
    assert.equal(settings.accountConnection(connection).canManageSchool, false);
    await assert.rejects(api.request('/api/reading/settings'), { status: 403 });
    await assert.rejects(api.request('/api/devices'), { status: 403 });
  } finally { await api.logout(); }

  await api.login('ICe', 'LocalDemo2026');
  try {
    const [readingProfile, devices, quota] = await Promise.all([
      api.request('/api/reading/settings'), api.request('/api/devices'), api.request('/api/banban/quotas')
    ]);
    assert.equal(typeof reading.profileFrom(readingProfile).config.enabled, 'boolean');
    assert.ok(settings.devicesFrom(devices).length > 0);
    assert.ok(settings.quotasFrom(quota).targets.length > 0);
  } finally { await api.logout(); }
});

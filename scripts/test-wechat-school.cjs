'use strict';
// Exercises the actual API against the explicitly started localhost demonstration only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createClient, BASE_URL } = require('../miniprogram/teacher/lib/api');
const homework = require('../miniprogram/teacher/lib/homework-data');
const paper = require('../miniprogram/teacher/lib/paper-data');
const paperAccounts = require('../miniprogram/teacher/lib/paper-accounts-data');
const reading = require('../miniprogram/teacher/lib/reading-settings');
const settings = require('../miniprogram/teacher/lib/settings-data');
const manage = require('../miniprogram/teacher/lib/manage-data');
const { buildNotice } = require('../miniprogram/teacher/lib/notice-data');
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
          options.success({ statusCode: response.status, data: await response.json(), header: { 'Set-Cookie': response.headers.get('set-cookie') || '' } });
        })
        .catch(error => options.fail({ errMsg: error.message }));
    }
  });
}

test('native login, role scope, teaching reports and offline notice use the real isolated school handlers', async () => {
  const api = client();
  const user = await api.login('teacher1', 'LocalTeacher2026');
  assert.equal(user.id, 'preview-teacher');
  assert.equal((await api.restoreSession()).id, user.id);
  const classes = (await api.request('/api/classes')).classes;
  assert.ok(classes.length > 0);
  const selectedClass = classes.find(item => item.canEditIsland);
  const cid = selectedClass.id;
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
  const text = '隔离演示库内的微信接口验证';
  const notice = buildNotice({ classId: cid, modeIndex: 0, levelIndex: 2, durationIndex: 1, text }, selectedClass);
  const result = await api.request('/api/shouts', { method: 'POST', data: { ...notice.values, quietAcknowledged: Boolean(responses[0].activePeriod) } });
  assert.equal(result.status, 'offline');
  const { history } = await api.request('/api/history?classId=' + cid + '&limit=5&offset=0');
  const sent = history.find(item => item.id === result.id);
  assert.equal(sent.content_type, 'text');
  assert.equal(sent.alert_level, 'info');
  assert.equal(sent.text, text);
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
    const { classes } = await api.request('/api/classes');
    const ownClass = classes.find(item => item.canEditIsland);
    const cid = ownClass.id;
    const [homeworkProfile, cards, studentAccounts] = await Promise.all([
      api.request('/api/homework/classes/' + cid + '/profile'),
      api.request('/api/card-quiz/classes/' + cid + '/cards'),
      api.request('/api/card-quiz/classes/' + cid + '/students')
    ]);
    assert.equal(homework.readProfile(homeworkProfile, cid).canEdit, true);
    assert.equal(paper.readCards(cards, cid).canEdit, true);
    assert.equal(paperAccounts.readAccounts(studentAccounts, cid).canEdit, true);
    await assert.rejects(api.request('/api/reading/settings'), { status: 403 });
    await assert.rejects(api.request('/api/devices'), { status: 403 });
    await assert.rejects(manage.updateClass(api.request, ownClass, { enabled: false }, () => true), { status: 403 });
  } finally { await api.logout(); }

  await api.login('ICe', 'LocalDemo2026');
  try {
    const [readingProfile, devices] = await Promise.all([api.request('/api/reading/settings'), api.request('/api/devices')]);
    assert.equal(typeof reading.profileFrom(readingProfile).config.enabled, 'boolean');
    assert.ok(settings.devicesFrom(devices).length > 0);
  } finally { await api.logout(); }
});

test('class and device edits still confirm the existing fixed school operations', async () => {
  const api = client();
  await api.login('ICe', 'LocalDemo2026');
  try {
    const devices = settings.devicesFrom(await api.request('/api/devices'));
    const device = devices[0];
    const className = device.class_name;
    const note = '微信小程序设备回归';
    await settings.updateDevice(api.request, device, { note }, className, () => true);
    assert.equal(settings.devicesFrom(await api.request('/api/devices')).find(row => row.id === device.id).binding_note, note);
    const name = '微信回归测试班 ' + randomUUID().slice(0, 8);
    await manage.updateClass(api.request, { id: device.class_id, name: className }, { name }, () => true);
    assert.equal(settings.classesFrom(await api.request('/api/classes')).find(row => row.id === device.class_id).name, name);
  } finally { await api.logout(); }
});

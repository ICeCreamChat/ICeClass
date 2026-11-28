'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {after, before, test} = require('node:test');
const {fixture, navigate, launchWorkbenchBrowser} = require('./test-teacher-ui.cjs');

const root = path.resolve(__dirname, '../web_controller');
const audio = fs.readFileSync(path.resolve(__dirname, '../Receiver/Assets/Sounds/notification-important.wav'));
const photo = fs.readFileSync(path.resolve(__dirname, '../branding/banban/thinking.jpg'));
const executablePath = process.env.ICECLASS_WHITEBOARD_CHROMIUM;
let browser;
before(async () => { browser = await launchWorkbenchBrowser(); });
after(async () => { await browser?.close(); });

function json(res, data, status = 200) {
  res.writeHead(status, {'Content-Type':'application/json'});
  return res.end(JSON.stringify(data));
}
function holdBody(res, type) {
  res.writeHead(200, {'Content-Type':type});
  res.flushHeaders();
  return res;
}
async function openPage(t, handle, entry = '/') {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (handle(url, res, req)) return;
    const data = fixture(url);
    json(res, data || {}, data ? 200 : 503);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const context = await browser.newContext({viewport:{width:390, height:850}, reducedMotion:'reduce'});
  const page = await context.newPage(), errors = [];
  t.after(async () => {
    await context.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(executablePath ? 30000 : 5000);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin);
    if (url.pathname.startsWith('/api/')) return route.continue();
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    assert.ok(file.startsWith(root + path.sep));
    return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
  });
  if (!executablePath) {
    await page.clock.install();
    await page.addInitScript(() => {
      Object.defineProperty(AbortSignal, 'any', {value:undefined});
      Object.defineProperty(AbortSignal, 'timeout', {value:undefined});
      Object.defineProperty(Object, 'hasOwn', {value:undefined});
    });
  }
  await page.goto(origin + entry);
  if (entry === '/') await page.locator('#readingRanking[aria-busy="false"]').waitFor();
  assert.equal(await page.evaluate(() => !AbortSignal.any && !AbortSignal.timeout), true);
  return page;
}

async function advanceTime(page, milliseconds) {
  // Playwright's clock supplies AbortSignal.timeout. Exercise the native engine with its real timers.
  if (executablePath) await new Promise(resolve => setTimeout(resolve, milliseconds));
  else await page.clock.fastForward(milliseconds);
}

test('student login shows only known notices and clears the parameter without Object.hasOwn', async t => {
  const page = await openPage(t, (url, res, req) => {
    if (url.pathname === '/api/student/login' && req.method === 'POST')
      return json(res, {code:'invalid_credentials', error:'编号或密码不正确。'}, 401);
  }, '/?login=student');
  assert.equal(await page.evaluate(() => typeof Object.hasOwn), 'undefined');
  const notice = page.locator('#loginNotice');
  assert.equal(await page.getByLabel('学生编号').isVisible(), true);
  assert.equal(await page.locator('#loginRoleStudent').isChecked(), true);
  assert.equal(await notice.isVisible(), false);
  const url = new URL(page.url());
  url.searchParams.set('keep', '1');
  for (const [reason, message] of [
    ['expired', '学生登录已失效，请重新登录。'],
    ['signed-out', '已退出学生账号。'],
    ['password-changed', '密码已修改，请用新密码重新登录。'],
    ['unknown', ''], ['constructor', '']
  ]) {
    url.searchParams.set('notice', reason);
    await page.goto(url.href);
    assert.equal(await notice.isVisible(), Boolean(message));
    if (message) {
      assert.equal(await notice.textContent(), message);
      assert.equal(await notice.evaluate(node => node === document.activeElement), true);
    }
    assert.equal(new URL(page.url()).search, '?login=student&keep=1');
  }
  await page.getByLabel('学生编号').fill('26110101');
  await page.locator('#loginPassword').fill('000000');
  await page.locator('#loginPassword').press('Enter');
  await page.locator('#loginError').filter({hasText:'编号或密码不正确。'}).waitFor();
  assert.equal(await page.locator('#loginPassword').getAttribute('aria-invalid'), 'true');
});

test('caller cancellation stays distinct from read timeout on an old whiteboard', {timeout:15000}, async t => {
  const page = await openPage(t, (url, res) => {
    if (url.pathname === '/api/held-read') return holdBody(res, 'application/json');
  });
  const name = await page.evaluate(async () => {
    const parent = new AbortController();
    parent.abort();
    try { await window.ICeClass.api('/api/held-read', {signal:parent.signal}); }
    catch (error) { return error.name; }
  });
  assert.equal(name, 'AbortError');
  const headers = page.waitForResponse(r => r.url().endsWith('/held-read'));
  await page.evaluate(() => {
    window.readParent = new AbortController();
    window.readResult = window.ICeClass.api('/api/held-read', {signal:window.readParent.signal})
      .catch(error => error.name);
  });
  await headers;
  const failed = page.waitForEvent('requestfailed', r => r.url().endsWith('/held-read'));
  await page.evaluate(() => window.readParent.abort());
  await failed;
  assert.equal(await page.evaluate(() => window.readResult), 'AbortError');
});

test('a HEAD deadline leaves a simultaneous write and its caller signal active', {timeout:30000}, async t => {
  let write, writes = 0;
  const page = await openPage(t, (url, res, req) => {
    if (url.pathname !== '/api/concurrent') return;
    if (req.method === 'PUT') {
      writes++;
      write = holdBody(res, 'application/json');
    }
    return res;
  });
  await Promise.all([
    page.waitForRequest(r => r.method() === 'HEAD' && r.url().endsWith('/concurrent')),
    page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/concurrent')),
    page.evaluate(() => {
      const signal = new AbortController().signal;
      window.headResult = window.ICeClass.api('/api/concurrent', {method:'HEAD', signal}).catch(error => error.name);
      window.saveResult = window.ICeClass.api('/api/concurrent', {method:'PUT', body:'{}', signal}).catch(error => error.name);
    })
  ]);
  await advanceTime(page, 15001);
  assert.equal(await page.evaluate(() => window.headResult), 'TimeoutError');
  write.end('{"saved":true}');
  assert.deepEqual(await page.evaluate(() => window.saveResult), {saved:true});
  assert.equal(writes, 1);
});

test('self-study distinguishes timeout, class failure and a successful empty list on retry', async t => {
  let lists = 0;
  const page = await openPage(t, (url, res) => {
    if (url.pathname === '/api/self-study/classes') {
      lists++;
      if (lists === 1) return holdBody(res, 'application/json');
      return json(res, {classes:lists === 2 ? [{id:'c1', name:'高一（1）班'}] : []});
    }
    if (url.pathname === '/api/self-study/classes/c1') return json(res, {error:'请稍后重试。'}, 503);
  });
  await navigate(page, 'self-study');
  const feedback = page.locator('#ss-feedback'), empty = page.getByText('当前没有可管理的班级。');
  assert.match(await feedback.innerText(), /正在载入/);
  assert.equal(await empty.isVisible(), false);
  const failed = page.waitForEvent('requestfailed', r => r.url().endsWith('/self-study/classes'));
  await advanceTime(page, 15001);
  await failed;
  await page.getByRole('alert').filter({hasText:'班级列表载入失败'}).waitFor();
  assert.match(await feedback.innerText(), /读取超时/);
  assert.equal(await empty.isVisible(), false);
  const retry = page.getByRole('button', {name:'重新载入', exact:true});
  await retry.press('Enter');
  await page.getByRole('alert').filter({hasText:'未能载入 高一（1）班 的设置'}).waitFor();
  assert.equal(await empty.isVisible(), false);
  await retry.press('Enter');
  await empty.waitFor();
  assert.equal(await feedback.isVisible(), false);
  assert.equal(lists, 3);
});

test('a photo closes mid-download, times out when left open, and loads on retry', async t => {
  const now = Date.now();
  let downloads = 0;
  const page = await openPage(t, (url, res) => {
    if (url.pathname === '/api/self-study/classes') return json(res, {classes:[{id:'c1', name:'高一（1）班'}]});
    if (url.pathname === '/api/self-study/classes/c1') return json(res, {
      config:{enabled:false, dailyCalls:4, dailyTokens:2400, sensitivity:'balanced', voiceTriggerMs:600,
        observationSeconds:10, reminderWaitSeconds:90, confirmationsAfterReminder:1},
      revision:1, usage:{calls:0, tokens:0}, schedule:[], serverTime:now
    });
    if (url.pathname === '/api/self-study/events') return json(res, {serverTime:now, pending:1,
      events:[{id:'e1', class_name:'高一（1）班', started_at:now, status:'reported', photo_status:'ready', photo_at:now}]});
    if (url.pathname.endsWith('/e1/photo')) {
      if (++downloads < 3) return holdBody(res, 'image/jpeg');
      res.writeHead(200, {'Content-Type':'image/jpeg'});
      return res.end(photo);
    }
  });
  await navigate(page, 'self-study');
  const show = page.getByRole('button', {name:'查看照片'});
  await show.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const isPhoto = request => request.url().endsWith('/e1/photo');
  for (const close of [true, false]) {
    const headers = page.waitForResponse(isPhoto);
    await show.press('Enter');
    await headers;
    const failed = page.waitForEvent('requestfailed', isPhoto);
    if (close) await page.keyboard.press('Escape');
    else await advanceTime(page, 15001);
    await failed;
    if (!close) {
      await page.getByRole('alert').filter({hasText:'照片载入超时，请关闭后重试。'}).waitFor();
      await page.keyboard.press('Escape');
    }
    assert.equal(await page.locator('#ss-photo img').count(), 0);
    assert.equal(await show.evaluate(node => node === document.activeElement), true);
  }
  await show.press('Enter');
  await page.locator('#ss-photo[open] img').waitFor();
  assert.ok(await page.locator('#ss-photo img').evaluate(image => image.naturalWidth));
  assert.equal(downloads, 3);
});

test('classroom voice times out while reading audio and plays a fresh download on retry', async t => {
  let downloads = 0;
  const page = await openPage(t, (url, res) => {
    if (url.pathname === '/api/classroom-voice') return json(res, {messages:[{
      id:'v1', class_name:'高一（1）班', audio_duration_ms:1000, created_at:Date.now(), audio_url:'/api/voice-file'
    }]});
    if (url.pathname === '/api/voice-file') {
      if (++downloads === 1) return holdBody(res, 'audio/wav');
      res.writeHead(200, {'Content-Type':'audio/wav'});
      return res.end(audio);
    }
  });
  await navigate(page, 'classroom-voice');
  const play = page.getByRole('button', {name:'播放语音', exact:true});
  const headers = page.waitForResponse(r => r.url().endsWith('/voice-file'));
  await play.press('Enter');
  await headers;
  await advanceTime(page, 15001);
  await page.getByText('语音载入超时，请重试。', {exact:true}).waitFor();
  await play.press('Enter');
  await page.getByRole('button', {name:'重新播放', exact:true}).waitFor();
  assert.ok(await page.locator('#classroomVoiceContainer audio').evaluate(node => node.src.startsWith('blob:')));
  assert.equal(downloads, 2);
});

test('print roster retries a timed-out read without resetting any passwords', async t => {
  let reads = 0;
  const writes = [];
  const page = await openPage(t, (url, res, req) => {
    if (req.method !== 'GET') writes.push(url.pathname);
    if (url.pathname.endsWith('/c1/students')) {
      if (++reads === 2) return holdBody(res, 'application/json');
      return json(res, {className:'测试班', canEdit:true, students:[
        {studentId:'s1', cardNumber:1, accountId:'a1', username:'test-card', activeHere:true}
      ]});
    }
  }, '/card-quiz/print.html?classId=c1');
  const list = page.locator('#metadata table'), reload = page.getByRole('button', {name:'重新载入名单'});
  await list.waitFor();
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/c1/students')), reload.press('Enter')]);
  await advanceTime(page, 15001);
  await page.getByRole('alert').filter({hasText:'读取超时，请检查连接后重新载入名单。'}).waitFor();
  await reload.press('Enter');
  await list.waitFor();
  assert.equal(await page.getByRole('button', {name:'重置密码并准备打印'}).isEnabled(), true);
  assert.equal(reads, 3);
  assert.deepEqual(writes, []);
});

test('standalone homework retains the selection on a timed-out save and makes only an explicit retry', async t => {
  const profile = fixture(new URL('http://127.0.0.1/api/homework/classes/c1/profile'));
  const homework = {...profile, records:[], date:'2026-11-28', serverDate:'2026-11-28'};
  let saves = 0;
  const page = await openPage(t, (url, res) => {
    if (url.pathname === '/api/homework/classroom') return json(res, homework);
    if (url.pathname.endsWith('/classroom/records')) {
      if (++saves === 1) return holdBody(res, 'application/json');
      return json(res, {record:{itemId:'book', status:'submitted', students:profile.value.students, missing:['s1'], revision:1}});
    }
  }, '/homework/classroom/index.html');
  await page.locator('[data-action="homework"]').click();
  const student = page.locator('#student-grid input[data-student="s1"]');
  await student.uncheck();
  const save = page.locator('[data-action="save-homework"]');
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/classroom/records')), save.press('Enter')]);
  await advanceTime(page, 15001);
  assert.equal(await save.isDisabled(), true);
  await advanceTime(page, 10000);
  await page.getByRole('alert').filter({hasText:'保存结果尚未确认'}).waitFor();
  assert.equal(await student.isChecked(), false);
  assert.equal(saves, 1);
  await save.press('Enter');
  await page.getByText('登记已保存，教师端可查看。').waitFor();
  assert.equal(saves, 2);
});

test('copying a published question retries its photo before creating the private question', async t => {
  const question = {subjectId:'math', type:'single', text:'配图题', options:['甲','乙'], answer:'A', tags:[], imageId:'original'};
  let copies = 0;
  const writes = [];
  const page = await openPage(t, (url, res, req) => {
    if (url.pathname.endsWith('/c1/publications')) return json(res, {publications:[{id:'deck', title:'测试题单', questions:[question]}]});
    if (url.pathname.endsWith('/images/original')) {
      if (req.headers['sec-fetch-dest'] === 'empty' && ++copies === 1) return holdBody(res, 'image/jpeg');
      res.writeHead(200, {'Content-Type':'image/jpeg'});
      return res.end(photo);
    }
    if (req.method === 'POST') {
      writes.push(url.pathname);
      return json(res, {id:url.pathname.endsWith('/images') ? 'copy' : 'question'});
    }
  });
  await navigate(page, 'card-quiz');
  await page.getByRole('button', {name:'题单发布', exact:true}).click();
  await page.getByText('测试题单 · 1 题', {exact:true}).click();
  await page.getByRole('button', {name:'另存为我的题目'}).click();
  const save = page.locator('[data-cq-action="save-question"]');
  const photoRead = r => r.request().resourceType() === 'fetch' && r.url().endsWith('/images/original');
  await Promise.all([page.waitForResponse(photoRead), save.press('Enter')]);
  await advanceTime(page, 15001);
  await page.getByRole('alert').filter({hasText:'读取超时'}).waitFor();
  assert.deepEqual(writes, []);
  const [created] = await Promise.all([
    page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/questions')), save.press('Enter')
  ]);
  await page.getByText('题目已保存到我的私有题库。').waitFor();
  assert.equal(created.postDataJSON().value.imageId, 'copy');
  assert.equal(copies, 2);
  assert.deepEqual(writes, ['/api/card-quiz/images','/api/card-quiz/questions']);
});

test('backup report shows ordinary report wording on failure and successful keyboard retry', async t => {
  let reads = 0;
  const page = await openPage(t, (url, res) => {
    if (url.pathname !== '/api/student/report-example') return;
    if (++reads === 1) return json(res, {}, 503);
    return json(res, {className:'测试班', username:'test-card', csrfToken:'fixture', lesson:{
      title:'对数的概念', subject:'数学', analysis:{strengths:'掌握记号', review:'复习底数', nextStep:'判断取值范围'},
      questions:[{type:'boolean', text:'底数可以是负数。', options:['正确','错误'], chosen:'A', answer:'B',
        reason:'底数必须为正数。', knowledge:['底数'], exercises:[{text:'哪个底数有效？', options:['2','0'], answer:'A', explanation:'2 大于 0 且不等于 1。'}]}]
    }});
  }, '/card-quiz/student-example.html');
  assert.equal(await page.title(), '课后报告 · ICeClass 班伴');
  await page.getByText('报告未能载入，请检查网络后重试。', {exact:true}).waitFor();
  assert.equal(await page.locator('#report').isVisible(), false);
  await page.getByRole('button', {name:'重新载入'}).press('Enter');
  await page.getByRole('heading', {name:'对数的概念'}).waitFor();
  assert.equal(await page.locator('.example-header span').innerText(), '课后报告');
  assert.doesNotMatch(await page.locator('body').innerText(), /示例/);
  await page.getByRole('button', {name:'查看 AI 学情报告'}).press('Enter');
  assert.equal(await page.locator('#ai').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(reads, 2);
});

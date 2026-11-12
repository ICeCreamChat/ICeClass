'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', 'web_controller');
const origin = 'http://127.0.0.1';
let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });

function fixture() {
  return {
    classId: 'search-test', className: '搜索验收班', revision: 1,
    date: '2026-11-07', serverDate: '2026-11-07', records: [],
    value: {
      activeTermId: 'term',
      students: [
        { id: 's1', name: '张三' }, { id: 's2', name: '张思远' },
        { id: 's3', name: '李四' }, { id: 's4', name: '单乐' }, { id: 's5', name: '吕小明' }
      ],
      terms: [{ id: 'term', label: '第一学期', subjects: [{ id: 'chinese', name: '语文',
        items: [{ id: 'workbook', name: '练习册', active: true }] }] }]
    }
  };
}

async function open(t, data = fixture(), viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'No browser errors'));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'The classroom search needs no external service');
    if (url.pathname === '/api/homework/classroom') return route.fulfill({ json: data });
    if (url.pathname === '/api/homework/classroom/records') {
      assert.equal(route.request().method(), 'PUT');
      const body = route.request().postDataJSON(); writes.push(body);
      const record = { ...body, students: data.value.students, revision: body.revision + 1 };
      data.records = [record];
      return route.fulfill({ json: { record } });
    }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    assert.ok(file.startsWith(root + path.sep), 'Only production static assets are served');
    try { return await route.fulfill({ path: file }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return route.fulfill({ status: 404, body: 'Not found' });
    }
  });
  await page.goto(origin + '/homework/classroom/index.html');
  await page.locator('[data-action="homework"]').click();
  await page.locator('#homework-dialog[open]').waitFor();
  await page.locator('#student-grid input').first().waitFor();
  return { page, search: page.locator('#student-search'), writes };
}

const names = page => page.locator('#student-grid .student-tile span').allTextContents();

test('Classroom roster matches name fragments, full pinyin and initials', async t => {
  const { page, search } = await open(t);
  for (const [query, expected] of [
    ['张', ['张三', '张思远']], ['三', ['张三']],
    ['zhangsan', ['张三']], ['zhangs', ['张三', '张思远']],
    ['Z S', ['张三', '张思远']], ['lisi', ['李四']],
    ['y', ['张思远', '单乐']],
    [' ＺＨＡＮＧ ＳＡＮ ', ['张三']], ['张 三', ['张三']],
    ['lüxiaoming', ['吕小明']], ['lvxiaoming', ['吕小明']], ['lxm', ['吕小明']]
  ]) {
    await search.fill(query);
    assert.deepEqual(await names(page), expected, query);
  }
});

test('Polyphonic names match their surname pronunciation and initials', async t => {
  const { page, search } = await open(t);
  for (const query of ['shanle', 'sl', 'shanl']) {
    await search.fill(query);
    assert.deepEqual(await names(page), ['单乐'], query);
  }
});

test('Clearing a search restores the roster and a miss displays feedback', async t => {
  const { page, search } = await open(t);
  await search.fill('no-such-name');
  assert.equal(await page.locator('#student-grid input').count(), 0);
  assert.equal(await page.locator('#empty-roster').isVisible(), true);
  await search.fill('   ');
  assert.deepEqual(await names(page), ['张三', '张思远', '李四', '单乐', '吕小明']);
  await page.getByRole('button', {name:'关闭作业登记',exact:true}).click();
  assert.equal(await page.locator('#confirm-dialog').isVisible(), false, 'Searching does not create a submission draft');
});

test('Searching and the missing-only filter preserve selections and save student IDs', async t => {
  const { page, search, writes } = await open(t);
  await search.fill('zs');
  await page.locator('[data-student="s1"]').uncheck();
  await search.fill('lisi');
  await page.locator('[data-student="s3"]').uncheck();
  await page.locator('#missing-filter').click();
  assert.deepEqual(await names(page), ['李四']);
  await search.fill('zs');
  assert.deepEqual(await names(page), ['张三']);
  assert.equal(await page.locator('[data-student="s1"]').isChecked(), false);
  await search.fill('');
  assert.deepEqual(await names(page), ['张三', '李四']);
  assert.match(await page.locator('#submitted-count').innerText(), /3\s*\/\s*5/);
  await page.locator('[data-action="save-homework"]').click();
  await page.getByText('登记已保存，教师端可查看。', { exact: true }).waitFor();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].missing, ['s1', 's3']);
  assert.equal(writes[0].status, 'submitted');
  assert.equal(await page.locator('[data-student="s1"]').isChecked(), false);
  assert.equal(await page.locator('[data-student="s3"]').isChecked(), false);
});

test('Matching duplicate names keeps each independently selectable student', async t => {
  const data = fixture(); data.value.students.push({ id: 's6', name: '张三' });
  const { page, search } = await open(t, data);
  await search.fill('zhangsan');
  assert.deepEqual(await names(page), ['张三', '张三']);
  await page.locator('[data-student="s6"]').uncheck();
  assert.equal(await page.locator('[data-student="s1"]').isChecked(), true);
});

test('Search uses the saved historical roster when the current class names changed', async t => {
  const data = fixture();
  data.records = [{ classId: data.classId, termId: 'term', termName: '第一学期', date: data.date,
    subjectId: 'chinese', subjectName: '语文', itemId: 'workbook', itemName: '练习册',
    students: [{ id: 'old-student', name: '赵小明' }], status: 'submitted', missing: [], revision: 1, updatedAt: 1 }];
  const { page, search } = await open(t, data);
  await search.fill('zxm');
  assert.deepEqual(await names(page), ['赵小明']);
  assert.equal(await page.locator('[data-student="old-student"]').isChecked(), true);
});

test('Narrow classroom search supports keyboard selection without horizontal overflow', async t => {
  for (const width of [720, 390]) {
    const { page, search } = await open(t, fixture(), { width, height: 520 });
    await search.fill('zs');
    await search.press('Tab');
    await page.locator('[data-student="s1"]').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('[data-student="s1"]').isChecked(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('#student-search').isVisible(), true);
  }
});

'use strict';

// Same isolated-browser/login/static-file pattern as test-island-admin.cjs.
// Every island/class-list request is fulfilled from fixtures. Only demo login
// and unrelated read-only application requests may reach the loopback server.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');

const reviewMode = process.argv.includes('--review');
const endpoint = new URL(process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'http://127.0.0.1:8870/');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Use a local demo server');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/bulk-island-review');
const clone = value => structuredClone(value);
let browser;
if (!reviewMode) {
  before(async () => {
    await fs.mkdir(output, { recursive: true });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  });
  after(async () => { await browser?.close(); });
}

const classes = [
  { id: 'bulk-11', name: '高一1班', grade: '高一', enabled: 1, canEditIsland: true },
  { id: 'bulk-12', name: '高一2班', grade: '高一', enabled: 1, canEditIsland: true },
  { id: 'bulk-21', name: '高二1班', grade: '高二', enabled: 1, canEditIsland: true },
  { id: 'bulk-22', name: '高二2班', grade: '高二', enabled: 1, canEditIsland: true },
  { id: 'bulk-31', name: '高三1班', grade: '高三', enabled: 1, canEditIsland: true },
  { id: 'bulk-off', name: '高三停用班', grade: '高三', enabled: 0, canEditIsland: true }
];

function profile(classId, index) {
  return {
    classId, revision: 4 + index, canEdit: true, devices: [],
    schoolVisibility: { revision: 2, config: { hideDaytimeLessons: true, hideFirstEvening: true } },
    config: {
      schemaVersion: 1, enabled: true, weekAnchor: '2026-09-07',
      slots: [{ id: 'p1', label: '第一节', start: 475, end: 520 },
        { id: 'e1', label: '晚自习第一节', start: 1100, end: 1190 }],
      lessons: [{ slotId: 'p1', weekday: 1, week: 'all', subject: '数学', teacher: '保留的任课教师', location: '' }],
      overrides: [{ date: '2026-11-03', slotId: 'p1', subject: '物理', teacher: '保留的调课教师' }],
      dutyRotations: {
        midday: { enabled: false, cycleWeeks: 1, weekAnchor: '2026-09-07', slotIds: [], lessons: [] },
        evening: { enabled: false, cycleWeeks: 3, weekAnchor: '2026-09-07', slotIds: ['e1'], lessons: [] }
      },
      visibility: { followSchool: false, hiddenSlotIds: ['p1'] },
      reminders: { enabled: true, prepare: true, start: false, end: false, prepareMinutes: 2, volume: 65, displaySeconds: 8 },
      appearance: { position: 'top-center', width: 560, opacity: 100, theme: 'light', offsetX: 0, offsetY: 0, hideDuringLessons: true },
      components: [{ id: 'message', type: 'text', text: '本班寄语', enabled: true }], rotationSeconds: 8, automation: []
    }
  };
}

async function open(t, options = {}) {
  const context = await browser.newContext({ viewport: { width: options.width || 1440, height: 1000 } });
  t.after(() => context.close());
  const login = await context.request.post(new URL('/api/auth/login', endpoint).href, {
    data: { username: 'ICe', password: 'LocalDemo2026' }
  });
  assert.equal(login.status(), 200, 'Local demo login succeeds');
  const user = (await login.json()).user;
  const model = {
    profiles: Object.fromEntries(classes.map((c, i) => [c.id, profile(c.id, i)])),
    previews: [], applies: [], profileGets: [], singleWrites: [], visibilityWrites: [], unexpected: [],
    previewMode: 'valid', applyStatus: 200, revisionShift: 0, ...options
  };
  if (options.unsavedDefaults) model.profiles['bulk-11'].revision = 0;
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => {
    assert.deepEqual(errors, [], 'No browser script errors');
    assert.deepEqual(model.unexpected, [], 'No unhandled API mutation reaches the local server');
    assert.deepEqual(model.singleWrites, [], 'Batch UI never replaces whole class profiles');
    assert.deepEqual(model.visibilityWrites, [], 'Batch UI never changes school/class visibility rules');
  });
  const staticFiles = new Set(['island-admin.js', 'island-admin.css', 'island-schedule.js', 'island-ribbon.js', 'island-ribbon.css']);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== endpoint.origin) return route.abort();
    if (url.pathname === '/') return route.fulfill({ path: path.join(root, 'web_controller/index.html'), contentType: 'text/html' });
    if (staticFiles.has(url.pathname.slice(1))) return route.fulfill({ path: path.join(root, 'web_controller', url.pathname.slice(1)) });
    if (url.pathname === '/api/session') return route.fulfill({ json: { authenticated: true, user: { ...user, role: options.role || 'superadmin' } } });
    if (url.pathname === '/api/classes') return route.fulfill({ json: { classes: clone(classes) } });
    // Synthetic class IDs must also stay out of the app shell's startup reads.
    if (method === 'GET' && url.pathname === '/api/history') return route.fulfill({ json: { history: [], hasMore: false } });
    if (method === 'GET' && url.pathname === '/api/classroom-voice') return route.fulfill({ json: { messages: [] } });
    if (method === 'GET' && /^\/api\/classes\/[^/]+\/status$/.test(url.pathname)) return route.fulfill({ json: { online: false } });
    if (url.pathname === '/api/island/visibility') {
      if (method !== 'GET') model.visibilityWrites.push(request.postDataJSON());
      return route.fulfill({ json: model.profiles['bulk-11'].schoolVisibility });
    }
    const classMatch = url.pathname.match(/^\/api\/island\/classes\/([^/]+)$/);
    if (classMatch) {
      const id = decodeURIComponent(classMatch[1]);
      if (method !== 'GET') model.singleWrites.push(request.postDataJSON());
      model.profileGets.push(id);
      if (model.failReload && model.applies.length && id === 'bulk-11') return route.fulfill({ status: 503, json: { error: '本班配置暂时无法重新载入' } });
      return route.fulfill({ status: model.profiles[id] ? 200 : 404, json: model.profiles[id] || { error: '未知测试班级' } });
    }
    if (url.pathname === '/api/island/bulk/preview') {
      assert.equal(method, 'POST');
      const data = request.postDataJSON(); model.previews.push(data);
      if (model.previewMode === 'network') return route.abort('failed');
      const rows = data.classIds.map((id, index) => ({ classId: id, className: classes.find(c => c.id === id).name,
        revision: model.profiles[id].revision + model.revisionShift, changed: index !== data.classIds.length - 1 || data.classIds.length === 1,
        addedSlots: index === 0 && data.changes.slots ? 2 : 0,
        ...(model.previewMode === 'invalid' && index === 0 ? { error: '第二节与午间静校重叠，请调整作息。' } : {}) }));
      if (model.previewMode === 'incomplete') rows.pop();
      return route.fulfill({ json: { valid: model.previewMode !== 'invalid', classes: rows } });
    }
    if (url.pathname === '/api/island/bulk') {
      assert.equal(method, 'PUT');
      const data = request.postDataJSON(); model.applies.push(data);
      await model.applyGate;
      if (model.applyStatus === 'network') return route.abort('failed');
      if (model.applyStatus === 409) {
        model.revisionShift++;
        return route.fulfill({ status: 409, json: { error: '本轮未下发，请核对班级提示后重新预览。',
          classes: data.classIds.map(id => ({ classId: id, className: classes.find(c => c.id === id).name,
            revision: model.profiles[id].revision + model.revisionShift, changed: false, error: '配置已被其他老师更新，请重新预览。' })) } });
      }
      const rows = data.classIds.map((id, index) => {
        const changed = index !== data.classIds.length - 1 || data.classIds.length === 1;
        if (changed) model.profiles[id].revision++;
        return { classId: id, className: classes.find(c => c.id === id).name, revision: data.revisions[id], changed, addedSlots: 0 };
      });
      return route.fulfill({ json: { updated: rows.filter(r => r.changed).length, unchanged: rows.filter(r => !r.changed).length, classes: rows } });
    }
    if (url.pathname.startsWith('/api/island/') || url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(method)) {
      model.unexpected.push(method + ' ' + url.pathname);
      return route.fulfill({ status: 400, json: { error: '测试已拦截未声明的 API 请求' } });
    }
    return route.continue();
  });
  await page.goto(endpoint.href);
  await page.waitForFunction(() => document.getElementById('settingsAccount').textContent.length > 0);
  assert.equal(await page.locator('#authPage').isVisible(), false, 'The workspace finishes authentication');
  const menu = page.getByRole('button', { name: '打开功能菜单', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: '教室浮岛', exact: true }).click();
  await page.locator('.island-week table').waitFor();
  return { page, model, bulk: page.locator('#islandBulk') };
}

async function dialogFor(page, bulk) {
  await bulk.click();
  const dialog = page.getByRole('dialog', { name: '批量设置浮岛', exact: true });
  await dialog.waitFor();
  return dialog;
}
async function preview(dialog) {
  await dialog.getByRole('button', { name: '预览影响', exact: true }).click();
  await dialog.locator('.island-bulk-results').waitFor();
}

if (!reviewMode) {
for (const role of ['superadmin', 'principal', 'director', 'grade_leader', 'teacher']) {
  test(`Bulk entry is school-admin-only: ${role}`, async t => {
    const { bulk } = await open(t, { role });
    assert.equal(await bulk.isVisible(), ['superadmin', 'principal'].includes(role));
  });
}

test('All-school preview freezes enabled targets, uses selected settings, then applies exact revisions', async t => {
  const { page, model, bulk } = await open(t);
  const original = clone(model.profiles['bulk-11'].config);
  const dialog = await dialogFor(page, bulk);
  assert.equal(await dialog.getByRole('checkbox', { name: '浮岛开关', exact: true }).isChecked(), true);
  assert.match(await dialog.locator('.island-bulk-count').innerText(), /5 个/);
  await dialog.getByLabel('批量浮岛状态', { exact: true }).selectOption('false');
  for (const group of ['作息时间', '提醒设置', '浮岛外观']) await dialog.getByRole('checkbox', { name: group, exact: true }).check();
  await preview(dialog);
  assert.deepEqual(model.previews[0].classIds, classes.filter(c => c.enabled).map(c => c.id));
  const { hideDuringLessons, ...appearance } = original.appearance;
  assert.deepEqual(model.previews[0].changes, { enabled: false, slots: original.slots, reminders: original.reminders, appearance });
  assert.deepEqual(model.profiles['bulk-11'].config, original, 'Preparing bulk changes never mutates the saved source profile');
  assert.equal(await dialog.locator('input, select').evaluateAll(nodes => nodes.every(node => node.matches(':disabled'))), true);
  assert.match(await dialog.locator('.island-bulk-summary').innerText(), /4 个.*更改|更改.*4 个/);
  assert.match(await dialog.locator('.island-bulk-summary').innerText(), /1 个.*无需更改/);
  assert.match(await dialog.locator('.island-bulk-results').innerText(), /新增.*2/);
  const gets = model.profileGets.filter(id => id === 'bulk-11').length;
  await page.evaluate(() => { window.ICeClass.state.classes[0].enabled = 0; window.ICeClass.state.classes.reverse(); });
  await dialog.getByRole('button', { name: '应用到 5 个班级', exact: true }).click();
  await dialog.getByRole('button', { name: '完成', exact: true }).waitFor();
  assert.deepEqual(model.applies[0], { ...model.previews[0], revisions: { 'bulk-11': 4, 'bulk-12': 5, 'bulk-21': 6, 'bulk-22': 7, 'bulk-31': 8 } });
  assert.ok(model.profileGets.filter(id => id === 'bulk-11').length > gets, 'The current targeted class reloads');
  assert.match(await dialog.locator('.island-bulk-summary').innerText(), /已更新 4 个班级.*1 个无需更改/);
  assert.equal(await dialog.locator('.island-bulk-results li').filter({ hasText: '已更新' }).count(), 4);
  assert.match(await page.locator('#toastRegion').innerText(), /4 个班级.*1 个无需更改/);
  await dialog.getByRole('button', { name: '完成', exact: true }).press('Enter');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await bulk.evaluate(node => node === document.activeElement), true);
});

test('Grade scope sends only that grade and does not reload an untargeted current class', async t => {
  const { page, model, bulk } = await open(t);
  const dialog = await dialogFor(page, bulk);
  await dialog.getByRole('radio', { name: '按年级', exact: true }).check();
  await dialog.getByLabel('选择年级', { exact: true }).selectOption('高二');
  assert.match(await dialog.locator('.island-bulk-count').innerText(), /2 个/);
  await preview(dialog);
  assert.deepEqual(model.previews[0], { classIds: ['bulk-21', 'bulk-22'], changes: { enabled: true } });
  const gets = model.profileGets.filter(id => id === 'bulk-11').length;
  await dialog.getByRole('button', { name: '应用到 2 个班级', exact: true }).click();
  await dialog.getByRole('button', { name: '完成', exact: true }).waitFor();
  assert.equal(model.profileGets.filter(id => id === 'bulk-11').length, gets);
});

test('Multi-select/search retains checked classes, supports returning to edit, and excludes disabled classes', async t => {
  const { page, model, bulk } = await open(t);
  const dialog = await dialogFor(page, bulk);
  await dialog.getByRole('radio', { name: '选择班级', exact: true }).check();
  assert.match(await dialog.locator('.island-bulk-count').innerText(), /0 个/);
  assert.equal(await dialog.getByRole('checkbox', { name: '高三停用班', exact: true }).count(), 0);
  await dialog.getByRole('checkbox', { name: '高一2班', exact: true }).check();
  await dialog.getByLabel('查找班级', { exact: true }).fill('高二');
  await dialog.getByRole('checkbox', { name: '高二1班', exact: true }).check();
  assert.match(await dialog.locator('.island-bulk-count').innerText(), /2 个/);
  await preview(dialog);
  assert.deepEqual(model.previews[0].classIds, ['bulk-12', 'bulk-21']);
  await dialog.getByRole('button', { name: '返回修改', exact: true }).click();
  assert.equal(await dialog.getByLabel('查找班级', { exact: true }).isEnabled(), true);
  await dialog.getByLabel('查找班级', { exact: true }).fill('');
  await dialog.getByRole('checkbox', { name: '高一2班', exact: true }).uncheck();
  await preview(dialog);
  assert.deepEqual(model.previews[1].classIds, ['bulk-21']);
});

test('Empty targets/groups show inline errors without previewing', async t => {
  const { page, model, bulk } = await open(t);
  const dialog = await dialogFor(page, bulk);
  await dialog.getByRole('radio', { name: '选择班级', exact: true }).check();
  await dialog.getByRole('button', { name: '预览影响', exact: true }).click();
  assert.match(await dialog.getByRole('alert').innerText(), /至少选择一个班级/);
  await dialog.getByRole('checkbox', { name: '高一1班', exact: true }).check();
  await dialog.getByRole('checkbox', { name: '浮岛开关', exact: true }).uncheck();
  await dialog.getByRole('button', { name: '预览影响', exact: true }).click();
  assert.match(await dialog.getByRole('alert').innerText(), /至少选择一项设置/);
  assert.equal(model.previews.length, 0);
});

test('Invalid preview preserves per-class errors, blocks apply, and permits correction', async t => {
  const { page, model, bulk } = await open(t, { previewMode: 'invalid' });
  const dialog = await dialogFor(page, bulk);
  await preview(dialog);
  assert.match(await dialog.locator('.island-bulk-results').innerText(), /第二节与午间静校重叠/);
  assert.equal(await dialog.getByRole('button', { name: '应用到 5 个班级', exact: true }).isDisabled(), true);
  assert.equal(model.applies.length, 0);
  await dialog.getByRole('button', { name: '返回修改', exact: true }).click();
  model.previewMode = 'valid';
  await preview(dialog);
  assert.equal(await dialog.getByRole('button', { name: '应用到 5 个班级', exact: true }).isEnabled(), true);
});

test('409 keeps errors visible and requires a manually refreshed preview/revisions', async t => {
  const { page, model, bulk } = await open(t, { applyStatus: 409 });
  const dialog = await dialogFor(page, bulk);
  await preview(dialog);
  await dialog.getByRole('button', { name: '应用到 5 个班级', exact: true }).click();
  await dialog.getByRole('button', { name: '重新预览', exact: true }).waitFor();
  assert.match(await dialog.getByRole('alert').innerText(), /未下发.*重新预览/);
  assert.match(await dialog.locator('.island-bulk-results').innerText(), /其他老师更新/);
  assert.equal(model.previews.length, 1);
  assert.equal(model.applies.length, 1);
  assert.equal(await dialog.getByRole('button', { name: /^应用到/ }).count(), 0);
  model.applyStatus = 200;
  await dialog.getByRole('button', { name: '重新预览', exact: true }).click();
  await dialog.getByRole('button', { name: '应用到 5 个班级', exact: true }).click();
  await dialog.getByRole('button', { name: '完成', exact: true }).waitFor();
  assert.equal(model.previews.length, 2);
  assert.equal(model.applies[1].revisions['bulk-11'], 5);
});

for (const stage of ['preview', 'apply']) test(`${stage} network failure supports manual re-preview without automatic retry`, async t => {
  const { page, model, bulk } = await open(t);
  const dialog = await dialogFor(page, bulk);
  if (stage === 'preview') {
    model.previewMode = 'network';
    await dialog.getByRole('button', { name: '预览影响', exact: true }).click();
  } else {
    await preview(dialog); model.applyStatus = 'network';
    await dialog.getByRole('button', { name: '应用到 5 个班级', exact: true }).click();
  }
  await dialog.getByRole('alert').filter({ hasText: /失败|fetch|网络|确认/i }).waitFor();
  assert.equal(model.previews.length, 1);
  assert.equal(model.applies.length, stage === 'apply' ? 1 : 0);
  model.previewMode = 'valid'; model.applyStatus = 200;
  await dialog.getByRole('button', { name: stage === 'preview' ? '预览影响' : '重新预览', exact: true }).click();
  await dialog.getByRole('button', { name: '应用到 5 个班级', exact: true }).waitFor();
  assert.equal(model.previews.length, 2);
  assert.equal(model.applies.length, stage === 'apply' ? 1 : 0);
});

for (const defaults of [false, true]) test(`Unsaved ${defaults ? 'grade defaults' : 'edits'} guard blocks opening and all requests`, async t => {
  const { page, model, bulk } = await open(t, { unsavedDefaults: defaults });
  if (!defaults) {
    await page.getByRole('tab', { name: '提醒与外观', exact: true }).click();
    await page.getByLabel('浮岛宽度（像素）', { exact: true }).fill('640');
  }
  await bulk.click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.match(await page.locator('#islandError').innerText(), /请先保存/);
  assert.equal(model.previews.length, 0); assert.equal(model.applies.length, 0);
});

test('Esc restores trigger focus; keyboard alone can choose, preview, apply and finish', async t => {
  const { page, model, bulk } = await open(t);
  await bulk.focus(); await bulk.press('Enter');
  let dialog = page.getByRole('dialog');
  await dialog.waitFor(); await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await bulk.evaluate(node => node === document.activeElement), true);
  await bulk.press('Enter'); dialog = page.getByRole('dialog'); await dialog.waitFor();
  const scope = dialog.getByRole('radio', { name: '全校', exact: true });
  await scope.focus(); await scope.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  assert.equal(await dialog.getByRole('radio', { name: '选择班级', exact: true }).isChecked(), true);
  await dialog.getByRole('checkbox', { name: '高一1班', exact: true }).focus(); await page.keyboard.press('Space');
  await dialog.getByRole('button', { name: '预览影响', exact: true }).press('Enter');
  const apply = dialog.getByRole('button', { name: '应用到 1 个班级', exact: true });
  await apply.waitFor();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'Native dialog traps keyboard focus');
  }
  await apply.press('Enter'); await dialog.getByRole('button', { name: '完成', exact: true }).press('Enter');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(model.applies.length, 1);
  assert.equal(await bulk.evaluate(node => node === document.activeElement), true);
});

test('Applying locks cancellation and Esc until the request completes', async t => {
  let release;
  const applyGate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { page, bulk } = await open(t, { applyGate });
  const dialog = await dialogFor(page, bulk); await preview(dialog);
  await dialog.getByRole('button', { name: '应用到 5 个班级', exact: true }).click();
  await dialog.locator('button:has-text("保存中")').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: '返回修改', exact: true }).isDisabled(), true);
  release(); await dialog.getByRole('button', { name: '完成', exact: true }).waitFor();
});

test('Incomplete previews never enable apply; a reload failure stays visible after successful apply', async t => {
  const { page, model, bulk } = await open(t, { previewMode: 'incomplete' });
  const dialog = await dialogFor(page, bulk);
  await dialog.getByRole('button', { name: '预览影响', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: /不完整/ }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: /^应用到/ }).count(), 0);
  model.previewMode = 'valid'; model.failReload = true;
  await preview(dialog);
  await dialog.getByRole('button', { name: '应用到 5 个班级', exact: true }).click();
  await dialog.getByRole('button', { name: '完成', exact: true }).waitFor();
  assert.match(await dialog.getByRole('alert').innerText(), /已完成.*重新载入/);
});

for (const width of [375, 1440]) test(`${width}px bulk preview fits, remains keyboard accessible and renders its review screenshot`, async t => {
  const { page, bulk } = await open(t, { width });
  const dialog = await dialogFor(page, bulk);
  assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1), true, 'Editing fits the viewport');
  for (const name of ['作息时间', '提醒设置', '浮岛外观']) await dialog.getByRole('checkbox', { name, exact: true }).check();
  await preview(dialog);
  const geometry = await dialog.evaluate(node => ({
    documentFits: document.documentElement.scrollWidth <= innerWidth + 1,
    dialogFits: node.scrollWidth <= node.clientWidth + 1,
    inside: node.getBoundingClientRect().left >= 0 && node.getBoundingClientRect().right <= innerWidth,
    actionsVisible: [...node.querySelectorAll('.island-bulk-actions button')].filter(b => !b.hidden).every(button => {
      const r = button.getBoundingClientRect(), d = node.getBoundingClientRect();
      return r.left >= d.left && r.right <= d.right && r.bottom <= d.bottom && r.height >= 44;
    })
  }));
  assert.deepEqual(geometry, { documentFits: true, dialogFits: true, inside: true, actionsVisible: true });
  await dialog.locator('.island-bulk-body').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, `bulk-${width}.png`), fullPage: false });
});
} else {
  // An optional visible review uses the exact same fixtures and write blockers.
  // Close this isolated Edge window to end the review process.
  (async () => {
    browser = await chromium.launch({ channel: 'msedge', headless: false });
    const { page, bulk } = await open({ after() {} });
    page.once('close', () => { void browser.close(); });
    await page.evaluate(() => { document.title = '浮岛批量设置 · 隔离验收'; });
    await dialogFor(page, bulk);
    console.log('Isolated review is open. All class profiles and bulk writes use fixtures.');
  })().catch(async error => {
    console.error(error);
    await browser?.close();
    process.exitCode = 1;
  });
}

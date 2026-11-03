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
const output = path.join(root, 'output/island-bulk-ux-20261103/browser');
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
  { id: 'bulk-11', name: '高一1班', enabled: 1, canEditIsland: true },
  { id: 'bulk-12', name: '高一2班', enabled: 1, canEditIsland: true },
  { id: 'bulk-21', name: '高二1班', enabled: 1, canEditIsland: true },
  { id: 'bulk-22', name: '高二2班', enabled: 1, canEditIsland: true },
  { id: 'bulk-31', name: '高三1班', enabled: 1, canEditIsland: true },
  { id: 'bulk-off', name: '高三停用班', enabled: 0, canEditIsland: true }
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
    assert.ok(model.singleWrites.every(write => options.allowSave && write.classId === 'bulk-11'), 'Only an explicitly confirmed save of the source may use the single-class endpoint');
    assert.deepEqual(model.visibilityWrites, [], 'Batch UI never changes school/class visibility rules');
  });
  const staticFiles = new Set(['island-admin.js', 'island-admin.css', 'island-schedule.js', 'island-ribbon.js', 'island-ribbon.css']);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== endpoint.origin) return route.abort();
    if (url.pathname === '/') return route.fulfill({ path: path.join(root, 'web_controller/index.html'), contentType: 'text/html' });
    if (staticFiles.has(url.pathname.slice(1))) return route.fulfill({ path: path.join(root, 'web_controller', url.pathname.slice(1)) });
    if (url.pathname === '/api/session') return route.fulfill({ json: { authenticated: true, user: { ...user, role: options.role || 'superadmin' } } });
    if (url.pathname === '/api/classes') return route.fulfill({ json: { classes: clone(classes).map(c => ({ ...c, canEditIsland: !options.editableIds || options.editableIds.includes(c.id) })) } });
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
      if (method !== 'GET') {
        const data = request.postDataJSON(); model.singleWrites.push({ classId: id, ...data });
        if (model.saveError) return route.fulfill({ status: 503, json: { error: '来源班级保存失败，请重试' } });
        if (options.allowSave) model.profiles[id] = { ...model.profiles[id], revision: model.profiles[id].revision + 1, config: data.config };
      }
      model.profileGets.push(id);
      if (model.failReload && model.applies.length && id === 'bulk-11') return route.fulfill({ status: 503, json: { error: '本班配置暂时无法重新载入' } });
      return route.fulfill({ status: model.profiles[id] ? 200 : 404, json: model.profiles[id] ? { ...model.profiles[id], canEdit: !options.readOnly } : { error: '未知测试班级' } });
    }
    if (url.pathname === '/api/island/bulk/preview') {
      assert.equal(method, 'POST');
      const data = request.postDataJSON(); model.previews.push(data);
      if (model.sourceChanged) return route.fulfill({ status: 409, json: { error: '来源班级的设置已更新，请重新载入。', sourceChanged: true } });
      if (model.previewMode === 'network') return route.abort('failed');
      const rows = data.classIds.map((id, index) => ({ classId: id, className: classes.find(c => c.id === id).name,
        revision: model.profiles[id].revision + model.revisionShift, changed: index !== data.classIds.length - 1 || data.classIds.length === 1,
        addedSlots: index === 0 && data.sections.includes('slots') ? 2 : 0, details: data.sections.map(name => '同步：' + name),
        ...(model.previewMode === 'invalid' && index === 0 ? { error: '第二节与午间静校重叠，请调整作息。' } : {}) }));
      if (model.previewMode === 'incomplete') rows.pop();
      return route.fulfill({ json: { valid: model.previewMode !== 'invalid', classes: rows } });
    }
    if (url.pathname === '/api/island/bulk') {
      assert.equal(method, 'PUT');
      const data = request.postDataJSON(); model.applies.push(data);
      if (model.sourceChanged) return route.fulfill({ status: 409, json: { error: '来源班级的设置已更新，请重新载入。', sourceChanged: true } });
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
  const dialog = page.locator('dialog.island-bulk-dialog');
  await dialog.waitFor();
  assert.equal(await dialog.getAttribute('aria-labelledby').then(id => page.locator('#' + id).innerText()), '批量设置');
  return dialog;
}
async function preview(dialog) {
  await dialog.getByRole('button', { name: '预览影响', exact: true }).click();
  await dialog.locator('.island-bulk-results').waitFor();
}

const sectionNames = ['浮岛开关', '作息时间', '周课表', '值班安排', '临时调课', '提醒设置', '浮岛外观', '课堂隐藏', '轮播信息', '自动化'];
async function selectTargets(dialog, grade = 'all') {
  await dialog.getByLabel('年级', { exact: true }).selectOption(grade);
  await dialog.getByRole('button', { name: '全选当前结果', exact: true }).click();
}
async function prepare(dialog, groups = ['浮岛开关']) {
  for (const name of groups) await dialog.getByRole('checkbox', { name, exact: true }).check();
  await selectTargets(dialog);
}
function applyButton(dialog, count = 4) { return dialog.getByRole('button', { name: `确认下发到 ${count} 个班级`, exact: true }); }

if (!reviewMode) {
for (const role of ['superadmin', 'principal', 'director', 'grade_leader', 'teacher']) test(`Unified entry keeps existing class editing permissions: ${role}`, async t => {
  const { page, bulk } = await open(t, { role });
  assert.equal(await bulk.isVisible(), true);
  assert.equal(await bulk.isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: '复制到其他班级', exact: true }).count(), 0);
});

test('Readonly source hides bulk editing; one editable source has no other targets', async t => {
  const { bulk } = await open(t, { readOnly: true });
  assert.equal(await bulk.isVisible(), false);
  const another = await open(t, { editableIds: ['bulk-11'] });
  assert.equal(await another.bulk.isDisabled(), true);
});

test('Defaults select neither content nor school; grade groups support selecting, search and clearing', async t => {
  const { page, model, bulk } = await open(t);
  const dialog = await dialogFor(page, bulk);
  assert.match(await dialog.locator('.island-bulk-count').innerText(), /0 个/);
  assert.equal(await dialog.getByRole('checkbox', { name: '全部设置', exact: true }).isChecked(), false);
  assert.equal(await dialog.getByRole('checkbox', { name: '浮岛开关', exact: true }).isChecked(), false);
  assert.equal(await dialog.getByRole('checkbox', { name: '高一1班', exact: true }).count(), 0, 'Source is not a target');
  assert.equal(await dialog.getByRole('checkbox', { name: '高三停用班', exact: true }).count(), 0);
  assert.equal(await dialog.getByLabel('年级', { exact: true }).inputValue(), '高一');
  await dialog.getByRole('checkbox', { name: '选择高一年级', exact: true }).check();
  await dialog.getByLabel('年级', { exact: true }).selectOption('高二');
  await dialog.getByLabel('查找班级', { exact: true }).fill('高二1');
  await dialog.getByRole('button', { name: '全选当前结果', exact: true }).click();
  assert.match(await dialog.locator('.island-bulk-count').innerText(), /2 个/);
  await dialog.getByLabel('查找班级', { exact: true }).fill('不存在的班级');
  assert.match(await dialog.innerText(), /没有符合的班级/);
  assert.match(await dialog.locator('.island-bulk-count').innerText(), /2 个/);
  await dialog.getByLabel('查找班级', { exact: true }).fill('');
  await dialog.getByRole('checkbox', { name: '浮岛开关', exact: true }).check();
  await preview(dialog);
  assert.deepEqual(model.previews[0].classIds, ['bulk-12', 'bulk-21']);
  await dialog.getByRole('button', { name: '返回修改', exact: true }).click();
  assert.equal(await dialog.getByRole('checkbox', { name: '高二1班', exact: true }).isChecked(), true);
  await dialog.getByRole('button', { name: '清空选择', exact: true }).click();
  assert.match(await dialog.locator('.island-bulk-count').innerText(), /0 个/);
});

test('Only authorized target classes appear', async t => {
  const { page, bulk, model } = await open(t, { role: 'teacher', editableIds: ['bulk-11', 'bulk-12', 'bulk-21'] });
  const dialog = await dialogFor(page, bulk); await prepare(dialog);
  await preview(dialog);
  assert.deepEqual(model.previews[0].classIds, ['bulk-12', 'bulk-21']);
});

test('Selective preview freezes source, selected sections and targets, then applies exact revisions', async t => {
  const { page, model, bulk } = await open(t);
  const original = clone(model.profiles['bulk-11'].config), dialog = await dialogFor(page, bulk);
  await prepare(dialog, ['作息时间', '提醒设置', '浮岛外观']); await preview(dialog);
  assert.deepEqual(model.previews[0], { sourceClassId: 'bulk-11', sourceRevision: 4,
    sections: ['slots', 'reminders', 'appearance'], classIds: ['bulk-12', 'bulk-21', 'bulk-22', 'bulk-31'] });
  assert.deepEqual(model.profiles['bulk-11'].config, original);
  assert.equal(await dialog.locator('input, select').evaluateAll(nodes => nodes.every(node => node.matches(':disabled'))), true);
  assert.match(await dialog.locator('.island-bulk-summary').innerText(), /3 个班级将更新，1 个无需更改/);
  assert.match(await dialog.locator('.island-bulk-results').innerText(), /新增 2/);
  const gets = model.profileGets.length;
  await page.evaluate(() => { window.ICeClass.state.classes.reverse(); window.ICeClass.state.classes[0].enabled = 0; });
  await applyButton(dialog).click(); await dialog.getByRole('button', { name: '完成', exact: true }).waitFor();
  assert.deepEqual(model.applies[0], { ...model.previews[0], revisions: { 'bulk-12': 5, 'bulk-21': 6, 'bulk-22': 7, 'bulk-31': 8 } });
  assert.equal(model.profileGets.length, gets, 'Source does not need a reload when only other classes changed');
  assert.match(await dialog.locator('.island-bulk-summary').innerText(), /已更新 3 个班级，1 个无需更改/);
  await dialog.getByRole('button', { name: '完成', exact: true }).press('Enter');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await bulk.evaluate(node => node === document.activeElement), true);
});

test('Whole configuration is an explicit selection and includes the source floating state', async t => {
  const { page, model, bulk } = await open(t);
  model.profiles['bulk-11'].config.enabled = false;
  await page.locator('#islandMore summary').click(); await page.getByRole('button', { name: '重新载入', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#islandEditor').getAttribute('aria-busy') === 'false');
  const dialog = await dialogFor(page, bulk);
  await dialog.getByRole('checkbox', { name: '全部设置', exact: true }).check();
  assert.equal(await dialog.getByLabel('批量浮岛状态', { exact: true }).inputValue(), 'false');
  await selectTargets(dialog); await preview(dialog);
  assert.equal(model.previews[0].sections.length, 10); assert.equal(model.previews[0].enabled, false);
  assert.match(await dialog.locator('.island-bulk-review').innerText(), /全部浮岛配置/);
  await dialog.getByRole('button', { name: '返回修改', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '周课表', exact: true }).uncheck();
  assert.equal(await dialog.getByRole('checkbox', { name: '全部设置', exact: true }).evaluate(node => node.indeterminate), true);
});

test('Empty selections show useful errors and never submit', async t => {
  const { page, model, bulk } = await open(t);
  const dialog = await dialogFor(page, bulk);
  await dialog.getByRole('button', { name: '预览影响', exact: true }).click();
  assert.match(await dialog.getByRole('alert').innerText(), /至少选择一项/);
  await dialog.getByRole('checkbox', { name: '浮岛开关', exact: true }).check();
  await dialog.getByRole('button', { name: '预览影响', exact: true }).click();
  assert.match(await dialog.getByRole('alert').innerText(), /至少选择一个目标班级/);
  assert.equal(model.previews.length, 0);
});

test('Invalid preview blocks the whole batch and supports editing preserved selections', async t => {
  const { page, model, bulk } = await open(t, { previewMode: 'invalid' });
  const dialog = await dialogFor(page, bulk); await prepare(dialog); await preview(dialog);
  assert.match(await dialog.locator('.island-bulk-results').innerText(), /第二节与午间静校重叠/);
  assert.equal(await applyButton(dialog).isDisabled(), true);
  assert.equal(model.applies.length, 0);
  await dialog.getByRole('button', { name: '返回修改', exact: true }).click();
  model.previewMode = 'valid'; await preview(dialog);
  assert.equal(await applyButton(dialog).isEnabled(), true);
});

test('409 requires re-preview and sends refreshed target versions', async t => {
  const { page, model, bulk } = await open(t, { applyStatus: 409 });
  const dialog = await dialogFor(page, bulk); await prepare(dialog); await preview(dialog);
  await applyButton(dialog).click(); await dialog.getByRole('button', { name: '重新预览', exact: true }).waitFor();
  assert.match(await dialog.getByRole('alert').innerText(), /未下发.*重新预览/);
  assert.equal(model.previews.length, 1); assert.equal(model.applies.length, 1);
  model.applyStatus = 200;
  await dialog.getByRole('button', { name: '重新预览', exact: true }).click(); await applyButton(dialog).click();
  await dialog.getByRole('button', { name: '完成', exact: true }).waitFor();
  assert.equal(model.applies[1].revisions['bulk-12'], 6);
});

for (const stage of ['preview', 'apply']) test(`${stage} network failure permits manual retry without repeating writes`, async t => {
  const { page, model, bulk } = await open(t);
  const dialog = await dialogFor(page, bulk); await prepare(dialog);
  if (stage === 'preview') { model.previewMode = 'network'; await dialog.getByRole('button', { name: '预览影响', exact: true }).click(); }
  else { await preview(dialog); model.applyStatus = 'network'; await applyButton(dialog).click(); }
  await dialog.getByRole('alert').filter({ hasText: /失败|fetch|网络|确认/i }).waitFor();
  assert.equal(model.previews.length, 1); assert.equal(model.applies.length, stage === 'apply' ? 1 : 0);
  model.previewMode = 'valid'; model.applyStatus = 200;
  await dialog.getByRole('button', { name: stage === 'preview' ? '预览影响' : '重新预览', exact: true }).click();
  await applyButton(dialog).waitFor(); assert.equal(model.previews.length, 2);
});

for (const defaults of [false, true]) test(`Unsaved ${defaults ? 'initial defaults' : 'edits'} offer an explicit source save before bulk preview`, async t => {
  const { page, model, bulk } = await open(t, { unsavedDefaults: defaults, allowSave: true });
  if (!defaults) {
    await page.getByRole('tab', { name: '提醒与外观', exact: true }).click();
    await page.getByLabel('浮岛宽度（像素）', { exact: true }).fill('640');
  }
  const dialog = await dialogFor(page, bulk);
  assert.equal(model.singleWrites.length, 0); assert.equal(model.previews.length, 0);
  await dialog.getByRole('button', { name: '保存并继续', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '全部设置', exact: true }).waitFor();
  assert.equal(model.singleWrites.length, 1);
  await prepare(dialog); await preview(dialog);
  assert.equal(model.previews[0].sourceRevision, defaults ? 1 : 5);
});

test('Failed source save stays visible with a retry and never enters bulk submit', async t => {
  const { page, model, bulk } = await open(t, { unsavedDefaults: true, allowSave: true, saveError: true });
  const dialog = await dialogFor(page, bulk);
  await dialog.getByRole('button', { name: '保存并继续', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: /保存失败/ }).waitFor();
  assert.equal(model.previews.length, 0); assert.equal(model.applies.length, 0);
  assert.equal(await dialog.getByRole('button', { name: '保存并继续', exact: true }).isEnabled(), true);
});

test('Keyboard can cancel, select contents/classes, preview and apply, with focus kept in the dialog', async t => {
  const { page, model, bulk } = await open(t);
  await bulk.focus(); await bulk.press('Enter'); let dialog = page.getByRole('dialog');
  await dialog.waitFor(); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  assert.equal(await bulk.evaluate(node => node === document.activeElement), true);
  await bulk.press('Enter'); dialog = page.getByRole('dialog'); await dialog.waitFor();
  await dialog.getByRole('checkbox', { name: '浮岛开关', exact: true }).focus(); await page.keyboard.press('Space');
  await dialog.getByRole('checkbox', { name: '高一2班', exact: true }).focus(); await page.keyboard.press('Space');
  await dialog.getByRole('button', { name: '预览影响', exact: true }).press('Enter'); await applyButton(dialog, 1).waitFor();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab'); assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true);
  }
  await applyButton(dialog, 1).press('Enter'); await dialog.getByRole('button', { name: '完成', exact: true }).press('Enter');
  await dialog.waitFor({ state: 'detached' }); assert.equal(model.applies.length, 1);
});

test('Applying locks close, cancel and repeated submission until receipt', async t => {
  let release; const applyGate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const { page, model, bulk } = await open(t, { applyGate });
  const dialog = await dialogFor(page, bulk); await prepare(dialog); await preview(dialog); await applyButton(dialog).click();
  await dialog.getByRole('button', { name: '下发中…', exact: true }).waitFor(); await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), true);
  for (const name of ['关闭', '取消', '返回修改', '下发中…']) assert.equal(await dialog.getByRole('button', { name, exact: true }).isDisabled(), true);
  assert.equal(model.applies.length, 1); release(); await dialog.getByRole('button', { name: '完成', exact: true }).waitFor();
});

test('Incomplete preview never enables applying', async t => {
  const { page, model, bulk } = await open(t, { previewMode: 'incomplete' });
  const dialog = await dialogFor(page, bulk); await prepare(dialog);
  await dialog.getByRole('button', { name: '预览影响', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: /不完整/ }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: /^确认下发/ }).count(), 0); assert.equal(model.applies.length, 0);
});

test('Changed source blocks submitting the old template and supports reloading the source', async t => {
  const { page, model, bulk } = await open(t);
  const dialog = await dialogFor(page, bulk); await prepare(dialog); await preview(dialog);
  model.sourceChanged = true; model.profiles['bulk-11'].revision = 9; await applyButton(dialog).click();
  await dialog.getByRole('alert').filter({ hasText: /来源班级/ }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '重新预览', exact: true }).isDisabled(), true);
  model.sourceChanged = false;
  await dialog.getByRole('button', { name: '重新载入来源', exact: true }).click();
  const fresh = page.locator('dialog.island-bulk-dialog'); await fresh.waitFor();
  await prepare(fresh); await preview(fresh);
  assert.equal(model.previews[1].sourceRevision, 9);
});

test('More operations uses the existing menu and Escape restores focus', async t => {
  const { page } = await open(t);
  const menu = page.locator('#islandMore'), trigger = menu.locator('summary');
  await trigger.click();
  for (const name of ['重新载入', '导入 Excel', '导出 Excel']) assert.equal(await menu.getByRole('button', { name, exact: true }).isVisible(), true);
  await page.keyboard.press('Escape'); assert.equal(await menu.getAttribute('open'), null);
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
});

for (const width of [375, 768, 1440]) test(`${width}px editor and preview fit with visible fixed actions and shared control sizes`, async t => {
  const { page, bulk } = await open(t, { width }); const dialog = await dialogFor(page, bulk); await prepare(dialog);
  const check = async () => {
    assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.equal(await dialog.locator('.island-bulk-actions').evaluate(node => [...node.querySelectorAll('button')].filter(b => !b.hidden).every(b => {
      const rect = b.getBoundingClientRect(), dialog = b.closest('dialog').getBoundingClientRect();
      return rect.left >= dialog.left && rect.right <= dialog.right && rect.bottom <= dialog.bottom && rect.height >= 39;
    })), true);
  };
  await check(); await dialog.locator('.island-bulk-body').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, `edit-${width}.png`) });
  await preview(dialog); await check(); await page.screenshot({ path: path.join(output, `preview-${width}.png`) });
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

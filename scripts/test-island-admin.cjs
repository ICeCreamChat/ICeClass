'use strict';

// Browser regressions against the local demo. Playwright is a QA-only dependency.
// Each page uses an isolated profile response; no class configuration is saved.
const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');

const endpoint = new URL(process.argv[2] || 'http://127.0.0.1:8870/');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Use a local demonstration server');
const root = path.resolve(__dirname, '..');
let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });

function profile() {
  return {
    classId: 'qa', revision: 4, devices: [],
    schoolVisibility: { revision: 0, config: { hideDaytimeLessons: true, hideFirstEvening: true } }, config: {
      schemaVersion: 1, enabled: true, weekAnchor: '2026-09-07',
      slots: [
        { id: 'p1', label: '第一节', start: 475, end: 520 },
        { id: 'e1', label: '晚自习第一节', start: 1100, end: 1190 }
      ],
      lessons: [{ slotId: 'p1', weekday: 1, week: 'all', subject: '数学', teacher: '日常教师', location: '' }],
      overrides: [],
      visibility: { followSchool: true, hiddenSlotIds: ['p1', 'e1'] },
      dutyRotations: {
        midday: { enabled: false, cycleWeeks: 1, weekAnchor: '2026-09-07', slotIds: [], lessons: [] },
        evening: { enabled: false, cycleWeeks: 3, weekAnchor: '2026-09-07', slotIds: ['e1'], lessons: [] }
      },
      reminders: { enabled: false, prepare: false, start: false, end: false, prepareMinutes: 2, volume: 65, displaySeconds: 8 },
      appearance: { position: 'top-center', width: 560, opacity: 100, theme: 'light', offsetX: 0, offsetY: 0 },
      components: [], rotationSeconds: 8, automation: []
    }
  };
}

async function open(t, data) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const login = await context.request.post(new URL('/api/auth/login', endpoint).href, {
    data: { username: 'ICe', password: 'LocalDemo2026' }
  });
  assert.equal(login.status(), 200, 'Demo login succeeds');
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'No browser script errors'));
  await page.route('**/island-admin.js?*', route => route.fulfill({ path: path.join(root, 'web_controller/island-admin.js') }));
  await page.route('**/island-admin.css?*', route => route.fulfill({ path: path.join(root, 'web_controller/island-admin.css') }));
  await page.route('**/island-schedule.js?*', route => route.fulfill({ path: path.join(root, 'web_controller/island-schedule.js') }));
  await page.route('**/island-ribbon.js?*', route => route.fulfill({ path: path.join(root, 'web_controller/island-ribbon.js') }));
  await page.route('**/island-ribbon.css?*', route => route.fulfill({ path: path.join(root, 'web_controller/island-ribbon.css') }));
  await page.route('**/api/island/classes/*', route => {
    assert.equal(route.request().method(), 'GET', 'Regression checks never save to the demo server');
    return route.fulfill({ json: data });
  });
  await page.route('**/api/island/visibility', route => {
    assert.equal(route.request().method(), 'GET', 'School edits in this helper remain read-only');
    return route.fulfill({ json: data.schoolVisibility });
  });
  await page.goto(endpoint.href);
  await page.getByRole('button', { name: '教室浮岛', exact: true }).click();
  await page.locator('.island-week table').waitFor();
  return page;
}

test('Missing midday time has a setup entry in the weekly timetable', async t => {
  const page = await open(t, profile());
  const setup = page.getByRole('button', { name: '设置午间静校时段', exact: true });
  await setup.press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).press('Enter');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await setup.evaluate(node => node === document.activeElement), true, 'Cancel restores focus to the timetable entry');
});

test('Adding midday time once and editing its timetable time updates duty settings', async t => {
  const page = await open(t, profile());
  await page.getByRole('button', { name: '设置午间静校时段', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('午间时段', { exact: true }).selectOption('new');
  await dialog.getByLabel('开始时间', { exact: true }).fill('12:30');
  await dialog.getByLabel('结束时间', { exact: true }).fill('13:35');
  await dialog.getByRole('button', { name: '应用时段', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('tab', { name: '周课表', exact: true }).evaluate(node => node === document.activeElement), true,
    'The active tab receives focus when the setup entry is replaced by the new row');
  assert.match(await page.locator('.island-week tbody').innerText(), /午间静校[\s\S]*12:30-13:35/);
  await page.getByRole('tab', { name: '作息时间', exact: true }).click();
  await page.getByLabel('午间静校上课时间', { exact: true }).fill('12:35');
  await page.getByRole('tab', { name: '值班安排', exact: true }).click();
  assert.match(await page.locator('.island-duty-grid tbody').innerText(), /12:35-13:35/);
  await page.getByRole('switch', { name: '启用轮换', exact: true }).press('Space');
  assert.equal(await page.getByRole('switch', { name: '启用轮换', exact: true }).isChecked(), true);
});

test('An explicitly named midday slot appears in both timetable and duty settings', async t => {
  const data = profile();
  data.config.slots.splice(1, 0, { id: 'mid', label: '午间静校', start: 750, end: 815 });
  const page = await open(t, data);
  assert.match(await page.locator('.island-week tbody').innerText(), /午间静校[\s\S]*12:30-13:35/);
  await page.getByRole('tab', { name: '值班安排', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '选择作息时段', exact: true }).count(), 0,
    'The existing explicit midday slot is linked without entering its time twice');
  assert.match(await page.locator('.island-duty-grid tbody').innerText(), /12:30-13:35/);
});

test('Weekly duty cells show teachers and follow the independently selected cycle week', async t => {
  const data = profile(), config = data.config;
  config.slots.splice(1, 0, { id: 'mid', label: '午间静校', start: 750, end: 815 });
  Object.assign(config.dutyRotations.midday, { enabled: true, slotIds: ['mid'], lessons: [
    { slotId: 'mid', weekday: 1, cycleWeek: 1, subject: '午间静校', teacher: '午间教师', location: '' }
  ] });
  Object.assign(config.dutyRotations.evening, { enabled: true, lessons: [
    { slotId: 'e1', weekday: 1, cycleWeek: 1, subject: '数学', teacher: '晚间一周教师', location: '' },
    { slotId: 'e1', weekday: 1, cycleWeek: 2, subject: '物理', teacher: '晚间二周教师', location: '' }
  ] });
  const page = await open(t, data);
  assert.match(await page.locator('.island-week tbody').innerText(), /午间教师/);
  await page.getByLabel('晚自习轮换周次', { exact: true }).selectOption('2');
  const cells = await page.locator('.island-week tbody').innerText();
  assert.match(cells, /晚间二周教师/);
  assert.match(cells, /午间教师/);
  assert.equal(await page.locator('#islandSave').isDisabled(), true, 'Viewing a cycle week does not dirty the configuration');
  await page.getByRole('button', { name: /周一 晚自习第一节.*晚间二周教师/ }).click();
  assert.equal(await page.getByRole('tab', { name: '第 2 周', exact: true }).getAttribute('aria-selected'), 'true');
});

for (const scope of ['all', 'odd', 'even']) test(`Fixed ${scope} course keeps rotation off and remains editable`, async t => {
  const data = profile();
  data.config.lessons.push({ slotId: 'e1', weekday: 1, week: scope, subject: '晚自习', teacher: '原任课教师', location: '' });
  const page = await open(t, data);
  await page.getByRole('tab', { name: '值班安排', exact: true }).click();
  await page.getByRole('button', { name: '晚自习 3 周', exact: true }).click();
  await page.getByRole('switch', { name: '启用轮换', exact: true }).press('Space');
  assert.equal(await page.getByRole('switch', { name: '启用轮换', exact: true }).isChecked(), false);
  assert.equal(await page.locator('#islandSave').isDisabled(), true, 'Rejected enable must not change the saved-state indicator');
  await page.getByRole('button', { name: '查看固定课程', exact: true }).click();
  assert.match(await page.locator('.island-week tbody').innerText(), /原任课教师/);
  await page.getByRole('button', { name: /周一 晚自习第一节.*原任课教师/ }).click();
  assert.equal(await page.getByLabel('任课教师（选填）', { exact: true }).inputValue(), '原任课教师');
});

test('Rotation cannot turn on before its time is configured', async t => {
  const page = await open(t, profile());
  await page.getByRole('tab', { name: '值班安排', exact: true }).click();
  await page.getByRole('switch', { name: '启用轮换', exact: true }).click();
  assert.equal(await page.getByRole('switch', { name: '启用轮换', exact: true }).isChecked(), false);
  assert.equal(await page.locator('#islandSave').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '选择作息时段', exact: true }).isVisible(), true);
});

test('Changing viewed weeks and toggling rotation preserves teachers and empty weeks', async t => {
  const data = profile();
  Object.assign(data.config.dutyRotations.evening, { enabled: true, lessons: [
    { slotId: 'e1', weekday: 1, cycleWeek: 2, subject: '物理', teacher: '轮换教师', location: '' }
  ] });
  const page = await open(t, data);
  const cycle = () => page.getByLabel('晚自习轮换周次', { exact: true });
  await cycle().press('Home');
  await cycle().press('ArrowDown');
  assert.equal(await cycle().inputValue(), '2');
  assert.match(await page.locator('.island-week tbody').innerText(), /轮换教师/);
  assert.equal(await page.locator('#islandSave').isDisabled(), true);
  await page.getByRole('button', { name: /周一 晚自习第一节.*轮换教师/ }).click();
  await page.getByRole('switch', { name: '启用轮换', exact: true }).press('Space');
  await page.getByRole('switch', { name: '启用轮换', exact: true }).press('Space');
  await page.getByRole('tab', { name: '周课表', exact: true }).click();
  assert.match(await page.locator('.island-week tbody').innerText(), /轮换教师/);
  await cycle().selectOption('3');
  assert.equal(await page.getByRole('button', { name: /晚自习轮换第 3 周，未安排/ }).count(), 7);
  assert.doesNotMatch(await page.locator('.island-week tbody').innerText(), /轮换教师/);
});

test('Duty controls stay within desktop and narrow viewports with long teacher names', async t => {
  const data = profile();
  data.config.slots.push({ id: 'mid', label: '午间静校', start: 750, end: 815 });
  for (const kind of ['midday', 'evening']) Object.assign(data.config.dutyRotations[kind], {
    enabled: true, cycleWeeks: 3, slotIds: [kind === 'midday' ? 'mid' : 'e1'], lessons: [
      { slotId: kind === 'midday' ? 'mid' : 'e1', weekday: 1, cycleWeek: 1,
        subject: '值班', teacher: '浏览器测试使用的长教师姓名'.repeat(3), location: '多媒体教室' }
    ]
  });
  const page = await open(t, data);
  for (const width of [1440, 600, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole('tab', { name: '周课表', exact: true }).click();
    await page.getByLabel('午间静校轮换周次', { exact: true }).selectOption('1');
    await page.getByLabel('晚自习轮换周次', { exact: true }).selectOption('1');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${width}px timetable has no page overflow`);
    const bounds = await page.locator('.island-duty-filters select').evaluateAll(nodes => nodes.map(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })));
    assert.ok(bounds.every(rect => rect.left >= 0 && rect.right <= width), `${width}px cycle selectors stay reachable`);
    await page.getByRole('tab', { name: '值班安排', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${width}px duty settings have no page overflow`);
  }
});

test('Teacher chooses class quiet periods with keyboard and saves the actual selection', async t => {
  const data = profile();
  data.config.slots.push({ id: 'mid', label: '午间静校', start: 750, end: 815 });
  const page = await open(t, data);
  await page.getByRole('tab', { name: '提醒与外观', exact: true }).click();
  const follow = () => page.getByRole('switch', { name: /^跟随全校默认/ });
  const choices = () => page.getByRole('group', { name: '隐藏时段', exact: true });
  assert.equal(await follow().isChecked(), true);
  assert.equal(await choices().getByRole('checkbox', { name: /^第一节/ }).isChecked(), true);
  assert.equal(await choices().getByRole('checkbox', { name: /^晚自习第一节/ }).isDisabled(), true);
  assert.equal(await choices().getByRole('checkbox', { name: /^午间静校/ }).isChecked(), false);
  await follow().press('Space');
  assert.equal(await follow().evaluate(node => node === document.activeElement), true, 'Rerender restores keyboard focus');
  await choices().getByRole('checkbox', { name: /^第一节/ }).press('Space');
  await choices().getByRole('checkbox', { name: /^午间静校/ }).press('Space');
  let saved;
  await page.route('**/api/island/classes/*', route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      saved = body.config.visibility;
      data.config = body.config; data.revision++;
    }
    return route.fulfill({ json: data });
  });
  await page.locator('#islandSave').click();
  await page.locator('#islandDirty').filter({ hasText: '版本 5' }).waitFor();
  assert.deepEqual(saved, { followSchool: false, hiddenSlotIds: ['e1', 'mid'] });
  assert.equal(await follow().isChecked(), false);
});

test('Only school administrators see global defaults and editing them does not dirty a class', async t => {
  const data = profile(), page = await open(t, data);
  await page.getByRole('tab', { name: '提醒与外观', exact: true }).click();
  const school = page.getByRole('button', { name: '全校默认规则', exact: true });
  await school.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('switch', { name: /^白天课程期间隐藏/ }).press('Space');
  await dialog.getByRole('button', { name: '取消', exact: true }).press('Enter');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('#islandSave').isDisabled(), true, 'Cancelling school edits leaves the class clean');
  assert.equal(await school.evaluate(node => node === document.activeElement), true);
  await page.evaluate(() => { window.ICeClass.state.user.role = 'teacher'; });
  await page.getByRole('tab', { name: '周课表', exact: true }).click();
  await page.getByRole('tab', { name: '提醒与外观', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '全校默认规则', exact: true }).count(), 0);
  assert.equal(await page.getByRole('switch', { name: /^跟随全校默认/ }).isEnabled(), true);
});

test('Global save refreshes inherited class settings while keeping the global request distinct', async t => {
  const data = profile(), page = await open(t, data);
  await page.getByRole('tab', { name: '提醒与外观', exact: true }).click();
  await page.getByRole('button', { name: '全校默认规则', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('switch', { name: /^白天课程期间隐藏/ }).uncheck();
  let saved;
  await page.route('**/api/island/visibility', route => {
    saved = route.request().postDataJSON();
    data.schoolVisibility = { revision: 1, config: saved.config };
    data.revision++;
    return route.fulfill({ json: data.schoolVisibility });
  });
  await dialog.getByRole('button', { name: '保存全校默认', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.locator('#islandDirty').filter({ hasText: '版本 5' }).waitFor();
  assert.deepEqual(saved, { revision: 0, config: { hideDaytimeLessons: false, hideFirstEvening: true } });
  assert.equal(await page.getByRole('checkbox', { name: /^第一节/ }).isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: /^晚自习第一节/ }).isChecked(), true);
});

test('Quiet-period settings remain usable at desktop and narrow widths', async t => {
  const data = profile();
  data.config.slots[0].label = '第一节（含眼保健操及课堂活动）';
  const page = await open(t, data);
  await page.getByRole('tab', { name: '提醒与外观', exact: true }).click();
  for (const width of [1440, 600, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${width}px quiet periods do not overflow`);
    const bounds = await page.locator('.island-visibility-toolbar button, .island-visibility-slots label').evaluateAll(nodes => nodes.map(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })));
    assert.ok(bounds.every(rect => rect.left >= 0 && rect.right <= width), `${width}px choices remain reachable`);
  }
});

test('The ribbon shows an unassigned midday label and follows a newly entered subject', async t => {
  const data = profile();
  data.config.slots.splice(1, 0, { id: 'mid', label: '午间静校', start: 750, end: 815 });
  data.config.dutyRotations.midday.slotIds = ['mid'];
  const page = await open(t, data);
  await page.locator('#islandPreviewToggle').click();
  await page.locator('#islandPreviewClock > summary').click();
  await page.getByLabel('预览日期', { exact: true }).fill('2026-10-26');
  await page.getByLabel('预览时间', { exact: true }).fill('07:00');
  await page.locator('#islandPreviewClock > summary').click();
  await page.locator('#islandPreview .ir-course[title="午间静校 12:30-13:35"]').waitFor();
  assert.equal(await page.locator('#islandPreview .ir-course[title^="午间静校"] .ir-subject').innerText(), '午');
  assert.equal(await page.locator('#islandPreview .ir-course[title^="晚自习"] .ir-subject').innerText(), '晚');
  await page.getByRole('button', { name: /周一 午间静校.*添加课程/ }).click();
  await page.getByRole('dialog').getByLabel('科目', { exact: true }).fill('物理');
  await page.getByRole('dialog').getByRole('button', { name: '应用修改', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.locator('#islandPreview .ir-course[title="物理 12:30-13:35"]').waitFor();
  assert.equal(await page.locator('#islandPreview .ir-course[title$="12:30-13:35"]').count(), 1);
  assert.equal(await page.locator('#islandPreview .ir-course[title^="物理"] .ir-subject').innerText(), '物');
});

test('All twelve ribbon periods fit at narrow widths during class and break', async t => {
  const data = profile(), starts = [480, 530, 590, 640, 690, 840, 890, 940, 990, 1080, 1130];
  data.config.slots = starts.map((start, index) => ({ id: 'p' + index, label: '第' + (index + 1) + '节', start, end: start + 40 }));
  data.config.lessons = starts.map((_, index) => ({ slotId: 'p' + index, weekday: 1, week: 'all', subject: '数学' }));
  data.config.slots[0].id = data.config.lessons[0].slotId = 'morning-reading';
  data.config.slots[0].label = data.config.lessons[0].subject = '晨读';
  data.config.slots.push({ id: 'mid', label: '午间静校', start: 750, end: 815 });
  data.config.visibility = { followSchool: false, hiddenSlotIds: [] };
  const page = await open(t, data);
  await page.getByRole('tab', { name: '提醒与外观', exact: true }).click();
  await page.locator('#islandPreviewToggle').click();
  await page.locator('#islandPreviewClock > summary').click();
  await page.getByLabel('预览日期', { exact: true }).fill('2026-10-26');
  for (const width of [380, 560, 1000]) {
    await page.getByLabel('浮岛宽度（像素）', { exact: true }).fill(String(width));
    if (!await page.locator('#islandPreviewClock').evaluate(node => node.open))
      await page.locator('#islandPreviewClock > summary').click();
    for (const time of ['07:00', '10:38', '12:30', '20:00']) {
      await page.getByLabel('预览时间', { exact: true }).fill(time);
      const layout = await page.locator('#islandPreview').evaluate(root => {
        const courses = [...root.querySelectorAll('.ir-course')], bounds = root.getBoundingClientRect();
        return { count: courses.filter(node => !['课间休息', '课前准备'].some(name => node.title.startsWith(name))).length,
          fits: courses.every(node => { const box = node.getBoundingClientRect(); return box.left >= bounds.left - 1 && box.right <= bounds.right + 1; }),
          sizes: [...root.querySelectorAll('.ir-subject')].map(node => parseFloat(getComputedStyle(node.parentElement).fontSize)), height: bounds.height };
      });
      assert.equal(layout.count, 12, `${width}px ${time} retains all periods`);
      assert.equal(layout.fits, true, `${width}px ${time} has no clipped course`);
      assert.ok(layout.sizes.every(size => size >= 12), `${width}px ${time} keeps readable abbreviations`);
      assert.equal(layout.height, 48);
      const groups = await page.locator('#islandPreview .ir-courses').evaluate(root => {
        const courses = [...root.querySelectorAll('.ir-course')], midday = courses.find(node => node.title.startsWith('午间静校'));
        return { morning: courses[0].nextElementSibling?.classList.contains('ir-divider'),
          middayBefore: midday.previousElementSibling?.classList.contains('ir-divider'),
          middayAfter: midday.nextElementSibling?.classList.contains('ir-divider') };
      });
      assert.deepEqual(groups, { morning: true, middayBefore: true, middayAfter: true }, `${width}px ${time} keeps morning and midday dividers`);
    }
  }
});

'use strict';

const assert = require('node:assert/strict');
const {after, before, test} = require('node:test');
const {open, settingsSection, moveBanbanAside, launchWorkbenchBrowser} = require('./test-teacher-ui.cjs');
const {createSettingsFixture} = require('./test-account-settings.cjs');

let browser;
before(async () => { browser = await launchWorkbenchBrowser(); });
after(async () => { await browser?.close(); });

async function assertFits(page, stage) {
  const overflow = await page.locator('#banbanQuotaSection').evaluate(section => {
    const root = document.documentElement;
    const elements = [root, section, ...section.querySelectorAll(
      '.quota-tabs, .quota-tabs button, .list-toolbar, .default-rule, .default-value, ' +
      '.quota-overview, .usage, .remaining, .inline-editor, .list-footer, .save-strip'
    )];
    return elements.filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1)
      .map(el => [el.id || el.className || el.tagName, el.clientWidth, el.scrollWidth]);
  });
  assert.deepEqual(overflow, [], stage);
}

for (const width of [320, 390, 1280]) {
  test(`quota filters and adjustment forms fit and restore focus at ${width}px`, async t => {
    const fixture = createSettingsFixture();
    const {page, context, errors} = await open(browser, {width, handle:fixture.handle});
    t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
    await settingsSection(page, 'quota');
    await page.locator('#quotaWorkspace:enabled').waitFor();
    await assertFits(page, 'Loaded quota list');
    assert.equal(await page.locator('.quota-table-head').isVisible(), width === 1280);
    const label = page.locator('#quotaRows .quota-cell-label').first();
    assert.equal(await label.evaluate(el => getComputedStyle(el).position === 'static'), width < 1280);
    await moveBanbanAside(page);

    await page.locator('#quotaFilter').selectOption('custom');
    assert.equal(await page.locator('#quotaRows > li').count(), 1);
    await page.locator('#quotaFilter').selectOption('all');
    await page.locator('#quotaSearch').fill('教室白板 1');
    assert.equal(await page.locator('#quotaRows > li').count(), 1);

    const editDefault = page.locator('#editDefault');
    await editDefault.click();
    const editor = page.getByRole('form', {name:'调整默认月度规则'});
    const limit = editor.getByRole('spinbutton');
    await limit.fill('0');
    await limit.press('Enter');
    assert.equal(await limit.getAttribute('aria-invalid'), 'true');
    assert.equal(await limit.evaluate(el => el === document.activeElement), true);
    await assertFits(page, 'Default editor with a validation message');
    await editor.getByRole('button', {name:'取消', exact:true}).click();
    assert.equal(await editDefault.evaluate(el => el === document.activeElement), true);

    const adjust = page.getByRole('button', {name:'调整教室白板 1的次数', exact:true});
    await adjust.click();
    const rowEditor = page.getByRole('form', {name:'调整教室白板 1月度规则'});
    await rowEditor.getByRole('radio', {name:'设置上限', exact:true}).check();
    await rowEditor.getByRole('spinbutton').fill('1000000');
    await assertFits(page, 'Individual editor with a seven-digit limit');
    await rowEditor.getByRole('button', {name:'确定调整'}).click();
    assert.equal(await adjust.evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('#quotaSave').isEnabled(), true);
    await assertFits(page, 'Staged individual override and save actions');

    await page.locator('#quotaSearch').fill('');
    await editDefault.click();
    await limit.fill('1000000');
    await limit.press('Enter');
    assert.equal(await editDefault.evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('#defaultDirty').isVisible(), true);
    await assertFits(page, 'Seven-digit default, pending label and remaining counts');
    assert.deepEqual(fixture.writes, []);
  });
}

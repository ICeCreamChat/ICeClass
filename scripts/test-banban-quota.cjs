'use strict';
// Production settings and composer, using isolated API fixtures only.
const assert = require('node:assert/strict');
const {test, before, after} = require('node:test');
const {chromium} = require('playwright');
const {open, navigate, settingsSection, moveBanbanAside} = require('./test-teacher-ui.cjs');

let browser;
before(async () => { browser = await chromium.launch({channel:'msedge', headless:true}); });
after(async () => { await browser?.close(); });
function configuration() {
  return {revision:1, month:'2026-11', resetsAt:1796054400000, deviceLimit:20, accountLimit:30, overrides:[],
    targets:[{kind:'device', id:'d1', name:'一班白板', detail:'高一（1）班', enabled:1, used:5, limit:20, source:'default'},
      {kind:'account', id:'review-teacher', name:'测试教师', detail:'review', enabled:1, used:3, limit:30, source:'default'}]};
}
async function setup(t, options = {}) {
  let config = configuration();
  const writes = [];
  const result = await open(browser, {...options, handle:async context => {
    const {url, request} = context;
    if (url.pathname === '/api/banban/quotas') {
      if (request.method() === 'PUT') writes.push(request.postDataJSON());
      const answer = options.quotaHandler && await options.quotaHandler(context);
      if (answer) return answer;
      if (request.method() === 'PUT') {
        config = {...config, ...request.postDataJSON(), revision:config.revision + 1};
        config.targets = config.targets.map(target => {
          const override = config.overrides.find(row => row.kind === target.kind && row.id === target.id);
          return {...target, limit:override ? override.limit : config[target.kind + 'Limit'], source:override ? 'custom' : 'default'};
        });
      }
      return {json:config};
    }
    if (url.pathname === '/api/banban/conversation') return {json:{id:null, messages:[], scope:{}}};
    if (url.pathname === '/api/banban/context') return {json:{snapshot:{}, classes:[], schoolAnalysis:false,
      connection:{configured:false, enabled:false}, quota:{kind:'account', used:3, limit:30, remaining:27, month:'2026-11', resetsAt:1796054400000}}};
    return options.handle && options.handle(context);
  }});
  t.after(async () => { await result.context.close(); assert.deepEqual(result.errors, [], 'No browser script errors'); });
  return {...result, writes};
}
async function settings(page) {
  await settingsSection(page, 'quota');
  await page.locator('#quotaWorkspace:enabled').waitFor();
}
async function setDefault(page, value) {
  await page.locator('#editDefault').click();
  const editor = page.locator('#defaultEditor');
  await editor.getByRole('radio', {name:'设置上限',exact:true}).check();
  await editor.locator('input[type=number]').fill(String(value));
  await editor.getByRole('button',{name:'确定调整'}).click();
}
async function editTarget(page, name, mode, value) {
  await page.getByRole('button',{name:`调整${name}的次数`,exact:true}).click();
  const form = page.getByRole('form',{name:`调整${name}月度规则`,exact:true});
  await form.getByRole('radio',{name:mode,exact:true}).check();
  if (value !== undefined) await form.locator('input[type=number]').fill(String(value));
  await form.getByRole('button',{name:'确定调整'}).click();
}

test('superadmin quota settings load on demand and save defaults with individual overrides', async t => {
  const {page,requests,writes} = await setup(t);
  assert.equal(requests.filter(r => r.path === '/api/banban/quotas').length,0);
  await settings(page); assert.equal(await page.locator('#defaultValue').textContent(),'20');
  await moveBanbanAside(page);
  await setDefault(page,50); await editTarget(page,'一班白板','设置上限',8);
  await page.locator('#quotaSave').click(); await page.locator('#quotaStatus').filter({hasText:'已保存'}).waitFor();
  assert.deepEqual(writes,[{revision:1,deviceLimit:50,accountLimit:30,overrides:[{kind:'device',id:'d1',limit:8}]}]);
  assert.match(await page.locator('#quotaRows .usage-number').textContent(),/^5/);
  assert.equal(await page.locator('#quotaSave').isDisabled(),true);
});

test('account rules support unlimited and inherit again, retaining monthly use',async t => {
  const {page,writes} = await setup(t); await settings(page); await page.locator('#tab-account').click();
  await moveBanbanAside(page);
  await editTarget(page,'测试教师','不限次数'); await page.locator('#quotaSave').click();
  await page.locator('#quotaStatus').filter({hasText:'已保存'}).waitFor();
  assert.deepEqual(writes[0].overrides,[{kind:'account',id:'review-teacher',limit:null}]);
  await editTarget(page,'测试教师','沿用默认'); await page.locator('#quotaSave').click();
  await page.locator('#quotaSave:disabled').waitFor(); assert.deepEqual(writes[1].overrides,[]);
  assert.match(await page.locator('#quotaRows .usage-number').textContent(),/^3/);
});

test('save failure and version conflict preserve staged changes until deliberate reload',async t => {
  let failed = true;
  const {page} = await setup(t,{quotaHandler:({request}) => request.method() === 'PUT' && failed
    ? {status:409,json:{error:'次数设置已在其他页面修改，请重新载入后核对。'}} : undefined});
  await settings(page); await page.locator('#tab-account').click(); await setDefault(page,45);
  await moveBanbanAside(page);
  await page.locator('#quotaSave').click(); await page.locator('#quotaStatus[role=alert]').waitFor();
  assert.equal(await page.locator('#defaultValue').textContent(),'45'); assert.equal(await page.locator('#quotaSave').isDisabled(),true);
  failed = false; page.once('dialog',dialog => dialog.accept()); await page.locator('#quotaReload').click();
  await page.waitForFunction(() => document.getElementById('defaultValue').textContent === '30');
  await setDefault(page,45); await page.locator('#quotaSave').click(); await page.locator('#quotaStatus').filter({hasText:'已保存'}).waitFor();
});

for (const role of ['teacher','principal']) test(`${role} cannot see or load quota administration`,async t => {
  const {page,requests} = await setup(t,{role}); await navigate(page,'settings');
  assert.equal(await page.locator('#view-settings [data-section=quota]').isVisible(),false);
  await page.evaluate(() => window.ICeClassSettings.select('quota'));
  assert.equal(await page.locator('#banbanQuotaSection').isVisible(),false);
  assert.equal(requests.filter(r => r.path === '/api/banban/quotas').length,0);
});

test('declining logout preserves staged quota changes and the mounted Banban panel',async t => {
  const {page,requests} = await setup(t); await settings(page); await setDefault(page,55);
  page.once('dialog',dialog => dialog.dismiss()); await page.locator('#logoutButton').evaluate(button => button.click());
  assert.equal(await page.locator('#defaultValue').textContent(),'55'); assert.equal(await page.locator('#banbanRoot').count(),1);
  assert.equal(requests.filter(r => r.path === '/api/auth/logout').length,0);
});

test('large lists render one page and pending editors resume through tabs, searches and sections',async t => {
  const config = configuration(); config.targets = Array.from({length:125},(_,index) => ({...config.targets[0],id:'d'+index,name:'白板'+index}));
  const {page} = await setup(t,{quotaHandler:({request}) => request.method() === 'GET' ? {json:config} : undefined});
  await settings(page); assert.equal(await page.locator('#quotaRows > li').count(),5);
  await page.getByRole('button',{name:'调整白板0的次数',exact:true}).click();
  const form = page.getByRole('form',{name:'调整白板0月度规则'}); await form.getByRole('radio',{name:'设置上限',exact:true}).check();
  await form.locator('input[type=number]').fill('7'); await page.locator('#quotaNext').click();
  assert.equal(await page.locator('#quotaRows > li').count(),5);
  await page.locator('#quotaSearch').fill('白板124'); assert.equal(await page.locator('#quotaRows > li').count(),1);
  await page.locator('#tab-account').click(); await settingsSection(page,'account'); await settingsSection(page,'quota');
  assert.equal(await page.locator('#quotaSave').isDisabled(),true); await page.locator('#quotaResume').click();
  assert.equal(await page.getByRole('form',{name:'调整白板0月度规则'}).locator('input[type=number]').inputValue(),'7');
  assert.equal(await page.locator('#quotaSearch').inputValue(),'');
});

test('quota validation, keyboard tabs, draft cancellation and narrow layout remain usable',async t => {
  const {page} = await setup(t,{width:390}); await settings(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),true);
  await page.locator('#tab-device').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tab-account').evaluate(e => e === document.activeElement),true);
  await page.locator('#editDefault').click(); const editor = page.locator('#defaultEditor');
  await editor.locator('input[type=number]').fill('-1'); await editor.getByRole('button',{name:'确定调整'}).click();
  assert.equal(await editor.locator('input[aria-invalid=true]').count(),1);
  await editor.getByRole('button',{name:'取消',exact:true}).click(); assert.equal(await page.locator('#quotaSave').isDisabled(),true);
  assert.equal(await page.locator('#editDefault').evaluate(e => e === document.activeElement),true);
});

test('composer shows live remaining quota and exhaustion offers refresh without a blind retry', async t => {
  let refreshed = false;
  const quota = {kind:'account', used:30, limit:30, remaining:0, month:'2026-11', resetsAt:1796054400000};
  const {page} = await setup(t, {handle:({url}) => {
    if (url.pathname === '/api/banban/chat/stream') return {status:429, json:{code:'banban_quota_exhausted', error:'本月班班次数已用完，下月自动恢复，或请超级管理员调整上限。', quota}};
    if (url.pathname === '/api/banban/quota') { refreshed = true; return {json:{...quota, limit:40, remaining:10}}; }
  }});
  await page.locator('#bbLauncher').click();
  await page.locator('#bbQuota').filter({hasText:'27 / 30'}).waitFor();
  await page.locator('#bbInput').fill('你好'); await page.locator('#bbSend').click();
  await page.locator('#bbQuota').filter({hasText:'0 / 30'}).waitFor();
  assert.equal(await page.getByRole('button', {name:'重试这个问题', exact:true}).count(), 0);
  await page.locator('#bbQuotaRefresh').click();
  await page.locator('#bbQuota').filter({hasText:'10 / 40'}).waitFor();
  assert.equal(refreshed, true);
  assert.equal(await page.locator('#bbHistoryToggle').isEnabled(), true);
});

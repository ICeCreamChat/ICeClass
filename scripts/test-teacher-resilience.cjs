'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {test, before, after} = require('node:test');
const {chromium} = require('playwright');
const {open, navigate, settingsSection} = require('./test-teacher-ui.cjs');
const {createSettingsFixture} = require('./test-account-settings.cjs');
const {selfStudyFixture} = require('./measure-teacher-ui.cjs');
let browser;
before(async () => { browser = await chromium.launch({channel:'msedge',headless:true}); });
after(async () => { await browser?.close(); });
async function setup(t, options = {}) {
  const handle = options.handle;
  const result = await open(browser,{...options,handle:async args => {
    const answer=await handle?.(args);
    if(answer !== undefined)return answer;
    if(args.url.pathname === '/api/auth/logout')return {json:{ok:true}};
    return selfStudyFixture(args);
  }});
  t.after(async () => { await result.context.close(); assert.deepEqual(result.errors,[]); });
  return result;
}
async function editReading(page) {
  await page.waitForFunction(() => document.getElementById('readingThreshold').value === '30');
  await page.locator('.reading-settings > summary').click();
  await page.locator('#readingThreshold').fill('42');
}
async function logout(page) {
  await page.locator('#headerAccount').focus();
  await page.waitForTimeout(100);
  await page.locator('#headerAccount').press('ArrowDown');
  await page.locator('#logoutButton').click();
}

async function stagedStartup(t, width, gatePaths) {
  const context=await browser.newContext({viewport:{width,height:850},reducedMotion:'reduce'});
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const created=context.waitForEvent('page');
  const opening=open({newContext:async()=>context},{width,handle:async args=>{
    if(gatePaths.includes(args.url.pathname))await gate;
    return selfStudyFixture(args);
  }});
  t.after(async()=>{release();await opening.catch(()=>{});await context.close();});
  const page=await created;
  await page.locator('#appShell:not(.hidden)').waitFor();
  return {page,release,opening};
}

for(const width of [1280,390,320]) {
  test(`Class hydration keeps the page heading and permitted navigation in place at ${width}px`,async t=>{
    const {page,release,opening}=await stagedStartup(t,width,['/api/classes']);
    const positions=()=>page.evaluate(()=>['#view-reading','#mainNav [data-view="island"]'].map(selector=>{
      const node=document.querySelector(selector);return {top:node.getBoundingClientRect().top,visible:!!node.getClientRects().length};
    }));
    const before=await positions();
    release();const {errors}=await opening;
    const after=await positions();
    assert.ok(Math.abs(before[0].top-after[0].top)<=1,'The preview notice is present before the workbench is shown');
    if(before[1].visible)assert.ok(Math.abs(before[1].top-after[1].top)<=1,'Permitted navigation is stable before class data arrives');
    assert.deepEqual(errors,[]);
  });
  test(`Reading data hydration keeps summary and ranking positions stable at ${width}px`,async t=>{
    const {page,release,opening}=await stagedStartup(t,width,['/api/reading/report','/api/reading/settings']);
    await page.waitForFunction(()=>document.getElementById('headerAccountName').textContent.length>0);
    const positions=()=>page.evaluate(()=>({height:document.getElementById('readingOverview').getBoundingClientRect().height,
      ruleHeight:document.getElementById('readingRuleStatus').getBoundingClientRect().height,
      rankingTop:document.querySelector('.ranking-panel').getBoundingClientRect().top}));
    const before=await positions();
    release();const {errors}=await opening;
    await page.waitForFunction(()=>document.getElementById('readingRuleStatus').dataset.enabled==='true');
    const after=await positions();
    assert.ok(Math.abs(before.height-after.height)<=1,'Loading and loaded summaries use the same space');
    assert.ok(Math.abs(before.rankingTop-after.rankingTop)<=1,`Rule and summary hydration do not move the ranking: ${JSON.stringify({before,after})}`);
    assert.deepEqual(errors,[]);
  });
}

test('A stalled auxiliary startup request cannot hold account information or background refreshes',async t => {
  let release;
  const gate = new Promise(resolve => {release=resolve;});
  t.after(() => release());
  const {page} = await setup(t,{handle:async ({url}) => {
    if(url.pathname === '/api/devices') { await gate; return {json:{devices:[]}}; }
  }});
  await page.waitForTimeout(150);
  const state = await page.evaluate(() => ({account:document.getElementById('settingsAccount').textContent,
    timers:[ICeClass.state.presenceTimer,ICeClass.state.quietTimer,ICeClass.state.classroomVoiceTimer].map(Boolean)}));
  assert.match(state.account,/测试教师/);
  assert.deepEqual(state.timers,[true,true,true]);
});

test('A stalled read times out with feedback and a later explicit retry can succeed',async t => {
  let release, calls=0;
  const gate = new Promise(resolve => {release=resolve;});
  t.after(() => release());
  const {page} = await setup(t,{handle:async ({url}) => {
    if(url.pathname === '/api/audit-stalled-read') {
      if(++calls === 1) await gate;
      return {json:{ok:true}};
    }
  }});
  await page.clock.install();
  await page.evaluate(() => { window.readResult=null; void ICeClass.api('/api/audit-stalled-read').then(
    data => {window.readResult=data;},error => {window.readResult={error:error.message};}); });
  await page.waitForTimeout(50);
  await page.clock.fastForward(16000);
  await page.waitForTimeout(50);
  assert.match((await page.evaluate(() => window.readResult))?.error || '',/超时/);
  release();
  assert.deepEqual(await page.evaluate(() => ICeClass.api('/api/audit-stalled-read')),{ok:true});
});

test('A caller can still cancel a read without it becoming a timeout error',async t => {
  let release;
  const gate=new Promise(resolve => {release=resolve;});
  t.after(() => release());
  const {page}=await setup(t,{handle:async ({url}) => {
    if(url.pathname === '/api/audit-cancelled-read'){await gate;return {json:{ok:true}};}
  }});
  const result=await page.evaluate(async () => {
    const controller=new AbortController();
    const request=ICeClass.api('/api/audit-cancelled-read',{signal:controller.signal});
    controller.abort();
    try {await request;return 'unexpected-success';}catch(error){return error.name;}
  });
  assert.equal(result,'AbortError');
});

for(const width of [1280,390]) test(`Unsaved reading rules protect keyboard navigation and restore the saved draft at ${width}px`,async t => {
  const {page} = await setup(t,{width});
  await editReading(page);
  const beforeUnload = () => page.evaluate(() => {const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;});
  assert.equal(await beforeUnload(),true);
  if(await page.locator('#menuToggle').isVisible())await page.locator('#menuToggle').click();
  await page.locator('#mainNav [data-view="console"]').press('Enter');
  assert.equal(await page.locator('#reading-leave[open]').count(),1);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#readingThreshold').inputValue(),'42');
  assert.equal(await page.locator('#view-reading').isVisible(),true);
  if(await page.locator('#mainContent').evaluate(node => node.inert))await page.keyboard.press('Escape');
  if(await page.locator('#menuToggle').isVisible() && !await page.locator('body').evaluate(node => node.classList.contains('nav-open')))await page.locator('#menuToggle').click();
  await page.locator('#mainNav [data-view="console"]').press('Enter');
  const dialog=page.locator('#reading-leave');
  assert.ok(await dialog.evaluate(node => node.scrollWidth <= innerWidth));
  await dialog.getByRole('button',{name:'放弃修改',exact:true}).press('Enter');
  await page.locator('#view-console:not(.hidden)').waitFor();
  assert.equal(await beforeUnload(),false);
  await navigate(page,'reading');
  assert.equal(await page.locator('#readingThreshold').inputValue(),'30');
});

test('Logout waits for an explicit decision about unsaved reading rules',async t => {
  const {page,requests} = await setup(t);
  await editReading(page);
  await logout(page);
  assert.equal(await page.locator('#reading-leave[open]').count(),1);
  assert.equal(requests.filter(r => r.path === '/api/auth/logout').length,0);
  await page.locator('#reading-leave').getByRole('button',{name:'继续编辑',exact:true}).click();
  assert.equal(await page.locator('#readingThreshold').inputValue(),'42');
  assert.equal(await page.locator('#banbanRoot').count(),1,'Cancelling logout keeps the assistant mounted');
  await page.locator('#bbLauncher').click();
  assert.equal(await page.locator('#bbPanel').isVisible(),true,'The retained assistant still opens');
});

test('Cancelling logout from unsaved acknowledgements preserves both the draft and assistant',async t => {
  const fixture=createSettingsFixture();
  const {page,requests}=await setup(t,{handle:args=>fixture.handle(args)});
  await settingsSection(page,'thanks');
  const title=page.locator('#acknowledgementsFields input').first();
  await title.fill('取消退出后保留的内容');
  page.once('dialog',dialog=>dialog.dismiss());
  await logout(page);
  assert.equal(requests.filter(r=>r.path==='/api/auth/logout').length,0);
  assert.equal(await title.inputValue(),'取消退出后保留的内容');
  assert.equal(await page.locator('#banbanRoot').count(),1);
});

test('A failed logout preserves the signed-in page and draft, reports failure and supports retry',async t => {
  const fixture=createSettingsFixture();
  let attempts=0,signedOut=false;
  const {page}=await setup(t,{handle:async args=>{
    if(args.url.pathname==='/api/auth/logout'){
      if(++attempts===1)return {status:503,json:{error:'退出服务暂不可用，请重试。'}};
      signedOut=true;return {json:{ok:true}};
    }
    if(args.url.pathname==='/api/session'&&signedOut)return {json:{authenticated:false}};
    return fixture.handle(args);
  }});
  page.setDefaultTimeout(5000);
  await settingsSection(page,'thanks');
  await page.locator('#acknowledgementsFields input').first().fill('退出失败也保留的草稿');
  let navigations=0;page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++;});
  page.once('dialog',dialog=>dialog.accept());
  await logout(page);
  await page.locator('#toastRegion').getByText(/退出未完成/).waitFor();
  assert.equal(navigations,0);
  assert.equal(await page.locator('#appShell').isVisible(),true);
  assert.equal(await page.locator('#banbanRoot').count(),1);
  assert.equal(await page.locator('#acknowledgementsFields input').first().inputValue(),'退出失败也保留的草稿');
  assert.equal(await page.locator('#logoutButton').isDisabled(),false);
  page.once('dialog',dialog=>dialog.accept());
  await logout(page);
  await page.locator('#loginForm:not(.hidden)').waitFor();
  assert.equal(attempts,2);
  assert.equal(await page.locator('#banbanRoot').count(),0);
});

test('A lost logout response completes cleanup when the server confirms the session has ended',async t => {
  let signedOut=false;
  const {page}=await setup(t,{handle:({url})=>{
    if(url.pathname==='/api/auth/logout'){
      signedOut=true;return {status:503,json:{error:'退出响应未送达。'}};
    }
    if(url.pathname==='/api/session'&&signedOut)return {json:{authenticated:false}};
  }});
  await logout(page);
  await page.locator('#loginForm:not(.hidden)').waitFor();
  assert.equal(await page.locator('#banbanRoot').count(),0);
});

test('An in-flight logout rejects duplicate activation and keeps the assistant until success',async t => {
  let release,attempts=0,signedOut=false;
  const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const {page}=await setup(t,{handle:async({url})=>{
    if(url.pathname==='/api/auth/logout'){
      attempts++;await gate;signedOut=true;return {json:{ok:true}};
    }
    if(url.pathname==='/api/session'&&signedOut)return {json:{authenticated:false}};
  }});
  await logout(page);
  await page.waitForFunction(()=>document.getElementById('logoutButton').disabled);
  await page.locator('#logoutButton').dispatchEvent('click');
  assert.equal(attempts,1);
  assert.equal(await page.locator('#banbanRoot').count(),1);
  release();await page.locator('#loginForm:not(.hidden)').waitFor();
});

test('Save-and-continue retains reading edits after failure and retries the exact rules',async t => {
  let writes=0, saved;
  const {page} = await setup(t,{handle:({url,request}) => {
    if(url.pathname === '/api/reading/settings' && request.method() === 'PUT') {
      saved=request.postDataJSON();
      return ++writes === 1 ? {status:503,json:{error:'暂时不能保存，请重试。'}} : {json:{config:saved}};
    }
    if(url.pathname === '/api/reading/settings' && saved && writes > 1)return {json:{config:saved}};
  }});
  await editReading(page);
  await page.locator('#mainNav [data-view="console"]').click();
  const dialog=page.locator('#reading-leave');
  assert.equal(await dialog.isVisible(),true);
  await dialog.getByRole('button',{name:'保存并继续',exact:true}).click();
  await dialog.getByRole('alert').filter({hasText:'请重试'}).waitFor();
  assert.equal(await page.locator('#readingThreshold').inputValue(),'42');
  assert.equal(await page.locator('#view-reading').isVisible(),true);
  await dialog.getByRole('button',{name:'保存并继续',exact:true}).click();
  await page.locator('#view-console:not(.hidden)').waitFor();
  assert.equal(writes,2);
  assert.equal(saved.threshold,42);
});

test('The timetable editor loads on entry once and a failed script load can be retried',async t => {
  const {page,context} = await setup(t);
  const loaded = await page.evaluate(() => performance.getEntriesByType('resource').some(item => new URL(item.name).pathname === '/island-admin.js'));
  assert.equal(loaded,false,'An unopened timetable must not load its editor');
  let attempts=0;
  await context.route('**/island-admin.js?*',route => ++attempts === 1 ? route.fulfill({status:503,body:'Unavailable'})
    : route.fulfill({path:path.resolve(__dirname,'../web_controller/island-admin.js')}));
  await navigate(page,'island');
  await page.locator('.toast').filter({hasText:'重新进入'}).waitFor();
  await navigate(page,'reading');
  await navigate(page,'island');
  await page.locator('.island-week table').waitFor();
  await navigate(page,'reading');
  await navigate(page,'island');
  assert.equal(attempts,2);
});

test('The default mascot settles at rest and wakes for an interaction without a permanent draw loop',async t => {
  const {page} = await setup(t);
  await page.evaluate(() => {
    const root=document.createElement('div');root.innerHTML='<span class="bb-mascot" style="display:block;width:80px;height:100px"></span>';
    document.body.append(root);window.reviewRig=ICeClassBanbanRig(root);
    reviewRig.update({state:'idle',mood:'neutral',gesture:'',reduced:false,paused:false});
  });
  await page.waitForFunction(() => reviewRig.status().ready);
  await page.waitForTimeout(1200);
  const before=await page.evaluate(() => reviewRig.status());
  await page.waitForTimeout(400);
  const idle=await page.evaluate(() => reviewRig.status());
  assert.equal(idle.animating,false);
  assert.equal(idle.frames,before.frames,'Idle must retain the painted pose without continuous redraws');
  await page.evaluate(() => reviewRig.update({state:'thinking',pose:'think',mood:'thinking'}));
  await page.waitForTimeout(450);
  const active=await page.evaluate(() => reviewRig.status());
  assert.ok(active.frames > idle.frames + 5,'A real interaction continues to animate');
  await page.evaluate(() => reviewRig.update({state:'idle',pose:'',mood:'neutral'}));
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => reviewRig.status().animating),false);
  await page.evaluate(() => reviewRig.look(.6,-.2));
  await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => reviewRig.status().pose.gazeX > .1));
  await page.evaluate(() => reviewRig.dispose());
});

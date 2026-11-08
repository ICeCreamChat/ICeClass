'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', 'web_controller');
const origin = 'http://127.0.0.1';
let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });

function homework() {
  return { classId:'ui-test', className:'界面检查班', revision:1, date:'2026-11-07', serverDate:'2026-11-07', records:[],
    value:{ activeTermId:'term', students:[{id:'s1',name:'张三'}],
      terms:[{id:'term',label:'2026—2027 学年第一学期',subjects:[{id:'chinese',name:'语文',items:[{id:'book',name:'练习册',active:true}]}]}] } };
}

async function open(t, routePath, { native = false, width = 1280, height = 850 } = {}) {
  const context = await browser.newContext({ viewport:{width,height} });
  t.after(() => context.close());
  const errors = [], requests = [];
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'No browser script errors'));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'The review uses isolated local assets and fixture data');
    requests.push(url.pathname);
    if (url.pathname === '/api/homework/classroom') return route.fulfill({json:homework()});
    if (url.pathname === '/api/ideas/student/context') return route.fulfill({json:{classId:'ui-test',deviceId:'fixture-device',className:'界面检查班'}});
    if (url.pathname === '/api/ideas/student') return route.fulfill({json:{items:[{id:'idea-1',title:'给图书角添一本书',text:'可以分享自己喜欢的书。',status:'pending',version:1,canDelete:true,reply:'',name:'',createdAt:1793500000000,updatedAt:1793500000000,media:[]}],total:1,page:1,pageSize:20}});
    if (url.pathname === '/api/ideas/showcase') return route.fulfill({json:{items:[],total:0,page:1,pageSize:20}});
    assert.ok(!url.pathname.startsWith('/api/'), 'The review never sends real API writes');
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    assert.ok(file.startsWith(root + path.sep));
    return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:'Not found'});
  });
  if (native) await context.addInitScript(data => {
    window.ICeClassNativeHome = true;
    const listeners = [];
    window.__emitHome = data => listeners.forEach(listener => listener({data}));
    let selfStudyPaused=false;
    window.chrome ||= {};
    window.chrome.webview = {
      addEventListener(type, listener) { if (type === 'message') listeners.push(listener); },
      postMessage(message) {
        if(message.action==='self-study'&&message.operation==='pause')selfStudyPaused=true;
        const value=message.action==='self-study'?{
          state:selfStudyPaused?'paused':'observing',detail:selfStudyPaused?'本节已暂停，下次晚自习自动恢复':'正在观察，先提醒再上报',
          inPeriod:true,paused:selfStudyPaused,config:{dailyCalls:4},usage:{calls:1},
          serverTime:1794226200000,schedule:[{startAt:1794225600000,endAt:1794231000000}]
        }:message.action==='homework'?data:null;
        if (message.id) queueMicrotask(() => window.__emitHome({type:'response',id:message.id,value}));
      }
    };
  }, homework());
  await page.goto(origin + routePath);
  return {page,requests};
}

for(const width of [1280,720])test('Self-study entry and session pause work at '+width+'px',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true,width});
  await presentHome(page);
  await page.locator('[data-action="management"]').click();
  await page.getByRole('button',{name:'查看晚自习',exact:true}).click();
  await page.locator('#classroom-ss-state').filter({hasText:'正在观察'}).waitFor();
  assert.equal(await page.locator('#classroom-self-study-title').evaluate(e=>e.getBoundingClientRect().height<60),true,'Dialog title stays on a single line');
  if(process.env.ICECLASS_REVIEW_DIR)await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,'classroom-'+width+'.png'),fullPage:true});
  await page.getByRole('button',{name:'暂停本节',exact:true}).click();
  await page.locator('#classroom-ss-state').filter({hasText:'本节已暂停'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'暂停本节',exact:true}).isDisabled(),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button',{name:'查看晚自习',exact:true}).evaluate(e=>e===document.activeElement),true);
});

async function presentHome(page) {
  await page.evaluate(() => {
    window.__homeIsland = {date:'2026-11-07',scheduleKnown:true,
      lessons:[{name:'语文',start:'08:00',end:'08:40',current:true},{name:'数学',start:'08:50',end:'09:30',current:false}],
      notice:{sequence:1,sender:'班主任',category:'班级通知',text:'请准备课本',progress:1}};
    window.__emitHome({type:'home-state',state:{className:'界面检查班',deviceCaption:'隔离测试设备',connected:true,connectionText:'已连接平台',capabilities:{reading:true,plan:true,banban:true},voice:{recording:false,sending:false,duration:'最长 30 秒',status:''},island:window.__homeIsland}});
  });
  await page.locator('#home-view:not([hidden])').waitFor();
}

test('Home: an existing academic year label uses the short hyphen on home and management', async t => {
  const {page} = await open(t, '/homework/classroom/index.html', {native:true});
  await presentHome(page);
  await page.waitForFunction(() => document.querySelector('#page-subtitle').textContent.includes('学年'));
  assert.equal(await page.locator('#page-subtitle').textContent(),'2026-2027 学年第一学期');
  await page.locator('[data-action="management"]').click();
  assert.match(await page.locator('#page-subtitle').textContent(),/2026-2027 学年第一学期/);
});

test('Home: notification progress retains the existing timetable and calendar nodes', async t => {
  const {page} = await open(t, '/homework/classroom/index.html', {native:true});
  await presentHome(page);
  const result = await page.evaluate(async () => {
    const list = document.getElementById('lesson-list'), calendar = document.getElementById('calendar-date');
    const lesson = list.firstElementChild, date = calendar.firstChild;
    let changes = 0;
    const observer = new MutationObserver(records => { changes += records.length; });
    observer.observe(list, {subtree:true,childList:true,characterData:true});
    observer.observe(calendar, {subtree:true,childList:true,characterData:true});
    for (let i=0;i<30;i++) window.__emitHome({type:'island-state',state:{...window.__homeIsland,notice:{...window.__homeIsland.notice,progress:1-i/30}}});
    await new Promise(resolve => queueMicrotask(resolve)); observer.disconnect();
    return {changes,sameLesson:list.firstElementChild===lesson,sameDate:calendar.firstChild===date};
  });
  assert.deepEqual(result, {changes:0,sameLesson:true,sameDate:true});
  await page.evaluate(() => window.__emitHome({type:'island-state',state:{...window.__homeIsland,date:'2026-11-08',lessons:[{name:'英语',start:'09:00',end:'09:40',current:true}],notice:null}}));
  assert.match(await page.locator('#lesson-list').innerText(), /英语/);
  assert.match(await page.locator('#calendar-date').innerText(), /8/);
  assert.equal(await page.locator('#daily-course').isVisible(), true);
});

test('Home: unchanged voice state does not rewrite the live status or action labels', async t => {
  const {page} = await open(t, '/homework/classroom/index.html', {native:true});
  await presentHome(page);
  await page.locator('[data-action="voice"]').click();
  const changes = await page.evaluate(async () => {
    let changes = 0;
    const observer = new MutationObserver(records => { changes += records.length; });
    for (const selector of ['#voice-status','#voice-panel-status','[data-action="voice"]','[data-action="voice-toggle"]']) observer.observe(document.querySelector(selector),{subtree:true,childList:true,characterData:true});
    for (let i=0;i<20;i++) window.__emitHome({type:'voice-state',state:{recording:false,sending:false,duration:'最长 30 秒',status:''}});
    await new Promise(resolve => queueMicrotask(resolve)); observer.disconnect(); return changes;
  });
  assert.equal(changes, 0);
  await page.evaluate(() => window.__emitHome({type:'voice-state',state:{recording:true,sending:false,duration:'1.2 / 30.0 秒',status:'正在录音…'}}));
  assert.equal(await page.locator('[data-action="voice-toggle"]').textContent(),'结束并发送');
  assert.match(await page.locator('#voice-panel-time').textContent(), /1.2/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-action="voice"]').evaluate(element => element === document.activeElement),true);
});

test('Ideas: reselecting the current tab preserves expanded content and media nodes', async t => {
  const {page,requests} = await open(t, '/ideas/index.html?view=class');
  await page.locator('#classList article').waitFor();
  await page.locator('#classList summary').click();
  assert.equal(await page.locator('#classList details').getAttribute('open'),'');
  await page.evaluate(() => {
    window.__ideaArticle = document.querySelector('#classList article');
    window.__ideaArticle.dataset.reviewMarker='preserve';
  });
  const count = requests.filter(p => p==='/api/ideas/student').length;
  await page.locator('#tab-class').click();
  assert.equal(await page.locator('#classList article').evaluate(element => element===window.__ideaArticle),true);
  assert.equal(await page.locator('#classList details').getAttribute('open'),'');
  assert.equal(requests.filter(p => p==='/api/ideas/student').length,count);
  await page.locator('#tab-showcase').click();
  await page.locator('#showcaseListNotice').getByText('还没有发布成果。',{exact:false}).waitFor();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#tab-class').getAttribute('aria-selected'),'true');
});

test('Ideas: populated lists have no empty notice pane; loading, failure and retry remain visible', async t => {
  const {page} = await open(t, '/ideas/index.html?view=class');
  await page.locator('#classList article').waitFor();
  const notice = page.locator('#classListNotice');
  assert.equal(await notice.isVisible(),false);
  let release;
  const pending = new Promise(resolve => { release=resolve; });
  const route = /\/api\/ideas\/student\?/;
  await page.route(route, async request => { await pending; await request.fulfill({status:503,json:{error:'连接中断，请重新加载。'}}); });
  await page.locator('#refreshClass').click();
  assert.equal(await notice.isVisible(),true);
  assert.equal(await notice.textContent(),'正在加载…');
  release();
  await page.locator('#retryClass').waitFor();
  assert.match(await notice.textContent(),/连接中断/);
  await page.unroute(route);
  await page.locator('#retryClass').click();
  await page.waitForFunction(() => document.getElementById('classListNotice').hidden);
  await page.locator('#tab-showcase').click();
  await page.getByText('还没有发布成果。',{exact:false}).waitFor();
});

test('Ideas: handwriting review keeps a clear name-field focus in normal and high-contrast modes', async t => {
  const {page} = await open(t, '/ideas/index.html');
  await page.getByText('界面检查班',{exact:true}).waitFor();
  const canvas = await page.locator('#inkCanvas').boundingBox();
  await page.mouse.move(canvas.x+40,canvas.y+40); await page.mouse.down();
  await page.mouse.move(canvas.x+110,canvas.y+90,{steps:8}); await page.mouse.up();
  await page.locator('#submitIdea:not([disabled])').click();
  await page.locator('#signNamed').check();
  const name = page.locator('#ideaName');
  await name.focus();
  const outline = await name.evaluate(element => { const css=getComputedStyle(element);return {width:css.outlineWidth,color:css.outlineColor,shadow:css.boxShadow}; });
  assert.equal(outline.width,'1px');
  assert.equal(outline.color,'rgb(136, 188, 229)');
  assert.notEqual(outline.shadow,'none');
  await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
  assert.equal(await name.evaluate(element => getComputedStyle(element).outlineWidth),'2px');
  await name.fill('张三');
  await page.locator('#cancelSubmit').click();
  assert.equal(await page.locator('#inkCanvas').isVisible(),true);
});

test('Ideas: keyboard focus stays inside clipped summaries and Enter expands the entry', async t => {
  const {page} = await open(t, '/ideas/index.html?view=class');
  const summary=page.locator('#classList summary').first();
  await summary.waitFor();await page.keyboard.press('Tab');await summary.focus();
  const focus=await summary.evaluate(element=>{
    const css=getComputedStyle(element);
    return {visible:element.matches(':focus-visible'),width:css.outlineWidth,offset:parseFloat(css.outlineOffset)};
  });
  assert.equal(focus.visible,true);assert.equal(focus.width,'1px');
  assert.ok(focus.offset<=-1,'The outline sits inside the clipped entry');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#classList details').first().getAttribute('open'),'');
});

for (const width of [1280,720,390]) test(`Classroom and Ideas: ${width}px layout and settings keyboard path`, async t => {
  const {page} = await open(t, '/homework/classroom/index.html', {native:true,width});
  await presentHome(page);
  await page.locator('[data-action="settings"]').click();
  await page.getByRole('button',{name:'原版白色',exact:true}).click();
  assert.equal(await page.locator('body').getAttribute('data-material'),'white');
  await page.locator('#clear-setting').check();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#detail-dialog').evaluate(dialog => dialog.open),false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth),true);
  await page.goto(origin+'/ideas/index.html');
  await page.getByText('界面检查班',{exact:true}).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#tab-submit').focus(); await page.keyboard.press('End');
  assert.equal(await page.locator('#tab-showcase').getAttribute('aria-selected'),'true');
});

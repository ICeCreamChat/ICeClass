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

function selfStudyFixture(overrides = {}) {
  return {state:'observing',detail:'正在观察，先提醒再上报',inPeriod:true,paused:false,
    config:{enabled:true,authorized:true,aiEnabled:true,dailyCalls:4,sensitivity:'high',voiceTriggerMs:1200,
      observationSeconds:30,reminderWaitSeconds:180,confirmationsAfterReminder:2},usage:{calls:1},
    serverTime:1794226200000,schedule:[{startAt:1794225600000,endAt:1794231000000}],...overrides};
}

async function open(t, routePath, { native = false, width = 1280, height = 850, homeworkData = homework(), selfStudyData = selfStudyFixture(), appearance, reducedTransparency = false } = {}) {
  const context = await browser.newContext({ viewport:{width,height} });
  t.after(() => context.close());
  const errors = [], requests = [];
  const page = await context.newPage();
  if (appearance) await context.addInitScript(value => {if(!localStorage.getItem('iceclass.classroom.appearance'))localStorage.setItem('iceclass.classroom.appearance', JSON.stringify(value));}, appearance);
  if (reducedTransparency) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
  }
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'No browser script errors'));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'The review uses isolated local assets and fixture data');
    requests.push(url.pathname);
    if (url.pathname === '/api/homework/classroom') return route.fulfill({json:homeworkData});
    if (url.pathname === '/api/ideas/student/context') return route.fulfill({json:{classId:'ui-test',deviceId:'fixture-device',className:'界面检查班'}});
    if (url.pathname === '/api/ideas/student') return route.fulfill({json:{items:[{id:'idea-1',title:'给图书角添一本书',text:'可以分享自己喜欢的书。',status:'pending',version:1,canDelete:true,reply:'',name:'',createdAt:1793500000000,updatedAt:1793500000000,media:[]}],total:1,page:1,pageSize:20}});
    if (url.pathname === '/api/ideas/showcase') return route.fulfill({json:{items:[],total:0,page:1,pageSize:20}});
    assert.ok(!url.pathname.startsWith('/api/'), 'The review never sends real API writes');
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    assert.ok(file.startsWith(root + path.sep));
    return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:'Not found'});
  });
  if (native) await context.addInitScript(({data,study}) => {
    window.ICeClassNativeHome = true;
    const listeners = [];
    window.__emitHome = data => listeners.forEach(listener => listener({data}));
    window.__selfStudyData=study;
    window.chrome ||= {};
    window.chrome.webview = {
      addEventListener(type, listener) { if (type === 'message') listeners.push(listener); },
      postMessage(message) {
        if(message.type==='classroom-appearance')window.__lastAppearance=message.state;
        if(message.action==='self-study'&&window.__selfStudyError) {
          queueMicrotask(()=>window.__emitHome({type:'response',id:message.id,error:window.__selfStudyError}));return;
        }
        if(message.action==='self-study'&&message.operation==='pause')window.__selfStudyData={...window.__selfStudyData,state:'paused',detail:'本节已暂停，下次晚自习自动恢复',paused:true};
        const value=message.action==='self-study'?window.__selfStudyData:message.action==='homework'?data:null;
        if (message.id) queueMicrotask(() => window.__emitHome({type:'response',id:message.id,value}));
      }
    };
  }, {data:homeworkData,study:selfStudyData});
  await page.goto(origin + routePath);
  return {page,requests};
}

for(const [width,height] of [[1280,720],[1280,600],[1024,768],[720,850],[390,850]])test('Self-study entry and session pause work at '+width+'x'+height,async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true,width,height});
  await page.emulateMedia({reducedMotion:'reduce'});
  await presentHome(page);
  await page.locator('[data-action="management"]').click();
  await page.mouse.move(0,0);
  assert.equal(await page.evaluate(()=>scrollY),0,'Entering management starts at the top of the page');
  assert.deepEqual(await page.locator('#management-view h2').allTextContents(),['作业统计','自习管理']);
  await page.locator('.management-art img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
  const entryButtons=await page.locator('.management-footer button').evaluateAll(buttons=>buttons.map(button=>{
    const style=getComputedStyle(button);
    return {width:button.offsetWidth,height:button.offsetHeight,background:style.backgroundColor,color:style.color,radius:style.borderRadius,font:style.font};
  }));
  assert.deepEqual(entryButtons[0],entryButtons[1],'The two entries share the approved light appearance and size');
  assert.deepEqual(await page.locator('.management-footer button').allTextContents(),['登记作业','自习管理']);
  const cards=await page.locator('.management-panel').evaluateAll(elements=>elements.map(element=>{
    const rect=element.getBoundingClientRect();return {x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom};
  }));
  assert.ok(cards.every(card=>card.x>=0&&card.right<=width),'Both cards stay within the viewport');
  assert.equal(width>900?cards[0].y===cards[1].y:cards[1].y>=cards[0].bottom,true,'The cards switch between columns and stacked rows');
  if(width>900&&height>=700)assert.ok(cards.every(card=>card.bottom<height),'Both entries fit a desktop window');
  if(process.env.ICECLASS_REVIEW_DIR)await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,'management-'+width+'.png'),fullPage:true});
  await page.getByRole('button',{name:'登记作业',exact:true}).focus();
  await page.keyboard.press('Enter');
  await page.locator('#homework-dialog[open]').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#homework-dialog').evaluate(dialog=>dialog.open),false);
  await page.getByRole('button',{name:'自习管理',exact:true}).click();
  await page.locator('#classroom-ss-state').filter({hasText:'正在观察'}).waitFor();
  assert.equal(await page.locator('#classroom-self-study-title').evaluate(e=>e.getBoundingClientRect().height<60),true,'Dialog title stays on a single line');
  assert.equal(await page.locator('.study-rules').evaluate(e=>e.open),false,'Detailed rules start collapsed');
  assert.equal(await page.locator('.study-flow li').count(),4,'The process has four illustrated stages');
  assert.equal(await page.locator('.study-flow [aria-current="step"]').textContent(),'听声','Observing highlights the real sound stage');
  await page.locator('.study-art img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
  assert.equal(await page.locator('.study-art img').evaluate(image=>{
    const art=image.parentElement.getBoundingClientRect(),rect=image.getBoundingClientRect();
    return rect.left>=art.left&&rect.right<=art.right&&rect.top>=art.top&&rect.bottom<=art.bottom;
  }),true,'The self-study illustration stays within its reserved space');
  const compact = await page.locator('.self-study-dialog').evaluate(dialog=>{
    const rect=dialog.getBoundingClientRect(),footer=dialog.querySelector('.study-dialog-footer').getBoundingClientRect();
    return {width:rect.width,height:rect.height,bottom:rect.bottom,y:rect.y,footerBottom:footer.bottom,overflow:dialog.scrollWidth>dialog.clientWidth};
  });
  assert.ok(compact.width<=540&&compact.y>=0&&compact.bottom<=height&&compact.footerBottom<=compact.bottom,'The compact dialog and its controls fit the window');
  assert.equal(compact.overflow,false,'The illustrated dialog has no horizontal overflow');
  if(width===1280&&height===720)assert.ok(compact.height<560,'The default view stays short');
  if(process.env.ICECLASS_REVIEW_DIR)await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,`study-compact-${width}-${height}.png`)});
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('[data-ss-close]').evaluate(e=>e===document.activeElement),true,'The close control is first in the dialog keyboard path');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('.study-rules summary').evaluate(e=>e===document.activeElement),true,'Rule details are keyboard reachable');
  await page.keyboard.press('Enter');
  assert.match(await page.locator('#classroom-ss-rules').textContent(),/较高[\s\S]*1.2 秒[\s\S]*30 秒[\s\S]*至少 180 秒[\s\S]*2 次后通知老师/);
  assert.equal(await page.locator('.study-dialog-footer').evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight),true,'Footer remains visible when the rules are expanded');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.ICECLASS_REVIEW_DIR)await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,'classroom-'+width+'.png'),fullPage:true});
  await page.getByRole('button',{name:'暂停本次自习',exact:true}).click();
  await page.locator('#classroom-ss-state').filter({hasText:'本节已暂停'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'暂停本次自习',exact:true}).isDisabled(),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button',{name:'自习管理',exact:true}).evaluate(e=>e===document.activeElement),true);
  await page.getByRole('button',{name:'返回教室首页',exact:true}).click();
  assert.equal(await page.locator('#home-view').isVisible(),true);
  assert.equal(await page.locator('.class-heading img').count(),0,'No mascot is rendered in the page heading');
});

test('Self-study: inactive, running and paused stages remain truthful',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true,selfStudyData:selfStudyFixture({state:'inactive',detail:'班主任尚未启用自习管理',inPeriod:false})});
  await presentHome(page);
  await page.locator('[data-action="management"]').click();
  await page.getByRole('button',{name:'自习管理',exact:true}).click();
  await page.locator('#classroom-ss-detail').filter({hasText:'班主任尚未启用'}).waitFor();
  if(process.env.ICECLASS_REVIEW_DIR)await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,'study-inactive.png')});
  assert.equal(await page.locator('.study-flow [aria-current]').count(),0,'An inactive session never looks active');
  assert.equal(await page.locator('[data-ss-pause]').isDisabled(),true);
  for(const [state,stage] of [['listening','listening'],['analyzing','analyzing'],['warning','warning'],['reported','reported'],['ai_paused',null],['paused',null]]) {
    await page.evaluate(state=>{window.__selfStudyData={...window.__selfStudyData,state,detail:'状态来源：'+state,inPeriod:true,paused:state==='paused'};},state);
    await page.getByRole('button',{name:'重新载入自习状态',exact:true}).click();
    await page.locator('#classroom-ss-detail').filter({hasText:'状态来源：'+state}).waitFor();
    assert.deepEqual(await page.locator('.study-flow [aria-current="step"]').evaluateAll(items=>items.map(item=>item.dataset.ssStage)),stage?[stage]:[]);
    assert.equal(await page.locator('[data-ss-pause]').isDisabled(),state==='paused');
  }
});

test('Self-study: initial sync and failed refresh preserve honest feedback and recovery',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true,selfStudyData:selfStudyFixture({state:'inactive',detail:'尚未取得有效设置，等待联网同步',config:null,usage:null,schedule:[],inPeriod:false})});
  await presentHome(page);
  await page.locator('[data-action="management"]').click();
  await page.getByRole('button',{name:'自习管理',exact:true}).click();
  await page.locator('#classroom-ss-usage').filter({hasText:'暂无记录'}).waitFor();
  assert.equal(await page.locator('#classroom-ss-schedule').textContent(),'暂无安排');
  assert.equal(await page.locator('#classroom-ss-meter').isVisible(),false,'Missing usage is never displayed as zero');
  await page.getByText('规则待同步',{exact:true}).click();
  assert.equal(await page.getByText('等待规则同步',{exact:true}).isVisible(),true);
  assert.equal(await page.locator('#classroom-ss-rules').isVisible(),false,'Missing rules never show example thresholds');
  await page.evaluate(data=>{window.__selfStudyData=data;},selfStudyFixture());
  await page.locator('[data-ss-refresh]').click();
  await page.locator('#classroom-ss-usage').filter({hasText:'1 / 4 次'}).waitFor();
  assert.equal(await page.getByRole('meter',{name:'今日复核'}).getAttribute('value'),'1');
  await page.evaluate(()=>{window.__selfStudyError='网络未连接，请重试。';});
  await page.locator('[data-ss-refresh]').click();
  await page.getByRole('alert').filter({hasText:'网络未连接，请重试。'}).waitFor();
  assert.equal(await page.locator('#classroom-ss-usage').textContent(),'1 / 4 次','A failed refresh retains the last synchronized usage');
  assert.equal(await page.locator('[data-ss-pause]').isDisabled(),true,'A failed refresh does not enable a stale pause action');
  await page.evaluate(()=>{window.__selfStudyError=null;});
  await page.locator('[data-ss-refresh]').click();
  assert.equal(await page.locator('#classroom-ss-error').isVisible(),false);
  assert.equal(await page.locator('[data-ss-pause]').isEnabled(),true);
  await page.setViewportSize({width:390,height:600});
  await page.evaluate(()=>{document.body.dataset.material='white';});
  if(process.env.ICECLASS_REVIEW_DIR)await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,'study-white-narrow.png')});
  await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
  await page.locator('.study-rules summary').focus();
  assert.equal(await page.locator('.study-rules summary').evaluate(e=>parseFloat(getComputedStyle(e).outlineWidth)>0),true,'Keyboard focus remains visible in high contrast');
  assert.equal(await page.locator('.study-dialog-footer').evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight),true,'Short narrow windows keep the controls visible');
  if(process.env.ICECLASS_REVIEW_DIR)await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,'study-high-contrast.png')});
});

function registrationFixture(count = 12) {
  const fixture = homework();
  const names = ['张三','李四','王五','赵六','陈晨','刘洋','周宁','吴欣','郑宇','孙悦','何安','林秋'];
  fixture.value.students = Array.from({length:count}, (_,i) => ({id:'s'+(i+1),name:names[i%names.length]+(i>=names.length?i+1:'')}));
  fixture.value.terms[0].subjects[0].items.push({id:'practice',name:'课后练习',active:true});
  fixture.value.terms[0].subjects.push({id:'math',name:'数学',items:[{id:'problems',name:'习题',active:true}]});
  return fixture;
}

async function registration(t, fixture = registrationFixture(), viewport = {}) {
  const {page} = await open(t, '/homework/classroom/index.html', {native:true,homeworkData:fixture,...viewport});
  page.setDefaultTimeout(5000);
  await page.emulateMedia({reducedMotion:'reduce'});
  await presentHome(page);
  await page.locator('[data-action="management"]').click();
  await page.getByRole('button',{name:'登记作业',exact:true}).click();
  await page.locator('#homework-dialog[open]').waitFor();
  return page;
}

for (const [width,height,count] of [[1280,720,12],[1280,600,48],[720,850,12],[390,850,12]]) test(`Homework: approved compact fields and roster at ${width}x${height}`, async t => {
  const page = await registration(t, registrationFixture(count), {width,height});
  const modal = page.locator('#homework-dialog');
  if (process.env.ICECLASS_REVIEW_DIR) await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,`secondary-homework-${width}-${height}.png`)});
  assert.equal(await modal.getByRole('heading',{name:'登记今日作业',exact:true}).isVisible(),true);
  assert.equal(await modal.getByLabel('学科',{exact:true}).inputValue(),'chinese');
  assert.equal(await modal.getByLabel('作业',{exact:true}).inputValue(),'book');
  assert.equal(await modal.getByLabel('日期',{exact:true}).inputValue(),'2026-11-07');
  assert.equal(await modal.getByRole('checkbox').count(),count);
  const geometry = await modal.evaluate(dialog => {
    const rect = dialog.getBoundingClientRect();
    const footer = dialog.querySelector('.homework-bottom').getBoundingClientRect();
    const fields = [...dialog.querySelectorAll('.homework-field')].map(el => ({x:el.offsetLeft,y:el.offsetTop}));
    const roster = dialog.querySelector('.roster-scroll');
    return {x:rect.x,y:rect.y,width:rect.width,bottom:rect.bottom,height:rect.height,footerBottom:footer.bottom,fields,rosterHeight:roster.clientHeight,scrollHeight:roster.scrollHeight,overflow:dialog.scrollWidth>dialog.clientWidth,columns:getComputedStyle(dialog.querySelector('.student-grid')).gridTemplateColumns.split(' ').length};
  });
  assert.ok(geometry.width<=840&&geometry.x>=0&&geometry.y>=0&&geometry.bottom<=height,'The dialog follows the sample width and fits the window');
  assert.ok(geometry.footerBottom<=geometry.bottom,'Save and cancel remain visible');
  assert.equal(geometry.overflow,false,'The dialog has no horizontal overflow');
  assert.equal(geometry.fields[0].y,geometry.fields[1].y,'Subject and assignment sit together above the roster');
  assert.equal(width>560?geometry.fields[2].y===geometry.fields[0].y:geometry.fields[2].y>geometry.fields[0].y,true,'Date shares the top row on desktop and wraps on narrow screens');
  assert.equal(geometry.columns,width>560?4:2);
  assert.ok(geometry.rosterHeight>0,'The roster remains usable in short windows');
  if (count===48) assert.ok(geometry.scrollHeight>geometry.rosterHeight,'Long rosters scroll within the dialog');
  if (width===1280&&height===720) assert.ok(geometry.height<650,'A short roster does not create a full-height modal');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(await modal.getByLabel('学科',{exact:true}).evaluate(el=>el===document.activeElement),true,'Native selects are in the keyboard focus path');
});

test('Homework: switching fields guards unsaved work; saves retain revisions and failures retain the selection', async t => {
  const fixture = registrationFixture();
  const page = await registration(t, fixture);
  await page.evaluate(fixture => {
    const original = window.chrome.webview.postMessage;
    window.__homeworkWrites = []; window.__failHomeworkSave = false;
    window.chrome.webview.postMessage = message => {
      if (message.action!=='homework') return original(message);
      if (message.path==='/records') {
        window.__homeworkWrites.push(message.body);
        const result = window.__failHomeworkSave ? {error:'记录已变化，请重新载入后再试。'} : {value:{record:{...message.body,revision:message.body.revision+1,students:fixture.value.students}}};
        queueMicrotask(()=>window.__emitHome({type:'response',id:message.id,...result}));
      } else if (message.path?.startsWith('?date=')) {
        const date = new URLSearchParams(message.path.slice(1)).get('date');
        queueMicrotask(()=>window.__emitHome({type:'response',id:message.id,value:{...fixture,date}}));
      } else original(message);
    };
  },fixture);
  const student = page.locator('[data-student="s1"]');
  await student.uncheck();
  await page.locator('#homework-subject').selectOption('math');
  await page.locator('#confirm-dialog[open]').waitFor();
  await page.getByRole('button',{name:'继续填写',exact:true}).click();
  assert.equal(await page.locator('#homework-subject').inputValue(),'chinese');
  assert.equal(await student.isChecked(),false,'Canceling a field switch keeps the draft');
  await page.locator('#homework-item').selectOption('practice');
  await page.getByRole('button',{name:'放弃修改',exact:true}).click();
  assert.equal(await page.locator('#homework-item').inputValue(),'practice');
  assert.equal(await student.isChecked(),true);
  await student.uncheck();
  await page.getByRole('button',{name:'保存登记',exact:true}).click();
  await page.locator('#unsaved-label').filter({hasText:'已保存'}).waitFor();
  assert.equal(await page.locator('#record-summary').textContent(),'已登记 1 项');
  const saved = await page.evaluate(()=>window.__homeworkWrites[0]);
  assert.equal(saved.subjectId,'chinese'); assert.equal(saved.itemId,'practice');
  assert.equal(saved.profileRevision,1); assert.equal(saved.revision,0); assert.equal(saved.date,'2026-11-07');
  assert.deepEqual(saved.missing,['s1']);
  await student.check();
  await page.getByRole('button',{name:'保存登记',exact:true}).click();
  await page.locator('#unsaved-label').filter({hasText:'已保存'}).waitFor();
  assert.equal(await page.evaluate(()=>window.__homeworkWrites[1].revision),1,'An existing record sends its latest revision');
  await page.locator('#homework-date').fill('2026-11-06');
  await page.locator('#homework-date').dispatchEvent('change');
  await page.locator('#homework-title').filter({hasText:'登记作业'}).waitFor();
  await student.uncheck();
  await page.evaluate(()=>{window.__failHomeworkSave=true;});
  await page.getByRole('button',{name:'保存登记',exact:true}).click();
  await page.locator('#entry-feedback').filter({hasText:'记录已变化'}).waitFor();
  assert.equal(await student.isChecked(),false,'A failed save keeps the missing-student selection');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.locator('#confirm-dialog[open]').waitFor();
  await page.getByRole('button',{name:'继续填写',exact:true}).click();
  assert.equal(await page.locator('#homework-dialog').evaluate(dialog=>dialog.open),true);
});

test('Homework: empty setup stays compact, names remain searchable and no-homework confirmation reaches the bridge', async t => {
  const empty = registrationFixture(0); empty.value.terms[0].subjects[0].items=[];
  const page = await registration(t, empty);
  assert.match(await page.locator('#empty-roster').textContent(),/暂无作业项目/);
  assert.equal(await page.getByRole('button',{name:'保存登记',exact:true}).isDisabled(),true);
  assert.equal(await page.locator('#homework-item').isDisabled(),true);
  const emptyHeight = (await page.locator('#homework-dialog').boundingBox()).height;
  if (process.env.ICECLASS_REVIEW_DIR) await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,'secondary-homework-empty.png')});
  await page.keyboard.press('Escape');
  const populated = await registration(t);
  assert.ok(emptyHeight<(await populated.locator('#homework-dialog').boundingBox()).height,'The dialog shrinks with an empty setup instead of keeping a full roster pane');
  await populated.locator('#student-search').fill('zhang');
  assert.equal(await populated.locator('#student-grid .student-tile').count(),1);
  assert.equal(await populated.locator('#student-grid .student-tile').textContent(),'张三');
  await populated.locator('#student-search').fill('');
  await populated.evaluate(()=>{
    const original=window.chrome.webview.postMessage;
    window.chrome.webview.postMessage=message=>{
      if(message.action!=='homework'||message.path!=='/records')return original(message);
      window.__noHomeworkSave=message.body;
      const students=[...document.querySelectorAll('[data-student]')].map(el=>({id:el.dataset.student,name:el.parentElement.textContent}));
      queueMicrotask(()=>window.__emitHome({type:'response',id:message.id,value:{record:{...message.body,revision:1,students}}}));
    };
  });
  await populated.getByRole('button',{name:'本次无作业',exact:true}).click();
  await populated.getByRole('button',{name:'确认无作业',exact:true}).click();
  await populated.locator('#none-message').waitFor();
  assert.equal(await populated.evaluate(()=>window.__noHomeworkSave.status),'no_homework');
  assert.deepEqual(await populated.evaluate(()=>window.__noHomeworkSave.missing),[]);
  await populated.getByRole('button',{name:'恢复正常登记',exact:true}).first().click();
  assert.equal(await populated.locator('#student-grid').isVisible(),true);
});

test('Management: refreshed records update the summary and a failed refresh preserves the loaded state',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true});
  await presentHome(page);
  await page.locator('[data-action="management"]').click();
  assert.equal(await page.locator('#class-context').textContent(),'1 位同学');
  assert.equal(await page.locator('#subject-count').textContent(),'1 科');
  assert.equal(await page.locator('#record-summary').textContent(),'待登记');
  const updated=homework();
  updated.value.terms[0].subjects[0].items.push({id:'practice',name:'课后练习',active:true});
  updated.records=[{itemId:'book',status:'submitted',revision:1,missing:[],students:updated.value.students},{itemId:'practice',status:'no_homework',revision:1,missing:[],students:updated.value.students}];
  await page.evaluate(fixture=>{
    const original=window.chrome.webview.postMessage;
    window.__refreshError=false;
    window.chrome.webview.postMessage=message=>{
      if(message.action!=='homework')return original(message);
      queueMicrotask(()=>window.__emitHome({type:'response',id:message.id,...(window.__refreshError?{error:'连接中断，请重新载入。'}:{value:fixture})}));
    };
  },updated);
  await page.getByRole('button',{name:'重新载入作业数据',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#record-summary').textContent==='已登记 1 项 · 无作业 1 项');
  await page.evaluate(()=>{window.__refreshError=true;});
  await page.getByRole('button',{name:'重新载入作业数据',exact:true}).click();
  await page.locator('#page-feedback').filter({hasText:'连接中断'}).waitFor();
  assert.equal(await page.locator('#record-summary').textContent(),'已登记 1 项 · 无作业 1 项');
  assert.equal(await page.getByRole('button',{name:'重新载入作业数据',exact:true}).isEnabled(),true);
  assert.equal(await page.getByRole('button',{name:'登记作业',exact:true}).isEnabled(),true);
});

async function presentHome(page, island = {}) {
  await page.evaluate(island => {
    window.__homeIsland = {date:'2026-11-07',scheduleKnown:true,
      lessons:[{name:'语文',start:'08:00',end:'08:40',current:true},{name:'数学',start:'08:50',end:'09:30',current:false}],
      notice:{sequence:1,sender:'班主任',category:'班级通知',text:'请准备课本',progress:1},...island};
    window.__emitHome({type:'home-state',state:{className:'界面检查班',deviceCaption:'隔离测试设备',connected:true,connectionText:'已连接平台',capabilities:{reading:true,plan:true,banban:true},voice:{recording:false,sending:false,duration:'最长 30 秒',status:''},island:window.__homeIsland}});
  }, island);
  await page.locator('#home-view:not([hidden])').waitFor();
}

async function assertLightweightGlass(page) {
  assert.equal(await page.locator('.classroom-filter-definitions filter').count(),0);
  assert.equal(await page.locator('.module-card .glass-lens').first().evaluate(e=>getComputedStyle(e).backdropFilter),'none');
}

test('Home: lightweight glass keeps dynamic dialogs free of backdrop filters',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true});await presentHome(page);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.classroom-filter-definitions filter').count(),0,'Classroom glass allocates no displacement maps');
  const activeFilters=()=>page.locator('.glass-lens,.lg-lens').evaluateAll(nodes=>nodes.filter(e=>{
    const style=getComputedStyle(e);return style.backdropFilter!=='none'||style.filter!=='none';
  }).length);
  assert.equal(await activeFilters(),0,'The home surface needs no per-frame backdrop processing');
  await page.getByRole('button',{name:'教室设置',exact:true}).click();
  assert.equal(await activeFilters(),0,'Opening dynamic content keeps the same lightweight material');
  await page.getByRole('button',{name:'原版白色',exact:true}).click();
  await page.getByRole('button',{name:'液态玻璃',exact:true}).click();
  assert.equal(await page.locator('.classroom-filter-definitions filter').count(),0);
  assert.equal(await activeFilters(),0);
});

test('Home: choosing liquid glass clears an old reduced-transparency setting immediately',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true,appearance:{material:'glass',reduceTransparency:true}});
  await presentHome(page);
  await page.getByRole('button',{name:'教室设置',exact:true}).click();
  assert.equal(await page.locator('#clear-setting').isChecked(),true);
  await page.getByRole('button',{name:'液态玻璃',exact:true}).click();
  assert.equal(await page.locator('#clear-setting').isChecked(),false,'The selected material and transparency control agree');
  await assertLightweightGlass(page);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('iceclass.classroom.appearance'))),{material:'glass',reduceTransparency:false});
  assert.deepEqual(await page.evaluate(()=>window.__lastAppearance),{material:'glass',effective:'glass',source:'classroom',systemReducedTransparency:false,forcedColors:false});
  await page.reload();await presentHome(page);
  await assertLightweightGlass(page);
});

test('Home: system transparency is respected until a user explicitly chooses liquid glass',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true,reducedTransparency:true});await presentHome(page);
  assert.equal(await page.locator('.module-card .glass-lens').first().evaluate(e=>getComputedStyle(e).backdropFilter),'none');
  await page.getByRole('button',{name:'教室设置',exact:true}).click();
  assert.equal(await page.locator('#clear-setting').isChecked(),true,'The control reflects the effective system preference');
  await page.getByRole('button',{name:'液态玻璃',exact:true}).click();
  await assertLightweightGlass(page);
  assert.notEqual(await page.locator('.module-card').first().evaluate(e=>getComputedStyle(e,'::before').backgroundImage),'none');
  await page.locator('#clear-setting').check();
  await page.waitForFunction(()=>document.querySelectorAll('.classroom-filter-definitions filter').length===0);
  await page.locator('#clear-setting').uncheck();
  await assertLightweightGlass(page);
  await page.getByRole('button',{name:'原版白色',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.classroom-filter-definitions filter').length===0);
});

test('Home: system transparency changes update the open settings without saving a classroom override',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true});await presentHome(page);
  await page.getByRole('button',{name:'教室设置',exact:true}).click();
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
  await page.waitForFunction(()=>window.__lastAppearance?.effective==='reduced');
  assert.equal(await page.locator('#clear-setting').isChecked(),true);
  await page.waitForFunction(()=>document.querySelectorAll('.classroom-filter-definitions filter').length===0);
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'no-preference'}]});
  await page.waitForFunction(()=>window.__lastAppearance?.effective==='glass');
  assert.equal(await page.locator('#clear-setting').isChecked(),false);
  await assertLightweightGlass(page);
  assert.equal(await page.evaluate(()=>localStorage.getItem('iceclass.classroom.appearance')),null);
});

test('Home: explicit liquid glass preserves reduced motion and forced colors',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true,appearance:{material:'glass',reduceTransparency:false}});
  await presentHome(page);await page.emulateMedia({reducedMotion:'reduce'});
  await assertLightweightGlass(page);
  assert.equal(await page.locator('.module-card').first().evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
  await page.emulateMedia({reducedMotion:'reduce',forcedColors:'active'});
  await page.waitForFunction(()=>window.__lastAppearance?.effective==='contrast');
  await page.waitForFunction(()=>document.querySelectorAll('.classroom-filter-definitions filter').length===0);
  await page.emulateMedia({reducedMotion:'reduce',forcedColors:'none'});
  await assertLightweightGlass(page);
});

test('Home: the native diagnostic snapshot reports actual filters and accessibility changes without classroom content',async t=>{
  const source=fs.readFileSync(path.join(root,'..','Receiver','StudentVoiceWindow.cs'),'utf8');
  const script=source.match(/core\.ExecuteScriptAsync\("""\s*([\s\S]*?)\s*"""\)/)?.[1];
  assert.ok(script,'Exercise the same diagnostic script used by the native report');
  const {page}=await open(t,'/homework/classroom/index.html',{native:true});await presentHome(page);
  await assertLightweightGlass(page);
  const glass=await page.evaluate(script);
  assert.match(glass,/教室玻璃快照：渲染=轻量静态；材料=glass/);
  assert.match(glass,/定义=0/);
  assert.match(glass,/实际 backdrop-filter=none/);
  assert.ok(!glass.includes('界面检查班')&&!glass.includes('张三'),'The snapshot contains rendering facts, never classroom content');
  await page.getByRole('button',{name:'教室设置',exact:true}).click();await page.locator('#clear-setting').check();
  await page.waitForFunction(()=>document.querySelectorAll('.classroom-filter-definitions filter').length===0);
  const reduced=await page.evaluate(script);
  assert.match(reduced,/透明度=reduced；降低透明度类=true/);
  assert.match(reduced,/定义=0/);
  assert.match(reduced,/实际 backdrop-filter=none/);
  await page.emulateMedia({forcedColors:'active'});
  assert.match(await page.evaluate(script),/强制颜色=true/);
});

for(const width of [1280,390])test('Home: compact schedule keeps complete time ranges and both materials at '+width+'px',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true,width});await presentHome(page);
  await page.evaluate(()=>window.__emitHome({type:'island-state',state:{...window.__homeIsland,notice:null}}));
  assert.match(await page.locator('#lesson-list').innerText(),/08:00-08:40/);
  assert.equal(await page.locator('.day-lesson[aria-current="true"]').count(),1);
  assert.equal(await page.locator('.lesson-state').count(),0,'The current course uses its background without a visible status label');
  assert.equal(await page.locator('.timetable-capsule').evaluate(e=>e.getBoundingClientRect().height),82);
  await page.evaluate(()=>window.__emitHome({type:'island-state',state:{...window.__homeIsland,notice:null,lessons:[{name:'自主学习与长课程名称的完整显示检查',start:'20:00',end:'21:30',current:true},...Array.from({length:10},(_,i)=>({name:'课程'+i,start:'08:00',end:'08:40',current:false}))]}}));
  assert.ok(await page.locator('.schedule-scroll').evaluate(e=>e.scrollWidth>e.clientWidth),'A full timetable scrolls internally');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.ok(await page.locator('.day-lesson[aria-current="true"] strong').evaluate(e=>{const a=e.getBoundingClientRect(),b=e.closest('.day-lesson').getBoundingClientRect();return a.right<=b.right&&a.left>=b.left;}),'Long course names remain inside their lesson');
  if(process.env.ICECLASS_REVIEW_DIR)await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,`classroom-ribbon-${width}-glass.png`)});
  await page.getByRole('button',{name:'教室设置',exact:true}).click();
  await page.getByRole('button',{name:'原版白色',exact:true}).click();await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelectorAll('.classroom-filter-definitions filter').length===0);
  if(process.env.ICECLASS_REVIEW_DIR)await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,`classroom-ribbon-${width}-white.png`)});
});

test('Home: changing only a course end time updates the ribbon',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true});await presentHome(page);
  await page.evaluate(()=>window.__emitHome({type:'island-state',state:{...window.__homeIsland,notice:null,lessons:window.__homeIsland.lessons.map((lesson,i)=>({...lesson,end:i===0?'08:45':lesson.end}))}}));
  assert.match(await page.locator('#lesson-list').innerText(),/08:00-08:45/);
});

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
  assert.equal(await page.locator('#calendar-day').isVisible(), true, 'The date remains visible alongside a notification');
  await page.evaluate(() => window.__emitHome({type:'island-state',state:{...window.__homeIsland,date:'2026-11-08',lessons:[{name:'英语',start:'09:00',end:'09:40',current:true}],notice:null}}));
  assert.match(await page.locator('#lesson-list').innerText(), /英语/);
  assert.match(await page.locator('#calendar-date').innerText(), /8/);
  assert.equal(await page.locator('#daily-course').isVisible(), true);
});

function fullDay() {
  return {date:'2026-11-09',scheduleKnown:true,notice:null,lessons:[
    ['物理','07:55','08:40'],['化学','08:50','09:35'],['语文','10:05','10:50'],['数学','11:00','11:45'],
    ['语文','12:30','13:35'],['英语','14:00','14:45'],['体育','14:55','15:40'],['生物','15:50','16:35'],
    ['班会','16:45','17:30'],['化学','18:20','19:50'],['化学','20:00','21:30']
  ].map(([name,start,end],index)=>({name,start,end,current:index===5,next:index===6}))};
}

async function assertFollowed(page, selector) {
  await page.waitForFunction(selector => {
    const lesson=document.querySelector(selector),viewport=document.querySelector('.schedule-scroll');
    if(!lesson||!viewport.clientWidth)return false;
    const view=viewport.getBoundingClientRect(),rect=lesson.getBoundingClientRect();
    return rect.left>=view.left-1&&rect.right<=view.left+viewport.clientWidth+1;
  },selector);
}

async function assertScheduleFits(page) {
  assert.equal(await page.evaluate(() => {
    const viewport=document.querySelector('.schedule-scroll'),view=viewport.getBoundingClientRect();
    const fits = element => {
      const range=document.createRange();range.selectNodeContents(element);
      const text=range.getBoundingClientRect(),box=element.closest('.day-lesson').getBoundingClientRect();
      return text.left>=box.left-1&&text.right<=box.right+1&&text.top>=box.top-1&&text.bottom<=box.bottom+1
        &&text.top>=view.top-1&&text.bottom<=view.top+viewport.clientHeight+1;
    };
    const date=document.querySelector('.date-capsule').getBoundingClientRect(),timetable=document.querySelector('.timetable-capsule').getBoundingClientRect();
    return document.documentElement.scrollWidth<=innerWidth
      &&[...document.querySelectorAll('.day-lesson strong,.day-lesson small')].every(fits)
      &&date.right<timetable.left&&date.top===timetable.top
      &&date.height===82&&timetable.height===82;
  }),true,'The date stays fixed beside a flat timetable with complete text and no page overflow');
}

for(const width of [1365,1280,1024,901,720,390]) test(`Home: ${width}px full-day schedule preserves content and reveals the current lesson`, async t => {
  const {page}=await open(t,'/homework/classroom/index.html',{native:true,width,height:980});
  const island=fullDay();await presentHome(page,island);
  assert.deepEqual(await page.locator('.period-header img').evaluateAll(images=>images.map(image=>image.alt)),['上午','中午','下午','晚上']);
  assert.equal(await page.locator('.day-lesson').count(),11);
  assert.deepEqual(await page.locator('.day-lesson small').allTextContents(),island.lessons.map(lesson=>`${lesson.start}-${lesson.end}`));
  assert.equal(await page.locator('.day-lesson[aria-current="true"] strong').textContent(),'英语');
  await page.waitForFunction(()=>[...document.querySelectorAll('.period-header img')].every(image=>image.complete&&image.naturalWidth>0));
  await assertScheduleFits(page);
  await assertFollowed(page,'.day-lesson[aria-current="true"]');
  await page.locator('[data-action="settings"]').click();
  await page.getByRole('button',{name:'原版白色',exact:true}).click();
  await page.locator('#clear-setting').check();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-action="settings"]').evaluate(element=>element===document.activeElement&&getComputedStyle(element).outlineWidth==='1px'),true);
  await assertScheduleFits(page);
  await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
  assert.equal(await page.locator('[data-action="settings"]').evaluate(element=>getComputedStyle(element).outlineWidth),'2px');
  assert.equal(await page.locator('.day-lesson[aria-current="true"]').evaluate(element=>getComputedStyle(element).outlineWidth),'1px');
});

test('Home: timetable follows current lessons, previews the next lesson during breaks and restores after notifications',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true,width:720,height:980});
  await page.emulateMedia({reducedMotion:'reduce'});
  const full=fullDay(),at=(current,next)=>({...full,lessons:full.lessons.map((lesson,index)=>({...lesson,current:index===current,next:index===next}))});
  await presentHome(page,at(10,-1));
  const viewport=page.locator('.schedule-scroll');
  await assertFollowed(page,'.day-lesson[aria-current="true"]');
  assert.ok(await viewport.evaluate(element=>element.scrollLeft>0));
  const date=await page.locator('.date-capsule').boundingBox();
  await page.evaluate(state=>window.__emitHome({type:'island-state',state}),at(-1,4));
  await assertFollowed(page,'.day-lesson[data-next]');
  assert.equal(await page.locator('[data-next] strong').textContent(),'语文');
  assert.equal(await page.locator('[aria-current="true"]').count(),0);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(state=>window.__emitHome({type:'island-state',state}),at(-1,9));
  await assertFollowed(page,'.day-lesson[data-next]');
  assert.equal(await page.locator('[data-next] small').textContent(),'18:20-19:50','A next-only state change moves the preview');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(state=>window.__emitHome({type:'island-state',state}),at(0,10));
  await assertFollowed(page,'.day-lesson[aria-current="true"]');
  assert.equal(await viewport.evaluate(element=>element.scrollLeft),0,'The current lesson takes priority over the next lesson');
  const notice={sequence:2,sender:'班主任',category:'班级通知',text:'请准备课本',progress:1};
  await page.evaluate(state=>window.__emitHome({type:'island-state',state}),{...at(9,10),notice});
  assert.equal(await page.locator('#daily-course').isVisible(),false);
  assert.equal(await page.locator('#calendar-day').isVisible(),true);
  await page.evaluate(state=>window.__emitHome({type:'island-state',state}),at(9,10));
  await assertFollowed(page,'.day-lesson[aria-current="true"]');
  await page.evaluate(state=>window.__emitHome({type:'island-state',state}),at(-1,-1));
  await assertFollowed(page,'.period-block:last-child .day-lesson:last-child');
  assert.deepEqual(await page.locator('.date-capsule').boundingBox(),date);
  await page.setViewportSize({width:1920,height:980});
  await page.waitForFunction(()=>document.querySelector('.schedule-scroll').scrollLeft===0);
  await assertScheduleFits(page);
  await page.setViewportSize({width:390,height:980});
  await assertFollowed(page,'.period-block:last-child .day-lesson:last-child');
  await page.evaluate(state=>window.__emitHome({type:'island-state',state}),{...at(0,1),date:'2026-11-10'});
  await assertFollowed(page,'.day-lesson[aria-current="true"]');
  assert.equal(await page.locator('#calendar-day').getAttribute('datetime'),'2026-11-10');
});

test('Home: timetable can be dragged from its lower edge and keeps the chosen position until the lesson changes',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true,width:720,height:980});
  await page.emulateMedia({reducedMotion:'reduce'});
  const full=fullDay();await presentHome(page,full);
  await assertFollowed(page,'.day-lesson[aria-current="true"]');
  const viewport=page.locator('.schedule-scroll'),box=await viewport.boundingBox(),left=await viewport.evaluate(element=>element.scrollLeft);
  const date=await page.locator('.date-capsule').boundingBox();
  await page.mouse.move(box.x+24,box.y+65);
  await page.mouse.down();
  await page.mouse.move(box.x+184,box.y+65,{steps:5});
  await page.mouse.up();
  const moved=await viewport.evaluate(element=>element.scrollLeft);
  assert.ok(moved<left-100,'Dragging the empty lower edge reveals earlier lessons');
  await page.evaluate(state=>window.__emitHome({type:'island-state',state}),{...full,lessons:full.lessons.map((lesson,index)=>({...lesson,next:index===7}))});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await viewport.evaluate(element=>element.scrollLeft),moved,'An unrelated next-lesson update must not pull the user back');
  assert.deepEqual(await page.locator('.date-capsule').boundingBox(),date);
  assert.equal(await viewport.evaluate(element=>window.getSelection().toString()),'');
  await page.evaluate(state=>window.__emitHome({type:'island-state',state}),{...full,lessons:full.lessons.map((lesson,index)=>({...lesson,current:false,next:index===9}))});
  await assertFollowed(page,'.day-lesson[data-next]');
  await assertScheduleFits(page);
});

test('Home: timetable hides the scrollbar while supporting keyboard and horizontal wheel browsing',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true,width:720,height:980});
  await page.emulateMedia({reducedMotion:'reduce'});
  await presentHome(page,fullDay());
  await assertFollowed(page,'.day-lesson[aria-current="true"]');
  const viewport=page.locator('.schedule-scroll');
  assert.equal(await viewport.getAttribute('tabindex'),'0');
  assert.equal(await viewport.evaluate(element=>getComputedStyle(element).scrollbarWidth),'none');
  await viewport.focus();
  await page.keyboard.press('Home');
  await page.waitForFunction(()=>document.querySelector('.schedule-scroll').scrollLeft===0);
  await page.keyboard.press('ArrowRight');
  assert.ok(await viewport.evaluate(element=>element.scrollLeft>0));
  await page.keyboard.press('End');
  await page.waitForFunction(()=>{const element=document.querySelector('.schedule-scroll');return Math.abs(element.scrollLeft+element.clientWidth-element.scrollWidth)<1;});
  const end=await viewport.evaluate(element=>element.scrollLeft);
  await viewport.hover();
  await page.mouse.wheel(-220,0);
  await page.waitForFunction(end=>document.querySelector('.schedule-scroll').scrollLeft<end-100,end);
  await page.setViewportSize({width:1920,height:980});
  await page.waitForFunction(()=>document.querySelector('.schedule-scroll').tabIndex===-1);
  await assertScheduleFits(page);
});

test('Home: touch swipes browse the timetable and automatic following resumes at the next class',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true,width:720,height:980});
  await page.emulateMedia({reducedMotion:'reduce'});
  const full=fullDay();await presentHome(page,full);
  await assertFollowed(page,'.day-lesson[aria-current="true"]');
  const viewport=page.locator('.schedule-scroll'),box=await viewport.boundingBox(),left=await viewport.evaluate(element=>element.scrollLeft);
  const touch=await page.context().newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  const touchX=box.x+box.width-24,touchY=box.y+24;
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:touchX,y:touchY}]});
  for(const delta of [30,70,110,150])await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touchX-delta,y:touchY}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await touch.send('Emulation.setTouchEmulationEnabled',{enabled:false});
  await touch.detach();
  await page.waitForFunction(left=>document.querySelector('.schedule-scroll').scrollLeft>left+60,left);
  await page.evaluate(state=>window.__emitHome({type:'island-state',state}),{...full,lessons:full.lessons.map((lesson,index)=>({...lesson,current:index===0,next:index===1}))});
  await assertFollowed(page,'.day-lesson[aria-current="true"]');
  await assertScheduleFits(page);
});

test('Home: period boundaries, end-time changes and current-course transitions follow live state',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true});
  const island={...fullDay(),lessons:[
    {name:'上午末课',start:'11:59',end:'12:00',current:true},
    {name:'午间课程',start:'12:00',end:'13:00',current:false},
    {name:'下午课程',start:'14:00',end:'14:45',current:false},
    {name:'晚间课程',start:'18:00',end:'18:45',current:false}
  ]};
  await presentHome(page,island);
  for(const [index,label] of ['上午','中午','下午','晚上'].entries()){
    const period=page.getByRole('region',{name:label,exact:true});
    assert.equal(await period.locator('.day-lesson strong').textContent(),island.lessons[index].name);
  }
  const updated={...island,date:'2026-11-10',lessons:island.lessons.map((lesson,index)=>({...lesson,current:index===2,...(index===2?{end:'14:55'}:{})}))};
  await page.evaluate(state=>window.__emitHome({type:'island-state',state}),updated);
  assert.equal(await page.locator('#calendar-day').getAttribute('datetime'),'2026-11-10');
  assert.equal(await page.locator('.day-lesson[aria-current="true"] strong').textContent(),'下午课程');
  assert.equal(await page.locator('.day-lesson[aria-current="true"] small').textContent(),'14:00-14:55');
  assert.doesNotMatch(await page.locator('#lesson-list').textContent(),/正在上课/);
  assert.equal(await page.locator('.day-lesson.is-current').count(),1);
  assert.equal(await page.locator('.day-lesson[aria-current="true"]').getAttribute('aria-label'),'下午课程，正在上课，14:00-14:55');
  assert.equal(await page.evaluate(()=>{
    const previous=document.querySelector('.day-lesson'),current=document.querySelector('.day-lesson[aria-current="true"]');
    return getComputedStyle(previous.querySelector('strong')).color!==getComputedStyle(current.querySelector('strong')).color
      &&getComputedStyle(previous.querySelector('small')).color!==getComputedStyle(current.querySelector('small')).color;
  }),true,'The live course changes color without adding visible status text');
  assert.equal(await page.locator('.day-lesson').first().locator('time').first().getAttribute('datetime'),'2026-11-10T11:59:00+08:00');
});

test('Home: unsynced, empty and partially populated schedules recover without blank groups',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true});
  await presentHome(page,{...fullDay(),scheduleKnown:false,lessons:[]});
  assert.equal(await page.locator('.schedule-empty').textContent(),'课表同步后显示全天课程');
  await page.evaluate(()=>window.__emitHome({type:'island-state',state:{...window.__homeIsland,scheduleKnown:true}}));
  assert.equal(await page.locator('.schedule-empty').textContent(),'今天没有课程');
  await page.evaluate(()=>window.__emitHome({type:'island-state',state:{...window.__homeIsland,scheduleKnown:true,lessons:[{name:'<临时调课>',start:'18:20',end:'19:50',current:false}]}}));
  assert.equal(await page.locator('.period-block').count(),1);
  assert.equal(await page.getByRole('heading',{name:'晚上',exact:true}).count(),1);
  assert.equal(await page.locator('.day-lesson strong').textContent(),'<临时调课>');
  await assertScheduleFits(page);
});

test('Home: dense schedules and long subject names remain reachable within the flat timetable',async t=>{
  const {page}=await open(t,'/homework/classroom/index.html',{native:true,width:1024});
  const time=minute=>`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
  const lessons=[420,720,840,1080].flatMap((start,period)=>Array.from({length:8},(_,index)=>({
    name:index===0?'综合实践活动课程与跨学科研究项目':'自习',
    start:time(start+index*(period===1?10:30)),end:time(start+(index+1)*(period===1?10:30)),current:false
  })));
  await presentHome(page,{...fullDay(),lessons});
  assert.equal(await page.locator('.day-lesson').count(),32);
  await assertScheduleFits(page);
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

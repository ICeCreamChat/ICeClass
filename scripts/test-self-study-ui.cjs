'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fixturePhoto = require('node:fs').readFileSync(path.join(__dirname,'..','branding','banban','thinking.jpg'));
const {test,before,after} = require('node:test');
const {chromium} = require('playwright');
const {open,navigate} = require('./test-teacher-ui.cjs');
let browser;
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();});
const snapshot = () => ({revision:1,config:{enabled:false,authorized:false,aiEnabled:false,photoEnabled:true,dailyCalls:4,dailyTokens:2400,
  sensitivity:'balanced',voiceTriggerMs:600,observationSeconds:10,reminderWaitSeconds:90,confirmationsAfterReminder:1},
  schedule:[{key:'monday',title:'晚自习第二节',startAt:1794225600000,endAt:1794231000000}],usage:{calls:0,tokens:0},
  serverTime:1794226200000,aiReady:true,status:null});
async function review(page,name) {
  if(!process.env.ICECLASS_REVIEW_DIR)return;
  await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});
  await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,name),fullPage:true});
}
async function setup(t,{width=1280,saveStatus=200,photo=false,photoValid=true,photoAgeMs=0,clock=false,runtime={}}={}) {
  const writes=[],reviews=[];
  const media={photo_status:'ready',present:true,serverTime:1794226200000,handled_at:0,resolution:''};
  const result=await open(browser,{width,handle:async({url,request})=>{
    if(url.pathname==='/api/self-study/classes')return {json:{classes:[{id:'c1',name:'高一（1）班'},{id:'c2',name:'高二（1）班'}]}};
    if(/^\/api\/self-study\/classes\//.test(url.pathname)){
      if(request.method()==='PUT'){
        writes.push(request.postDataJSON());
        return saveStatus===200?{json:{...snapshot(),revision:2,config:request.postDataJSON().config}}
          :{status:saveStatus,json:{error:saveStatus===409?'设置已被其他人修改，请重新载入。':'保存失败，请稍后重试。'}};
      }
      return {json:{...snapshot(),...runtime}};
    }
    if(url.pathname==='/api/self-study/events')return {json:{events:photo&&media.present?[{id:'event1',class_id:'c1',class_name:'高一（1）班',started_at:1794226200000,reported_at:1794226200000,status:'reported',photo_status:media.photo_status,photo_at:1794226200000-photoAgeMs,handled_at:media.handled_at,resolution:media.resolution}]:[],pending:photo&&media.present&&!media.handled_at?1:0,serverTime:media.serverTime}};
    if(url.pathname==='/api/self-study/events/event1/review'&&request.method()==='POST'){
      const review=request.postDataJSON();reviews.push(review);media.handled_at=media.serverTime;media.resolution=review.resolution;
      return {json:{ok:true}};
    }
    if(url.pathname==='/api/self-study/events/event1/photo')return {contentType:'image/jpeg',body:photoValid?fixturePhoto:Buffer.from('/9j/2Q==','base64')};
  }});
  t.after(async()=>{await result.context.close();assert.deepEqual(result.errors,[]);});
  if(clock){
    await result.page.clock.install({time:new Date(1794226200000)});
    await result.page.clock.pauseAt(new Date(1794226201000));
  }
  await navigate(result.page,'self-study');
  await result.page.locator('#ss-class').waitFor();
  return {...result,writes,reviews,media};
}
test('Failed saves preserve the draft and show an actionable error',async t=>{
  const {page,writes}=await setup(t,{saveStatus:503});
  await page.getByLabel('已完成学校告知与授权').check();
  await page.getByLabel('启用自习管理',{exact:true}).check();
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.locator('#ss-feedback').filter({hasText:'保存失败'}).waitFor();
  assert.equal(await page.getByLabel('启用自习管理',{exact:true}).isChecked(),true);
  assert.equal(writes.length,1);
  await review(page,'teacher-desktop.png');
});

test('Visible rules and keyboard sensitivity save exact units from the page header',async t=>{
  const {page,writes}=await setup(t);
  assert.equal(await page.getByRole('heading',{name:'自习管理',exact:true}).count(),1);
  assert.deepEqual(await page.locator('#selfStudyRoot details').evaluateAll(nodes=>nodes.map(node=>node.open)),[false]);
  assert.equal(await page.locator('#ss-trigger').isVisible(),true);
  await page.getByRole('radio',{name:'标准',exact:true}).focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('radio',{name:'较高',exact:true}).isChecked(),true);
  await page.getByLabel('进入观察前持续（秒）',{exact:true}).fill('1.2');
  await page.getByLabel('AI 复核前积累（秒）',{exact:true}).fill('30');
  await page.getByLabel('提醒后至少等待（秒）',{exact:true}).fill('180');
  await page.getByLabel('提醒后再确认（次）',{exact:true}).fill('2');
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.locator('#ss-feedback').filter({hasText:'设置已保存'}).waitFor();
  assert.deepEqual(writes[0].config,{...snapshot().config,sensitivity:'high',voiceTriggerMs:1200,
    observationSeconds:30,reminderWaitSeconds:180,confirmationsAfterReminder:2});
  assert.equal(await page.locator('#ss-dirty').textContent(),'设置已保存');
  await review(page,'teacher-rules-desktop.png');
});

test('Invalid hidden budget opens its section and prevents a save',async t=>{
  const {page,writes}=await setup(t);
  await page.locator('#ss-budget summary').click();
  await page.locator('#ss-calls').fill('5');
  await page.locator('#ss-budget summary').click();
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  assert.equal(writes.length,0);
  assert.equal(await page.locator('#ss-budget').evaluate(node=>node.open),true);
  assert.equal(await page.locator('#ss-calls').evaluate(node=>node===document.activeElement),true);
});

test('Unsaved rules survive status polling and warn when the call limit cannot finish notification',async t=>{
  const data=snapshot();
  const runtime={config:{...data.config,enabled:true},status:{state:'observing',detail:'正在观察，先提醒再上报',updated_at:data.serverTime}};
  const {page,writes}=await setup(t,{width:390,runtime});
  assert.equal(await page.locator('#ss-detail').isVisible(),false,'Normal status is not repeated as extra prose');
  assert.match(await page.locator('#ss-next-period').textContent(),/本节/);
  await page.locator('#ss-confirmations').fill('3');
  await page.locator('#ss-budget summary').click();
  await page.locator('#ss-calls').fill('2');
  assert.match(await page.locator('#ss-budget-caption').textContent(),/不足/);
  assert.match(await page.locator('#ss-budget-note').textContent(),/不足以完成/);
  runtime.usage={calls:1,tokens:120};
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(()=>document.querySelector('#ss-usage-calls').textContent==='1 / 4 次');
  assert.equal(await page.locator('#ss-confirmations').inputValue(),'3');
  assert.equal(await page.locator('#ss-calls').inputValue(),'2');
  assert.equal(await page.locator('#ss-budget').evaluate(node=>node.open),true);
  assert.equal(writes.length,0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await review(page,'teacher-rules-mobile.png');
});

test('Synced revisions preserve expanded secondary settings and keyboard focus',async t=>{
  const runtime={};
  const {page}=await setup(t,{runtime});
  await page.locator('#ss-budget summary').click();
  await page.locator('#ss-observation').focus();
  runtime.revision=2;
  runtime.config={...snapshot().config,sensitivity:'low',observationSeconds:20};
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(()=>document.querySelector('#ss-observation').value==='20');
  assert.equal(await page.locator('#ss-budget').evaluate(node=>node.open),true);
  assert.equal(await page.locator('#ss-observation').evaluate(node=>node===document.activeElement),true);
  assert.equal(await page.getByRole('radio',{name:'较低',exact:true}).isChecked(),true);
  assert.equal(await page.locator('#ss-dirty').textContent(),'设置已保存');
});
test('Conflicts retain changes and require an explicit reload',async t=>{
  const {page}=await setup(t,{saveStatus:409});
  await page.getByLabel('已完成学校告知与授权').check();
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.locator('#ss-feedback').filter({hasText:'重新载入'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'保存设置',exact:true}).isDisabled(),true);
  assert.equal(await page.getByLabel('已完成学校告知与授权').isChecked(),true);
});
test('Changing class protects unsaved settings and navigation works by keyboard',async t=>{
  const {page}=await setup(t);
  await page.getByLabel('已完成学校告知与授权').check();
  await page.locator('#ss-class').selectOption('c2');
  await page.locator('#ss-leave[open]').waitFor();
  await page.getByRole('button',{name:'继续编辑',exact:true}).click();
  assert.equal(await page.locator('#ss-class').inputValue(),'c1');
  await page.locator('#ss-class').selectOption('c2');
  await page.getByRole('button',{name:'放弃修改',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#ss-class').value==='c2');
  assert.equal(await page.getByLabel('已完成学校告知与授权').isChecked(),false);
});
test('Narrow layout stays within viewport and private photos clear on close',async t=>{
  const {page}=await setup(t,{width:390,photo:true});
  await page.getByRole('button',{name:'查看照片',exact:true}).click();
  await page.locator('#ss-photo[open] img').waitFor();
  await page.waitForFunction(()=>document.querySelector('#ss-photo img')?.naturalWidth>0);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#ss-photo img').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await review(page,'teacher-mobile.png');
});

test('An undecodable private photo shows a recoverable message',async t=>{
  const {page}=await setup(t,{photo:true,photoValid:false});
  await page.getByRole('button',{name:'查看照片',exact:true}).click();
  await page.locator('#ss-photo p').filter({hasText:'照片无法显示，请关闭后重新载入。'}).waitFor({timeout:3000});
  assert.equal(await page.locator('#ss-photo img').count(),0);
  await page.getByRole('button',{name:'关闭照片',exact:true}).click();
  assert.equal(await page.locator('#ss-photo').evaluate(el=>el.open),false);
});

test('An open photo closes and revokes its URL at its server retention deadline',async t=>{
  const {page}=await setup(t,{photo:true,photoAgeMs:86400000-2000,clock:true});
  await page.evaluate(()=>{window.revokedPhotos=0;const original=URL.revokeObjectURL;URL.revokeObjectURL=url=>{window.revokedPhotos++;original.call(URL,url);};});
  await page.getByRole('button',{name:'查看照片',exact:true}).click();
  await page.locator('#ss-photo[open] img').waitFor();
  await page.clock.runFor(2001);
  assert.equal(await page.locator('#ss-photo img').count(),0);
  assert.equal(await page.locator('#ss-photo').evaluate(el=>el.open),false);
  assert.equal(await page.evaluate(()=>window.revokedPhotos),1);
});

test('Refreshed expired or removed records clear an already open photo',async t=>{
  for(const state of ['expired','missing']){
    const {page,media}=await setup(t,{photo:true});
    await page.getByRole('button',{name:'查看照片',exact:true}).click();
    await page.locator('#ss-photo[open] img').waitFor();
    if(state==='missing')media.present=false;else media.photo_status='expired';
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(()=>!document.querySelector('#ss-photo').open);
    assert.equal(await page.locator('#ss-photo img').count(),0);
  }
});

test('Remaining call count does not hide a token reservation stop',async t=>{
  const data=snapshot();
  const {page}=await setup(t,{width:390,runtime:{config:{...data.config,enabled:true},
    usage:{calls:1,tokens:1456,estimated:1},status:{state:'budget',detail:'今日 AI 复核预算不足，已暂停',updated_at:data.serverTime}}});
  assert.equal(await page.locator('#ss-state').textContent(),'AI 复核已暂停');
  assert.equal(await page.locator('#ss-state-note').textContent(),'教室声波继续显示');
  assert.equal(await page.locator('#ss-state-note').isVisible(),true);
  assert.match(await page.locator('#ss-detail').textContent(),/预算不足/);
  assert.equal(await page.locator('#ss-usage-calls').textContent(),'1 / 4 次');
  assert.match(await page.locator('#ss-usage-tokens').textContent(),/1456.*含预占/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
});

test('Monitoring cannot save without school authorization or display a draft as live status',async t=>{
  const {page,writes}=await setup(t);
  await page.getByLabel('启用自习管理',{exact:true}).check();
  assert.equal(await page.locator('#ss-state').textContent(),'尚未启用');
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.locator('#ss-feedback[role="alert"]').filter({hasText:'告知与授权'}).waitFor();
  assert.equal(writes.length,0);
});

test('The processing flow follows fresh device state and clears its stage when stale or paused',async t=>{
  const data=snapshot(),runtime={config:{...data.config,enabled:true},status:{state:'observing',updated_at:data.serverTime}};
  const {page,requests}=await setup(t,{runtime});
  await page.locator('#ss-event-list .ss-empty').waitFor();
  for(const [state,step] of [['observing',1],['analyzing',2],['warning',3],['reported',4],['teaching',0],['budget',null],['ai_paused',null],['paused',null]]){
    runtime.status={state,updated_at:data.serverTime};
    const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/self-study/events'&&new URL(response.url()).searchParams.get('classId')==='c1');
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await refreshed;
    await page.waitForFunction(state=>document.querySelector('.ss-runtime')?.dataset.state===state,state);
    const active=await page.locator('[data-ss-step][aria-current="step"]').evaluateAll(nodes=>nodes[0]?.dataset.ssStep??null);
    assert.equal(active,step===null?null:String(step));
  }
  runtime.status={state:'observing',updated_at:data.serverTime-90001};
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('#ss-state').filter({hasText:'等待教室端同步'}).waitFor();
  assert.equal(await page.locator('[aria-current="step"]').count(),0);
  assert.equal(requests.every(r=>['GET','HEAD'].includes(r.method)),true);
});

test('Bottom actions remain clickable above the floating assistant on a narrow screen',async t=>{
  const {page}=await setup(t,{width:390,photo:true});
  await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
  const button=page.getByRole('button',{name:'查看晚自习安排',exact:true});
  const clear=await button.evaluate(node=>{const r=node.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===node;});
  assert.equal(clear,true,'The launcher cannot intercept the schedule action');
  await button.click();await page.locator('#ss-week[open]').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await button.evaluate(node=>node===document.activeElement),true);
});

test('Unchanged records preserve keyboard focus when polling advances the server clock',async t=>{
  const runtime={};
  const {page,media}=await setup(t,{photo:true,runtime});
  const button=await page.getByRole('button',{name:'查看照片',exact:true}).elementHandle();
  await button.focus();media.serverTime+=20000;runtime.usage={calls:1,tokens:100};
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(()=>document.querySelector('#ss-usage-calls').textContent==='1 / 4 次');
  assert.equal(await button.evaluate(node=>node.isConnected&&node===document.activeElement),true);
});

test('Record actions submit their resolution and refresh the pending state',async t=>{
  for(const [name,resolution] of [['标记误报','false_alarm'],['处理完成','handled']]){
    const {page,reviews}=await setup(t,{photo:true});
    await page.getByRole('button',{name,exact:true}).click();
    await page.locator('#ss-feedback').filter({hasText:'处理结果已记录'}).waitFor();
    assert.deepEqual(reviews,[{resolution}]);
    assert.equal(await page.locator('#ss-pending').textContent(),'暂无待核实');
    assert.equal(await page.locator('[data-ss-review]').count(),0);
  }
});

test('The weekly schedule has a keyboard dialog, returns focus and reaches the real timetable editor',async t=>{
  const {page}=await setup(t);
  const button=page.getByRole('button',{name:'查看晚自习安排',exact:true});
  await button.focus();await page.keyboard.press('Enter');
  await page.locator('#ss-week[open]').waitFor();
  assert.match(await page.locator('#ss-schedule').textContent(),/20:00.*21:30/);
  await page.keyboard.press('Escape');
  assert.equal(await button.evaluate(node=>node===document.activeElement),true);
  await button.click();await page.getByRole('button',{name:'编辑周课表',exact:true}).click();
  await page.locator('#view-island:not(.hidden)').waitFor();
  assert.equal(await page.locator('#ss-week').evaluate(node=>node.open),false);
});

test('The approved layout aligns its controls and stays inside glass and white viewports',async t=>{
  const {page}=await setup(t,{width:1440,photo:true});
  for(const material of ['液态玻璃','原版白色']){
    if(material==='原版白色'){
      await navigate(page,'settings');await page.getByRole('radio',{name:material,exact:true}).check();await navigate(page,'self-study');
      await page.locator('#ss-trigger').waitFor();
    }
    for(const width of [1440,1280,1024,768,390,320]){
      await page.setViewportSize({width,height:1000});
      const layout=await page.evaluate(()=>{
        const rect=selector=>document.querySelector(selector).getBoundingClientRect();
        const left=rect('.ss-rules-panel'),right=rect('.ss-options'),runtime=rect('.ss-runtime');
        const trigger=rect('#ss-trigger'),observation=rect('#ss-observation');
        const ai=rect('#ss-aiEnabled'),photo=rect('#ss-photoEnabled');
        const fields=[...document.querySelectorAll('#selfStudyRoot input,#selfStudyRoot button,#selfStudyRoot select')].filter(el=>el.getClientRects().length);
        return {pageFits:document.documentElement.scrollWidth<=innerWidth+1,panelsAlign:Math.abs(left.top-right.top)<=1&&Math.abs(left.bottom-right.bottom)<=1,
          fullWidth:Math.abs(runtime.left-left.left)<=1&&Math.abs(runtime.right-right.right)<=1,
          numbersAlign:Math.abs(trigger.right-observation.right)<=1,switchesAlign:Math.abs(ai.right-photo.right)<=1,
          controlsFit:fields.every(el=>{const r=el.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1;})};
      });
      assert.ok(layout.pageFits&&layout.controlsFit,`${material} ${width}px: all controls fit their viewport`);
      assert.ok(layout.numbersAlign&&layout.switchesAlign,`${material} ${width}px: repeated controls share alignment`);
      if(width>1050)assert.ok(layout.panelsAlign&&layout.fullWidth,`${material} ${width}px: the status and equal-height columns share edges`);
      if([1440,390].includes(width))await review(page,`layout-${material==='液态玻璃'?'glass':'white'}-${width}.png`);
    }
  }
});

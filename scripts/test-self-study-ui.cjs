'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const {test,before,after} = require('node:test');
const {chromium} = require('playwright');
const {open,navigate} = require('./test-teacher-ui.cjs');
let browser;
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();});
const snapshot = () => ({revision:1,config:{enabled:false,authorized:false,aiEnabled:false,photoEnabled:true,dailyCalls:4,dailyTokens:2400},
  schedule:[{key:'monday',title:'晚自习第二节',startAt:1794225600000,endAt:1794231000000}],usage:{calls:0,tokens:0},
  serverTime:1794226200000,aiReady:true,status:null});
async function setup(t,{width=1280,saveStatus=200,photo=false,photoAgeMs=0,clock=false}={}) {
  const writes=[];
  const media={photo_status:'ready',present:true};
  const result=await open(browser,{width,handle:async({url,request})=>{
    if(url.pathname==='/api/self-study/classes')return {json:{classes:[{id:'c1',name:'高一（1）班'},{id:'c2',name:'高二（1）班'}]}};
    if(/^\/api\/self-study\/classes\//.test(url.pathname)){
      if(request.method()==='PUT'){
        writes.push(request.postDataJSON());
        return saveStatus===200?{json:{...snapshot(),revision:2,config:request.postDataJSON().config}}
          :{status:saveStatus,json:{error:saveStatus===409?'设置已被其他人修改，请重新载入。':'保存失败，请稍后重试。'}};
      }
      return {json:snapshot()};
    }
    if(url.pathname==='/api/self-study/events')return {json:{events:photo&&media.present?[{id:'event1',class_id:'c1',class_name:'高一（1）班',started_at:1794226200000,reported_at:1794226200000,status:'reported',photo_status:media.photo_status,photo_at:1794226200000-photoAgeMs}]:[],pending:photo?1:0,serverTime:1794226200000}};
    if(url.pathname==='/api/self-study/events/event1/photo')return {contentType:'image/jpeg',body:Buffer.from('/9j/2Q==','base64')};
  }});
  t.after(async()=>{await result.context.close();assert.deepEqual(result.errors,[]);});
  if(clock)await result.page.clock.install({time:new Date(1794226200000)});
  await navigate(result.page,'self-study');
  await result.page.locator('#ss-class').waitFor();
  return {...result,writes,media};
}
test('Failed saves preserve the draft and show an actionable error',async t=>{
  const {page,writes}=await setup(t,{saveStatus:503});
  await page.getByLabel('已完成学校告知与授权').check();
  await page.getByLabel('启用晚自习管理',{exact:true}).check();
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.locator('#ss-feedback').filter({hasText:'保存失败'}).waitFor();
  assert.equal(await page.getByLabel('启用晚自习管理',{exact:true}).isChecked(),true);
  assert.equal(writes.length,1);
  if(process.env.ICECLASS_REVIEW_DIR)await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,'teacher-desktop.png'),fullPage:true});
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
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#ss-photo img').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.ICECLASS_REVIEW_DIR)await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,'teacher-mobile.png'),fullPage:true});
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

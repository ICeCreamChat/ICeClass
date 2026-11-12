'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test,before,after} = require('node:test');
const {chromium} = require('playwright');
const root = path.resolve(__dirname,'../web_controller');
let browser;
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();});

async function open(t) {
  const context=await browser.newContext({viewport:{width:1280,height:850},reducedMotion:'reduce'});
  t.after(()=>context.close());
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    assert.equal(url.origin,'http://127.0.0.1');
    assert.ok(!url.pathname.startsWith('/api/'),'Only the isolated bridge may handle business data');
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    assert.ok(file.startsWith(root+path.sep));
    return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:''});
  });
  await context.addInitScript(()=>{
    window.ICeClassNativeHome=true;
    const listeners=[];
    window.__emit=data=>listeners.forEach(fn=>fn({data}));
    window.__day='2026-11-10';window.__requests=[];window.__held=[];window.__hold=false;
    const students=[{id:'s1',name:'张三'},{id:'s2',name:'李四'}];
    window.__island=()=>({date:__day,scheduleKnown:true,lessons:[],notice:null});
    window.__nextDay=()=>{__day='2026-11-11';__emit({type:'island-state',state:__island()});};
    window.__release=()=>{__hold=false;__held.splice(0).forEach(fn=>fn());};
    window.chrome||={};window.chrome.webview={
      addEventListener(type,fn){if(type==='message')listeners.push(fn);},
      postMessage(message){
        if(message.type==='classroom-ready')queueMicrotask(()=>__emit({type:'home-state',state:{
          className:'隔离回归班',deviceCaption:'本地测试',connected:true,connectionText:'已连接平台',
          capabilities:{reading:true,plan:true,banban:true},voice:{recording:false,sending:false},island:__island()}}));
        if(!message.id)return;
        __requests.push(message);
        let value=null;
        if(message.action==='homework'){
          const date=new URLSearchParams(message.path?.startsWith('?')?message.path.slice(1):'').get('date')||__day;
          value=message.path==='/records'?{record:{...message.body,students,revision:2}}:{
            classId:'fixture',className:'隔离回归班',revision:1,date,serverDate:__day,
            records:date==='2026-11-10'?[{itemId:'book',revision:1,status:'submitted',missing:[],students}]:[],
            value:{activeTermId:'term',students,terms:[{id:'term',label:'2026-2027 学年第一学期',subjects:[
              {id:'chinese',name:'语文',items:[{id:'book',name:'练习册',active:true}]}]}]}};
        }
        const respond=()=>__emit({type:'response',id:message.id,...(window.__error?{error:window.__error}:{value})});
        if(__hold)__held.push(respond);else queueMicrotask(respond);
      }
    };
  });
  const page=await context.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  t.after(()=>assert.deepEqual(errors,[]));
  await page.goto('http://127.0.0.1/homework/classroom/index.html');
  await page.waitForFunction(()=>document.querySelector('#record-summary').textContent==='已登记 1 项');
  await page.getByRole('button',{name:'管理班级',exact:true}).click();
  return page;
}
const summary=page=>page.locator('#record-summary');
async function settled(page){await page.waitForFunction(()=>!document.querySelector('[data-action="reload"]').disabled);}
async function editor(page){await page.getByRole('button',{name:'登记作业',exact:true}).click();await page.locator('#homework-dialog[open]').waitFor();}

test('Midnight updates the management summary once, without polling on island ticks',async t=>{
  const page=await open(t);
  await page.evaluate(()=>__nextDay());
  await page.waitForFunction(()=>document.querySelector('#record-summary').textContent==='待登记',{},{timeout:4000});
  const count=await page.evaluate(()=>__requests.length);
  await page.evaluate(()=>{for(let i=0;i<120;i++)__emit({type:'island-state',state:__island()});});
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>__requests.length),count);
});

test('A historical editor keeps its draft through midnight and external reload',async t=>{
  const page=await open(t);await editor(page);
  await page.locator('[data-student="s1"]').uncheck();
  const count=await page.evaluate(()=>__requests.length);
  await page.evaluate(()=>{__nextDay();void window.ICeClassHomework.reload();});
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#homework-date').inputValue(),'2026-11-10');
  assert.equal(await page.locator('[data-student="s1"]').isChecked(),false);
  assert.equal(await page.evaluate(()=>__requests.length),count,'Background refresh cannot discard a draft');
  await page.keyboard.press('Escape');await page.locator('#confirm-dialog[open]').waitFor();
  await page.locator('#keep-editing').click();
  assert.equal(await page.locator('[data-student="s1"]').isChecked(),false);
  await page.keyboard.press('Escape');await page.locator('#discard').click();
  await page.waitForFunction(()=>document.querySelector('#record-summary').textContent==='待登记',{},{timeout:4000});
});

test('Closing historical registration restores today and manual refresh requests today',async t=>{
  const page=await open(t);await page.evaluate(()=>__nextDay());
  await settled(page);await editor(page);
  await page.locator('#homework-date').fill('2026-11-10');await page.locator('#homework-date').dispatchEvent('change');await settled(page);
  assert.equal(await page.locator('#homework-date').inputValue(),'2026-11-10');
  await page.keyboard.press('Escape');await settled(page);
  await page.getByRole('button',{name:'重新载入作业数据'}).click();await settled(page);
  assert.equal(await summary(page).textContent(),'待登记');
  assert.equal(await page.evaluate(()=>__requests.filter(r=>r.action==='homework').at(-1).path),'');
});

test('A day change during a pending read queues one current-day read after it settles',async t=>{
  const page=await open(t);
  await page.evaluate(()=>{__hold=true;});
  await page.getByRole('button',{name:'重新载入作业数据'}).click();
  await page.evaluate(()=>{__nextDay();for(let i=0;i<20;i++)__emit({type:'island-state',state:__island()});});
  const count=await page.evaluate(()=>__requests.length);
  await page.evaluate(()=>__release());
  await page.waitForFunction(()=>document.querySelector('#record-summary').textContent==='待登记',{},{timeout:4000});
  assert.equal(await page.evaluate(()=>__requests.length),count+1);
});

test('Saving across midnight preserves the selected record date and refreshes after closing',async t=>{
  const page=await open(t);await editor(page);
  await page.locator('[data-student="s1"]').uncheck();
  await page.evaluate(()=>{__hold=true;});
  await page.getByRole('button',{name:'保存登记',exact:true}).click();
  await page.evaluate(()=>__nextDay());
  assert.equal(await page.evaluate(()=>__requests.at(-1).body.date),'2026-11-10');
  assert.equal(await page.locator('#homework-date').inputValue(),'2026-11-10');
  await page.evaluate(()=>__release());await settled(page);
  assert.equal(await page.locator('[data-student="s1"]').isChecked(),false);
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelector('#record-summary').textContent==='待登记',{},{timeout:4000});
});

test('Reopening a hidden management page checks today without waiting for a timer',async t=>{
  const page=await open(t);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});__nextDay();});
  const count=await page.evaluate(()=>__requests.length);
  await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>__requests.length),count);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>document.querySelector('#record-summary').textContent==='待登记',{},{timeout:4000});
});

test('Opening registration across midnight finishes the current-day load before editing',async t=>{
  const page=await open(t);
  await page.evaluate(()=>{__hold=true;});
  await page.getByRole('button',{name:'登记作业',exact:true}).click();
  await page.evaluate(()=>{__nextDay();__release();});
  await page.locator('#homework-dialog[open]').waitFor();await settled(page);
  assert.equal(await page.locator('#homework-date').inputValue(),'2026-11-11');
  await page.locator('[data-student="s1"]').uncheck();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-student="s1"]').isChecked(),false);
});

test('A failed midnight refresh stays bounded, reports failure and retries on entry',async t=>{
  const page=await open(t);
  await page.evaluate(()=>{__error='隔离服务暂时不可用';__nextDay();});await settled(page);
  assert.equal(await summary(page).textContent(),'已登记 1 项');
  assert.match(await page.locator('#page-feedback').textContent(),/暂时不可用/);
  const count=await page.evaluate(()=>__requests.length);
  await page.evaluate(()=>{for(let i=0;i<50;i++)__emit({type:'island-state',state:__island()});});
  await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>__requests.length),count);
  await page.evaluate(()=>{__error='';});
  await page.getByRole('button',{name:'返回教室首页',exact:true}).click();
  await page.getByRole('button',{name:'管理班级',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#record-summary').textContent==='待登记',{},{timeout:4000});
});

test('An uncertain save at midnight retains the draft and permits explicit recovery',async t=>{
  const page=await open(t);await editor(page);
  await page.locator('[data-student="s1"]').uncheck();
  await page.evaluate(()=>{__error='保存结果尚未确认';__hold=true;});
  await page.getByRole('button',{name:'保存登记',exact:true}).click();
  await page.evaluate(()=>{__nextDay();__release();});await settled(page);
  assert.equal(await page.locator('#homework-date').inputValue(),'2026-11-10');
  assert.equal(await page.locator('[data-student="s1"]').isChecked(),false);
  assert.match(await page.locator('#entry-feedback').textContent(),/尚未确认/);
  const count=await page.evaluate(()=>__requests.length);
  await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>__requests.length),count);
  await page.evaluate(()=>{__error='';});
  await page.keyboard.press('Escape');await page.locator('#discard').click();
  await page.waitForFunction(()=>document.querySelector('#record-summary').textContent==='待登记',{},{timeout:4000});
});

'use strict';
const assert=require('node:assert/strict');
const {test,before,after}=require('node:test');
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..','web_controller');
let browser;
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();});
async function open(t,{native=true,width=1280,forcedColors='none'}={}){
  const context=await browser.newContext({viewport:{width,height:780},reducedMotion:'reduce',forcedColors});t.after(()=>context.close());
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());assert.equal(url.origin,'http://127.0.0.1');
    if(url.pathname.startsWith('/api/'))return route.fulfill({json:{className:'虚构验收班',classId:'fixture',records:[],terms:[],students:[],value:{terms:[],students:[]}}});
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));assert.ok(file.startsWith(root+path.sep));
    return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404});
  });
  if(native)await context.addInitScript(()=>{
    window.ICeClassNativeHome=true;const listeners=[];window.__workshopCalls=[];window.__cardQuizCalls=0;
    window.__emit=data=>listeners.forEach(listener=>listener({data}));
    window.__plugin={installed:false,enabled:false,running:false,starting:false,busy:false,ready:false,name:'视频展台',message:'导入本机插件包，开始课堂展示。'};
    window.chrome||={};window.chrome.webview={addEventListener(type,listener){if(type==='message')listeners.push(listener);},postMessage(message){
      if(message.type==='classroom-ready')return queueMicrotask(()=>window.__emit({type:'home-state',state:{className:'虚构验收班',deviceCaption:'隔离测试',connected:true,connectionText:'已连接',capabilities:{reading:true,plan:true,banban:true,workshop:true,cardQuiz:true},voice:{recording:false,sending:false}}}));
      if(!message.id)return;
      if(message.action==='card-quiz')window.__cardQuizCalls++;
      if(message.action==='workshop'){
        const op=message.operation;window.__workshopCalls.push(op);
        if(window.__workshopError)return queueMicrotask(()=>window.__emit({type:'response',id:message.id,error:window.__workshopError}));
        if(op==='install')Object.assign(window.__plugin,{installed:true,version:'1.0.0',message:'已安装，启用后即可使用。'});
        if(op==='enable')Object.assign(window.__plugin,{enabled:true,message:'已启用，可以打开视频展台。'});
        if(op==='open')Object.assign(window.__plugin,{running:true,ready:true,message:'视频展台已打开。'});
        if(op==='stop')Object.assign(window.__plugin,{running:false,ready:false,message:'展示已停止。'});
        if(op==='disable')Object.assign(window.__plugin,{enabled:false,running:false,ready:false,message:'已禁用，展示已停止。'});
        if(op==='uninstall')Object.assign(window.__plugin,{installed:false,enabled:false,running:false,ready:false,message:'已卸载，展台配对和连接资料已保留。'});
        return queueMicrotask(()=>window.__emit({type:'response',id:message.id,value:window.__plugin}));
      }
      queueMicrotask(()=>window.__emit({type:'response',id:message.id,value:{classId:'fixture',className:'虚构验收班',records:[],value:{terms:[],students:[]}}}));
    }};
  });
  await page.goto('http://127.0.0.1/homework/classroom/index.html');
  // The browser embed opens management only; exercise the no-bridge handler explicitly.
  if(native)await page.locator('[data-action="workshop"]').click();
  else await page.locator('[data-action="workshop"]').dispatchEvent('click');
  return page;
}
for(const width of [1280,720,390])test(`Workshop local lifecycle and keyboard at ${width}px`,async t=>{
  const page=await open(t,{width});
  const cardQuiz=page.getByRole('button',{name:'打开纸卡答题',exact:true});await cardQuiz.focus();await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>window.__cardQuizCalls),1);
  const install=page.getByRole('button',{name:'安装插件',exact:true});await install.focus();await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'启用视频展台',exact:true}).waitFor();
  assert.equal(await page.locator('[data-workshop="open"]').count(),0,'fresh package is not enabled');
  await page.getByRole('button',{name:'启用视频展台',exact:true}).click();
  await page.getByRole('button',{name:'打开视频展台',exact:true}).click();
  await page.getByRole('button',{name:'停止并关闭展台',exact:true}).waitFor();
  await page.getByRole('button',{name:'禁用并停止',exact:true}).click();
  await page.getByRole('button',{name:'卸载并停止',exact:true}).click();
  await page.getByRole('button',{name:'安装插件',exact:true}).waitFor();
  assert.match(await page.locator('#workshop-status').textContent(),/资料已保留/);
  assert.deepEqual(await page.evaluate(()=>window.__workshopCalls),['status','install','enable','open','disable','uninstall']);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const actions=await page.locator('#workshop-actions button').evaluateAll(buttons=>buttons.map(button=>{const r=button.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height};}));
  assert.ok(actions.every(rect=>rect.left>=0&&rect.right<=width&&rect.height>=44));
  await page.keyboard.press('Escape');assert.equal(await page.locator('#detail-dialog').evaluate(dialog=>dialog.open),false);
});
test('Browser clearly explains native installation',async t=>{
  const page=await open(t,{native:false});assert.match(await page.locator('#workshop-status').textContent(),/Windows 教室端/);
  assert.equal(await page.locator('#workshop-actions button').count(),0);
  assert.equal(await page.getByRole('button',{name:'打开纸卡答题',exact:true}).count(),0);
});
test('Error, high contrast and untrusted text remain readable',async t=>{
  const page=await open(t,{forcedColors:'active'});
  await page.evaluate(()=>window.__workshopError='插件包架构不适用于本机，请选择 win-x64 视频展台包。');
  await page.getByRole('button',{name:'安装插件',exact:true}).click();
  await page.locator('#workshop-status').filter({hasText:'架构不适用'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'安装插件',exact:true}).isEnabled(),true);
  await page.evaluate(()=>window.__emit({type:'workshop-state',state:{...window.__plugin,message:'<img src=x onerror=alert(1)>'}}));
  assert.equal(await page.locator('#workshop-status img').count(),0);
  assert.match(await page.locator('#workshop-status').textContent(),/<img/);
});

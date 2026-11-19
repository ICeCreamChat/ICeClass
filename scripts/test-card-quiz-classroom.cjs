'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..','web_controller');
const origin='https://cardquiz.iceclass.local';
let browser;
before(async()=>{browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});});
after(async()=>{await browser?.close();});
const copy=value=>JSON.parse(JSON.stringify(value));
const Model=require('../web_controller/card-quiz/model.js'),Journal=require('../web_controller/card-quiz/journal.js');

async function open({width=1160,journals=[],failCommit=false,scannerFixture=false,touch=false}={}){
  const context=await browser.newContext({viewport:{width,height:820},reducedMotion:'reduce',hasTouch:touch}),page=await context.newPage();
  const fixture={journals:copy(journals),failCommit,commands:[],messages:[],errors:[],synced:0,companion:{enabled:false,expanded:false}};
  const base={classId:'c1',deviceId:'d1',className:'隔离演示班',context:{classId:'c1',deviceId:'d1',students:[{id:'s1',name:'不应出现在教室报告中的姓名',cardNumber:1},{id:'s2',name:'私密姓名乙',cardNumber:2}],publications:[]},errors:[]};
  const load=()=>copy({...base,journals:fixture.journals});
  await page.exposeFunction('__quizNative',async message=>{
    fixture.messages.push(copy(message));
    if(message.type)return null;
    const body=message.body||{};
    switch(message.action){
      case'load':case'bootstrap':return load();
      case'commit':{
        if(fixture.failCommit)throw new Error('隔离检查：磁盘不可写');
        const j=copy(body.journal),index=fixture.journals.findIndex(x=>x.session.id===j.session.id);
        if(index>=0)fixture.journals[index]=j;else fixture.journals.push(j);return j;
      }
      case'sync':fixture.journals.forEach(j=>j.syncedSeq=j.session.seq);return load();
      case'relay':{const commands=fixture.commands.splice(0);return{commands,pairings:[]};}
      case'pair':return{pairId:crypto.randomUUID(),code:'482915',url:'https://school.example/card-quiz/phone.html#pair=isolated',expiresAt:Date.now()+300000};
      case'compact':{
        const enabled=body.enabled===true,expanded=enabled&&body.expanded===true;
        fixture.companion={enabled,expanded};
        await page.evaluate(value=>window.__quizReceive(value),{type:'compact',value:enabled,expanded});return null;
      }
      case'close':return null;
      default:throw new Error('未预期的原生操作：'+message.action);
    }
  });
  await page.addInitScript(()=>{
    const listeners=[];window.chrome ||= {};
    window.__quizReceive=value=>listeners.forEach(fn=>fn({data:value}));
    window.chrome.webview={addEventListener(type,fn){if(type==='message')listeners.push(fn);},postMessage(message){
      if(message.type==='companion-state')window.__quizWheelState=message.state;
      window.__quizNative(message).then(value=>{if(message.id)window.__quizReceive({type:'response',id:message.id,value});}).catch(error=>{if(message.id)window.__quizReceive({type:'response',id:message.id,error:error.message});});
    }};
  });
  page.on('pageerror',error=>fixture.errors.push(error.message));
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());assert.equal(url.origin,origin,'No external requests');
    if(scannerFixture&&url.pathname.endsWith('/scanner.js'))return route.fulfill({contentType:'application/javascript',body:`window.CardQuizScanner=class{constructor(options){window.testScanner=this;this.options=options;this.running=false;}start(){this.running=true;return Promise.resolve();}stop(){this.running=false;}reset(key,count){this.key=key;this.optionCount=count;}};`});
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));assert.ok(file.startsWith(root+path.sep));
    return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:'Not found'});
  });
  await page.goto(origin+'/card-quiz/classroom.html');
  await page.locator('#create-session:not([disabled])').waitFor();
  return{page,context,fixture};
}
async function create(page){await page.locator('#create-session').click();await page.locator('#workspace:not([hidden])').waitFor();await page.locator('#start:not([disabled])').waitFor();}
async function noOverflow(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');}

async function sector(page,id){await page.evaluate(action=>window.__quizReceive({type:'companion-action',action}),id);}
async function wheel(page){return page.evaluate(()=>window.__quizWheelState);}

test('开课前将八个禁用功能发送给原班班，页面不再生成第二个班班，打开入口不创建课堂',async()=>{
  const{page,context,fixture}=await open({scannerFixture:true,width:390});
  try{
    const state=await wheel(page);assert.equal(state.actions.length,8);assert.ok(state.actions.every(action=>!action.enabled));
    assert.equal(state.progress,'请先开始课堂');assert.equal(await page.locator('#companion,#wheel-toggle').count(),0);
    await page.locator('#compact').click();await page.waitForFunction(()=>!document.querySelector('#compact').disabled);
    assert.deepEqual(fixture.companion,{enabled:true,expanded:true});assert.equal(fixture.journals.length,0);
    assert.equal(fixture.messages.some(message=>['commit','pair','relay'].includes(message.action)),false);
    await create(page);await page.waitForFunction(()=>window.__quizWheelState.actions.find(a=>a.id==='collect').enabled);
    assert.deepEqual(fixture.companion,{enabled:true,expanded:true});
    assert.equal(fixture.journals.length,1);assert.equal(fixture.journals[0].session.questions[0].rounds.length,0);
    assert.equal(await page.evaluate(()=>testScanner.running),false);await noOverflow(page);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('原班班的收答操作复用课堂记录，收起后真实模拟视频继续刷新',async()=>{
  const{page,context,fixture}=await open();
  try{
    await create(page);await sector(page,'collect');
    await page.waitForFunction(()=>document.querySelector('#camera')?.srcObject?.getVideoTracks()[0]?.readyState==='live');
    await page.waitForTimeout(4200);
    assert.deepEqual(fixture.companion,{enabled:true,expanded:false});
    assert.equal(await page.locator('#camera-status').innerText(),'相机已开启');
    assert.equal(fixture.journals.length,1);assert.equal(fixture.journals[0].session.questions[0].rounds[0].status,'collecting');
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('原班班手机扫码与缺席免答沿用工作台原对话框和真实轮次',async()=>{
  const{page,context,fixture}=await open({scannerFixture:true});
  try{
    await create(page);await sector(page,'source');await page.locator('#pair-dialog[open]').waitFor();
    assert.equal(await page.locator('#pair-qr svg').count(),1);assert.equal(fixture.companion.enabled,false);
    await page.locator('[data-dismiss="pair-dialog"]').click();
    await sector(page,'collect');await page.locator('#stop:not([disabled])').waitFor();
    await sector(page,'exempt');await page.locator('#exempt-dialog[open]').waitFor();await page.locator('[data-student="s2"]').check();
    await page.waitForFunction(()=>document.querySelector('#expected').textContent.includes('/ 1'));
    assert.deepEqual(fixture.journals[0].session.questions[0].rounds[0].exempt,['s2']);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('原班班状态同步收答人数和可用功能，伪造禁用动作不能换题或切换来源',async()=>{
  const{page,context,fixture}=await open({scannerFixture:true});
  try{
    await create(page);await sector(page,'collect');await page.locator('#stop:not([disabled])').waitFor();
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:1,option:'C'}));
    const state=await wheel(page);assert.match(state.progress,/1 \/ 2/);
    assert.equal(state.actions.find(a=>a.id==='next').enabled,false);assert.equal(state.actions.find(a=>a.id==='source').enabled,false);
    assert.equal(state.actions.find(a=>a.id==='collect').label,'结束本轮');
    await sector(page,'next');await sector(page,'source');assert.equal(fixture.journals[0].session.questions.length,1);
    assert.equal(await page.locator('#pair-dialog').isVisible(),false);
    await sector(page,'collect');await page.waitForFunction(()=>document.querySelector('#round-status').textContent==='本轮已封存');
    assert.equal(await page.evaluate(()=>testScanner.running),false);
    assert.equal(fixture.journals[0].session.questions[0].rounds[0].answers.s1.option,'C');
    await sector(page,'next');await page.waitForFunction(()=>document.querySelector('#question-number').textContent.includes('第 2 题'));
    assert.equal(fixture.journals.length,1);assert.equal(fixture.journals[0].session.questions.length,2);
    assert.doesNotMatch(JSON.stringify(await wheel(page)),/不应出现在|私密姓名/);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('原班班题目设置、分布和结束课堂沿用原窗口，结束仍保留取消与确认',async()=>{
  const{page,context,fixture}=await open({scannerFixture:true});
  try{
    await create(page);await sector(page,'edit');await page.locator('#editor[open]').waitFor();assert.equal(fixture.companion.enabled,false);
    await page.locator('#edit-answer').selectOption('B');await page.locator('#question-form [type=submit]').click();await page.locator('#editor').waitFor({state:'hidden'});
    await sector(page,'collect');await page.locator('#stop:not([disabled])').waitFor();await sector(page,'collect');
    await page.locator('#show-distribution:not([disabled])').waitFor();await sector(page,'distribution');await page.locator('#distribution:not([hidden])').waitFor();
    await sector(page,'end-session');await page.locator('#confirm-dialog[open]').waitFor();await page.locator('#confirm-cancel').click();assert.equal(fixture.journals[0].session.endedAt,null);
    await sector(page,'end-session');await page.locator('#confirm-ok').click();await page.waitForFunction(()=>document.querySelector('#round-status').textContent==='本课堂已结束');
    assert.ok(fixture.journals[0].session.endedAt);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('原班班多选逐项收答继续复用原按钮，换项停相机，再主动开启',async()=>{
  const{page,context,fixture}=await open({scannerFixture:true,width:390});
  try{
    await create(page);await page.locator('#edit').click();await page.locator('#edit-type').selectOption('multiple');
    await page.locator('#question-form [type=submit]').click();await page.locator('#editor').waitFor({state:'hidden'});
    await sector(page,'collect');await page.waitForFunction(()=>window.__quizWheelState.multiple && window.__quizWheelState.multiEnabled);
    await sector(page,'multi');await page.waitForFunction(()=>document.querySelector('#multi-option').value==='B');
    assert.equal(await page.evaluate(()=>testScanner.running),false);assert.match((await wheel(page)).status,/收 B 项/);
    await page.waitForFunction(()=>!document.querySelector('#compact').disabled);await sector(page,'camera');await page.waitForFunction(()=>testScanner.running);
    assert.equal(fixture.journals.length,1);await noOverflow(page);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});
test('多选课堂可勾选答案、逐项收答和回改，换项停相机后主动继续且不泄露个人',async()=>{
  const{page,context,fixture}=await open({width:390,scannerFixture:true});
  const scan=read=>page.evaluate(value=>window.testScanner.options.onRead(value),read);
  try{
    await create(page);await page.locator('#edit').click();await page.locator('#edit-type').selectOption('multiple');
    await page.locator('#edit-answer-multiple input[value="A"]').check();await page.locator('#edit-answer-multiple input[value="C"]').check();
    await page.locator('#question-form [type=submit]').click();await page.locator('#editor').waitFor({state:'hidden'});
    assert.equal(fixture.journals[0].session.questions[0].answer,'AC');
    await page.locator('#start').click();await page.locator('#stop:not([disabled])').waitFor();
    assert.equal(await page.evaluate(()=>testScanner.optionCount),2);await scan({cardNumber:1,option:'A'});
    assert.equal(await page.locator('#received').innerText(),'0');assert.match(await page.locator('#multi-progress').innerText(),/1.*2/);
    await page.locator('#multi-next').click();await page.waitForFunction(()=>document.querySelector('#multi-option').value==='B'&&!document.querySelector('#multi-option').disabled);
    assert.equal(await page.evaluate(()=>testScanner.running),false,'切项后不沿用学生尚未改变的卡面');
    await page.locator('#camera-toggle').click();await scan({cardNumber:1,option:'B'});
    for(const [option,read]of [['C','A'],['D','B']]){
      await page.locator('#multi-option').selectOption(option);await page.waitForFunction(()=>!document.querySelector('#multi-option').disabled);
      await page.locator('#camera-toggle').click();await scan({cardNumber:1,option:read});
    }
    assert.equal(await page.locator('#received').innerText(),'1');assert.equal(fixture.journals[0].session.questions[0].rounds[0].answers.s1.option,'AC');
    await page.locator('#multi-option').selectOption('C');await page.waitForFunction(()=>!document.querySelector('#multi-option').disabled);
    await page.locator('#camera-toggle').click();await scan({cardNumber:2,option:'B'});
    await page.locator('#stop').click();await page.locator('#show-distribution:not([disabled])').waitFor();await page.locator('#show-distribution').click();
    assert.match(await page.locator('#distribution').innerText(),/未完成.*1/);assert.match(await page.locator('#distribution').innerText(),/未答.*0/);
    assert.doesNotMatch(await page.locator('body').innerText(),/不应出现在|私密姓名/);await noOverflow(page);
    await page.locator('#edit').click();await page.locator('#edit-answer-multiple input[value="C"]').focus();await page.keyboard.press('Space');
    await page.locator('#question-form [type=submit]').click();await page.locator('#editor').waitFor({state:'hidden'});
    assert.equal(fixture.journals[0].session.questions[0].answer,'A');assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('真实课堂页可课件出题、封存、补答案、揭晓、练习和结束，匿名不展示名单',async()=>{
  const{page,context,fixture}=await open();
  try{
    await create(page);await page.locator('#start').click();await page.locator('#stop:not([disabled])').waitFor();
    await page.locator('#stop').click();await page.locator('#edit:not([disabled])').waitFor();
    await page.locator('#edit').click();await page.locator('#edit-answer').selectOption('B');await page.locator('#question-form [type=submit]').click();await page.locator('#editor').waitFor({state:'hidden'});
    await page.locator('#reveal').click();await page.locator('#answer-display:not([hidden])').waitFor();assert.match(await page.locator('#answer-display').innerText(),/B/);
    await page.locator('#start').click();await page.locator('#stop:not([disabled])').waitFor();
    assert.equal(fixture.journals[0].session.questions[0].rounds[1].purpose,'practice');
    await page.locator('#stop').click();await page.locator('#end-session:not([disabled])').waitFor();await page.locator('#end-session').click();await page.locator('#confirm-ok').click();
    await page.waitForFunction(()=>document.querySelector('#round-status').textContent==='本课堂已结束');
    assert.ok(fixture.journals[0].session.endedAt);assert.equal(fixture.journals[0].syncedSeq,fixture.journals[0].session.seq);
    assert.doesNotMatch(await page.locator('body').innerText(),/不应出现在|私密姓名/);assert.deepEqual(fixture.errors,[]);await noOverflow(page);
  }finally{await context.close();}
});

test('保存失败不进入已收状态，重开恢复原记录并暂停旧代次',async()=>{
  const first=await open();let saved;
  try{await create(first.page);await first.page.locator('#start').click();await first.page.locator('#stop:not([disabled])').waitFor();saved=copy(first.fixture.journals);first.fixture.failCommit=true;
    await first.page.locator('#stop').click();await first.page.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('保存'));
    assert.equal(first.fixture.journals[0].session.questions[0].rounds[0].status,'collecting');
    assert.equal(await first.page.locator('#received').innerText(),'0');
  }finally{await first.context.close();}
  const second=await open({width:390,journals:saved});
  try{
    await second.page.locator('[data-resume]').click();await second.page.locator('#workspace:not([hidden])').waitFor();
    assert.equal(second.fixture.journals[0].session.questions[0].rounds[0].status,'paused');
    assert.ok(second.fixture.journals[0].session.generation>saved[0].session.generation);
    assert.equal(await second.page.locator('#start').innerText(),'恢复本轮');
    assert.equal(await second.page.locator('#camera').evaluate(v=>v.srcObject),null);
    await second.page.keyboard.press('Tab');assert.ok(await second.page.evaluate(()=>document.activeElement!==document.body));
    await noOverflow(second.page);assert.deepEqual(second.fixture.errors,[]);
  }finally{await second.context.close();}
});

test('暂停请求先释放相机并持久化暂停，再回复可关闭',async()=>{
  const{page,context,fixture}=await open();
  try{
    await create(page);await page.locator('#start').click();await page.locator('#stop:not([disabled])').waitFor();
    await page.evaluate(()=>window.__quizReceive({type:'suspend'}));
    await page.waitForFunction(()=>document.querySelector('#round-status').textContent.includes('已暂停'));
    await page.waitForTimeout(30);
    assert.equal(fixture.journals[0].session.questions[0].rounds[0].status,'paused');
    assert.equal(fixture.messages.filter(m=>m.type==='suspended').at(-1)?.saved,true);
    assert.equal(await page.locator('#camera').evaluate(v=>v.srcObject),null);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('原生撤权通知立即停止相机并禁止继续收答，仍能保存暂停',async()=>{
  const{page,context,fixture}=await open();
  try{
    await create(page);await page.locator('#start').click();await page.locator('#stop:not([disabled])').waitFor();
    await page.evaluate(()=>{window.__quizReceive({type:'authorization',revoked:true,message:'设备授权已失效'});window.__quizReceive({type:'suspend'});});
    await page.waitForFunction(()=>document.querySelector('#round-status').textContent.includes('已暂停'));
    assert.equal(await page.locator('#camera').evaluate(v=>v.srcObject),null);
    assert.equal(await page.locator('#start').isDisabled(),true);assert.equal(await page.locator('#camera-toggle').isDisabled(),true);
    assert.equal(fixture.journals[0].session.questions[0].rounds[0].status,'paused');
    assert.equal(fixture.messages.filter(m=>m.type==='suspended').at(-1)?.saved,true);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

for(const change of ['edit_question','add_question'])test('白板编辑草稿绑定原题版本，拒绝并发'+change+'覆盖',async()=>{
  const initial=Journal.create(Model.createSession({classId:'c1',deviceId:'d1',students:[{id:'s1',name:'学生甲',cardNumber:1}]},'math'));
  const controller=new Journal.Controller(initial,async j=>j);
  const cmd=(s,action,payload)=>({id:crypto.randomUUID(),sessionId:s.id,questionId:s.currentQuestionId,roundId:s.currentRoundId,generation:s.generation,sourceId:s.sourceId,action,payload});
  await controller.dispatch(cmd(controller.session,'add_question',{type:'single',text:'原题草稿',options:['一','二'],answer:'A'}));
  await controller.dispatch(cmd(controller.session,'set_source',{source:'phone',sourceId:crypto.randomUUID()}));
  const{page,context,fixture}=await open({journals:[controller.journal]});
  try{
    await page.locator('[data-resume]').click();await page.locator('#edit:not([disabled])').waitFor();await page.locator('#edit').click();
    const s=fixture.journals[0].session,before=s.seq;
    fixture.commands.push(cmd(s,change,change==='edit_question'?{revision:s.questions[0].revision,text:'手机已修改',answer:'B'}:{type:'single',text:'手机下一题',options:['甲','乙'],answer:'B'}));
    await page.waitForFunction(seq=>document.querySelector('#sync-status').textContent.includes(`${seq} 条`),before+1);
    await page.locator('#question-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#editor-error').textContent.includes('草稿已保留'));
    assert.equal(fixture.journals[0].session.seq,before+1);
    assert.equal(fixture.journals[0].session.questions.at(-1).text,change==='edit_question'?'手机已修改':'手机下一题');
    assert.equal(await page.locator('#edit-text').inputValue(),'原题草稿');assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('封存只保存记录，教师主动展示分布，换题后恢复隐藏',async()=>{
  const{page,context,fixture}=await open({width:390});
  try{
    await create(page);await page.locator('#start').click();await page.locator('#stop:not([disabled])').waitFor();await page.locator('#stop').click();await page.locator('#show-distribution:not([disabled])').waitFor();
    assert.equal(await page.locator('#distribution').isVisible(),false);
    await page.locator('#show-distribution').click();assert.equal(await page.locator('#distribution').isVisible(),true);
    assert.match(await page.locator('#distribution').innerText(),/A · 0 人/);assert.match(await page.locator('#distribution').innerText(),/未答 · 2 人/);
    assert.equal(await page.locator('#answer-display').isVisible(),false);
    await page.locator('#next').click();await page.waitForFunction(()=>document.querySelector('#question-number').textContent.includes('第 2 题'));
    assert.equal(await page.locator('#distribution').isVisible(),false);await noOverflow(page);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('结束多选空白轮次后编辑锁定题型和数量，并说明新建临时题入口',async()=>{
  const{page,context,fixture}=await open({width:390,scannerFixture:true});
  try{
    await create(page);await page.locator('#edit').click();await page.locator('#edit-type').selectOption('multiple');
    await page.locator('#question-form [type=submit]').click();await page.locator('#editor').waitFor({state:'hidden'});
    await page.locator('#start').click();await page.locator('#stop:not([disabled])').waitFor();
    await page.locator('#stop').click();await page.locator('#edit:not([disabled])').click();
    const sealed=copy(fixture.journals[0].session.questions[0].rounds);
    assert.equal(await page.locator('#edit-type').isDisabled(),true);assert.equal(await page.locator('#edit-count').isDisabled(),true);
    assert.equal(await page.locator('#editor-round-note').isVisible(),true);
    await page.locator('#edit-text').fill('空轮次后补题干');await page.locator('#edit-answer-choices input[value="B"]').check();
    await page.locator('#question-form [type=submit]').click();await page.locator('#editor').waitFor({state:'hidden'});
    assert.deepEqual(fixture.journals[0].session.questions[0].rounds,sealed);
    await page.locator('#temporary').click();assert.equal(await page.locator('#edit-type').isDisabled(),false);
    assert.equal(await page.locator('#edit-count').isDisabled(),false);assert.equal(await page.locator('#editor-round-note').isVisible(),false);
    await noOverflow(page);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('空白单选轮次保留判断互改入口，改多选需新建临时题',async()=>{
  const{page,context,fixture}=await open({width:390,scannerFixture:true});
  try{
    await create(page);await page.locator('#start').click();await page.locator('#stop:not([disabled])').waitFor();
    await page.locator('#stop').click();await page.locator('#edit:not([disabled])').click();
    const sealed=copy(fixture.journals[0].session.questions[0].rounds);
    assert.equal(await page.locator('#edit-type').isDisabled(),false);assert.equal(await page.locator('#edit-count').isDisabled(),false);
    assert.equal(await page.locator('#edit-type option[value="multiple"]').evaluate(option=>option.matches(':disabled')),true);
    await page.locator('#edit-type').selectOption('boolean');await page.locator('#question-form [type=submit]').click();
    await page.locator('#editor').waitFor({state:'hidden'});assert.equal(fixture.journals[0].session.questions[0].type,'boolean');
    assert.deepEqual(fixture.journals[0].session.questions[0].rounds,sealed);
    await page.locator('#temporary').click();assert.equal(await page.locator('#edit-type option[value="multiple"]').evaluate(option=>option.matches(':disabled')),false);
    await noOverflow(page);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('题库快照编辑锁定题型和选项，保留本场题干答案修订与临时题入口',async()=>{
  const initial=Journal.create(Model.createSession({classId:'c1',deviceId:'d1',students:[{id:'s1',name:'学生甲',cardNumber:1}]},'math'));
  const controller=new Journal.Controller(initial,async j=>j),s=controller.session;
  await controller.dispatch({id:crypto.randomUUID(),sessionId:s.id,questionId:null,roundId:null,generation:s.generation,sourceId:s.sourceId,action:'add_question',payload:{type:'single',bankId:'bank-fixed',bankVersion:1,text:'发布题目',options:['甲','乙'],answer:'A'}});
  const{page,context,fixture}=await open({width:390,journals:[controller.journal]});
  try{
    await page.locator('[data-resume]').click();await page.locator('#edit:not([disabled])').waitFor();await page.locator('#edit').click();
    assert.equal(await page.locator('#edit-type').isDisabled(),true);assert.equal(await page.locator('#edit-count').isDisabled(),true);
    assert.deepEqual(await page.locator('#edit-options input').evaluateAll(inputs=>inputs.map(i=>i.readOnly)),[true,true]);
    assert.equal(await page.locator('#editor-snapshot-note').isVisible(),true);
    await page.locator('#edit-text').fill('本场修订题干');await page.locator('#edit-answer').selectOption('B');await page.locator('#edit-tags').fill('本场标签');
    await page.locator('#question-form [type=submit]').click();await page.locator('#editor').waitFor({state:'hidden'});
    const saved=fixture.journals[0].session.questions[0];
    assert.equal(saved.text,'本场修订题干');assert.equal(saved.answer,'B');assert.deepEqual(saved.tags,['本场标签']);assert.deepEqual(saved.options,['甲','乙']);assert.equal(saved.bankId,'bank-fixed');
    await page.locator('#temporary').click();
    assert.equal(await page.locator('#edit-type').isDisabled(),false);assert.equal(await page.locator('#edit-count').isDisabled(),false);
    assert.equal(await page.locator('#editor-snapshot-note').isVisible(),false);
    assert.deepEqual(await page.locator('#edit-options input').evaluateAll(inputs=>inputs.map(i=>i.readOnly)),[false,false,false,false]);
    await noOverflow(page);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

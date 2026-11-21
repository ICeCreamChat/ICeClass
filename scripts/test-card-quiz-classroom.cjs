'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..','web_controller');
const origin='https://cardquiz.iceclass.local';
let browser;
before(async()=>{browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});});
after(async()=>{await browser?.close();});
const copy=value=>JSON.parse(JSON.stringify(value));
const Model=require('../web_controller/card-quiz/model.js'),Journal=require('../web_controller/card-quiz/journal.js');

async function open({width=1160,height=820,companion=false,journals=[],publications=[],failCommit=false,scannerFixture=false,touch=false}={}){
  const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',hasTouch:touch}),page=await context.newPage();
  const fixture={journals:copy(journals),failCommit,commands:[],messages:[],errors:[],synced:0,pairings:[]};
  const publicationSummaries=publications.map(({id,title,questions})=>({id,title,questionCount:questions.length,cached:true}));
  const base={classId:'c1',deviceId:'d1',className:'隔离演示班',context:{classId:'c1',deviceId:'d1',students:[{id:'s1',name:'不应出现在教室报告中的姓名',cardNumber:1},{id:'s2',name:'私密姓名乙',cardNumber:2}],publications:publicationSummaries},errors:[]};
  const load=()=>copy({...base,journals:fixture.journals});
  await page.exposeFunction('__quizNative',async message=>{
    fixture.messages.push(copy(message));
    if(message.type)return null;
    const body=message.body||{};
    switch(message.action){
      case'load':case'bootstrap':return load();
      case'publication':return {publication:copy(publications.find(publication=>publication.id===body.id))};
      case'commit':{
        const hold = fixture.holdCommit;
        if (hold) { fixture.holdCommit = null; fixture.commitStarted(); await hold; }
        if(fixture.failCommit)throw new Error('隔离检查：磁盘不可写');
        const j=copy(body.journal),index=fixture.journals.findIndex(x=>x.session.id===j.session.id);
        if(index>=0)fixture.journals[index]=j;else fixture.journals.push(j);return j;
      }
      case'sync':{
        if (fixture.holdSync) await fixture.holdSync;
        if (fixture.failSync) throw new Error('学校服务暂时离线');
        fixture.journals.forEach(j=>j.syncedSeq=j.session.seq);return load();
      }
      case'relay':{const commands=fixture.commands.splice(0);return{commands,pairings:fixture.pairings};}
      case'pair':
        fixture.pairId=crypto.randomUUID();
        return{pairId:fixture.pairId,code:'482915',url:'https://school.example/card-quiz/phone.html#pair=isolated',expiresAt:Date.now()+300000};
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
    if(scannerFixture&&url.pathname.endsWith('/scanner.js'))return route.fulfill({contentType:'application/javascript',body:`window.CardQuizScanner=class{constructor(options){window.testScanner=this;this.options=options;this.running=false;this.starts=0;}waitForNewPresentation(){}cardsInView(){return new Map();}start(){this.starts++;this.running=true;return Promise.resolve();}stop(){this.running=false;}reset(key,count){this.key=key;this.optionCount=count;}};`});
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));assert.ok(file.startsWith(root+path.sep));
    return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:'Not found'});
  });
  await page.goto(origin+'/card-quiz/classroom.html'+(companion?'#banban':''));
  await page.locator(journals.some(j=>j.session.endedAt===null)?'[data-resume]':'#create-session:not([disabled])').first().waitFor({state:'attached'});
  return{page,context,fixture};
}
async function create(page){await page.locator('#create-session').click();await page.locator('#workspace:not([hidden])').waitFor();await page.locator('#start:not([disabled])').waitFor();}
async function noOverflow(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');}

async function sector(page,action,payload={}){await page.evaluate(value=>window.__quizReceive(value),{type:'companion-action',action,...payload});}
async function wheel(page){return page.evaluate(()=>window.__quizWheelState);}
async function startInPet(page,template='single:4'){
  await sector(page,'setup-start',{selection:{publication:'',subject:'math',template}});
  await page.waitForFunction(()=>window.__quizWheelState.actions.some(a=>a.id==='collect'&&a.label==='开始收答'&&a.enabled));
}
async function waitPanel(page,name){
  await page.waitForFunction(name=>window.__quizWheelState.panel===name,name);
}

test('开课和首题一并保存，结束后无需等待学校同步即可开下一堂',async()=>{
  const {page,context,fixture}=await open({width:390,scannerFixture:true});
  let release;
  try {
    await create(page);
    const first=fixture.journals[0];
    assert.equal(fixture.messages.filter(m=>m.action==='commit').length,1);
    assert.equal(first.session.questions.length,1);
    fixture.holdSync=new Promise(resolve=>release=resolve);
    await page.locator('#end-session').click();
    await page.locator('#confirm-ok').click();
    await page.locator('#return-setup').click();
    await create(page);
    assert.equal(fixture.journals.length,2);
    assert.ok(fixture.journals[0].session.endedAt);
    assert.equal(fixture.journals[1].session.endedAt,null);
    release();await noOverflow(page);assert.deepEqual(fixture.errors,[]);
  }finally{release?.();await context.close();}
});

test('课件题可直接选题型，窄窗口优先显示收答控制和待收卡号',async()=>{
  const {page,context,fixture}=await open({width:390,scannerFixture:true});
  try {
    await page.locator('#first-template').selectOption('boolean:2');
    await create(page);
    assert.equal(fixture.journals[0].session.questions[0].type,'boolean');
    await page.locator('#start').click();
    await page.waitForFunction(()=>testScanner.running);
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:1,option:'A'}));
    assert.match(await page.locator('#capture-progress').innerText(),/待收 1 人/);
    await page.locator('#exempt').click();
    assert.match(await page.locator('#exempt-cards label').filter({hasText:'2 号'}).innerText(),/待收/);
    assert.doesNotMatch(await page.locator('#exempt-dialog').innerText(),/私密姓名|不应出现在/);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.locator('#stop').click();
    await page.locator('#next-template').selectOption('single:3');
    await page.locator('#next').click();
    await page.locator('#question-number').filter({hasText:'第 2 题'}).waitFor();
    assert.equal(fixture.journals[0].session.questions[1].options.length,3);
    await noOverflow(page);
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('课堂暂停后可切换设备，同一轮保留已确认的答案',async()=>{
  const {page,context,fixture}=await open({scannerFixture:true});
  try {
    await create(page);
    await page.locator('#start').click();
    await page.waitForFunction(()=>testScanner.running);
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:1,option:'C'}));
    const first=fixture.journals[0].session.currentRoundId;
    await page.locator('#pause').click();
    await page.locator('#source:not([disabled])').click();
    await page.locator('#pair-dialog[open]').waitFor();
    assert.equal(await page.evaluate(()=>testScanner.running),false);
    assert.equal(fixture.journals[0].session.currentRoundId,first);
    assert.equal(fixture.journals[0].session.questions[0].rounds[0].answers.s1.option,'C');
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('启动轮次等待落盘时最小化不会开启摄像头，恢复窗口后重连手机通道',async()=>{
  const {page,context,fixture}=await open({scannerFixture:true});
  const relays=()=>fixture.messages.filter(m=>m.action==='relay').length;
  const setVisibility=visible=>page.evaluate(visible=>{
    Object.defineProperty(document,'hidden',{configurable:true,value:!visible});
    document.dispatchEvent(new Event('visibilitychange'));
    window.__quizReceive({type:'visibility',visible});
  },visible);
  let release;
  try {
    await create(page);
    const started=new Promise(resolve=>fixture.commitStarted=resolve);
    fixture.holdCommit=new Promise(resolve=>release=resolve);
    await page.locator('#start').click();await started;
    await setVisibility(false);release();
    await page.waitForFunction(()=>document.querySelector('#round-status').textContent.includes('已暂停'));
    assert.equal(await page.evaluate(()=>testScanner.starts),0);
    const before=relays();
    await setVisibility(true);
    for(let i=0;i<25&&before===relays();i++) await page.waitForTimeout(100);
    assert.ok(relays()>before,'Returning to the window restarts phone polling');
    assert.equal(await page.evaluate(()=>testScanner.starts),0);
    await page.locator('#start').click();
    await page.waitForFunction(()=>testScanner.running);
    assert.deepEqual(fixture.errors,[]);
  }finally{release?.();await context.close();}
});

test('原班班开课扇区复用开课选项和本机保存，确认前不建课，确认后不要求显示工作台',async()=>{
  const{page,context,fixture}=await open({scannerFixture:true,width:390});
  try{
    const state=await wheel(page);assert.equal(state.actions.length,8);
    assert.deepEqual(state.actions.filter(action=>action.enabled).map(action=>action.label),['开始课堂']);
    assert.match(state.setup.roster,/2 张/);assert.equal(await page.locator('#companion,#wheel-toggle').count(),0);
    assert.ok(state.setup.subjects.some(option=>option.value==='math'));
    await sector(page,'collect');assert.equal(fixture.journals.length,0);
    assert.equal(fixture.messages.some(message=>['commit','pair','relay'].includes(message.action)),false);

    await sector(page,'setup-start',{selection:{publication:'',subject:'invalid',template:'boolean:2'}});
    await page.waitForFunction(()=>window.__quizWheelState.feedback.includes('开课选项已变化'));
    assert.equal(fixture.journals.length,0);
    const selection={publication:'',subject:'math',template:'boolean:2'};
    await sector(page,'setup-start',{selection});await sector(page,'setup-start',{selection});
    await page.waitForFunction(()=>window.__quizWheelState.actions.find(a=>a.id==='collect').label==='开始收答' && window.__quizWheelState.actions.find(a=>a.id==='collect').enabled);
    assert.equal((await wheel(page)).setup,null);assert.equal(fixture.messages.some(message=>message.action==='compact'),false);
    assert.equal(fixture.journals.length,1);assert.equal(fixture.messages.filter(message=>message.action==='commit').length,1);
    assert.equal(fixture.journals[0].session.subjectId,'math');assert.equal(fixture.journals[0].session.questions[0].type,'boolean');
    assert.equal(fixture.journals[0].session.questions[0].rounds.length,0);
    assert.equal(await page.evaluate(()=>testScanner.running),false);await noOverflow(page);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('班班恢复未结束课堂，并保留原题与收答',async()=>{
  const original=await open({scannerFixture:true});
  let journal;
  try{
    await create(original.page);
    await original.page.locator('#start').click();await original.page.locator('#stop:not([disabled])').waitFor();
    await original.page.evaluate(()=>testScanner.options.onRead({cardNumber:1,option:'C'}));
    journal=copy(original.fixture.journals[0]);
  }finally{await original.context.close();}

  const{page,context,fixture}=await open({scannerFixture:true,journals:[journal]});
  try{
    const state=await wheel(page);
    assert.equal(state.actions.find(action=>action.enabled).label,'恢复课堂');assert.equal(state.setup.canCreate,false);
    assert.equal(state.setup.recovery.value,journal.session.id);
    await sector(page,'setup-restore',{sessionId:'stale'});assert.equal(fixture.messages.some(message=>message.action==='commit'),false);
    await sector(page,'setup-restore',{sessionId:journal.session.id});
    await page.waitForFunction(()=>window.__quizWheelState.actions.find(a=>a.id==='collect').label==='恢复本轮' && window.__quizWheelState.actions.find(a=>a.id==='collect').enabled);
    const restored=fixture.journals[0].session;
    assert.equal(fixture.journals.length,1);assert.equal(restored.id,journal.session.id);
    assert.equal(restored.questions[0].rounds[0].status,'paused');assert.equal(restored.questions[0].rounds[0].answers.s1.option,'C');
    assert.equal(await page.evaluate(()=>testScanner.running),false);assert.equal(fixture.messages.some(message=>message.action==='compact'),false);
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('班班从已发布题单开课时沿用题单的学科和首题',async()=>{
  const publication={id:crypto.randomUUID(),title:'演示题单',questions:[{id:crypto.randomUUID(),subjectId:'physics',type:'multiple',options:['甲','乙','丙','丁'],text:'选择正确选项'}]};
  const {page,context,fixture}=await open({scannerFixture:true,publications:[publication]});
  try{
    assert.ok((await wheel(page)).setup.publications.some(option=>option.value===publication.id && option.label.includes(publication.title)));
    await sector(page,'setup-start',{selection:{publication:publication.id,subject:'math',template:'boolean:2'}});
    await page.locator('#workspace:not([hidden])').waitFor();
    const [journal]=fixture.journals;
    assert.equal(journal.publicationId,publication.id);assert.equal(journal.session.subjectId,'physics');
    assert.equal(journal.session.questions[0].bankId,publication.questions[0].id);
    assert.equal(journal.session.questions[0].type,'multiple');assert.equal(fixture.messages.some(message=>message.action==='compact'),false);
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('原班班的收答操作保持圆环，相机持续接收模拟视频',async()=>{
  const{page,context,fixture}=await open({companion:true,width:280,height:280});
  try{
    await startInPet(page);await sector(page,'collect');
    await page.waitForFunction(()=>document.querySelector('#camera')?.srcObject?.getVideoTracks()[0]?.readyState==='live');
    await page.waitForTimeout(4200);
    assert.equal((await wheel(page)).panel,'');
    assert.equal(await page.locator('#camera-status').textContent(),'相机已开启');
    assert.equal(fixture.journals.length,1);assert.equal(fixture.journals[0].session.questions[0].rounds[0].status,'collecting');
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('班班内显示配对码、确认换机、换回本机和按卡号免答',async()=>{
  const{page,context,fixture}=await open({scannerFixture:true,companion:true,width:280,height:280});
  try{
    await startInPet(page);await sector(page,'source');await waitPanel(page,'pair-dialog');
    assert.equal(await page.locator('#pair-qr svg').count(),1);assert.equal(await page.locator('#confirm-phone').isDisabled(),true);
    fixture.pairings=[{pairId:fixture.pairId,claimed:true}];
    await page.locator('#confirm-phone:not([disabled])').click();await waitPanel(page,'');
    assert.equal(fixture.journals[0].session.source,'phone');
    await sector(page,'source');await page.waitForFunction(()=>window.__quizWheelState.actions.some(a=>a.id==='source'&&a.label==='手机扫码'&&a.enabled));
    await sector(page,'collect');await page.waitForFunction(()=>testScanner.running);
    await sector(page,'exempt');await page.locator('#exempt-dialog[open]').waitFor();await page.locator('[data-student="s2"]').check();
    await page.waitForFunction(()=>document.querySelector('#expected').textContent.includes('/ 1'));
    assert.deepEqual(fixture.journals[0].session.questions[0].rounds[0].exempt,['s2']);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('收答中的圆环拒绝换题与换机，封存后同窗选择下一题题型',async()=>{
  const{page,context,fixture}=await open({scannerFixture:true,companion:true,width:280,height:280});
  try{
    await startInPet(page);await sector(page,'collect');await page.waitForFunction(()=>testScanner.running);
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:1,option:'C'}));
    const state=await wheel(page);assert.match(state.progress,/1 \/ 2/);
    assert.equal(state.actions.find(a=>a.id==='next').enabled,false);assert.equal(state.actions.find(a=>a.id==='source').enabled,false);
    assert.equal(state.actions.find(a=>a.id==='collect').label,'结束本轮');
    await sector(page,'next');await sector(page,'source');assert.equal(fixture.journals[0].session.questions.length,1);
    assert.equal(await page.locator('#pair-dialog').isVisible(),false);
    await sector(page,'collect');await page.waitForFunction(()=>document.querySelector('#round-status').textContent==='本轮已封存');
    assert.equal(await page.evaluate(()=>testScanner.running),false);
    assert.equal(fixture.journals[0].session.questions[0].rounds[0].answers.s1.option,'C');
    await sector(page,'next');await waitPanel(page,'next');
    assert.equal(fixture.journals[0].session.questions.length,1);
    await page.locator('#next-template').selectOption('boolean:2');await page.locator('#next').click();
    await page.waitForFunction(()=>document.querySelector('#question-number').textContent.includes('第 2 题'));
    assert.equal(fixture.journals[0].session.questions[1].type,'boolean');
    assert.equal(fixture.journals.length,1);assert.equal(fixture.journals[0].session.questions.length,2);
    assert.doesNotMatch(JSON.stringify(await wheel(page)),/不应出现在|私密姓名/);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('原班班查看分布、设置并揭晓答案、取消结课、汇总与离线重试',async()=>{
  const{page,context,fixture}=await open({scannerFixture:true,companion:true,width:260,height:260});
  try{
    await startInPet(page);await sector(page,'collect');await page.waitForFunction(()=>testScanner.running);
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:1,option:'A'}));
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:2,option:'B'}));
    await sector(page,'collect');await page.waitForFunction(()=>!document.querySelector('#show-distribution').disabled);
    await sector(page,'exempt');await waitPanel(page,'exempt-dialog');
    assert.equal(await page.locator('#exempt-cards input:disabled').count(),2);
    await page.keyboard.press('Escape');await waitPanel(page,'');
    await sector(page,'distribution');await waitPanel(page,'distribution');await noOverflow(page);
    assert.match(await page.locator('#distribution').innerText(),/A · 1 人/);
    await page.locator('#edit').click();await waitPanel(page,'editor');await noOverflow(page);
    await page.locator('#edit-answer').selectOption('B');await page.locator('#question-form [type=submit]').click();await waitPanel(page,'distribution');
    assert.equal(await page.locator('#answer-display').isVisible(),false);
    await page.locator('#reveal').click();await page.locator('#answer-display:not([hidden])').waitFor();
    await page.locator('#pane-back').click();await waitPanel(page,'');
    await sector(page,'end-session');await page.locator('#confirm-dialog[open]').waitFor();await page.locator('#confirm-cancel').click();assert.equal(fixture.journals[0].session.endedAt,null);
    fixture.failSync=true;
    await sector(page,'end-session');await page.locator('#confirm-ok').click();await waitPanel(page,'summary');
    await page.locator('#feedback').filter({hasText:'学校服务暂时离线'}).waitFor();
    assert.match(await page.locator('#summary-questions').innerText(),/已答 2 \/ 2 人/);
    assert.match(await page.locator('#sync-status').innerText(),/待同步/);assert.ok(fixture.journals[0].session.endedAt);
    await page.locator('#return-setup').click();await waitPanel(page,'');
    await sector(page,'end-session');await waitPanel(page,'history');await page.locator('[data-resume]').click();await waitPanel(page,'summary');
    fixture.failSync=false;await page.locator('#sync').click();await page.locator('#sync-status').filter({hasText:'已同步学校服务'}).waitFor();
    assert.equal(fixture.journals.length,1);assert.equal((await context.pages()).length,1);await noOverflow(page);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('顶部主按钮完成两卡三题，多选一键换项，结课回看匿名记录',async()=>{
  const {page,context,fixture}=await open({scannerFixture:true,companion:true,width:280,height:280});
  async function primary(label){
    await page.waitForFunction(label=>window.__quizWheelState.lesson.label===label && window.__quizWheelState.lesson.enabled,label);
    const {lesson,setup}=await wheel(page);
    await sector(page,lesson.primary,{key:lesson.key,selection:setup?.selection,sessionId:setup?.recovery?.value});
  }
  async function scan(first,second){
    await page.waitForFunction(()=>testScanner.running && !window.__quizWheelState.lesson.busy);
    await page.evaluate(async ([a,b])=>{
      await testScanner.options.onRead({cardNumber:1,option:a});
      await testScanner.options.onRead({cardNumber:2,option:b});
    },[first,second]);
    await page.waitForFunction(()=>window.__quizWheelState.lesson.missing.length===0);
  }
  async function next(type){
    await primary('下一题');
    await page.waitForFunction(()=>window.__quizWheelState.lesson.canChooseType && !window.__quizWheelState.lesson.busy);
    await sector(page,'kind-'+type);
    await page.waitForFunction(type=>window.__quizWheelState.lesson.kind===type && !window.__quizWheelState.lesson.busy,type);
  }
  async function distribution(counts){
    await primary('结束收答');
    await page.waitForFunction(()=>window.__quizWheelState.lesson.phase==='result');
    const state=await wheel(page);
    assert.deepEqual(state.lesson.counts,counts);
    assert.equal(state.panel,'');
    assert.doesNotMatch(JSON.stringify(state),/私密姓名|不应出现在/);
  }
  try{
    await primary('开始课堂');
    await primary('开始收答');await scan('A','B');await distribution([1,1,0,0]);
    await next('boolean');await primary('开始收答');await scan('B','A');await distribution([1,1]);
    await next('multiple');await primary('开始收答');await scan('A','B');
    const stale=(await wheel(page)).lesson.key;
    for(const [option,a,b] of [['B','B','A'],['C','A','B'],['D','A','B']]){
      await primary('收 '+option+' 项');
      await page.waitForFunction(opt=>window.__quizWheelState.lesson.option===opt && testScanner.running && !window.__quizWheelState.lesson.busy,option);
      assert.deepEqual((await wheel(page)).lesson.missing,[1,2]);
      await sector(page,'multi',{key:stale});
      await scan(a,b);
    }
    await distribution([1,1,1,1]);
    await sector(page,'finish-confirmed',{key:(await wheel(page)).lesson.key});
    await page.waitForFunction(()=>window.__quizWheelState.lesson.phase==='done' && !window.__quizWheelState.lesson.needsSync);
    const result=await wheel(page);
    assert.equal(result.lesson.records.length,3);assert.deepEqual(result.lesson.records[2].counts,[1,1,1,1]);
    assert.deepEqual(fixture.journals[0].session.questions.map(q=>Object.values(q.rounds[0].answers).map(a=>a.option)),[['A','B'],['B','A'],['ACD','B']]);
    assert.ok(fixture.journals[0].session.questions.every(q=>!q.revealed));
    assert.equal((await context.pages()).length,1);assert.deepEqual(fixture.errors,[]);
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

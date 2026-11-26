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

async function open({width=1160,height=820,companion=false,journals=[],publications=[],students,cardMode='assigned',failCommit=false,scannerFixture=false,touch=false,quickScan=false,endpoint=origin}={}){
  const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',hasTouch:touch}),page=await context.newPage();
  const fixture={journals:copy(journals),failCommit,commands:[],messages:[],errors:[],synced:0,pairings:[]};
  const publicationSummaries=publications.map(({id,title,questions})=>({id,title,questionCount:questions.length,cached:true}));
  const base={classId:'c1',deviceId:'d1',className:'隔离演示班',endpoint,context:{classId:'c1',deviceId:'d1',students:students ?? [{id:'s1',name:'不应出现在教室报告中的姓名',cardNumber:1},{id:'s2',name:'私密姓名乙',cardNumber:2}],publications:publicationSummaries},errors:[]};
  const load=()=>copy({...base,journals:fixture.journals});
  await page.exposeFunction('__quizNative',async message=>{
    fixture.messages.push(copy(message));
    if(message.type)return null;
    const body=message.body||{};
    switch(message.action){
      case'load':case'bootstrap':return load();
      case'publication':return {publication:copy(publications.find(publication=>publication.id===body.id)),images:fixture.images || {}};
      case'commit':{
        const hold = fixture.holdCommit;
        if (hold) { fixture.holdCommit = null; fixture.commitStarted(); await hold; }
        if(fixture.failCommit)throw new Error('隔离检查：磁盘不可写');
        const j=copy(body.journal),index=fixture.journals.findIndex(x=>x.session.id===j.session.id);
        if(index>=0)fixture.journals[index]=j;else fixture.journals.push(j);
        if(fixture.loseCommitReply)throw new Error('隔离检查：写入后回执丢失');
        return j;
      }
      case'sync':{
        if (fixture.holdSync) await fixture.holdSync;
        if (fixture.failSync) throw new Error('学校服务暂时离线');
        fixture.journals.forEach(j=>j.syncedSeq=j.session.seq);return load();
      }
      case'sync-session':{
        const journal=fixture.journals.find(j=>j.session.id===body.sessionId);
        const syncedSeq=journal.session.seq;
        if (fixture.beforeSyncSession) await fixture.beforeSyncSession(journal.session);
        journal.syncedSeq=syncedSeq;
        return {syncedSeq};
      }
      case'relay':{const commands=fixture.commands.splice(0);return{commands,pairings:fixture.pairings,...await fixture.relay?.(body)};}
      case'pair':
        if (fixture.beforePair) await fixture.beforePair();
        fixture.pairId=crypto.randomUUID();
        if(quickScan){
          fixture.scanUrl=(fixture.inviteOrigin ?? endpoint)+'/card-quiz/phone.html#scan='+crypto.randomUUID().replaceAll('-','');
          return {pairId:fixture.pairId,mode:'scan',url:fixture.scanUrl,expiresAt:Date.now()+(fixture.lifetime??300000)};
        }
        return{pairId:fixture.pairId,code:'482915',url:'https://school.example/card-quiz/phone.html#pair=isolated',expiresAt:Date.now()+300000};
      case'cancel-pair':fixture.pairings=fixture.pairings.filter(p=>p.pairId!==body.pairId);return {ok:true};
      default:throw new Error('未预期的原生操作：'+message.action);
    }
  });
  await page.addInitScript(()=>{
    const listeners=[];window.chrome ||= {};
    window.__quizReceive=value=>listeners.forEach(fn=>fn({data:value}));
    window.chrome.webview={addEventListener(type,fn){if(type==='message')listeners.push(fn);},postMessage(message){
      if(message.type==='companion-state')window.__quizWheelState=message.state;
      if(message.type==='suspended')(window.__quizSuspendReplies??=[]).push(message);
      if(message.action==='cancel-pair')(window.__quizCancelledPairs??=[]).push(message.body.pairId);
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
  // Existing classroom fixtures exercise personal cards. A null choice exercises the production default.
  if(cardMode && !journals.length && !await page.locator('#card-mode-field').evaluate(field=>field.hidden))
    await page.locator('#card-mode').selectOption(cardMode,{force:true});
  return{page,context,fixture};
}
async function create(page){await page.locator('#create-session').click();await page.locator('#workspace:not([hidden])').waitFor();await page.locator('#start:not([disabled])').waitFor();}
async function noOverflow(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');}

async function sector(page,action,payload={}){await page.evaluate(value=>window.__quizReceive(value),{type:'companion-action',action,...payload});}
async function wheel(page){return page.evaluate(()=>window.__quizWheelState);}
async function suspendReply(page,id) {
  await page.evaluate(id=>__quizReceive({type:'suspend',suspendId:id}),id);
  const reply = await page.waitForFunction(id=>window.__quizSuspendReplies?.find(item=>item.suspendId===id),id);
  return (await reply.jsonValue()).saved;
}
async function startInPet(page,template='single:4'){
  await sector(page,'setup-start',{selection:{publication:'',subject:'math',template}});
  await page.waitForFunction(()=>window.__quizWheelState.actions.some(a=>a.id==='collect'&&a.label==='开始收答'&&a.enabled));
}
async function waitPanel(page,name){
  await page.waitForFunction(name=>window.__quizWheelState.panel===name,name);
}
async function waitPhoneCode(page) {
  await page.locator('#pair-qr svg').waitFor({state:'attached'});
}
async function openClassCards(page) {
  await sector(page,'missing'); await waitPanel(page,'exempt-dialog');
  assert.ok((await wheel(page)).cardPanel.pendingOnly);
  await sector(page,'card-scope',{key:(await wheel(page)).lesson.key});
  assert.equal((await wheel(page)).cardPanel.pendingOnly,false);
}

async function useNativeDisc(page) {
  await page.evaluate(() => window.__quizReceive({type:'visibility',visible:true,nativeDisc:true}));
}

async function detailPage(page, panel, layout) {
  await page.waitForFunction(([panel, layout]) => __quizWheelState.panel === panel && __quizWheelState.discPage?.layout === layout, [panel, layout]);
  const {discPage} = await wheel(page);
  assert.ok(discPage.key && discPage.title);
  assert.ok(discPage.items.length <= (layout === 'ring' ? 8 : 2));
  assert.equal(new Set(discPage.items.map(item => item.id)).size, discPage.items.length);
  assert.ok(discPage.items.every(item => item.id !== 'back' && item.label && item.name && (item.mark || item.icon)));
  return discPage;
}

async function detailAction(page, id) {
  await page.waitForFunction(id => __quizWheelState.discPage &&
    (id === 'back' || __quizWheelState.discPage.items.some(item => item.id === id && item.enabled)), id);
  const {discPage, lesson} = await wheel(page);
  await sector(page, id === 'back' ? 'back' : 'disc-' + id, {pageKey:discPage.key, key:lesson.key});
}

test('九班空名单从原生圆环首题直接扫，开放卡号图实时补卡，封存保留各轮人数',async()=>{
  const {page,context,fixture}=await open({width:390,companion:true,students:[],cardMode:null,scannerFixture:true});
  const read=(cardNumber,option='A')=>page.evaluate(read=>testScanner.options.onRead(read),{cardNumber,option});
  try {
    await useNativeDisc(page);
    assert.equal((await wheel(page)).setup.selection.cardMode,'scanned');
    await startInPet(page,'boolean:2');
    await sector(page,'collect');
    await page.waitForFunction(()=>testScanner.running);
    await read(1); await read(1,'B');
    assert.equal((await wheel(page)).lesson.received,1);
    assert.equal((await wheel(page)).lesson.hasPriorParticipants,false);
    assert.doesNotMatch((await wheel(page)).progress,/收齐|1\s*\/\s*1/);
    await sector(page,'missing'); await waitPanel(page,'exempt-dialog');
    assert.equal((await wheel(page)).cardPanel.pendingOnly,false);
    await read(2);
    assert.deepEqual((await wheel(page)).cardPanel.cards.map(c=>c.number),[1,2]);
    await sector(page,'dismiss');
    await sector(page,'collect');
    await page.waitForFunction(()=>__quizWheelState.lesson.phase==='result');
    await sector(page,'advance');
    await page.waitForFunction(()=>__quizWheelState.lesson.phase==='ready');
    await sector(page,'collect');
    await page.waitForFunction(()=>testScanner.running);
    await read(47);
    const lesson=(await wheel(page)).lesson;
    assert.equal(lesson.hasPriorParticipants,true);
    assert.deepEqual([lesson.received,lesson.expected],[1,3]);
    assert.equal(lesson.participantCount,3);
    assert.deepEqual(lesson.missing,[1,2]);
    await sector(page,'finish-confirmed');
    await page.waitForFunction(()=>__quizWheelState.lesson.phase==='done');
    const s=fixture.journals[0].session;
    assert.deepEqual(s.questions.map(q=>q.rounds[0].participantCount),[2,3]);
    assert.deepEqual((await wheel(page)).lesson.records.map(r=>r.abstained),[0,2]);
    assert.deepEqual((await wheel(page)).lesson.records.map(r=>[r.received,r.expected]),[[2,2],[1,3]]);
    await noOverflow(page);assert.deepEqual(fixture.errors,[]);
  } finally {await context.close();}
});

test('通用单选首题恢复和重收按开轮前的参与人数区分，免答实时扣除',async()=>{
  const {page,context,fixture}=await open({companion:true,students:[],scannerFixture:true});
  const read=(cardNumber,option='A')=>page.evaluate(value=>testScanner.options.onRead(value),{cardNumber,option});
  const collect=async()=>{
    await sector(page,'collect');
    await page.waitForFunction(()=>testScanner.running && !__quizWheelState.lesson.busy);
  };
  async function checkCounts(prior,received,expected,participants) {
    const lesson=(await wheel(page)).lesson;
    assert.deepEqual([lesson.hasPriorParticipants,lesson.received,lesson.expected,lesson.participantCount],
      [prior,received,expected,participants]);
  }
  try {
    await useNativeDisc(page); await startInPet(page,'single:3'); await collect();
    await checkCounts(false,0,0,0);
    await read(7); await read(15); await read(7,'C');
    await checkCounts(false,2,2,2);
    await page.reload();
    await page.waitForFunction(()=>window.__quizWheelState?.setup?.recovery);
    await useNativeDisc(page); await sector(page,'setup-restore',{sessionId:fixture.journals[0].session.id});
    await page.waitForFunction(()=>__quizWheelState.lesson.phase==='paused' && !__quizWheelState.lesson.busy);
    await checkCounts(false,2,2,2);
    await collect(); await sector(page,'collect');
    await page.waitForFunction(()=>__quizWheelState.lesson.phase==='result' && !__quizWheelState.lesson.busy);
    await collect(); await checkCounts(true,0,2,2);
    await read(15); await read(47); await read(47,'B');
    await checkCounts(true,2,3,3);
    await sector(page,'missing'); await waitPanel(page,'exempt-dialog');
    assert.equal((await wheel(page)).cardPanel.pendingOnly,false);
    await sector(page,'card-locate',{cardNumber:7});
    for (const [n,received,expected] of [[7,2,2],[15,1,1],[47,0,0]]) {
      await sector(page,'card-toggle',{cardNumber:n});
      await page.waitForFunction(e=>!__quizWheelState.lesson.busy && __quizWheelState.lesson.expected===e,expected);
      await checkCounts(true,received,expected,3);
    }
    await sector(page,'dismiss'); await sector(page,'collect');
    await page.waitForFunction(()=>__quizWheelState.lesson.phase==='result' && !__quizWheelState.lesson.busy);
    const result=(await wheel(page)).lesson;
    assert.deepEqual([result.received,result.expected,result.participantCount,result.abstained,result.primary],[0,0,3,0,'advance']);
    assert.deepEqual(fixture.journals[0].session.questions[0].rounds.map(r=>r.participantCount),[2,3]);
    assert.deepEqual(fixture.errors,[]);
  } finally {await context.close();}
});

test('通用单选零卡封存后跳到第二题，首张卡仍无此前参与基数',async()=>{
  const {page,context}=await open({companion:true,students:[],scannerFixture:true});
  try {
    await useNativeDisc(page); await startInPet(page);
    await sector(page,'collect'); await page.waitForFunction(()=>testScanner.running && !__quizWheelState.lesson.busy);
    await sector(page,'collect'); await page.waitForFunction(()=>__quizWheelState.lesson.phase==='result' && !__quizWheelState.lesson.busy);
    const empty=(await wheel(page)).lesson;
    assert.deepEqual([empty.received,empty.expected,empty.participantCount,empty.primary],[0,0,0,'collect']);
    await sector(page,'advance'); await page.waitForFunction(()=>__quizWheelState.lesson.phase==='ready' && !__quizWheelState.lesson.busy);
    await sector(page,'collect'); await page.waitForFunction(()=>testScanner.running && !__quizWheelState.lesson.busy);
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:47,option:'A'}));
    const next=(await wheel(page)).lesson;
    assert.deepEqual([next.number,next.hasPriorParticipants,next.received,next.participantCount],[2,false,1,1]);
  } finally {await context.close();}
});

for (const count of [2,3,4]) {
  test(`通用多选 ${count} 项按实际阶段切换、回改，只在教师封存时结束`,async()=>{
    const {page,context,fixture}=await open({companion:true,students:[],scannerFixture:true});
    const options='ABCD'.slice(0,count);
    const read=(cardNumber,option)=>page.evaluate(value=>testScanner.options.onRead(value),{cardNumber,option});
    async function checkStage(option,received) {
      await page.waitForFunction(opt=>__quizWheelState.lesson.option===opt && !__quizWheelState.lesson.busy,option);
      const {lesson,progress}=await wheel(page);
      assert.deepEqual([lesson.phase,lesson.optionCount,lesson.received],['collect',count,received]);
      assert.match(progress,new RegExp('本项已收 '+received+' 人'));
      assert.equal(lesson.label,option===options.at(-1) ? '结束收答' : '下一项 '+options[options.indexOf(option)+1]);
    }
    try {
      await useNativeDisc(page); await startInPet(page,'multiple:'+count);
      await sector(page,'collect'); await checkStage('A',0);
      await read(1,'A'); await read(2,'B'); await checkStage('A',2);
      for (const option of options.slice(1)) { await sector(page,'multi'); await checkStage(option,0); }
      await read(3,'A'); await checkStage(options.at(-1),1);
      await sector(page,'missing'); await waitPanel(page,'exempt-dialog');
      assert.equal((await wheel(page)).cardPanel.pendingOnly,false);
      await sector(page,'dismiss'); await sector(page,'options'); await detailPage(page,'options','ring');
      await detailAction(page,'collect-a'); await checkStage('A',2);
      await read(1,'B'); await checkStage('A',2);
      await sector(page,'seal'); await page.waitForFunction(()=>__quizWheelState.lesson.phase==='result' && !__quizWheelState.lesson.busy);
      const result=(await wheel(page)).lesson;
      assert.deepEqual([result.received,result.expected,result.abstained],[3,3,0]);
      assert.deepEqual(result.bars,[{label:'全不选',count:2},{label:options.at(-1),count:1}]);
      assert.deepEqual(fixture.errors,[]);
    } finally {await context.close();}
  });
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
    assert.equal(await page.locator('#card-mode').inputValue(),'scanned');
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
    assert.match(state.setup.roster,/2 张/);assert.equal(state.setup.cardCount,2);
    assert.equal(await page.locator('#companion,#wheel-toggle').count(),0);
    assert.ok(state.setup.subjects.some(option=>option.value==='math'));
    await sector(page,'setup-refresh');
    await page.waitForFunction(()=>window.__quizWheelState.setup?.refreshed && window.__quizWheelState.setup.canCreate);
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
    assert.equal(state.setup.cardCount,null);
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

test('班班从已发布题单开课，预览下一题缓存配图后可直接加题',async()=>{
  const imageId=crypto.randomUUID();
  const publication={id:crypto.randomUUID(),title:'演示题单',questions:[
    {id:crypto.randomUUID(),subjectId:'physics',type:'multiple',options:['甲','乙','丙','丁'],text:'选择正确选项'},
    {id:crypto.randomUUID(),subjectId:'physics',type:'single',options:['甲\r\n二行\n三行','乙'],text:'依据配图作答',imageId}]};
  const {page,context,fixture}=await open({companion:true,scannerFixture:true,publications:[publication]});
  try{
    await useNativeDisc(page);
    fixture.images = {[imageId]:await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width=96; canvas.height=48;
      canvas.getContext('2d').fillRect(12,12,24,24); return canvas.toDataURL();
    })};
    assert.ok((await wheel(page)).setup.publications.some(option=>option.value===publication.id && option.label.includes(publication.title)));
    await sector(page,'setup-start',{selection:{publication:publication.id,subject:'math',template:'boolean:2'}});
    await page.locator('#workspace:not([hidden])').waitFor();
    const [journal]=fixture.journals;
    assert.equal(journal.publicationId,publication.id);assert.equal(journal.session.subjectId,'physics');
    assert.equal(journal.session.questions[0].bankId,publication.questions[0].id);
    assert.equal(journal.session.questions[0].type,'multiple');assert.equal(fixture.messages.some(message=>message.action==='compact'),false);
    await sector(page,'next'); await detailAction(page,'read-image');
    await detailPage(page,'next','reader');
    const image=page.getByAltText('题目配图',{exact:true}).filter({visible:true});
    assert.equal(await image.getAttribute('src'),fixture.images[imageId]);
    assert.equal(await image.evaluate(async node => { await node.decode(); return node.naturalWidth; }),96);
    await detailAction(page,'back'); await detailAction(page,'add-next'); await waitPanel(page,'');
    assert.equal(fixture.journals[0].session.questions[1].imageId,imageId);
    await sector(page,'edit'); await detailAction(page,'edit'); await detailAction(page,'answer-b');
    await detailAction(page,'fields'); await detailAction(page,'options'); await detailAction(page,'option-a');
    await detailPage(page,'editor','reader');
    assert.equal(await page.locator('#editor .disc-columns [data-editor-visible]').filter({hasText:'三行'}).last().textContent(),publication.questions[1].options[0]);
    await detailAction(page,'back'); await detailAction(page,'back'); await detailAction(page,'back');
    await detailAction(page,'save'); await detailPage(page,'question','ring');
    assert.equal(fixture.journals[0].session.questions[1].answer,'B');
    assert.deepEqual(fixture.journals[0].session.questions[1].options,publication.questions[1].options);
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
    await startInPet(page);await sector(page,'source');await waitPhoneCode(page);
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

test('模拟班在圆心提示真机入口，不签发邀请或显示本机链接',async()=>{
  const {page,context,fixture}=await open({companion:true,quickScan:true,endpoint:'http://127.0.0.1:8964',width:178,height:140});
  try {
    await useNativeDisc(page); await startInPet(page); await sector(page,'source'); await waitPanel(page,'pair-dialog');
    const dialog=page.locator('#pair-dialog');
    assert.match(await dialog.innerText(),/纸卡测试班/);
    assert.doesNotMatch(await dialog.innerText(),/https?:|#scan=/);
    assert.equal(await dialog.locator('svg,button:visible').count(),0);
    assert.equal(fixture.messages.some(m=>m.action==='pair'),false);
    assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1 && el.scrollHeight<=el.clientHeight+1));
    await page.keyboard.press('Escape'); await waitPanel(page,'');
    assert.equal(fixture.journals[0].session.source,'board');
  } finally {await context.close();}
});

test('圆心显示完整的学校二维码，服务返回不可用的手机地址就撤回',async()=>{
  const {page,context,fixture}=await open({companion:true,quickScan:true,width:178,height:140});
  try {
    await useNativeDisc(page); await startInPet(page); await sector(page,'source'); await waitPhoneCode(page);
    const qr=page.locator('#pair-qr svg');
    const rect=await qr.boundingBox();
    assert.ok(rect && rect.width>=128 && rect.width===rect.height && rect.x>=0 && rect.y>=0 && rect.x+rect.width<=178 && rect.y+rect.height<=140);
    assert.doesNotMatch(await page.locator('#pair-dialog').innerText(),/#scan=|https?:/);
    await sector(page,'back'); await waitPanel(page,'');
    for (const address of ['https://[::1]','http://school.example']) {
      fixture.inviteOrigin=address;
      await sector(page,'source'); await waitPanel(page,'pair-dialog');
      await page.locator('#pair-dialog .disc-reader').getByText(/纸卡测试班|HTTPS 地址/).waitFor();
      assert.equal(await qr.count(),0);
      assert.equal(await page.locator('#confirm-phone').isVisible(),false);
      assert.doesNotMatch(await page.locator('#pair-dialog').innerText(),/#scan=|https?:/);
      assert.ok(fixture.messages.some(m=>m.action==='cancel-pair' && m.body.pairId===fixture.pairId));
      await sector(page,'back'); await waitPanel(page,'');
    }
    assert.deepEqual(fixture.errors,[]);
  } finally {await context.close();}
});

test('关掉或收起班班就撤回待扫的码，过期后手机不能接管',async()=>{
  const {page,context,fixture}=await open({companion:true,quickScan:true,scannerFixture:true});
  try {
    await startInPet(page);
    for (const action of ['back','suspend','exit','expire']) {
      if(action==='expire')fixture.lifetime=1000;
      await sector(page,'source');await waitPhoneCode(page);
      const pid=fixture.pairId;
      if(action==='suspend')
        await page.evaluate(()=>window.__quizReceive({type:'visibility',visible:false}));
      else if(action==='exit') {
        assert.equal(await suspendReply(page,17),true);
        const sent=fixture.messages.map(m=>m.action==='cancel-pair' && m.body.pairId===pid?'cancel':m.type==='suspended' && m.suspendId===17?'exit':'');
        assert.deepEqual(sent.filter(Boolean),['cancel','exit']);
      }
      else if(action==='back')await sector(page,'back');
      else {
        await page.locator('#pair-status').getByText(/已过期/).waitFor();
        assert.equal(await page.locator('#pair-qr').isVisible(),false);
        await sector(page,'back');
      }
      await waitPanel(page,'');
      assert.ok(fixture.messages.some(m=>m.action==='cancel-pair'&&m.body.pairId===pid));
      // A delayed claim from the discarded QR must not select that phone.
      fixture.pairings=[{pairId:pid,claimed:true}];
      if(action==='suspend' || action==='exit')await page.evaluate(()=>window.__quizReceive({type:'visibility',visible:true}));
      await page.waitForTimeout(900);
      assert.equal(fixture.journals[0].session.source,'board');
    }
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('扫码直接恢复暂停的一轮，连接已封存的课堂时保留原结果',async()=>{
  const {page,context,fixture}=await open({quickScan:true,scannerFixture:true});
  try {
    await create(page);await page.locator('#start').click();
    await page.waitForFunction(()=>testScanner.running);
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:1,option:'A'}));
    const roundId=fixture.journals[0].session.currentRoundId;
    await page.locator('#pause').click();await page.locator('#source').click();
    await waitPhoneCode(page);
    fixture.pairings=[{pairId:fixture.pairId,claimed:true}];
    await page.getByText('手机收答中，白板保存后确认',{exact:true}).waitFor();
    assert.equal(fixture.journals[0].session.currentRoundId,roundId);
    assert.equal(fixture.journals[0].session.questions[0].rounds[0].answers.s1.option,'A');
    await page.locator('#stop').click();await page.locator('#source').click();
    await page.waitForFunction(()=>document.getElementById('source').textContent.includes('使用手机'));
    await page.locator('#source').click();await waitPhoneCode(page);
    fixture.pairings=[{pairId:fixture.pairId,claimed:true}];
    await page.locator('#pair-dialog').waitFor({state:'hidden'});
    const rounds=fixture.journals[0].session.questions[0].rounds;
    assert.equal(rounds.length,1);assert.equal(rounds[0].status,'closed');
    assert.deepEqual(fixture.errors,[]);
  } finally {await context.close();}
});

test('电脑取景独立于识卡节拍，收起停止绘制而摄像头继续采集',async()=>{
  const {page,context,fixture}=await open({companion:true});
  try {
    await useNativeDisc(page); await startInPet(page);
    await sector(page,'collect',{key:(await wheel(page)).lesson.key});
    await page.waitForFunction(()=>window.__quizWheelState.preview?.phone===false);
    const count=()=>fixture.messages.filter(m=>m.type==='preview-frame').length;
    await page.waitForTimeout(450);
    const before=count();
    await page.waitForTimeout(2000);
    assert.ok(count()-before>=26,'20 fps 模拟摄像头在两秒内应交付至少 26 帧');
    const key=(await wheel(page)).preview.key;
    await sector(page,'preview-fold',{key});
    await page.waitForFunction(()=>__quizWheelState.preview.folded);
    await page.waitForTimeout(100);
    const folded=count();
    await page.waitForTimeout(350);
    assert.equal(count(),folded);
    assert.equal(await page.locator('#camera').evaluate(v=>v.srcObject.active),true);
    await sector(page,'preview-open',{key});
    await page.waitForTimeout(400);
    assert.ok(count()>folded);
  } finally {await context.close();}
});

test('等待电脑相机授权时可取消取景，迟到的授权释放镜头',async()=>{
  const {page,context}=await open({companion:true});
  try {
    await useNativeDisc(page); await startInPet(page);
    await page.evaluate(()=>{
      const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async options=>{
        await new Promise(resolve=>{window.grantCamera=resolve;});
        const stream=await get(options); window.grantedTrack=stream.getVideoTracks()[0]; return stream;
      };
    });
    await sector(page,'collect');await page.waitForFunction(()=>__quizWheelState.preview?.phone===false);
    await sector(page,'preview-stop',{key:(await wheel(page)).preview.key});
    assert.equal((await wheel(page)).preview,null,'等待授权时也可关掉取景框');
    await page.evaluate(()=>grantCamera());
    await page.waitForFunction(()=>window.grantedTrack?.readyState==='ended' && !__quizWheelState.lesson.busy);
    assert.equal((await wheel(page)).lesson.primary,'open-camera');
  } finally {await context.close();}
});

test('从电脑取景获取手机码期间继续收卡，返回后撤回迟到的二维码',async()=>{
  const {page,context,fixture}=await open({companion:true,quickScan:true,scannerFixture:true,width:178,height:140});
  let releasePair;
  try {
    await useNativeDisc(page); await startInPet(page);
    await sector(page,'collect');
    await page.waitForFunction(()=>__quizWheelState.cameraRunning && !__quizWheelState.lesson.busy);
    const pairStarted = new Promise(resolve => {
      fixture.beforePair = () => new Promise(release => { releasePair = release; resolve(); });
    });
    await sector(page,'preview-phone',{key:(await wheel(page)).preview.key});
    await pairStarted;
    assert.equal((await wheel(page)).lesson.phase,'collect');
    assert.equal((await wheel(page)).preview.phone,false);
    await waitPanel(page,'pair-dialog');
    assert.match(await page.locator('#pair-dialog').innerText(),/正在获取二维码/);
    assert.ok(await page.locator('#pair-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1 && el.scrollHeight<=el.clientHeight+1));
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:1,option:'C'}));
    await page.keyboard.press('Escape'); await waitPanel(page,'');
    assert.equal(fixture.journals[0].session.questions[0].rounds[0].answers.s1.option,'C');
    fixture.beforePair = null;
    await sector(page,'preview-phone',{key:(await wheel(page)).preview.key});
    await waitPanel(page,'pair-dialog');
    assert.equal(fixture.messages.filter(message=>message.action==='pair').length,1);
    releasePair();
    await page.waitForFunction(()=>window.__quizCancelledPairs?.length===1,undefined,{timeout:2500});
    const [oldPair] = await page.evaluate(()=>window.__quizCancelledPairs);
    await waitPhoneCode(page);
    assert.notEqual(oldPair,fixture.pairId);
    assert.ok(!fixture.messages.some(message=>message.action==='cancel-pair' && message.body.pairId===fixture.pairId));
    assert.equal(fixture.journals[0].session.source,'board');
  } finally { releasePair?.(); await context.close(); }
});

test('二维码申请失败仍用电脑收答，同一轮可重新扫码接力',async()=>{
  const {page,context,fixture}=await open({companion:true,quickScan:true,scannerFixture:true});
  try {
    await useNativeDisc(page); await startInPet(page);
    await sector(page,'collect');
    await page.waitForFunction(()=>__quizWheelState.cameraRunning && !__quizWheelState.lesson.busy);
    const initial = fixture.journals[0].session.currentRoundId;
    fixture.beforePair = () => { throw new Error('获取二维码超时。'); };
    await sector(page,'preview-phone',{key:(await wheel(page)).preview.key});
    await page.locator('#pair-dialog .disc-reader').getByText(/获取二维码超时/).waitFor({timeout:2500});
    assert.equal((await wheel(page)).cameraRunning,true);
    assert.equal(await page.locator('#pair-qr svg').count(),0);
    await sector(page,'back'); await waitPanel(page,'');
    fixture.beforePair = null;
    await sector(page,'preview-phone',{key:(await wheel(page)).preview.key});
    await waitPhoneCode(page);
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:2,option:'B'}));
    assert.equal(await page.locator('#pair-qr svg').count(),1);
    fixture.beforeSyncSession = async session => {
      assert.equal(session.currentRoundId,initial);
      assert.equal(session.questions[0].rounds[0].status,'paused');
      assert.equal(session.sourceId,fixture.pairId);
      assert.equal((await wheel(page)).preview?.phone ?? false,false);
    };
    fixture.pairings=[{pairId:fixture.pairId,claimed:true}];
    await page.waitForFunction(()=>__quizWheelState.preview?.phone && !__quizWheelState.lesson.busy);
    const session = fixture.journals[0].session;
    assert.equal(session.currentRoundId,initial);
    assert.equal(session.questions[0].rounds[0].answers.s2.option,'B');
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('已显示的手机码在学校连接中断后撤下，同一轮继续收答', async () => {
  const {page,context,fixture} = await open({companion:true,quickScan:true,scannerFixture:true,width:178,height:140});
  let unblockRelay;
  try {
    await page.clock.install();
    await useNativeDisc(page);
    await startInPet(page);
    await sector(page,'collect');
    await page.waitForFunction(() => __quizWheelState.cameraRunning && !__quizWheelState.lesson.busy);
    const roundId = fixture.journals[0].session.currentRoundId;
    const stalled = new Promise(resolve => { unblockRelay = resolve; });
    const relayStarted = new Promise(resolve => {
      fixture.relay = async () => {
        resolve();
        await stalled;
        throw new Error('学校连接已中断');
      };
    });
    await sector(page,'preview-phone',{key:(await wheel(page)).preview.key});
    await waitPhoneCode(page);
    const oldPair = fixture.pairId;
    await relayStarted;
    await page.clock.fastForward(1000);
    assert.equal(await page.locator('#pair-qr svg').count(),1,'短时延迟保留已有二维码');
    await page.clock.fastForward(9000);
    assert.equal(await page.locator('#pair-qr svg').count(),0,'失联时撤下原二维码');
    const dialog = page.locator('#pair-dialog');
    assert.match(await dialog.innerText(),/连接已中断/);
    assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1));
    assert.equal((await wheel(page)).cameraRunning,true);
    await page.evaluate(() => testScanner.options.onRead({cardNumber:1,option:'C'}));
    await page.keyboard.press('Escape');
    await waitPanel(page,'');
    fixture.relay = null;
    unblockRelay();
    await sector(page,'preview-phone',{key:(await wheel(page)).preview.key});
    await waitPhoneCode(page);
    assert.notEqual(fixture.pairId,oldPair);
    fixture.pairings = [{pairId:oldPair,claimed:true},{pairId:fixture.pairId,claimed:true}];
    await page.waitForFunction(() => __quizWheelState.preview?.phone && !__quizWheelState.lesson.busy);
    const lesson = fixture.journals[0].session;
    assert.equal(lesson.sourceId,fixture.pairId);
    assert.equal(lesson.currentRoundId,roundId);
    assert.equal(lesson.questions[0].rounds[0].answers.s1.option,'C');
    assert.deepEqual(fixture.errors,[]);
  } finally {
    unblockRelay?.();
    await context.close();
  }
});

test('扫码后本堂同步超时会恢复电脑相机，原多选项和已收卡保留',async()=>{
  const {page,context,fixture}=await open({companion:true,quickScan:true,scannerFixture:true});
  try {
    await useNativeDisc(page); await startInPet(page,'multiple:3');
    await sector(page,'collect');
    await page.waitForFunction(()=>__quizWheelState.cameraRunning && !__quizWheelState.lesson.busy);
    await sector(page,'multi');
    await page.waitForFunction(()=>__quizWheelState.cameraRunning && __quizWheelState.lesson.option==='B' && !__quizWheelState.lesson.busy);
    const initial=fixture.journals[0].session.currentRoundId;
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:1,option:'A'}));
    await sector(page,'preview-phone',{key:(await wheel(page)).preview.key});
    await waitPhoneCode(page);
    fixture.beforeSyncSession = () => { throw new Error('本堂课同步超时。'); };
    fixture.pairings=[{pairId:fixture.pairId,claimed:true}];
    await page.locator('#pair-dialog .disc-reader').getByText(/本堂课同步超时/).waitFor({timeout:4000});
    await page.waitForFunction(()=>__quizWheelState.cameraRunning && !__quizWheelState.lesson.busy);
    await sector(page,'back'); await waitPanel(page,'');
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:2,option:'B'}));
    const session=fixture.journals[0].session, result=session.questions[0].rounds[0];
    assert.deepEqual([session.source,session.currentRoundId,result.activeOption,result.status],['board',initial,'B','collecting']);
    assert.deepEqual([result.answers.s1.choices.B,result.answers.s2.choices.B],[true,false]);
    assert.ok(fixture.messages.some(message=>message.action==='cancel-pair' && message.body.pairId===fixture.pairId));
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('扫码后主动返回可立即恢复电脑，迟到的同步确认不再换源',async()=>{
  const {page,context,fixture}=await open({companion:true,quickScan:true,scannerFixture:true});
  let releaseSync;
  try {
    await useNativeDisc(page); await startInPet(page); await sector(page,'collect');
    await page.waitForFunction(()=>__quizWheelState.cameraRunning && !__quizWheelState.lesson.busy);
    const roundId=fixture.journals[0].session.currentRoundId;
    const syncing=new Promise(resolve=>{
      fixture.beforeSyncSession=session=>session.source==='phone' && new Promise(release=>{releaseSync=release;resolve();});
    });
    await sector(page,'preview-phone',{key:(await wheel(page)).preview.key});
    await waitPhoneCode(page);
    fixture.pairings=[{pairId:fixture.pairId,claimed:true}];
    await syncing;
    const syncRequest=fixture.messages.findLast(message=>message.action==='sync-session').id;
    await page.evaluate(id=>{
      window.chrome.webview.addEventListener('message',event=>{
        if(event.data.type==='response' && event.data.id===id) window.lateHandoffSync=true;
      });
    },syncRequest);
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>__quizWheelState.cameraRunning && !__quizWheelState.panel && !__quizWheelState.lesson.busy,undefined,{timeout:2500});
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:1,option:'D'}));
    releaseSync();
    await page.waitForFunction(()=>window.lateHandoffSync);
    const session=fixture.journals[0].session;
    assert.deepEqual([session.source,session.currentRoundId,session.questions[0].rounds[0].answers.s1.option],['board',roundId,'D']);
    assert.ok(fixture.messages.some(message=>message.action==='cancel-pair' && message.body.pairId===fixture.pairId));
    assert.deepEqual(fixture.errors,[]);
  } finally { releaseSync?.(); await context.close(); }
});

test('手机取景与本轮收答同时出现，等待连接时可收起，封存立即清屏',async()=>{
  const {page,context,fixture}=await open({companion:true,quickScan:true});
  try {
    await useNativeDisc(page); await startInPet(page,'boolean:2');
    await sector(page,'source'); await waitPhoneCode(page);
    fixture.pairings=[{pairId:fixture.pairId,claimed:true}];
    await page.waitForFunction(()=>__quizWheelState.lesson.phase==='collect' && !__quizWheelState.lesson.busy);
    const started=fixture.messages.find(m=>m.type==='companion-state' && m.state.lesson.phase==='collect');
    assert.ok(started?.state.preview?.phone,'本机确认收答时即显示手机取景，独立于首次视频握手');
    const key=started.state.preview.key;
    await sector(page,'preview-fold',{key});
    assert.equal((await wheel(page)).preview.folded,true);
    await sector(page,'collect'); await page.waitForFunction(()=>__quizWheelState.lesson.phase==='result');
    await sector(page,'preview-open',{key}); assert.equal((await wheel(page)).preview,null);
    assert.deepEqual(fixture.errors,[]);
  } finally {await context.close();}
});

test('60 张手机卡逐张保存后及时回执，断线重试和空闲轮询仍限频',{timeout:30000},async()=>{
  const {page,context,fixture}=await open({quickScan:true,students:[]});
  const polls=()=>fixture.messages.filter(message=>message.action==='relay');
  let release;
  try {
    await page.clock.install();
    await create(page); await page.locator('#source').click();
    await waitPhoneCode(page);
    fixture.pairings=[{pairId:fixture.pairId,claimed:true}];
    await page.getByText('手机收答中，白板保存后确认',{exact:true}).waitFor();
    const s=fixture.journals[0].session;
    const commands=Array.from({length:60},(_,i)=>({id:crypto.randomUUID(),action:'answer',sessionId:s.id,
      questionId:s.currentQuestionId,roundId:s.currentRoundId,generation:s.generation,sourceId:s.sourceId,
      payload:{cardNumber:i+1,option:'A'}}));
    const saving=new Promise(resolve=>fixture.commitStarted=resolve);
    fixture.holdCommit=new Promise(resolve=>{release=resolve;});
    fixture.commands.push(...commands);
    let offline=true;
    fixture.relay=body=>{if (offline && body.receipts.length) throw new Error('模拟回执断线');};
    await saving;
    const before=polls().length;
    await page.clock.pauseAt(new Date(await page.evaluate(()=>Date.now()+1000)));
    assert.equal(polls().length,before,'逐卡保存期间不并发轮询');
    release();
    await page.locator('#received').getByText('60',{exact:true}).waitFor({state:'attached'});
    await page.clock.runFor(1);
    assert.equal(polls().length,before+1,'保存已超过设备轮询间隔，应立即发回执');
    const receipts=polls().at(-1).body.receipts;
    assert.deepEqual(receipts.map(r=>[r.id,r.result.seq]),commands.map((c,i)=>[c.id,s.seq+i+1]));
    await page.locator('#feedback').getByText(/手机连接暂时不可用/).waitFor();
    offline=false;
    await page.clock.runFor(1000);
    assert.equal(polls().length,before+1,'断线且有回执时仍退避');
    await page.clock.runFor(510);
    assert.equal(polls().length,before+2);
    assert.deepEqual(polls().at(-1).body.receipts,receipts,'按原顺序重试原回执');
    await page.locator('#feedback').getByText(/手机连接暂时不可用/).waitFor({state:'hidden'});
    await page.clock.runFor(600);
    assert.equal(polls().length,before+2,'回执确认后恢复空闲间隔');

    const next={...commands[0],id:crypto.randomUUID(),payload:{cardNumber:61,option:'B'}};
    const savingNext=new Promise(resolve=>fixture.commitStarted=resolve);
    fixture.holdCommit=new Promise(resolve=>{release=resolve;});
    fixture.commands.push(next);
    await page.clock.fastForward(160);
    await savingNext;
    assert.equal(polls().length,before+3);
    assert.deepEqual(polls().at(-1).body.receipts,[]);
    await page.clock.runFor(200);
    release();
    await page.locator('#received').getByText('61',{exact:true}).waitFor({state:'attached'});
    await page.clock.runFor(549);
    assert.equal(polls().length,before+3,'小批回执不能早于 750 毫秒发送');
    await page.clock.runFor(1);
    assert.deepEqual(polls().at(-1).body.receipts.map(r=>r.id),[next.id],'小批只等剩余间隔');
  } finally {release?.(); await context.close();}
});

for(const video of [false,true]) test('手机扫一次免登录接入班班，两张模拟纸卡经取景和封存 · '+(video?'连续视频':'旧版取景'), {timeout:50000},async()=>{
  const {page,context,fixture}=await open({companion:true,quickScan:true});
  const phone=await context.newPage();
  let state,offer,answer,scannerKey,receipts=[];
  let delayedPoll, pollStarted, releasePoll;
  const holding = new Promise(resolve=>{pollStarted=resolve;});
  const sealed = new Promise(resolve=>{releasePoll=resolve;});
  fixture.relay=async body=>{
    if (video && !delayedPoll && body.state.received===2 && body.receipts.length) {
      delayedPoll=body; pollStarted(); await sealed;
      assert.equal(body.retrySuperseded,true);
      return {supersededSeq:fixture.journals[0].session.seq};
    }
    state=body.state;
    if(body.preview?.offer && offer?.id!==body.preview.id){offer=body.preview;answer=null;}
    receipts=body.receipts.map(r=>({id:r.id,status:'confirmed',result:r.result}));
    if(video && body.preview?.prepare) return {preview:{id:body.preview.id,video:true,iceServers:[]}};
    return body.preview && offer ? {preview:{id:offer.id,...(answer && !body.preview.answered ? {answer}: {})}} : {};
  };
  try {
    await useNativeDisc(page);await startInPet(page);await sector(page,'collect');
    await page.waitForFunction(()=>__quizWheelState.cameraRunning && !__quizWheelState.lesson.busy);
    const boardRound=fixture.journals[0].session.currentRoundId;
    await sector(page,'preview-phone',{key:(await wheel(page)).preview.key});
    await waitPhoneCode(page);
    assert.equal(await page.locator('#confirm-phone').isVisible(),false);
    assert.equal(await page.locator('#pair-code').isVisible(),false);
    await phone.route('**/api/**',async route=>{
      const url=new URL(route.request().url()),body=route.request().postDataJSON();
      const key=route.request().headers()['x-iceclass-scanner'];
      assert.match(key,/^[0-9a-f]{64}$/);
      let result;
      if(url.pathname.endsWith('/scan')){
        assert.equal(body.invite,new URLSearchParams(new URL(fixture.scanUrl).hash.slice(1)).get('scan'));
        scannerKey=key; fixture.pairings=[{pairId:fixture.pairId,claimed:true}];
        result={pairId:fixture.pairId,mode:'scan'};
      }
      else if(url.pathname.endsWith('/preview')){assert.equal(key,scannerKey);assert.equal(body.id,offer.id);answer=body.answer;result={id:body.id};}
      else if(url.pathname.endsWith('/commands')){fixture.commands.push(body);result={id:body.id,status:'pending'};}
      else {
        assert.equal(key,scannerKey);assert.equal(url.pathname,'/api/card-quiz/pairs/'+fixture.pairId);
        const wants=url.searchParams.get('preview');
        const selected=state?.sourceId===fixture.pairId;
        result={connected:selected,state:selected?state:null,receipts,...(wants && offer ? {preview:{id:offer.id,...(wants!==offer.id?{offer:offer.offer}:{})}}:{})};
      }
      return route.fulfill({json:result});
    });
    await phone.addInitScript(()=>{
      const send=RTCDataChannel.prototype.send;
      const createAnswer=RTCPeerConnection.prototype.createAnswer;
      RTCPeerConnection.prototype.createAnswer=function(...args){ window.previewConnection=this; return createAnswer.apply(this,args); };
      window.testJpegs=0;
      RTCDataChannel.prototype.send=function(value){
        if(typeof value==='string' && value.startsWith('data:image/jpeg')) window.testJpegs++;
        return send.call(this,value);
      };
      navigator.mediaDevices.getUserMedia=async()=>{
        const canvas=document.createElement('canvas');canvas.width=400;canvas.height=240;
        const ctx=canvas.getContext('2d');let ticks=0;
        function paint(){
          ctx.fillStyle='white';ctx.fillRect(0,0,400,240);
          ctx.fillStyle='black';ctx.fillRect(ticks++%32*10,4,22,22);
          if(!window.raiseCards)return;
          for(const n of [1,2]){
            const matrix=CardQuizCards.matrix(n);
            for(let y=0;y<8;y++)for(let x=0;x<8;x++)
              if(!(n===1?matrix[y][x]:matrix[x][7-y]))ctx.fillRect(30+(n-1)*190+x*17,50+y*17,17,17);
          }
        }
        paint();const stream=canvas.captureStream(30),track=stream.getVideoTracks()[0];
        const timer=setInterval(()=>track.readyState==='ended'?clearInterval(timer):paint(),33);
        return stream;
      };
    });
    await phone.goto(fixture.scanUrl);
    await phone.addScriptTag({url:origin+'/card-quiz/cards.js'});
    await waitPanel(page,'');
    assert.equal(fixture.journals[0].session.currentRoundId,boardRound);
    await page.waitForFunction(()=>window.__quizWheelState.lesson.phase==='collect');
    await page.waitForFunction(()=>window.__quizWheelState.preview?.phone,{},{timeout:18000});
    const initialKey=(await wheel(page)).preview.key;
    await phone.locator('#on-board:not([hidden])').waitFor();
    await sector(page,'preview-stop',{key:initialKey});
    await phone.waitForFunction(()=>!document.querySelector('video').srcObject);
    await page.waitForFunction(()=>!window.__quizWheelState.preview);
    await phone.locator('#camera-toggle').click();
    await page.waitForFunction(old=>window.__quizWheelState.preview && window.__quizWheelState.preview.key!==old,initialKey);
    await sector(page,'preview-fold',{key:initialKey});
    assert.equal((await wheel(page)).preview.folded,false);
    const key=(await wheel(page)).preview.key;
    const frames=()=>fixture.messages.filter(m=>m.type==='preview-frame' && m.key===key);
    const waitForFrameAfter = async count => {
      const deadline = Date.now() + 12000;
      while (frames().length <= count && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve,50));
      assert.ok(frames().length > count,'新取景帧到达白板');
    };
    await waitForFrameAfter(0);
    if(video){
      assert.match(offer.offer,/^m=video /m);
      assert.match(answer,/^a=sendonly/m);
      await page.waitForTimeout(500);
      const before=frames().length;
      await page.waitForTimeout(2000);
      assert.ok(frames().length-before>=35,'连续取景应当独立于识卡节拍');
      assert.equal(await phone.evaluate(()=>testJpegs),0,'手机传视频时不重复传 JPEG');
    }
    assert.ok(frames()[0].frame.startsWith('data:image/jpeg;base64,'));
    assert.deepEqual(await page.evaluate(async data => {
      const image = new Image();
      image.src = data;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }, frames()[0].frame),[288,162]);
    await sector(page,'preview-fold',{key});
    await page.waitForFunction(()=>window.__quizWheelState.preview?.folded);
    await phone.locator('#on-board').waitFor({state:'hidden'});
    const foldedCount=frames().length;
    await phone.evaluate(()=>{window.raiseCards=true;});
    await page.waitForFunction(()=>window.__quizWheelState.lesson.received===2);
    assert.equal(frames().length,foldedCount);
    assert.ok(await phone.locator('video').evaluate(v=>v.srcObject.active));
    await sector(page,'preview-open',{key});
    await waitForFrameAfter(foldedCount);
    const oldOffer=offer.id;
    await phone.evaluate(()=>{window.lastCameraTrack=document.querySelector('video').srcObject.getVideoTracks()[0];});
    if(video) await holding;
    await sector(page,'collect');await page.waitForFunction(()=>window.__quizWheelState.lesson.phase==='result');
    releasePoll();
    await sector(page,'preview-open',{key});assert.equal((await wheel(page)).preview,null);
    assert.deepEqual((await wheel(page)).lesson.bars.map(b => b.count),[1,1,0,0]);
    await phone.waitForFunction(()=>!document.querySelector('video').srcObject);
    assert.equal(await phone.evaluate(()=>lastCameraTrack.readyState),'ended');
    if(video){
      await sector(page,'advance');await page.waitForFunction(()=>__quizWheelState.lesson.phase==='ready' && !__quizWheelState.lesson.busy);
      await sector(page,'collect');await page.waitForFunction(()=>__quizWheelState.lesson.number===2 && __quizWheelState.preview?.phone);
      const second=(await wheel(page)).preview.key;
      assert.notEqual(second,key);
      await phone.locator('#on-board:not([hidden])').waitFor();
      const until=Date.now()+10000;
      while(!fixture.messages.some(m=>m.type==='preview-frame' && m.key===second) && Date.now()<until)
        await new Promise(resolve=>setTimeout(resolve,50));
      assert.ok(fixture.messages.some(m=>m.type==='preview-frame' && m.key===second),'新题单独接收第一帧');
      assert.equal(offer.id,oldOffer,'同一手机换题复用取景连接');
      assert.ok(fixture.messages.some(m=>m.action==='relay' && m.body.state.seq>delayedPoll.state.seq &&
        delayedPoll.receipts.every(r=>m.body.receipts.some(sent=>JSON.stringify(sent)===JSON.stringify(r)))),
        '旧轮询被新进度超过后重发原收卡回执');
      assert.equal(await phone.evaluate(()=>document.querySelector('video').srcObject.getVideoTracks()[0]!==lastCameraTrack),true);
      await phone.evaluate(()=>{
        window.secondTrack=document.querySelector('video').srcObject.getVideoTracks()[0];
        previewConnection.close();
      });
      const untilReconnect=Date.now()+14000;
      let restored;
      while(Date.now()<untilReconnect) {
        restored=(await wheel(page)).preview;
        if (offer.id!==oldOffer && restored?.phone && restored.key!==second &&
          fixture.messages.some(m=>m.type==='preview-frame' && m.key===restored.key)) break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.notEqual(offer.id,oldOffer,'连接中断后自动重新协商');
      assert.ok(restored?.phone && restored.key!==second && fixture.messages.some(m=>m.type==='preview-frame' && m.key===restored.key),
        '重新协商后收到当前手机取景的新帧');
      assert.equal(await phone.evaluate(()=>document.querySelector('video').srcObject.getVideoTracks()[0]===secondTrack),true);
    }
    assert.ok(!JSON.stringify(fixture.journals).includes('data:image/jpeg'));
    assert.deepEqual(fixture.errors,[]);
  } finally {releasePoll();await context.close();}
});

test('60 人同屏核卡，点阵只定位卡号，免答、翻页、焦点及封存只读沿用明细', async () => {
  const numbers = Array.from({length:61}, (_, i) => i + 1).filter(n => n !== 4);
  const students = [...numbers].reverse().map(n => ({id:'s'+n, name:'演示'+n, cardNumber:n}));
  const {page,context,fixture} = await open({companion:true,scannerFixture:true,students,width:178,height:140});
  const dialog = page.locator('#exempt-dialog');
  const cards = dialog.getByRole('checkbox');
  try {
    await useNativeDisc(page); await startInPet(page);
    await sector(page,'collect'); await page.waitForFunction(() => testScanner.running);
    await openClassCards(page);
    assert.equal((await wheel(page)).panelTitle,'本轮卡号');
    assert.equal((await wheel(page)).panelHint,'已收 0 / 60 人');
    const marks = dialog.locator('#card-map [data-card]');
    assert.deepEqual(await marks.evaluateAll(items => items.map(el => Number(el.dataset.card))),numbers);
    assert.deepEqual(await dialog.locator('.card-row-start').allTextContents(), ['1','11','21','31','41','51','61']);
    const centers = await marks.evaluateAll(items => items.slice(0,4).map(el => {
      const {x, width} = el.getBoundingClientRect(); return x + width / 2;
    }));
    assert.ok(Math.abs(centers[3] - centers[2] - 2 * (centers[1] - centers[0])) < 1, '4 号空位在 3 号和 5 号之间');
    const firstBounds = await marks.first().boundingBox();
    await page.mouse.click((centers[2] + centers[3]) / 2, firstBounds.y + firstBounds.height / 2);
    assert.equal(await dialog.locator('#card-overview').isVisible(),true, '点空位仍在概览');
    assert.ok(await dialog.evaluate(el => el.scrollHeight <= el.clientHeight+1 && el.scrollWidth <= el.clientWidth+1),'60 人全图在首屏');
    await marks.last().click();
    assert.equal(await dialog.locator('#card-page').inputValue(),'9');
    assert.ok(await dialog.getByRole('checkbox',{name:'61 号免答'}).evaluate(el => !el.checked && document.activeElement===el));
    await sector(page,'back');
    await dialog.getByRole('button',{name:'查卡号'}).waitFor();
    await marks.first().click();
    assert.match((await wheel(page)).panelHint,/切换免答/);
    assert.deepEqual(await cards.evaluateAll(items => items.map(item => item.dataset.student)),['s1','s2','s3','s5','s6','s7']);
    assert.ok(await dialog.evaluate(el => el.scrollHeight <= el.clientHeight+1 && el.scrollWidth <= el.clientWidth+1),'两行纸卡和翻页应同时可见');
    await dialog.getByRole('button',{name:'下一页卡号'}).press('Enter');
    assert.equal(await dialog.locator('#card-page').inputValue(),'1');
    const eight = dialog.getByRole('checkbox',{name:'8 号免答'});
    await eight.focus();
    await page.evaluate(() => testScanner.options.onRead({cardNumber:8,option:'B'}));
    assert.equal(await dialog.locator('#card-check-8').innerText(),'已收');
    assert.ok(await eight.evaluate(input => document.activeElement === input));
    let finishSave;
    fixture.holdCommit = new Promise(resolve => { finishSave = resolve; });
    const saving = new Promise(resolve => { fixture.commitStarted = resolve; });
    await eight.press('Space'); await saving;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    finishSave();
    await page.waitForFunction(() => document.querySelector('#card-check-8').textContent === '免答' && !window.__quizWheelState.lesson.busy);
    assert.ok(await eight.evaluate(input => input.checked && document.activeElement === input),'用键盘切换免答后继续停在原卡');
    assert.equal(await dialog.locator('#card-page').inputValue(),'1');
    await page.keyboard.press('Escape');
    await dialog.getByRole('button',{name:'查卡号'}).waitFor();
    assert.equal(await marks.nth(6).getAttribute('data-state'),'exempt');
    assert.equal((await wheel(page)).panelHint,'已收 0 / 59 人');
    await sector(page,'back'); await waitPanel(page,'');
    await sector(page,'collect'); await page.waitForFunction(() => window.__quizWheelState.lesson.phase === 'result' && !window.__quizWheelState.lesson.busy);
    await sector(page,'exempt'); await waitPanel(page,'exempt-dialog');
    assert.equal(await marks.first().getAttribute('data-state'),'abstained');
    await dialog.getByRole('button',{name:'查卡号'}).press('Enter');
    assert.match((await wheel(page)).panelHint,/只读/);
    await dialog.getByRole('combobox',{name:'跳到卡号段'}).selectOption('1');
    assert.ok(await cards.evaluateAll(items => items.length === 6 && items.every(item => item.disabled)));
    assert.equal(await dialog.locator('#card-check-8').innerText(),'免答');
    assert.equal(fixture.journals[0].session.questions[0].rounds[0].answers.s8.option,'B');
    await page.keyboard.press('Escape');
    await dialog.getByRole('button',{name:'查卡号'}).waitFor();
    await page.keyboard.press('Escape'); await waitPanel(page,'');
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('待收圆盘实时缩到缺收号码，跳号、封存和只读操作共享本轮口径', async () => {
  const numbers = [2,3,5,11,21,31,41,51,61,71,81,91,101,111];
  const students = numbers.map(n=>({id:'s'+n,name:'匿名测试',cardNumber:n}));
  const {page,context,fixture} = await open({companion:true,scannerFixture:true,students,width:178,height:140});
  try {
    await useNativeDisc(page); await startInPet(page);
    await sector(page,'collect'); await page.waitForFunction(()=>testScanner.running);
    await sector(page,'missing'); await waitPanel(page,'exempt-dialog');
    const overview = (await wheel(page)).cardPanel;
    assert.ok(overview.radial && overview.grouped);
    assert.deepEqual(overview.cards.map(card=>card.number),numbers);
    await sector(page,'card-locate',{cardNumber:111});
    assert.deepEqual((await wheel(page)).cardPanel.cards.map(item=>item.number),[101,111]);
    await sector(page,'card-scope');
    assert.ok((await wheel(page)).cardPanel.pendingOnly,'明细内不能切换范围');
    await sector(page,'card-toggle',{cardNumber:111});
    assert.deepEqual(fixture.journals[0].session.questions[0].rounds[0].exempt,[]);
    await sector(page,'back');
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:3,option:'A'}));
    const grouped = (await wheel(page)).cardPanel;
    assert.ok(grouped.grouped);
    assert.deepEqual(grouped.cards.map(item=>item.number),numbers.filter(n=>n!==3));
    assert.ok(grouped.cards.every(item=>item.state==='pending'));
    await sector(page,'card-locate',{cardNumber:3});
    assert.ok((await wheel(page)).cardPanel.overview);
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:5,option:'A'}));
    const pending = (await wheel(page)).cardPanel;
    assert.ok(pending.overview && pending.radial && pending.readOnly && !pending.grouped);
    assert.deepEqual(pending.cards.map(item=>item.number),numbers.filter(n=>n!==3 && n!==5));
    const questionId = fixture.journals[0].session.currentQuestionId;
    for (const n of numbers.filter(n=>n!==3 && n!==5))
      await page.evaluate(n=>testScanner.options.onRead({cardNumber:n,option:'B'}),n);
    assert.deepEqual((await wheel(page)).cardPanel.cards,[]);
    await sector(page,'card-scope',{key:'previous-round'});
    assert.ok((await wheel(page)).cardPanel.pendingOnly);
    await sector(page,'card-scope');
    assert.deepEqual((await wheel(page)).cardPanel.cards.map(item=>item.number),numbers);
    assert.equal(fixture.journals[0].session.currentQuestionId,questionId);
    await sector(page,'back'); await waitPanel(page,'');
    await sector(page,'collect'); await page.waitForFunction(()=>__quizWheelState.lesson.phase==='result' && !__quizWheelState.lesson.busy);
    await sector(page,'exempt'); await sector(page,'card-scope');
    assert.equal((await wheel(page)).cardPanel.pendingOnly,false);
    await sector(page,'card-locate',{cardNumber:2});
    assert.ok((await wheel(page)).cardPanel.readOnly);
    assert.equal((await wheel(page)).cardPanel.cards[0].state,'received');
    await sector(page,'card-toggle',{cardNumber:2});
    assert.deepEqual(fixture.journals[0].session.questions[0].rounds[0].exempt,[]);
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('无人作答时主操作重收同题，揭晓后转为练习，失效授权仍能结课', async () => {
  const {page,context,fixture} = await open({companion:true,scannerFixture:true});
  const waitResult = () => page.waitForFunction(() => __quizWheelState.lesson.phase === 'result' && !__quizWheelState.lesson.busy);
  try {
    await startInPet(page);
    await sector(page,'collect'); await page.waitForFunction(() => testScanner.running);
    await sector(page,'collect'); await waitResult();
    const first = (await wheel(page)).lesson;
    assert.equal(first.primary,'collect'); assert.equal(first.label,'重收');
    await sector(page,first.primary,{key:first.key}); await page.waitForFunction(() => testScanner.running);
    await sector(page,first.primary,{key:first.key});
    assert.equal(fixture.journals[0].session.questions[0].rounds.length,2);
    await sector(page,'collect'); await waitResult();
    await sector(page,'edit'); await waitPanel(page,'question');
    await page.locator('#reveal').click();
    await page.waitForFunction(() => __quizWheelState.lesson.label === '练习' && !__quizWheelState.lesson.busy);
    await sector(page,'back'); await waitPanel(page,'');
    await sector(page,'collect'); await page.waitForFunction(() => testScanner.running);
    await sector(page,'collect'); await waitResult();
    assert.deepEqual(fixture.journals[0].session.questions[0].rounds.map(r => r.purpose), ['formal','formal','practice']);
    await page.evaluate(() => __quizReceive({type:'authorization',revoked:true}));
    assert.equal((await wheel(page)).actions.find(a => a.id === 'collect').enabled,false);
    await sector(page,'collect'); await sector(page,'advance');
    assert.equal(fixture.journals[0].session.questions.length,1);
    assert.equal(fixture.journals[0].session.questions[0].rounds.length,3);
    await sector(page,'finish-confirmed'); await page.waitForFunction(() => __quizWheelState.lesson.phase === 'done');
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('恢复第 100 题后可重收或结课，快捷操作和加题入口都遵守上限', async () => {
  const initial = Journal.create(Model.createSession({classId:'c1',deviceId:'d1',students:[{id:'s1',name:'演示',cardNumber:1}]},'math'));
  const saved = new Journal.Controller(initial, async value => value);
  function apply(action, payload = {}) {
    const s = saved.session;
    return saved.dispatch({id:crypto.randomUUID(), sessionId:s.id, questionId:s.currentQuestionId, roundId:s.currentRoundId,
      generation:s.generation, sourceId:s.sourceId, action, payload});
  }
  for (let i = 0; i < 100; i++) await apply('add_question', {type:'single',options:['','']});
  await apply('start_round'); await apply('end_round');
  const {page,context,fixture} = await open({companion:true,scannerFixture:true,journals:[saved.journal]});
  try {
    await sector(page,'setup-restore',{sessionId:saved.session.id});
    await page.waitForFunction(() => __quizWheelState.lesson.label === '重收' && __quizWheelState.lesson.enabled);
    assert.equal((await wheel(page)).actions.find(a => a.id === 'next').enabled,false);
    await sector(page,'advance'); await sector(page,'next');
    assert.equal((await wheel(page)).panel,'');
    await sector(page,'collect'); await page.waitForFunction(() => testScanner.running);
    await page.evaluate(() => testScanner.options.onRead({cardNumber:1,option:'A'}));
    await sector(page,'collect'); await page.waitForFunction(() => __quizWheelState.lesson.primary === 'finish' && __quizWheelState.lesson.enabled);
    await sector(page,'advance'); await sector(page,'finish-confirmed');
    await page.waitForFunction(() => __quizWheelState.lesson.phase === 'done');
    assert.equal(fixture.journals[0].session.questions.length,100);
    assert.equal((await wheel(page)).lesson.records.at(-1).received,1);
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('整班图随多选换项刷新，封存区分已举卡、弃权和免答', async () => {
  const students = Array.from({length:157}, (_,i) => ({id:'s'+(i+1),name:'学生'+i,cardNumber:i+1}));
  const {page,context,fixture} = await open({companion:true,scannerFixture:true,students,width:178,height:140});
  const dialog = page.locator('#exempt-dialog');
  const scan = (cardNumber,option) => page.evaluate(read => testScanner.options.onRead(read), {cardNumber,option});
  const mark = n => dialog.locator('#card-map [data-card="'+n+'"]');
  try {
    await useNativeDisc(page); await startInPet(page,'multiple:2');
    await sector(page,'collect'); await page.waitForFunction(() => testScanner.running);
    await scan(1,'A'); await scan(2,'A');
    await openClassCards(page);
    assert.match((await wheel(page)).panelHint,/A 项.*2 \/ 157 人/);
    await mark(3).click();
    await dialog.getByRole('checkbox',{name:'3 号免答'}).check();
    await page.waitForFunction(() => !window.__quizWheelState.lesson.busy && window.__quizWheelState.lesson.expected===156);
    await sector(page,'back'); await sector(page,'back'); await waitPanel(page,'');
    await sector(page,'multi'); await page.waitForFunction(() => window.__quizWheelState.lesson.option==='B' && testScanner.running);
    await openClassCards(page);
    assert.equal(await mark(1).getAttribute('data-state'),'pending');
    await scan(1,'B');
    assert.equal((await wheel(page)).panelHint,'B 项 · 1 / 156 人');
    assert.equal(await mark(1).getAttribute('data-state'),'received');
    await sector(page,'back'); await sector(page,'collect');
    await page.waitForFunction(() => window.__quizWheelState.lesson.phase==='result' && !window.__quizWheelState.lesson.busy);
    await sector(page,'exempt'); await waitPanel(page,'exempt-dialog');
    assert.equal((await wheel(page)).panelHint,'已答 2 / 156 人');
    assert.deepEqual(await Promise.all([1,2,3,157].map(n=>mark(n).getAttribute('data-state'))),['received','received','exempt','abstained']);
    assert.deepEqual(await dialog.locator('#card-key > span:visible').allTextContents(),['已收','弃权','免答']);
    assert.ok(await dialog.evaluate(el => {
      const dot = state => getComputedStyle(el.querySelector(`#card-map [data-state="${state}"]`),'::before');
      const received = dot('received'), abstained = dot('abstained');
      const ink = getComputedStyle(el.querySelector('.card-map-link')).color;
      return received.backgroundColor === ink && abstained.backgroundColor !== ink && abstained.borderTopWidth !== '0px' &&
        getComputedStyle(el.querySelector('.card-check-state[data-state="received"]')).color === ink;
    }), '已收实心、弃权空心，已收卡号和点阵共用主题蓝');
    await page.emulateMedia({forcedColors:'active'});
    assert.ok(await dialog.evaluate(el=>el.scrollHeight<=el.clientHeight+1 && el.scrollWidth<=el.clientWidth+1),'157 个点及三种图例在圆盘内完整可见');
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('紧凑圆盘通过原生消息扫码、保存题目、翻页揭晓和返回核卡', async () => {
  const {page,context,fixture} = await open({companion:true,scannerFixture:true,width:178,height:140});
  try {
    await useNativeDisc(page); await startInPet(page);
    await sector(page,'source');
    const qr = await detailPage(page,'pair-dialog','reader');
    assert.deepEqual(qr.items.map(item => [item.id,item.enabled]),[['pair-info',true],['confirm-phone',false]]);
    assert.doesNotMatch(JSON.stringify(qr),/482915|#pair=|https?:/);
    const code = await page.locator('#pair-qr svg').boundingBox();
    assert.ok(code && code.width === code.height && code.width >= 128 && code.y >= 0 && code.y + code.height <= 140);
    await detailAction(page,'pair-info');
    assert.match(await page.locator('#pair-dialog .disc-reader').innerText(),/482915[\s\S]*扫码登录/);
    await detailAction(page,'back');
    fixture.pairings = [{pairId:fixture.pairId,claimed:true}];
    await detailAction(page,'confirm-phone'); await waitPanel(page,'');
    assert.equal(fixture.journals[0].session.source,'phone');
    await page.waitForFunction(() => !__quizWheelState.lesson.busy);
    await sector(page,'source');
    await page.waitForFunction(() => !__quizWheelState.lesson.phone && !__quizWheelState.lesson.busy);

    await sector(page,'edit');
    const menu = await detailPage(page,'question','ring');
    await detailAction(page,'edit'); await detailPage(page,'editor','ring');
    await detailAction(page,'answer-b'); await detailAction(page,'fields'); await detailAction(page,'stem');
    const editor = await detailPage(page,'editor','reader');
    assert.ok(editor.items.some(item => item.id === 'save' && item.enabled));
    const stem = Array.from({length:18}, (_, i) => '读第 ' + (i + 1) + ' 行。').join('\n') + '最后一字';
    await page.locator('#edit-text').fill(stem);
    await detailAction(page,'save'); await detailPage(page,'question','ring');
    await page.waitForFunction(() => !__quizWheelState.lesson.busy);
    await page.setViewportSize({width:168,height:128});
    await detailAction(page,'read-stem');
    const first = await detailPage(page,'question','reader');
    assert.deepEqual(first.items.map(item => [item.id,item.enabled]),[['page',true],['reveal',true]]);
    await detailAction(page,'page');
    const second = await detailPage(page,'question','reader');
    assert.notEqual(first.key,second.key);
    await useNativeDisc(page);
    assert.equal((await wheel(page)).discPage.key,second.key);
    await sector(page,'disc-reveal',{pageKey:menu.key,key:(await wheel(page)).lesson.key});
    assert.equal(fixture.journals[0].session.questions[0].revealed,false);
    await page.reload(); await useNativeDisc(page);
    await page.waitForFunction(() => __quizWheelState.setup?.recovery);
    await sector(page,'setup-restore',{sessionId:fixture.journals[0].session.id});
    await page.waitForFunction(() => __quizWheelState.lesson.phase === 'ready' && !__quizWheelState.lesson.busy);
    await sector(page,'edit');
    assert.equal((await detailPage(page,'question','reader')).title,second.title);
    for (let i = 0; i < 12 && (await wheel(page)).discPage.items.some(item => item.id === 'page' && item.label === '下页'); i++)
      await detailAction(page,'page');
    assert.ok(await page.locator('.disc-reader:visible p').evaluate(node => {
      const range = document.createRange(), text = node.firstChild;
      range.setStart(text,text.length - 1); range.setEnd(text,text.length);
      const rect = range.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    }), '长题干末字可通过原生翻页在圆内读到');
    await detailAction(page,'reveal');
    await page.waitForFunction(() => __quizWheelState.discPage.title === '答案' && !__quizWheelState.lesson.busy);
    assert.equal(await page.locator('.disc-reader:visible').innerText(),'标准答案 B');
    await detailAction(page,'back');
    assert.equal((await detailPage(page,'question','ring')).value,'答案 B');
    await detailAction(page,'back'); await waitPanel(page,'');

    await sector(page,'collect'); await page.waitForFunction(() => testScanner.running && !__quizWheelState.lesson.busy);
    await openClassCards(page);
    await sector(page,'card-locate',{cardNumber:1});
    fixture.failCommit = true;
    await sector(page,'card-toggle',{cardNumber:1});
    await detailPage(page,'exempt-dialog','reader');
    const alert = page.locator('#exempt-dialog [role="alert"]:visible');
    assert.match(await alert.innerText(),/保存尚未确认[\s\S]*重读记录/);
    assert.equal((await wheel(page)).cardPanel.radial,false);
    await detailAction(page,'back');
    await page.waitForFunction(() => __quizWheelState.cardPanel?.radial && !__quizWheelState.discPage);
    assert.ok((await wheel(page)).cardPanel.readOnly);
    assert.deepEqual(fixture.journals[0].session.questions[0].rounds[0].exempt,[]);
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('本机无取景时可重开或换设备，相机失败和换源都先保存暂停，过期与后台命令无效', async () => {
  const {page,context,fixture} = await open({companion:true,scannerFixture:true,quickScan:true});
  const state = () => fixture.journals[0].session;
  const waitPhase = phase => page.waitForFunction(phase => __quizWheelState.lesson.phase === phase && !__quizWheelState.lesson.busy,phase);
  let release;
  try {
    await useNativeDisc(page); await startInPet(page);
    await sector(page,'collect'); await waitPhase('collect');
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:2,option:'A'}));
    const {currentRoundId,currentQuestionId} = state();
    await sector(page,'missing');
    const small = (await wheel(page)).cardPanel;
    assert.ok(small.pendingOnly && !small.grouped);
    assert.deepEqual(small.cards,[{number:1,state:'pending'}]);
    await sector(page,'card-scope');
    assert.deepEqual((await wheel(page)).cardPanel.cards,[{number:1,state:'pending'},{number:2,state:'received'}]);
    await sector(page,'back');
    const stopCamera = async () => {
      await sector(page,'preview-stop',{key:(await wheel(page)).preview.key});
      await page.waitForFunction(()=>__quizWheelState.lesson.primary==='open-camera' && !__quizWheelState.lesson.busy);
      const controls = (await wheel(page)).actions.filter(item=>item.enabled).map(item=>item.id);
      assert.ok(controls.includes('source') && controls.includes('seal'));
      assert.ok(!controls.includes('camera') && !controls.includes('options'));
    };
    await stopCamera();
    const beforeRetry = (await wheel(page)).lesson.key;
    await page.evaluate(()=>{
      const start = testScanner.start.bind(testScanner);
      testScanner.start = async () => { testScanner.start = start; throw new Error('没有可用的相机'); };
    });
    await sector(page,'open-camera',{key:beforeRetry}); await waitPhase('paused');
    assert.match((await wheel(page)).feedback,/可恢复本轮重试.*使用手机.*没有可用的相机/);
    assert.equal(state().questions[0].rounds[0].status,'paused');
    await sector(page,'source',{key:beforeRetry});
    assert.equal(fixture.messages.some(item=>item.action==='pair'),false);
    await sector(page,'source'); await waitPhoneCode(page);
    await sector(page,'back'); await waitPanel(page,'');
    await sector(page,'collect'); await waitPhase('collect');
    await stopCamera();
    await sector(page,'source'); await waitPhoneCode(page);
    fixture.holdCommit = new Promise(resolve=>{release=resolve;});
    const saving = new Promise(resolve=>{fixture.commitStarted=resolve;});
    fixture.pairings=[{pairId:fixture.pairId,claimed:true}];
    await saving;
    for (const id of ['source','pause','seal','options']) await sector(page,id);
    assert.equal(fixture.messages.filter(item=>item.action==='pair').length,2);
    assert.equal(fixture.messages.findLast(item=>item.action==='commit').body.journal.session.questions[0].rounds[0].status,'paused');
    assert.equal(state().source,'board');
    release();
    await waitPhase('collect'); await waitPanel(page,'');
    assert.equal(state().source,'phone');
    const waitingLens=(await wheel(page)).preview;
    assert.ok(waitingLens?.phone);
    await sector(page,'preview-board',{key:waitingLens.key}); await waitPhase('paused');
    assert.equal(state().source,'board');
    assert.equal(state().currentRoundId,currentRoundId);
    assert.equal(state().currentQuestionId,currentQuestionId);
    assert.equal(state().questions[0].rounds[0].answers.s2.option,'A');
    await page.evaluate(()=>__quizReceive({type:'visibility',visible:false,nativeDisc:true}));
    const key = (await wheel(page)).lesson.key;
    for (const id of ['collect','seal','source','missing']) await sector(page,id,{key});
    assert.equal(state().questions[0].rounds[0].status,'paused');
    assert.equal((await wheel(page)).panel,'');
    await useNativeDisc(page); await sector(page,'seal',{key}); await waitPhase('result');
    assert.deepEqual(fixture.errors,[]);
  } finally { release?.(); await context.close(); }
});

test('紧凑圆盘直接暂停、切项、封存、加题和离线逐题回看', async () => {
  const {page,context,fixture} = await open({companion:true,scannerFixture:true,width:168,height:128});
  try {
    await useNativeDisc(page); await startInPet(page);
    await sector(page,'collect'); await page.waitForFunction(() => testScanner.running && !__quizWheelState.lesson.busy);
    const hasAction = async id => (await wheel(page)).actions.some(item => item.id === id && item.enabled);
    assert.equal((await wheel(page)).actions.some(item => item.id === 'camera'),false);
    for (const id of ['source','seal','options','exempt']) assert.equal(await hasAction(id),false,id);
    await sector(page,'camera'); await sector(page,'exempt'); await sector(page,'seal');
    assert.equal((await wheel(page)).panel,'');
    await sector(page,'pause');
    await page.waitForFunction(() => __quizWheelState.lesson.phase === 'paused' && !__quizWheelState.lesson.busy);
    assert.ok(await hasAction('seal')); assert.ok(await hasAction('source'));
    assert.equal(await hasAction('pause'),false);
    await sector(page,'collect');
    await page.waitForFunction(() => testScanner.running && !__quizWheelState.lesson.busy);
    await page.evaluate(() => testScanner.options.onRead({cardNumber:1,option:'A'}));
    await sector(page,'collect');
    await page.waitForFunction(() => __quizWheelState.lesson.phase === 'result' && !__quizWheelState.lesson.busy);
    await sector(page,'distribution');
    const chart = await detailPage(page,'distribution','reader');
    assert.deepEqual(chart.items,[]);
    await sector(page,'disc-reveal',{pageKey:chart.key,key:(await wheel(page)).lesson.key});
    assert.equal(fixture.journals[0].session.questions[0].revealed,false);
    const rails = await page.locator('#distribution meter').evaluateAll(items => items.map(item => {
      const {x,width} = item.getBoundingClientRect(); return [x,width];
    }));
    assert.ok(rails.length === 4 && rails.every(([x,width]) => x === rails[0][0] && width === rails[0][1] && width > 80));
    assert.deepEqual(await page.locator('#distribution .distribution-scale span').allTextContents(), ['0','1 人']);
    assert.match(await page.locator('.capture-count').innerText(),/已答\s*1\s*\/\s*2/);
    const axis = await page.locator('#distribution .distribution-scale small').boundingBox();
    assert.ok(Math.abs(axis.x - rails[0][0]) < 1 && Math.abs(axis.width - rails[0][1]) < 1);
    assert.equal(await page.locator('#distribution .option-result small:visible').count(),0);
    assert.equal(await page.locator('#workspace button:visible').count(),0);
    await noOverflow(page);
    await sector(page,'back'); await waitPanel(page,'');
    assert.equal((await wheel(page)).actions.find(item => item.id==='edit').label,'设置与揭晓答案');
    await sector(page,'edit'); await detailAction(page,'reveal');
    await page.waitForFunction(()=>__quizWheelState.discPage.value==='已讲解' && !__quizWheelState.lesson.busy);
    await sector(page,'back'); await waitPanel(page,'');
    await sector(page,'next');
    const templates = await detailPage(page,'next','ring');
    assert.deepEqual(templates.items.map(item => item.mark || item.label),['A-D','A-C','A-B','对错','A-D','A-C','A-B','临时题']);
    await detailAction(page,'temporary'); await detailPage(page,'editor','ring');
    await sector(page,'back'); await detailPage(page,'next','ring');
    await detailAction(page,'add-multiple-4'); await waitPanel(page,'');
    await sector(page,'collect'); await page.waitForFunction(() => testScanner.running && !__quizWheelState.lesson.busy);
    assert.ok(await hasAction('seal'));
    await sector(page,'multi');
    await page.waitForFunction(() => __quizWheelState.lesson.option === 'B' && !__quizWheelState.lesson.busy);
    await sector(page,'options');
    const multi = await detailPage(page,'options','ring');
    assert.equal(multi.value,'收 B');
    assert.deepEqual(multi.items.map(item=>item.label),['A','C','D']);
    for (const letter of 'ACD') {
      const option = multi.items.find(item => item.id === 'collect-' + letter.toLowerCase());
      assert.ok(option,'收答扇面 ' + letter);
      assert.equal(option.label,letter);
      assert.ok(option.name.includes('收 ' + letter + ' 项'));
      assert.ok(option.enabled);
    }
    const switchAt = fixture.messages.length;
    await detailAction(page,'collect-c');
    await page.waitForFunction(() => __quizWheelState.lesson.option === 'C' && !__quizWheelState.lesson.busy);
    await waitPanel(page,'');
    assert.ok(await page.evaluate(()=>testScanner.running));
    const afterSwitch = (await wheel(page)).lesson;
    assert.deepEqual([afterSwitch.phase,afterSwitch.primary,afterSwitch.label,afterSwitch.enabled],['collect','multi','下一项 D',true]);
    const states = fixture.messages.slice(switchAt).filter(message=>message.type==='companion-state').map(message=>message.state);
    const panels = states.map(state=>state.panel);
    assert.deepEqual(panels.filter((name,i)=>i===0 || name!==panels[i-1]),['options','']);
    assert.equal(states.find(state=>!state.panel).lesson.option,'C');
    assert.ok(states.filter(state=>state.panel==='options').every(state=>state.lesson.option==='B'));
    await sector(page,'options');
    assert.deepEqual((await wheel(page)).discPage.items.map(item=>item.label),['A','B','D']);
    await detailAction(page,'back');
    assert.equal((await wheel(page)).lesson.key,afterSwitch.key);
    assert.equal((await wheel(page)).panel,'');
    await sector(page,'seal'); await waitPanel(page,'');
    await page.waitForFunction(() => !__quizWheelState.lesson.busy);
    await sector(page,'end-session'); await detailPage(page,'confirm-dialog','reader');
    await sector(page,'back'); await waitPanel(page,'');
    assert.equal(fixture.journals[0].session.endedAt,null);
    fixture.failSync = true;
    await sector(page,'end-session'); await detailPage(page,'confirm-dialog','reader');
    assert.equal((await wheel(page)).lesson.busy,true);
    await detailAction(page,'confirm'); await detailPage(page,'summary','ring');
    await detailAction(page,'records'); await detailPage(page,'summary','reader');
    const record = page.locator('.disc-record');
    assert.match(await record.innerText(),/已答 1 \/ 2 人/);
    assert.deepEqual(await record.locator('meter').evaluateAll(rows => rows.map(row => [row.value,row.max])), [[1,1],[0,1],[0,1],[0,1]]);
    await detailAction(page,'next');
    assert.match((await wheel(page)).discPage.title,/第 2 题/);
    assert.equal(await record.locator('.distribution-empty').innerText(),'弃权 2 人');
    await sector(page,'back'); await detailAction(page,'setup'); await waitPanel(page,'');
    await page.waitForFunction(() => !__quizWheelState.lesson.busy);
    await sector(page,'end-session');
    const pending = await detailPage(page,'history','ring');
    assert.doesNotMatch(JSON.stringify(pending),new RegExp(fixture.journals[0].session.id));
    const sessionItem = pending.items[0].id;
    await detailAction(page,sessionItem); await detailPage(page,'summary','ring');
    await page.waitForFunction(() => !__quizWheelState.lesson.busy);
    await detailAction(page,'back');
    await page.waitForFunction(id => __quizWheelState.panel === 'history' && __quizWheelState.discPage?.focusId === id,sessionItem);
    await detailAction(page,sessionItem); await detailPage(page,'summary','ring');
    await detailAction(page,'sync');
    await page.waitForFunction(() => __quizWheelState.discPage?.hint === '同步失败' && !__quizWheelState.lesson.busy);
    await detailAction(page,'status');
    assert.match(await page.locator('.disc-reader:visible').innerText(),/学校服务暂时离线/);
    await detailAction(page,'back');
    fixture.failSync = false;
    await detailAction(page,'sync');
    await page.waitForFunction(() => !__quizWheelState.lesson.needsSync && !__quizWheelState.lesson.busy);
    await detailAction(page,'back');
    const empty = await detailPage(page,'history','reader');
    assert.equal(empty.focusId,undefined);
    assert.equal(await page.locator('.disc-reader:visible').innerText(),'本机没有待同步的课堂。');
    assert.equal(fixture.journals.length,1);
    assert.equal(context.pages().length,1);
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('跨天待同步课堂翻到末页，逐题查看后回到原记录，同步后更新列表', async () => {
  const roster = {classId:'c1',deviceId:'d1',students:[{id:'s1',name:'演示',cardNumber:1}]};
  const journals = [];
  for (let i = 1; i <= 14; i++) {
    const start = new Date(2023,10,i,9,10).getTime();
    const saved = new Journal.Controller(Journal.create(Model.createSession(roster,'math',start)), async value => value);
    for (const [action,payload] of [['add_question',{type:'single'}],['add_question',{type:'boolean'}],['end_session',{}]]) {
      const s = saved.session;
      await saved.dispatch({id:crypto.randomUUID(),sessionId:s.id,questionId:s.currentQuestionId,roundId:s.currentRoundId,
        generation:s.generation,sourceId:s.sourceId,action,payload});
    }
    journals.push(saved.journal);
  }
  const {page,context,fixture} = await open({companion:true,scannerFixture:true,journals,width:168,height:128});
  try {
    await useNativeDisc(page); await sector(page,'end-session');
    const first = await detailPage(page,'history','ring');
    assert.equal(first.value,'14 堂'); assert.equal(first.hint,'1/3 页');
    await detailAction(page,'next'); await detailAction(page,'next');
    const last = await detailPage(page,'history','ring');
    assert.equal(last.hint,'3/3 页');
    const lessons = last.items.filter(item => item.id.startsWith('lesson-'));
    assert.deepEqual(lessons.map(item => item.mark),['11/2','11/1']);
    assert.ok(lessons.every(item => item.name.includes('数学') && item.label.includes('9:10')));
    const target = lessons[1].id;
    await detailAction(page,target); await detailPage(page,'summary','ring');
    await detailAction(page,'records'); await detailAction(page,'next');
    assert.match((await detailPage(page,'summary','reader')).title,/第 2 题/);
    await detailAction(page,'back'); await detailPage(page,'summary','ring');
    await detailAction(page,'back');
    await page.waitForFunction(id => __quizWheelState.discPage?.focusId === id, target);
    assert.equal((await detailPage(page,'history','ring')).hint,'3/3 页');
    await detailAction(page,target); await detailPage(page,'summary','ring');
    fixture.journals[0].syncedSeq = fixture.journals[0].session.seq;
    await detailAction(page,'back'); await detailPage(page,'history','ring');
    await page.waitForFunction(() => !__quizWheelState.lesson.busy);
    const remaining = (await wheel(page)).discPage;
    assert.equal(remaining.value,'13 堂'); assert.equal(remaining.hint,'3/3 页');
    assert.ok(!remaining.focusId && !remaining.items.some(item => item.id === target));
    await detailAction(page,lessons[0].id); await detailAction(page,'sync');
    await page.waitForFunction(() => !__quizWheelState.lesson.needsSync && !__quizWheelState.lesson.busy);
    await detailAction(page,'back'); await detailPage(page,'history','reader');
    assert.match(await page.locator('.disc-reader:visible').innerText(),/没有待同步/);
    await detailAction(page,'back'); await waitPanel(page,'');
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
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
    await sector(page,'distribution');await waitPanel(page,'distribution');
    assert.deepEqual(await page.locator('.option-result.leading strong').allTextContents(), ['C']);
    assert.match(await page.locator('.distribution-note').innerText(), /弃权.*1 人/);
    await page.locator('#pane-back').click();await waitPanel(page,'');
    await sector(page,'next');await waitPanel(page,'next');
    assert.equal(fixture.journals[0].session.questions.length,1);
    await page.locator('#next-template').selectOption('boolean:2');await page.locator('#next').click();
    await page.waitForFunction(()=>document.querySelector('#question-number').textContent.includes('第 2 题'));
    assert.equal(fixture.journals[0].session.questions[1].type,'boolean');
    await sector(page,'collect');await page.waitForFunction(()=>testScanner.running);
    await sector(page,'collect');await page.locator('#show-distribution:not([disabled])').waitFor({state:'attached'});
    await sector(page,'distribution');await waitPanel(page,'distribution');
    assert.equal(await page.locator('.distribution-empty').innerText(),'弃权 2 人');
    assert.equal(await page.locator('.distribution-note').count(),0);
    assert.equal(await page.locator('.option-result').count(),0);
    assert.equal(await page.locator('.capture-count').isVisible(),false);
    assert.equal(fixture.journals.length,1);assert.equal(fixture.journals[0].session.questions.length,2);
    assert.doesNotMatch(JSON.stringify(await wheel(page)),/不应出现在|私密姓名/);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

for (const scenario of ['只举 A 项','完整全不选','全员免答']) {
  test('班班多选封存与课堂汇总：' + scenario, async () => {
    const {page,context} = await open({companion:true,scannerFixture:true,width:178,height:140});
    const skipAll = scenario === '全员免答', complete = scenario === '完整全不选';
    try {
      await useNativeDisc(page); await startInPet(page,'multiple:2');
      await sector(page,'collect'); await page.waitForFunction(() => testScanner.running);
      if (skipAll) {
        await openClassCards(page);
        await sector(page,'card-locate',{cardNumber:1});
        for (const n of [1,2]) {
          await sector(page,'card-toggle',{cardNumber:n});
          await page.waitForFunction(expected => !__quizWheelState.lesson.busy && __quizWheelState.lesson.expected === expected, 2 - n);
        }
        await sector(page,'back'); await sector(page,'card-scope');
        assert.ok((await wheel(page)).cardPanel.pendingOnly);
        assert.deepEqual((await wheel(page)).cardPanel.cards,[]);
        assert.match((await wheel(page)).panelHint,/全员免答/);
        await sector(page,'card-scope');
        assert.deepEqual((await wheel(page)).cardPanel.cards.map(card=>[card.number,card.state]),[[1,'exempt'],[2,'exempt']]);
        await sector(page,'back'); await waitPanel(page,'');
      } else {
        await page.evaluate(option => testScanner.options.onRead({cardNumber:1,option}),complete ? 'B' : 'A');
        await sector(page,'multi'); await page.waitForFunction(() => __quizWheelState.lesson.option === 'B' && !__quizWheelState.lesson.busy);
        if (complete) await page.evaluate(() => testScanner.options.onRead({cardNumber:1,option:'B'}));
      }
      await sector(page,skipAll ? 'seal' : 'collect'); await page.waitForFunction(() => __quizWheelState.lesson.phase === 'result' && !__quizWheelState.lesson.busy);
      const {lesson} = await wheel(page);
      assert.equal(lesson.received, skipAll ? 0 : 1);
      assert.equal(lesson.incomplete, 0);
      assert.equal(lesson.abstained, skipAll ? 0 : 1);
      assert.equal(lesson.primary, 'advance');
      await sector(page,'distribution'); await waitPanel(page,'distribution');
      const label = skipAll ? '全员免答' : '已答 1 / 2 人';
      if (!skipAll) {
        assert.deepEqual(await page.locator('#distribution meter').evaluateAll(items => items.map(item => [item.value,item.max])), [[1,1]]);
        assert.equal(await page.locator('.capture-count').isVisible(),true);
        assert.equal(await page.locator('.option-result.leading strong').innerText(),complete ? '全不选' : 'A');
        assert.equal(await page.locator('.distribution-note').innerText(),'弃权 1 人');
      } else {
        assert.equal(await page.locator('.distribution-empty').innerText(),label);
        assert.equal(await page.locator('#distribution meter').count(),0);
      }
      await noOverflow(page); await sector(page,'back'); await waitPanel(page,'');
      await sector(page,'end-session'); await detailPage(page,'confirm-dialog','reader');
      await detailAction(page,'confirm'); await detailPage(page,'summary','ring');
      await detailAction(page,'records'); await detailPage(page,'summary','reader');
      const record = page.locator('.disc-record');
      assert.ok((await record.innerText()).includes(label));
      assert.deepEqual(await record.locator('meter').evaluateAll(items => items.map(item => [item.value,item.max])),
        skipAll ? [] : [[1,1]]);
    } finally { await context.close(); }
  });
}

test('多选十六种组合在封存、结课记录和逐题汇总中都能翻完，翻页不改变课堂', async () => {
  const options = [...'ABCD'];
  const combinations = Array.from({length:16}, (_, mask) =>
    options.filter((_, i) => mask & (1 << i)).join(''));
  const popular = ['A','AB','ABC','ABCD','ABD'];
  const votes = [...combinations, ...popular];
  // Card 22 selects only A, 23 abstains, and exempt card 24 keeps its saved choices.
  const students = Array.from({length:24}, (_, i) => ({id:'s'+i, name:'匿名样例'+i, cardNumber:i+1}));
  const saved = new Journal.Controller(Journal.create(Model.createSession({classId:'c1',deviceId:'d1',students},'math')), async j => j);
  async function apply(action, payload = {}) {
    const s = saved.session;
    await saved.dispatch({id:crypto.randomUUID(), sessionId:s.id, questionId:s.currentQuestionId,
      roundId:s.currentRoundId, generation:s.generation, sourceId:s.sourceId, action, payload});
  }
  await apply('add_question',{type:'multiple',answer:'AB'}); await apply('start_round');
  for (const letter of options) {
    if (letter !== 'A') await apply('set_multi_option',{option:letter});
    for (const [i, vote] of votes.entries())
      await apply('answer',{targetOption:letter,cardNumber:i+1,option:vote.includes(letter)?'A':'B'});
    if (letter === 'A') await apply('answer',{targetOption:letter,cardNumber:22,option:'A'});
    await apply('answer',{targetOption:letter,cardNumber:24,option:'A'});
  }
  await apply('set_exempt',{studentId:students[23].id,exempt:true}); await apply('end_round');
  const expected = [...popular, ...combinations.filter(c => c && !popular.includes(c)).sort(), '全不选'];
  const {page,context,fixture} = await open({companion:true,scannerFixture:true,students,journals:[saved.journal],width:156,height:118,touch:true});
  async function checkPages(panel, chart) {
    const seq = fixture.journals[0].session.seq;
    for (let part = 0; part < 4; part++) {
      const view = await detailPage(page,panel,'reader');
      assert.ok(view.title.includes((part+1)+'/4'));
      const labels = expected.slice(part*4,part*4+4);
      assert.deepEqual(await chart.locator('.option-result strong').allTextContents(),labels);
      assert.deepEqual(await chart.locator('.leading strong').allTextContents(),labels.filter(label=>label==='A'));
      assert.deepEqual(await chart.locator('meter').evaluateAll(items=>items.map(m=>[m.value,m.max])),
        labels.map(label=>[label==='A'?3:popular.includes(label)?2:1,22]));
      assert.equal(await chart.locator('.distribution-note').innerText(),'弃权 1 人');
      assert.ok(await chart.locator('.option-result').evaluateAll(items => items.every(row => {
        const {top, bottom} = row.getBoundingClientRect(), label=row.querySelector('strong');
        return top >= 0 && bottom <= innerHeight && label.scrollWidth <= label.clientWidth+1;
      })), '四行组合都能看到');
      const clipped = await page.locator('.capture-count:visible, .distribution-note:visible, .disc-record-count:visible, .disc-record-grade:visible')
        .evaluateAll(nodes => nodes.filter(node => {
          const {top,bottom}=node.getBoundingClientRect();
          return top < -1 || bottom > innerHeight+1;
        }).map(node=>node.className));
      assert.deepEqual(clipped, [], '已答、弃权及正式记录均在圆内可见');
      await noOverflow(page);
      if (part < 3) {
        await detailAction(page,'next');
        await sector(page,'disc-next',{pageKey:view.key,key:(await wheel(page)).lesson.key});
      }
    }
    assert.equal(fixture.journals[0].session.seq,seq);
    await detailAction(page,'previous');
    assert.ok((await wheel(page)).discPage.title.includes('3/4'));
  }
  try {
    await useNativeDisc(page); await sector(page,'setup-restore',{sessionId:saved.session.id});
    await page.waitForFunction(()=>__quizWheelState.lesson.phase==='result' && !__quizWheelState.lesson.busy);
    const {lesson} = await wheel(page);
    assert.deepEqual([lesson.received,lesson.expected,lesson.abstained],[22,23,1]);
    assert.deepEqual(lesson.bars.map(b=>b.label),expected);
    await sector(page,'distribution'); await checkPages('distribution',page.locator('#distribution'));
    await page.keyboard.press('Escape'); await waitPanel(page,'');
    await sector(page,'advance'); await page.waitForFunction(()=>__quizWheelState.lesson.phase==='ready' && !__quizWheelState.lesson.busy);
    await sector(page,'finish-confirmed'); await page.waitForFunction(()=>__quizWheelState.lesson.phase==='done' && !__quizWheelState.lesson.busy);
    assert.equal((await wheel(page)).lesson.records[1].bars,null);
    await sector(page,'record-chart',{questionIndex:0});
    await checkPages('record-chart',page.locator('.disc-record')); await detailAction(page,'back'); await waitPanel(page,'');
    await sector(page,'end-session'); await detailAction(page,'records');
    await checkPages('summary',page.locator('.disc-record'));
    await detailAction(page,'next');
    assert.equal((await wheel(page)).discPage.items[1].label,'下一题');
    await detailAction(page,'next');
    assert.equal(await page.locator('.disc-record .distribution-empty').innerText(),'无正式收答');
    await detailAction(page,'previous'); assert.match((await wheel(page)).discPage.title,/1\/4/);
    await detailAction(page,'back'); await detailPage(page,'summary','ring');
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
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
    const rows = page.locator('#distribution .option-result');
    assert.deepEqual(await rows.locator('strong').allTextContents(), ['A','B','C','D']);
    assert.deepEqual(await rows.locator('meter').evaluateAll(bars => bars.map(bar => [bar.value,bar.max])), [[1,2],[1,2],[0,2],[0,2]]);
    assert.deepEqual(await rows.evaluateAll(items => items.map(item => [
      item.classList.contains('leading'), getComputedStyle(item.querySelector('strong')).fontWeight,
      item.getAttribute('aria-label')
    ])), [[true,'700','A，1 人，人数最多'],[true,'700','B，1 人，人数最多'],[false,'400',null],[false,'400',null]]);
    assert.equal(await rows.first().locator('span').innerText(), '1 人');
    assert.equal(await rows.first().locator('small').innerText(), '50%');
    assert.equal(await page.locator('.distribution-note').count(), 0);
    const back = page.locator('#pane-back');
    assert.ok(await back.evaluate(button => {
      const style = getComputedStyle(button);
      return style.fontFamily.split(',')[0].replaceAll('"','').trim() === 'Microsoft YaHei' && style.fontWeight === '700' &&
        button.getBoundingClientRect().height >= 44;
    }));
    assert.ok(await rows.last().evaluate(row => row.getBoundingClientRect().bottom <= innerHeight),
      '在 260 像素的同窗详情中，四项分布都应在首屏可见');
    await page.keyboard.press('Tab');assert.equal(await back.evaluate(button => button === document.activeElement), true);
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
    assert.equal(await page.locator('#sync-status').innerText(),'已存本机 · 待同步');assert.ok(fixture.journals[0].session.endedAt);
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
  async function distribution(entries){
    await primary('结束收答');
    await page.waitForFunction(()=>window.__quizWheelState.lesson.phase==='result');
    const state=await wheel(page);
    assert.deepEqual(state.lesson.bars.map(bar => [bar.label,bar.count]),entries);
    assert.equal(state.panel,'');
    assert.doesNotMatch(JSON.stringify(state),/私密姓名|不应出现在/);
  }
  try{
    await primary('开始课堂');
    await primary('开始收答');await scan('A','B');await distribution([['A',1],['B',1],['C',0],['D',0]]);
    await next('boolean');await primary('开始收答');await scan('B','A');await distribution([['A 对',1],['B 错',1]]);
    await next('multiple');await primary('开始收答');await scan('A','B');
    const stale=(await wheel(page)).lesson.key;
    for(const [option,a,b] of [['B','B','A'],['C','A','B'],['D','A','B']]){
      await primary('下一项 '+option);
      await page.waitForFunction(opt=>window.__quizWheelState.lesson.option===opt && testScanner.running && !window.__quizWheelState.lesson.busy,option);
      assert.deepEqual((await wheel(page)).lesson.missing,[1,2]);
      await sector(page,'multi',{key:stale});
      await scan(a,b);
    }
    await distribution([['ACD',1],['B',1]]);
    await sector(page,'finish-confirmed',{key:(await wheel(page)).lesson.key});
    await page.waitForFunction(()=>window.__quizWheelState.lesson.phase==='done' && !window.__quizWheelState.lesson.needsSync);
    const result=await wheel(page);
    assert.equal(result.lesson.records.length,3);assert.deepEqual(result.lesson.records[2].bars,[{label:'ACD',count:1},{label:'B',count:1}]);
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
    assert.equal(await page.locator('#received').innerText(),'1');assert.match(await page.locator('#multi-progress').innerText(),/1.*2/);
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
    assert.match(await page.locator('#distribution').innerText(),/全不选 · 1 人/);assert.match(await page.locator('#distribution').innerText(),/AC · 1 人/);
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
    assert.equal(await suspendReply(page,1),true);
    await page.waitForFunction(()=>document.querySelector('#round-status').textContent.includes('已暂停'));
    assert.equal(fixture.journals[0].session.questions[0].rounds[0].status,'paused');
    assert.equal(await page.locator('#camera').evaluate(v=>v.srcObject),null);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

for (const fault of ['failCommit','loseCommitReply']) test('退出暂停失败只重试相同的落盘请求：'+fault,async()=>{
  const {page,context,fixture}=await open({companion:true,scannerFixture:true});
  const writes=()=>fixture.messages.filter(m=>m.action==='commit').map(m=>m.body.journal);
  try {
    await useNativeDisc(page); await startInPet(page); await sector(page,'collect');
    await page.waitForFunction(()=>testScanner.running && !__quizWheelState.lesson.busy);
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:1,option:'B'}));
    const before=copy(fixture.journals[0]);
    fixture[fault]=true;
    assert.equal(await suspendReply(page,1),false);
    assert.equal(await page.evaluate(()=>testScanner.running),false);
    assert.ok((await wheel(page)).retry);
    assert.match((await wheel(page)).feedback,/重读记录[\s\S]*再次退出/);
    const proposal=writes().at(-1), count=writes().length;
    assert.equal(proposal.events.at(-1).action,'recover');
    assert.deepEqual(fixture.journals[0],fault==='loseCommitReply'?proposal:before);

    // Visibility changes must neither retry an uncertain write nor acknowledge a host exit.
    await page.evaluate(()=>__quizReceive({type:'visibility',visible:false,nativeDisc:true}));
    assert.equal(writes().length,count);
    assert.equal(await page.evaluate(()=>__quizSuspendReplies.length),1);
    assert.equal(await suspendReply(page,2),false);
    fixture[fault]=false;
    assert.equal(await suspendReply(page,3),true);
    assert.deepEqual(writes().slice(count),[proposal,proposal]);
    assert.deepEqual(fixture.journals[0],proposal);
    assert.equal(proposal.session.seq,before.session.seq+1);
    assert.equal(proposal.session.questions[0].rounds[0].status,'paused');
    assert.equal(proposal.session.questions[0].rounds[0].answers.s1.option,'B');
    assert.equal((await wheel(page)).retry,false);
    assert.equal(await suspendReply(page,4),true);
    assert.equal(writes().length,count+2);
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('未确认的作答阻止正常退出，重读按实际落盘恢复，不重放作答',async()=>{
  const {page,context,fixture}=await open({companion:true,scannerFixture:true});
  try {
    await useNativeDisc(page); await startInPet(page); await sector(page,'collect');
    await page.waitForFunction(()=>testScanner.running && !__quizWheelState.lesson.busy);
    fixture.loseCommitReply=true;
    await assert.rejects(page.evaluate(()=>testScanner.options.onRead({cardNumber:2,option:'B'})),/保存尚未确认/);
    const saved=copy(fixture.journals[0]), count=fixture.messages.filter(m=>m.action==='commit').length;
    fixture.loseCommitReply=false;
    for (const id of [1,2]) assert.equal(await suspendReply(page,id),false);
    assert.equal(fixture.messages.filter(m=>m.action==='commit').length,count);
    assert.deepEqual(fixture.journals[0],saved);
    assert.ok((await wheel(page)).retry);
    await page.reload(); await useNativeDisc(page);
    await page.waitForFunction(()=>__quizWheelState.setup?.recovery);
    await sector(page,'setup-restore',{sessionId:saved.session.id});
    await page.waitForFunction(()=>__quizWheelState.lesson.phase==='paused' && !__quizWheelState.lesson.busy);
    assert.equal(await suspendReply(page,3),true);
    const restored=fixture.journals[0];
    assert.deepEqual(restored.events.map(e=>e.action),[...saved.events.map(e=>e.action),'recover']);
    assert.equal(restored.session.questions[0].rounds[0].answers.s2.option,'B');
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('系统终止时页面释放相机，下次按落盘的原轮恢复并更换采集代次',async()=>{
  const {page,context,fixture}=await open({companion:true,scannerFixture:true});
  try {
    await startInPet(page); await sector(page,'collect');
    await page.waitForFunction(()=>testScanner.running && !__quizWheelState.lesson.busy);
    await page.evaluate(()=>testScanner.options.onRead({cardNumber:2,option:'C'}));
    const saved=copy(fixture.journals[0]);
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
    assert.equal(await page.evaluate(()=>testScanner.running),false);
    assert.equal(await page.evaluate(()=>window.__quizSuspendReplies?.length ?? 0),0);
    assert.deepEqual(fixture.journals[0],saved);
    await page.reload();
    await page.waitForFunction(()=>__quizWheelState.setup?.recovery);
    await sector(page,'setup-restore',{sessionId:saved.session.id});
    await page.waitForFunction(()=>__quizWheelState.lesson.phase==='paused' && !__quizWheelState.lesson.busy);
    const restored=fixture.journals[0].session;
    assert.equal(restored.currentRoundId,saved.session.currentRoundId);
    assert.ok(restored.generation>saved.session.generation);
    assert.equal(restored.questions[0].rounds[0].answers.s2.option,'C');
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('首题落盘中的退出不会提前成功，结束保存后可再次退出',async()=>{
  const {page,context,fixture}=await open({companion:true,scannerFixture:true});
  let release;
  try {
    fixture.holdCommit=new Promise(resolve=>{release=resolve;});
    const writing=new Promise(resolve=>{fixture.commitStarted=resolve;});
    await sector(page,'setup-start',{selection:{publication:'',subject:'math',template:'single:4'}});
    await writing;
    assert.equal(await suspendReply(page,1),false);
    assert.equal(fixture.journals.length,0);
    release();
    await page.waitForFunction(()=>__quizWheelState.lesson.phase==='ready' && !__quizWheelState.lesson.busy);
    assert.equal(await suspendReply(page,2),true);
    assert.equal(fixture.journals.length,1);
    assert.deepEqual(fixture.errors,[]);
  } finally { release?.(); await context.close(); }
});

test('收起与两个退出请求共用一次暂停，落盘前不回执，落盘后分别匹配请求',async()=>{
  const {page,context,fixture}=await open({companion:true,scannerFixture:true});
  let release;
  try {
    await useNativeDisc(page); await startInPet(page); await sector(page,'collect');
    await page.waitForFunction(()=>testScanner.running && !__quizWheelState.lesson.busy);
    fixture.holdCommit=new Promise(resolve=>{release=resolve;});
    const writing=new Promise(resolve=>{fixture.commitStarted=resolve;});
    await page.evaluate(()=>__quizReceive({type:'visibility',visible:false,nativeDisc:true}));
    await writing;
    await page.evaluate(()=>{
      for (const id of [8,9]) __quizReceive({type:'suspend',suspendId:id});
    });
    assert.equal(await page.evaluate(()=>testScanner.running),false);
    assert.equal(await page.evaluate(()=>window.__quizSuspendReplies?.length ?? 0),0);
    assert.equal(fixture.journals[0].session.questions[0].rounds[0].status,'collecting');
    release();
    await page.waitForFunction(()=>window.__quizSuspendReplies?.length===2);
    assert.deepEqual(await page.evaluate(()=>__quizSuspendReplies.map(r=>[r.suspendId,r.saved])),[[8,true],[9,true]]);
    assert.equal(fixture.messages.filter(m=>m.action==='commit' && m.body.journal.events.at(-1).action==='recover').length,1);
    assert.equal(fixture.journals[0].session.questions[0].rounds[0].status,'paused');
    assert.deepEqual(fixture.errors,[]);
  } finally { release?.(); await context.close(); }
});

test('原生撤权通知立即停止相机并禁止继续收答，仍能保存暂停',async()=>{
  const{page,context,fixture}=await open();
  try{
    await create(page);await page.locator('#start').click();await page.locator('#stop:not([disabled])').waitFor();
    await page.evaluate(()=>window.__quizReceive({type:'authorization',revoked:true,message:'设备授权已失效'}));
    assert.equal(await suspendReply(page,1),true);
    await page.waitForFunction(()=>document.querySelector('#round-status').textContent.includes('已暂停'));
    assert.equal(await page.locator('#camera').evaluate(v=>v.srcObject),null);
    assert.equal(await page.locator('#start').isDisabled(),true);assert.equal(await page.locator('#camera-toggle').isDisabled(),true);
    assert.equal(fixture.journals[0].session.questions[0].rounds[0].status,'paused');
    assert.deepEqual(fixture.errors,[]);
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
    await page.waitForFunction(text=>document.querySelector('#question-text').textContent===text,change==='edit_question'?'手机已修改':'手机下一题');
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
    assert.match(await page.locator('#distribution').innerText(),/A · 0 人/);assert.match(await page.locator('#distribution').innerText(),/弃权 · 2 人/);
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

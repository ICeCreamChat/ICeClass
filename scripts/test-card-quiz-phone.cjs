'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..','web_controller'),origin='https://school.example';
let browser;
before(async()=>{browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});});
after(async()=>{await browser?.close();});
const copy=x=>JSON.parse(JSON.stringify(x));
async function open({unknown=false,status='pending',roundStatus='collecting',questionType='single',optionCount=4,previousPair=false}={}){
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),page=await context.newPage();
  const fixture={unknown,status,pollStatus:200,commands:[],receipts:[],errors:[],claims:[],state:{sessionId:'session-1',className:'测试班',subjectId:'math',questionId:'question-1',questionNumber:1,questionType:'single',optionCount:4,roundId:'round-1',roundStatus:'collecting',source:'phone',sourceId:'pair-1',generation:2,seq:3,received:0,expected:2,ended:false}};
  fixture.state.roundStatus=roundStatus;
  fixture.state.questionType=questionType;fixture.state.optionCount=optionCount;
  if(questionType==='multiple'){fixture.state.activeOption='A';fixture.state.optionReceived=0;}
  await page.addInitScript(()=>{window.CardQuizScanner=class{constructor(options){window.testScanner=this;this.options=options;this.running=false;}start(){this.running=true;return Promise.resolve();}stop(){this.running=false;}reset(key,count){this.key=key;this.optionCount=count;} };});
  if(previousPair)await page.addInitScript(()=>sessionStorage.setItem('iceclass.cardQuizPair',JSON.stringify({pairId:'old-pair'})));
  page.on('pageerror',error=>fixture.errors.push(error.message));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());assert.equal(url.origin,origin);
    const fulfill=(body,status=200)=>route.fulfill({status,json:body});
    if(url.pathname==='/api/session')return fulfill({authenticated:true,user:{id:'teacher',displayName:'教师',csrfToken:'csrf'}});
    if(url.pathname==='/api/card-quiz/pair'){
      fixture.claims.push(route.request().postDataJSON().code);
      return fulfill({pairId:'pair-1',classId:'class-1',sessionId:'session-1',expiresAt:Date.now()+3600000});
    }
    if(url.pathname==='/api/card-quiz/pairs/old-pair')return fulfill({error:'旧配对已失效'},403);
    if(url.pathname==='/api/card-quiz/pairs/pair-1'){
      const hold=fixture.holdPoll;fixture.holdPoll=null;if(hold){fixture.pollStarted?.();await hold;}
      if(fixture.pollStatus===0)return route.abort('failed');
      return fixture.pollStatus===200?fulfill({state:copy(fixture.state),connected:true,receipts:copy(fixture.receipts)}):fulfill({error:'配对授权已失效'},fixture.pollStatus);
    }
    if(url.pathname.endsWith('/commands')){
      const command=route.request().postDataJSON();fixture.commands.push(command);
      if(fixture.unknown)return route.abort('failed');
      return fulfill({status:fixture.status,id:command.id,error:fixture.status==='rejected'?'这次操作被拒绝':undefined});
    }
    if(url.pathname.endsWith('/scanner.js'))return route.fulfill({body:'/* isolated scanner fixture */',contentType:'application/javascript'});
    const file=path.resolve(root,'.'+url.pathname);assert.ok(file.startsWith(root+path.sep));
    return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:'Not found'});
  });
  try{
    await page.goto(origin+'/card-quiz/phone.html?code=DEMO');
    await page.locator('#capture:not([hidden])').waitFor({timeout:5000});
    await page.locator(roundStatus==='closed'?'#start:not([disabled])':'#stop:not([disabled])').waitFor({timeout:5000});
  }
  catch(error){await context.close();throw error;}
  return{page,context,fixture};
}

test('扫描新二维码优先配对新课堂，不沿用手机上的旧连接',async()=>{
  const{context,page,fixture}=await open({previousPair:true});
  try{
    assert.deepEqual(fixture.claims,['DEMO']);
    assert.match(await page.locator('#connection').innerText(),/正在收答/);
    assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('iceclass.cardQuizPair')).pairId),'pair-1');
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('手机接力可恢复白板暂停的同一轮，确认前不打开相机',async()=>{
  const {context,page,fixture}=await open({roundStatus:'paused'});
  try {
    assert.equal(await page.locator('#start').innerText(),'恢复本轮');
    assert.equal(await page.locator('#camera').isVisible(),false);
    await page.locator('#start').click();
    await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    const request=fixture.commands[0];
    assert.equal(request.action,'resume_round');
    assert.equal(request.roundId,'round-1');
    assert.equal(await page.evaluate(()=>testScanner.running),false);
    fixture.state={...fixture.state,roundStatus:'collecting',generation:3,seq:4,received:1};
    fixture.receipts=[{id:request.id,status:'confirmed',result:{state:fixture.state,seq:4}}];
    await page.waitForFunction(()=>testScanner.running);
    assert.match(await page.locator('#capture-progress').innerText(),/待收 1 人/);
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('手机多选候选绑定收答项，换项后主动开相机，新题支持多选',async()=>{
  const{page,context,fixture}=await open({questionType:'multiple'});
  try{
    assert.match(await page.locator('#question-label').innerText(),/多选/);assert.equal(await page.evaluate(()=>testScanner.optionCount),2);
    await page.locator('#camera-toggle').click();await page.evaluate(()=>{void testScanner.options.onRead({cardNumber:1,option:'A'}).catch(()=>{});});
    await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    assert.deepEqual(fixture.commands[0].payload,{cardNumber:1,option:'A',targetOption:'A'});
    fixture.state={...fixture.state,seq:4,optionReceived:1};fixture.receipts=[{id:fixture.commands[0].id,status:'confirmed',result:{seq:4,status:'confirmed',state:copy(fixture.state)}}];
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('已保存'));
    await page.locator('#multi-next').click();await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    assert.equal(await page.evaluate(()=>testScanner.running),false);assert.equal(fixture.commands[1].action,'set_multi_option');assert.deepEqual(fixture.commands[1].payload,{option:'B'});
    fixture.state={...fixture.state,seq:5,generation:3,activeOption:'B',optionReceived:0};fixture.receipts=[{id:fixture.commands[1].id,status:'confirmed',result:{seq:5,status:'confirmed',state:copy(fixture.state)}}];
    await page.waitForFunction(()=>document.querySelector('#multi-option').value==='B'&&!document.querySelector('#multi-option').disabled);
    assert.equal(await page.evaluate(()=>testScanner.running),false);
    await page.locator('#camera-toggle').click();await page.evaluate(()=>{void testScanner.options.onRead({cardNumber:1,option:'B'}).catch(()=>{});});
    await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    assert.equal(fixture.commands[2].payload.targetOption,'B');
    fixture.state={...fixture.state,seq:6,roundStatus:'closed'};fixture.receipts=[{id:fixture.commands[2].id,status:'confirmed',result:{seq:6,status:'confirmed',state:copy(fixture.state)}}];
    await page.locator('#next:not([disabled])').waitFor();await page.locator('#next-type').selectOption('multiple');await page.locator('#next-count').selectOption('3');await page.locator('#next').click();
    await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    assert.equal(fixture.commands[3].payload.type,'multiple');assert.equal(fixture.commands[3].payload.options.length,3);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('白板更换多选收答项时手机停相机，既有候选不自动带入新项',async()=>{
  const{page,context,fixture}=await open({questionType:'multiple',optionCount:2});
  try{
    await page.locator('#camera-toggle').click();assert.equal(await page.evaluate(()=>testScanner.running),true);
    fixture.state={...fixture.state,seq:4,generation:3,activeOption:'B',optionReceived:0};
    await page.waitForFunction(()=>document.querySelector('#multi-option').value==='B');
    assert.equal(await page.evaluate(()=>testScanner.running),false);assert.equal(fixture.commands.length,0);
    assert.equal(await page.locator('#multi-next').isDisabled(),true);assert.equal(await page.locator('#multi-option option').count(),2);
    await page.locator('#camera-toggle').click();assert.equal(await page.evaluate(()=>testScanner.running),true);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('手机多选标准答案可勾选组合，未确认保存保留选择和原版本',async()=>{
  const{page,context,fixture}=await open({questionType:'multiple',roundStatus:'closed'});
  try{
    await page.locator('#edit-multiple-answer input[value="C"]').check();await page.locator('#edit-multiple-answer input[value="A"]').check();
    await page.locator('#question-edit').click();await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    assert.equal(fixture.commands[0].payload.answer,'AC');assert.equal(fixture.commands[0].payload.expectedSeq,3);
    fixture.receipts=[{id:fixture.commands[0].id,status:'rejected',error:'版本已变化'}];
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('版本已变化'));
    assert.equal(await page.locator('#edit-multiple-answer input[value="A"]').isChecked(),true);
    assert.equal(await page.locator('#edit-multiple-answer input[value="C"]').isChecked(),true);
    await page.locator('#edit-reset').click();assert.equal(await page.locator('#edit-multiple-answer input:checked').count(),0);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});
test('手机只在白板回执后显示已保存；拒绝不报成功，窄屏和键盘可用',async()=>{
  const{page,context,fixture}=await open();
  try{
    await page.locator('#stop').click();await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    assert.doesNotMatch(await page.locator('#feedback').innerText(),/已保存/);
    const id=fixture.commands[0].id;fixture.receipts=[{id,status:'rejected',error:'旧轮次已封存'}];
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('封存'));
    assert.doesNotMatch(await page.locator('#feedback').innerText(),/已保存/);
    assert.equal(await page.locator('#stop').isEnabled(),true);
    fixture.receipts=[];await page.locator('#stop').click();
    await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    fixture.state={...fixture.state,roundStatus:'closed',seq:4};fixture.receipts=[{id:fixture.commands.at(-1).id,status:'confirmed',result:{status:'confirmed',seq:4,state:copy(fixture.state)}}];
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('已保存'));
    assert.equal(await page.locator('#received').innerText(),'0');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>document.activeElement!==document.body));assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});
test('发送回执丢失且服务端查无请求时停止相机并解除等待，明确提示未确认',async()=>{
  const{page,context,fixture}=await open({unknown:true});
  try{
    await page.locator('#stop').click();await page.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('尚未确认'));
    await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('未确认'),null,{timeout:8000});
    assert.doesNotMatch(await page.locator('#feedback').innerText(),/已保存/);assert.equal(fixture.commands.length,1,'never replay an uncertain answer');
    assert.equal(await page.evaluate(()=>testScanner.running),false);
    await page.waitForFunction(()=>!document.querySelector('#stop').disabled);
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});
test('授权撤回清理待确认操作，重新配对不被旧controlBusy锁住',async()=>{
  const{page,context,fixture}=await open();
  try{
    await page.locator('#stop').click();await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    fixture.pollStatus=403;await page.locator('#pairing:not([hidden])').waitFor();fixture.pollStatus=200;
    await page.locator('#code').fill('AGAIN');await page.locator('#pair-form button').click();
    await page.locator('#capture:not([hidden])').waitFor();await page.waitForFunction(()=>!document.querySelector('#stop').disabled,{},{timeout:5000});
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

for(const status of [0,503])test('临时断线刷新连接状态并禁用在线操作：'+status,async()=>{
  const{page,context,fixture}=await open();
  try{
    await page.locator('#camera-toggle').click();assert.equal(await page.evaluate(()=>testScanner.running),true);
    fixture.pollStatus=status;await page.waitForFunction(()=>document.querySelector('#stop').disabled);
    assert.equal(await page.evaluate(()=>testScanner.running),false);assert.equal(await page.locator('#camera-toggle').isDisabled(),true);
    assert.equal(await page.locator('#camera-toggle').innerText(),'开启相机');assert.doesNotMatch(await page.locator('#connection').innerText(),/正在收答/);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('开始请求待确认时进入后台，迟到确认仍被记录但不会重新开相机',async()=>{
  const{page,context,fixture}=await open({roundStatus:'closed'});
  try{
    await page.locator('#start').click();await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    let release;fixture.holdPoll=new Promise(resolve=>release=resolve);await new Promise(resolve=>fixture.pollStarted=resolve);
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
    fixture.state={...fixture.state,roundStatus:'collecting',generation:3,seq:4};fixture.receipts=[{id:fixture.commands[0].id,status:'confirmed',result:{seq:4,status:'confirmed',state:copy(fixture.state)}}];release();
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('已保存'));
    assert.equal(await page.evaluate(()=>testScanner.running),false);assert.equal(await page.locator('#received').innerText(),'0');assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('手机编辑保留开始输入时的版本，并发变更后须清空重填',async()=>{
  const{page,context,fixture}=await open({roundStatus:'closed'});
  try{
    await page.locator('#edit-value').fill('B');fixture.state.seq=4;
    await page.waitForTimeout(1400);await page.locator('#question-edit').click();
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('草稿已保留'));
    assert.equal(fixture.commands.length,0);assert.equal(await page.locator('#edit-value').inputValue(),'B');
    await page.locator('#edit-reset').click();await page.locator('#edit-value').fill('A');await page.locator('#question-edit').click();
    await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    assert.equal(fixture.commands[0].payload.expectedSeq,4);assert.equal(fixture.commands[0].payload.answer,'A');assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

for(const field of ['text','tags','answer'])test('手机合法清空'+field+'仍绑定原版本，只有显式重填才能更新版本',async()=>{
  const{page,context,fixture}=await open({roundStatus:'closed'});
  try{
    await page.locator('#edit-field').selectOption(field);await page.locator('#edit-value').fill('B');await page.locator('#edit-value').fill('');
    fixture.state.seq=4;await page.waitForTimeout(1400);await page.locator('#question-edit').click();
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('草稿已保留'));
    assert.equal(fixture.commands.length,0);assert.equal(await page.locator('#edit-value').inputValue(),'');
    await page.locator('#edit-reset').click();await page.locator('#question-edit').click();
    await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    assert.equal(fixture.commands[0].payload.expectedSeq,4);
    assert.deepEqual(fixture.commands[0].payload[field],field==='text'?'':field==='tags'?[]:null);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

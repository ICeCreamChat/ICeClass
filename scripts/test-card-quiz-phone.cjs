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
const scanInvite='T'.repeat(32);
async function open({unknown=false,status='pending',roundStatus='collecting',questionType='single',optionCount=4,
  previousPair=false,manualLogin=false,setupCamera,scan,withoutQuerySize=false}={}){
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),page=await context.newPage();
  const fixture={unknown,status,pollStatus:200,commands:[],receipts:[],errors:[],claims:[],state:{sessionId:'session-1',className:'测试班',subjectId:'math',questionId:'question-1',questionNumber:1,questionType:'single',optionCount:4,roundId:'round-1',roundStatus:'collecting',source:'phone',sourceId:'pair-1',generation:2,seq:3,received:0,expected:2,ended:false}};
  fixture.state.roundStatus=roundStatus;
  fixture.state.questionType=questionType;fixture.state.optionCount=optionCount;
  fixture.sessionChecks=0;fixture.scanKeys=[];fixture.scanClaims=[];fixture.waiting=scan?.waiting;
  if(questionType==='multiple'){fixture.state.activeOption='A';fixture.state.optionReceived=0;}
  if(withoutQuerySize)await page.addInitScript(()=>{delete URLSearchParams.prototype.size;});
  if(setupCamera)await page.addInitScript(setupCamera);
  else await page.addInitScript(()=>{window.CardQuizScanner=class{
    constructor(options){window.testScanner=this;this.options=options;this.running=false;this.starts=0;}
    start(){this.starts++;this.running=true;return Promise.resolve();}
    stop(){this.running=false;}
    setReading(enabled){this.reading=enabled;}
    reset(key,count){this.key=key;this.optionCount=count;}
    cardsInView(){return new Map([[1,'A']]);}
    waitForNewPresentation(cards){this.held=[...cards];}
  };});
  if(previousPair)await page.addInitScript(()=>{if(!sessionStorage.getItem('iceclass.cardQuizPair'))sessionStorage.setItem('iceclass.cardQuizPair',JSON.stringify({pairId:'old-pair'}));});
  if(scan)await context.addCookies([{name:'iceclass_session',value:'unrelated-session',url:origin}]);
  page.on('pageerror',error=>fixture.errors.push(error.message));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());assert.equal(url.origin,origin);
    const fulfill=(body,status=200)=>route.fulfill({status,json:body});
    const user={id:'teacher',displayName:'教师',csrfToken:'csrf'};
    if(url.pathname==='/api/session'){fixture.sessionChecks++;return fulfill({authenticated:!manualLogin,user:manualLogin?null:user});}
    if(scan && url.pathname.startsWith('/api/card-quiz/')){
      const headers=await route.request().allHeaders();
      fixture.scanKeys.push(headers['x-iceclass-scanner']);
      assert.equal(headers.cookie,undefined);
    }
    if(url.pathname==='/api/card-quiz/scan'){
      fixture.scanClaims.push(route.request().postDataJSON().invite);
      if(scan?.loseFirst && fixture.scanClaims.length===1)return route.abort('failed');
      if(scan?.expired)return fulfill({error:'二维码已过期，请在白板重新打开扫码。'},410);
      return fulfill({pairId:'pair-1',mode:'scan',expiresAt:Date.now()+3600000});
    }
    if(url.pathname==='/api/auth/login')return fulfill({user});
    if(url.pathname==='/api/card-quiz/pair'){
      fixture.claims.push(route.request().postDataJSON().code);
      return fulfill({pairId:'pair-1',classId:'class-1',sessionId:'session-1',expiresAt:Date.now()+3600000});
    }
    if(url.pathname==='/api/card-quiz/pairs/old-pair')return fulfill({error:'旧配对已失效'},403);
    if(url.pathname==='/api/card-quiz/pairs/pair-1'){
      const hold=fixture.holdPoll;fixture.holdPoll=null;if(hold){fixture.pollStarted?.();await hold;}
      if(fixture.pollStatus===0)return route.abort('failed');
      const connected=fixture.boardOnline!==false && fixture.state.source==='phone' &&
        fixture.state.sourceId==='pair-1' && !fixture.state.ended;
      const requested=url.searchParams.get('preview');
      const preview=requested && fixture.preview ? (requested===fixture.preview.id ? {id:requested} : fixture.preview) : undefined;
      const ids=new Set(url.searchParams.getAll('commandId'));
      const receipts=fixture.receipts.filter(receipt=>ids.has(receipt.id));
      return fixture.pollStatus===200?fulfill({state:fixture.waiting?null:copy(fixture.state),connected:!fixture.waiting&&connected,boardOnline:fixture.waiting?fixture.boardOnline!==false:undefined,receipts,preview}):fulfill({error:'配对授权已失效'},fixture.pollStatus);
    }
    if(url.pathname==='/api/card-quiz/pairs/pair-1/preview'){
      const {id}=route.request().postDataJSON();
      return id===fixture.preview?.id ? fulfill({id}) : fulfill({error:'取景连接已更新'},409);
    }
    if(url.pathname.endsWith('/commands')){
      const command=route.request().postDataJSON();fixture.commands.push(command);
      if(fixture.unknown)return route.abort('failed');
      return fulfill({status:fixture.status,id:command.id,error:fixture.status==='rejected'?'这次操作被拒绝':undefined});
    }
    if(!setupCamera&&url.pathname.endsWith('/scanner.js'))return route.fulfill({body:'/* isolated scanner fixture */',contentType:'application/javascript'});
    const file=path.resolve(root,'.'+url.pathname);assert.ok(file.startsWith(root+path.sep));
    return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:'Not found'});
  });
  try{
    if(scan){
      await page.goto(origin+'/card-quiz/phone.html#scan='+scanInvite);
      return {page,context,fixture};
    }
    if(manualLogin){
      await page.goto(origin+'/card-quiz/phone.html?manual=1');
      await page.locator('#login-form').waitFor();
      return {page,context,fixture};
    }
    await page.goto(origin+'/card-quiz/phone.html?code=DEMO');
    await page.locator('#capture:not([hidden])').waitFor({timeout:5000});
    await page.locator(roundStatus==='closed'?'#start:not([disabled])':'#stop:not([disabled])').waitFor({timeout:5000});
  }
  catch(error){await context.close();throw error;}
  return{page,context,fixture};
}

test('扫白板新码直接进入收答，丢失领取回执或刷新后仍使用同一把手机密钥',async()=>{
  const {page,context,fixture}=await open({previousPair:true,scan:{loseFirst:true,waiting:true},questionType:'multiple',withoutQuerySize:true});
  try {
    await page.getByText('正在连接白板',{exact:true}).waitFor();
    assert.equal(new URL(page.url()).hash,'');
    assert.equal(await page.locator('#login,#pairing,#round').evaluateAll(nodes=>nodes.some(n=>!n.hidden)),false);
    await page.reload();
    fixture.waiting=false;
    await page.getByRole('button',{name:'关闭相机'}).waitFor();
    assert.equal(await page.locator('#question-type').innerText(),'多选 · 收 A 项');
    assert.equal(await page.locator('#feedback').innerText(),'');
    for(const id of ['start','stop','multi-next','multi-option','round-tools'])
      assert.equal(await page.locator('#'+id).isVisible(),false,id);
    await page.getByRole('button',{name:'关闭相机'}).click();
    await page.reload();
    await page.getByRole('button',{name:'开启相机'}).waitFor();
    await page.getByRole('button',{name:'开启相机'}).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button',{name:'关闭相机'}).waitFor();
    fixture.state={...fixture.state,roundStatus:'closed',seq:4};
    await page.getByText('已封存',{exact:true}).waitFor();
    assert.equal(await page.locator('#camera-toggle').isVisible(),false);
    assert.equal(await page.locator('#round-tools').isVisible(),false);
    fixture.pollStatus=403;
    await page.getByText(/连接已结束/).waitFor();
    assert.equal(await page.locator('#pairing').isVisible(),false);
    assert.equal(fixture.sessionChecks,0);
    assert.deepEqual(fixture.claims,[]);
    assert.deepEqual(fixture.scanClaims,[scanInvite,scanInvite]);
    assert.match(fixture.scanKeys[0],/^[0-9a-f]{64}$/);
    assert.equal(new Set(fixture.scanKeys).size,1);
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('缺少 URLSearchParams.size 时 52 张卡逐条确认，超过一分钟仍可取景收答',{timeout:20000},async()=>{
  const {page,context,fixture}=await open({scan:{},withoutQuerySize:true});
  try {
    await page.getByRole('button',{name:'关闭相机'}).waitFor();
    assert.equal(await page.evaluate(()=>'size' in new URLSearchParams()),false);
    const submittedAt=Date.now();
    await page.clock.setFixedTime(submittedAt);
    const cards=Array.from({length:52},(_,index)=>index+1);
    fixture.state.expected=cards.length;
    const posted=page.waitForResponse(response=>response.url().endsWith('/commands') && fixture.commands.length===cards.length);
    await page.evaluate(numbers=>{
      window.cardResults=Promise.allSettled(numbers.map(cardNumber=>testScanner.options.onRead({cardNumber,option:'A'})));
    },cards);
    await posted;
    await page.getByText('52 条待白板确认',{exact:true}).waitFor();
    assert.equal(await page.locator('#received').innerText(),'0');

    const isPairPoll=request=>new URL(request.url()).pathname==='/api/card-quiz/pairs/pair-1';
    const poll=page.waitForResponse(async response=>
      isPairPoll(response) && (await response.json()).state.received===cards.length);
    fixture.receipts=fixture.commands.map(({id},index)=>{
      const state={...fixture.state,seq:fixture.state.seq+index+1,received:index+1};
      return {id,status:'confirmed',result:{seq:state.seq,status:'confirmed',state}};
    });
    fixture.state=fixture.receipts.at(-1).result.state;
    const query=new URL((await poll).url()).searchParams;
    await page.locator('#progress-ring[aria-valuenow="52"]').waitFor();

    await page.clock.setFixedTime(submittedAt+61000);
    const later=new URL((await page.waitForResponse(isPairPoll)).url()).searchParams;
    const outcome=await page.evaluate(async()=>({
      confirmed:(await window.cardResults).filter(result=>result.status==='fulfilled').length,
      scanning:testScanner.running,
      submission:document.getElementById('submission-status').textContent
    }));
    const ids=query.getAll('commandId');
    assert.deepEqual({requested:ids.length,preview:query.get('preview'),...outcome},
      {requested:52,preview:'open',confirmed:52,scanning:true,submission:''});
    assert.equal(new Set(ids).size,52);
    assert.deepEqual(ids.sort(),fixture.commands.map(command=>command.id).sort());
    assert.deepEqual(fixture.commands.map(command=>command.payload.cardNumber).sort((a,b)=>a-b),cards);
    assert.deepEqual([...later],[['preview','open']]);
    await page.getByRole('button',{name:'关闭相机'}).click();
    assert.equal((await page.waitForRequest(isPairPoll)).url(),origin+'/api/card-quiz/pairs/pair-1');
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('无效的扫码邀请原处提示重新扫码，已有教师配对不会被恢复',async()=>{
  const {page,context,fixture}=await open({previousPair:true,scan:{expired:true}});
  try {
    await page.getByText(/二维码已过期/).waitFor();
    await page.reload();
    await page.getByText(/扫新码连接/).waitFor();
    assert.equal(await page.locator('#login,#pairing,#capture').evaluateAll(nodes=>nodes.some(n=>!n.hidden)),false);
    assert.equal(fixture.sessionChecks,0);
    assert.equal(fixture.scanClaims.length,1);
    const newInvite='N'.repeat(32);
    await page.evaluate(invite=>{location.hash='scan='+invite;},newInvite);
    await page.getByText(/二维码已过期/).waitFor();
    assert.deepEqual(fixture.scanClaims,[scanInvite,newInvite]);
    assert.notEqual(fixture.scanKeys[0],fixture.scanKeys[1]);
    assert.equal(fixture.sessionChecks,0);
  } finally { await context.close(); }
});

test('白板停止提供本轮状态时释放手机镜头，恢复连接后由教师重新开启',async()=>{
  const {page,context,fixture}=await open({scan:{}});
  try{
    await page.getByRole('button',{name:'关闭相机'}).waitFor();
    fixture.waiting=true;fixture.boardOnline=false;
    await page.getByText('白板离线',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.testScanner.running),false);
    fixture.waiting=false;fixture.boardOnline=true;
    await page.getByRole('button',{name:'开启相机'}).waitFor();
    assert.equal(await page.evaluate(()=>window.testScanner.running),false);
  }finally{await context.close();}
});

test('扫码收答遇到暂时断网，保留镜头，校验新代次才收下一项',async()=>{
  const {page,context,fixture}=await open({scan:{},questionType:'multiple'});
  try{
    await page.getByRole('button',{name:'关闭相机'}).waitFor();
    fixture.pollStatus=503;
    await page.getByText('正在重连',{exact:true}).waitFor({timeout:5000});
    assert.deepEqual(await page.evaluate(()=>[testScanner.running,testScanner.reading,testScanner.starts]),[true,false,1]);
    const blocked=await page.evaluate(()=>testScanner.options.onRead({cardNumber:1,option:'A'}).then(()=>false,()=>true));
    assert.equal(blocked,true);
    assert.deepEqual(fixture.commands,[]);
    Object.assign(fixture.state,{activeOption:'B',generation:3,seq:4});
    fixture.pollStatus=200;
    await page.getByText('多选 · 收 B 项',{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>[testScanner.running,testScanner.reading,testScanner.starts,testScanner.held]),
      [true,true,1,[[1,'A']]]);
    const answer=page.waitForResponse(res=>res.url().endsWith('/commands'));
    await page.evaluate(()=>{void testScanner.options.onRead({cardNumber:2,option:'A'});});
    assert.deepEqual((await answer).request().postDataJSON().payload,{cardNumber:2,option:'A',targetOption:'B'});
    assert.equal(fixture.commands[0].generation,3);
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('扫码断网超出恢复窗口会关镜头，重新联网后手动开启',async()=>{
  const {page,context,fixture}=await open({scan:{}});
  try{
    await page.getByRole('button',{name:'关闭相机'}).waitFor();
    fixture.pollStatus=0;
    await page.getByText('正在重连',{exact:true}).waitFor({timeout:5000});
    await page.getByText('白板离线',{exact:true}).waitFor({timeout:15000});
    assert.deepEqual(await page.evaluate(()=>[testScanner.running,testScanner.starts]),[false,1]);
    fixture.pollStatus=200;
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    const camera=page.getByRole('button',{name:'开启相机'});
    await camera.waitFor({timeout:16000});
    assert.equal(await page.evaluate(()=>testScanner.running),false);
    await camera.click();
    assert.deepEqual(await page.evaluate(()=>[testScanner.running,testScanner.starts]),[true,2]);
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('扫码正在重连时手动关闭或切到后台，恢复连接后保持关闭',async()=>{
  const {page,context,fixture}=await open({scan:{}});
  try{
    const close=page.getByRole('button',{name:'关闭相机'});
    const openCamera=page.getByRole('button',{name:'开启相机'});
    for(const background of [false,true]){
      await close.waitFor();
      fixture.pollStatus=0;
      await page.getByText('正在重连',{exact:true}).waitFor();
      if(background)await page.evaluate(()=>{
        Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      else await close.click();
      assert.equal(await page.evaluate(()=>testScanner.running),false);
      fixture.pollStatus=200;
      await page.evaluate(hidden=>{
        if(hidden){delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));}
        else window.dispatchEvent(new Event('online'));
      },background);
      await openCamera.waitFor();
      assert.deepEqual(await page.evaluate(()=>[testScanner.running,testScanner.starts]),[false,background?2:1]);
      if(!background)await openCamera.click();
    }
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('扫码自动开镜头遭拒后只显示一次许可提示，可以原处重试',async()=>{
  const {page,context,fixture}=await open({scan:{},setupCamera:()=>{
    window.cameraAttempts=0;
    navigator.mediaDevices.getUserMedia=async()=>{window.cameraAttempts++; throw new DOMException('denied','NotAllowedError');};
  }});
  try {
    await page.getByText(/并允许访问相机/).waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(()=>window.cameraAttempts),1);
    await page.getByRole('button',{name:'开启相机'}).click();
    await page.getByText(/相机权限未开启/).waitFor();
    assert.equal(await page.evaluate(()=>window.cameraAttempts),2);
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('扫码收四项沿用同一镜头，封存释放，下一题跟随白板，手动关闭后保持关闭',async()=>{
  const {page,context,fixture}=await open({scan:{},questionType:'multiple'});
  try {
    await page.getByRole('button',{name:'关闭相机'}).waitFor();
    for(const option of ['B','C','D']){
      Object.assign(fixture.state,{activeOption:option,generation:fixture.state.generation+1,seq:fixture.state.seq+1});
      await page.getByText('多选 · 收 '+option+' 项',{exact:true}).waitFor();
      assert.deepEqual(await page.evaluate(()=>[testScanner.running,testScanner.starts,testScanner.held]),[true,1,[[1,'A']]]);
    }
    Object.assign(fixture.state,{roundStatus:'closed',generation:6,seq:7});
    await page.getByText('已封存',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>testScanner.running),false);
    Object.assign(fixture.state,{questionId:'question-2',questionNumber:2,roundId:'round-2',roundStatus:'collecting',questionType:'single',generation:8,seq:9});
    await page.getByRole('button',{name:'关闭相机'}).waitFor({timeout:4500});
    assert.equal(await page.evaluate(()=>testScanner.starts),2);
    await page.getByRole('button',{name:'关闭相机'}).click();
    Object.assign(fixture.state,{roundId:'round-3',generation:10,seq:11});
    await page.waitForFunction(()=>testScanner.key.endsWith('/10'));
    assert.deepEqual(await page.evaluate(()=>[testScanner.running,testScanner.starts]),[false,2]);
    assert.deepEqual(fixture.errors,[]);
  } finally { await context.close(); }
});

test('教师登录后手动配对，白板确认再开放相机，轮间工具不占收答画面',async()=>{
  const {page,context,fixture}=await open({manualLogin:true,withoutQuerySize:true});
  try{
    assert.equal(await page.locator('#question-form').isVisible(),false);
    await page.getByLabel('账号',{exact:true}).fill('teacher');
    await page.getByLabel('密码',{exact:true}).fill('fixture-only');
    await page.getByRole('button',{name:'登录并继续'}).click();
    await page.locator('#pair-form').waitFor();
    assert.equal(await page.locator('#account').innerText(),'教师');
    fixture.state.source='board';fixture.state.sourceId='board';
    await page.getByLabel('白板配对码').fill('manual');
    await page.getByRole('button',{name:'连接课堂'}).click();
    const awaitingBoard=page.getByText('请在白板确认',{exact:true});
    await awaitingBoard.waitFor({timeout:4000});
    assert.equal(await page.locator('#camera-toggle').isVisible(),false);
    fixture.pollStatus=503;
    await page.getByText('白板离线',{exact:true}).waitFor();
    fixture.pollStatus=200;
    await awaitingBoard.waitFor();
    assert.equal(await page.locator('#feedback').innerText(),'');
    fixture.state={...fixture.state,source:'phone',sourceId:'pair-1',seq:4};
    await page.getByRole('button',{name:'开启相机'}).waitFor();
    fixture.boardOnline=false;
    await page.getByText('白板离线',{exact:true}).waitFor();
    assert.equal(await page.locator('#camera-toggle').isVisible(),false);
    assert.equal(await page.locator('#round-tools').isVisible(),false);
    assert.deepEqual(fixture.claims,['MANUAL']);
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('等待相机许可时可取消；迟到的视频轨释放，拒绝后原处提示并可重试',async()=>{
  const {page,context,fixture}=await open({setupCamera:()=>{
    let attempts=0;
    navigator.mediaDevices.getUserMedia=async()=>{
      if(++attempts>1)throw new DOMException('Permission denied','NotAllowedError');
      await new Promise(resolve=>{window.allowCamera=resolve;});
      const canvas=document.createElement('canvas');
      const stream=canvas.captureStream(12);
      window.lateTrack=stream.getVideoTracks()[0];
      return stream;
    };
  }});
  try{
    const toggle=page.locator('#camera-toggle'),status=page.locator('#camera-status');
    await toggle.click();
    assert.equal(await toggle.innerText(),'取消开启');
    assert.ok(await page.locator('#camera').isVisible());
    assert.match(await status.innerText(),/允许/);
    await toggle.press('Enter');
    await page.evaluate(()=>window.allowCamera());
    await page.waitForFunction(()=>window.lateTrack?.readyState==='ended');
    assert.equal(await page.locator('#camera').isVisible(),false);
    await toggle.click();
    await page.waitForFunction(()=>document.getElementById('camera-status').textContent.includes('权限'));
    assert.match(await status.innerText(),/允许.*重试/);
    assert.equal(await toggle.isEnabled(),true);
    assert.equal(fixture.commands.length,0);
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

for(const [callbacks,counter] of [[true,0],[false,0],[false,1]])test('小屏相机连续收两张卡，解码计数固定为 '+counter+'，呈现回调'+(callbacks?'可用':'缺失'),async()=>{
  const {page,context,fixture}=await open({setupCamera:()=>{
    HTMLVideoElement.prototype.getVideoPlaybackQuality=()=>({totalVideoFrames:0,droppedVideoFrames:0});
    navigator.mediaDevices.getUserMedia=async()=>{
      const canvas=document.createElement('canvas');
      canvas.width=360;canvas.height=180;
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='white';ctx.fillRect(0,0,360,180);
      ctx.fillStyle='black';
      for(const number of [1,2]){
        const cells=CardQuizCards.matrix(number);
        for(let y=0;y<8;y++)for(let x=0;x<8;x++){
          const white=number===1?cells[y][x]:cells[x][7-y];
          if(!white)ctx.fillRect(10+(number-1)*180+x*20,10+y*20,20,20);
        }
      }
      const stream=canvas.captureStream(12);
      window.testTrack=stream.getVideoTracks()[0];
      let tick=0;
      const timer=setInterval(()=>{
        if(window.testTrack.readyState==='ended'){clearInterval(timer);return;}
        if(window.freezeTestImage)return;
        ctx.fillStyle=++tick%2?'black':'white';
        ctx.fillRect(0,0,8,8);
      },80);
      return stream;
    };
  }});
  try{
    await page.setViewportSize({width:320,height:568});
    if(!callbacks)await page.locator('#camera').evaluate((video,count)=>{
      Object.defineProperty(video,'requestVideoFrameCallback',{value:undefined});
      Object.defineProperty(video,'webkitDecodedFrameCount',{value:0});
      Object.defineProperty(video,'getVideoPlaybackQuality',{value:()=>({totalVideoFrames:count,droppedVideoFrames:0})});
    },counter);
    await page.addScriptTag({url:origin+'/card-quiz/cards.js'});
    const deliveries=[1,2].map(number=>page.waitForResponse(response=>
      response.url().endsWith('/commands')&&response.request().postDataJSON().payload.cardNumber===number));
    await Promise.all([...deliveries,page.getByRole('button',{name:'开启相机'}).click()]);
    await page.waitForFunction(()=>document.getElementById('submission-status').textContent.includes('2 条'));
    assert.deepEqual(fixture.commands.map(c=>c.payload).sort((a,b)=>a.cardNumber-b.cardNumber),
      [{cardNumber:1,option:'A'},{cardNumber:2,option:'B'}]);
    assert.equal(await page.locator('#received').innerText(),'0');
    assert.ok(await page.locator('#camera').evaluate(v=>{
      const bounds=v.getBoundingClientRect();
      return bounds.top<innerHeight&&bounds.bottom>0&&document.documentElement.scrollWidth<=innerWidth;
    }));
    fixture.state={...fixture.state,seq:5,received:2};
    fixture.receipts=fixture.commands.map(c=>({id:c.id,status:'confirmed',result:{state:copy(fixture.state)}}));
    await page.waitForFunction(()=>document.getElementById('received').textContent==='2');
    assert.equal(await page.getByRole('progressbar',{name:'已收'}).getAttribute('aria-valuenow'),'2');
    assert.equal(await page.locator('#progress-arc').getAttribute('stroke-dashoffset'),'0');
    await page.waitForFunction(()=>document.getElementById('camera').currentTime>4);
    assert.equal(await page.locator('#camera-status').innerText(),'');
    assert.equal(fixture.commands.length,2);
    if(counter===1){
      await page.evaluate(()=>{window.freezeTestImage=true;});
      await page.waitForFunction(()=>document.getElementById('camera-status').textContent.includes('等待相机画面'),null,{timeout:8000});
      assert.equal(await page.evaluate(()=>window.testTrack.readyState),'live');
      await page.evaluate(()=>{window.freezeTestImage=false;});
      await page.waitForFunction(()=>document.getElementById('camera-status').textContent==='');
      assert.equal(fixture.commands.length,2);
    }
    await page.getByRole('button',{name:'关闭相机'}).click();
    assert.equal(await page.evaluate(()=>window.testTrack.readyState),'ended');
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

function previewCamera(){
  window.cameraOpens=0;
  window.previewCard=0;
  navigator.mediaDevices.getUserMedia=async()=>{
    window.cameraOpens++;
    const canvas=document.createElement('canvas');
    canvas.width=320;canvas.height=180;
    const ctx=canvas.getContext('2d');
    let tick=0;
    function paint(){
      ctx.fillStyle='white';ctx.fillRect(0,0,320,180);
      ctx.fillStyle='#387dba';ctx.fillRect(++tick*5%300,156,20,24);
      if(!window.previewCard)return;
      const cells=CardQuizCards.matrix(window.previewCard);
      ctx.fillStyle='black';
      for(let y=0;y<8;y++)for(let x=0;x<8;x++)if(!cells[y][x])ctx.fillRect(80+x*16,16+y*16,16,16);
    }
    paint();
    const stream=canvas.captureStream(24),track=stream.getVideoTracks()[0];
    const timer=setInterval(()=>{if(track.readyState==='ended')clearInterval(timer);else paint();},40);
    return stream;
  };
}

async function connectPreviewBoard(page,fixture,{video,legacyPhone=false}){
  await page.addScriptTag({url:origin+'/card-quiz/cards.js'});
  if(await page.getByRole('button',{name:'开启相机'}).isVisible())
    await page.getByRole('button',{name:'开启相机'}).click();
  await page.getByRole('button',{name:'关闭相机'}).waitFor();
  const offer=await page.evaluate(async({video,legacyPhone})=>{
    window.previewMessages=[];window.jpegEncodes=0;
    const encode=HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL=function(type,...args){
      if(type==='image/jpeg')window.jpegEncodes++;
      return encode.call(this,type,...args);
    };
    const Peer=CardQuizPreview.Peer;
    window.board=new Peer('phone-preview',{
      onOpen:()=>{},onClose:()=>{},onMessage:value=>previewMessages.push(value),
      onTrack:track=>{
        window.boardVideo=document.createElement('video');
        boardVideo.muted=true;boardVideo.srcObject=new MediaStream([track]);
        void boardVideo.play();
      }
    });
    CardQuizPreview.Peer=class extends Peer{
      constructor(...args){
        super(...args);window.phonePeer=this;
        // A legacy answerer lets createAnswer() choose the default video direction.
        if(legacyPhone)this.pc.getTransceivers=undefined;
      }
    };
    return video ? board.describe('offer',undefined,true) : board.describe('offer');
  },{video,legacyPhone});
  const posted=page.waitForResponse(r=>r.url().endsWith('/pairs/pair-1/preview'));
  fixture.preview={id:'phone-preview',offer};
  const response=await posted;
  assert.equal(response.status(),200);
  const {answer}=response.request().postDataJSON();
  await page.evaluate(sdp=>board.pc.setRemoteDescription({type:'answer',sdp}),answer);
  await page.waitForFunction(()=>board.channel?.readyState==='open');
  return {offer,answer};
}

test('扫码手机短时断网后复用镜头和取景，丢失的发送回执按原请求查询',async()=>{
  const {page,context,fixture}=await open({scan:{},setupCamera:previewCamera,withoutQuerySize:true});
  try{
    await page.getByRole('button',{name:'关闭相机'}).waitFor();
    await connectPreviewBoard(page,fixture,{video:true});
    await page.evaluate(()=>{
      window.scannerTrack=document.getElementById('camera').srcObject.getVideoTracks()[0];
      board.send(JSON.stringify({view:'current-view',round:'round-1',generation:2,visible:true}));
    });
    await page.waitForFunction(()=>phonePeer.videoSender.track===scannerTrack && boardVideo.currentTime>0);
    fixture.unknown=true;
    await page.evaluate(()=>{window.previewCard=1;});
    await page.getByText('正在重连',{exact:true}).waitFor({timeout:5000});
    assert.equal(await page.locator('#received').innerText(),'0');
    assert.deepEqual(await page.evaluate(()=>[scannerTrack.readyState,Boolean(phonePeer.closed),phonePeer.videoSender.track===scannerTrack]),['live',false,true]);
    const id=fixture.commands[0].id;
    fixture.unknown=false;
    fixture.state={...fixture.state,seq:4,received:1};
    fixture.receipts=[{id,status:'confirmed',result:{state:copy(fixture.state)}}];
    const recovery=await page.waitForResponse(r=>new URL(r.url()).searchParams.getAll('commandId').includes(id));
    assert.equal(new URL(recovery.url()).searchParams.get('preview'),'phone-preview');
    await page.getByText('正在收答',{exact:true}).waitFor();
    assert.equal(await page.locator('#received').innerText(),'1');
    assert.deepEqual(await page.evaluate(()=>[cameraOpens,Boolean(phonePeer.closed),phonePeer.videoSender.track===scannerTrack]),[1,false,true]);
    const next=page.waitForResponse(r=>r.url().endsWith('/commands') && r.request().postDataJSON().payload.cardNumber===2);
    await page.evaluate(()=>{window.previewCard=2;});
    await next;
    assert.deepEqual(fixture.commands.map(command=>command.payload.cardNumber),[1,2]);
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('手机 WebRTC 连续传原镜头和匿名角点，收起停发视频仍能识卡，再展开复用轨道',async()=>{
  const {page,context,fixture}=await open({setupCamera:previewCamera});
  try{
    const {offer,answer}=await connectPreviewBoard(page,fixture,{video:true});
    assert.match(offer,/^a=recvonly\r?$/m);assert.match(answer,/^a=sendonly\r?$/m);
    assert.deepEqual(await page.evaluate(()=>board.pc.getTransceivers().map(t=>[t.receiver.track.kind,t.currentDirection])),[['video','recvonly']]);
    assert.equal(await page.evaluate(()=>phonePeer.videoSender.track),null);
    await page.evaluate(()=>{window.scannerTrack=document.getElementById('camera').srcObject.getVideoTracks()[0];window.previewCard=1;board.send('show');});
    await page.waitForFunction(()=>phonePeer.videoSender.track===scannerTrack && previewMessages.some(m=>JSON.parse(m).corners.length));
    await page.waitForFunction(async()=>{
      const stats=[...(await board.pc.getStats()).values()];
      const video=stats.find(r=>r.type==='inbound-rtp' && r.kind==='video');
      return video?.framesDecoded>=16 && video.framesDecoded>previewMessages.length*2;
    },null,{timeout:12000});
    const messages=await page.evaluate(()=>previewMessages.map(JSON.parse));
    for(const message of messages)assert.deepEqual(Object.keys(message),['corners']);
    const quad=messages.find(m=>m.corners.length).corners[0];
    assert.equal(quad.length,4);
    assert.ok(quad.every(p=>p.length===2 && p.every(n=>Number.isFinite(n) && n>=0 && n<=1)));
    const xs=quad.map(p=>p[0]),ys=quad.map(p=>p[1]);
    assert.ok(Math.abs(Math.min(...xs)-96/320)<.02 && Math.abs(Math.max(...xs)-191/320)<.02);
    assert.ok(Math.abs(Math.min(...ys)-32/180)<.02 && Math.abs(Math.max(...ys)-127/180)<.02);
    await page.evaluate(()=>{window.previewCard=0;});
    await page.waitForFunction(()=>JSON.parse(previewMessages.at(-1)).corners.length===0);

    await page.evaluate(()=>board.send('hide'));
    await page.waitForFunction(()=>document.getElementById('on-board').hidden && phonePeer.videoSender.track===null);
    const card=page.waitForRequest(r=>r.url().endsWith('/commands') && r.postDataJSON().payload.cardNumber===2);
    await page.evaluate(()=>{window.previewCard=2;});
    assert.deepEqual((await card).postDataJSON().payload,{cardNumber:2,option:'A'});
    assert.equal(await page.evaluate(()=>scannerTrack.readyState),'live');
    const previousTime=await page.evaluate(()=>boardVideo.currentTime);
    await page.evaluate(()=>{board.send('show');board.send('hide');board.send('show');});
    await page.waitForFunction(time=>phonePeer.videoSender.track===scannerTrack && boardVideo.currentTime>time &&
      !document.getElementById('on-board').hidden && JSON.parse(previewMessages.at(-1)).corners.length===1,previousTime);
    assert.deepEqual(await page.evaluate(()=>[window.cameraOpens,window.jpegEncodes]),[1,0]);
    await page.evaluate(()=>{window.duplicate=board.pc.createDataChannel('banban-preview');});
    await page.waitForFunction(()=>duplicate.readyState==='closed' && board.channel.readyState==='open');
    await page.evaluate(()=>board.send('stop'));
    await page.waitForFunction(()=>scannerTrack.readyState==='ended' && phonePeer.closed);
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

for(const legacyPhone of [false,true])test((legacyPhone?'旧手机回复 inactive':'旧白板只提供数据通道')+'时仍按宽屏指令发送 JPEG',async()=>{
  const {page,context,fixture}=await open({setupCamera:previewCamera});
  try{
    const {offer,answer}=await connectPreviewBoard(page,fixture,{video:legacyPhone,legacyPhone});
    assert.match(answer,/^m=application /m);
    if(legacyPhone){
      assert.match(offer,/^a=recvonly\r?$/m);
      assert.match(answer,/^a=inactive\r?$/m);
    }else for(const sdp of [offer,answer])assert.equal((sdp.match(/^m=/gm)||[]).length,1);
    await page.evaluate(()=>{board.send('wide');board.send('show');});
    await page.waitForFunction(()=>previewMessages.length>=2);
    const dimensions=await page.evaluate(async()=>{
      const frame=new Image();frame.src=previewMessages[0];await frame.decode();
      return [frame.width,frame.height];
    });
    assert.deepEqual(dimensions,[288,162]);
    assert.ok(await page.evaluate(()=>!phonePeer.videoSender && jpegEncodes>=2 && previewMessages.every(CardQuizPreview.validFrame)));
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('仅取景连接失败时手机继续收答并等待白板回执',async()=>{
  const {page,context,fixture}=await open();
  try {
    fixture.preview={id:'isolated',offer:'unusable connection description'};
    await page.locator('#camera-toggle').click();
    await page.getByText('白板取景重连中，仍可收卡。').waitFor();
    assert.ok(await page.evaluate(()=>testScanner.running));
    await page.evaluate(()=>{void testScanner.options.onRead({cardNumber:1,option:'A'});});
    await page.waitForFunction(()=>document.getElementById('submission-status').textContent.includes('1 条'));
    assert.equal(await page.locator('#received').innerText(),'0');
    fixture.state={...fixture.state,seq:4,received:1};
    fixture.receipts=fixture.commands.map(c=>({id:c.id,status:'confirmed',result:{state:copy(fixture.state)}}));
    await page.waitForFunction(()=>document.getElementById('received').textContent==='1');
    assert.deepEqual(fixture.errors,[]);
  } finally {await context.close();}
});

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
  const {context,page,fixture}=await open({roundStatus:'paused',withoutQuerySize:true});
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
    await page.waitForFunction(()=>document.querySelector('#received').textContent==='1');
    assert.equal(await page.locator('#multi-progress').innerText(),'整题完成 0 / 2');
    assert.equal(await page.getByRole('progressbar',{name:'本项已收'}).getAttribute('aria-valuenow'),'1');
    await page.locator('#multi-next').click();await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    assert.equal(await page.evaluate(()=>testScanner.running),false);assert.equal(fixture.commands[1].action,'set_multi_option');assert.deepEqual(fixture.commands[1].payload,{option:'B'});
    fixture.state={...fixture.state,seq:5,generation:3,activeOption:'B',optionReceived:0};fixture.receipts=[{id:fixture.commands[1].id,status:'confirmed',result:{seq:5,status:'confirmed',state:copy(fixture.state)}}];
    await page.getByRole('button',{name:'收 B 项',pressed:true}).waitFor();
    assert.equal(await page.locator('#received').innerText(),'0');
    assert.equal(await page.evaluate(()=>testScanner.running),false);
    await page.locator('#camera-toggle').click();await page.evaluate(()=>{void testScanner.options.onRead({cardNumber:1,option:'B'}).catch(()=>{});});
    await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    assert.equal(fixture.commands[2].payload.targetOption,'B');
    fixture.state={...fixture.state,seq:6,roundStatus:'closed'};fixture.receipts=[{id:fixture.commands[2].id,status:'confirmed',result:{seq:6,status:'confirmed',state:copy(fixture.state)}}];
    await page.locator('#courseware summary').click();
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
    await page.getByRole('button',{name:'收 B 项',pressed:true}).waitFor();
    assert.equal(await page.evaluate(()=>testScanner.running),false);assert.equal(fixture.commands.length,0);
    assert.equal(await page.locator('#multi-next').isDisabled(),true);assert.equal(await page.locator('#multi-option button:visible').count(),2);
    await page.locator('#camera-toggle').click();assert.equal(await page.evaluate(()=>testScanner.running),true);assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('选才举卡时区分本项与本题人数，封存后显示弃权',async()=>{
  const {page,context,fixture}=await open({questionType:'multiple',scan:{}});
  try {
    fixture.state={...fixture.state,seq:4,generation:3,noCardPolicy:'abstain',activeOption:'C',optionReceived:0,received:1};
    await page.getByText('本题已举卡 1 / 2',{exact:true}).waitFor();
    assert.equal(await page.getByRole('progressbar',{name:'本项已收'}).getAttribute('aria-valuenow'),'0');
    assert.equal(await page.locator('#guide-label').innerText(),'选才举卡');
    fixture.state={...fixture.state,seq:5,generation:4,roundStatus:'closed'};
    await page.getByText('弃权 1 人',{exact:true}).waitFor();
    assert.equal(await page.getByRole('progressbar',{name:'已收'}).getAttribute('aria-valuenow'),'1');
  } finally { await context.close(); }
});

test('大班多选圆环按当前项计数，封存切回整题，免答显示独立状态',async()=>{
  const {page,context,fixture}=await open({questionType:'multiple'});
  try{
    fixture.state={...fixture.state,seq:4,expected:60,optionReceived:53,received:7};
    const itemRing=page.getByRole('progressbar',{name:'本项已收'});
    await page.locator('#progress-ring[aria-valuenow="53"]').waitFor();
    assert.equal(await itemRing.getAttribute('aria-valuemax'),'60');
    assert.equal(await page.locator('#multi-progress').innerText(),'整题完成 7 / 60');
    await page.getByRole('button',{name:'收 D 项'}).press('Enter');
    await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    const switchCommand=fixture.commands[0];
    assert.deepEqual(switchCommand.payload,{option:'D'});
    assert.equal(await page.getByRole('button',{name:'收 A 项'}).getAttribute('aria-pressed'),'true');
    fixture.state={...fixture.state,seq:5,generation:3,activeOption:'D',optionReceived:10};
    fixture.receipts=[{id:switchCommand.id,status:'confirmed',result:{state:copy(fixture.state)}}];
    await page.getByRole('button',{name:'收 D 项',pressed:true}).waitFor();
    await page.getByRole('button',{name:'结束收答'}).click();
    await page.waitForFunction(()=>document.querySelector('#submission-status').textContent.includes('1 条'));
    fixture.state={...fixture.state,seq:6,roundStatus:'closed'};
    fixture.receipts=[{id:fixture.commands[1].id,status:'confirmed',result:{state:copy(fixture.state)}}];
    const finalRing=page.getByRole('progressbar',{name:'整题完成'});
    await finalRing.waitFor();
    assert.equal(await finalRing.getAttribute('aria-valuenow'),'7');
    assert.equal(await page.locator('#multi-option').isVisible(),false);
    fixture.state={...fixture.state,seq:7,expected:0,received:0,optionReceived:0};
    await page.getByText('全员免答',{exact:true}).waitFor();
    assert.equal(await finalRing.isVisible(),false);
    assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('手机按卡计人，首题没有收齐提示，第二题区分本轮和本节',async()=>{
  const {page,context,fixture}=await open({scan:{}});
  try {
    fixture.state={...fixture.state,seq:4,noCardPolicy:'abstain',expected:0,received:0,participantCount:0};
    await page.getByText('等待举卡',{exact:true}).waitFor();
    fixture.state={...fixture.state,seq:5,received:35,expected:35,participantCount:35};
    const ring=page.getByRole('status',{name:'已收 35 人'});
    await ring.waitFor();
    assert.equal(await ring.getAttribute('aria-valuemax'),null);
    assert.equal(await page.locator('#progress-arc').evaluate(el=>el.hasAttribute('hidden')),true);
    assert.equal(await page.locator('#ring-label').innerText(),'已收');
    fixture.state={...fixture.state,seq:6,questionNumber:2,questionId:'q2',roundId:'r2',participantCount:38,expected:38};
    await page.getByText('本节已参与 38 人 · 待收 3 人',{exact:true}).waitFor();
    fixture.state={...fixture.state,seq:7,roundStatus:'closed'};
    await page.getByText('本节已参与 38 人 · 弃权 3 人',{exact:true}).waitFor();
    assert.deepEqual(fixture.errors,[]);
  } finally {await context.close();}
});

test('手机多选标准答案可勾选组合，未确认保存保留选择和原版本',async()=>{
  const{page,context,fixture}=await open({questionType:'multiple',roundStatus:'closed'});
  try{
    await page.locator('#question-settings summary').press('Enter');
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
    await page.getByText('已封存',{exact:true}).waitFor();
    assert.equal(await page.locator('#submission-status').innerText(),'');
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
    await page.waitForFunction(()=>!document.querySelector('#submission-status').textContent);
    assert.equal(await page.evaluate(()=>testScanner.running),false);assert.equal(await page.locator('#received').innerText(),'0');assert.deepEqual(fixture.errors,[]);
  }finally{await context.close();}
});

test('手机编辑保留开始输入时的版本，并发变更后须清空重填',async()=>{
  const{page,context,fixture}=await open({roundStatus:'closed'});
  try{
    await page.locator('#question-settings summary').click();
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
    await page.locator('#question-settings summary').click();
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

'use strict';
// Real localhost service, fictional accounts, shared classroom Journal and isolated browsers.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {chromium}=require('playwright');
const Model=require('../web_controller/card-quiz/model.js');
const Journal=require('../web_controller/card-quiz/journal.js');
const root=path.resolve(__dirname,'..');
let browser,server,origin,teacher,student,other,fixture,credentials,output;
const errors=[];
const versions=s=>Object.fromEntries(['revision','rosterRevision','cardRevision'].map(k=>[k,s[k]]));

async function api(context,url,method='GET',data,expected=200){
  const response=await context.request.fetch(origin+url,{method,data,
    headers:method==='GET'?{}:{'X-CSRF-Token':context.csrf||''}});
  assert.equal(response.status(),expected,`${method} ${url}: unexpected HTTP status`);
  return response.json();
}
async function login(context,credential){
  const result=await api(context,'/api/student/login','POST',{
    username:credential.username,password:credential.password});
  context.csrf=result.student.csrfToken;
  return result.student;
}
async function makeJournal(){
  const started=Date.now()-60_000;
  const session=Model.createSession({classId:fixture.cid,deviceId:fixture.device.deviceId,
    rosterRevision:1,cardRevision:1,students:fixture.students.map((s,i)=>({...s,cardNumber:i+1}))},'math',started);
  const controller=new Journal.Controller(Journal.create(session),async journal=>journal);
  const realNow=Date.now;let at=started;
  async function dispatch(action,payload={}){
    const current=controller.session;at+=1000;Date.now=()=>at;
    await controller.dispatch({id:randomUUID(),sessionId:current.id,questionId:current.currentQuestionId,
      roundId:current.currentRoundId,generation:current.generation,sourceId:current.sourceId,action,payload});
  }
  const question=(type,text,answer,options=['选项一','选项二'])=>({type,text,answer,options,
    subjectId:'math',imageId:null,tags:['课堂练习']});
  try{
    await dispatch('add_question',question('single','1 + 1 = ?','B'));
    await dispatch('start_round');
    await dispatch('answer',{cardNumber:1,option:'B'});
    await dispatch('answer',{cardNumber:2,option:'A'});
    await dispatch('end_round');
    await dispatch('add_question',question('boolean','2 是偶数','A',['正确','错误']));
    await dispatch('start_round');
    await dispatch('answer',{cardNumber:1,option:'A'});
    await dispatch('answer',{cardNumber:2,option:'B'});
    await dispatch('answer',{cardNumber:3,option:'A'});
    await dispatch('end_round');
    await dispatch('add_question',question('multiple','选择偶数','AC',['2','3','4']));
    await dispatch('start_round');
    await dispatch('answer',{cardNumber:1,option:'A',targetOption:'A'});
    await dispatch('answer',{cardNumber:2,option:'B',targetOption:'A'});
    await dispatch('answer',{cardNumber:3,option:'A',targetOption:'A'});
    for(const targetOption of ['B','C']){
      await dispatch('set_multi_option',{option:targetOption});
      await dispatch('answer',{cardNumber:1,option:targetOption==='C'?'A':'B',targetOption});
      await dispatch('answer',{cardNumber:2,option:'B',targetOption});
    }
    await dispatch('end_round');await dispatch('end_session');
  }finally{Date.now=realNow;}
  const response=await teacher.request.post(origin+'/api/card-quiz/device/sync',{
    headers:{Authorization:'Bearer '+fixture.device.deviceToken,
      'X-ICeClass-Device-Id':fixture.device.deviceId,'X-ICeClass-Class-Id':fixture.cid},
    data:{session:controller.session,events:controller.journal.events,fromSeq:1,receipts:[]}});
  assert.equal(response.status(),200,'Actual Journal must sync through production device handler');
  fixture.sessionId=controller.session.id;
}

before(async()=>{
  output=path.join(root,'output','playwright','student-accounts-'+new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(output,{recursive:true});
  const port=await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);
    probe.listen(0,'127.0.0.1',()=>{const p=probe.address().port;probe.close(()=>resolve(p));});});
  // Playwright's request cookie store recognizes localhost for Secure loopback cookies.
  origin='http://localhost:'+port;
  server=spawn(process.env.ICECLASS_TEST_PYTHON||'python',['-X','utf8',path.join(root,'server','preview.py'),
    '--port',String(port),'--database',path.join(output,'fictional-test.db')],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe']});
  let serverErrors='';server.stderr.on('data',chunk=>serverErrors+=chunk);
  server.on('error',error=>errors.push(error.message));
  let ready=false;
  for(let i=0;i<100;i++){
    if(server.exitCode!==null)throw new Error('Test server exited: '+serverErrors);
    try{const probe=await fetch(origin+'/api/student/session');if(probe.ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready,'Fictional localhost test service must start');
  browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
  teacher=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
  const auth=await api(teacher,'/api/auth/login','POST',{username:'ICe',password:'LocalDemo2026'});
  teacher.csrf=auth.user.csrfToken;
  const room=await api(teacher,'/api/classes','POST',{name:'高一（91）班'},201);
  const enrollment=await api(teacher,`/api/classes/${room.id}/enrollment-code`,'POST',{});
  const device=await api(teacher,'/api/device/enroll','POST',{code:enrollment.code,deviceName:'学生分析联调模拟白板'});
  const students=Array.from({length:4},(_,i)=>({id:'student-demo-'+(i+1),name:'虚构同学'+(i+1)}));
  const profile=await api(teacher,`/api/homework/classes/${room.id}/profile`);
  await api(teacher,`/api/homework/classes/${room.id}/profile`,'PUT',{
    revision:profile.revision,value:{...profile.value,students}});
  await api(teacher,`/api/card-quiz/classes/${room.id}/cards`,'PUT',{revision:0,initialize:true});
  fixture={cid:room.id,device,students};
  const state=await api(teacher,`/api/card-quiz/classes/${room.id}/students`);
  const created=await api(teacher,`/api/card-quiz/classes/${room.id}/students`,'POST',{
    ...versions(state),entryYear:2026,classCode:'191'});
  credentials=created.credentials;
  assert.equal(credentials.length,4);
  await makeJournal();
  student=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
  other=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await login(student,credentials[0]);await login(other,credentials[2]);
  for(const context of [teacher,student,other])context.on('page',page=>{
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error'&&/Content Security Policy|Refused to/.test(message.text()))errors.push(message.text());});
  });
}, {timeout:30000});

after(async()=>{
  await browser?.close();
  if(server&&server.exitCode===null)server.kill();
});

test('real three-type classroom produces separate per-student reports and matching teacher totals',async()=>{
  const first=await api(student,'/api/student/report');
  const third=await api(other,'/api/student/report?studentId='+fixture.students[0].id);
  assert.equal(first.totals.correct,3);assert.equal(first.totals.samples,3);assert.equal(first.totals.accuracy,1);
  assert.deepEqual(first.records.map(r=>r.type),['single','boolean','multiple']);
  assert.equal(first.records[2].option,'AC');
  assert.equal(third.totals.correct,1);assert.equal(third.totals.samples,2);
  assert.equal(third.totals.abstained,1);assert.equal(third.totals.incomplete,0);assert.equal(third.totals.unanswered,0);
  assert.deepEqual(third.records.map(record=>record.status),['abstained','correct','wrong']);
  assert.equal(third.records[2].option,'A');
  assert.equal(first.knowledge[0].samples,3);assert.equal(third.knowledge[0].samples,2);
  assert.deepEqual(third.sessions[0].knowledge[0].wrongQuestionNumbers,[3]);
  assert.ok(!JSON.stringify(first).includes('虚构同学2'));
  await api(student,'/api/classes','GET',undefined,401);
  const teacherReport=await api(teacher,'/api/card-quiz/report?classId='+fixture.cid);
  assert.equal(teacherReport.students.find(s=>s.studentId===fixture.students[0].id).samples,first.totals.samples);
  assert.deepEqual(errors,[]);
});

test('password reentry prints own credentials and teacher reset revokes only selected account',async()=>{
  const self=await api(student,'/api/student/card','POST',{password:credentials[0].password});
  assert.equal(self.card.username,credentials[0].username);assert.equal(self.card.cardNumber,1);
  assert.ok(!('name' in self.card));
  const state=await api(teacher,`/api/card-quiz/classes/${fixture.cid}/students`);
  const reset=await api(teacher,`/api/card-quiz/classes/${fixture.cid}/students/reset`,'POST',{
    ...versions(state),studentIds:[fixture.students[0].id]});
  await api(student,'/api/student/report','GET',undefined,401);
  await api(other,'/api/student/report');
  credentials[0]=reset.credentials[0];await login(student,credentials[0]);
  assert.deepEqual(errors,[]);
});

async function paperPDF(page,name,count){
  await page.emulateMedia({media:'print'});
  const size=await page.locator('.card-sheet svg').first().evaluate(svg=>
    svg.querySelector('g').getBBox().width/svg.viewBox.baseVal.width*svg.getBoundingClientRect().width*25.4/96);
  assert.ok(Math.abs(size-170)<0.2,'Printed recognition square must measure 170 mm');
  const pdf=await page.pdf({path:path.join(output,name),preferCSSPageSize:true,printBackground:true});
  assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length,count,'Exactly one A4 page per card');
  await page.emulateMedia({media:'screen'});
}
async function noOverflow(page){
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),
    'Document must fit narrow viewport; tables can scroll inside their own region');
}

test('real student page supports keyboard login, personal statuses, self print and changing password',{timeout:45000},async()=>{
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  try{
    const teacherAuth=await api(context,'/api/auth/login','POST',{username:'ICe',password:'LocalDemo2026'});
    await page.goto(origin+'/student');
    await page.locator('#loginForm:not(.hidden)').waitFor();
    assert.ok(await page.locator('#loginRoleStudent').isChecked());
    await page.locator('#loginUsername').fill(credentials[2].username);
    await page.locator('#loginPassword').fill(credentials[2].password);
    await page.locator('#loginPassword').press('Enter');
    await page.locator('#student-workspace:not([hidden])').waitFor();
    await page.getByRole('button',{name:'所有作答记录'}).click();
    await page.locator('.student-record').first().waitFor();
    assert.equal(await page.locator('.student-record').count(),3);
    assert.equal(await page.locator('[data-status="abstained"]').count(),1);
    assert.match(await page.locator('#student-totals').innerText(),/50\.0%/);
    await page.locator('[data-student-view="knowledge"]').focus();
    await page.keyboard.press('Enter');await page.locator('.student-table').waitFor();
    assert.match(await page.locator('.student-table').innerText(),/课堂练习/);
    await page.locator('[data-student-view="wrong"]').click();
    assert.equal(await page.locator('.student-record').count(),1);
    assert.match(await page.locator('.student-record-title').innerText(),/第 3 题/);
    await page.locator('[data-student-view="records"]').click();
    await page.screenshot({path:path.join(output,'学生个人分析-桌面.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await noOverflow(page);
    await page.screenshot({path:path.join(output,'学生个人分析-窄屏.png'),fullPage:true});
    const bad=credentials[2].password==='999999'?'999998':'999999';
    await page.locator('#card-password').fill(bad);
    const rejected=page.waitForResponse(r=>r.url().endsWith('/api/student/card'));
    await page.locator('#student-card-form button[type=submit]').click();assert.equal((await rejected).status(),401);
    await page.locator('#card-password[aria-invalid="true"]').waitFor();
    assert.ok(await page.locator('#student-workspace').isVisible());
    await page.locator('#card-password').fill(credentials[2].password);
    await page.locator('#student-card-form button[type=submit]').click();await page.locator('.card-sheet').waitFor();
    assert.equal(await page.locator('.card-login .card-password').innerText(),credentials[2].password);
    assert.match(await page.locator('.card-instructions').innerText(),/单选.*判断/);
    assert.match(await page.locator('.card-instructions').innerText(),/多选/);
    assert.ok(!/姓名|虚构同学/.test(await page.locator('.card-sheet').innerText()));
    assert.ok(await page.evaluate(password=>![...Object.values(localStorage),...Object.values(sessionStorage)].some(v=>v.includes(password)),credentials[2].password));
    await noOverflow(page);await paperPDF(page,'学生本人纸卡.pdf',1);
    await page.locator('#student-card-clear').click();assert.equal(await page.locator('.card-sheet').count(),0);
    await page.locator('#current-password').fill(credentials[2].password);
    await page.locator('#new-password').fill('000042');await page.locator('#confirm-password').fill('000042');
    await page.locator('#student-password-form button[type=submit]').click();
    await page.locator('#loginForm:not(.hidden)').waitFor();
    await page.locator('#loginUsername').fill(credentials[2].username);
    await page.locator('#loginPassword').fill('000042');await page.locator('#loginPassword').press('Enter');
    await page.locator('#student-workspace:not([hidden])').waitFor();
    assert.match(await page.locator('#student-identity').innerText(),new RegExp(credentials[2].username));
    await page.locator('#student-logout').click();await page.locator('#loginForm:not(.hidden)').waitFor();
    assert.match(await page.locator('#loginNotice').innerText(),/已退出学生账号/);
    assert.equal((await api(context,'/api/session')).user.id,teacherAuth.user.id);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('real teacher page generates distribution sheet and requires explicit reset before A4 printing',{timeout:45000},async()=>{
  const room=await api(teacher,'/api/classes','POST',{name:'高二（92）班'},201);
  const profile=await api(teacher,`/api/homework/classes/${room.id}/profile`);
  const students=fixture.students.map((s,i)=>({id:'ui-student-'+i,name:'界面虚构同学'+i}));
  await api(teacher,`/api/homework/classes/${room.id}/profile`,'PUT',{
    revision:profile.revision,value:{...profile.value,students}});
  await api(teacher,`/api/card-quiz/classes/${room.id}/cards`,'PUT',{revision:0,initialize:true});
  const page=await teacher.newPage();
  try{
    await page.goto(origin+'/');await page.locator('#mainNav [data-view="card-quiz"]').click();
    await page.locator('#cq-class').selectOption(room.id);
    await page.locator('#cq-generate-form').waitFor();
    await page.locator('[name="entryYear"]').fill('2026');await page.locator('[name="classCode"]').fill('292');
    const generated=page.waitForResponse(r=>r.url().endsWith(`/classes/${room.id}/students`)&&r.request().method()==='POST');
    await page.locator('[data-cq-action="generate-accounts"]').click();
    const response=await generated;assert.equal(response.status(),200);
    const created=await response.json();assert.equal(created.credentials.length,4);
    await page.locator('.cq-credentials').waitFor();
    const download=page.waitForEvent('download');await page.locator('[data-cq-action="download-credentials"]').click();
    const file=await download;await file.saveAs(path.join(output,'虚构账号发放表.csv'));
    assert.match(fs.readFileSync(path.join(output,'虚构账号发放表.csv'),'utf8'),/六位密码|密码/);
    await page.setViewportSize({width:390,height:844});await noOverflow(page);
    await page.screenshot({path:path.join(output,'教师账号管理-窄屏.png'),fullPage:true});
    const print=await teacher.newPage();
    try{
      await print.goto(origin+`/card-quiz/print.html?classId=${encodeURIComponent(room.id)}`);
      await print.locator('#prepare:not([disabled])').waitFor();
      assert.equal(await print.locator('.card-sheet').count(),0);
      assert.equal(await print.locator('#print').isDisabled(),true);
      assert.equal((await api(teacher,`/api/card-quiz/classes/${room.id}/students`)).revision,created.revision);
      await print.locator('#prepare').click();await print.locator('#reset-confirm[open]').waitFor();
      await print.keyboard.press('Escape');assert.equal(await print.locator('#reset-confirm[open]').count(),0);
      assert.equal((await api(teacher,`/api/card-quiz/classes/${room.id}/students`)).revision,created.revision);
      await print.locator('#prepare').click();
      const reset=print.waitForResponse(r=>r.url().endsWith('/students/reset'));
      await print.locator('#confirm-reset').click();assert.equal((await reset).status(),200);
      await print.locator('#print:not([disabled])').waitFor();assert.equal(await print.locator('.card-sheet').count(),4);
      assert.ok(!/姓名|界面虚构同学/.test(await print.locator('#cards').innerText()));
      assert.equal(await print.locator('.card-instructions').count(),4);
      await paperPDF(print,'教师代印全班纸卡.pdf',4);
      await print.locator('.card-sheet').first().screenshot({path:path.join(output,'纸卡版式.png')});
      await print.setViewportSize({width:390,height:844});await noOverflow(print);
      await print.locator('#clear').click();assert.equal(await print.locator('.card-sheet').count(),0);
    }finally{await print.close();}
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

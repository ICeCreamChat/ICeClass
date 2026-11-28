'use strict';
// Fictional accounts over isolated HTTP, using the production pages and CSP.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {fixture:teacherFixture,navigate,launchWorkbenchBrowser}=require('./test-teacher-ui.cjs');
const root=path.resolve(__dirname,'../web_controller');
const clone=value=>JSON.parse(JSON.stringify(value));
const password='001234';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
let browser;
before(async()=>{browser=await launchWorkbenchBrowser();});
after(async()=>{await browser?.close();});
function makeFixture(){
  const state={authenticated:false,password,requests:[],writes:[],canEdit:true,versionError:false,linkDenied:false,accountsUnavailable:false};
  state.accounts={classId:'c1',className:'高一（9）班',revision:3,rosterRevision:7,cardRevision:2,classCode:'109',canEdit:true,
    students:[{studentId:'s1',name:'=HYPERLINK("https://example.invalid")',cardNumber:1,accountId:null,username:null,accountRevision:null,activeHere:false},
      {studentId:'s2',name:'学生乙',cardNumber:157,accountId:null,username:null,accountRevision:null,activeHere:false},
      {studentId:'s3',name:'转班学生',cardNumber:3,accountId:null,username:null,accountRevision:null,activeHere:false}]};
  state.cards={classId:'c1',revision:2,canEdit:true,students:state.accounts.students.map(s=>({id:s.studentId,name:s.name,cardNumber:s.cardNumber}))};
  state.student={id:'account-s1',username:'2610901',classId:'c1',className:state.accounts.className,cardNumber:1,csrfToken:'student-csrf'};
  const totals={samples:2,correct:1,wrong:1,incomplete:1,unanswered:1,exempt:1,ungraded:1,practice:1,accuracy:.5};
  const base={sessionId:'lesson',classId:'c1',className:state.accounts.className,subjectId:'math',questionId:'q1',text:'已确认的单选题',type:'single',options:['一','二','三','四'],imageId:null,answer:'A',tags:['集合'],roundId:'r1',purpose:'formal',status:'correct',option:'A',startedAt:1794800000000,endedAt:1794800001000,isOfficial:true,counted:true};
  state.report={totals,knowledge:[{subjectId:'math',tag:'集合',questionCount:3,answers:7,...totals}],
    sessions:[{id:'lesson',classId:'c1',className:state.accounts.className,subjectId:'math',startedAt:1794799900000,endedAt:1794800100000}],
    records:[base,{...base,questionId:'q2',roundId:'r2',text:'判断题',type:'boolean',options:['正确','错误'],status:'wrong',option:'B'},
      {...base,questionId:'q3',roundId:'r3',text:'多选题',type:'multiple',status:'incomplete',answer:'AC',option:'A',choices:{A:true,B:false},imageId:'image1'},
      {...base,questionId:'q4',roundId:'r4',text:'',status:'unanswered',option:null,tags:[]},
      {...base,questionId:'q5',roundId:'r5',text:'免答题',status:'exempt',option:null},
      {...base,questionId:'q6',roundId:'r6',text:'未设答案',status:'ungraded',answer:null},
      {...base,questionId:'q7',roundId:'r7',text:'练习多选题',type:'multiple',status:'practice',purpose:'practice',option:'',choices:{A:false,B:false,C:false,D:false},counted:false,isOfficial:false},
      {...base,questionId:'q2',roundId:'old-round',text:'较早正式轮次',type:'boolean',status:'wrong',option:'B',counted:false,isOfficial:false}]};
  state.credential=s=>({accountId:s.accountId||'account-'+s.studentId,username:s.username||'26109'+String(s.cardNumber).padStart(2,'0'),password,
    classId:'c1',className:state.accounts.className,studentId:s.studentId,cardNumber:s.cardNumber});
  state.issue=ids=>{
    const selected=state.accounts.students.filter(s=>ids.includes(s.studentId));
    for(const s of selected)Object.assign(s,{accountId:'account-'+s.studentId,username:'26109'+String(s.cardNumber).padStart(2,'0'),accountRevision:(s.accountRevision||0)+1,activeHere:true});
    state.accounts.revision++;
    return selected.map(state.credential);
  };
  return state;
}
async function setup(t,{width=1280,student=false,authenticated=false,canEdit=true,linked=false,prepare,beforeOpen}={}){
  const state=makeFixture();state.authenticated=authenticated;state.canEdit=state.accounts.canEdit=state.cards.canEdit=canEdit;
  if(linked)state.issue(['s1','s2']);
  prepare?.(state);
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    const reply=(status,data,type='application/json')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(type==='application/json'?JSON.stringify(data):data);};
    try{
      if(url.pathname.startsWith('/api/')){
        let raw='';for await(const chunk of req)raw+=chunk;
        const body=raw?JSON.parse(raw):null;
        const call={path:url.pathname,query:url.search,method:req.method,body,csrf:req.headers['x-csrf-token']};
        state.requests.push(call);if(req.method!=='GET')state.writes.push(call);
        if(url.pathname.startsWith('/api/student')){
          const p=url.pathname.slice('/api/student'.length);
          if(p==='/session'){
            const result=clone({authenticated:state.authenticated,...(state.authenticated?{student:state.student}:{})});
            await state.readSession?.();
            return reply(200,result);
          }
          if(p==='/login'){
            if(body.username!==state.student.username||body.password!==state.password)return reply(401,{error:'学生编号或密码错误。',code:'invalid_credentials'});
            state.authenticated=true;return reply(200,{student:state.student});
          }
          if(!state.authenticated)return reply(401,{error:'请使用学生账号登录。',code:'authentication_required'});
          if(req.method!=='GET'&&call.csrf!==state.student.csrfToken)return reply(403,{error:'页面凭证已失效，请刷新后重试。'});
          if(p==='/report'){
            if(state.reportError)return reply(503,{error:'个人报告暂时不可用，请重试。'});
            const result=clone({accountId:state.student.id,...(url.searchParams.get('subjectId')==='english'?{totals:{samples:0,correct:0,wrong:0,accuracy:null},knowledge:[],sessions:[],records:[]}:state.report)});
            await state.readReport?.();
            return reply(200,result);
          }
          if(p.startsWith('/report/') && p.endsWith('/analysis') && req.method==='POST'){
            const sessionId=decodeURIComponent(p.slice('/report/'.length,-'/analysis'.length));
            const envelope={accountId:state.student.id,sessionId};
            const response=await state.analyze?.(sessionId,call);
            return reply(response?.httpStatus || 200,{...envelope,...(response?.data || {status:'ready',
              analysis:{strengths:'本节答对的内容。',review:'复习本节错题。',nextStep:'完成对应练习。'},explanations:{}})});
          }
          if(p.startsWith('/images/'))return reply(200,png,'image/png');
          if(p==='/card'){
            state.cardStarted?.();
            if(state.holdCard)await state.holdCard;
            if(body.password!==state.password)return reply(401,{error:'当前密码错误，请重新输入。',code:'invalid_credentials'});
            return reply(200,{card:{...state.credential(state.accounts.students[0]),password:state.password}});
          }
          if(p==='/password'){
            if(body.currentPassword!==state.password)return reply(401,{error:'当前密码错误，请重新输入。',code:'invalid_credentials'});
            state.password=body.newPassword;state.authenticated=false;return reply(200,{ok:true,reauthenticate:true});
          }
          if(p==='/logout'){state.authenticated=false;return reply(200,{ok:true});}
          return reply(404,{error:'未知学生接口。'});
        }
        if(url.pathname.startsWith('/api/card-quiz')){
          const p=url.pathname.slice('/api/card-quiz'.length);
          if(p==='/questions')return reply(200,{questions:[{id:'q1',revision:1,subjectId:'math',text:'已有题目',imageId:null,type:'single',options:['一','二'],answer:'A',tags:[]}]});
          if(p==='/decks')return reply(200,{decks:[]});
          if(p.endsWith('/publications'))return reply(200,{publications:[]});
          if(p==='/classes/c1/cards'){
            if(body){state.cards.revision++;state.cards.students.forEach((s,i)=>s.cardNumber=body.initialize?i+1:body.bindings.find(b=>b.studentId===s.id).cardNumber);state.accounts.cardRevision=state.cards.revision;for(const s of state.accounts.students)s.cardNumber=state.cards.students.find(c=>c.id===s.studentId).cardNumber;}
            return reply(200,state.cards);
          }
          if(p.startsWith('/classes/c1/students')){
            if(state.accountsUnavailable)return reply(503,{error:'账号信息暂时不可用。'});
            if(req.method==='GET')return reply(200,state.accounts);
            if(call.csrf!=='fixture')return reply(403,{error:'页面凭证已失效。'});
            if(!state.canEdit)return reply(403,{error:'没有本班名单管理权限。'});
            if(state.versionError||['revision','rosterRevision','cardRevision'].some(k=>body[k]!==state.accounts[k]))return reply(409,{error:'名单、卡号或账号版本冲突。'});
            if(p.endsWith('/number-cards')){
              state.accounts.numberCards ??= [];
              const credentials=[];
              for(let n=body.firstNumber;n<=body.lastNumber;n++){
                if(state.accounts.numberCards.some(c=>c.cardNumber===n))continue;
                const row={accountId:'card-'+n,cardNumber:n};
                state.accounts.numberCards.push(row);
                credentials.push({...row,numberCard:true,username:'261109'+String(n).padStart(2,'0'),password,classId:'c1',className:state.accounts.className});
              }
              if(credentials.length)state.accounts.revision++;
              return reply(200,{...state.accounts,credentials});
            }
            if(p.endsWith('/link')){
              if(state.linkDenied)return reply(403,{error:'没有原班管理权限，无法关联。'});
              const s=state.accounts.students.find(s=>s.studentId===body.studentId);
              Object.assign(s,{accountId:'transferred-account',username:body.username,accountRevision:2,activeHere:true});state.accounts.revision++;
              return reply(200,state.accounts);
            }
            const ids=p.endsWith('/reset')?body.studentIds:state.accounts.students.filter(s=>s.cardNumber!=null&&!s.accountId).map(s=>s.studentId);
            if(state.holdWrite){state.writeStarted?.();await state.holdWrite;}
            return reply(200,{...state.accounts,credentials:state.issue(ids),revision:state.accounts.revision});
          }
          return reply(404,{error:'未知纸卡接口。'});
        }
        const generic=teacherFixture(url);
        return generic===undefined?reply(503,{error:'隔离测试未提供此接口。'}):reply(200,generic);
      }
      if(url.pathname==='/student'){res.writeHead(302,{Location:'/card-quiz/student.html'+url.search});return res.end();}
      const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
      const file=path.resolve(root,relative);
      if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return reply(404,'Not found','text/plain');
      const ext=path.extname(file),type={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon'}[ext]||'application/octet-stream';
      const own=relative.startsWith('card-quiz/'),source=own?"'self' 'nonce-fixture'":"'nonce-fixture'";
      const headers={'Content-Type':type,'Cache-Control':'no-store'};
      if(ext==='.html')headers['Content-Security-Policy']=`default-src 'self'; script-src ${source}; style-src ${source}; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'`;
      res.writeHead(200,headers);res.end(ext==='.html'?fs.readFileSync(file,'utf8').replaceAll('__CSP_NONCE__','fixture'):fs.readFileSync(file));
    }catch{if(!res.headersSent)reply(500,{error:'隔离测试请求失败。'});else res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(/Content Security Policy|violates.*directive|Refused to/.test(message.text()))errors.push(message.text());});
  t.after(async()=>{await context.close();await new Promise(resolve=>server.close(resolve));assert.deepEqual(errors,[],'No script or CSP errors');});
  await beforeOpen?.(page);
  await page.goto(origin+(student?'/student':'/'));
  if(!student){await page.locator('#appShell:not(.hidden)').waitFor();await navigate(page,'card-quiz');if(canEdit)await page.locator('[data-cq-action=initialize]:not([disabled])').waitFor();else await page.locator('text=当前为只读权限').first().waitFor();}
  else await page.locator(authenticated?'#student-workspace:not([hidden])':'#loginForm:not(.hidden)').waitFor();
  return{state,page,context,origin,errors};
}
async function noOverflow(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No page-wide horizontal overflow');}
function logarithmLesson(state, {numberCard = false, id = 'lesson', revision = 7} = {}) {
  state.student.numberCard = numberCard;
  const session = {...state.report.sessions[0], id, revision, title: '对数的概念'};
  const base = {...state.report.records[0], sessionId: id};
  const records = Array.from({length: 5}, (_, i) => ({...base, questionId: 'q' + (i + 1), roundId: 'r' + (i + 1), questionNumber: i + 1}));
  const tag = '底数与真数的条件';
  Object.assign(records[1], {
    type: 'boolean', text: '由 (−2)³ = −8，可得 log₍₋₂₎(−8) = 3。', options: ['正确', '错误'],
    status: 'wrong', option: 'A', answer: 'B', tags: [tag], counted: false,
    explanation: '-2 是负数，不能作对数的底数。',
    exercises: [
      {id: 'domain', tag, text: '在实数范围内，哪个对数有意义？',
        options: ['log₁ 5', 'log₂(−4)', 'log₍₁⁄₂₎ 4', 'log₀ 3'], answer: 'C', explanation: '底数 1/2 大于 0 且不等于 1，真数 4 大于 0。'},
      {id: 'range', tag, text: '要使 log_3(x − 2) 有意义，x 应满足什么条件？',
        options: ['x ≥ 2', 'x < 2', 'x ≠ 2', 'x > 2'], answer: 'D', explanation: '真数须大于 0。'}
    ]
  });
  state.report.sessions = [session];
  state.report.records = [...records, {...records[1], roundId:'older', isOfficial:false, exercises:[]},
    {...records[0], purpose:'practice', status:'practice', isOfficial:false, counted:false}];
  return session;
}
const callsForAnalysis = state => state.requests.filter(r => r.path.endsWith('/analysis'));
test('扫码登录遇到资源中断仍可使用学生身份，教师管理和纸卡打印均按需载入', async t => {
  const requested = [];
  const {page,state} = await setup(t, {student:true, async beforeOpen(page) {
    page.setDefaultTimeout(5000);
    await page.route('**/assets/page-assets.js*', route => route.abort());
    page.on('request', r => requested.push(new URL(r.url()).pathname));
  }});
  await page.waitForLoadState('load');
  assert.equal(new URL(page.url()).search, '?login=student');
  assert.equal(await page.locator('#loginRoleStudent').isChecked(), true);
  assert.deepEqual(requested.filter(p => /\/(?:card-quiz-admin|homework-admin|banban|users)\.(?:css|js)$|\/(?:vendor\/|print(?:-card)?\.)/.test(p)), []);
  await page.locator('#loginRoleStudent').press('ArrowLeft');
  assert.equal(await page.locator('#loginUsernameLabel').textContent(), '用户名');
  await page.locator('#loginRoleTeacher').press('ArrowRight');
  assert.equal(await page.locator('#loginUsernameLabel').textContent(), '学生编号');
  await page.locator('#loginUsername').fill(state.student.username);
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginPassword').press('Enter');
  await page.locator('#student-workspace:not([hidden])').waitFor();
  assert.deepEqual(state.writes.map(call => call.path).filter(path => path.endsWith('/login')), ['/api/student/login']);
  assert.equal(requested.includes('/api/session'), false);
});
test('补印依赖中断后可重试，只有核验成功的本人纸卡能打印', async t => {
  const {page} = await setup(t, {student:true, authenticated:true});
  assert.equal(await page.evaluate(() => Boolean(window.CardQuizPrintCard)), false);
  await page.route('**/vendor/aruco.js', route => route.abort(), {times:1});
  const submit = page.locator('#student-card-form button');
  await page.locator('#card-password').fill(password);
  await submit.press('Enter');
  await page.locator('#student-card-error').filter({hasText:'重试'}).waitFor();
  assert.equal(await page.locator('#cards .card-sheet').count(), 0);
  assert.equal(await page.locator('#student-print').isDisabled(), true);
  await page.locator('#card-password').fill(password);
  await submit.press('Enter');
  await page.locator('#cards .card-sheet').waitFor();
  assert.equal(await page.locator('#student-print').isEnabled(), true);
  assert.equal(await page.locator('#cards .card-credentials').innerText().then(t => t.includes('2610901')), true);
});
test('补印加载器下载失败后重新核验密码，原页重试只生成本人的纸卡', async t => {
  let attempts = 0;
  const {page,state} = await setup(t, {student:true, authenticated:true, async beforeOpen(page) {
    await page.route('**/assets/page-assets.js*', route => ++attempts === 1 ? route.abort() : route.continue());
  }});
  const field = page.locator('#card-password'), error = page.locator('#student-card-error');
  const card = page.locator('#cards .card-sheet'), print = page.locator('#student-print');
  assert.equal(attempts, 0);
  await field.fill(password);
  await field.press('Enter');
  await error.filter({hasText:/./}).waitFor();
  assert.equal(await field.inputValue(), '');
  assert.equal(await card.count(), 0);
  assert.equal(await print.isDisabled(), true);
  const resourceError = await error.innerText();
  await field.fill('999999');
  await field.press('Enter');
  await error.filter({hasText:'当前密码错误'}).waitFor();
  assert.equal(await field.getAttribute('aria-invalid'), 'true');
  assert.equal(attempts, 1);
  assert.equal(await print.isDisabled(), true);
  await field.fill(password);
  await field.press('Enter');
  await card.waitFor({timeout:5000});
  assert.match(resourceError, /载入.*重试/);
  assert.equal(await error.innerText(), '');
  assert.equal(await field.inputValue(), '');
  assert.equal(await field.getAttribute('aria-invalid'), null);
  assert.equal(await print.isEnabled(), true);
  assert.match(await card.innerText(), new RegExp(state.student.username));
  assert.equal(attempts, 2);
  assert.equal(state.writes.filter(call => call.path === '/api/student/card').length, 3);
});
const readyAnalysis = (label, explanations = {}) => ({data: {status: 'ready', explanations,
  analysis: {strengths: label + '的掌握情况', review: label + '的复习重点', nextStep: label + '的下一步'}}});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
for (const numberCard of [true, false]) {
  test((numberCard ? '通用卡' : '个人卡') + '首屏按原题顺序复习，数学排版和练习选择随课堂保留', async t => {
    const {page, state} = await setup(t, {student:true, authenticated:true, width:390, prepare(state) {
      const lesson = logarithmLesson(state, {numberCard});
      if (!numberCard) state.report.sessions.unshift({...lesson, id:'previous', title:'', startedAt:lesson.startedAt - 86400000});
      state.analyze = () => readyAnalysis('本节', {'2':'不能覆盖题源错因'});
    }});
    const counts = page.locator('#student-lesson-counts'), drill = page.locator('.student-exercise');
    await page.getByRole('heading', {name:'对数的概念', exact:true}).waitFor();
    assert.deepEqual(await counts.locator('span').allTextContents(), ['共 5 题','答对 4 题','答错 1 题']);
    assert.equal(await counts.locator('.student-other-counts').count(), 0);
    assert.equal(await page.locator('.student-question msup').count(), 1);
    assert.equal(await page.locator('.student-question msub').textContent(), 'log−2');
    assert.equal(await drill.locator('mfrac').textContent(), '12');
    assert.equal(await page.locator('.student-verdict strong').allTextContents().then(a => a.join(' / ')), '对 / 错');
    assert.match(await page.locator('#student-mistake-explanation').innerText(), /^−2 是负数/);
    assert.equal(await page.locator('#student-knowledge-session').isVisible(), !numberCard);
    assert.equal(await page.locator('.student-record').count(), 0);
    assert.equal(await drill.count(), 1);
    assert.equal(await drill.locator('[role=status]').innerText(), '');
    await drill.getByRole('button').nth(3).press('Enter');
    assert.match(await drill.locator('[role=status]').innerText(), /^应选 C。/);
    assert.equal(await drill.locator('[role=status] mfrac').count(), 1);
    await page.getByRole('button', {name:'下一题', exact:true}).press('Enter');
    assert.match(await drill.locator('legend').innerText(), /应满足什么条件/);
    assert.equal(await page.locator('.student-drill .student-progress').innerText(), '2 / 2');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'student-drill-title');
    const choice = drill.getByRole('button', {name:'D x > 2'});
    await choice.click();
    const checked = page.waitForResponse(r => r.url().endsWith('/api/student/session'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await checked;
    await page.waitForFunction(() => document.querySelector('#student-main').getAttribute('aria-busy') === 'false');
    assert.equal(await choice.evaluate(node => node === document.activeElement && node.getAttribute('aria-pressed') === 'true'), true);
    assert.equal(callsForAnalysis(state).length, 1);
    if (!numberCard) {
      const picker = page.getByLabel('选择课堂');
      await picker.selectOption('previous'); await page.getByRole('heading',{name:'数学课堂',exact:true}).waitFor();
      assert.equal(await page.locator('#student-ai-action').isVisible(), false);
      await picker.selectOption('lesson');
      assert.equal(await choice.getAttribute('aria-pressed'), 'true');
    }
    await page.getByRole('button', {name:'查看学情报告'}).click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'student-ai-title');
    await page.getByRole('button',{name:'上一题',exact:true}).click();
    assert.equal(await drill.getByRole('button').nth(3).getAttribute('aria-pressed'), 'true');
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({width,height:844}); await noOverflow(page);
      assert.ok((await drill.getByRole('button').first().boundingBox()).height >= 44);
    }
    await page.setViewportSize({width:360,height:760});
    await page.evaluate(() => { document.documentElement.style.fontSize = '150%'; });
    await noOverflow(page);
  });
}
test('202 按间隔续查，只有主动重试携带 retry，返回分析保留焦点与教师原文', async t => {
  const gate = deferred(), times = [], id = '数学/第 2 节';
  const {page,state} = await setup(t,{student:true,authenticated:true,prepare(state) {
    logarithmLesson(state,{id});
    state.report.records[1].explanation = '';
    state.analyze = async () => {
      times.push(Date.now());
      if (times.length === 2) return {httpStatus:503,data:{error:'生成失败，请重试。'}};
      if (times.length === 4) { await gate.promise; return readyAnalysis('本节', {'2':'AI 补充 <b>原文</b>，底数不能为 −2。'}); }
      return {httpStatus:202,data:{status:'pending',retryAfterMs:240}};
    };
  }});
  t.after(() => gate.resolve());
  await page.getByText('正在生成本节学情报告…').waitFor();
  assert.equal(await page.locator('#student-mistake-explanation').isVisible(),false);
  await page.getByRole('button',{name:'重试',exact:true}).waitFor();
  assert.equal(times.length,2);
  await page.getByRole('button',{name:'重试',exact:true}).press('Enter');
  await page.getByText('正在生成本节学情报告…').waitFor();
  const choice=page.locator('.student-exercise button').first();
  await choice.click(); gate.resolve();
  await page.getByText('本节的下一步').waitFor();
  assert.deepEqual(await page.locator('#student-ai-content dd').allTextContents(),['本节的掌握情况','本节的复习重点','本节的下一步']);
  assert.match(await page.locator('#student-mistake-explanation').innerText(),/AI 补充 <b>原文<\/b>/);
  assert.equal(await page.locator('#student-mistake-explanation b').count(),0);
  assert.equal(await choice.evaluate(node => node === document.activeElement && node.getAttribute('aria-pressed') === 'true'),true);
  const calls=callsForAnalysis(state);
  assert.deepEqual(calls.map(r=>r.body),[{revision:7},{revision:7},{revision:7,retry:true},{revision:7}]);
  assert.ok(calls.every(r=>r.method==='POST' && r.csrf==='student-csrf' && r.path === '/api/student/report/'+encodeURIComponent(id)+'/analysis'));
  assert.ok(times[1]-times[0]>=230 && times[3]-times[2]>=230);
});
test('多道正式错题各带自己的练习，无题源和 AI 错因时不补写', async t => {
  const {page}=await setup(t,{student:true,authenticated:true,prepare(state) {
    logarithmLesson(state);
    state.report.records[1].explanation='';
    const third=state.report.records[2];
    Object.assign(third,{option:'B',status:'wrong',text:'保留教师原文 <strong>第三题</strong>',
      exercises:[{id:'third',tag:'集合',text:'第三题的配套练习',options:['甲','乙'],answer:'B',explanation:'乙符合条件。'}]});
    state.report.records.reverse();
  }});
  await page.getByRole('heading',{name:'第 2 题 · 判断'}).waitFor();
  await page.getByText('本节答对的内容。').waitFor();
  assert.equal(await page.locator('#student-mistake-explanation').isVisible(),false);
  await page.getByRole('button',{name:'下一题',exact:true}).click();
  await page.getByRole('button',{name:'下一题',exact:true}).press('Enter');
  assert.equal(await page.locator('#student-mistake-title').innerText(),'第 3 题 · 单选');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'student-mistake-title');
  assert.equal(await page.locator('.student-question').innerText(),'保留教师原文 <strong>第三题</strong>');
  assert.equal(await page.locator('.student-exercise legend').innerText(),'第三题的配套练习');
  assert.equal(await page.locator('.student-drill .student-progress').innerText(),'1 / 1');
});
for (const [httpStatus,code] of [[409,'analysis_changed'],[403,'forbidden'],[404,'not_found']]) {
  test('分析返回 '+httpStatus+' 时引导重载最新报告，作答与解析同时更新', async t => {
    const {page,state}=await setup(t,{student:true,authenticated:true,prepare(state) {
      logarithmLesson(state,{numberCard:true});
      state.analyze=()=>({httpStatus,data:{code,error:'当前课堂报告已变化。'}});
    }});
    const reload=page.getByRole('button',{name:'重新载入最新报告'});
    await reload.waitFor();
    await page.locator('.student-exercise button').last().click();
    assert.equal(await page.getByRole('button',{name:'重试',exact:true}).count(),0);
    if (httpStatus===409) state.report.sessions[0].revision++;
    else {
      state.report.sessions[0].id='latest';
      state.report.records.forEach(row => { row.sessionId='latest'; });
    }
    Object.assign(state.report.records[1],{text:'新题面，老师已修订。',explanation:''});
    state.analyze=()=>readyAnalysis('新版',{'2':'与新版答案对应的错因。'});
    await reload.press('Enter'); await page.getByText('新版的复习重点').waitFor();
    assert.equal(await page.locator('.student-question').innerText(),'新题面，老师已修订。');
    assert.equal(await page.locator('#student-mistake-explanation').innerText(),'与新版答案对应的错因。');
    assert.equal(await page.locator('.student-exercise [aria-pressed=true]').count(),0);
    assert.deepEqual(callsForAnalysis(state).map(r=>r.body),[{revision:7},{revision:httpStatus===409?8:7}]);
  });
}
test('已判定零错题仍生成报告，服务端和本地的无样本状态都可辨认',async t=>{
  const {page,state}=await setup(t,{student:true,authenticated:true,prepare(state){
    const latest=logarithmLesson(state);
    state.report.records=state.report.records.filter(r=>r.isOfficial && r.status==='correct');
    state.report.sessions.unshift({...latest,id:'empty',title:'尚无判分',startedAt:latest.startedAt-10000});
    state.report.records.push({...state.report.records[0],sessionId:'empty',status:'ungraded',answer:null});
    state.analyze=()=>({data:{status:'insufficient'}});
  }});
  await page.getByText('本节已判定的题目全部答对了。').waitFor();
  await page.locator('#student-ai-state').filter({hasText:'暂无可判定'}).waitFor();
  assert.equal(await page.locator('.student-exercise').count(),0);
  await page.getByLabel('选择课堂').selectOption('empty');
  assert.equal(await page.locator('#student-report').innerText(),'本节暂无可判定的正式作答。');
  assert.match(await page.locator('#student-ai-state').innerText(),/暂无可判定/);
  assert.equal(await page.locator('#student-ai-action').isVisible(),false);
  assert.equal(callsForAnalysis(state).length,1);
});
test('本节补充计数只取非零的正式结果，弃权、免答及旧版未完成分列',async t=>{
  const {page}=await setup(t,{student:true,authenticated:true,prepare(state){
    logarithmLesson(state);
    const base=state.report.records[0];
    for(const [index,status] of ['abstained','exempt','ungraded','incomplete','unanswered','abstained'].entries()){
      state.report.records.push({...base,status,questionId:'extra'+index,roundId:'extra'+index,questionNumber:6+index,option:null});
    }
    state.report.records.push({...base,status:'exempt',isOfficial:false,questionId:'old',roundId:'old'});
  }});
  const summary=page.locator('#student-lesson-counts');
  await summary.waitFor();
  assert.deepEqual(await summary.locator('span').allTextContents(),['共 11 题','答对 4 题','答错 1 题']);
  assert.equal(await summary.locator('.student-other-counts').innerText(),'弃权 2 题 · 免答 1 题 · 未判定 1 题 · 未完成 1 题 · 未答 1 题');
});
test('旧课堂的延迟应答和窗口刷新不会覆盖选中的课堂、练习或焦点',async t=>{
  const oldAnalysis=deferred(), readStarted=deferred(), oldRead=deferred();
  const {page,state}=await setup(t,{student:true,authenticated:true,prepare(state){
    const latest=logarithmLesson(state), earlier={...latest,id:'earlier',title:'先前的课堂'};
    state.report.sessions.unshift(earlier);
    state.report.records.push({...state.report.records[1],sessionId:earlier.id,text:'先前的题干',explanation:''});
    state.analyze=async id=>{
      if(id==='lesson'){await oldAnalysis.promise; return readyAnalysis('旧选择',{'2':'旧选择错因'});}
      return readyAnalysis('当前选择',{'2':'当前选择错因'});
    };
  }});
  t.after(()=>{oldAnalysis.resolve();oldRead.resolve();});
  await page.getByRole('heading',{name:'针对练习'}).waitFor();
  state.readReport=async()=>{readStarted.resolve(); await oldRead.promise;};
  await page.locator('#student-report-reload').click(); await readStarted.promise;
  const cancelled=page.waitForEvent('requestfailed',{predicate:r=>r.url().endsWith('/report/lesson/analysis')});
  await page.getByLabel('选择课堂').selectOption('earlier');
  await cancelled;
  await page.getByText('当前选择错因').waitFor();
  await page.getByRole('button',{name:'下一题',exact:true}).press('Enter');
  const choice=page.locator('.student-exercise button').last(); await choice.press('Enter');
  const verify=page.waitForResponse(r=>r.url().endsWith('/api/student/session'));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus'))); await verify;
  oldAnalysis.resolve(); oldRead.resolve();
  await page.waitForFunction(()=>document.querySelector('#student-main').getAttribute('aria-busy')==='false');
  assert.equal(await page.getByLabel('选择课堂').inputValue(),'earlier');
  assert.equal(await choice.getAttribute('aria-pressed'),'true');
  assert.equal(await choice.evaluate(node=>document.activeElement===node),true);
  assert.match(await page.locator('#student-ai-content').innerText(),/当前选择的下一步/);
  assert.doesNotMatch(await page.locator('article').innerText(),/旧选择/);
  assert.equal(callsForAnalysis(state).length,2);
});
test('缺少 AbortSignal 静态方法时仍能超时取消，再用新请求完成重试', {timeout:15000}, async t=>{
  const held=deferred(), started=deferred();
  const {page,state}=await setup(t,{student:true,authenticated:true,async beforeOpen(page){
    await page.addInitScript(()=>{
      Object.defineProperty(AbortSignal,'any',{value:undefined});
      Object.defineProperty(AbortSignal,'timeout',{value:undefined});
    });
    await page.clock.install();
  },prepare(state){
    logarithmLesson(state);
    state.analyze=async (id,call)=>{
      if(!call.body.retry){started.resolve();await held.promise;}
      return readyAnalysis('重试成功');
    };
  }});
  t.after(()=>held.resolve());
  await started.promise;
  const cancelled=page.waitForEvent('requestfailed',{predicate:r=>r.url().endsWith('/analysis')});
  await page.clock.fastForward(60001);await cancelled;
  await page.getByText('读取超时，请检查连接后重试。').waitFor();
  await page.getByRole('button',{name:'重试',exact:true}).press('Enter');held.resolve();
  await page.getByText('重试成功的掌握情况').waitFor();
  assert.deepEqual(callsForAnalysis(state).map(c=>c.body),[{revision:7},{revision:7,retry:true}]);
  const mathText=await page.evaluate(()=>{
    const div=document.createElement('div');
    div.innerHTML=window.StudentReportText.math('2026-11-26 编号 A-2，得 -8；catalog_2 与 1/2、2026/11/26。');
    return {text:div.textContent,log:div.querySelectorAll('msub').length,fractions:div.querySelectorAll('mfrac').length};
  });
  assert.match(mathText.text,/2026-11-26 编号 A-2，得 −8；catalog_2/);
  assert.deepEqual([mathText.log,mathText.fractions],[0,1]);
});
test('同一课堂换账号时隔离未返回的分析、旧选项和错因',async t=>{
  const first=deferred(), auth=deferred(), checking=deferred();
  const {page,state}=await setup(t,{student:true,authenticated:true,prepare(state){
    logarithmLesson(state);
    state.report.records[1].explanation='';
    state.analyze=async()=>{
      if(state.student.id==='account-s1'){await first.promise; return readyAnalysis('第一人',{'2':'第一人错因'});}
      return readyAnalysis('第二人',{'2':'第二人错因'});
    };
  }});
  t.after(()=>{first.resolve();auth.resolve();});
  await page.locator('.student-exercise button').last().click();
  state.student={...state.student,id:'account-s2',username:'2610902',csrfToken:'second-csrf'};
  state.readSession=async()=>{checking.resolve(); await auth.promise;};
  await page.evaluate(()=>window.dispatchEvent(new Event('focus'))); await checking.promise;
  const completed=page.waitForResponse(r=>r.url().endsWith('/analysis'));
  first.resolve(); await completed;
  assert.doesNotMatch(await page.locator('article').innerText(),/第一人/);
  auth.resolve(); await page.getByText('第二人错因').waitFor();
  assert.equal(await page.locator('.student-exercise [aria-pressed=true]').count(),0);
  assert.deepEqual(callsForAnalysis(state).map(r=>r.csrf),['student-csrf','second-csrf']);
});
test('离开页面后终止 pending 轮询，恢复页重新核对身份',async t=>{
  const gate=deferred();
  const {page,state}=await setup(t,{student:true,authenticated:true,prepare(state){
    logarithmLesson(state);
    state.analyze=async()=>{await gate.promise;return {httpStatus:202,data:{status:'pending',retryAfterMs:2000}};};
  }});
  await page.locator('.student-exercise').waitFor();
  await page.clock.install();
  const returned=page.waitForResponse(r=>r.status()===202); gate.resolve(); await returned;
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  await page.clock.fastForward(6000);
  assert.equal(callsForAnalysis(state).length,1);
  assert.equal(await page.locator('#student-ai-content').textContent(),'');
  state.authenticated=false;
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await page.locator('#loginForm:not(.hidden)').waitFor();
  assert.equal(callsForAnalysis(state).length,1);
});
test('a reusable card can practise its own missed topic from either report view', async t => {
  const {state, page, errors} = await setup(t, {width: 360, student: true, authenticated: true, prepare(state) {
    state.student.numberCard = true;
    const missed = state.report.records.find(r => r.isOfficial && r.status === 'wrong');
    missed.questionNumber = 2;
    missed.exercises = [{id: 'log-1', tag: '集合', text: '选择正确的说法', options: ['甲', '乙'],
      answer: 'B', explanation: '乙符合定义。'}];
    state.report.sessions[0].knowledge = [{tag: '集合', questionCount: 2, correct: 1, wrong: 1, samples: 2, wrongQuestionNumbers: [2]}];
  }});
  await page.getByRole('heading',{name:'针对练习'}).waitFor();
  const group = page.locator('.student-exercise');
  assert.equal(await group.count(), 1);
  assert.equal(await group.locator('[role=status]').innerText(), '');
  const first = group.getByRole('button', {name: 'A 甲'});
  await first.focus(); await page.keyboard.press('Enter');
  assert.match(await group.locator('[role=status]').innerText(), /应选 B。 乙符合定义/);
  await page.locator('[data-student-view=knowledge]').click();
  assert.equal(await group.getByRole('button', {name: 'A 甲'}).getAttribute('aria-pressed'), 'true');
  await group.getByRole('button', {name: 'B 乙'}).click();
  assert.match(await group.locator('[role=status]').innerText(), /答对了。 乙符合定义/);
  assert.equal((await group.getByRole('button').first().boundingBox()).height >= 44, true);
  await noOverflow(page);
  await page.setViewportSize({width: 1280, height: 800}); await noOverflow(page);
  assert.deepEqual(state.writes.map(w=>[w.path,w.body]), [['/api/student/report/lesson/analysis',{}]]);
  state.report.records = []; state.report.sessions = [];
  await page.locator('#student-report-reload').click();
  await page.getByText('本卡暂无本节知识点记录。').waitFor();
  assert.equal(await group.count(), 0); assert.deepEqual(errors, []);
});
test('number cards can be issued by keyboard and printed independently of the class roster',async t=>{
  const {page,state}=await setup(t,{width:390});
  await page.locator('[name=lastNumber]').fill('2');
  await page.locator('[name=lastNumber]').press('Enter');
  await page.locator('.cq-credentials').waitFor();
  assert.equal(state.accounts.numberCards.length,2);
  await page.addInitScript(()=>{window.print=()=>{};});
  await page.locator('[data-cq-action=print-issued]').click();
  const frame=page.frameLocator('.cq-issued-frame');
  await frame.locator('.card-sheet').first().waitFor({state:'attached'});
  assert.equal(await frame.locator('.card-sheet').count(),2);
  assert.match(await frame.locator('.card-sheet').first().textContent(),/学生编号26110901/);
  await noOverflow(page);
});
for(const [metadata,usernames,expected] of [
  ['legacy',[undefined,undefined],'所选通用卡已发放。'],
  ['partial',['25110901',undefined],'所选通用卡已发放。'],
  ['current',['25110901','25110902'],'所选通用卡已发放。登录编号 25110901 - 25110902，沿用原密码。'],
  ['single',['25110901'],'所选通用卡已发放。登录编号 25110901，沿用原密码。']
]){
  test(`already issued number cards show the correct notice with ${metadata} metadata`,async t=>{
    const {page,state}=await setup(t,{width:metadata==='current'?1280:390});
    state.accounts.numberCards=usernames.map((username,i)=>({accountId:'card-'+(i+1),cardNumber:i+1,username}));
    const end=page.locator('#cq-number-form [name=lastNumber]');
    await end.fill(String(usernames.length));
    await end.press('Enter');
    const notice=page.locator('.cq-feedback[role=status]').filter({hasText:'所选通用卡已发放。'});
    await notice.waitFor();
    assert.equal(await notice.innerText(),expected);
    assert.equal(await page.locator('.cq-credentials').count(),0);
    await noOverflow(page);
  });
}
async function noPersistentPassword(page){
  assert.equal(await page.evaluate(()=>Object.values({...localStorage,...sessionStorage}).some(v=>/001234|009876|006789/.test(v))),false,'No credentials in browser storage');
  assert.equal(/[?&#](password|currentPassword|newPassword)=/.test(page.url()),false,'No password URL parameters');
}
async function openPrint(context,origin,query='classId=c1'){
  const page=await context.newPage();await page.goto(origin+'/card-quiz/print.html?'+query);await page.locator('#metadata table').waitFor();return page;
}
test('teacher generates once, safely downloads text credentials, resets only selected, and links an original account',async t=>{
  const{page,state}=await setup(t,{width:390});
  state.accounts.students[2].cardNumber=null;state.cards.students[2].cardNumber=null;
  await page.locator('[data-cq-action=reload]').click();await page.locator('#cq-generate-form').waitFor();
  assert.equal(state.writes.length,0);
  await page.locator('[name=entryYear]').fill('2026');await page.locator('[name=classCode]').fill('109');
  await page.locator('[name=classCode]').press('Enter');await page.locator('.cq-credentials').waitFor();
  assert.equal(state.writes.length,1);assert.equal(state.writes[0].body.entryYear,2026);
  assert.deepEqual(Object.keys(state.writes[0].body).sort(),['cardRevision','classCode','entryYear','revision','rosterRevision']);
  assert.equal(await page.locator('.cq-password').count(),2);
  await page.addInitScript(()=>{if(location.search==='?issued')window.print=()=>{document.documentElement.dataset.printed='true';};});
  for(let attempt=0;attempt<2;attempt++){
    await page.getByRole('button',{name:'打印本次纸卡'}).click();
    const preview=page.frameLocator('.cq-issued-frame');
    await preview.locator('html[data-printed]').waitFor({state:'attached'});
    assert.deepEqual(await preview.locator('.card-number strong').allTextContents(),['01','157']);
    assert.deepEqual(await preview.locator('.card-password').allTextContents(),[password,password]);
    assert.equal(await preview.locator('.card-portal').first().getAttribute('href'),'https://iceclass.icecreamchat.top/student');
    assert.equal(state.writes.length,1,'Printing the issued batch reuses the original passwords');
  }
  const downloadEvent=page.waitForEvent('download');await page.locator('[data-cq-action=download-credentials]').click();const download=await downloadEvent;
  const csv=fs.readFileSync(await download.path(),'utf8');
  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.invalid"")"'),'Formula-leading names are quoted as text');
  assert.ok(csv.includes('"\'001234"'),'Six-digit passwords retain leading zero as text');
  assert.ok(!csv.includes('="'),'CSV does not use spreadsheet formulas');
  await page.locator('[data-cq-tab=bank]').click();await page.locator('#workbenchConfirm[open] #workbenchConfirmCancel').click();
  assert.equal(await page.locator('.cq-credentials').isVisible(),true);
  await page.locator('[data-cq-action=clear-credentials]').click();assert.equal(await page.locator('.cq-password').count(),0);
  assert.equal(await page.locator('.cq-issued-frame').count(),0);
  await page.locator('[data-account-student=s2]').check();assert.equal(await page.locator('#cq-accounts-all').evaluate(n=>n.indeterminate),true);
  await page.locator('[data-cq-action=reset-accounts]').click();await page.locator('#workbenchConfirm[open] #workbenchConfirmAccept').click();await page.locator('.cq-credentials').waitFor();
  const reset=state.writes.find(r=>r.path.endsWith('/reset'));assert.deepEqual(reset.body.studentIds,['s2']);assert.equal(reset.csrf,'fixture');
  await page.locator('[data-cq-action=clear-credentials]').click();await page.locator('.cq-link-account summary').click();
  await page.locator('#cq-link-form [name=studentId]').selectOption('s3');await page.locator('#cq-link-form [name=username]').fill('2510903');
  await page.locator('[data-cq-action=link-account]').click();await page.locator('#workbenchConfirm[open] #workbenchConfirmAccept').click();await page.waitForFunction(()=>document.querySelector('.cq-feedback').textContent.includes('原账号已关联'));
  assert.equal(state.accounts.students[2].username,'2510903');assert.equal(await page.locator('.cq-password').count(),0);
  await noOverflow(page);await noPersistentPassword(page);
});
test('account version conflicts preserve fields and selections, permission errors remain actionable',async t=>{
  const{page,state}=await setup(t,{linked:true});
  await page.locator('[data-account-student=s1]').check();state.versionError=true;
  await page.locator('[data-cq-action=reset-accounts]').click();await page.locator('#workbenchConfirm[open] #workbenchConfirmAccept').click();await page.locator('.cq-feedback.cq-error').waitFor();
  assert.match(await page.locator('.cq-feedback').innerText(),/重新载入/);assert.equal(await page.locator('[data-account-student=s1]').isChecked(),true);
  assert.equal(await page.locator('[data-cq-action=reset-accounts]').isDisabled(),true);assert.equal(state.writes.length,1);
  state.versionError=false;await page.locator('[data-cq-action=reload]').click();await page.locator('[data-account-student=s1]:not([disabled])').waitFor();
  state.linkDenied=true;await page.locator('.cq-link-account summary').click();
  await page.locator('#cq-link-form [name=studentId]').selectOption('s3');await page.locator('#cq-link-form [name=username]').fill('2510903');
  await page.locator('[data-cq-action=link-account]').click();await page.locator('#workbenchConfirm[open] #workbenchConfirmAccept').click();await page.locator('.cq-feedback.cq-error').waitFor();
  assert.match(await page.locator('.cq-feedback').innerText(),/原班管理权限/);assert.equal(await page.locator('#cq-link-form [name=username]').inputValue(),'2510903');
  assert.equal(await page.locator('[data-cq-action=link-account]').isEnabled(),true);
});
test('optional account metadata failure keeps card editing and all three question types usable',async t=>{
  const{page,state}=await setup(t);state.accountsUnavailable=true;
  await page.locator('[data-cq-action=reload]').click();
  await page.getByRole('alert').filter({hasText:'账号信息暂时不可用。'}).waitFor();
  await page.locator('[data-card-student=s1]').fill('8');await page.locator('[data-cq-action=save-cards]').click();
  await page.waitForFunction(()=>document.querySelector('.cq-feedback').textContent.includes('已保存'));assert.equal(state.cards.students[0].cardNumber,8);
  state.accountsUnavailable=false; await page.getByRole('button',{name:'重试读取账号',exact:true}).click();
  await page.locator('#cq-generate-form').waitFor();
  await page.locator('[data-cq-tab=bank]').click();await page.locator('[data-cq-action=new-question]').click();
  assert.deepEqual(await page.locator('[name=type] option').evaluateAll(nodes=>nodes.map(n=>n.value)),['single','boolean','multiple']);
});
test('teacher reset confirmation prints the foldable account strip and a 170 mm marker on one A4 page',async t=>{
  const{context,origin,state}=await setup(t,{width:390,linked:true});state.accounts.className='高一年级国际课程实验班'.repeat(8);
  const page=await openPrint(context,origin);
  assert.equal(state.writes.length,0);assert.equal(await page.locator('.card-sheet').count(),0);assert.equal(await page.locator('#print').isDisabled(),true);
  await page.locator('#prepare').click();await page.locator('#cancel-reset').click();assert.equal(state.writes.length,0);
  await page.locator('#prepare').click();await page.locator('#confirm-reset').click();await page.locator('#print:not([disabled])').waitFor();
  assert.equal(state.writes.length,1);assert.deepEqual(state.writes[0].body.studentIds,['s1','s2']);
  await noOverflow(page);await noPersistentPassword(page);await page.emulateMedia({media:'print'});
  const dimensions=await page.locator('.card-sheet').evaluateAll(nodes=>nodes.map(sheet=>{
    const svg=sheet.querySelector('svg'),black=svg.querySelector('g[shape-rendering="crispEdges"]').getBBox();
    const caption=sheet.querySelector('.card-caption').getBoundingClientRect(),symbol=svg.getBoundingClientRect();
    const classText=sheet.querySelector('.card-class').getBoundingClientRect(),fold=sheet.querySelector('.card-login').getBoundingClientRect();
    const portal=sheet.querySelector('.card-portal'),password=sheet.querySelector('.card-password').getBoundingClientRect();
    return{blackMm:black.width/svg.viewBox.baseVal.width*symbol.width*25.4/96,height:sheet.getBoundingClientRect().height*25.4/96,
      overflow:sheet.scrollHeight-sheet.clientHeight,captionFits:classText.top>=caption.top && classText.bottom<=symbol.top,
      foldsAway:Math.max(password.bottom,portal.getBoundingClientRect().bottom)<=fold.bottom && fold.bottom<=caption.top,
      url:portal.href,text:sheet.innerText};
  }));
  assert.equal(dimensions.length,2);
  for(const d of dimensions){
    assert.ok(Math.abs(d.blackMm-170)<.1);
    assert.ok(Math.abs(d.height-297)<.1 && d.overflow<=1);
    assert.ok(d.foldsAway && d.captionFits,'Folding must leave the full class name and marker visible');
    assert.ok(d.text.includes(state.accounts.className));
    assert.match(d.text,/学生编号/);assert.match(d.text,/登录密码/);assert.match(d.text,/卡号/);
    assert.match(d.text,/单选.*判断/);assert.match(d.text,/多选\s*只在选中项举 A，改为不选举 B/);
    assert.match(d.text,/整题未举记弃权，免答另计/);assert.match(d.text,/图案朝镜头，捏白边举稳/);
    assert.equal(d.url,'https://iceclass.icecreamchat.top/student');
    assert.match(d.text,/扫码查看我的AI课后报告/);assert.match(d.text,/备案号\s*皖ICP备2025106471号/);
    assert.match(d.text,/ICeClass 教师端/);assert.match(d.text,/「班伴班班」/);assert.match(d.text,/管局备案中，上线后开放/);
    assert.match(d.text,/版式著作权归许斌所有/);assert.match(d.text,/获授权学校的师生可为本班教学打印、补印/);
    assert.doesNotMatch(d.text,/姓名|学生乙|HYPERLINK/);
  }
  const pdf=await page.pdf({preferCSSPageSize:true});assert.equal([...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length,2);
  await page.emulateMedia({media:'screen'});await page.locator('#clear').click();assert.equal(await page.locator('.card-sheet').count(),0);assert.equal(await page.locator('#print').isDisabled(),true);
});
test('read-only metadata cannot expose password actions or prepare teacher print',async t=>{
  const{page,context,state,origin}=await setup(t,{canEdit:false,linked:true,width:390});
  assert.equal(await page.locator('[data-cq-action=generate-accounts],[data-cq-action=reset-accounts],[data-cq-action=print-all],[data-cq-action=print-one]').count(),0);
  const print=await openPrint(context,origin,'classId=c1&card=1');
  assert.equal(await print.locator('#prepare').isDisabled(),true);assert.equal(await print.locator('#print').isDisabled(),true);
  assert.match(await print.locator('#feedback').innerText(),/只读权限/);assert.equal(state.writes.length,0);await noOverflow(print);
});
test('teacher print version conflict disables preparation until an explicit metadata reload',async t=>{
  const{context,origin,state}=await setup(t,{linked:true});const page=await openPrint(context,origin,'classId=c1&card=1');
  state.versionError=true;await page.locator('#prepare').click();await page.locator('#confirm-reset').click();await page.locator('#feedback.error').waitFor();
  assert.match(await page.locator('#feedback').innerText(),/重新载入.*版本/);assert.equal(await page.locator('#prepare').isDisabled(),true);assert.equal(await page.locator('#print').isDisabled(),true);
  assert.equal(await page.locator('.card-sheet').count(),0);assert.equal(state.writes.length,1);
  state.versionError=false;await page.locator('#reload').click();await page.locator('#prepare:not([disabled])').waitFor();assert.equal(state.writes.length,1);
});
test('a delayed credential response cannot repopulate the teacher view after account teardown',async t=>{
  const{page,state}=await setup(t);let release;
  state.holdWrite=new Promise(resolve=>release=resolve);const started=new Promise(resolve=>state.writeStarted=resolve);
  await page.locator('[data-cq-action=generate-accounts]').click();await started;
  const finished=page.waitForEvent('requestfinished',{predicate:request=>request.method()==='POST'&&request.url().endsWith('/classes/c1/students')});
  try{await page.evaluate(()=>{window.ICeClass.state.user=null;window.dispatchEvent(new Event('iceclass-logout'));});}finally{release();}
  await finished;
  // Wait for the fetch continuation and render cycle after the delayed reply.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#cardQuizRoot > *').count(),0);
  assert.equal(await page.locator('.cq-password,.cq-credentials').count(),0);await noPersistentPassword(page);
});

test('leaving the teacher view clears the one-time password table from the hidden DOM',async t=>{
  const{page}=await setup(t);
  await page.locator('[data-cq-action=generate-accounts]').click();await page.locator('.cq-credentials').waitFor();
  assert.equal(await page.locator('.cq-password').count(),3);
  await page.locator('#mainNav [data-view=history]').click();await page.locator('#workbenchConfirm[open] #workbenchConfirmAccept').click();
  await page.locator('#view-history:not(.hidden)').waitFor();
  assert.equal(await page.locator('#cardQuizRoot .cq-password,#cardQuizRoot .cq-credentials').count(),0);
});
test('shared student login allows a retry and renders only student records and images',async t=>{
  const{page,state}=await setup(t,{student:true,width:390});
  assert.ok(await page.locator('#loginRoleStudent').isChecked());
  await page.locator('#loginUsername').fill('261109157');
  assert.equal(await page.locator('#loginUsername').inputValue(),'261109157');
  assert.equal(await page.locator('#loginUsername').evaluate(input=>input.checkValidity()),true);
  await page.locator('#loginUsername').fill(state.student.username);await page.locator('#loginPassword').fill('999999');
  await page.locator('#loginPassword').press('Enter');await page.locator('#loginError').filter({hasText:'学生编号或密码错误'}).waitFor();
  assert.equal(await page.locator('#loginUsername').inputValue(),state.student.username);
  assert.equal(await page.locator('#loginPassword').inputValue(),'');
  await page.locator('#loginPassword').fill(password);
  await page.locator('#loginPassword').press('Enter');
  await page.getByRole('button',{name:'所有作答记录'}).click();await page.locator('.student-record').first().waitFor();
  assert.equal(state.writes.filter(r=>r.path==='/api/student/login').at(-1).body.password,password);
  assert.equal(await page.locator('.student-record').count(),8);
  assert.deepEqual(await page.locator('.student-status').allTextContents(),['正确','错误','未完成','未答','免答','未判定','练习','错误']);
  assert.match(await page.locator('#student-totals').innerText(),/50\.0%/);assert.match(await page.locator('.student-denominator').innerText(),/正确 \+ 错误/);
  const incomplete=page.locator('.student-record').filter({has:page.locator('[data-status=incomplete]')});await incomplete.locator('summary').click();
  assert.match(await incomplete.innerText(),/A 选 · B 不选 · C 未答 · D 未答/);
  await page.locator('img[src="/api/student/images/image1"]').waitFor();await page.waitForFunction(()=>document.querySelector('.student-question-image').complete);
  assert.equal(state.requests.some(r=>r.path==='/api/student/images/image1'),true);
  assert.match(await page.locator('.student-record').last().innerText(),/非最终正式轮次.*不计入汇总/);
  await page.locator('[data-student-view=wrong]').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.student-record').count(),1);
  await page.locator('[data-student-view=knowledge]').click();assert.match(await page.locator('.student-table').innerText(),/集合/);
  assert.equal(state.requests.some(r=>!r.path.startsWith('/api/student/')),false,'Student page never requests teacher data');
  await noOverflow(page);await noPersistentPassword(page);await page.emulateMedia({forcedColors:'active'});await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>document.activeElement!==document.body));
});
test('wrong current password preserves the student session; self print and change password use only current identity',async t=>{
  const{page,state}=await setup(t,{student:true,authenticated:true,width:390});
  await page.locator('#student-report-feedback').filter({hasText:'已读取'}).waitFor();
  await page.locator('#card-password').fill('999999');await page.locator('#student-card-form button').click();await page.locator('#student-card-error').filter({hasText:'当前密码错误'}).waitFor();
  assert.equal(await page.locator('#student-workspace').isVisible(),true);assert.equal(await page.locator('#cards .card-sheet').count(),0);
  await page.locator('#card-password').fill(password);await page.locator('#student-card-form button').click();await page.locator('#student-print:not([disabled])').waitFor();
  assert.equal(await page.locator('.card-sheet').count(),1);assert.equal(await page.locator('#card-password').inputValue(),'');
  assert.deepEqual(Object.keys(state.writes.filter(r=>r.path==='/api/student/card').at(-1).body),['password']);
  await noOverflow(page);await noPersistentPassword(page);
  const portal=page.locator('.card-portal');
  await page.keyboard.press('Tab');await portal.focus();
  assert.equal(await portal.evaluate(el=>el.matches(':focus-visible') && getComputedStyle(el).outlineStyle!=='none'),true);
  await portal.hover();
  await page.emulateMedia({media:'print'});assert.equal(await page.locator('#student-workspace').isVisible(),false);
  assert.deepEqual(await portal.evaluate(el=>{
    const style=getComputedStyle(el);return [style.color,style.outlineStyle,style.boxShadow];
  }),['rgb(0, 0, 0)','none','none']);
  const pdf=await page.pdf({preferCSSPageSize:true});assert.equal([...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length,1);
  assert.match(await page.locator('.card-sheet').innerText(),/编号[\s\S]*密码[\s\S]*多选/);
  await page.emulateMedia({media:'screen'});await page.locator('#student-card-clear').click();assert.equal(await page.locator('.card-sheet').count(),0);
  await page.locator('#current-password').fill(password);await page.locator('#new-password').fill('006789');await page.locator('#confirm-password').fill('006788');
  await page.locator('#student-password-form button').click();assert.equal(state.writes.some(r=>r.path==='/api/student/password'),false);
  await page.locator('#current-password').fill('999999');await page.locator('#confirm-password').fill('006789');await page.locator('#student-password-form button').click();
  await page.locator('#student-password-error').filter({hasText:'当前密码错误'}).waitFor();assert.equal(await page.locator('#student-workspace').isVisible(),true);
  await page.locator('#current-password').fill(password);await page.locator('#new-password').fill('006789');await page.locator('#confirm-password').fill('006789');await page.locator('#student-password-form button').click();
  await page.locator('#loginForm:not(.hidden)').waitFor();assert.match(await page.locator('#loginNotice').innerText(),/密码已修改.*重新登录/);
  assert.equal(await page.locator('.card-sheet').count(),0);await noPersistentPassword(page);
  await page.locator('#loginUsername').fill(state.student.username);await page.locator('#loginPassword').fill('006789');
  await page.locator('#loginSubmit').click();await page.locator('#student-workspace:not([hidden])').waitFor();
});
test('report failure preserves old data, filter empty state is honest, expired session returns to login',async t=>{
  const{page,state}=await setup(t,{student:true,authenticated:true});
  await page.getByRole('button',{name:'所有作答记录'}).click();await page.locator('.student-record').first().waitFor();
  state.reportError=true;await page.locator('#student-report-reload').click();await page.locator('#student-report-feedback.error').waitFor();
  assert.equal(await page.locator('.student-record').count(),8);assert.match(await page.locator('#student-report-feedback').innerText(),/上次成功读取/);
  state.reportError=false;await page.locator('#student-subject').selectOption('english');await page.getByText('暂无已结束课堂的作答记录。').waitFor();
  assert.match(await page.locator('#student-totals').innerText(),/暂无判定样本/);
  state.authenticated=false;await page.locator('#student-report-reload').click();await page.locator('#loginForm:not(.hidden)').waitFor();
  assert.match(await page.locator('#loginNotice').innerText(),/已失效/);assert.equal(await page.locator('.student-record').count(),0);
});

test('reload and focus reconcile the shared student session before showing another account report',async t=>{
  const{page,state}=await setup(t,{student:true,authenticated:true});await page.locator('.student-mistake').waitFor();
  await page.locator('#card-password').fill(password);await page.locator('#student-card-form button').click();await page.locator('.card-sheet').waitFor();
  state.student={...state.student,id:'account-s2',username:'26109157',cardNumber:157,csrfToken:'second-student-csrf'};
  state.report.records=[{...state.report.records[0],status:'wrong',option:'B',text:'第二位学生的课堂记录'}];
  await page.locator('#student-report-reload').click();await page.locator('.student-question').filter({hasText:'第二位学生的课堂记录'}).waitFor();
  assert.match(await page.locator('#student-identity').innerText(),/26109157/);
  assert.equal(await page.locator('.card-sheet').count(),0);
  state.student={...state.student,id:'account-s3',username:'2610903',cardNumber:3,csrfToken:'third-student-csrf'};
  state.report.records=[{...state.report.records[0],text:'第三位学生的课堂记录'}];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.locator('.student-question').filter({hasText:'第三位学生的课堂记录'}).waitFor();
  assert.match(await page.locator('#student-identity').innerText(),/2610903/);
  assert.doesNotMatch(await page.locator('#student-report').innerText(),/第二位学生的课堂记录/);
  state.student={...state.student,id:'account-s4',username:'2610904',cardNumber:4,csrfToken:'fourth-student-csrf'};
  state.report.records=[{...state.report.records[0],text:'筛选期间切换后的学生记录'}];
  await page.locator('#student-subject').selectOption('math');
  await page.locator('.student-question').filter({hasText:'筛选期间切换后的学生记录'}).waitFor();
  assert.match(await page.locator('#student-identity').innerText(),/2610904/);
});

test('focus during a delayed self-print request reconciles the account before exposing any paper-card password',async t=>{
  const{page,state}=await setup(t,{student:true,authenticated:true});await page.locator('.student-mistake').waitFor();
  let release;state.holdCard=new Promise(resolve=>release=resolve);
  const started=new Promise(resolve=>state.cardStarted=resolve);
  await page.locator('#card-password').fill(password);await page.locator('#student-card-form button').click();await started;
  try{
    state.student={...state.student,id:'account-s2',username:'26109157',cardNumber:157,csrfToken:'second-student-csrf'};
    state.report.records=[{...state.report.records[1],text:'等待纸卡期间已切换的学生'}];
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  }finally{release();}
  await page.locator('#student-main[aria-busy="false"]').waitFor();
  assert.match(await page.locator('#student-identity').innerText(),/26109157/);
  assert.equal(await page.locator('.card-sheet').count(),0);
  assert.equal(await page.locator('#student-print').isDisabled(),true);
  assert.match(await page.locator('#student-report').innerText(),/等待纸卡期间已切换的学生/);
});
test('narrow student identity keeps the account and card labels with their numbers while long class names still wrap',async t=>{
  const{page,state}=await setup(t,{student:true,authenticated:true,width:390});
  state.student.cardNumber=3;await page.reload();await page.locator('#student-identity .student-identity-segment').first().waitFor();
  for(const index of [1,2])assert.equal(await page.locator('.student-identity-segment').nth(index).evaluate(node=>{
    const range=document.createRange();range.selectNodeContents(node);return range.getClientRects().length;
  }),1,'Identity label and number share a line');
  state.student.className='高一年级国际课程实验班'.repeat(8);await page.reload();await page.locator('#student-identity .student-identity-class').waitFor();
  await noOverflow(page);
});

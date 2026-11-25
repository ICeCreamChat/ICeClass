'use strict';
// Fictional accounts over isolated HTTP, using the production pages and CSP.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const {fixture:teacherFixture,navigate}=require('./test-teacher-ui.cjs');
const root=path.resolve(__dirname,'../web_controller');
const clone=value=>JSON.parse(JSON.stringify(value));
const password='001234';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
let browser;
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
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
async function setup(t,{width=1280,student=false,authenticated=false,canEdit=true,linked=false}={}){
  const state=makeFixture();state.authenticated=authenticated;state.canEdit=state.accounts.canEdit=state.cards.canEdit=canEdit;
  if(linked)state.issue(['s1','s2']);
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
          if(p==='/session')return reply(200,{authenticated:state.authenticated,...(state.authenticated?{student:state.student}:{})});
          if(p==='/login'){
            if(body.username!==state.student.username||body.password!==state.password)return reply(401,{error:'学生编号或密码错误。',code:'invalid_credentials'});
            state.authenticated=true;return reply(200,{student:state.student});
          }
          if(!state.authenticated)return reply(401,{error:'请使用学生账号登录。',code:'authentication_required'});
          if(req.method!=='GET'&&call.csrf!==state.student.csrfToken)return reply(403,{error:'页面凭证已失效，请刷新后重试。'});
          if(p==='/report'){
            if(state.reportError)return reply(503,{error:'个人报告暂时不可用，请重试。'});
            return reply(200,{accountId:state.student.id,...(url.searchParams.get('subjectId')==='english'?{totals:{samples:0,correct:0,wrong:0,accuracy:null},knowledge:[],sessions:[],records:[]}:state.report)});
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
  await page.goto(origin+(student?'/card-quiz/student.html':'/'));
  if(!student){await page.locator('#appShell:not(.hidden)').waitFor();await navigate(page,'card-quiz');if(canEdit)await page.locator('[data-cq-action=initialize]:not([disabled])').waitFor();else await page.locator('text=当前为只读权限').first().waitFor();}
  else await page.locator(authenticated?'#student-workspace:not([hidden])':'#loginForm:not(.hidden)').waitFor();
  return{state,page,context,origin,errors};
}
async function noOverflow(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No page-wide horizontal overflow');}
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
  await page.locator('#loginPassword').press('Enter');await page.locator('.student-record').first().waitFor();
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
  const{page,state}=await setup(t,{student:true,authenticated:true});await page.locator('.student-record').first().waitFor();
  state.reportError=true;await page.locator('#student-report-reload').click();await page.locator('#student-report-feedback.error').waitFor();
  assert.equal(await page.locator('.student-record').count(),8);assert.match(await page.locator('#student-report-feedback').innerText(),/上次成功读取/);
  state.reportError=false;await page.locator('#student-subject').selectOption('english');await page.getByText('暂无已结束课堂的作答记录。').waitFor();
  assert.match(await page.locator('#student-totals').innerText(),/暂无判定样本/);
  state.authenticated=false;await page.locator('#student-report-reload').click();await page.locator('#loginForm:not(.hidden)').waitFor();
  assert.match(await page.locator('#loginNotice').innerText(),/已失效/);assert.equal(await page.locator('.student-record').count(),0);
});

test('reload and focus reconcile the shared student session before showing another account report',async t=>{
  const{page,state}=await setup(t,{student:true,authenticated:true});await page.locator('.student-record').first().waitFor();
  await page.locator('#card-password').fill(password);await page.locator('#student-card-form button').click();await page.locator('.card-sheet').waitFor();
  state.student={...state.student,id:'account-s2',username:'26109157',cardNumber:157,csrfToken:'second-student-csrf'};
  state.report.records=[{...state.report.records[0],text:'第二位学生的课堂记录'}];
  await page.locator('#student-report-reload').click();await page.locator('.student-record-title').filter({hasText:'第二位学生的课堂记录'}).waitFor();
  assert.match(await page.locator('#student-identity').innerText(),/26109157/);
  assert.equal(await page.locator('.card-sheet').count(),0);
  state.student={...state.student,id:'account-s3',username:'2610903',cardNumber:3,csrfToken:'third-student-csrf'};
  state.report.records=[{...state.report.records[0],text:'第三位学生的课堂记录'}];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.locator('.student-record-title').filter({hasText:'第三位学生的课堂记录'}).waitFor();
  assert.match(await page.locator('#student-identity').innerText(),/2610903/);
  assert.doesNotMatch(await page.locator('#student-report').innerText(),/第二位学生的课堂记录/);
  state.student={...state.student,id:'account-s4',username:'2610904',cardNumber:4,csrfToken:'fourth-student-csrf'};
  state.report.records=[{...state.report.records[0],text:'筛选期间切换后的学生记录'}];
  await page.locator('#student-subject').selectOption('math');
  await page.locator('.student-record-title').filter({hasText:'筛选期间切换后的学生记录'}).waitFor();
  assert.match(await page.locator('#student-identity').innerText(),/2610904/);
});

test('focus during a delayed self-print request reconciles the account before exposing any paper-card password',async t=>{
  const{page,state}=await setup(t,{student:true,authenticated:true});await page.locator('.student-record').first().waitFor();
  let release;state.holdCard=new Promise(resolve=>release=resolve);
  const started=new Promise(resolve=>state.cardStarted=resolve);
  await page.locator('#card-password').fill(password);await page.locator('#student-card-form button').click();await started;
  try{
    state.student={...state.student,id:'account-s2',username:'26109157',cardNumber:157,csrfToken:'second-student-csrf'};
    state.report.records=[{...state.report.records[0],text:'等待纸卡期间已切换的学生'}];
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  }finally{release();}
  await page.waitForFunction(()=>document.querySelector('#student-main').getAttribute('aria-busy')==='false');
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

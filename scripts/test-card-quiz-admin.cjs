'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {open,navigate}=require('./test-teacher-ui.cjs');
let browser;
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();});
const copy=x=>JSON.parse(JSON.stringify(x));
const count={samples:1,correct:1,wrong:0,unanswered:1,exempt:0,ungraded:0,practice:0,accuracy:1};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
async function setup(t,width=1280){
  const q={id:'q1',revision:1,ownerId:'review-teacher',subjectId:'math',type:'single',text:'已有题目',imageId:null,options:['一','二','三','四'],answer:'A',tags:['集合']};
  const sq={...q,id:'sq1',bankId:'q1',bankVersion:1,revealed:false,rounds:[]};
  const fixture={className:'高一（9）班',studentsRevision:1,cards:{classId:'c1',revision:0,canEdit:true,students:[{id:'s1',name:'学生甲',cardNumber:null},{id:'s2',name:'学生乙',cardNumber:null}]},questions:[q],decks:[],publications:[],writes:[],conflict:false};
  const accounts=()=>({classId:'c1',className:fixture.className,revision:fixture.studentsRevision,rosterRevision:1,cardRevision:fixture.cards.revision,classCode:'109',canEdit:fixture.cards.canEdit,students:fixture.cards.students.map((s,i)=>({studentId:s.id,name:s.name,cardNumber:s.cardNumber,accountId:'account-'+s.id,username:'26109'+String(i+1).padStart(2,'0'),accountRevision:1,activeHere:true}))});
  fixture.detail={revision:1,session:{id:'session1',classId:'c1',subjectId:'math',startedAt:1794700000000,endedAt:1794700100000,teacherId:null,roster:[{id:'s1',name:'学生甲',cardNumber:1},{id:'s2',name:'学生乙',cardNumber:2}],questions:[sq]},report:{totals:count,students:[{studentId:'s1',studentName:'学生甲',...count}],questions:[{id:'sq1',text:sq.text,answer:'A',tags:['集合'],rounds:[{id:'r1',purpose:'formal',status:'closed',...count,students:[{studentId:'s1',studentName:'学生甲',option:'A',status:'correct'},{studentId:'s2',studentName:'学生乙',option:null,status:'unanswered'}]}]}]}};
  const result=await open(browser,{width,handle:async({url,request})=>{
    if(!url.pathname.startsWith('/api/card-quiz'))return;
    const relative=url.pathname.slice('/api/card-quiz'.length),method=request.method(),body=method==='GET'?null:request.postDataJSON();
    if(body)fixture.writes.push({path:relative,method,body});
    if(body&&fixture.holdSave){const hold=fixture.holdSave;fixture.holdSave=null;fixture.saveStarted?.();await hold;}
    if(relative.endsWith('/cards')){
      if(body){fixture.cards.revision++;fixture.cards.students.forEach((s,i)=>s.cardNumber=body.initialize?i+1:body.bindings.find(b=>b.studentId===s.id).cardNumber);}
      return{json:copy(fixture.cards)};
    }
    if(relative==='/classes/c1/students'&&method==='GET')return{json:accounts()};
    if(relative==='/classes/c1/students/reset'&&method==='POST'){
      fixture.studentsRevision++;
      const value=accounts();
      return{json:{...value,credentials:value.students.filter(s=>body.studentIds.includes(s.studentId)).map(s=>({accountId:s.accountId,username:s.username,password:'001234',classId:value.classId,className:value.className,studentId:s.studentId,cardNumber:s.cardNumber}))}};
    }
    if(relative==='/images'&&body)return{json:{id:'image1'}};
    if(relative.startsWith('/images/'))return{body:png,contentType:'image/png'};
    if(relative==='/questions'&&method==='GET')return fixture.readError?{status:503,json:{error:'隔离题库读取失败'}}:{json:{questions:copy(fixture.questions)}};
    if(relative.startsWith('/questions')&&body){
      if(fixture.conflict){fixture.conflict=false;return{status:409,json:{error:'题目版本冲突，请重新载入'}};}
      const id=relative.split('/')[2]||'q'+(fixture.questions.length+1),saved={...body.value,id,revision:(body.revision||0)+1};
      const i=fixture.questions.findIndex(q=>q.id===id);if(i<0)fixture.questions.push(saved);else fixture.questions[i]=saved;
      return{json:copy(saved)};
    }
    if(relative==='/decks'&&method==='GET')return{json:{decks:copy(fixture.decks)}};
    if(relative==='/decks'&&body){const d={...body,id:'deck1',revision:1};fixture.decks.push(d);return{json:d};}
    if(relative.endsWith('/publish')){const p={id:'publication1',classId:'c1',title:fixture.decks[0].title,questions:fixture.decks[0].questionIds.map(id=>copy(fixture.questions.find(q=>q.id===id)))};fixture.publications.push(p);return{json:p};}
    if(relative==='/classes/c1/publications')return{json:{publications:copy(fixture.publications)}};
    if(relative==='/publications/publication1'&&method==='DELETE'){fixture.publications=[];return{json:{ok:true}};}
    if(relative==='/report')return{json:{sessions:[{...fixture.detail.session,questionCount:1}],students:fixture.detail.report.students,knowledge:fixture.knowledge||[{subjectId:'math',tag:'集合',questionCount:1,answers:1,...count}]}};
    if(relative==='/sessions/session1'){
      if(body){fixture.detail.revision++;if(body.teacherId)fixture.detail.session.teacherId=body.teacherId;for(const q of body.questions||[]){Object.assign(fixture.detail.session.questions[0],q);Object.assign(fixture.detail.report.questions[0],q);}}
      return{json:copy(fixture.detail)};
    }
    if(relative==='/export')return{body:'学生,状态\n学生甲,正确',contentType:'text/csv'};
    return{status:404,json:{error:'隔离接口不存在 '+relative}};
  }});
  t.after(async()=>{await result.context.close();assert.deepEqual(result.errors,[],'no page errors');});
  await navigate(result.page,'card-quiz');await result.page.locator('[data-cq-action=initialize]:not([disabled])').waitFor();
  return{...result,fixture};
}
test('真实教师入口分配卡号，未保存离开保护，保存及单卡补印',async t=>{
  const{page,fixture}=await setup(t,390);
  await page.locator('[data-cq-action=initialize]').click();await page.locator('[data-card-student=s1]').waitFor();
  await page.locator('[data-card-student=s1]').fill('8');
  if(await page.locator('#menuToggle').isVisible())await page.locator('#menuToggle').click();
  await page.locator('#mainNav [data-view=history]').click();await page.locator('#workbenchConfirm[open] #workbenchConfirmCancel').click();
  assert.equal(await page.locator('[data-card-student=s1]').inputValue(),'8');
  if(await page.locator('#navBackdrop').isVisible())await page.keyboard.press('Escape');
  await page.locator('[data-cq-action=save-cards]').click();await page.waitForFunction(()=>document.querySelector('.cq-feedback').textContent.includes('已保存'));
  assert.equal(fixture.cards.students[0].cardNumber,8);
  const popupEvent=page.waitForEvent('popup');await page.locator('[data-cq-action=print-one]').first().click();const popup=await popupEvent;
  await popup.locator('#prepare:not([disabled])').click();await popup.locator('#confirm-reset').click();
  await popup.locator('#print:not([disabled])').waitFor();assert.equal(await popup.locator('.card-sheet').count(),1);assert.equal(await popup.locator('.card-sheet svg').count(),1);
  assert.match(popup.url(),/card=8/);await popup.emulateMedia({media:'print'});assert.ok(await popup.locator('.card-sheet').evaluate(el=>Math.abs(el.getBoundingClientRect().width-190*96/25.4)<1));
  await popup.close();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
});
test('文字图片题保存、版本冲突保留草稿，题单按序发布和撤回',async t=>{
  const{page,fixture}=await setup(t);
  const questionText=page.getByRole('textbox',{name:'题干',exact:true});
  await page.locator('[data-cq-tab=bank]').click();await page.locator('[data-cq-action=new-question]').click();
  await questionText.fill('新建图文题');await page.locator('[name=count]').selectOption('2');await page.locator('[name=answer]').selectOption('B');await page.locator('[name=tags]').fill('集合，函数');
  await page.locator('[name=image]').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:png});
  await page.locator('[data-cq-action=save-question]').click();await page.locator('[data-cq-action=new-question]').waitFor();
  assert.equal(fixture.questions[1].imageId,'image1');assert.equal(fixture.questions[1].answer,'B');assert.deepEqual(fixture.questions[1].tags,['集合','函数']);
  await page.locator('[data-cq-action=edit-question][data-id=q2]').click();await questionText.fill('未保存的冲突草稿');fixture.conflict=true;
  await page.locator('[data-cq-action=save-question]').click();await page.locator('.cq-feedback.cq-error').waitFor();assert.equal(await questionText.inputValue(),'未保存的冲突草稿');
  assert.equal(await page.locator('[data-cq-action=save-question]').isDisabled(),true);
  await page.locator('[data-cq-action=cancel-editor]').click();await page.locator('#workbenchConfirm[open] #workbenchConfirmAccept').click();
  await page.locator('[data-cq-tab=decks]').click();await page.locator('[data-cq-action=new-deck]').click();await page.locator('[name=title]').fill('复习题单');
  await page.locator('[data-deck-question=q1]').check();await page.locator('[data-deck-question=q2]').check();await page.locator('[data-cq-action=deck-up][data-index="1"]').click();
  await page.locator('[data-cq-action=save-deck]').click();await page.locator('[data-cq-action=publish]').click();await page.locator('#workbenchConfirm[open] #workbenchConfirmAccept').click();
  await page.locator('.cq-panel details.cq-item summary').click();await page.locator('[data-cq-action=withdraw]').waitFor();assert.deepEqual(fixture.decks[0].questionIds,['q2','q1']);assert.equal(fixture.publications[0].questions[0].text,'新建图文题');
  await page.locator('[data-cq-action=withdraw]').click();await page.locator('#workbenchConfirm[open] #workbenchConfirmAccept').click();await page.locator('[data-cq-action=withdraw]').waitFor({state:'hidden'});assert.equal(fixture.publications.length,0);
});
test('教师报告展示样本和未答，课后修订及本人认领、CSV下载',async t=>{
  const{page,fixture}=await setup(t,390);
  await page.locator('[data-cq-tab=reports]').click();await page.locator('[data-cq-action=open-session]').click();await page.locator('[data-cq-action=review-question]').click();
  await page.getByRole('textbox',{name:'题干',exact:true}).fill('课后补录题干');await page.locator('[name=answer]').selectOption('B');await page.locator('[name=tags]').fill('数与式');await page.locator('[data-cq-action=save-review]').click();
  await page.locator('[data-cq-action=claim]').click();await page.waitForFunction(()=>document.querySelector('.cq-feedback').textContent.includes('认领'));
  assert.equal(fixture.detail.session.teacherId,'review-teacher');assert.equal(fixture.detail.session.questions[0].text,'课后补录题干');
  await page.locator('.cq-round summary').click();assert.match(await page.locator('#cardQuizRoot').innerText(),/未答/);
  await page.locator('[data-cq-action=close-detail]').click();await page.locator('[data-cq-action=export]').waitFor();const downloadEvent=page.waitForEvent('download');await page.locator('[data-cq-action=export]').click();assert.match((await downloadEvent).suggestedFilename(),/\.csv$/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>document.activeElement!==document.body));
});

test('保存期间锁住完整题目草稿，延迟成功响应不吞掉后续输入',async t=>{
  const{page,fixture}=await setup(t);await page.locator('[data-cq-tab=bank]').click();await page.locator('[data-cq-action=edit-question]').click();
  const questionText=page.getByRole('textbox',{name:'题干',exact:true});
  await questionText.fill('已提交版本');let release;fixture.holdSave=new Promise(resolve=>release=resolve);const started=new Promise(resolve=>fixture.saveStarted=resolve);
  await page.locator('[data-cq-action=save-question]').click();await started;
  try{
    assert.equal(await page.locator('.cq-form input:not([disabled]),.cq-form textarea:not([disabled]),.cq-form select:not([disabled])').count(),0);
    await page.keyboard.type('保存途中新内容');assert.equal(await questionText.inputValue(),'已提交版本');
  }finally{release();}
  await page.locator('[data-cq-action=new-question]').waitFor();assert.equal(fixture.questions[0].text,'已提交版本');
});

test('重新载入失败保留错误和旧数据，不报成功',async t=>{
  const{page,fixture}=await setup(t);await page.locator('[data-cq-tab=bank]').click();await page.locator('[data-cq-action=edit-question]').waitFor();
  fixture.readError=true;await page.locator('[data-cq-action=reload]').click();await page.locator('.cq-feedback.cq-error').waitFor();
  assert.equal(await page.locator('.cq-feedback').innerText(),'隔离题库读取失败');assert.equal(await page.locator('.cq-feedback').getAttribute('role'),'alert');
  assert.match(await page.locator('#cardQuizRoot').innerText(),/已有题目/);
});

test('报告显示图题选项快照和准确的匿名分布及未答',async t=>{
  const{page,fixture}=await setup(t,390);const q=fixture.detail.session.questions[0];q.text='';q.imageId='image1';q.options=['图中方案甲','图中方案乙'];fixture.detail.report.questions[0].text='';
  await page.locator('[data-cq-tab=reports]').click();await page.locator('[data-cq-action=open-session]').click();await page.locator('.cq-round summary').waitFor();
  assert.equal(await page.locator('#cardQuizRoot img[src="/api/card-quiz/images/image1"]').count(),1);assert.match(await page.locator('#cardQuizRoot').innerText(),/图中方案甲/);
  await page.locator('.cq-round summary').click();const rows=await page.locator('[aria-label="本轮匿名选项分布"] tbody tr').allTextContents();
  assert.deepEqual(rows,['A图中方案甲1100.0%','B图中方案乙00.0%','未答1']);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
});

test('键盘连续调整题单顺序后焦点跟随移动题目',async t=>{
  const{page,fixture}=await setup(t,390);fixture.questions.push({...fixture.questions[0],id:'q2',text:'第二题'},{...fixture.questions[0],id:'q3',text:'第三题'});
  await page.locator('[data-cq-tab=decks]').click();await page.locator('[data-cq-action=new-deck]').click();await page.locator('[name=title]').fill('键盘题单');
  for(const id of ['q1','q2','q3'])await page.locator(`[data-deck-question=${id}]`).check();
  await page.locator('[data-cq-action=deck-up][data-index="2"]').focus();await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>[document.activeElement.dataset.cqAction,document.activeElement.dataset.index]),['deck-up','1']);
  await page.keyboard.press('Enter');assert.deepEqual(await page.evaluate(()=>[document.activeElement.dataset.cqAction,document.activeElement.dataset.index]),['deck-down','0']);
  await page.locator('[data-cq-action=save-deck]').click();await page.locator('[data-cq-action=publish]').waitFor();assert.deepEqual(fixture.decks[0].questionIds,['q3','q1','q2']);
});

test('三种题型提供真实多选复选框，键盘选择按 ABCD 顺序保存，空标准答案保存 null',async t=>{
  const{page,fixture}=await setup(t,390);
  await page.locator('[data-cq-tab=bank]').click();await page.locator('[data-cq-action=new-question]').click();
  assert.deepEqual(await page.locator('[name=type] option').evaluateAll(nodes=>nodes.map(n=>n.value)),['single','boolean','multiple']);
  await page.getByRole('textbox',{name:'题干',exact:true}).fill('多选题');await page.locator('[name=type]').selectOption('multiple');
  const answers=page.locator('fieldset.cq-answer-set input[type=checkbox][name=answer]');assert.equal(await answers.count(),4);
  await answers.nth(2).focus();await page.keyboard.press('Space');await answers.nth(0).check();
  assert.equal(await answers.nth(2).isChecked(),true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.locator('[data-cq-action=save-question]').click();await page.locator('[data-cq-action=new-question]').waitFor();
  assert.equal(fixture.questions[1].type,'multiple');assert.equal(fixture.questions[1].answer,'AC');
  assert.match(await page.locator('[data-cq-tab=bank]').evaluate(el=>el.closest('#cardQuizRoot').innerText),/多选/);
  await page.locator('[data-cq-action=edit-question][data-id=q2]').click();
  assert.deepEqual(await page.locator('[name=answer]:checked').evaluateAll(nodes=>nodes.map(n=>n.value)),['A','C']);
  for(const value of ['A','C'])await page.locator(`[name=answer][value=${value}]`).uncheck();
  await page.locator('[data-cq-action=save-question]').click();await page.locator('[data-cq-action=new-question]').waitFor();
  assert.equal(fixture.questions[1].answer,null);
});

test('缩减选项保留有效多选答案，切换单选判断不留下非法组合，焦点随题型控件保留',async t=>{
  const{page,fixture}=await setup(t);Object.assign(fixture.questions[0],{type:'multiple',answer:'AD'});
  await page.locator('[data-cq-tab=bank]').click();await page.locator('[data-cq-action=edit-question]').click();
  assert.equal(await page.locator('[name=answer][type=checkbox]').count(),4);
  await page.locator('[name=count]').selectOption('2');
  assert.deepEqual(await page.locator('[name=answer]:checked').evaluateAll(nodes=>nodes.map(n=>n.value)),['A']);
  await page.locator('[name=answer][value=B]').check();await page.locator('[name=type]').selectOption('single');
  assert.equal(await page.locator('select[name=answer]').inputValue(),'');
  assert.equal(await page.evaluate(()=>document.activeElement.name),'type');
  await page.locator('[name=answer]').selectOption('B');await page.locator('[name=type]').selectOption('boolean');
  assert.equal(await page.locator('[name=count]').isDisabled(),true);
  assert.deepEqual(await page.locator('[name^=option-]').evaluateAll(nodes=>nodes.map(n=>n.value)),['正确','错误']);
  await page.locator('[data-cq-action=save-question]').click();await page.locator('[data-cq-action=new-question]').waitFor();
  assert.equal(fixture.questions[0].type,'boolean');assert.equal(fixture.questions[0].answer,'B');
});

test('多选报告区分完整空选择、未完成和未答，分布只统计完整作答，修订保存规范字符串',async t=>{
  const{page,fixture}=await setup(t,390),q=fixture.detail.session.questions[0],rq=fixture.detail.report.questions[0];
  Object.assign(q,{type:'multiple',answer:'AC'});rq.answer='AC';
  const all={A:false,B:false,C:false,D:false},students=[
    {studentName:'全对',option:'AC',choices:{...all,A:true,C:true},status:'correct'},
    {studentName:'少选',option:'A',choices:{...all,A:true},status:'wrong'},
    {studentName:'多选',option:'ABC',choices:{...all,A:true,B:true,C:true},status:'wrong'},
    {studentName:'全不选',option:'',choices:all,status:'wrong'},
    {studentName:'部分作答',option:'A',choices:{A:true,B:false},status:'incomplete'},
    {studentName:'完全未答',option:null,status:'unanswered'},
    {studentName:'免答学生',option:'A',choices:{A:true},status:'exempt'}
  ];
  fixture.detail.session.roster=students.map((s,i)=>({id:'s'+i,name:s.studentName,cardNumber:i+1}));
  Object.assign(rq.rounds[0],{students,correct:1,wrong:3,incomplete:1,unanswered:1,exempt:1,ungraded:0});
  await page.locator('[data-cq-tab=reports]').click();await page.locator('[data-cq-action=open-session]').click();await page.locator('.cq-round summary').click();
  const rows=await page.locator('[aria-label="本轮匿名选项分布"] tbody tr').allTextContents();
  assert.deepEqual(rows,['A一375.0%','B二125.0%','C三250.0%','D四00.0%','未完成1','未答1']);
  const text=await page.locator('.cq-round').innerText();assert.match(text,/参与 4\/6/);assert.match(text,/25\.0%/);
  const detailRows=await page.locator('[aria-label="本题作答明细"] tbody tr').allTextContents();
  assert.match(detailRows[3],/全不选.*全不选.*错误/);
  assert.match(detailRows[4],/A 选.*B 不选.*C 未答.*D 未答.*未完成/);
  assert.match(detailRows[5],/完全未答.*未答.*未答/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.locator('[data-cq-action=review-question]').click();
  assert.deepEqual(await page.locator('[name=answer]:checked').evaluateAll(nodes=>nodes.map(n=>n.value)),['A','C']);
  await page.locator('[name=answer][value=A]').uncheck();await page.locator('[name=answer][value=D]').check();
  await page.locator('[data-cq-action=save-review]').click();await page.locator('[data-cq-action=review-question]').waitFor();
  assert.equal(fixture.detail.session.questions[0].answer,'CD');
  assert.equal(fixture.writes.at(-1).body.questions[0].answer,'CD');
});

test('未设标准答案及练习多选的有效空选择仍计完成，部分作答不进入选项分布',async t=>{
  const{page,fixture}=await setup(t);const q=fixture.detail.session.questions[0],rq=fixture.detail.report.questions[0];
  Object.assign(q,{type:'multiple',options:['一','二'],answer:null});rq.answer=null;
  const students=[{studentName:'空选择',option:'',choices:{A:false,B:false},status:'practice'},{studentName:'未收齐',option:'A',choices:{A:true},status:'incomplete'}];
  rq.rounds=[{...rq.rounds[0],purpose:'practice',correct:0,wrong:0,ungraded:0,practice:1,incomplete:1,unanswered:0,students}];
  await page.locator('[data-cq-tab=reports]').click();await page.locator('[data-cq-action=open-session]').click();await page.locator('.cq-round summary').click();
  assert.match(await page.locator('.cq-round').innerText(),/参与 1\/2/);
  assert.deepEqual(await page.locator('[aria-label="本轮匿名选项分布"] tbody tr').allTextContents(),['A一00.0%','B二00.0%','未完成1','未答0']);
});

test('学生、知识点与本课汇总保留服务端未完成数，不混入错误或正确率',async t=>{
  const{page,fixture}=await setup(t,390),totals={samples:4,correct:1,wrong:3,incomplete:2,unanswered:1,exempt:0,ungraded:0,practice:0,accuracy:.25};
  fixture.detail.report.totals=totals;fixture.detail.report.students=[{studentName:'学生甲',...totals}];
  fixture.knowledge=[{subjectId:'math',tag:'集合',questionCount:1,answers:7,...totals}];
  await page.locator('[data-cq-tab=reports]').click();await page.locator('[data-cq-action=open-session]').waitFor();
  assert.deepEqual(await page.locator('[aria-label="学生统计"] tbody tr').first().locator('td').allTextContents(),['学生甲','4','1','3','2','1','0','0','0','25.0%']);
  assert.deepEqual(await page.locator('[aria-label="知识点样本与正确率"] tbody tr').first().locator('td').allTextContents(),['数学','集合','1','7','4','1','3','2','25.0%']);
  await page.locator('[data-cq-action=open-session]').click();
  const incomplete = page.locator('.cq-summary .wb-metric').filter({has:page.getByText('未完成',{exact:true})});
  assert.equal(await incomplete.locator('strong').innerText(),'2');
});

test('A4 纸卡实际黑色检测方块为 140-150 mm，长班级保持单页，印账号密码和说明而不印姓名',async t=>{
  const{page,context,fixture}=await setup(t,390);
  fixture.cards.students=[{id:'s1',name:'很长的复姓学生姓名'.repeat(6),cardNumber:1},{id:'s2',name:'学生乙',cardNumber:157}];
  fixture.className='高一年级国际课程实验班'.repeat(8);
  const popup=await context.newPage();await popup.goto('http://127.0.0.1/card-quiz/print.html?classId=c1');
  await popup.locator('#prepare:not([disabled])').click();await popup.locator('#confirm-reset').click();await popup.locator('#print:not([disabled])').waitFor();
  assert.ok(await popup.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await popup.emulateMedia({media:'print'});
  const dimensions=await popup.locator('.card-sheet').evaluateAll(nodes=>nodes.map(sheet=>{
    const svg=sheet.querySelector('svg'),black=svg.querySelector('g[shape-rendering="crispEdges"]').getBBox(),box=sheet.getBoundingClientRect();
    return{blackMm:black.width/svg.viewBox.baseVal.width*svg.getBoundingClientRect().width*25.4/96,heightMm:box.height*25.4/96,overflow:sheet.scrollHeight-sheet.clientHeight,caption:sheet.innerText,labels:[...svg.querySelectorAll('text')].map(n=>n.textContent)};
  }));
  assert.equal(dimensions.length,2);
  for(const d of dimensions){assert.ok(d.blackMm>=140&&d.blackMm<=150,JSON.stringify(d));assert.ok(d.heightMm<=277&&d.overflow<=1,JSON.stringify(d));assert.doesNotMatch(d.caption,/ice-v1|姓名|学生乙|很长的复姓学生/);for(const field of ['班级','编号','卡号','密码','001234'])assert.ok(d.caption.includes(field),field);assert.match(d.caption,/朝上/);assert.deepEqual(d.labels.slice(0,4),['A','B','C','D']);}
  const pdf=await popup.pdf({preferCSSPageSize:true});assert.equal([...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length,2,'one A4 page per student');
  await popup.close();
});

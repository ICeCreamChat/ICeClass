const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const Model=require('../web_controller/card-quiz/model.js');
const context={classId:'class-1',deviceId:'device-1',students:[{id:'s1',name:'甲',cardNumber:1},{id:'s2',name:'乙',cardNumber:2}]};
let clock=1000;
function send(session,action,payload={}){
  return Model.apply(session,{id:crypto.randomUUID(),sessionId:session.id,questionId:session.currentQuestionId,roundId:session.currentRoundId,generation:session.generation,sourceId:session.sourceId,action,payload},++clock);
}
function opened(){let s=Model.createSession(context,'math',clock);s=send(s,'add_question',{type:'single',options:['','','','']});return send(s,'start_round');}

test('题目上限按Unicode码点与服务端一致，数学字符不提前截断且拒绝无效代理字符',()=>{
  const initial=Model.createSession(context,'math',clock),symbol='𝑥';
  const value={type:'single',text:symbol.repeat(20000),options:[symbol.repeat(2000),'乙'],tags:[symbol.repeat(80)]};
  const accepted=send(initial,'add_question',value);assert.equal(accepted.questions[0].text,value.text);
  for(const patch of [{text:symbol.repeat(20001)},{options:[symbol.repeat(2001),'乙']},{tags:[symbol.repeat(81)]},{text:'\ud800'},{tags:['\udc00']}])assert.throws(()=>send(initial,'add_question',{...value,...patch}));
});

test('课堂只使用稳定身份与固定卡号，创建和操作不修改输入',()=>{
  const s=Model.createSession(context,'math',clock),before=JSON.stringify(s);
  const next=send(s,'add_question',{type:'boolean'});
  assert.equal(JSON.stringify(s),before);assert.equal(next.questions[0].options.length,2);
  assert.equal(next.roster[0].id,'s1');assert.equal(next.seq,1);
  assert.throws(()=>Model.createSession({...context,students:[context.students[0],{...context.students[1],cardNumber:1}]},'math',clock));
});
test('收答中改答，消失不撤销，结束后拒绝迟到与旧轮次答案',()=>{
  let s=opened();s=send(s,'answer',{cardNumber:1,option:'A'});s=send(s,'answer',{cardNumber:1,option:'B'});
  const r=s.questions[0].rounds[0];assert.equal(r.answers.s1.option,'B');assert.equal(Model.roundSummary(s,r).received,1);
  s=send(s,'end_round');assert.throws(()=>send(s,'answer',{cardNumber:1,option:'C'}));
  const old=r.id;s=send(s,'start_round');
  assert.throws(()=>Model.apply(s,{id:crypto.randomUUID(),sessionId:s.id,questionId:s.currentQuestionId,roundId:old,generation:s.generation,sourceId:s.sourceId,action:'answer',payload:{cardNumber:2,option:'A'}},clock));
});
test('未设置答案不计算正确率，未答不算错，免答排除分母且保留原选项',()=>{
  let s=opened();s=send(s,'answer',{cardNumber:1,option:'A'});
  let r=s.questions[0].rounds[0],summary=Model.roundSummary(s,r);
  assert.equal(summary.expected,2);assert.equal(summary.received,1);assert.equal(summary.correct,null);assert.equal(summary.unanswered,1);
  s=send(s,'set_exempt',{studentId:'s1',exempt:true});r=s.questions[0].rounds[0];summary=Model.roundSummary(s,r);
  assert.equal(summary.expected,1);assert.equal(summary.received,0);assert.equal(r.answers.s1.option,'A');
  s=send(s,'set_exempt',{studentId:'s1',exempt:false});assert.equal(Model.roundSummary(s,s.questions[0].rounds[0]).received,1);
});
test('封存后不能新增或恢复免答，拒绝不改序号、原答案和正式统计',()=>{
  for(const exempt of [false,true]){
    let s=opened();s=send(s,'answer',{cardNumber:1,option:'B'});
    if(exempt)s=send(s,'set_exempt',{studentId:'s1',exempt:true});
    s=send(s,'end_round');const before=structuredClone(s),summary=Model.roundSummary(s,Model.officialRound(s.questions[0]));
    assert.throws(()=>send(s,'set_exempt',{studentId:'s1',exempt:!exempt}),/结束|封存/);
    assert.deepEqual(s,before);assert.deepEqual(Model.roundSummary(s,Model.officialRound(s.questions[0])),summary);
  }
});
test('教师发布题单按服务端题干、选项和标签上限完整导入并可修订',()=>{
  const value={type:'single',text:'题'.repeat(20000),options:['甲'.repeat(2000),'乙'.repeat(2000)],tags:Array.from({length:50},(_,i)=>String(i).padStart(2,'0')+'标'.repeat(78)),answer:'B'};
  const initial=Model.createSession(context,'math',clock),s=send(initial,'add_question',value);
  for(const key of ['text','options','tags','answer'])assert.deepEqual(s.questions[0][key],value[key]);
  const edited=send(s,'edit_question',{...value,text:'文'.repeat(20000),revision:1});
  assert.equal(edited.questions[0].text.length,20000);assert.equal(edited.questions[0].revision,2);
});
test('超过服务端单项或列表上限的题目明确拒绝且不改变课堂',()=>{
  const s=Model.createSession(context,'math',clock),before=structuredClone(s);
  for(const value of [{text:'题'.repeat(20001)},{options:['甲'.repeat(2001),'乙']},{tags:Array.from({length:51},(_,i)=>'标签'+i)},{tags:['标'.repeat(81)]}]){
    assert.throws(()=>send(s,'add_question',{type:'single',...value}));assert.deepEqual(s,before);
  }
});
test('判断题拒绝 C/D、未知卡，收答后可补标准答案',()=>{
  let s=Model.createSession(context,'math',clock);s=send(s,'add_question',{type:'boolean'});s=send(s,'start_round');
  assert.throws(()=>send(s,'answer',{cardNumber:1,option:'C'}));assert.throws(()=>send(s,'answer',{cardNumber:3,option:'A'}));
  s=send(s,'answer',{cardNumber:1,option:'B'});s=send(s,'end_round');
  s=send(s,'edit_question',{answer:'B',tags:['判断'],revision:s.questions[0].revision});
  assert.equal(Model.roundSummary(s,s.questions[0].rounds[0]).correct,1);
});
test('手机未提供 revision 时可按最新 expectedSeq 部分更新本场题目',()=>{
  let s=opened();s=send(s,'end_round');const before=structuredClone(s.questions[0]);
  s=send(s,'edit_question',{expectedSeq:s.seq,answer:'B'});
  assert.equal(s.questions[0].answer,'B');assert.equal(s.questions[0].revision,2);
  s=send(s,'edit_question',{expectedSeq:s.seq,text:'手机补录题干',tags:['本场']});
  assert.equal(s.questions[0].text,'手机补录题干');assert.deepEqual(s.questions[0].tags,['本场']);
  assert.equal(s.questions[0].answer,'B');assert.equal(s.questions[0].revision,3);
  assert.equal(s.questions[0].type,before.type);assert.deepEqual(s.questions[0].options,before.options);assert.deepEqual(s.questions[0].rounds,before.rounds);
});
test('手机旧 expectedSeq、缺少版本及显式错误 revision 拒绝且不改状态',()=>{
  let s=opened();s=send(s,'end_round');const oldSeq=s.seq;
  s=send(s,'edit_question',{revision:1,answer:'A'});const before=structuredClone(s);
  for(const payload of [{expectedSeq:oldSeq,answer:'B'},{text:'没有版本'},{revision:1,expectedSeq:s.seq,answer:'B'},{revision:null,expectedSeq:s.seq,answer:'B'}]){
    assert.throws(()=>send(s,'edit_question',payload),/变化|重新载入/);assert.deepEqual(s,before);
  }
  const revised=send(s,'edit_question',{revision:2,expectedSeq:oldSeq,text:'白板按 revision 修订'});
  assert.equal(revised.questions[0].revision,3);assert.equal(revised.questions[0].text,'白板按 revision 修订');
});
test('手机最新 expectedSeq 也不能在正在收答时修改题目',()=>{
  const s=opened(),before=structuredClone(s);
  assert.throws(()=>send(s,'edit_question',{expectedSeq:s.seq,answer:'A'}),/结束/);assert.deepEqual(s,before);
});
test('换来源只在轮次间；重启恢复使旧来源代次失效',()=>{
  let s=opened();assert.throws(()=>send(s,'set_source',{source:'phone',sourceId:'pair-1'}));
  s=send(s,'end_round');const old=s.generation;s=send(s,'set_source',{source:'phone',sourceId:'pair-1'});assert.ok(s.generation>old);
  s=send(s,'start_round');const restored=Model.recover(s,++clock);
  assert.equal(restored.questions[0].rounds[1].status,'paused');assert.ok(restored.generation>s.generation);
  assert.throws(()=>send(restored,'answer',{cardNumber:1,option:'A'}));
  const resumed=send(restored,'resume_round');assert.equal(resumed.questions[0].rounds[1].status,'collecting');
});
test('最近正式封存轮次不回填旧作答，揭晓后重答为练习',()=>{
  let s=opened();s=send(s,'answer',{cardNumber:1,option:'A'});s=send(s,'end_round');s=send(s,'start_round');s=send(s,'end_round');
  assert.equal(Model.officialRound(s.questions[0]).id,s.questions[0].rounds[1].id);
  assert.equal(Model.roundSummary(s,Model.officialRound(s.questions[0])).received,0);
  s=send(s,'edit_question',{answer:'A',revision:s.questions[0].revision});s=send(s,'reveal');s=send(s,'start_round');
  assert.equal(s.questions[0].rounds[2].purpose,'practice');
  s=send(s,'end_round');assert.equal(Model.officialRound(s.questions[0]).id,s.questions[0].rounds[1].id);
});
test('手机公开状态不含个人答案、名单或标准答案',()=>{
  let s=opened();s=send(s,'answer',{cardNumber:1,option:'D'});
  const p=Model.publicState(s,'测试班');assert.equal(p.received,1);assert.equal(p.expected,2);
  for(const key of ['answers','roster','answer','students','questions'])assert.equal(Object.hasOwn(p,key),false);
});
test('有作答后禁止更改题型和有效选项，封课后禁止继续写入',()=>{
  let s=opened();s=send(s,'answer',{cardNumber:1,option:'A'});s=send(s,'end_round');
  assert.throws(()=>send(s,'edit_question',{type:'boolean',revision:s.questions[0].revision}));
  s=send(s,'end_session');assert.throws(()=>send(s,'add_question',{type:'single'}));
});

test('关联题库快照的题型和选项在本机也保持原版本，题干答案标签仍可修订',()=>{
  let s=Model.createSession(context,'math',clock);s=send(s,'add_question',{type:'single',bankId:'bank-fixed',bankVersion:1,options:['甲','乙']});
  const before=structuredClone(s);
  for(const patch of [{type:'boolean'},{options:['新甲','乙']},{options:['甲','乙','丙']}]){
    assert.throws(()=>send(s,'edit_question',{revision:1,...patch}),/题库|快照/);assert.deepEqual(s,before);
  }
  s=send(s,'edit_question',{revision:1,text:'本场补录',answer:'B',tags:['本场标签']});
  assert.equal(s.questions[0].bankId,'bank-fixed');assert.equal(s.questions[0].bankVersion,1);assert.equal(s.questions[0].answer,'B');
});
function multiple(options=['甲','乙','丙','丁'],answer='AC',students=context.students){
  let s=Model.createSession({...context,students},'math',clock);
  s=send(s,'add_question',{type:'multiple',options,answer});return send(s,'start_round');
}
test('多选逐项确认只在全部有效项作答后计入整题人数，规范选择集合',()=>{
  let s=multiple();assert.equal(Model.activeRound(s).activeOption,'A');
  s=send(s,'answer',{cardNumber:1,option:'A',targetOption:'A'});
  let r=Model.activeRound(s),summary=Model.roundSummary(s,r);
  assert.deepEqual(r.answers.s1.choices,{A:true});assert.equal(r.answers.s1.option,'A');
  assert.equal(summary.received,0);assert.equal(summary.incomplete,1);assert.equal(summary.unanswered,1);
  assert.deepEqual(summary.distribution,{A:0,B:0,C:0,D:0});
  assert.equal(Model.publicState(s).optionReceived,1);assert.equal(Model.publicState(s).activeOption,'A');
  for(const [targetOption,option]of [['B','B'],['C','A'],['D','B']]){
    s=send(s,'set_multi_option',{option:targetOption});s=send(s,'answer',{cardNumber:1,option,targetOption});
  }
  r=Model.activeRound(s);summary=Model.roundSummary(s,r);
  assert.equal(r.answers.s1.option,'AC');assert.deepEqual(r.answers.s1.choices,{A:true,B:false,C:true,D:false});
  assert.equal(summary.received,1);assert.equal(summary.correct,1);assert.equal(summary.incomplete,0);assert.equal(summary.unanswered,1);
  assert.deepEqual(summary.distribution,{A:1,B:0,C:1,D:0});
  s=send(s,'set_multi_option',{option:'C'});s=send(s,'answer',{cardNumber:1,option:'B',targetOption:'C'});
  assert.equal(Model.activeRound(s).answers.s1.option,'A');assert.equal(Model.roundSummary(s,Model.activeRound(s)).correct,0);
});
test('多选换项切换代次，旧项迟到、无目标和无效朝向都拒绝且保留原选择',()=>{
  let s=multiple(),old=structuredClone(s);s=send(s,'set_multi_option',{option:'B'});
  assert.equal(s.generation,old.generation+1);assert.equal(Model.activeRound(s).generation,s.generation);
  assert.throws(()=>Model.apply(s,{id:crypto.randomUUID(),sessionId:s.id,questionId:s.currentQuestionId,roundId:s.currentRoundId,generation:old.generation,sourceId:s.sourceId,action:'answer',payload:{cardNumber:1,option:'A',targetOption:'A'}},clock));
  for(const p of [{cardNumber:1,option:'A',targetOption:'A'},{cardNumber:1,option:'A'},{cardNumber:1,option:'C',targetOption:'B'},{cardNumber:1,option:'D',targetOption:'B'}])assert.throws(()=>send(s,'answer',p));
  assert.deepEqual(Model.activeRound(s).answers,{});
  for(const option of ['E','',null,1])assert.throws(()=>send(s,'set_multi_option',{option}));
  s=send(s,'end_round');assert.throws(()=>send(s,'set_multi_option',{option:'C'}));
  assert.throws(()=>send(opened(),'set_multi_option',{option:'B'}));
});
test('多选全不选是完整作答，部分作答和免答分别统计，恢复不丢项',()=>{
  const students=[...context.students,{id:'s3',name:'丙',cardNumber:3},{id:'s4',name:'丁',cardNumber:4}];
  let s=multiple(['甲','乙'],'AB',students);
  for(const cardNumber of [1,2,3])s=send(s,'answer',{cardNumber,option:'B',targetOption:'A'});
  s=send(s,'set_multi_option',{option:'B'});s=send(s,'answer',{cardNumber:1,option:'B',targetOption:'B'});
  s=send(s,'set_exempt',{studentId:'s3',exempt:true});
  let summary=Model.roundSummary(s,Model.activeRound(s));
  assert.equal(Model.activeRound(s).answers.s1.option,'');assert.deepEqual(Model.activeRound(s).answers.s1.choices,{A:false,B:false});
  assert.equal(summary.expected,3);assert.equal(summary.received,1);assert.equal(summary.correct,0);assert.equal(summary.incomplete,1);assert.equal(summary.unanswered,1);
  assert.equal(Model.publicState(s).optionReceived,1);
  const choices=structuredClone(Model.activeRound(s).answers);s=Model.recover(s,++clock);
  assert.deepEqual(Model.activeRound(s).answers,choices);assert.equal(Model.activeRound(s).activeOption,'B');
  assert.throws(()=>send(s,'set_multi_option',{option:'A'}));s=send(s,'resume_round');
  s=send(s,'answer',{cardNumber:2,option:'A',targetOption:'B'});s=send(s,'end_round');
  assert.equal(Model.roundSummary(s,Model.activeRound(s)).received,2);
  const before=structuredClone(s);assert.throws(()=>send(s,'answer',{cardNumber:2,option:'B',targetOption:'B'}));assert.deepEqual(s,before);
});
test('三种题型独立校验，只有多选规范答案组合，旧单选轮次不增加多选字段',()=>{
  let initial=Model.createSession(context,'math',clock);
  let s=send(initial,'add_question',{type:'multiple',answer:'CA'});assert.equal(s.questions[0].answer,'AC');
  for(const answer of ['AA','AE','',true,['A','C']])assert.throws(()=>send(initial,'add_question',{type:'multiple',answer}));
  assert.throws(()=>send(initial,'add_question',{type:'single',answer:'AC'}));
  s=opened();assert.equal(Object.hasOwn(Model.activeRound(s),'activeOption'),false);
  s=send(s,'answer',{cardNumber:1,option:'A'});assert.equal(Object.hasOwn(Model.activeRound(s).answers.s1,'choices'),false);
  assert.equal(Object.hasOwn(Model.publicState(s),'activeOption'),false);
  s=multiple();const p=Model.publicState(s);for(const k of ['choices','answers','answer','roster'])assert.equal(Object.hasOwn(p,k),false);
});
test('空白轮次禁止涉及多选的结构修改，保留单选判断旧行为及封存记录',()=>{
  for(const type of ['single','boolean','multiple']){
    let s=send(Model.createSession(context,'math',clock),'add_question',{type,answer:'A'});
    const editable=send(s,'edit_question',{revision:1,type:type==='multiple'?'single':'multiple',options:['甲','乙'],answer:'A'});
    assert.equal(editable.questions[0].rounds.length,0);
    s=send(send(s,'start_round'),'end_round');const sealed=structuredClone(s.questions[0].rounds),before=structuredClone(s);
    for(const next of ['single','boolean','multiple'].filter(next=>next!==type)){
      if(type==='multiple'||next==='multiple')assert.throws(()=>send(s,'edit_question',{revision:1,type:next,answer:'A'}),/轮次|新建/);
      else assert.deepEqual(send(s,'edit_question',{revision:1,type:next,answer:'A'}).questions[0].rounds,sealed);
      assert.deepEqual(s,before);
    }
    if(type==='multiple')assert.throws(()=>send(s,'edit_question',{revision:1,options:['甲','乙'],answer:'A'}),/轮次|新建/);
    if(type==='single')assert.deepEqual(send(s,'edit_question',{revision:1,options:['甲','乙'],answer:'A'}).questions[0].rounds,sealed);
    s=send(s,'edit_question',{revision:1,text:'补录题干',answer:'B',tags:['复核']});
    assert.deepEqual(s.questions[0].rounds,sealed);assert.equal(s.questions[0].answer,'B');
  }
});
module.exports={send,opened};

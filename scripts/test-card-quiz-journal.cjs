const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const M=require('../web_controller/card-quiz/model.js');
const J=require('../web_controller/card-quiz/journal.js');
function context(){return M.createSession({classId:'c1',deviceId:'d1',students:[{id:'s1',name:'甲',cardNumber:1}]},'math',1000);}
function command(s,action,payload={}){return{id:crypto.randomUUID(),sessionId:s.id,questionId:s.currentQuestionId,roundId:s.currentRoundId,generation:s.generation,sourceId:s.sourceId,action,payload};}

test('多选切项与答案顺序落盘，恢复保留分项，旧候选拒绝且重试返回原回执',async()=>{
  let durable=J.create(context());const c=new J.Controller(durable,async j=>{durable=structuredClone(j);return durable;});
  await c.dispatch(command(c.session,'add_question',{type:'multiple',options:['甲','乙'],answer:'AB'}));await c.dispatch(command(c.session,'start_round'));
  await c.dispatch(command(c.session,'answer',{cardNumber:1,option:'A',targetOption:'A'}));
  const old=command(c.session,'answer',{cardNumber:1,option:'B',targetOption:'A'}),switchItem=command(c.session,'set_multi_option',{option:'B'});
  const outcomes=await Promise.allSettled([c.dispatch(switchItem),c.dispatch(old)]);assert.deepEqual(outcomes.map(x=>x.status),['fulfilled','rejected']);
  assert.equal(durable.session.questions[0].rounds[0].answers.s1.option,'A');assert.deepEqual(await c.dispatch(switchItem),outcomes[0].value);
  const restored=new J.Controller(durable,async j=>structuredClone(j));await restored.dispatch(command(restored.session,'recover'));await restored.dispatch(command(restored.session,'resume_round'));
  await restored.dispatch(command(restored.session,'answer',{cardNumber:1,option:'B',targetOption:'B'}));
  assert.deepEqual(restored.session.questions[0].rounds[0].answers.s1.choices,{A:true,B:false});assert.equal(M.publicState(restored.session).received,1);
});

test('题目信息合计超过既有64KiB事件上限时先拒绝，不能落盘后才无法同步',async()=>{
  let writes=0;const c=new J.Controller(J.create(context()),async journal=>{writes++;return structuredClone(journal);});
  const value={type:'single',text:'中'.repeat(20000),options:['甲'.repeat(2000),'乙'.repeat(2000)]};
  assert.ok(Buffer.byteLength(J.canonical(value))>64*1024);
  await assert.rejects(c.dispatch(command(c.session,'add_question',value)),/合计|总量/);
  assert.equal(writes,0);assert.equal(c.session.seq,0);assert.equal(c.pending,null);
  value.options=['甲'.repeat(800),'乙'.repeat(800)];assert.ok(Buffer.byteLength(J.canonical(value))<=64*1024);
  const result=await c.dispatch(command(c.session,'add_question',value));assert.equal(result.status,'confirmed');assert.equal(writes,1);
});

test('缺失或错误类型的保存回执不能替代落盘证明，仍可重试原提案',async()=>{
  for(const missing of [null,undefined,false,0,'']){
    const proposals=[];let valid=false;
    const control=new J.Controller(J.create(context()),async proposal=>{proposals.push(structuredClone(proposal));return valid?structuredClone(proposal):missing;});
    const cmd=command(control.session,'add_question',{type:'single'});
    await assert.rejects(control.dispatch(cmd),/保存|回执/);assert.equal(control.session.seq,0);assert.ok(control.pending);
    valid=true;const result=await control.dispatch(cmd);assert.equal(result.status,'confirmed');assert.deepEqual(proposals[0],proposals[1]);
  }
});
test('保存未完成时不发布结果，保存失败保留原状态',async()=>{
  const initial=J.create(context());let reject;const saved=new Promise((_,r)=>{reject=r;});
  const control=new J.Controller(initial,()=>saved);const next=control.dispatch(command(control.session,'add_question',{type:'single'}));
  await Promise.resolve();assert.equal(control.session.seq,0);reject(new Error('磁盘已满'));await assert.rejects(next,/磁盘/);
  assert.equal(control.session.seq,0);assert.equal(control.journal.events.length,0);
});
test('同请求重试返回原回执，封存后重试也可查询，相同编号不同内容拒绝',async()=>{
  let writes=0;const c=new J.Controller(J.create(context()),async journal=>{writes++;return structuredClone(journal);});
  const first=command(c.session,'add_question',{type:'single'});const receipt=await c.dispatch(first);
  const closed=command(c.session,'end_session');await c.dispatch(closed);const repeated=await c.dispatch(first);
  assert.deepEqual(repeated,receipt);assert.equal(writes,2);assert.equal(c.journal.events.length,2);
  await assert.rejects(c.dispatch({...first,payload:{type:'boolean'}}),/编号/);
});
test('并发答案与停止按一个顺序落盘，停止后的新答案拒绝',async()=>{
  const c=new J.Controller(J.create(context()),async journal=>structuredClone(journal));
  await c.dispatch(command(c.session,'add_question',{type:'single'}));await c.dispatch(command(c.session,'start_round'));
  const answer=command(c.session,'answer',{cardNumber:1,option:'B'}),stop=command(c.session,'end_round'),late=command(c.session,'answer',{cardNumber:1,option:'C'});
  const results=await Promise.allSettled([c.dispatch(answer),c.dispatch(stop),c.dispatch(late)]);
  assert.deepEqual(results.map(r=>r.status),['fulfilled','fulfilled','rejected']);
  assert.equal(c.session.questions[0].rounds[0].answers.s1.option,'B');assert.equal(c.session.seq,4);
});
for(const action of ['answer','add_question','start_round','end_session'])test('落盘成功丢回执后复用完全相同的提案：'+action,async t=>{
  let time=2000;t.mock.method(Date,'now',()=>++time);
  let durable=J.create(context()),loseReply=false;const proposals=[];
  const c=new J.Controller(durable,async journal=>{
    if(loseReply)proposals.push(structuredClone(journal));
    if(journal.session.seq===durable.session.seq){
      assert.deepEqual(journal.session,durable.session,'同序号的课堂不能变化');
      assert.deepEqual(journal.events,durable.events,'同序号的事件不能变化');
      assert.deepEqual(journal.receipts,durable.receipts,'同序号的回执不能变化');
    }else{assert.equal(journal.session.seq,durable.session.seq+1);durable=structuredClone(journal);}
    if(loseReply&&proposals.length===1)throw new Error('本机已落盘，桥接回执丢失');
    return {...structuredClone(durable),syncedSeq:durable.session.seq};
  });
  if(action==='answer'||action==='start_round')await c.dispatch(command(c.session,'add_question',{type:'single'}));
  if(action==='answer')await c.dispatch(command(c.session,'start_round'));
  const payload=action==='answer'?{cardNumber:1,option:'B'}:action==='add_question'?{type:'single'}:{};
  const request=command(c.session,action,payload),before=structuredClone(c.journal);loseReply=true;
  await assert.rejects(c.dispatch(request),/丢失/);assert.deepEqual(c.journal,before);
  const receipt=structuredClone(durable.receipts[request.id].result);
  assert.deepEqual(await c.dispatch(request),receipt);assert.deepEqual(proposals[1],proposals[0]);
  assert.equal(c.session.seq,before.session.seq+1);assert.equal(c.journal.syncedSeq,c.session.seq);
  assert.deepEqual(await c.dispatch(request),receipt);assert.equal(proposals.length,2);
  const reloaded=new J.Controller(durable,()=>assert.fail('已有回执不应再次保存'));
  assert.deepEqual(await reloaded.dispatch(request),receipt);
});
test('结果未知时拒绝同编号不同内容及后续新请求，原请求仍能恢复',async()=>{
  let durable,attempts=0;const c=new J.Controller(J.create(context()),async journal=>{
    attempts++;if(!durable){durable=structuredClone(journal);throw new Error('回执丢失');}
    assert.deepEqual(journal,durable);return structuredClone(durable);
  });
  const first=command(c.session,'add_question',{type:'single'});
  await assert.rejects(c.dispatch(first),/丢失/);
  await assert.rejects(c.dispatch({...first,payload:{type:'boolean'}}),/编号|内容/);
  await assert.rejects(c.dispatch(command(c.session,'end_session')),/确认|重试|核对/);
  assert.equal(attempts,1);assert.equal(c.session.seq,0);
  assert.deepEqual(await c.dispatch(first),durable.receipts[first.id].result);assert.equal(attempts,2);
});
test('保存返回不匹配的请求身份时不发布，仍可重试原提案',async()=>{
  let attempts=0;const c=new J.Controller(J.create(context()),async journal=>{
    const saved=structuredClone(journal);if(++attempts===1)saved.receipts[Object.keys(saved.receipts)[0]].fingerprint='其他请求';return saved;
  });
  const request=command(c.session,'add_question',{type:'single'});
  await assert.rejects(c.dispatch(request),/回执|请求/);assert.equal(c.session.seq,0);
  assert.equal((await c.dispatch(request)).seq,1);
});
test('恢复时按规范化命令校验有效 JSON 指纹，保持持久化回执原样',async()=>{
  const c=new J.Controller(J.create(context()),async journal=>structuredClone(journal));
  const request=command(c.session,'add_question',{type:'single'}),result=await c.dispatch(request),journal=structuredClone(c.journal);
  journal.receipts[request.id].fingerprint=JSON.stringify(JSON.parse(journal.receipts[request.id].fingerprint),null,2);
  const restored=new J.Controller(journal,()=>assert.fail('已有匹配回执不应再次写入'));
  assert.deepEqual(await restored.dispatch(request),result);assert.deepEqual(restored.journal,journal);
  await assert.rejects(restored.dispatch({...request,payload:{type:'boolean'}}),/编号|内容/);
});

(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.CardQuizModel=factory();})(globalThis,function(){
  'use strict';
  const letters='ABCD',clone=value=>JSON.parse(JSON.stringify(value));
  const uid=()=>globalThis.crypto.randomUUID();
  const fail=message=>{throw new Error(message);};
  const activeQuestion=s=>s.questions.find(q=>q.id===s.currentQuestionId);
  const activeRound=s=>activeQuestion(s)?.rounds.find(r=>r.id===s.currentRoundId);
  const closed=r=>!r||r.status==='closed';
  const completeAnswer=(q,a)=>Boolean(a)&&(q?.type!=='multiple'||q.options.every((_,i)=>typeof a.choices?.[letters[i]]==='boolean'));
  function validText(value,max){
    if(typeof value!=='string')return false;let count=0;
    for(const character of value){const code=character.codePointAt(0);if(++count>max||code>=0xd800&&code<=0xdfff)return false;}
    return true;
  }
  function text(value,max=4000){if(!validText(value,max))fail('文字格式不正确或过长。');return value;}
  function question(value){
    if(!value||!['single','boolean','multiple'].includes(value.type))fail('请选择单选、判断或多选题。');
    const options=value.type==='boolean'?['正确','错误']:(value.options||['','','','']);
    if(!Array.isArray(options)||options.length<2||options.length>4)fail('选择题需要 2-4 个选项。');
    let answer=value.answer??null;
    if(answer!==null){
      if(typeof answer!=='string'||!answer.length||new Set(answer).size!==answer.length||
          [...answer].some(l=>!letters.slice(0,options.length).includes(l))||value.type!=='multiple'&&answer.length!==1)fail('标准答案不在有效选项中。');
      if(value.type==='multiple')answer=[...answer].sort().join('');
    }
    const tags=value.tags||[];
    if(!Array.isArray(tags)||tags.length>50||tags.some(t=>!validText(t,80)||!t.trim()))fail('知识点最多 50 个，每个最多 80 字。');
    return{type:value.type,text:text(value.text||'',20000),imageId:value.imageId||null,options:options.map(x=>text(x,2000)),answer,tags:[...new Set(tags.map(t=>t.trim()))]};
  }
  function createSession(context,subjectId,now=Date.now()){
    if(!context?.classId||!context.deviceId||!Array.isArray(context.students)||!context.students.length)fail('请先联网准备本班名单和纸卡。');
    if(context.students.length>157)fail('第一版纸卡最多支持 157 名学生。');
    const ids=new Set(),numbers=new Set();
    const roster=context.students.map(s=>{
      if(typeof s.id!=='string'||!s.id||ids.has(s.id)||!Number.isInteger(s.cardNumber)||s.cardNumber<1||s.cardNumber>157||numbers.has(s.cardNumber))fail('本班纸卡尚未完整分配或卡号重复，请联系名单管理员。');
      ids.add(s.id);numbers.add(s.cardNumber);return{id:s.id,name:text(s.name,40),cardNumber:s.cardNumber};
    });
    if(typeof subjectId!=='string'||!subjectId)fail('请选择学科。');
    return{schema:1,id:uid(),classId:context.classId,deviceId:context.deviceId,subjectId,startedAt:now,endedAt:null,seq:0,cardVersion:'ice-v1',rosterRevision:context.rosterRevision||0,cardRevision:context.cardRevision||0,roster,questions:[],currentQuestionId:null,currentRoundId:null,source:'board',sourceId:'board',generation:1};
  }
  function apply(input,command,now=Date.now()){
    if(!command?.id||command.sessionId!==input.id)fail('课堂标识不匹配，请重新载入。');
    if(input.endedAt!==null)fail('课堂已经结束，不能继续收答。');
    if(command.generation!==input.generation||command.sourceId!==input.sourceId)fail('采集许可已经变化，请核对当前题目。');
    const s=clone(input),p=command.payload||{},q=activeQuestion(s),r=activeRound(s);
    const current=()=>{if(!q||command.questionId!==q.id)fail('题目已经变化，请重新核对。');};
    const round=()=>{current();if(!r||command.roundId!==r.id)fail('收答轮次已经变化，请重新核对。');};
    const between=()=>{if(!closed(r))fail('请先结束当前轮次。');};
    switch(command.action){
      case 'add_question':{
        between();if(s.questions.length>=100)fail('一堂课最多 100 道题，请结束后另开课堂。');
        const value=question(p),bankId=p.bankId||p.id||null;
        const created={...value,id:uid(),revision:1,bankId,bankVersion:bankId?(p.bankVersion||p.revision||1):null,subjectId:s.subjectId,revealed:false,rounds:[]};
        s.questions.push(created);s.currentQuestionId=created.id;s.currentRoundId=null;s.generation++;break;
      }
      case 'start_round':{
        current();between();s.generation++;
        const created={id:uid(),startedAt:now,endedAt:null,purpose:q.revealed||p.practice===true?'practice':'formal',source:s.source,sourceId:s.sourceId,generation:s.generation,status:'collecting',answers:{},exempt:[]};
        if(q.type==='multiple')created.activeOption='A';
        q.rounds.push(created);s.currentRoundId=created.id;break;
      }
      case 'answer':{
        round();if(r.status!=='collecting'||r.generation!==s.generation)fail('当前没有正在收答的轮次。');
        const student=s.roster.find(x=>x.cardNumber===p.cardNumber);
        if(!student)fail(`卡 ${p.cardNumber} 未绑定本班学生。`);
        if(q.type==='multiple'){
          if(p.targetOption!==r.activeOption)fail('收答项已变化，请核对当前选项。');
          if(!['A','B'].includes(p.option))fail('多选分项请用 A 表示选、B 表示不选。');
          const choices={...r.answers[student.id]?.choices,[r.activeOption]:p.option==='A'};
          r.answers[student.id]={option:letters.slice(0,q.options.length).split('').filter(l=>choices[l]===true).join(''),choices,confirmedAt:now,seq:s.seq+1};
        }else{
          if(typeof p.option!=='string'||p.option.length!==1||!letters.slice(0,q.options.length).includes(p.option))fail('该选项不适用于当前题目。');
          r.answers[student.id]={option:p.option,confirmedAt:now,seq:s.seq+1};
        }
        break;
      }
      case 'set_multi_option':
        round();if(q.type!=='multiple'||r.status!=='collecting')fail('请先开始多选题收答。');
        if(typeof p.option!=='string'||p.option.length!==1||!letters.slice(0,q.options.length).includes(p.option))fail('收答项不在有效选项中。');
        r.activeOption=p.option;s.generation++;r.generation=s.generation;break;
      case 'end_round':
        round();if(r.status==='closed')fail('本轮已经结束。');r.status='closed';r.endedAt=now;s.generation++;break;
      case 'resume_round':
        round();if(r.status!=='paused')fail('当前轮次不处于暂停状态。');s.generation++;r.generation=s.generation;r.status='collecting';break;
      case 'recover':
        s.generation++;if(r&&r.status!=='closed'){r.status='paused';r.generation=s.generation;}break;
      case 'set_source':
        between();if(!['board','phone'].includes(p.source)||typeof p.sourceId!=='string'||!p.sourceId)fail('采集来源不正确。');
        s.source=p.source;s.sourceId=p.sourceId;s.generation++;break;
      case 'edit_question':{
        current();between();if(p.revision===undefined?p.expectedSeq!==s.seq:p.revision!==q.revision)fail('题目信息已变化，请重新载入。');
        const value=question({...q,...p});
        if(q.bankId&&(value.type!==q.type||JSON.stringify(value.options)!==JSON.stringify(q.options)))fail('题库快照的题型和选项已固定，请添加临时题或修改题库后重新发布。');
        const shapeChanged=value.type!==q.type||value.options.length!==q.options.length;
        if(q.rounds.some(x=>Object.keys(x.answers).length)&&shapeChanged)fail('已有作答，改变题型或选项范围需要新建题目。');
        if(q.rounds.length&&(q.type==='multiple'||value.type==='multiple')&&shapeChanged)fail('已有收答轮次，改变多选题型或选项范围需要新建题目。');
        Object.assign(q,value);q.revision++;break;
      }
      case 'reveal':
        current();between();if(!p.external&&q.answer===null)fail('请先设置标准答案，或标记已经在课件中讲解。');q.revealed=true;break;
      case 'set_exempt':{
        round();if(r.status==='closed')fail('本轮已经结束，不能更改免答。');
        if(!s.roster.some(x=>x.id===p.studentId)||typeof p.exempt!=='boolean')fail('免答学生无效。');
        r.exempt=r.exempt.filter(id=>id!==p.studentId);if(p.exempt)r.exempt.push(p.studentId);break;
      }
      case 'end_session':
        if(r&&r.status!=='closed'){r.status='closed';r.endedAt=now;}s.endedAt=now;s.generation++;break;
      default:fail('不支持的课堂操作。');
    }
    s.seq++;return s;
  }
  function recover(s,now=Date.now()){
    if(s.endedAt!==null)return clone(s);
    return apply(s,{id:uid(),sessionId:s.id,generation:s.generation,sourceId:s.sourceId,action:'recover',payload:{}},now);
  }
  function officialRound(q){return [...q.rounds].reverse().find(r=>r.status==='closed'&&r.purpose==='formal')||null;}
  function roundSummary(s,r){
    const q=s.questions.find(q=>q.rounds.some(item=>item.id===r?.id))||activeQuestion(s);
    const expected=s.roster.filter(x=>!r?.exempt.includes(x.id)),entries=expected.map(x=>r?.answers[x.id]).filter(Boolean),answers=entries.filter(a=>completeAnswer(q,a));
    const distribution=Object.fromEntries(letters.slice(0,q?.options.length||4).split('').map(l=>[l,0]));
    for(const a of answers)for(const option of a.option)if(Object.hasOwn(distribution,option))distribution[option]++;
    return{expected:expected.length,received:answers.length,unanswered:expected.length-entries.length,correct:q?.answer?answers.filter(a=>a.option===q.answer).length:null,distribution,
      ...(q?.type==='multiple'?{incomplete:entries.length-answers.length,optionReceived:entries.filter(a=>Object.hasOwn(a.choices,r?.activeOption)).length}:{})};
  }
  function publicState(s,className=''){
    const q=activeQuestion(s),r=activeRound(s),counts=roundSummary(s,r);
    return{sessionId:s.id,className,subjectId:s.subjectId,questionId:q?.id||null,questionNumber:q?s.questions.indexOf(q)+1:0,questionType:q?.type||null,optionCount:q?.options.length||4,roundId:r?.id||null,roundStatus:r?.status||null,source:s.source,sourceId:s.sourceId,generation:s.generation,seq:s.seq,received:counts.received,expected:counts.expected,ended:s.endedAt!==null,
      ...(q?.type==='multiple'?{activeOption:r?.activeOption||null,optionReceived:counts.optionReceived||0}:{})};
  }
  return{createSession,apply,recover,officialRound,roundSummary,publicState,activeQuestion,activeRound};
});

(() => {
  'use strict';
  const $=id=>document.getElementById(id), pending=new Map();
  const subjects={chinese:'语文',math:'数学',english:'英语',physics:'物理',chemistry:'化学',biology:'生物',politics:'政治',history:'历史',geography:'地理'};
  let user, pair, state, connected=false, pollTimer, polling=false, failures=0, disposed=false, controlBusy=false, uncertain=0, editQuestionId, editContext, cameraIntent=0, captureKey='';
  const feedback=(message,kind='')=>{$('feedback').textContent=message;$('feedback').className='feedback '+kind;};
  const scanner=new CardQuizScanner({video:$('camera'),onRead:read=>send('answer',{...read,...(state?.questionType==='multiple'?{targetOption:state.activeOption}:{})}),onStatus:({message})=>{$('camera-status').textContent=message;show();}});
  let initialCode=new URLSearchParams(location.search).get('code')||'';
  if(initialCode){$('code').value=initialCode;history.replaceState(null,'',location.pathname);}
  async function api(path,body){
    const headers=body?{'Content-Type':'application/json','X-CSRF-Token':user?.csrfToken||''}:{};
    const response=await fetch(path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});
    const value=await response.json();
    if(!response.ok){const error=new Error(value.error||'连接未完成，请重试。');error.status=response.status;throw error;}return value;
  }
  function show(){
    $('login').hidden=Boolean(user);$('pairing').hidden=!user||Boolean(pair);$('capture').hidden=!pair;
    $('question-settings').hidden=!pair||!state;
    $('account').textContent=user?`${user.displayName||user.username} · 教师账号`:'';
    if(!state)return;
    $('class-name').textContent=state.className;
    $('disconnect').textContent=state.ended?'连接下一堂课':'断开手机';
    const multiple=state.questionType==='multiple';
    $('question-label').textContent=`${subjects[state.subjectId]||state.subjectId} · 第 ${state.questionNumber} 题 · ${state.questionType==='boolean'?'判断（A/B）':multiple?'多选（逐项确认）':state.optionCount+' 选一'}`;
    $('received').textContent=state.received;$('expected').textContent=` / ${state.expected} 人${multiple?'整题完成':'已收'}`;
    const own=connected&&state.source==='phone'&&state.sourceId===pair?.pairId&&!state.ended;
    const collecting=own&&state.roundStatus==='collecting',paused=state.roundStatus==='paused',between=!state.roundId||state.roundStatus==='closed';
    const nextKey=`${state.sessionId}/${state.roundId}/${state.generation}`;
    if(captureKey&&captureKey!==nextKey)scanner.stop();captureKey=nextKey;
    $('multi-capture').hidden=!multiple;
    if(multiple){
      if($('multi-option').options.length!==state.optionCount)$('multi-option').innerHTML='ABCD'.slice(0,state.optionCount).split('').map(l=>`<option value="${l}">${l} 项</option>`).join('');
      $('multi-option').value=state.activeOption||'A';$('multi-option').disabled=!collecting||controlBusy;
      $('multi-next').disabled=!collecting||controlBusy||'ABCD'.indexOf(state.activeOption)>=state.optionCount-1;
      $('multi-progress').textContent=`本项已收 ${state.optionReceived||0} / ${state.expected} 人；切项后请重新开启相机。`;
    }
    const remaining=state.expected-(multiple?(state.optionReceived||0):state.received);
    $('capture-progress').hidden=between||state.ended;
    $('capture-progress').textContent=!state.expected?'本轮无人须答':remaining?`待收 ${remaining} 人`:multiple?'本项已收齐':'本轮已收齐';
    $('connection').textContent=state.ended?'本课堂已结束':!own?'等待白板确认手机来源或恢复连接':collecting?'正在收答，白板保存后确认':paused?'已暂停，已收答案保留':'已连接，等待开始收答';
    $('start').hidden=state.roundStatus==='collecting'||state.ended;
    $('start').disabled=!own||(!between&&!paused)||controlBusy||!state.questionId;
    $('start').textContent=paused?'恢复本轮':state.roundId?'重新收答':'开始收答';
    $('stop').hidden=between||state.ended;
    $('stop').classList.toggle('primary',collecting);
    $('stop').disabled=!own||between||controlBusy;
    $('camera-toggle').hidden=!collecting;
    $('camera-toggle').disabled=!collecting||controlBusy;
    $('camera-toggle').textContent=scanner.running?'关闭相机':'开启相机';
    $('camera').hidden=!collecting||!scanner.running;
    $('camera-status').hidden=!collecting;
    $('next').disabled=!own||!between||controlBusy;$('reveal').disabled=!own||!between||controlBusy;
    $('submission-status').textContent=pending.size?`${pending.size} 条等待白板确认`:uncertain?`${uncertain} 条状态未确认，请在白板核对；不会自动重发。`:'白板已确认的作答计入上方人数。';
    $('question-edit').disabled=!own||!between||controlBusy||!state.questionId;
    $('edit-value').disabled=$('edit-field').disabled=$('edit-reset').disabled=$('question-edit').disabled;
    if(editQuestionId!==state.questionId){editQuestionId=state.questionId;resetEdit();}
    const multiEdit=multiple&&$('edit-field').value==='answer';
    $('edit-multiple-answer').hidden=!multiEdit;$('edit-value-label').hidden=multiEdit;
    if(multiEdit&&$('edit-multiple-options').children.length!==state.optionCount)$('edit-multiple-options').innerHTML='ABCD'.slice(0,state.optionCount).split('').map(l=>`<label><input type="checkbox" value="${l}"><span>${l}</span></label>`).join('');
    $('edit-multiple-options').querySelectorAll('input').forEach(input=>input.disabled=$('question-edit').disabled);
    scanner.reset(nextKey,multiple?2:state.optionCount);
    if(!collecting)scanner.stop();
  }
  function settle(id,value){
    const item=pending.get(id);if(!item)return;
    if(value.status==='confirmed'){
      pending.delete(id);item.resolve(value.result||value);
      if(value.result?.state&&(!state||value.result.state.seq>=state.seq))state=value.result.state;
      feedback('白板已保存并确认。');
    }else if(value.status==='rejected'){
      pending.delete(id);item.reject(new Error(value.error||'白板拒绝了这次操作。'));feedback(value.error||'操作被拒绝，请核对题目。','error');
    }
    show();
  }
  function unconfirmed(id,message){
    const item=pending.get(id);if(!item)return;
    pending.delete(id);uncertain++;scanner.stop();item.reject(new Error(message));feedback(message,'warning');
  }
  function clearPending(message){for(const id of [...pending.keys()])unconfirmed(id,message);}
  function schedule(){clearTimeout(pollTimer);if(!disposed&&!document.hidden&&pair)pollTimer=setTimeout(poll,Math.min(15000,1200*2**failures));}
  async function poll(){
    if(polling||!pair||disposed)return;polling=true;const pairId=pair.pairId;
    try{
      const query=new URLSearchParams();for(const id of pending.keys())query.append('commandId',id);
      const value=await api('/api/card-quiz/pairs/'+encodeURIComponent(pair.pairId)+(query.size?'?'+query:''));
      if(pair?.pairId!==pairId||disposed)return;
      if(!state||value.state.seq>=state.seq)state=value.state;
      connected=value.connected&&!document.hidden;failures=0;
      if(connected&&$('feedback').textContent==='手机已配对，请在白板确认使用此手机。')feedback('已连接白板，请主动开启相机后识别纸卡。');
      for(const receipt of value.receipts||[])settle(receipt.id,receipt);
      const found=new Set((value.receipts||[]).map(r=>r.id));
      for(const[id,item]of pending){
        if(item.deliveryUnknown&&!found.has(id))item.missing=(item.missing||0)+1;
        if(item.missing>=2||Date.now()-item.at>60000)unconfirmed(id,'操作状态尚未确认，请在白板核对后继续；本手机不会自动重发。');
      }
      if(!connected)scanner.stop();
      if(state.ended)feedback('本课堂已结束，请在教师工作台查看报告。');
      show();
    }catch(error){
      if(pair?.pairId!==pairId||disposed)return;
      connected=false;cameraIntent++;scanner.stop();failures=Math.min(failures+1,4);
      if([401,403,404].includes(error.status))clearPending('配对授权已失效，未确认操作请在白板核对。');
      if(error.status===401){user=null;pair=null;state=null;sessionStorage.removeItem('iceclass.cardQuizPair');show();}
      else if(error.status===403||error.status===404){pair=null;state=null;sessionStorage.removeItem('iceclass.cardQuizPair');show();}
      show();
      feedback(error.status?error.message:'网络中断，相机已停止；未确认的作答请恢复连接后核对。','error');
    }finally{polling=false;schedule();}
  }
  function send(action,payload={},context){
    if(!pair||!state||!connected||state.sourceId!==pair.pairId||state.ended)return Promise.reject(new Error('白板尚未连接或采集来源已变化。'));
    if(pending.size>=128)return Promise.reject(new Error('待确认队列已满，请等待白板保存。'));
    if(context&&Object.keys(context).some(key=>context[key]!==state[key]))return Promise.reject(new Error('题目或版本已变化，草稿已保留。请核对后清空重填。'));
    const command={id:crypto.randomUUID(),sessionId:state.sessionId,questionId:state.questionId,roundId:state.roundId,generation:state.generation,sourceId:state.sourceId,action,payload};
    const result=new Promise((resolve,reject)=>pending.set(command.id,{command,resolve,reject,at:Date.now()}));
    api('/api/card-quiz/pairs/'+encodeURIComponent(pair.pairId)+'/commands',command).then(value=>{
      if(value.status==='confirmed')settle(command.id,{status:'confirmed',result:value});else settle(command.id,value);
      show();
    }).catch(error=>{
      const item=pending.get(command.id);
      if(!item)return;
      if(error.status){pending.delete(command.id);item?.reject(error);feedback(error.message,'error');}
      else{item.deliveryUnknown=true;connected=false;scanner.stop();feedback('发送尚未确认，相机已停止；连接恢复后核对白板人数。','warning');}
      show();
    });
    show();return result;
  }
  async function claim(){
    pair=await api('/api/card-quiz/pair',{code:$('code').value.trim().toUpperCase()});
    sessionStorage.setItem('iceclass.cardQuizPair',JSON.stringify(pair));state=null;connected=false;uncertain=0;show();feedback('手机已配对，请在白板确认使用此手机。');await poll();
  }
  async function control(task){if(controlBusy)return;controlBusy=true;show();try{await task();}catch(error){feedback(error.message,'error');}finally{controlBusy=false;show();}}
  $('login-form').onsubmit=event=>{event.preventDefault();void control(async()=>{const value=await api('/api/auth/login',{username:$('username').value,password:$('password').value});$('password').value='';user=value.user;show();if(initialCode){initialCode='';await claim();}});};
  $('pair-form').onsubmit=event=>{event.preventDefault();void control(claim);};
  $('start').onclick=()=>void control(async()=>{const intent=++cameraIntent,pairId=pair.pairId,questionId=state.questionId;await send(state.roundStatus==='paused'?'resume_round':'start_round');if(intent===cameraIntent&&!disposed&&!document.hidden&&connected&&pair?.pairId===pairId&&state.questionId===questionId&&state.sourceId===pairId&&state.roundStatus==='collecting')await scanner.start();});
  $('stop').onclick=()=>{cameraIntent++;scanner.stop();void control(()=>send('end_round'));};
  $('camera-toggle').onclick=()=>void control(async()=>{if(scanner.running)scanner.stop();else await scanner.start();});
  function switchMultiOption(option){
    if(option===state?.activeOption)return;
    cameraIntent++;scanner.stop();void control(async()=>{await send('set_multi_option',{option});feedback(`已切换到 ${option} 项，请学生调整卡面后再开启相机。`);});
  }
  $('multi-option').onchange=event=>switchMultiOption(event.target.value);
  $('multi-next').onclick=()=>switchMultiOption('ABCD'['ABCD'.indexOf(state?.activeOption)+1]);
  $('next-type').onchange=()=>{$('next-count').disabled=$('next-type').value==='boolean';};
  $('next').onclick=()=>void control(()=>send('add_question',{type:$('next-type').value,options:$('next-type').value==='boolean'?['正确','错误']:Array(Number($('next-count').value)).fill('')}));
  $('reveal').onclick=()=>void control(()=>send('reveal',{external:true}));
  const resetEdit=()=>{editContext=null;$('edit-value').value='';$('edit-multiple-options').querySelectorAll('input').forEach(input=>input.checked=false);};
  const captureEdit=()=>{if(!editContext&&state)editContext={sessionId:state.sessionId,questionId:state.questionId,seq:state.seq,generation:state.generation,sourceId:state.sourceId};};
  $('edit-reset').onclick=()=>{resetEdit();$('edit-value').focus();};
  $('edit-field').onchange=()=>{resetEdit();captureEdit();show();};
  $('edit-value').onfocus=captureEdit;
  $('edit-value').oninput=captureEdit;
  $('edit-multiple-options').onchange=()=>{captureEdit();$('edit-value').value=[...$('edit-multiple-options').querySelectorAll('input:checked')].map(input=>input.value).join('');};
  $('question-form').onsubmit=event=>{event.preventDefault();void control(async()=>{
    const context=editContext||{sessionId:state.sessionId,questionId:state.questionId,seq:state.seq,generation:state.generation,sourceId:state.sourceId};
    const payload={expectedSeq:context.seq},field=$('edit-field').value,value=$('edit-value').value;
    if(field==='answer')payload.answer=value.trim().toUpperCase()||null;
    else if(field==='tags')payload.tags=[...new Set(value.split(/[,，]/).map(t=>t.trim()).filter(Boolean))];
    else payload.text=value;
    await send('edit_question',payload,context);resetEdit();
  });};
  $('disconnect').onclick=()=>{cameraIntent++;scanner.stop();clearTimeout(pollTimer);clearPending('手机已断开，未确认操作请在白板核对。');pair=state=null;connected=false;resetEdit();sessionStorage.removeItem('iceclass.cardQuizPair');show();feedback('手机已断开。请在白板停止当前轮次并换回本机。','warning');};
  document.addEventListener('visibilitychange',()=>{if(document.hidden){cameraIntent++;scanner.stop();connected=false;clearTimeout(pollTimer);show();}else if(pair)void poll();});
  window.addEventListener('pagehide',()=>{disposed=true;cameraIntent++;scanner.stop();clearTimeout(pollTimer);clearPending('页面已离开，未确认操作请在白板核对。');});
  window.addEventListener('pageshow',event=>{if(event.persisted){disposed=false;if(pair)void poll();}});
  (async()=>{try{
    const value=await api('/api/session');user=value.authenticated?value.user:null;
    show();
    if(!user){feedback('请使用有本班权限的教师账号登录。');return;}
    if(initialCode){
      initialCode='';sessionStorage.removeItem('iceclass.cardQuizPair');await claim();return;
    }
    try{pair=JSON.parse(sessionStorage.getItem('iceclass.cardQuizPair')||'null');}catch{}
    if(pair){show();await poll();}
    else feedback('请输入白板上的配对码。');
  }catch(error){show();feedback(error.message,'error');}})();
})();

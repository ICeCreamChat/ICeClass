(() => {
  'use strict';
  const root = document.getElementById('selfStudyRoot');
  if (!root) return;
  const app = () => window.ICeClass;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone = v => JSON.parse(JSON.stringify(v));
  const format = (at, options = {}) => at ? new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',
    month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',...options}).format(new Date(at)) : '尚无记录';
  const visible = () => !document.getElementById('view-self-study').classList.contains('hidden');
  const allowed = () => app()?.state.user && app().state.user.role !== 'subject_teacher' &&
    !(window.ICeClassVoiceHost?.classroomAccount && window.chrome?.webview);
  let cid = '', owner = '', generation = 0, classes = [], profile, draft, controller;
  let saving = false, loading = false, conflict = false, leaveAction, timer, pollBusy = false, pollGeneration = 0;
  let eventsSignature = '', photoUrl = '', photoVersion = 0, lastNotice = '', seen = new Set();
  let photoEvent = '', photoTimer, photoRecords = new Map(), eventsTime = 0, eventsReceived = 0;
  const dirty = () => !!(draft && profile && JSON.stringify(draft) !== JSON.stringify(profile.config));
  const leave = document.createElement('dialog');
  leave.id = 'ss-leave'; leave.className = 'ss-dialog'; leave.setAttribute('aria-labelledby','ss-leave-title');
  leave.innerHTML = '<h2 id="ss-leave-title">有尚未保存的设置</h2><p>放弃本班的修改并继续？</p><div class="ss-actions"><button type="button" class="btn" data-ss-keep>继续编辑</button><button type="button" class="btn primary" data-ss-discard>放弃修改</button></div>';
  const photo = document.createElement('dialog');
  photo.id = 'ss-photo'; photo.className = 'ss-dialog ss-photo'; photo.setAttribute('aria-labelledby','ss-photo-title');
  const schedule = document.createElement('dialog');
  schedule.id = 'ss-week'; schedule.className = 'ss-dialog'; schedule.setAttribute('aria-labelledby','ss-week-title');
  schedule.innerHTML = '<h2 id="ss-week-title">第二节晚自习安排</h2><ul id="ss-schedule" class="ss-schedule"></ul><div class="ss-actions"><button type="button" class="btn" data-ss-timetable>编辑周课表</button><button type="button" class="btn primary" data-ss-close-schedule>关闭</button></div>';
  document.body.append(leave,photo,schedule);
  schedule.addEventListener('click',e=>{
    if(e.target.closest('[data-ss-close-schedule]'))schedule.close();
    if(e.target.closest('[data-ss-timetable]')){schedule.close();document.querySelector('[data-view="island"]').click();}
  });
  function closePhoto() {
    clearTimeout(photoTimer);photoTimer=undefined;photoEvent='';
    photoVersion++; if(photo.open)photo.close();photo.replaceChildren();
    if(photoUrl)URL.revokeObjectURL(photoUrl);photoUrl='';
  }
  function refreshPhotoLifetime() {
    if(!photoEvent)return;
    const record=photoRecords.get(photoEvent);
    const remaining=record?.photo_at+86400000-eventsTime-Math.max(0,performance.now()-eventsReceived);
    if(record?.photo_status!=='ready'||!Number.isFinite(remaining)||remaining<=0){closePhoto();return;}
    clearTimeout(photoTimer);photoTimer=setTimeout(closePhoto,remaining);
  }
  photo.addEventListener('close',()=>{if(!photo.open)closePhoto();});
  photo.addEventListener('click',e=>{if(e.target.closest('[data-ss-close-photo]'))closePhoto();});
  leave.querySelector('[data-ss-keep]').addEventListener('click',()=>{leaveAction=undefined;leave.close();});
  leave.addEventListener('cancel',()=>{leaveAction=undefined;});
  leave.querySelector('[data-ss-discard]').addEventListener('click',()=>{
    const next=leaveAction;leaveAction=undefined;draft=profile?clone(profile.config):undefined;leave.close();next?.();
  });
  function canLeave(next) {
    if(saving||loading){app()?.toast('正在载入或保存，请稍候。');return false;}
    if(dirty()){leaveAction=next;if(!leave.open)leave.showModal();return false;}
    return true;
  }
  function feedback(message='',error=false) {
    const node=document.getElementById('ss-feedback');if(!node)return;
    node.textContent=message;node.hidden=!message;node.classList.toggle('ss-error',error);
    node.setAttribute('role',error?'alert':'status');
  }
  function updateSave() {
    const button=root.querySelector('[data-ss-save]');if(!button)return;
    button.disabled=saving||loading||conflict||!draft;
    button.textContent=saving?'正在保存…':loading?'正在载入…':'保存设置';
    const changed=dirty();
    setText('ss-dirty',changed?'有未保存的修改':draft?'设置已保存':'');
    root.querySelector('#ss-dirty').classList.toggle('ss-is-dirty',changed);
    root.querySelector('#ss-class').disabled=saving||loading;
    root.querySelector('[data-ss-reload]').disabled=saving||loading;
    const form=root.querySelector('#ss-form');
    if(form){form.setAttribute('aria-busy',String(saving||loading));form.querySelector('fieldset').disabled=saving||loading;}
    const scheduleButton=root.querySelector('[data-ss-schedule]');if(scheduleButton)scheduleButton.disabled=loading||!profile;
  }
  function setText(id,value) {const node=document.getElementById(id);if(node&&node.textContent!==value)node.textContent=value;}
  const icon = paths => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+paths+'</svg>';
  const clockIcon=icon('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>');
  const checkIcon=icon('<path d="m5 12 4 4L19 6"/>');
  const infoIcon=icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>');
  const reloadIcon=icon('<path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5M20 7l-3-3"/>');
  const toggle = (key,title,note='',name=title) => '<label class="ss-switch'+(key==='enabled'?' ss-monitor-switch':'')+'"><span class="ss-switch-copy"><strong>'+title+'</strong>'+(note?'<small id="ss-'+key+'-note">'+note+'</small>':'')+'</span><span class="ss-switch-control"><input id="ss-'+key+'" type="checkbox" name="'+key+'" data-ss-field="'+key+'" aria-label="'+name+'"'+(note?' aria-describedby="ss-'+key+'-note"':'')+(draft[key]?' checked':'')+'><span class="ss-switch-track"></span></span></label>';
  const number = (key,id,title,min,max,value,unit='',step=1) => '<span class="ss-number"><input id="'+id+'" name="'+key+'" data-ss-field="'+key+'" type="number" inputmode="'+(step===1?'numeric':'decimal')+'" min="'+min+'" max="'+max+'" step="'+step+'" autocomplete="off" aria-label="'+title+'" value="'+esc(value)+'" required>'+(unit?'<span aria-hidden="true">'+unit+'</span>':'')+'</span>';
  function renderRules() {
    if(!draft)return;
    const calls=1+draft.confirmationsAfterReminder;
    const limited=draft.dailyCalls<calls;
    const incomplete=!Number.isFinite(calls)||!Number.isFinite(draft.dailyCalls);
    setText('ss-budget-caption',incomplete?'请检查规则':limited?'次数不足以通知':'每日上限');
    const note=document.getElementById('ss-budget-note');
    note.textContent=incomplete?'请填写有效的确认次数和每日复核上限。':(limited?'当前次数上限不足以完成一次完整通知流程。':'一次完整提醒与通知至少需要 '+calls+' 次复核。')+' 额度用完后暂停 AI，声波继续；失败不自动重试。';
    note.classList.toggle('ss-budget-warning',limited||incomplete);
  }
  function render() {
    const expanded=new Set([...root.querySelectorAll('details[open]')].map(node=>node.id));
    const focus=root.contains(document.activeElement)?document.activeElement.id:'';
    root.innerHTML = '<div class="ss-page-head"><h1>自习管理</h1><div class="ss-scope"><label for="ss-class">班级</label><select id="ss-class" name="self-study-class" autocomplete="off">'+classes.map(c=>'<option value="'+esc(c.id)+'"'+(cid===c.id?' selected':'')+'>'+esc(c.name)+'</option>').join('')+'</select></div>'+
      '<div class="ss-page-actions"><span id="ss-dirty" role="status"></span><button type="button" class="btn ss-reload" data-ss-reload aria-label="重新载入" title="重新载入">'+reloadIcon+'</button><button class="btn primary" type="submit" form="ss-form" data-ss-save>保存设置</button></div></div>'+
      '<p id="ss-feedback" class="ss-feedback" role="status" aria-live="polite" tabindex="-1" hidden></p>'+
      (draft?'<form id="ss-form"><fieldset class="ss-config"'+(saving?' disabled':'')+'><legend class="sr-only">监测、识别规则与 AI 额度</legend>'+
        '<section class="panel ss-runtime" aria-label="运行状态"><div class="ss-session-head"><div class="ss-session-identity"><span class="ss-session-icon">'+clockIcon+'</span><div class="ss-session-copy"><h2 class="ss-state"><span id="ss-state" role="status" aria-live="polite"></span></h2><p class="ss-next-period" id="ss-next-period"></p></div></div>'+toggle('enabled','本班监测','','启用自习管理')+'</div>'+
        '<p id="ss-detail" class="ss-note" hidden></p><div class="ss-flow"><span class="ss-flow-label">处理流程</span><ol aria-label="监测处理流程">'+['声音感知','持续观察','AI 复核','轻声提醒','再次确认后通知'].map((label,index)=>'<li data-ss-step="'+index+'">'+label+'</li>').join('')+'</ol><small id="ss-state-note"></small></div></section>'+
        '<div class="ss-layout"><section class="panel ss-settings ss-rules-panel" aria-labelledby="ss-settings-title"><div class="ss-section-head"><h2 id="ss-settings-title">识别与提醒</h2><span class="ss-adapt">'+checkIcon+'背景声自动适应</span></div>'+
        '<div class="ss-sensitivity"><div><span id="ss-sensitivity-label" class="ss-field-title">识别灵敏度</span><p class="ss-note">正常学习交流不直接通知老师</p></div><div class="ss-segments" role="radiogroup" aria-labelledby="ss-sensitivity-label">'+['low','balanced','high'].map(key=>'<label class="ss-segment"><input type="radio" id="ss-sensitivity-'+key+'" name="sensitivity" data-ss-field="sensitivity" value="'+key+'"'+(draft.sensitivity===key?' checked':'')+'><span>'+({low:'较低',balanced:'标准',high:'较高'}[key])+'</span></label>').join('')+'</div></div>'+
        '<div class="ss-rule-row"><label class="ss-field-title" for="ss-trigger">进入观察</label><div class="ss-rule-value"><span>连续人声</span>'+number('voiceTriggerMs','ss-trigger','进入观察前持续（秒）',0.3,3,draft.voiceTriggerMs/1000,'秒',0.1)+'</div></div>'+
        '<div class="ss-rule-row"><label class="ss-field-title" for="ss-observation">AI 复核</label><div class="ss-rule-value"><span>积累有效片段</span>'+number('observationSeconds','ss-observation','AI 复核前积累（秒）',10,30,draft.observationSeconds,'秒')+'</div></div>'+
        '<div class="ss-rule-row ss-notify-rule"><span class="ss-field-title">通知老师</span><div class="ss-rule-value"><label for="ss-wait" class="ss-number-label">提醒后等待'+number('reminderWaitSeconds','ss-wait','提醒后至少等待（秒）',90,300,draft.reminderWaitSeconds,'秒')+'</label><label for="ss-confirmations" class="ss-number-label">再确认'+number('confirmationsAfterReminder','ss-confirmations','提醒后再确认（次）',1,3,draft.confirmationsAfterReminder,'次')+'</label></div></div>'+
        '<p class="ss-rule-footer ss-note">'+infoIcon+'<span>先在教室提醒，持续疑似闲聊才通知班主任。</span></p></section>'+
        '<section class="panel ss-settings ss-options" aria-labelledby="ss-options-title"><div class="ss-section-head"><h2 id="ss-options-title">监测选项</h2></div>'+toggle('aiEnabled','AI 复核','仅发送疑似片段的短文本')+toggle('photoEnabled','通知时附现场照片','仅通知老师时拍摄')+
        '<label class="ss-authorization"><input type="checkbox" name="authorized" data-ss-field="authorized"'+(draft.authorized?' checked':'')+'>已完成学校告知与授权</label>'+
        '<details id="ss-budget" class="ss-disclosure"><summary><span>AI 额度</span><small id="ss-budget-caption">每日上限</small></summary><div class="ss-budget-fields"><label for="ss-calls">每日复核'+number('dailyCalls','ss-calls','每日复核（次）',0,4,draft.dailyCalls,'次')+'</label><label for="ss-tokens">每日 token'+number('dailyTokens','ss-tokens','每日 token',1500,2400,draft.dailyTokens)+'</label></div><p id="ss-budget-note" class="ss-note"></p></details>'+
        '<dl class="ss-usage"><div><dt>今日复核</dt><dd id="ss-usage-calls"></dd></div><div><dt>今日 token</dt><dd id="ss-usage-tokens"></dd></div></dl></section></div></fieldset></form>'+
        '<section class="panel ss-events" aria-labelledby="ss-events-title"><div class="ss-events-head"><div><h2 id="ss-events-title">待核实记录</h2><span>最近 7 天</span></div><span id="ss-pending" role="status"></span></div><div id="ss-event-list"></div><div class="ss-events-foot"><span>识别结果仅供核实 · 照片保留 24 小时</span><button type="button" class="ss-schedule-button" data-ss-schedule>查看晚自习安排</button></div></section>'
        :'<div class="panel ss-settings"><p class="muted" role="status">'+(classes.length?'正在载入设置…':'当前没有可管理的班级。')+'</p></div>');
    expanded.forEach(id=>{const node=document.getElementById(id);if(node)node.open=true;});
    if(focus)document.getElementById(focus)?.focus({preventScroll:true});
    updateSave();renderRules();renderRuntime();
  }
  const states = {disabled:'尚未启用',syncing:'等待教室端同步',inactive:'等待晚自习',listening:'正在感知教室声音',observing:'正在观察',analyzing:'AI 复核中',teaching:'学习交流，继续观察',warning:'已提醒安静',reported:'已通知班主任核实',budget:'AI 复核已暂停',ai_paused:'AI 复核已暂停',error:'需要检查',paused:'本节已暂停'};
  const flowSteps = {listening:0,observing:1,analyzing:2,teaching:0,warning:3,reported:4};
  const stateNotes = {disabled:'启用后按晚自习安排运行',syncing:'等待教室端更新状态',inactive:'到时自动开始',listening:'自动适应教室背景声',observing:'正在积累有效片段',analyzing:'正在核实疑似片段',teaching:'保持本地声音感知',warning:'持续观察是否恢复安静',reported:'请结合现场情况核实',budget:'教室声波继续显示',ai_paused:'教室声波继续显示',error:'请检查教室端状态',paused:'等待本节恢复监测'};
  function renderRuntime() {
    if(!profile||!document.getElementById('ss-state'))return;
    const fresh=profile.status&&profile.serverTime-profile.status.updated_at<90000;
    const state=!profile.config.enabled?'disabled':fresh&&states[profile.status.state]?profile.status.state:'syncing';
    setText('ss-state',states[state]);setText('ss-state-note',stateNotes[state]);
    root.querySelector('.ss-runtime').dataset.state=state;
    root.querySelectorAll('[data-ss-step]').forEach(node=>{
      const active=Number(node.dataset.ssStep)===flowSteps[state];
      if(active)node.setAttribute('aria-current','step');else node.removeAttribute('aria-current');
    });
    const detail=document.getElementById('ss-detail');
    detail.textContent=profile.config.enabled?(fresh&&['warning','budget','ai_paused','error','paused'].includes(profile.status.state)?profile.status.detail:profile.config.aiEnabled&&!profile.aiReady?'请先在班班连接设置中配置 AI。':''):'';
    detail.hidden=!detail.textContent;
    setText('ss-usage-calls',profile.usage.calls+' / '+profile.config.dailyCalls+' 次');
    setText('ss-usage-tokens',profile.usage.tokens+' / '+profile.config.dailyTokens+(profile.usage.estimated?'（含预占）':''));
    const next=profile.schedule.find(p=>p.endAt>profile.serverTime);
    setText('ss-next-period',next?(next.startAt<=profile.serverTime?'本节 · ':'下一节 · ')+'第二节晚自习 '+format(next.startAt,{weekday:'short'})+'–'+format(next.endAt,{month:undefined,day:undefined}):'近期没有第二节晚自习安排');
    const periods=profile.schedule.length?profile.schedule.map(p=>'<li>'+esc(format(p.startAt,{weekday:'short'}))+'–'+esc(format(p.endAt,{month:undefined,day:undefined}))+(p.temporary?' · 调课':'')+'</li>').join(''):'<li>近期没有安排第二节晚自习，请先检查周课表。</li>';
    if(document.getElementById('ss-schedule').innerHTML!==periods)document.getElementById('ss-schedule').innerHTML=periods;
  }
  async function api(path,options={}) {return app().api('/api/self-study'+path,{...options,signal:controller?.signal});}
  async function load() {
    if(!allowed())return;
    const identity=app().state.user.id;
    if(owner!==identity){destroy();owner=identity;}
    const current=++generation;controller?.abort();controller=new AbortController();loading=true;closePhoto();if(schedule.open)schedule.close();updateSave();
    try{
      const data=await api('/classes');
      if(current!==generation)return;
      classes=data.classes;cid=classes.some(c=>c.id===cid)?cid:classes[0]?.id||'';
      profile=draft=undefined;eventsSignature='';render();
      if(!cid)return;
      const value=await api('/classes/'+encodeURIComponent(cid));
      if(current!==generation||!allowed()||app().state.user.id!==identity)return;
      profile=value;draft=clone(value.config);conflict=false;render();await loadEvents(current);
    }catch(error){if(error.name!=='AbortError'&&current===generation){render();feedback(error.message,true);}}
    finally{if(current===generation){loading=false;updateSave();}}
  }
  async function loadEvents(current=generation) {
    const data=await api('/events?classId='+encodeURIComponent(cid));
    if(current!==generation||!visible()||!document.getElementById('ss-event-list'))return;
    photoRecords=new Map(data.events.map(e=>[e.id,e]));eventsTime=data.serverTime;eventsReceived=performance.now();
    refreshPhotoLifetime();
    const signature=JSON.stringify([data.pending,data.events]);
    if(signature===eventsSignature)return;eventsSignature=signature;
    setText('ss-pending',data.pending?data.pending+' 条待核实':'暂无待核实');
    document.getElementById('ss-event-list').innerHTML=data.events.length?data.events.map(e=>{
      const status=e.handled_at?(e.resolution==='false_alarm'?'已标记误报':'已处理'):e.status==='reported'?'待核实':e.status==='warning'?'已提醒':'已结束';
      const media={ready:'',expired:'照片已过期',failed:'本次未取得照片',pending:'照片正在提交',capturing:'照片正在提交',none:'未附照片'}[e.photo_status]||'';
      const title=e.status==='reported'?'提醒后仍有疑似闲聊':e.status==='warning'?'已进行轻声提醒':'本次观察已结束';
      return '<article class="ss-event"><time>'+esc(format(e.reported_at||e.started_at))+'</time><div class="ss-event-copy"><strong>'+esc(title)+'</strong><p>'+esc(media||'附现场照片，供您核实。')+'</p></div><span class="ss-event-status'+(e.handled_at?' ss-is-handled':'')+'">'+esc(status)+'</span><div class="ss-actions">'+
        (e.photo_status==='ready'?'<button type="button" class="btn" data-ss-photo="'+esc(e.id)+'">查看照片</button>':'')+
        (e.status==='reported'&&!e.handled_at?'<button type="button" class="btn" data-ss-review="'+esc(e.id)+'" data-resolution="false_alarm">标记误报</button><button type="button" class="btn" data-ss-review="'+esc(e.id)+'" data-resolution="handled">处理完成</button>':'')+'</div></article>';
    }).join(''):'<div class="ss-empty"><span class="ss-empty-mark">'+checkIcon+'</span><div><h3>暂无需要核实的记录</h3><p>教室恢复安静后，不会打扰班主任。</p></div></div>';
  }
  async function save(event) {
    event.preventDefault();if(saving||loading||conflict)return;
    if(draft.enabled&&!draft.authorized){feedback('启用前请确认学校已完成告知与授权。',true);document.getElementById('ss-feedback').focus();return;}
    const current=generation; saving=true;updateSave();
    root.querySelector('fieldset').disabled=true;
    try{
      const data=await api('/classes/'+encodeURIComponent(cid),{method:'PUT',body:JSON.stringify({config:draft,revision:profile.revision})});
      if(current!==generation)return;
      profile=data;draft=clone(data.config);conflict=false;feedback('设置已保存，教室端联网后自动同步。');renderRules();renderRuntime();
    }catch(error){if(current===generation){conflict=error.status===409;feedback(error.message,true);document.getElementById('ss-feedback')?.focus();}}
    finally{if(current===generation){saving=false;root.querySelector('fieldset').disabled=false;updateSave();}}
  }
  async function showPhoto(id) {
    closePhoto();const current=generation, version=++photoVersion, identity=owner;
    photo.innerHTML='<h2 id="ss-photo-title">教室现场照片</h2><p class="muted" role="status">正在载入…</p><button type="button" class="btn" data-ss-close-photo>关闭照片</button>';photo.showModal();
    photoEvent=id;refreshPhotoLifetime();if(!photo.open)return;
    try{
      const response=await fetch('/api/self-study/events/'+encodeURIComponent(id)+'/photo',{credentials:'same-origin',cache:'no-store',signal:controller?.signal});
      if(!response.ok)throw new Error('照片不可用或已过期，请重新载入记录。');
      const blob=await response.blob();
      if(current!==generation||version!==photoVersion||!photo.open||identity!==app()?.state.user?.id)return;
      photoUrl=URL.createObjectURL(blob);
      const img=document.createElement('img');img.src=photoUrl;img.alt='本班晚自习事件现场，供教师核实';img.width=1280;img.height=720;
      try{await img.decode();}catch{throw new Error('照片无法显示，请关闭后重新载入。');}
      if(current!==generation||version!==photoVersion||!photo.open||identity!==app()?.state.user?.id)return;
      photo.querySelector('p').remove();
      photo.insertBefore(img,photo.querySelector('button'));
    }catch(error){if(current===generation&&version===photoVersion&&photo.open){const message=photo.querySelector('p');message.setAttribute('role','alert');message.textContent=error.message;}}
  }
  root.addEventListener('submit',e=>{if(e.target.id==='ss-form')void save(e);});
  root.addEventListener('invalid',e=>{const details=e.target.closest('details');if(details)details.open=true;},true);
  root.addEventListener('input',e=>{
    const key=e.target.dataset.ssField;if(!key||!draft)return;
    draft[key]=e.target.type==='checkbox'?e.target.checked:e.target.type==='radio'?e.target.value:key==='voiceTriggerMs'?Math.round(e.target.valueAsNumber*1000):e.target.valueAsNumber;
    updateSave();renderRules();
  });
  root.addEventListener('change',e=>{
    if(e.target.id!=='ss-class')return;const next=e.target.value;e.target.value=cid;
    const proceed=()=>{cid=next;void load();};if(canLeave(proceed))proceed();
  });
  root.addEventListener('click',async e=>{
    const button=e.target.closest('button');if(!button||button.disabled)return;
    if(button.hasAttribute('data-ss-reload')){if(canLeave(load))void load();}
    else if(button.hasAttribute('data-ss-schedule')){if(profile&&!loading&&!schedule.open)schedule.showModal();}
    else if(button.hasAttribute('data-ss-timetable'))document.querySelector('[data-view="island"]').click();
    else if(button.dataset.ssPhoto)void showPhoto(button.dataset.ssPhoto);
    else if(button.dataset.ssReview){
      const current=generation;button.disabled=true;
      try{await api('/events/'+encodeURIComponent(button.dataset.ssReview)+'/review',{method:'POST',body:JSON.stringify({resolution:button.dataset.resolution})});
        if(current===generation){eventsSignature='';await loadEvents(current);feedback('处理结果已记录。');}
      }catch(error){if(current===generation){button.disabled=false;feedback(error.message,true);}}
    }
  });
  async function poll() {
    if(document.hidden||!allowed()||pollBusy)return;
    const identity=app().state.user.id;
    if(owner&&owner!==identity)destroy();
    owner=identity;pollBusy=true;const run=++pollGeneration;
    try{
      const data=await app().api('/api/self-study/events?limit=30');
      if(run!==pollGeneration||identity!==app()?.state.user?.id)return;
      const reported=data.events.filter(e=>e.status==='reported'&&!e.handled_at);
      const fresh=reported.filter(e=>!seen.has(e.id));
      reported.forEach(e=>seen.add(e.id));
      const badge=document.getElementById('ss-nav-count');badge.textContent=data.pending?' '+data.pending:'';badge.hidden=!data.pending;
      if(fresh.length){lastNotice=fresh[0].class_name+'晚自习有持续疑似闲聊，请查看待核实记录。';app().toast(lastNotice);}
      if(visible()&&cid&&profile&&!loading&&!saving){
        const current=generation;
        const value=await api('/classes/'+encodeURIComponent(cid));
        if(current!==generation||run!==pollGeneration)return;
        if(value.revision!==profile.revision){conflict=dirty();if(conflict)feedback('设置已更新，您有未保存的修改，请重新载入后核对。',true);else {profile=value;draft=clone(value.config);render();eventsSignature='';}}
        else profile={...value,config:profile.config};
        renderRuntime();updateSave();await loadEvents(current);
      }
    }catch{ /* User-initiated load has inline errors; silent polls retain existing data. */ }
    finally{if(run===pollGeneration)pollBusy=false;}
  }
  function destroy() {
    generation++;pollGeneration++;controller?.abort();closePhoto();leaveAction=undefined;leave.close();schedule.close();
    cid=owner='';profile=draft=undefined;classes=[];seen=new Set();pollBusy=saving=loading=false;eventsSignature='';
    photoRecords.clear();eventsTime=eventsReceived=0;
    document.getElementById('ss-schedule').replaceChildren();
    clearInterval(timer);timer=undefined;root.replaceChildren();
  }
  function ready() {
    const nav=document.querySelector('[data-view="self-study"]');
    if(!allowed()){destroy();return;}
    if(owner!==app().state.user.id)destroy();
    owner=app().state.user.id;clearInterval(timer);timer=setInterval(poll,20000);void poll();
    if(new URL(location.href).searchParams.get('view')==='self-study')nav.click();
  }
  window.ICeClassSelfStudy={load,canLeave,destroy};
  window.addEventListener('iceclass-ready',ready);
  window.addEventListener('iceclass-classes-changed',()=>{if(visible()&&!dirty())void load();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll();else closePhoto();});
  window.addEventListener('beforeunload',e=>{if(dirty()||saving){e.preventDefault();e.returnValue='';}});
  if(app()?.state.user)ready();
})();

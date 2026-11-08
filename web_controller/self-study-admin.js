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
  document.body.append(leave,photo);
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
    button.textContent=saving?'正在保存…':'保存设置';
    root.querySelector('#ss-dirty').textContent=dirty()?'有未保存的修改':'';
  }
  const toggle = (key,title,note='') => '<label class="ss-toggle"><input type="checkbox" name="'+key+'" data-ss-field="'+key+'"'+(draft[key]?' checked':'')+'><span>'+title+(note?'<small>'+note+'</small>':'')+'</span></label>';
  function render() {
    root.innerHTML = '<div class="ss-heading"><div><h1>晚自习管理</h1><p class="muted">先提醒安静，持续交谈再通知班主任。</p></div><button type="button" class="btn" data-ss-reload>重新载入</button></div>'+
      '<div class="ss-scope"><label for="ss-class">班级</label><select id="ss-class" name="self-study-class" autocomplete="off">'+classes.map(c=>'<option value="'+esc(c.id)+'"'+(cid===c.id?' selected':'')+'>'+esc(c.name)+'</option>').join('')+'</select></div>'+
      '<p id="ss-feedback" class="ss-feedback" role="status" aria-live="polite" tabindex="-1" hidden></p>'+
      (draft?'<div class="ss-layout"><section class="panel ss-settings" aria-labelledby="ss-settings-title"><h2 id="ss-settings-title">自动陪伴</h2><form id="ss-form">'+
        '<fieldset'+(saving?' disabled':'')+'><legend class="sr-only">监测与费用设置</legend>'+
        toggle('enabled','启用晚自习管理')+toggle('authorized','已完成学校告知与授权')+
        toggle('aiEnabled','允许少量文字交给现有 AI 复核','声音留在教室电脑，仅发送疑似片段的短文本和统计。')+
        toggle('photoEnabled','持续交谈时附一张教室照片','提醒后仍出现新的疑似交谈才拍摄，照片供班主任核实。')+
        '<div class="ss-budgets"><label for="ss-calls">每日复核上限<input id="ss-calls" name="dailyCalls" data-ss-field="dailyCalls" type="number" inputmode="numeric" min="0" max="4" step="1" autocomplete="off" value="'+draft.dailyCalls+'" required></label>'+
        '<label for="ss-tokens">每日 token 上限<input id="ss-tokens" name="dailyTokens" data-ss-field="dailyTokens" type="number" inputmode="numeric" min="1500" max="2400" step="1" autocomplete="off" value="'+draft.dailyTokens+'" required></label></div>'+
        '<p class="ss-note">复用班主任现有 AI 连接，每班每天最多 4 次、2400 token。余额不足以完成一次复核时停止；失败不自动重试。</p></fieldset>'+
        '<div class="ss-actions"><button class="btn primary" type="submit" data-ss-save>保存设置</button><span id="ss-dirty" role="status"></span></div></form></section>'+
        '<section class="panel ss-runtime" aria-labelledby="ss-runtime-title"><h2 id="ss-runtime-title">本班运行状态</h2><p id="ss-state" class="ss-state"></p><p id="ss-detail" class="muted"></p>'+
        '<dl class="ss-usage"><div><dt>今日复核</dt><dd id="ss-usage-calls"></dd></div><div><dt>今日 token</dt><dd id="ss-usage-tokens"></dd></div></dl>'+
        '<h3>跟随教室浮岛周课表</h3><p class="ss-note">第二节晚自习，自动沿用轮值、调课和停课安排。</p><ul id="ss-schedule" class="ss-schedule"></ul>'+
        '<button class="btn" type="button" data-ss-timetable>查看周课表</button></section></div>'+
        '<section class="panel ss-events" aria-labelledby="ss-events-title"><div class="ss-heading"><h2 id="ss-events-title">最近 7 天的记录</h2><span id="ss-pending" role="status"></span></div>'+
        '<p class="ss-note">讲题、学习问答和不明确的片段不会升级。照片保留 24 小时；请结合现场情况核实。</p><div id="ss-event-list"></div></section>'
        :'<div class="panel"><p class="muted">'+(classes.length?'正在载入设置…':'当前没有可管理的班级。')+'</p></div>');
    updateSave();renderRuntime();
  }
  const states = {inactive:'等待晚自习',observing:'正在观察',teaching:'可能正在讲题',warning:'已提醒安静',reported:'已通知班主任',budget:'今日复核已暂停',error:'需要检查',paused:'本节已暂停'};
  function renderRuntime() {
    if(!profile||!document.getElementById('ss-state'))return;
    const fresh=profile.status&&profile.serverTime-profile.status.updated_at<90000;
    document.getElementById('ss-state').textContent=!profile.config.enabled?'尚未启用':fresh?(states[profile.status.state]||'等待同步'):'等待教室端同步';
    document.getElementById('ss-detail').textContent=fresh?profile.status.detail:!profile.aiReady?'班主任尚未配置可用的 AI 连接。':'教室端联网后会在这里显示运行状态。';
    document.getElementById('ss-usage-calls').textContent=profile.usage.calls+' / '+profile.config.dailyCalls+' 次';
    document.getElementById('ss-usage-tokens').textContent=profile.usage.tokens+' / '+profile.config.dailyTokens+(profile.usage.estimated?'（含预占）':'');
    document.getElementById('ss-schedule').innerHTML=profile.schedule.length?profile.schedule.map(p=>'<li>'+esc(format(p.startAt,{weekday:'short'}))+'-'+esc(format(p.endAt,{month:undefined,day:undefined}))+(p.temporary?' · 调课':'')+'</li>').join(''):'<li>近期没有安排第二节晚自习，请先检查周课表。</li>';
  }
  async function api(path,options={}) {return app().api('/api/self-study'+path,{...options,signal:controller?.signal});}
  async function load() {
    if(!allowed())return;
    const identity=app().state.user.id;
    if(owner!==identity){destroy();owner=identity;}
    const current=++generation;controller?.abort();controller=new AbortController();loading=true;closePhoto();
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
    const signature=JSON.stringify(data);
    if(signature===eventsSignature)return;eventsSignature=signature;
    document.getElementById('ss-pending').textContent=data.pending?data.pending+' 条待核实':'';
    document.getElementById('ss-event-list').innerHTML=data.events.length?data.events.map(e=>{
      const status=e.handled_at?(e.resolution==='false_alarm'?'已标记误报':'已处理'):e.status==='reported'?'待核实':e.status==='warning'?'已提醒':'已恢复';
      const media={ready:'',expired:'照片已过期',failed:'本次未取得照片',pending:'照片正在提交',capturing:'照片正在提交',none:'未附照片'}[e.photo_status]||'';
      return '<article class="ss-event"><div><strong>'+esc(status)+'</strong><span>'+esc(format(e.reported_at||e.started_at))+'</span><p class="muted">'+esc(media||'提醒后持续交谈，附图供您核实。')+'</p></div><div class="ss-actions">'+
        (e.photo_status==='ready'?'<button type="button" class="btn" data-ss-photo="'+esc(e.id)+'">查看照片</button>':'')+
        (e.status==='reported'&&!e.handled_at?'<button type="button" class="btn" data-ss-review="'+esc(e.id)+'" data-resolution="false_alarm">标记误报</button><button type="button" class="btn" data-ss-review="'+esc(e.id)+'" data-resolution="handled">处理完成</button>':'')+'</div></article>';
    }).join(''):'<div class="ss-empty"><h3>还没有上报记录</h3><p>教室端会先提醒；恢复安静后，无需打扰班主任。</p></div>';
  }
  async function save(event) {
    event.preventDefault();if(saving||loading||conflict)return;
    if(draft.enabled&&!draft.authorized){feedback('启用前请确认学校已完成告知与授权。',true);document.getElementById('ss-feedback').focus();return;}
    const current=generation; saving=true;updateSave();
    root.querySelector('fieldset').disabled=true;
    try{
      const data=await api('/classes/'+encodeURIComponent(cid),{method:'PUT',body:JSON.stringify({config:draft,revision:profile.revision})});
      if(current!==generation)return;
      profile=data;draft=clone(data.config);conflict=false;feedback('设置已保存，教室端联网后自动同步。');renderRuntime();
    }catch(error){if(current===generation){conflict=error.status===409;feedback(error.message,true);document.getElementById('ss-feedback')?.focus();}}
    finally{if(current===generation){saving=false;root.querySelector('fieldset').disabled=false;updateSave();}}
  }
  async function showPhoto(id) {
    closePhoto();const current=generation, version=++photoVersion, identity=owner;
    photo.innerHTML='<h2 id="ss-photo-title">教室现场照片</h2><p class="muted">正在载入…</p><button type="button" class="btn" data-ss-close-photo>关闭照片</button>';photo.showModal();
    photoEvent=id;refreshPhotoLifetime();if(!photo.open)return;
    try{
      const response=await fetch('/api/self-study/events/'+encodeURIComponent(id)+'/photo',{credentials:'same-origin',cache:'no-store',signal:controller?.signal});
      if(!response.ok)throw new Error('照片不可用或已过期，请重新载入记录。');
      const blob=await response.blob();
      if(current!==generation||version!==photoVersion||!photo.open||identity!==app()?.state.user?.id)return;
      photoUrl=URL.createObjectURL(blob);
      photo.querySelector('p').remove();
      const img=document.createElement('img');img.src=photoUrl;img.alt='本班晚自习事件现场，供教师核实';img.width=1280;img.height=720;
      photo.insertBefore(img,photo.querySelector('button'));
    }catch(error){if(current===generation&&version===photoVersion&&photo.open)photo.querySelector('p').textContent=error.message;}
  }
  root.addEventListener('submit',e=>{if(e.target.id==='ss-form')void save(e);});
  root.addEventListener('input',e=>{
    const key=e.target.dataset.ssField;if(!key||!draft)return;
    draft[key]=e.target.type==='checkbox'?e.target.checked:e.target.valueAsNumber;updateSave();
  });
  root.addEventListener('change',e=>{
    if(e.target.id!=='ss-class')return;const next=e.target.value;e.target.value=cid;
    const proceed=()=>{cid=next;void load();};if(canLeave(proceed))proceed();
  });
  root.addEventListener('click',async e=>{
    const button=e.target.closest('button');if(!button||button.disabled)return;
    if(button.hasAttribute('data-ss-reload')){if(canLeave(load))void load();}
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
      if(fresh.length){lastNotice=fresh[0].class_name+'晚自习持续交谈，请查看待核实记录。';app().toast(lastNotice);}
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
    generation++;pollGeneration++;controller?.abort();closePhoto();leaveAction=undefined;leave.close();
    cid=owner='';profile=draft=undefined;classes=[];seen=new Set();pollBusy=saving=loading=false;eventsSignature='';
    photoRecords.clear();eventsTime=eventsReceived=0;
    clearInterval(timer);timer=undefined;root.replaceChildren();
  }
  function ready() {
    const nav=document.querySelector('[data-view="self-study"]');nav.classList.toggle('hidden',!allowed());
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

(() => {
  'use strict';
  const entry=document.getElementById('self-study-open');
  if(!entry)return;
  const dialog=document.createElement('dialog');
  dialog.className='glass management-dialog self-study-dialog';dialog.setAttribute('aria-labelledby','classroom-self-study-title');
  dialog.setAttribute('aria-describedby','classroom-ss-detail');
  dialog.innerHTML=`<span class="glass-lens" aria-hidden="true"></span>
    <svg class="svg-definitions" width="0" height="0" aria-hidden="true"><defs>
      <symbol id="ss-sound" viewBox="0 0 24 24"><path d="M4 10v4m4-7v10m4-13v16m4-13v10m4-7v4"/></symbol>
      <symbol id="ss-review" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5M7.5 10.5l2 2 4-4"/></symbol>
      <symbol id="ss-bell" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></symbol>
      <symbol id="ss-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></symbol>
      <symbol id="ss-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
      <symbol id="ss-pause" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></symbol>
    </defs></svg>
    <div class="glass-content management-dialog-content">
      <header class="dialog-header"><h2 id="classroom-self-study-title" tabindex="-1">自习管理</h2><button type="button" class="icon-button close-button" data-ss-close aria-label="关闭自习管理"><svg aria-hidden="true"><use href="#icon-close"/></svg></button></header>
      <div class="study-dialog-main">
      <div class="study-overview">
        <div class="study-status"><h3 id="classroom-ss-state" role="status" aria-live="polite">正在载入…</h3><p id="classroom-ss-detail"></p>
          <div class="study-schedule" role="group" aria-label="第二节晚自习时段"><svg aria-hidden="true"><use href="#ss-clock"/></svg><div><span id="classroom-ss-date"></span><span id="classroom-ss-schedule">正在载入…</span></div></div>
          <p id="classroom-ss-schedule-note" class="study-schedule-note" hidden>请班主任检查周课表</p>
        </div>
        <div class="study-art" aria-hidden="true"><img src="./illustrations/study-reading.webp" alt="" width="480" height="320" decoding="async"></div>
      </div>
      <ol class="study-flow" aria-label="自习处理流程，先提醒，再确认后通知老师">
        <li data-ss-stage="listening"><span class="study-step-icon"><svg aria-hidden="true"><use href="#ss-sound"/></svg></span><span>听声</span></li>
        <li data-ss-stage="analyzing"><span class="study-step-icon"><svg aria-hidden="true"><use href="#ss-review"/></svg></span><span>复核</span></li>
        <li data-ss-stage="warning"><span class="study-step-icon"><svg aria-hidden="true"><use href="#ss-bell"/></svg></span><span>提醒</span></li>
        <li data-ss-stage="reported"><span class="study-step-icon"><svg aria-hidden="true"><use href="#icon-people"/></svg></span><span>通知</span></li>
      </ol>
      <div class="study-usage"><label id="classroom-ss-usage-label" for="classroom-ss-meter">今日复核</label><meter id="classroom-ss-meter" min="0" max="4" value="0" aria-labelledby="classroom-ss-usage-label" hidden></meter><span id="classroom-ss-usage">正在载入…</span></div>
      <p id="classroom-ss-error" class="feedback" role="alert" hidden></p>
      <details class="study-rules"><summary><span id="classroom-ss-rules-label">规则待同步</span><svg aria-hidden="true"><use href="#ss-chevron"/></svg></summary><div id="classroom-ss-rules" hidden><p>自动适应背景声</p><dl class="study-rule-values">
        <div><dt>灵敏度</dt><dd id="classroom-ss-sensitivity"></dd></div><div><dt>声音持续</dt><dd id="classroom-ss-trigger"></dd></div>
        <div><dt>观察</dt><dd id="classroom-ss-observation"></dd></div><div><dt>提醒后等待</dt><dd id="classroom-ss-wait"></dd></div>
        <div><dt>再确认</dt><dd id="classroom-ss-confirmations"></dd></div>
      </dl></div><p id="classroom-ss-rules-empty" hidden>等待规则同步</p></details>
      </div>
      <footer class="study-dialog-footer"><button type="button" class="icon-button" data-ss-refresh aria-label="重新载入自习状态" title="重新载入自习状态"><svg aria-hidden="true"><use href="#icon-refresh"/></svg></button><button type="button" class="button soft" data-ss-pause><svg aria-hidden="true"><use href="#ss-pause"/></svg>暂停本次自习</button></footer>
    </div>`;
  document.body.append(dialog);
  let timer,busy=false,version=0;
  const states={inactive:'等待晚自习',listening:'正在听声',observing:'正在观察',analyzing:'AI 复核中',teaching:'学习交流中',warning:'请保持安静',reported:'已通知老师',budget:'AI 复核已暂停',ai_paused:'AI 复核已暂停',error:'需要检查',paused:'本节已暂停'};
  const stages={listening:'listening',observing:'listening',analyzing:'analyzing',teaching:'analyzing',warning:'warning',reported:'reported'};
  const time = (at,options)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...options}).format(new Date(at));
  function setText(id,value) {
    const element=dialog.querySelector('#classroom-ss-'+id);
    if(element.textContent!==value)element.textContent=value;
  }
  async function load(operation='status') {
    if(busy||!dialog.open)return;busy=true;
    const current=version,error=dialog.querySelector('#classroom-ss-error');
    const pause=dialog.querySelector('[data-ss-pause]'),refresh=dialog.querySelector('[data-ss-refresh]');pause.disabled=true;refresh.disabled=true;
    try{
      const data=await window.ICeClassHost.request('self-study',{operation});
      if(current!==version||!dialog.open)return;
      dialog.dataset.state=data.state;
      setText('state',states[data.state]||'等待同步');
      setText('detail',data.detail||'');
      for(const step of dialog.querySelectorAll('[data-ss-stage]')) {
        if(step.dataset.ssStage===stages[data.state])step.setAttribute('aria-current','step');
        else step.removeAttribute('aria-current');
      }
      const next=data.schedule?.find(p=>p.endAt>data.serverTime);
      setText('date',next?time(next.startAt,{month:'numeric',day:'numeric'}):'');
      setText('schedule',next?time(next.startAt,{hour:'2-digit',minute:'2-digit'})+'-'+time(next.endAt,{hour:'2-digit',minute:'2-digit'}):'暂无安排');
      dialog.querySelector('#classroom-ss-schedule-note').hidden=!!next;
      const meter=dialog.querySelector('#classroom-ss-meter');
      const hasUsage=!!data.usage&&!!data.config;
      setText('usage',hasUsage?data.usage.calls+' / '+data.config.dailyCalls+' 次':'暂无记录');
      meter.hidden=!hasUsage;
      if(hasUsage){meter.max=data.config.dailyCalls;meter.value=data.usage.calls;}
      error.hidden=true;
      const rules=data.config;
      setText('rules-label',rules?'已同步规则':'规则待同步');
      dialog.querySelector('#classroom-ss-rules').hidden=!rules;
      dialog.querySelector('#classroom-ss-rules-empty').hidden=!!rules;
      if(rules){
        setText('sensitivity',{low:'较低',balanced:'标准',high:'较高'}[rules.sensitivity]);
        setText('trigger',rules.voiceTriggerMs/1000+' 秒');
        setText('observation',rules.observationSeconds+' 秒');
        setText('wait','至少 '+rules.reminderWaitSeconds+' 秒');
        setText('confirmations',rules.confirmationsAfterReminder+' 次后通知老师');
      }
      pause.disabled=!data.inPeriod||data.paused;
    }catch(e){if(current===version&&dialog.open){error.textContent=e.message;error.hidden=false;}}
    finally{busy=false;refresh.disabled=false;}
  }
  entry.addEventListener('click',()=>{version++;dialog.showModal();dialog.querySelector('#classroom-self-study-title').focus();void load();clearInterval(timer);timer=setInterval(()=>{if(!document.hidden)void load();},5000);});
  dialog.addEventListener('close',()=>{version++;clearInterval(timer);});
  dialog.addEventListener('click',e=>{
    if(e.target.closest('[data-ss-close]'))dialog.close();
    else if(e.target.closest('[data-ss-refresh]'))void load();
    else if(e.target.closest('[data-ss-pause]'))void load('pause');
  });
})();

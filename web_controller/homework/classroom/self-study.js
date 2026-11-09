(() => {
  'use strict';
  const entry=document.getElementById('self-study-open');
  if(!entry)return;
  const dialog=document.createElement('dialog');
  dialog.className='glass detail-dialog';dialog.setAttribute('aria-labelledby','classroom-self-study-title');
  dialog.innerHTML='<span class="glass-lens" aria-hidden="true"></span><div class="glass-content detail-content">'+
    '<header><h2 id="classroom-self-study-title">自习管理</h2><button type="button" class="icon-button close-button" data-ss-close aria-label="关闭自习管理"><svg aria-hidden="true"><use href="#icon-close"/></svg></button></header>'+
    '<h3 id="classroom-ss-state" role="status" aria-live="polite">正在载入…</h3><p id="classroom-ss-detail"></p><p id="classroom-ss-schedule"></p><p id="classroom-ss-usage"></p><p id="classroom-ss-error" class="feedback" role="alert" hidden></p>'+
    '<details><summary>已同步规则</summary><p id="classroom-ss-rules"></p></details>'+
    '<div class="settings-actions"><button type="button" class="button soft" data-ss-refresh>重新载入</button><button type="button" class="button soft" data-ss-pause>暂停本节</button></div></div>';
  document.body.append(dialog);
  let timer,busy=false,version=0;
  const states={inactive:'等待晚自习',listening:'正在感知教室声音',observing:'正在观察',analyzing:'AI 复核中',teaching:'学习交流，继续观察',warning:'请保持安静',reported:'已通知班主任核实',budget:'AI 复核已暂停，声波继续',ai_paused:'AI 复核已暂停，声波继续',error:'需要检查',paused:'本节已暂停'};
  const time = (at,options={})=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',...options}).format(new Date(at));
  async function load(operation='status') {
    if(busy||!dialog.open)return;busy=true;
    const current=version,error=dialog.querySelector('#classroom-ss-error');
    const pause=dialog.querySelector('[data-ss-pause]');pause.disabled=true;
    try{
      const data=await window.ICeClassHost.request('self-study',{operation});
      if(current!==version||!dialog.open)return;
      dialog.querySelector('#classroom-ss-state').textContent=states[data.state]||'等待同步';
      dialog.querySelector('#classroom-ss-detail').textContent=data.detail;
      const next=data.schedule?.find(p=>p.endAt>data.serverTime);
      dialog.querySelector('#classroom-ss-schedule').textContent=next?'课表安排：'+time(next.startAt)+'-'+time(next.endAt,{month:undefined,day:undefined}):'近期没有第二节晚自习安排，由班主任在教师端检查周课表。';
      dialog.querySelector('#classroom-ss-usage').textContent=data.usage?'今日复核：'+data.usage.calls+' / '+data.config.dailyCalls+' 次':'';error.hidden=true;
      const rules=data.config;
      dialog.querySelector('#classroom-ss-rules').textContent='自动适应背景声 · '+({low:'较低',balanced:'标准',high:'较高'}[rules.sensitivity])+'灵敏度。声音持续 '+rules.voiceTriggerMs/1000+' 秒进入观察，积累 '+rules.observationSeconds+' 秒后复核；提醒后至少等 '+rules.reminderWaitSeconds+' 秒，再确认 '+rules.confirmationsAfterReminder+' 次才通知老师。';
      pause.disabled=!data.inPeriod||data.paused;
    }catch(e){if(current===version&&dialog.open){error.textContent=e.message;error.hidden=false;}}
    finally{busy=false;}
  }
  entry.addEventListener('click',()=>{version++;dialog.showModal();void load();clearInterval(timer);timer=setInterval(()=>{if(!document.hidden)void load();},5000);});
  dialog.addEventListener('close',()=>{version++;clearInterval(timer);});
  dialog.addEventListener('click',e=>{
    if(e.target.closest('[data-ss-close]'))dialog.close();
    else if(e.target.closest('[data-ss-refresh]'))void load();
    else if(e.target.closest('[data-ss-pause]'))void load('pause');
  });
})();

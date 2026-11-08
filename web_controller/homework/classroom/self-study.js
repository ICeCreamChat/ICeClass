(() => {
  'use strict';
  const entry=document.getElementById('self-study-open');
  if(!entry)return;
  const dialog=document.createElement('dialog');
  dialog.className='glass detail-dialog';dialog.setAttribute('aria-labelledby','classroom-self-study-title');
  dialog.innerHTML='<span class="glass-lens" aria-hidden="true"></span><div class="glass-content detail-content">'+
    '<header><h2 id="classroom-self-study-title">晚自习管理</h2><button type="button" class="icon-button close-button" data-ss-close aria-label="关闭晚自习管理"><svg aria-hidden="true"><use href="#icon-close"/></svg></button></header>'+
    '<h3 id="classroom-ss-state" role="status" aria-live="polite">正在载入…</h3><p id="classroom-ss-detail"></p><p id="classroom-ss-schedule"></p><p id="classroom-ss-usage"></p><p id="classroom-ss-error" class="feedback" role="alert" hidden></p>'+
    '<div class="settings-actions"><button type="button" class="button soft" data-ss-refresh>重新载入</button><button type="button" class="button soft" data-ss-pause>暂停本节</button></div></div>';
  document.body.append(dialog);
  let timer,busy=false,version=0;
  const states={inactive:'等待晚自习',observing:'正在观察',teaching:'可能正在讲题',warning:'请保持安静',reported:'已通知班主任',budget:'今日复核已暂停',error:'需要检查',paused:'本节已暂停'};
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

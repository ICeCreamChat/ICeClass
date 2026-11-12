(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const setText = (element, value) => { const text=String(value??'');if(element.textContent!==text)element.textContent=text; };
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = name => `<svg aria-hidden="true"><use href="#icon-${name}"/></svg>`;
  const pending = new Map();
  let sequence=0, initialized=false, view='management', className='', termLabel='', home, island, voice={recording:false,sending:false}, voicePanel=false;
  const native = Boolean(window.ICeClassNativeHome);
  document.body.classList.toggle('native-home',native);
  const systemTransparency=matchMedia('(prefers-reduced-transparency: reduce)');
  const forcedColors=matchMedia('(forced-colors: active)');
  let appearanceChosen=false,preference={material:'glass',reduceTransparency:false};
  try {const saved=JSON.parse(localStorage.getItem('iceclass.classroom.appearance')||'null');if(saved&&typeof saved==='object'){appearanceChosen=true;preference={material:saved.material==='white'?'white':'glass',reduceTransparency:Boolean(saved.reduceTransparency)};}} catch {}
  const reducedTransparency=()=>preference.reduceTransparency||(!appearanceChosen&&systemTransparency.matches);
  function applyAppearance() {
    const reduced=reducedTransparency();
    document.body.dataset.material=preference.material;
    document.body.dataset.classroomTransparency=appearanceChosen?(preference.reduceTransparency?'reduced':'full'):'auto';
    document.body.classList.toggle('reduce-transparency',reduced);
    document.querySelectorAll('button[data-material]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.material===preference.material)));
    if($('clear-setting'))$('clear-setting').checked=reduced;
    window.dispatchEvent(new Event('iceclass-appearance-change'));
    if(native)window.chrome.webview.postMessage({type:'classroom-appearance',state:{material:preference.material,
      effective:forcedColors.matches?'contrast':preference.material==='white'?'white':reduced?'reduced':'glass',
      source:appearanceChosen?'classroom':'system',systemReducedTransparency:systemTransparency.matches,forcedColors:forcedColors.matches}});
  }
  function saveAppearance() {appearanceChosen=true;applyAppearance();try{localStorage.setItem('iceclass.classroom.appearance',JSON.stringify(preference));}catch{notify('外观已应用，暂时无法记住此设置。');}}
  systemTransparency.addEventListener('change',applyAppearance);
  forcedColors.addEventListener('change',applyAppearance);
  function request(action,value={}) {
    if(!native)return Promise.reject(new Error('请从教室客户端打开此功能。'));
    const id=++sequence;
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('操作超时，请检查连接后重试。'));},30000);
      pending.set(id,{resolve,reject,timeout});
      window.chrome.webview.postMessage({id,action,...value});
    });
  }
  window.ICeClassHost={request,get date(){return island?.date;}};
  let toastTimer;
  function notify(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').classList.add('visible');toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),4000);}
  function heading(){
    setText($('page-title'),view==='home'?className||'本班教室':'班级管理');
    setText($('page-subtitle'),view==='home'?termLabel:[className,termLabel].filter(Boolean).join(' · '));
  }
  function showView(next){
    view=next;document.body.dataset.view=next;
    $('home-view').hidden=next!=='home';$('management-view').hidden=next!=='management';heading();
    window.scrollTo(0,0);
    if(next==='management')document.querySelector('[data-action="homework"]').focus({preventScroll:true});
    window.dispatchEvent(new CustomEvent('classroom-view-change',{detail:next}));
  }
  function showDetail(title,content){voicePanel=false;$('detail-title').textContent=title;$('detail-body').innerHTML=content;$('detail-dialog').showModal();}
  function renderVoice(){
    const button=document.querySelector('[data-action="voice"]');setText(button,voice.recording?'正在留言':voice.sending?'正在发送…':'开始留言');button.disabled=voice.sending;
    setText($('voice-duration'),voice.duration||'最长 30 秒');
    setText($('voice-status').querySelector('span'),voice.status||'仅本班授权老师可收听');
    $('voice-status').classList.toggle('success',Boolean(voice.success));
    document.querySelector('.voice-card').classList.toggle('is-recording',voice.recording);
    if(!voicePanel||!$('detail-dialog').open)return;
    const action=document.querySelector('[data-action="voice-toggle"]');
    setText(action,voice.recording?'结束并发送':voice.sending?'正在发送…':'开始录音');action.disabled=voice.sending;
    setText($('voice-panel-time'),voice.recording?voice.duration:'最长 30 秒');
    $('voice-panel-time').classList.toggle('is-recording',voice.recording);
    setText($('voice-panel-status'),voice.status||'');
    $('voice-panel-status').classList.toggle('success',Boolean(voice.success));
    document.querySelector('.detail-voice').classList.toggle('voice-recording',voice.recording);
  }
  function renderLessons(value){
    const periods=[['morning','上午'],['noon','中午'],['afternoon','下午'],['evening','晚上']].map(([key,label])=>({key,label,lessons:[]}));
    for(const lesson of value.lessons){
      const period=lesson.start<'12:00'?0:lesson.start<'14:00'?1:lesson.start<'18:00'?2:3;
      periods[period].lessons.push(lesson);
    }
    const groups=periods.filter(period=>period.lessons.length),list=$('lesson-list');
    list.innerHTML=groups.length?groups.map(period=>{
      const lessons=period.lessons.map(lesson=>{
        const name=esc(lesson.name),start=esc(lesson.start),end=esc(lesson.end),date=esc(value.date);
        return `<li class="day-lesson${lesson.current?' is-current':''}"${lesson.next?' data-next':''}${lesson.current?` aria-current="true" aria-label="${name}，正在上课，${start}-${end}"`:''}><div class="lesson-subject"><strong>${name}</strong></div><small><time datetime="${date}T${start}:00+08:00">${start}</time>-<time datetime="${date}T${end}:00+08:00">${end}</time></small></li>`;
      }).join('');
      return `<section class="period-block" aria-labelledby="period-${period.key}"><header class="period-header"><h2 id="period-${period.key}"><span class="module-icon blue period-icon"><img src="./icons/${period.key}.webp" alt="${period.label}" title="${period.label}" width="144" height="192" decoding="async"></span></h2></header><ol class="period-lessons" style="--lesson-columns:${Math.ceil(period.lessons.length/2)}">${lessons}</ol></section>`;
    }).join(''):`<p class="schedule-empty" role="status">${value.scheduleKnown?'今天没有课程':'课表同步后显示全天课程'}</p>`;
  }
  function renderIsland(value){
    if(!value)return;
    const previous=island;island=value;
    if(value.date!==previous?.date){
      const date=new Date(value.date+'T12:00:00+08:00');
      if(!Number.isNaN(date.getTime())){
        const [,month,day]=value.date.split('-');
        $('calendar-day').dateTime=value.date;$('calendar-day').hidden=false;
        $('calendar-date').innerHTML=`${Number(month)}<span>月</span>${Number(day)}<span>日</span>`;
        setText($('calendar-weekday'),new Intl.DateTimeFormat('zh-CN',{weekday:'long',timeZone:'Asia/Shanghai'}).format(date));
      }
      window.dispatchEvent(new Event('classroom-day-change'));
    }
    const lessonsChanged=!previous||value.date!==previous.date||value.scheduleKnown!==previous.scheduleKnown||value.lessons.length!==previous.lessons.length
      ||value.lessons.some((lesson,index)=>{const old=previous.lessons[index];return lesson.name!==old.name||lesson.start!==old.start||lesson.end!==old.end||lesson.current!==old.current||lesson.next!==old.next;});
    if(lessonsChanged)renderLessons(value);
    const notice=value.notice;
    if(!previous||Boolean(previous.notice)!==Boolean(notice)){$('daily-course').hidden=Boolean(notice);$('shout-course').hidden=!notice;}
    if(notice){
      setText($('shout-sender'),`${notice.sender} · ${notice.category}`);setText($('shout-text'),notice.text);
      const progress=document.querySelector('.shout-progress');progress.style.animation='none';progress.style.transform=`scaleX(${Math.max(0,Math.min(1,notice.progress))})`;
    }
  }
  function renderHome(state){
    home=state;className=state.className;heading();
    setText($('device-caption'),state.deviceCaption);
    setText($('connection-text'),state.connected?'已连接平台':state.connectionText);
    $('connection').classList.toggle('offline',!state.connected);
    document.querySelectorAll('[data-action="reading"],[data-action="voice"],[data-action="plan"],[data-action="banban"]').forEach(button=>{
      const action=button.dataset.action;button.disabled=action==='voice'?state.voice.sending:!state.capabilities[action];
    });
    voice=state.voice;renderVoice();
    document.querySelector('.course-area').hidden=false;
    if(state.island)renderIsland(state.island);
    if(!initialized){initialized=true;showView('home');}
  }
  if(native){
    window.chrome.webview.addEventListener('message',event=>{
      const value=event.data;if(!value||typeof value!=='object')return;
      if(value.type==='response'){
        const task=pending.get(value.id);if(!task)return;clearTimeout(task.timeout);pending.delete(value.id);
        value.error?task.reject(new Error(value.error)):task.resolve(value.value);
      }else if(value.type==='home-state')renderHome(value.state);
      else if(value.type==='island-state')renderIsland(value.state);
      else if(value.type==='voice-state'){voice=value.state;renderVoice();}
      else if(value.type==='open-management')showView('management');
    });
    window.chrome.webview.postMessage({type:'classroom-ready'});
  }
  window.addEventListener('homework-context',event=>{className=event.detail.className;termLabel=event.detail.term;heading();if(!native){$('connection-text').textContent='已连接平台';}});
  document.addEventListener('click',async event=>{
    const control=event.target.closest('[data-action],button[data-material]');if(!control||control.disabled)return;
    if(control.tagName==='A')event.preventDefault();
    if(control.dataset.material){preference.material=control.dataset.material;if(preference.material==='glass')preference.reduceTransparency=false;saveAppearance();return;}
    const action=control.dataset.action;
    try{
      if(action==='home'){if(native)showView('home');else window.chrome?.webview?.postMessage('close');}
      else if(action==='management')showView('management');
      else if(action==='close-detail')$('detail-dialog').close();
      else if(action==='workshop')showDetail('创意工坊','<p>收集各学科的创意与互动作品，供课堂交流使用。</p><p>工坊正在筹备，敬请期待。</p>');
      else if(action==='settings')showDetail('教室设置',`<div class="settings-row"><span>教室外观</span><div class="material-switch" role="group" aria-label="教室外观"><button data-material="glass" aria-pressed="${preference.material==='glass'}">液态玻璃</button><button data-material="white" aria-pressed="${preference.material==='white'}">原版白色</button></div></div><label class="settings-row"><span>降低透明度<small>使用更实的底色，让文字更清晰。</small></span><input type="checkbox" id="clear-setting" name="reduce-transparency"${reducedTransparency()?' checked':''}></label><div class="settings-actions"><button class="button soft" data-action="binding">教室绑定与连接</button><button class="button soft" data-action="island">教室浮岛</button></div>`);
      else if(action==='voice'){
        showDetail('语音留言',`<div class="voice-message">
          <div class="detail-voice">${icon('mic')}</div>
          <p class="voice-prompt">想说的话，安心告诉老师。</p>
          <p class="recording-time" id="voice-panel-time">最长 30 秒</p>
          <button class="button primary" data-action="voice-toggle">开始录音</button>
          <p class="voice-feedback" id="voice-panel-status" role="status" aria-atomic="true"></p>
          <div class="voice-privacy"><span class="voice-access">${icon('lock')}<span>仅本班授权老师可收听</span></span><span class="voice-retention">留言最长保留 30 分钟</span></div>
        </div>`);
        voicePanel=true;renderVoice();
      }else if(action==='voice-toggle'){await request('voice');}
      else if(action==='acknowledge')await request('acknowledge',{sequence:island?.notice?.sequence});
      else if(['reading','plan','banban','binding','island','about'].includes(action)){
        if(action==='reading')control.disabled=true;
        try{await request(action);if(action==='reading')$('reading-status').querySelector('span').textContent='时段内的活动计入本班记录，联网后同步。';}
        finally{if(action==='reading')control.disabled=false;}
      }
    }catch(error){notify(error.message);if(action==='reading')$('reading-status').querySelector('span').textContent=error.message;}
  });
  document.addEventListener('change',event=>{if(event.target.id==='clear-setting'){preference.reduceTransparency=event.target.checked;saveAppearance();}});
  $('detail-dialog').addEventListener('close',()=>{if(voicePanel&&voice.recording)void request('cancel-voice').catch(error=>notify(error.message));voicePanel=false;});
  $('detail-dialog').addEventListener('click',event=>{if(event.target!==$('detail-dialog'))return;const r=event.target.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)event.target.close();});
  applyAppearance();
})();

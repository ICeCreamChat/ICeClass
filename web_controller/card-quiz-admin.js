(() => {
  'use strict';
  const root = document.getElementById('cardQuizRoot');
  if (!root) return;
  const app = () => window.ICeClass, esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api = (path, method = 'GET', data, signal) => app().api('/api/card-quiz' + path, {
    method, signal, ...(data === undefined ? {} : {body:JSON.stringify(data)})
  });
  const clone = v => JSON.parse(JSON.stringify(v));
  const subjects = [['chinese','语文'],['math','数学'],['english','英语'],['physics','物理'],['chemistry','化学'],['biology','生物'],['politics','政治'],['history','历史'],['geography','地理']];
  const names = Object.fromEntries(subjects), statuses = {correct:'正确',wrong:'错误',incomplete:'未完成',unanswered:'未答',abstained:'弃权',exempt:'免答',ungraded:'未判定',practice:'练习'};
  const option = (values,current) => values.map(([value,label])=>`<option value="${esc(value)}"${value===current?' selected':''}>${esc(label)}</option>`).join('');
  const button = (action,text,primary=false,extra='') => `<button type="button" class="btn${primary?' primary':''}" data-cq-action="${action}"${busy?' disabled':''} ${extra}>${text}</button>`;
  const rate = value => value === null || value === undefined ? '未判定' : (value*100).toFixed(1) + '%';
  const date = at => new Date(at).toLocaleString('zh-CN',{hour12:false});
  let owner = '', cid = '', tab = 'cards', subject = '', generation = 0, busy = false, changed = false, conflict = false;
  let cards, cardsDraft, bank = [], decks = [], publications = [], report, detail, editor, message = '', failed = false;
  let accounts, accountsError = '', accountsConflict = false, credentials = [], accountSelection = new Set();
  const entryYear = String(new Date().getFullYear());
  let accountClassCode = '', accountDraft = newAccountDraft();
  function newAccountDraft() { return {entryYear,classCode:accountClassCode,studentId:'',username:'',firstNumber:'1',lastNumber:'60'}; }
  const ui = window.ICeClassUI, draftLabel = '纸卡答题', credentialsLabel = '纸卡学生密码发放表';
  let workEpoch = 0;
  function discard() {
    if (editor?.kind === 'import') { editor.dispose(); notify(); }
    editor = undefined; changed = conflict = false; cardsDraft = cards && clone(cards.students);
    accountDraft = newAccountDraft();
    accountSelection.clear();
    credentials = []; root.querySelector('.cq-credentials')?.remove();
  }
  const confirm = (title, message, acceptLabel, danger = false) => ui.ask({title,message,acceptLabel,danger});
  function notify(text='',error=false) { message=text;failed=error;const node=root.querySelector('.cq-feedback');if(node){node.textContent=text;node.hidden=!text;node.classList.toggle('cq-error',error);node.setAttribute('role',error?'alert':'status');} }
  const draftFields = () => accountDraft.classCode.trim() !== accountClassCode || accountDraft.studentId || accountDraft.username.trim() || accountDraft.entryYear !== entryYear;
  const allowReplace = action => ui.confirmLeave(action, {only:[draftLabel, credentialsLabel]});
  async function canLeave(action = '离开纸卡答题') {
    if (!await allowReplace(action)) return false;
    if (editor?.kind === 'import') { discard(); render(); }
    else if (changed || credentials.length || draftFields()) discard();
    return true;
  }
  async function afterLeave(task, action) { if (await canLeave(action)) await task(); }
  async function work(task, accountWrite=false) {
    if (busy) return false;
    const epoch = workEpoch;
    busy = true; render();
    try { await task(); return epoch === workEpoch; }
    catch(error) {
      if(epoch!==workEpoch)return false;
      if(accountWrite && error.status===409)accountsConflict=true;else if(editor?.kind!=='import')conflict ||= error.status===409;
      notify(error.message+(accountWrite&&error.status===409?' 请重新载入，核对名单、卡号和账号版本后再操作。':''),true);
      return false;
    }
    finally {
      if(epoch===workEpoch){
        const restore = root.contains(document.activeElement) || document.activeElement === document.body;
        busy=false;render();
        if(accountWrite && restore && credentials.length) root.querySelector('.cq-credentials h2')?.focus();
      }
    }
  }
  function markChanged() { changed=true;const node=root.querySelector('.cq-dirty');if(node)node.textContent='尚未保存';const save=root.querySelector('[data-cq-action^="save-"]');if(save)save.disabled=busy||conflict;if(tab==='cards'){root.querySelectorAll('.cq-account-form input,.cq-account-form select,.cq-account-form button,[data-account-student],#cq-accounts-all,[data-cq-action="reset-accounts"]').forEach(n=>n.disabled=true);} }
  function table(headings,rows,label,tableClass='') { return `<div class="cq-table-wrap" role="region" aria-label="${esc(label)}" tabindex="0"><table class="cq-table ${tableClass}"><thead><tr>${headings.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.join(''):`<tr><td colspan="${headings.length}">暂无记录</td></tr>`}</tbody></table></div>`; }
  function renderCards() {
    if (!cards) return '<p class="cq-empty">请选择班级并载入名单。</p>';
    const canPrint=cards.canEdit&&accounts?.canEdit;
    const rows=(cardsDraft||cards.students).map(s=>{
      const account=accounts?.students.find(a=>a.studentId===s.id), printable=canPrint&&account?.accountId&&account.activeHere&&s.cardNumber;
      return `<tr><td>${esc(s.name)}</td><td>${cards.canEdit?`<input type="number" min="1" max="157" aria-label="${esc(s.name)}的卡号" data-card-student="${esc(s.id)}" value="${s.cardNumber??''}"${busy?' disabled':''}>`:s.cardNumber??'未分配'}</td><td>${printable?button('print-one','代印此卡（重置密码）',false,`data-card="${s.cardNumber}"`):!s.cardNumber?'未分配':canPrint?'请先生成或关联账号':'仅名单管理员可代印'}</td></tr>`;
    });
    return `<section class="cq-panel"><div class="cq-item-head"><h2>本班纸卡</h2><div class="cq-actions">${cards.canEdit?button('initialize','分配缺失卡号')+button('save-cards','保存卡号',true,(!changed||conflict)?'disabled':''):''}${canPrint?button('print-all','代印全班（重置密码）'):''}</div></div><p class="cq-note">沿用作业登记中的班级名单，支持 1-157 号。换号保留历史，旧号不会自动分给其他同学。${cards.canEdit?'教师代印需明确重置密码；学生可用当前密码自行补印。':'当前为只读权限，名单管理员可以修改卡号、管理账号和代印。'}</p><p class="cq-dirty">${changed?'尚未保存，账号操作前请先保存卡号。':''}</p>${table(['学生','卡号（留空解绑）','教师代印'],rows,'本班学生纸卡编号')}</section>${renderAccounts()}`;
  }
  function renderAccounts() {
    if(!accounts)return `<section class="cq-panel"><h2>学生账号</h2><p class="cq-note${accountsError?' cq-error':''}" role="${accountsError?'alert':'status'}">${esc(accountsError||'正在读取账号信息…')}</p>${accountsError?button('retry-accounts','重试读取账号'):''}</section>`;
    const writable=accounts.canEdit&&!changed&&!accountsConflict&&!conflict&&!busy;
    const available=accounts.students.filter(s=>s.accountId&&s.activeHere);
    const eligible=accounts.students.filter(s=>!s.accountId&&s.cardNumber!=null);
    const unlinked=accounts.students.filter(s=>!s.accountId);
    const rows=accounts.students.map(s=>`<tr><td>${accounts.canEdit&&s.accountId&&s.activeHere?`<input type="checkbox" data-account-student="${esc(s.studentId)}" aria-label="选择${esc(s.name)}的账号 ${esc(s.username)}"${accountSelection.has(s.studentId)?' checked':''}${!writable?' disabled':''}>`:'-'}</td><td>${esc(s.name)}</td><td>${s.cardNumber??'未分配'}</td><td class="cq-account-number">${esc(s.username||(accounts.canEdit?'尚未关联':'仅管理员可查看'))}</td><td>${!accounts.canEdit?'只读':s.accountId?s.activeHere?'当前关联':'保留历史关联':'待生成或关联'}</td></tr>`);
    return `${accounts.canEdit ? `<section class="cq-panel"><h2>按号发通用卡</h2>
      <p class="cq-note">每张卡有固定编号和密码，可重复发放。持卡人可查本班最近一节通用卡课堂中该号的报告。</p>
      <form id="cq-number-form" class="cq-account-form" data-account-form="issue-number-cards"><div class="cq-fields">
        ${[['firstNumber','起始卡号'],['lastNumber','结束卡号']].map(([key,label])=>`<label>${label}<input name="${key}" data-account-field="${key}" type="number" inputmode="numeric" min="1" max="157" step="1" autocomplete="off" required value="${esc(accountDraft[key])}"${!writable?' disabled':''}></label>`).join('')}
      </div><div class="cq-actions"><button type="submit" class="btn primary"${!writable?' disabled':''}>生成缺失号卡</button>
      ${(accounts.numberCards||[]).length?button('reset-number-cards','补印所选号段（重置密码）',false,!writable?'disabled':''):''}</div></form></section>`:''}
    <section class="cq-panel" aria-labelledby="cq-accounts-title">
      <h2 id="cq-accounts-title">学生账号</h2>
      <p class="cq-note">编号长期保留，升班、转班或换卡不重新生成。密码为独立六位数字，生成和重置时仅返回一次。</p>
      ${accountsConflict?'<p class="cq-note cq-error" role="alert">名单、卡号或账号版本已变化。请重新载入核对后再操作。</p>':''}
      ${accounts.canEdit?`<form id="cq-generate-form" class="cq-account-form" data-account-form="generate-accounts"><div class="cq-fields"><label>入学年份<input name="entryYear" data-account-field="entryYear" inputmode="numeric" type="number" min="2000" max="2099" step="1" required value="${esc(accountDraft.entryYear)}"${!writable?' disabled':''}></label><label>首次发放班级编码<input name="classCode" data-account-field="classCode" inputmode="numeric" pattern="[123](0[1-9]|[1-9][0-9])" maxlength="3" minlength="3" required value="${esc(accountDraft.classCode)}" aria-describedby="cq-class-code-help"${!writable?' disabled':''}></label></div><p id="cq-class-code-help" class="cq-note">三位编码：年级 1/2/3 + 班号 01-99，例如高一（9）班为 109。仅为有卡号且未关联的 ${eligible.length} 人生成，已有账号不覆盖。</p><button type="submit" class="btn primary" data-cq-action="generate-accounts"${!writable||!eligible.length?' disabled':''}>批量生成账号和初始密码</button></form>`:'<p class="cq-note">当前为只读权限，账号发放、关联、重置和代印由名单管理员操作。</p>'}
      <div class="cq-account-tools">${accounts.canEdit?`<label class="cq-choice"><input type="checkbox" id="cq-accounts-all"${available.length&&available.every(s=>accountSelection.has(s.studentId))?' checked':''}${!writable||!available.length?' disabled':''}><span>选择本班已关联账号</span></label><div class="cq-actions"><span id="cq-selected-count">已选 ${accountSelection.size} 人</span>${button('reset-accounts','重置所选密码',false,!writable||!accountSelection.size?'disabled':'')}</div>`:''}</div>
      ${table(['选择','学生','卡号','编号（学生账号）','关联状态'],rows,'本班学生账号')}
      ${accounts.canEdit&&unlinked.length?`<details class="cq-link-account"><summary>转班或升班：关联已有账号</summary><p class="cq-note">明确选择本班学生并输入其原账号编号，不按姓名或卡号猜测身份。需要同时管理原班与本班；关联后保留原历史，密码不变。</p><form id="cq-link-form" class="cq-account-form" data-account-form="link-account"><div class="cq-fields"><label>本班学生<select name="studentId" data-account-field="studentId" required${!writable?' disabled':''}><option value="">请选择学生</option>${option(unlinked.map(s=>[s.studentId,s.name+' · '+(s.cardNumber==null?'未分配卡号':s.cardNumber+' 号卡')]),accountDraft.studentId)}</select></label><label>原学生账号编号<input name="username" data-account-field="username" inputmode="numeric" pattern="[0-9]+" maxlength="32" autocomplete="off" required value="${esc(accountDraft.username)}"${!writable?' disabled':''}></label></div><button type="submit" class="btn" data-cq-action="link-account"${!writable?' disabled':''}>关联原账号并保留历史</button></form></details>`:''}
    </section>${credentials.length?`<section class="cq-panel cq-credentials" aria-labelledby="cq-credentials-title"><div class="cq-item-head"><h2 tabindex="-1" id="cq-credentials-title">本次发放表 · ${credentials.length} ${credentials[0]?.numberCard?'张':'人'}</h2><div class="cq-actions">${button('print-issued','打印本次纸卡',true,credentials.some(c=>c.cardNumber!=null)?'':'disabled')}${button('download-credentials','下载发放表 CSV')}${button('clear-credentials','清除本次密码')}</div></div><p class="cq-note">有卡号的学生可直接打印本次密码。离开后无法找回，请在发放完毕后清除。</p>${table(['学生','班级','编号','卡号','六位密码'],credentials.map(c=>`<tr><td>${esc(accounts.students.find(s=>s.studentId===c.studentId)?.name||(c.numberCard?c.cardNumber+' 号卡':''))}</td><td>${esc(c.className)}</td><td>${esc(c.username)}</td><td>${c.cardNumber??'未分配'}</td><td class="cq-password">${esc(c.password)}</td></tr>`),'本次一次性账号密码发放表')}</section>`:''}`;
  }
  function syncAccountSelection() {
    const all=root.querySelector('#cq-accounts-all'), count=root.querySelector('#cq-selected-count');
    if(count)count.textContent='已选 '+accountSelection.size+' 人';
    if(all){const available=accounts.students.filter(s=>s.accountId&&s.activeHere);all.checked=!!available.length&&available.every(s=>accountSelection.has(s.studentId));all.indeterminate=accountSelection.size>0&&!all.checked;}
    const reset=root.querySelector('[data-cq-action="reset-accounts"]');
    if(reset)reset.disabled=busy||changed||conflict||accountsConflict||!accountSelection.size||!accounts?.canEdit;
  }
  async function readAccounts() {
    const classAt=cid, userAt=owner, request=generation;
    const current=()=>request===generation&&classAt===cid&&userAt===owner&&userAt===app()?.state.user?.id;
    try {
      const result=await api('/classes/'+encodeURIComponent(classAt)+'/students');
      if(!current())return;
      if(result.classId!==classAt)throw new Error('账号信息与当前班级不一致，请重试。');
      const followsSuggestion=accountDraft.classCode===accountClassCode;
      accountClassCode=result.classCode||'';
      if(followsSuggestion)accountDraft.classCode=accountClassCode;
      accounts=result;accountsError='';accountsConflict=false;accountSelection.clear();
    } catch(error) { if(current()){accounts=undefined;accountsError=error.message;} }
  }
  const accountVersions = () => ({revision:accounts.revision,rosterRevision:accounts.rosterRevision,cardRevision:accounts.cardRevision});
  function printIssued() {
    const panel=root.querySelector('.cq-credentials');
    if(!panel || !accounts?.canEdit || !credentials.length || app().state.sessionExpired || owner!==app().state.user?.id)return;
    const batch=credentials.filter(card=>card.cardNumber!=null).sort((a,b)=>a.cardNumber-b.cardNumber);
    if(!batch.length)return;
    const current=accounts.students;
    const matches=card=>card.numberCard ? accounts.numberCards?.some(s=>s.accountId===card.accountId && s.cardNumber===card.cardNumber) : current.some(s=>s.activeHere && s.accountId===card.accountId && s.cardNumber===card.cardNumber);
    if(changed || batch.some(card=>card.classId!==cid || !matches(card))){
      notify('卡号已变化，请先核对名单，再为对应学生打印。',true);return;
    }
    panel.querySelector('.cq-issued-frame')?.remove();
    const frame=document.createElement('iframe');
    frame.className='cq-issued-frame';frame.title='本次纸卡打印';frame.tabIndex=-1;
    frame.setAttribute('aria-hidden','true');
    frame.onload=async()=>{
      if(!frame.isConnected || app().state.sessionExpired || owner!==app().state.user?.id)return;
      try{
        if(!frame.contentWindow.printIssuedCards)throw new Error('打印页未能载入，请重新点击打印。');
        await frame.contentWindow.printIssuedCards(batch);
      }catch(error){if(frame.isConnected){frame.remove();notify(error.message,true);}}
    };
    frame.src='/card-quiz/print.html?issued';panel.append(frame);
  }
  function downloadCredentials() {
    const cell=(value,text=false)=>{let s=String(value??'');if(text||/^[\s\u0000-\u001f]*[=+@-]/.test(s)||/^[\t\r\n]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
    const rows=[['班级','学生','编号','卡号','密码'].map(v=>cell(v)).join(',')];
    for(const c of credentials)rows.push([cell(c.className),cell(accounts.students.find(s=>s.studentId===c.studentId)?.name),cell(c.username,true),cell(c.cardNumber),cell(c.password,true)].join(','));
    const url=URL.createObjectURL(new Blob(['\ufeff',rows.join('\r\n')],{type:'text/csv;charset=utf-8'})), link=document.createElement('a');
    link.href=url;link.download='学生账号发放表.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
    notify('发放表已生成。请妥善保管，完成发放后清除本次密码。');
  }
  function accountAction(action) {
    if(action==='print-issued'){printIssued();return;}
    if(action==='download-credentials'){if(credentials.length)downloadCredentials();return;}
    if(action==='clear-credentials'){credentials=[];render();notify('本次密码已从页面清除。');return;}
    if(!accounts?.canEdit){notify('只有名单管理员可以管理学生账号。',true);return;}
    if(changed||accountsConflict||conflict){notify('请先保存卡号，或重新载入核对版本后再管理账号。',true);return;}
    const numberCards=action==='issue-number-cards'||action==='reset-number-cards';
    const form=root.querySelector(numberCards?'#cq-number-form':action==='generate-accounts'?'#cq-generate-form':action==='link-account'?'#cq-link-form':'[data-no-form]');
    if(form&&!form.reportValidity())return;
    const versions=accountVersions(), classAt=cid, userAt=owner, generationAt=generation;
    const body=numberCards?{...versions,firstNumber:Number(accountDraft.firstNumber),lastNumber:Number(accountDraft.lastNumber)}:action==='generate-accounts'?{...versions,entryYear:Number(accountDraft.entryYear),classCode:accountDraft.classCode}:
      action==='reset-accounts'?{...versions,studentIds:[...accountSelection]}:{...versions,studentId:accountDraft.studentId,username:accountDraft.username.trim()};
    if(numberCards && body.lastNumber < body.firstNumber){notify('结束卡号须大于或等于起始卡号。',true);form.elements.lastNumber.focus();return;}
    if(action==='reset-accounts'&&!body.studentIds.length)return;
    void work(async()=>{
      if(credentials.length)throw new Error('请先发放并清除本次密码，再执行新的账号操作。');
      if(action==='reset-number-cards'&&!await confirm('换发通用卡密码？',`将重置 ${body.firstNumber}-${body.lastNumber} 号卡的密码，并注销这些卡的旧登录。请用新打印的纸卡替换旧卡。`,'重置并补印',true))return;
      if(action==='reset-accounts'&&!await confirm('重置所选学生密码？',`将重置 ${body.studentIds.length} 人的六位密码，旧密码和旧学生会话立即失效。新密码仅本次返回，请下载发放。`, '重置密码', true))return;
      if(action==='link-account'&&!await confirm('关联已有学生账号？',`将 ${accounts.students.find(s=>s.studentId===body.studentId)?.name||'所选学生'} 关联到原账号 ${body.username}。原班与本班权限由服务端核验，历史保留，密码不变。`, '关联账号'))return;
      const data=await api('/classes/'+encodeURIComponent(classAt)+'/students'+(numberCards?(action==='reset-number-cards'?'/number-cards/reset':'/number-cards'):action==='reset-accounts'?'/reset':action==='link-account'?'/link':''),'POST',body);
      if(generationAt!==generation||classAt!==cid||userAt!==owner||userAt!==app()?.state.user?.id||app()?.state.sessionExpired)return;
      const issued=data.credentials||[];
      accounts={...data};delete accounts.credentials;
      credentials=issued;accountSelection=new Set();accountsConflict=false;accountsError='';
      if(action==='link-account')accountDraft.studentId=accountDraft.username='';
      if(action==='generate-accounts'){accountDraft.entryYear=entryYear;accountDraft.classCode=accountClassCode;}
      if(numberCards){
        if(issued.length){notify(`已准备 ${issued.length} 张通用卡，可打印本次纸卡。`);return;}
        const range=(data.numberCards||[]).filter(card=>card.cardNumber>=body.firstNumber&&card.cardNumber<=body.lastNumber);
        if(range.length!==body.lastNumber-body.firstNumber+1 || range.some(card=>!card.username)){
          notify('所选通用卡已发放。');return;
        }
        const first=range[0].username, last=range[range.length-1].username;
        notify(`所选通用卡已发放。登录编号 ${first===last?first:first+' - '+last}，沿用原密码。`);return;
      }
      notify(action==='generate-accounts'?`已生成 ${issued.length} 个账号，可打印本次纸卡或下载发放表。`:action==='reset-accounts'?`已重置 ${issued.length} 人的密码，旧密码已失效，请发放新密码。`:'原账号已关联，原历史和密码已保留。');
    },true);
  }
  function answerControl(q) {
    const letters='ABCD'.slice(0,q.options.length).split('');
    if(q.type==='multiple')return `<fieldset class="cq-answer-set" aria-describedby="cq-answer-help"><legend>标准答案（多选）</legend><div class="cq-answer-options">${letters.map(letter=>`<label class="cq-choice"><input type="checkbox" name="answer" value="${letter}"${q.answer?.includes(letter)?' checked':''}><span>${letter}</span></label>`).join('')}</div><p id="cq-answer-help" class="cq-note">可选一项或多项；全部取消时暂不设置标准答案。</p></fieldset>`;
    return `<label>标准答案<select name="answer">${option([['','暂不设置'],...letters.map(letter=>[letter,q.type==='boolean'?letter==='A'?'A 正确':'B 错误':letter])],q.answer||'')}</select></label>`;
  }
  function importPreview(batch) {
    const {url, image} = batch.source, draft = batch.current;
    const [x, y, w, h] = draft?.rect || [0, 0, image.naturalWidth, image.naturalHeight];
    const picture = draft
      ? `<svg role="img" aria-label="本题截图" viewBox="${draft.rect.join(' ')}">
          <clipPath id="cq-import-bounds"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath>
          <image href="${esc(url)}" width="${image.naturalWidth}" height="${image.naturalHeight}" clip-path="url(#cq-import-bounds)"/></svg>`
      : `<img src="${esc(url)}" width="${w}" height="${h}" alt="待识别的截图">`;
    return `<figure class="cq-import-preview"><figcaption><strong>${draft?'本题原图':'截图预览'}</strong>
      <a href="${esc(url)}" target="_blank" rel="noopener">查看完整原图<span class="sr-only">（在新标签页打开）</span></a>
      </figcaption><div class="cq-import-picture">${picture}</div></figure>`;
  }

  function renderImportSource(batch) {
    const ready = batch.source && !batch.pending;
    return `<section class="cq-panel cq-import"><div class="cq-item-head"><h2>截图录题</h2>${button('cancel-editor','返回题库')}</div>
      <div class="cq-import-layout"><div class="cq-form cq-import-controls">
        <label>识别学科<select id="cq-import-subject">${option(subjects,batch.subjectId)}</select></label>
        <div><input id="cq-import-file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="题目截图" hidden>
          ${button('choose-screenshot',batch.source?'更换截图':'选择截图',false,'aria-describedby="cq-import-help"')}
          <p class="cq-note" id="cq-import-help">也可直接粘贴截图。支持 PNG、JPEG、WebP，单张最多 2 MiB。</p></div>
        <div><p class="cq-note" id="cq-import-limit">每张最多 8 道单选、多选或判断题。每次发起新识别使用 1 次班班额度。</p>
          <div class="cq-actions">${button('recognize','识别题目',true,'aria-describedby="cq-import-limit"'+(!ready||batch.request?' disabled':''))}
          ${ready?button('manual-import','手动录题'):''}</div></div>
        <p class="cq-note cq-import-status" role="status">${batch.pending?'正在读取截图…':batch.request?'正在识别题目…':''}</p>
      </div>${batch.source?importPreview(batch):''}</div></section>`;
  }

  function renderQuestionEditor() {
    const q=editor.value, review=editor.kind==='review', boolean=q.type==='boolean', count=q.options.length;
    const image=q.imageId||editor.sourceImageId;
    const importing = editor.kind === 'import';
    const form = `<form class="cq-form" id="cq-question-form"><div class="cq-fields">
      <label>学科<select name="subjectId"${review||busy?' disabled':''}>${option(subjects,q.subjectId)}</select></label>
      <label>题型<select name="type"${review||busy?' disabled':''}>${option([['single','单选'],['boolean','判断（A 正确，B 错误）'],['multiple','多选']],q.type)}</select></label></div>
      <label>题干<textarea name="text" rows="4" maxlength="40000">${esc(q.text)}</textarea></label>
      ${image&&!importing?`<img class="cq-image" src="/api/card-quiz/images/${encodeURIComponent(image)}" alt="题目配图">`:''}
      ${!review&&!importing?`<label>题目图片（PNG、JPEG、WebP，最多 2 MiB）<input type="file" name="image" accept="image/png,image/jpeg,image/webp"></label>${image?button('remove-image','移除配图'):''}`:''}
      ${!review?`<label>选项数量<select name="count"${boolean||busy?' disabled':''}>${option([['2','2'],['3','3'],['4','4']],String(count))}</select></label>`:''}
      <div class="cq-fields">${q.options.map((text,i)=>`<label>选项 ${'ABCD'[i]}${!review&&!boolean&&(importing||/[\r\n]/.test(text))
        ? `<textarea name="option-${i}" rows="2" maxlength="4000">${esc(text)}</textarea>`
        : `<input name="option-${i}" maxlength="4000" value="${esc(text)}"${review||boolean?' readonly':''}>`}</label>`).join('')}</div>
      <div class="cq-fields">${answerControl(q)}<label>知识点（逗号分隔）<input name="tags" maxlength="8049" value="${esc(q.tags.join('，'))}"></label></div>
      ${review?`<label>关联本人题库版本<select name="bankLink"><option value="">${q.bankId?'保留原关联':'独立临时题'}</option><option value="clear">取消题库关联</option>${bank.filter(b=>b.subjectId===q.subjectId&&b.type===q.type&&JSON.stringify(b.options)===JSON.stringify(q.options)).map(b=>`<option value="${esc(b.id)}">${esc(b.text||'无题干')} · v${b.revision}</option>`).join('')}</select></label>`:''}
      <p class="cq-dirty">${conflict?'版本有冲突，请重新载入核对':changed?'尚未保存':''}</p>
      <div class="cq-form-footer"><div class="cq-actions">${importing?button('skip-import','跳过此题'):button('cancel-editor','返回')}
        ${button(review?'save-review':'save-question',importing?'确认保存此题':'保存',true,conflict?'disabled':'')}</div></div></form>`;
    if (!importing) return `<section class="cq-panel"><h2>${review?'课后修订':q.id?'编辑私有题目':'新建私有题目'}</h2>${form}</section>`;
    const draft = editor.current;
    return `<section class="cq-panel cq-import"><div class="cq-item-head"><h2 id="cq-import-heading" tabindex="-1">审阅第 ${editor.index+1} / ${editor.drafts.length} 题</h2>
      ${button('cancel-editor','返回题库')}</div><div class="cq-import-layout">
      <div>${importPreview(editor)}<label class="cq-choice cq-import-attach"><input id="cq-import-attach" type="checkbox"${draft.attach?' checked':''}${busy?' disabled':''}>保留本题截图作配图</label>
      ${draft.note?`<p class="cq-note cq-import-note">${esc(draft.note)}</p>`:''}</div>${form}</div></section>`;
  }
  function renderBank() {
    if(editor?.kind==='import')return editor.current?renderQuestionEditor():renderImportSource(editor);
    if(editor?.kind==='question')return renderQuestionEditor();
    return `<section class="cq-panel"><div class="cq-item-head"><h2>我的私有题库</h2><div class="cq-actions">${button('open-import','截图录题')}${button('new-question','新建题目',true)}</div></div>${bank.length?'<div class="cq-list">'+bank.map(q=>`<article class="cq-item"><div class="cq-item-head"><p>${esc(q.text||'图片或课件题')}</p><div class="cq-actions">${button('edit-question','编辑',false,`data-id="${esc(q.id)}"`)}${button('delete-question','删除',false,`data-id="${esc(q.id)}"`)}</div></div><small>${esc(names[q.subjectId]||q.subjectId)} · ${q.type==='boolean'?'判断':q.type==='multiple'?'多选':q.options.length+'选一'} · v${q.revision} · ${q.answer?'答案 '+q.answer:'未设答案'}${q.tags.length?' · '+esc(q.tags.join('、')):''}</small></article>`).join('')+'</div>':'<p class="cq-empty">创建文字或图片题，加入题单后发布到班级。</p>'}</section>`;
  }
  function renderDecks() {
    if(editor?.kind==='deck') {
      const d=editor.value;
      return `<section class="cq-panel"><h2>${d.id?'编辑题单':'新建题单'}</h2><form class="cq-form" id="cq-deck-form"><label>题单名称<input name="title" maxlength="120" value="${esc(d.title)}" required></label><h3>题目顺序</h3><ol class="cq-deck-order">${d.questionIds.map((id,i)=>{const q=bank.find(q=>q.id===id);return`<li><div class="cq-item-head"><p>${esc(q?.text||'图片或课件题（已删除的题目请移除）')}</p><div class="cq-actions">${button('deck-up','上移',false,`data-index="${i}"${i===0?' disabled':''}`)}${button('deck-down','下移',false,`data-index="${i}"${i===d.questionIds.length-1?' disabled':''}`)}</div></div></li>`;}).join('')}</ol><h3>选择本人题库题目</h3>${bank.map(q=>`<label class="cq-choice"><input type="checkbox" data-deck-question="${esc(q.id)}"${d.questionIds.includes(q.id)?' checked':''}><span>${esc(names[q.subjectId])} · ${esc(q.text||'图片或课件题')}</span></label>`).join('')||'<p class="cq-note">请先在我的题库中创建题目。</p>'}<p class="cq-dirty">${changed?'尚未保存':''}</p><div class="cq-actions">${button('cancel-editor','返回')}${button('save-deck','保存题单',true,conflict?'disabled':'')}</div></form></section>`;
    }
    return `<section class="cq-panel"><div class="cq-item-head"><h2>我的题单</h2>${button('new-deck','新建题单',true)}</div><div class="cq-list">${decks.map(d=>`<article class="cq-item"><div class="cq-item-head"><p>${esc(d.title)} · ${d.questionIds.length} 题</p><div class="cq-actions">${button('edit-deck','编辑',false,`data-id="${esc(d.id)}"`)}${button('publish','发布到当前班',true,`data-id="${esc(d.id)}"${!cid?' disabled':''}`)}</div></div></article>`).join('')||'<p class="cq-empty">按授课顺序组织题目，再发布固定快照到班级。</p>'}</div></section><section class="cq-panel"><h2>本班已发布题单</h2><p class="cq-note">使用快照不会改动作者的源题；修改源题后需要重新发布。</p>${publications.map(p=>`<details class="cq-item"><summary>${esc(p.title)} · ${p.questions.length} 题</summary><div class="cq-actions">${button('withdraw','撤回此题单',false,`data-id="${esc(p.id)}"`)}</div>${p.questions.map((q,i)=>`<div class="cq-item-head cq-item"><p>${i+1}. ${esc(q.text||'图片题')}</p>${button('copy-publication','另存为我的题目',false,`data-id="${esc(p.id)}" data-question="${i}"`)}</div>`).join('')}</details>`).join('')||'<p class="cq-empty">当前班级暂无已发布题单。</p>'}</section>`;
  }
  function statistics(value,label) {
    return table([label,'判定样本','正确','错误','未完成','未答','弃权','免答','未判定','练习','已答正确率'],value.map(s=>`<tr><td>${esc(s.studentName||s.tag)}</td><td>${s.samples}</td><td>${s.correct}</td><td>${s.wrong}</td><td>${s.incomplete||0}</td><td>${s.unanswered||0}</td><td>${s.abstained||0}</td><td>${s.exempt||0}</td><td>${s.ungraded||0}</td><td>${s.practice||0}</td><td>${rate(s.accuracy)}</td></tr>`),label+'统计');
  }
  function responseText(student,question,round) {
    if (student.status === 'abstained') return '弃权';
    if (student.status === 'exempt' && student.option == null) return '—';
    if(question?.type!=='multiple')return student.option||'未答';
    if(CardQuizModel.completeAnswer(question,student,round))return student.option||'全不选';
    if(Object.keys(student.choices||{}).length)return 'ABCD'.slice(0,question.options.length).split('').map(letter=>letter+' '+(student.choices[letter]===true?'选':student.choices[letter]===false?'不选':'未答')).join(' · ');
    return '未答';
  }
  function renderSessionKnowledge(topics) {
    if (!topics) return '';
    return `<section class="cq-panel"><h2>本节知识点</h2>${topics.length
      ? '<p class="cq-note">每题取最新封存的正式轮次，多标签题分别列入各知识点。展开可看学生明细，错题数多的排在前面。</p>' +
        topics.map((topic, index) => `<details class="cq-round" data-cq-topic="${index}"><summary class="cq-question-preview">${esc(topic.tag)} · ${topic.questionCount === 1 ? '仅 1 题' : topic.questionCount + ' 题'} · 正确 ${topic.correct} / 已判定 ${topic.samples} · 错误 ${topic.wrong}</summary></details>`).join('')
      : '<p class="cq-note">本节暂无带知识点标签的已封存正式题。</p>'}</section>`;
  }
  root.addEventListener('toggle', event => {
    const section = event.target;
    if (!section.matches('details[data-cq-topic]') || !section.open || section.querySelector('table')) return;
    const topic = detail.report.knowledge[Number(section.dataset.cqTopic)];
    const cards = new Map(detail.session.roster.map(student => [student.id, student.cardNumber]));
    const rows = topic.students.map(student => {
      const card = cards.get(student.studentId);
      const missed = student.wrongQuestionNumbers;
      const other = ['abstained','exempt','ungraded','incomplete','unanswered'].filter(key => student[key])
        .map(key => statuses[key] + ' ' + student[key]).join('、');
      return `<tr><td>${esc(student.studentName)}${card == null || detail.session.attendanceMode === 'scanned' ? '' : ' · ' + card + ' 号'}</td>
        <td>${student.samples ? student.correct + ' / ' + student.samples : '暂无判定样本'}</td><td>${student.wrong}</td>
        <td>${missed.length ? '第 ' + missed.join('、') + ' 题' : '—'}</td><td>${other || '—'}</td></tr>`;
    });
    section.insertAdjacentHTML('beforeend', table(['学生','正确 / 已判定','错误','错题题号','未计入判分'], rows, topic.tag + '的学生明细'));
  }, true);
  function renderDetail() {
    if(editor?.kind==='review')return renderQuestionEditor();
    const s=detail.session, totals=detail.report.totals;
    const hasNewRounds = s.questions.some(q => q.rounds?.some(r => r.noCardPolicy === 'abstain'));
    return `<section class="cq-panel"><div class="cq-item-head"><h2>${esc(names[s.subjectId]||s.subjectId)} · ${date(s.startedAt)}</h2><div class="cq-actions">${button('close-detail','返回报告')}${s.endedAt?button('claim','认领此课',false):''}</div></div><p class="cq-note">${s.endedAt?'课堂已结束并同步，可以补录题干、标准答案和知识点。':'课堂尚未结束，修订由教室端确认。'}${s.teacherId?' 已认领。':''}</p><div class="cq-summary wb-metrics" role="group" aria-label="本课答题汇总">${ui.metric('判定样本',totals.samples,'clipboard')}${ui.metric('已答正确率',rate(totals.accuracy),'chart',{bar:ui.meter(totals.accuracy)})}${!hasNewRounds || totals.incomplete ? ui.metric('未完成',totals.incomplete||0,'clock') : ''}${!hasNewRounds || totals.unanswered ? ui.metric('未答',totals.unanswered||0,'inbox') : ''}${hasNewRounds ? ui.metric('弃权',totals.abstained||0,'inbox') : ''}</div></section>
      ${renderSessionKnowledge(detail.report.knowledge)}
      <section class="cq-panel"><h2>逐题记录与修订</h2>${detail.report.questions.map((q,i)=>{
      const snapshot=s.questions.find(value=>value.id===q.id), options=snapshot?.options||[];
      return `<article class="cq-item"><div class="cq-item-head"><h3>第 ${i+1} 题</h3><div class="cq-actions">${s.endedAt?button('review-question','课后修订',false,`data-id="${esc(q.id)}"`):''}${button('copy-session','另存为我的题目',false,`data-id="${esc(q.id)}"`)}</div></div><p class="cq-question-preview">${esc(q.text|| (snapshot?.imageId?'图片题':'课件临时题'))}</p>${snapshot?.imageId?`<img class="cq-image" src="/api/card-quiz/images/${encodeURIComponent(snapshot.imageId)}" alt="本题配图">`:''}<ol type="A">${options.map(text=>`<li>${esc(text||'选项无文字')}</li>`).join('')}</ol><p class="cq-note">${q.answer?'标准答案 '+q.answer:'未设置答案'}${q.tags.length?' · '+esc(q.tags.join('、')):''}</p>${q.rounds.map((r,index)=>{
      if(r.status!=='closed')return `<details class="cq-round"><summary>第 ${index+1} 轮 · ${r.purpose==='practice'?'练习':'正式'} · ${r.status==='paused'?'已暂停':'收答中'}</summary><p class="cq-note">本轮尚未封存，结束后显示作答结果。</p></details>`;
      const round=snapshot?.rounds?.find(item=>item.id===r.id);
      const multiple=snapshot?.type==='multiple', participants=r.students.filter(x=>x.status!=='exempt');
      const complete=participants.filter(x=>CardQuizModel.completeAnswer(snapshot,x,round));
      const expected=(s.attendanceMode === 'scanned' ? r.students.length : s.roster.length)-r.exempt, received=complete.length;
      const incomplete=multiple?participants.filter(x=>!CardQuizModel.completeAnswer(snapshot,x,round)&&Object.keys(x.choices||{}).length).length:0;
      const abstained=r.abstained || 0, unanswered=Math.max(0,expected-received-incomplete-abstained);
      const bars=multiple ? CardQuizModel.distributionBars('multiple',r.combinationDistribution ?? CardQuizModel.combinationDistribution(complete)) :
        options.map((_,i)=>({label:'ABCD'[i],count:complete.filter(x=>x.option==='ABCD'[i]).length}));
      const distribution=bars.map(({label,count},i)=>`<tr${multiple && count === bars[0].count ? ' class="cq-most"' : ''}><th scope="row">${esc(label)}</th>${multiple?'':`<td class="cq-option-text">${esc(options[i]||'选项无文字')}</td>`}<td>${count}</td><td class="cq-proportion">${received?`<span class="wb-meter-track">${ui.meter(count,received)}</span>${rate(count/received)}`:'暂无作答'}</td></tr>`);
      if(!multiple)distribution.push(`<tr><th scope="row">${round?.noCardPolicy === 'abstain' ? '弃权' : '未答'}</th><td></td><td>${round?.noCardPolicy === 'abstain' ? abstained : unanswered}</td><td></td></tr>`);
      const headers=multiple?['组合','人数','占已答人数']:['选项','内容','人数','占已答人数'];
      const chart = distribution.length ? table(headers,distribution,multiple?'本轮匿名组合分布':'本轮匿名选项分布',multiple?'cq-combinations':'')
        : `<p class="cq-note">${!r.students.length?'本轮未收到卡':expected===0?'全员免答':abstained===expected?'全员弃权':incomplete?'暂无完整作答':'无人作答'}</p>`;
      const participation = [s.attendanceMode === 'scanned' ? `本题已答 ${received} 人 · 截至本轮已参与 ${r.students.length} 人` :
        `参与 ${received}/${expected}${expected ? '（'+rate(received/expected)+'）' : ''}`];
      if (!multiple && r.exempt) participation.push('免答 '+r.exempt);
      if (multiple) for (const [label,n] of [['未完成',incomplete],['未答',unanswered],['弃权',abstained],['免答',r.exempt]]) {
        if (n) participation.push(label+' '+n);
      }
      participation.push(r.purpose==='practice'?'练习不计入正式正确率':'已答正确率 '+(q.answer && received ? rate(r.correct/received) : '未判定'));
      return `<details class="cq-round"><summary>第 ${index+1} 轮 · ${r.purpose==='practice'?'练习':'正式'} · 已封存</summary><p class="cq-note">${participation.join(' · ')}</p>${chart}${table(['学生','作答','状态'],r.students.map(x=>`<tr><td>${esc(x.studentName)}</td><td>${esc(responseText(x,snapshot,round))}</td><td>${esc(statuses[x.status]||x.status)}</td></tr>`),'本题作答明细')}</details>`;
    }).join('')}</article>`;}).join('')}</section><section class="cq-panel"><h2>本课学生汇总</h2>${statistics(detail.report.students,'学生')}</section>`;
  }
  function renderReports() {
    if(detail)return renderDetail();
    if(!report)return'<p class="cq-empty">请选择班级查询课堂记录。</p>';
    return `<section class="cq-panel"><div class="cq-item-head"><h2>课堂记录</h2>${button('export','导出明细 CSV')}</div><div class="cq-list">${[...report.sessions].reverse().map(s=>`<article class="cq-item"><div class="cq-item-head"><p>${esc(names[s.subjectId]||s.subjectId)} · ${date(s.startedAt)}<br><small>${s.questionCount} 题 · ${s.endedAt?'已结束':'尚未结束'} · ${s.teacherId?'已认领':'待认领'}</small></p>${button('open-session','查看与修订',false,`data-id="${esc(s.id)}"`)}</div></article>`).join('')||'<p class="cq-empty">本班暂无已同步课堂。</p>'}</div></section><section class="cq-panel"><h2>学生汇总</h2><p class="cq-note">同人、同题、同版本取最近的有效正式作答。正确率按已判定的作答计算。</p>${statistics(report.students,'学生')}</section><section class="cq-panel"><h2>知识点表现</h2><p class="cq-note">按教师确认的知识点汇总，请结合判定样本数看正确率。</p>${table(['学科','知识点','题数','作答数','判定样本','正确','错误','未完成','已答正确率'],report.knowledge.map(k=>`<tr><td>${esc(names[k.subjectId]||k.subjectId)}</td><td>${esc(k.tag)}</td><td>${k.questionCount}</td><td>${k.answers}</td><td>${k.samples}</td><td>${k.correct}</td><td>${k.wrong}</td><td>${k.incomplete||0}</td><td>${rate(k.accuracy)}</td></tr>`),'知识点样本与正确率')}</section>`;
  }
  function render() {
    ui.preserveFocus(root, renderContent, () => root.querySelector('[data-cq-tab][aria-pressed="true"]'));
  }
  function renderContent() {
    const classes=app()?.state.classes||[];
    root.innerHTML=`<div class="cq-heading"><h1>纸卡答题</h1><div class="cq-tabs" role="group" aria-label="纸卡答题工作区">${[['cards','班级纸卡'],['bank','我的题库'],['decks','题单发布'],['reports','课堂报告']].map(([id,label])=>`<button type="button" class="btn" data-cq-tab="${id}" aria-pressed="${tab===id}"${busy?' disabled':''}>${label}</button>`).join('')}</div></div><div class="cq-toolbar"><label>当前班级<select id="cq-class"${busy?' disabled':''}>${option(classes.map(c=>[c.id,c.name]),cid)}</select></label>${tab==='reports'?`<label>学科<select id="cq-subject"${busy?' disabled':''}>${option([['','全部学科'],...subjects],subject)}</select></label>`:''}<div class="cq-actions">${button('reload','重新载入')}</div></div><p ${message?'':'hidden'} class="cq-feedback${failed?' cq-error':''}" role="${failed?'alert':'status'}" aria-live="polite">${esc(message)}</p>${busy?'<p class="cq-note" role="status">正在处理…</p>':''}${tab==='cards'?renderCards():tab==='bank'?renderBank():tab==='decks'?renderDecks():renderReports()}`;
    if(busy)root.querySelectorAll('.cq-form input,.cq-form select,.cq-form textarea,.cq-form button').forEach(node=>node.disabled=true);
    if(tab==='cards'&&accounts)syncAccountSelection();
  }
  async function fetchTab({classId=cid, nextTab=tab, nextSubject=subject, replace=false}={}) {
    if (replace && editor?.kind === 'import') editor.cancelRequest();
    const current=++generation, base='/classes/'+encodeURIComponent(classId);
    const [questions, lists, published, freshCards, freshReport] = await Promise.all([
      api('/questions'), api('/decks'), classId?api(base+'/publications'):null,
      classId&&nextTab==='cards'?api(base+'/cards'):null,
      classId&&nextTab==='reports'?api('/report?'+new URLSearchParams({classId,...(nextSubject?{subjectId:nextSubject}:{})})):null
    ]);
    if(current!==generation)return;
    if(classId!==cid){cards=cardsDraft=accounts=undefined;accountClassCode='';accountsConflict=false;accountsError='';}
    if(replace || classId!==cid){discard();detail=undefined;}
    cid=classId;tab=nextTab;subject=nextSubject;
    bank=questions.questions;decks=lists.decks;publications=published?.publications||[];
    if(nextTab==='reports')report=freshReport;
    if(nextTab==='cards'&&freshCards){cards=freshCards;cardsDraft=clone(cards.students);await readAccounts();}
    conflict=false;
  }
  async function load() {
    const uid=app()?.state.user?.id;if(!uid)return;
    if(owner!==uid){destroy();owner=uid;}
    if(editor?.kind==='import')return;
    if(changed || draftFields() || busy || credentials.length){render();return;}
    const classes=app().state.classes||[];
    const classId=classes.some(c=>c.id===cid)?cid:classes[0]?.id||'';
    await work(()=>fetchTab({classId}));
  }
  function editQuestion(value,kind='question',sourceImageId=null) {editor={kind,value:clone(value),sourceImageId};changed=false;conflict=false;render();root.querySelector('textarea')?.focus();}
  function syncEditor() {
    if(!editor?.value)return;
    const form=root.querySelector('.cq-form');if(!form)return;
    if(editor.kind==='deck'){editor.value.title=form.elements.title.value;return;}
    const q=editor.value;
    q.subjectId=form.elements.subjectId.value;q.type=form.elements.type.value;q.text=form.elements.text.value;
    q.options=Array.from({length:q.options.length},(_,i)=>form.elements['option-'+i].value);
    const answer=form.querySelector('select[name=answer]');
    q.answer=(answer?answer.value:Array.from(form.querySelectorAll('input[name=answer]:checked'),input=>input.value).sort().join(''))||null;
    q.tags=[...new Set(form.elements.tags.value.split(/[,，]/).map(t=>t.trim()).filter(Boolean))];
    if(editor.kind==='review'&&form.elements.bankLink.value){const id=form.elements.bankLink.value,b=bank.find(q=>q.id===id);q.bankId=b?.id||null;q.bankVersion=b?.revision||null;}
  }
  const fileData = file => new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片未能读取，请重新选择。'));reader.readAsDataURL(file);});
  function currentBankEditor(target) {
    return editor === target && tab === 'bank' && owner === app().state.user?.id && !app().state.sessionExpired &&
      !document.getElementById('view-card-quiz').classList.contains('hidden');
  }

  function focusImport(selector) {
    if (root.contains(document.activeElement) || document.activeElement === document.body) root.querySelector(selector)?.focus();
  }

  async function updateImport(batch, operation, focusSelector) {
    notify();
    render();
    try {
      if (await operation && currentBankEditor(batch)) {
        render();
        focusImport(focusSelector);
      }
    } catch (error) {
      if (currentBankEditor(batch)) { render(); notify(error.message, true); }
    }
  }

  function selectScreenshot(file) {
    const batch = editor;
    if (file && batch?.kind === 'import' && !batch.current && !busy && currentBankEditor(batch))
      return updateImport(batch, batch.selectFile(file), '[data-cq-action="recognize"]');
  }

  function finishImportQuestion(batch, saved) {
    if (saved) batch.saved++;
    batch.drafts[batch.index++] = null;
    changed = conflict = false;
    if (batch.current) {
      notify(saved ? '上一题已保存到我的题库。' : '已跳过上一题。');
    } else {
      notify('审阅完成，已入库 ' + batch.saved + ' 道，跳过 ' + (batch.index - batch.saved) + ' 道。');
      batch.dispose();
      editor = undefined;
    }
  }

  async function saveQuestion() {
    const target = editor, q = target.value, draft = target.kind === 'import' ? target.current : null;
    if (!currentBankEditor(target)) return;
    const creation = draft ? {requestKey:draft.saveKey} : {};
    let dataUrl;
    if (draft?.attach && !q.imageId) {
      dataUrl = await target.imageData();
    } else if (target.file) {
      if (!['image/png','image/jpeg','image/webp'].includes(target.file.type) || target.file.size > 2*1024*1024)
        throw new Error('图片仅支持 PNG、JPEG、WebP，最多 2 MiB。');
      dataUrl = await fileData(target.file);
    } else if (target.sourceImageId) {
      const response = await fetch('/api/card-quiz/images/'+encodeURIComponent(target.sourceImageId),{credentials:'same-origin',signal:AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error('配图未能复制，请重新载入后再试。');
      dataUrl = await fileData(await response.blob());
    }
    if (!currentBankEditor(target)) return;
    if (dataUrl) {
      const image = await api('/images', 'POST', {dataUrl,...creation});
      if (!currentBankEditor(target)) return;
      if (!image?.id) throw new Error('未获得配图编号，请重新保存。');
      q.imageId = image.id;
      target.file = target.sourceImageId = null;
      if (draft) draft.cropData = null;
    }
    const value={subjectId:q.subjectId,type:q.type,text:q.text,imageId:draft&&!draft.attach?null:q.imageId||null,options:q.options,answer:q.answer,tags:q.tags};
    const saved = await api('/questions'+(q.id?'/'+encodeURIComponent(q.id):''),q.id?'PUT':'POST',{...(q.id?{revision:q.revision}:creation),value});
    if (!currentBankEditor(target)) return;
    if (draft) {
      bank.push(saved);
      finishImportQuestion(target, true);
      return;
    }
    editor=undefined;changed=false;await fetchTab();notify('题目已保存到我的私有题库。');
  }
  function openPrint(number) {
    if(changed)throw new Error('请先保存卡号后再打印。');
    if(!cid)throw new Error('请选择班级。');
    if(!cards?.canEdit||!accounts?.canEdit)throw new Error('只有名单管理员可以代印纸卡和重置密码。');
    if(!accounts.students.some(s=>s.accountId&&s.activeHere&&s.cardNumber!=null&&(!number||s.cardNumber===Number(number))))throw new Error('请先为已分配卡号的学生生成或关联账号。');
    window.open('/card-quiz/print.html?'+new URLSearchParams({classId:cid,...(number?{card:String(number)}:{})}),'_blank','noopener');
  }
  function copyQuestion(q) {tab='bank';const value={...q};delete value.id;delete value.ownerId;delete value.bankId;delete value.bankVersion;value.revision=1;const image=value.imageId;value.imageId=null;editQuestion(value,'question',image);changed=true;render();}
  root.addEventListener('input',event=>{
    if(event.target.dataset.accountField){accountDraft[event.target.dataset.accountField]=event.target.value;return;}
    if(event.target.matches('.cq-form input:not([type=file]),.cq-form textarea')){syncEditor();markChanged();}
    if(event.target.dataset.cardStudent){const s=cardsDraft.find(s=>s.id===event.target.dataset.cardStudent);s.cardNumber=event.target.value===''?null:Number(event.target.value);markChanged();}
  });
  root.addEventListener('change',event=>{
    const input=event.target;
    if (input.id === 'cq-import-file') { void selectScreenshot(input.files?.[0]); return; }
    if (input.id === 'cq-import-subject') {
      editor.cancelRequest(); editor.requestKey = null; editor.subjectId = input.value; notify(); render(); return;
    }
    if (input.id === 'cq-import-attach') { editor.current.attach = input.checked; markChanged(); return; }
    if(input.dataset.accountField){accountDraft[input.dataset.accountField]=input.value;return;}
    if(input.dataset.accountStudent){if(input.checked)accountSelection.add(input.dataset.accountStudent);else accountSelection.delete(input.dataset.accountStudent);syncAccountSelection();return;}
    if(input.id==='cq-accounts-all'){accountSelection=new Set(input.checked?accounts.students.filter(s=>s.accountId&&s.activeHere).map(s=>s.studentId):[]);root.querySelectorAll('[data-account-student]').forEach(n=>n.checked=accountSelection.has(n.dataset.accountStudent));syncAccountSelection();return;}
    if(input.id==='cq-class'||input.id==='cq-subject'){
      const classChange=input.id==='cq-class', next=input.value;
      input.value=classChange?cid:subject;
      void (async()=>{
        if(await allowReplace(classChange?'切换班级':'切换学科'))
          await work(()=>fetchTab({classId:classChange?next:cid,nextSubject:classChange?subject:next,replace:true}));
      })();return;
    }
    if(input.name==='image'){editor.file=input.files?.[0]||null;markChanged();return;}
    if(input.dataset.deckQuestion){syncEditor();const ids=editor.value.questionIds;editor.value.questionIds=input.checked?[...ids,input.dataset.deckQuestion]:ids.filter(id=>id!==input.dataset.deckQuestion);changed=true;render();root.querySelector(`[data-deck-question="${CSS.escape(input.dataset.deckQuestion)}"]`)?.focus();return;}
    if(input.closest('.cq-form')){
      syncEditor();
      if(input.name==='type'||input.name==='count'){
        const q=editor.value,count=q.type==='boolean'?2:Number(root.querySelector('[name=count]').value);
        q.options=q.type==='boolean'?['正确','错误']:Array.from({length:count},(_,i)=>q.options[i]||'');
        const answer='ABCD'.slice(0,count).split('').filter(letter=>q.answer?.includes(letter)).join('');
        q.answer=answer&&(q.type==='multiple'||answer.length===1)?answer:null;
        changed=true;render();root.querySelector(`[name="${input.name}"]`)?.focus();
      }else markChanged();
    }
  });
  root.addEventListener('submit',event=>{event.preventDefault();if(event.target.dataset.accountForm&&!busy)accountAction(event.target.dataset.accountForm);});
  document.addEventListener('paste', event => {
    if (editor?.kind !== 'import' || editor.current || busy || !currentBankEditor(editor) ||
        document.querySelector('dialog[open]') || root.closest('[inert]')) return;
    if (!root.contains(event.target) && event.target !== document.body && event.target !== document) return;
    const data = event.clipboardData;
    const file = [...(data?.files || [])].find(item => item.type.startsWith('image/')) ||
      [...(data?.items || [])].find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
    if (file) { event.preventDefault(); void selectScreenshot(file); }
  });
  root.addEventListener('click',async event=>{
    const control=event.target.closest('button');if(!control||control.disabled||busy)return;
    if(control.dataset.cqTab){
      const next=control.dataset.cqTab;
      if(next!==tab&&await allowReplace('切换纸卡答题页面'))await work(()=>fetchTab({nextTab:next,replace:true}));
      return;
    }
    const action=control.dataset.cqAction,id=control.dataset.id;
    if(!action)return;
    if (action === 'open-import') {
      editor = new window.ICeClassQuestionImport(subject || 'math', fileData);
      changed = conflict = false; notify(); render(); focusImport('[data-cq-action="choose-screenshot"]'); return;
    }
    if (editor?.kind === 'import') {
      const batch = editor;
      if (!currentBankEditor(batch)) return;
      if (action === 'choose-screenshot') { root.querySelector('#cq-import-file').click(); return; }
      if (action === 'recognize') {
        await updateImport(batch, batch.recognize(api, () => currentBankEditor(batch)), '#cq-import-heading'); return;
      }
      if (action === 'manual-import') {
        batch.manual(); notify(); render(); focusImport('#cq-question-form textarea'); return;
      }
      if (action === 'skip-import') {
        finishImportQuestion(batch, false); render(); focusImport('#cq-import-heading,[data-cq-action="open-import"]'); return;
      }
      if (action === 'save-question') {
        syncEditor();
        if (await work(saveQuestion)) focusImport('#cq-import-heading,[data-cq-action="open-import"]');
        return;
      }
      if (action === 'cancel-editor') {
        if (await canLeave('返回我的题库')) focusImport('[data-cq-action="open-import"]');
        return;
      }
    }
    if(['generate-accounts','reset-accounts','issue-number-cards','reset-number-cards','link-account','print-issued','download-credentials','clear-credentials'].includes(action)){event.preventDefault();accountAction(action);return;}
    if(action==='retry-accounts'){await work(readAccounts);return;}
    if(action==='reload'){if(await allowReplace('重新载入纸卡答题')&&await work(()=>fetchTab({replace:true})))notify('已重新载入。');return;}
    if(action==='cancel-editor'){await afterLeave(async()=>{editor=undefined;render();},'关闭编辑');return;}
    if(editor && ['new-question','edit-question','new-deck','edit-deck','copy-publication','copy-session','review-question','close-detail','open-session','claim'].includes(action)){
      if(!await ui.confirmLeave('更换当前编辑内容', {only:draftLabel}))return;
      if(action==='open-session'||action==='claim'){
        await work(async()=>{
          detail=action==='open-session'?await api('/sessions/'+encodeURIComponent(id)):
            await api('/sessions/'+encodeURIComponent(detail.session.id),'PUT',{revision:detail.revision,questions:[],teacherId:app().state.user.id});
          editor=undefined;changed=conflict=false;
          if(action==='claim')notify('已以当前教师账号认领。');
        });return;
      }
      if(action!=='close-detail'){editor=undefined;changed=conflict=false;}
    }
    if(action==='new-question'){editQuestion({subjectId:subject||'math',type:'single',text:'',imageId:null,options:['','','',''],answer:null,tags:[]});return;}
    if(action==='edit-question'){editQuestion(bank.find(q=>q.id===id));return;}
    if(action==='new-deck'||action==='edit-deck'){editor={kind:'deck',value:action==='new-deck'?{title:'',questionIds:[]}:clone(decks.find(d=>d.id===id))};changed=conflict=false;render();return;}
    if(action==='deck-up'||action==='deck-down'){syncEditor();const ids=editor.value.questionIds,i=Number(control.dataset.index),j=i+(action==='deck-up'?-1:1);[ids[i],ids[j]]=[ids[j],ids[i]];changed=true;render();const same=root.querySelector(`[data-cq-action="${action}"][data-index="${j}"]`);(same&&!same.disabled?same:root.querySelector(`[data-cq-action="${action==='deck-up'?'deck-down':'deck-up'}"][data-index="${j}"]`))?.focus();return;}
    if(action==='remove-image'){editor.value.imageId=null;editor.sourceImageId=null;editor.file=null;changed=true;render();return;}
    if(action==='copy-publication'){copyQuestion(publications.find(p=>p.id===id).questions[Number(control.dataset.question)]);return;}
    if(action==='copy-session'){copyQuestion(detail.session.questions.find(q=>q.id===id));return;}
    if(action==='review-question'){editQuestion(detail.session.questions.find(q=>q.id===id),'review');return;}
    if(action==='close-detail'){await work(()=>fetchTab({replace:true}));return;}
    if(action==='print-one'||action==='print-all'){try{openPrint(control.dataset.card);}catch(error){notify(error.message,true);}return;}
    syncEditor();
    void work(async()=>{
      if(action==='save-question')await saveQuestion();
      else if(action==='save-cards'){cards=await api('/classes/'+encodeURIComponent(cid)+'/cards','PUT',{revision:cards.revision,bindings:cardsDraft.map(s=>({studentId:s.id,cardNumber:s.cardNumber}))});cardsDraft=clone(cards.students);changed=false;await readAccounts();notify('本班卡号已保存。请联网刷新教室端名单。');}
      else if(action==='initialize'){if(changed)throw new Error('请先保存或重新载入当前卡号修改。');cards=await api('/classes/'+encodeURIComponent(cid)+'/cards','PUT',{revision:cards.revision,initialize:true});cardsDraft=clone(cards.students);await readAccounts();notify('缺失卡号已分配。生成或关联学生账号后可以代印。');}
      else if(action==='delete-question'){const q=bank.find(q=>q.id===id);if(editor?.value.id===id&&changed)throw new Error('请先保存或关闭正在编辑的题目。');if(await confirm('删除这道私有题目？','已发布题单和已开始课堂保留原快照。','删除题目',true)){await api('/questions/'+encodeURIComponent(id),'DELETE',{revision:q.revision});if(editor?.value.id===id)editor=undefined;await fetchTab();notify('题目已从我的题库删除。');}}
      else if(action==='save-deck'){const d=editor.value;await api('/decks'+(d.id?'/'+encodeURIComponent(d.id):''),d.id?'PUT':'POST',{...(d.id?{revision:d.revision}:{}),title:d.title,questionIds:d.questionIds});editor=undefined;changed=false;await fetchTab();notify('题单已保存。');}
      else if(action==='publish'){const d=decks.find(d=>d.id===id);if(!cid)throw new Error('请选择发布班级。');if(await confirm('发布到当前班级？',(app().state.classes.find(c=>c.id===cid)?.name||cid)+' · '+d.title,'发布题单')){await api('/decks/'+encodeURIComponent(id)+'/publish','POST',{revision:d.revision,classId:cid});await fetchTab();notify('已发布固定题单快照，教室端联网后可以缓存。');}}
      else if(action==='withdraw'){if(await confirm('撤回这份已发布题单？','仅题单作者可以撤回；已开始的课堂保留快照。','撤回题单',true)){await api('/publications/'+encodeURIComponent(id),'DELETE',{});await fetchTab();notify('题单已撤回未来使用。');}}
      else if(action==='open-session'){detail=await api('/sessions/'+encodeURIComponent(id));}
      else if(action==='save-review'){const q=editor.value;detail=await api('/sessions/'+encodeURIComponent(detail.session.id),'PUT',{revision:detail.revision,questions:[{id:q.id,text:q.text,answer:q.answer,tags:q.tags,bankId:q.bankId||null,bankVersion:q.bankVersion||null}]});editor=undefined;changed=false;notify('课后修订已保存，统计已重新计算。');}
      else if(action==='claim'){detail=await api('/sessions/'+encodeURIComponent(detail.session.id),'PUT',{revision:detail.revision,questions:[],teacherId:app().state.user.id});notify('已以当前教师账号认领。');}
      else if(action==='export'){const csv=await api('/export?'+new URLSearchParams({classId:cid,...(subject?{subjectId:subject}:{})}));const url=URL.createObjectURL(new Blob(['\ufeff',csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='纸卡答题明细.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);notify('CSV 明细已生成。');}
    });
  });
  function destroy(){
    workEpoch++;
    if (editor?.kind === 'import') editor.dispose();
    generation++;owner=cid='';tab='cards';subject='';cards=cardsDraft=report=detail=editor=accounts=undefined;credentials=[];accountSelection=new Set();accountsError='';accountsConflict=false;accountClassCode='';accountDraft=newAccountDraft();bank=[];decks=[];publications=[];changed=conflict=busy=failed=false;message='';root.replaceChildren();
  }
  ui.registerDraft(draftLabel, () => ({dirty:changed || draftFields() || !!(editor?.kind==='import' && (editor.source || editor.pending)), busy}));
  ui.registerDraft(credentialsLabel, () => ({dirty:credentials.length > 0}));
  window.addEventListener('iceclass-logout', destroy);
  window.addEventListener('iceclass-session-expired',()=>{
    credentials=[];root.querySelector('.cq-credentials')?.remove();
    if (editor?.kind === 'import') { editor.cancelRequest(); render(); }
  });
  window.addEventListener('pagehide',()=>{
    generation++;credentials=[];root.querySelector('.cq-credentials')?.remove();
    if (editor?.kind === 'import') { workEpoch++; busy=false; discard(); render(); }
  });
  window.addEventListener('iceclass-classes-changed',()=>{
    if(cid && !app().state.classes.some(c=>c.id===cid))destroy();
    if(!document.getElementById('view-card-quiz')?.classList.contains('hidden')&&!busy)void load();
  });
  window.ICeClassCardQuiz={load,canLeave,destroy};
})();

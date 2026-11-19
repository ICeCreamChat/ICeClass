(() => {
  'use strict';
  const $ = id => document.getElementById(id), Model = window.CardQuizModel, Journal = window.CardQuizJournal;
  const native = window.chrome?.webview, pending = new Map(), letters = 'ABCD';
  const subjects = {chinese:'语文',math:'数学',english:'英语',physics:'物理',chemistry:'化学',biology:'生物',politics:'政治',history:'历史',geography:'地理'};
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let requestId = 0, data, controller, deck, pair, operation = false, frozen = false, disposed = false, wheelOperation = false;
  let relayTimer, relayRunning = false, relayFailures = 0, syncTimer, editorAdding = false, editorContext, distributionRound = '', startInWheel = false;
  const relayReceipts = new Map();
  const feedback = (message, kind = '') => { $('feedback').textContent = message; $('feedback').className = 'feedback ' + kind; renderWheel(); };
  const wheel = new CardQuizWheel();
  function renderWheel() {
    const s = session(), q = question(), r = round(), summary = s && Model.roundSummary(s,r);
    wheel.update({
      hasSession:Boolean(s),
      targets:s?{collect:$(r?.status==='collecting'?'stop':'start'),camera:$('camera-toggle'),source:$('source'),next:$('next'),
        'end-session':$('end-session'),exempt:$('exempt'),edit:$('edit'),distribution:$('show-distribution'),multi:$('multi-next')}:{},
      labels:{collect:r?.status==='collecting'?'结束本轮':$('start').textContent,camera:scanner.running?'关闭相机':'本机相机',
        source:s?.source==='phone'?'换回本机':'手机扫码',distribution:$('distribution').hidden?'作答分布':'收起分布'},
      progress:s?`第 ${s.questions.indexOf(q)+1} 题 · ${summary.received} / ${summary.expected} 人`:'请先开始课堂',
      state:!s?'':q?.type==='multiple'&&r?.status==='collecting'?`收 ${r.activeOption} 项 · 本项 ${summary.optionReceived} / ${summary.expected} 人`:$('round-status').textContent,
      multiple:q?.type==='multiple'&&r?.status==='collecting',cameraRunning:scanner.running,feedback:$('feedback').textContent,error:$('feedback').classList.contains('error')
    });
  }
  async function activateWheel(id) {
    const target = wheel.targets[id];
    if (wheelOperation || operation || !target || target.disabled || target.hidden) return;
    wheelOperation = true;
    // Detailed tasks use the same full-size dialogs and original handlers.
    const details = ['source','edit','exempt','distribution','end-session'].includes(id);
    try {
      await request('compact',{enabled:!details,expanded:false});
      if (!target.disabled && !target.hidden) target.click();
    } catch (error) { feedback(error.message,'error'); }
    finally { wheelOperation = false; }
  }
  function request(action, body = {}) {
    if (!native) return Promise.reject(new Error('请在 Windows 教室端打开纸卡答题。'));
    return new Promise((resolve,reject) => {
      const id = ++requestId, timeout = setTimeout(() => { pending.delete(id); reject(new Error('操作尚未确认，请重新打开并核对本机记录。')); }, 35000);
      pending.set(id,{resolve,reject,timeout}); native.postMessage({id,action,body});
    });
  }
  const session = () => controller?.session, question = () => session() && Model.activeQuestion(session()), round = () => session() && Model.activeRound(session());
  const active = () => Boolean(session() && session().endedAt === null);
  function command(action,payload = {}) {
    const s = session();
    return {id:crypto.randomUUID(),sessionId:s.id,questionId:s.currentQuestionId,roundId:s.currentRoundId,generation:s.generation,sourceId:s.sourceId,action,payload};
  }
  const scanner = new CardQuizScanner({video:$('camera'),onRead:async read => {
    if (data?.context?.revoked) throw new Error('设备授权已失效，采集已停止。');
    if (!active() || frozen || session().source !== 'board' || round()?.status !== 'collecting') return;
    await dispatch(command('answer',{...read,...(question()?.type==='multiple'?{targetOption:round().activeOption}:{})}));
    feedback('本机已确认作答。');
  },onStatus:({message,kind}) => { $('camera-status').textContent = message; if (kind === 'error') feedback(message,'error'); }});
  function newController(journal) {
    return new Journal.Controller(journal,async next => {
      try { return await request('commit',{journal:next}); }
      catch (error) { frozen = true; scanner.stop(); const message = '保存尚未确认。请关闭并重新打开，核对本机记录：' + error.message; feedback(message,'error'); render(); throw new Error(message); }
    });
  }
  async function dispatch(value) {
    if (frozen) throw new Error('请先重新打开，核对本机已保存的记录。');
    if (data?.context?.revoked && !['recover','end_round','end_session'].includes(value.action)) throw new Error('设备授权已失效，采集已停止，本机记录保留。');
    const result = await controller.dispatch(value); render(); return {...result,state:{...result.state,className:data?.className || ''}};
  }
  function renderSetup() {
    if (!data) return;
    $('class-name').textContent = data.className || '创意工坊';
    const context = data.context, students = context?.students || [];
    const numbers = new Set(students.map(s=>s.cardNumber));
    const ready = context && !context.revoked && students.length > 0 && students.length <= 157 &&
      students.every(s=>Number.isInteger(s.cardNumber) && s.cardNumber >= 1 && s.cardNumber <= 157) && numbers.size === students.length;
    $('roster-status').textContent = context?.revoked ? '本机绑定已失效，请在教室设置中重新绑定。' : ready ? `已准备 ${students.length} 张本班纸卡。` : '请在教师工作台的纸卡答题中分配卡号，再联网刷新本机名单。';
    $('create-session').disabled = !ready || operation;
    const selected = $('publication').value;
    $('publication').innerHTML = '<option value="">配合课件临时出题</option>' + (context?.publications || []).map(p=>`<option value="${esc(p.id)}">${esc(p.title)} · ${p.questionCount} 题${p.cached?' · 已缓存':''}</option>`).join('');
    if ([...$('publication').options].some(o=>o.value===selected)) $('publication').value = selected;
    const saved = (data.journals || []).filter(j=>j.session.endedAt === null || j.syncedSeq < j.session.seq || j.reviewError).sort((a,b)=>b.session.startedAt-a.session.startedAt);
    $('saved-sessions').innerHTML = saved.map(j=>`<div class="saved-session"><span>${esc(subjects[j.session.subjectId] || j.session.subjectId)} · ${new Date(j.session.startedAt).toLocaleString('zh-CN')}<br><small>${j.session.endedAt===null?'课堂尚未结束':j.reviewError?'记录待核对':'记录待同步'}</small></span><button type="button" data-resume="${esc(j.session.id)}">${j.session.endedAt===null?'恢复课堂':'查看汇总'}</button></div>`).join('');
    if (data.errors?.length) feedback(data.errors.join(' '),'error');
  }
  function render() {
    const s = session(), q = question(), r = round(), exists = Boolean(s), ended = exists && !active();
    $('setup').hidden = exists; $('workspace').hidden = !exists;
    $('compact').disabled = operation;
    if (!exists) { renderSetup(); renderWheel(); return; }
    native?.postMessage({type:'activity',busy:active()});
    $('class-name').textContent = `${data.className} · ${subjects[s.subjectId] || s.subjectId}`;
    const collecting = r?.status === 'collecting', between = !r || r.status === 'closed', disabled = operation || frozen || ended || data?.context?.revoked;
    const summary = Model.roundSummary(s,r);
    $('question-number').textContent = `第 ${s.questions.indexOf(q)+1} 题 · 共 ${s.questions.length} 题`;
    $('question-heading').textContent = q ? (q.type === 'boolean' ? '判断题' : q.type === 'multiple' ? `多选题 · ${q.options.length} 个选项` : `${q.options.length} 选一`) : '准备出题';
    $('question-text').textContent = q?.text || '题目请看课件或黑板';
    const image = deck?.images?.[q?.imageId];
    $('question-image').hidden = !image;
    if (image && $('question-image').firstElementChild?.getAttribute('src') !== image) {
      const picture = document.createElement('img'); picture.alt = '题目配图'; picture.src = image; $('question-image').replaceChildren(picture);
    }
    if (!image) $('question-image').replaceChildren();
    $('options').innerHTML = (q?.options || []).map((text,index)=>`<li>${esc(text || `选项 ${letters[index]}`)}</li>`).join('');
    $('round-kind').textContent = r?.purpose === 'practice' ? '讲解后练习 · 不覆盖正式记录' : '正式作答';
    $('received').textContent = summary.received; $('expected').textContent = ` / ${summary.expected} 人${q?.type==='multiple'?'整题完成':'已收'}`;
    $('multi-capture').hidden = q?.type !== 'multiple';
    if(q?.type==='multiple'){
      if($('multi-option').options.length!==q.options.length)$('multi-option').innerHTML=letters.slice(0,q.options.length).split('').map(l=>`<option value="${l}">${l} 项</option>`).join('');
      $('multi-option').value = r?.activeOption || 'A';
      $('multi-option').disabled = disabled || !collecting;
      $('multi-next').disabled = disabled || !collecting || letters.indexOf(r?.activeOption)>=q.options.length-1;
      $('multi-progress').textContent = !r ? '开始后逐项收答，全部项均确认才算整题完成。' : `本项已收 ${summary.optionReceived} / ${summary.expected} 人${r.status==='closed'?`；未完成 ${summary.incomplete} 人`:'；切项后请重新开启相机。'}`;
    }
    $('round-status').textContent = ended ? '本课堂已结束' : collecting ? (s.source === 'phone' ? '手机正在收答，白板保存后确认' : '正在本机收答') : r?.status === 'paused' ? '已暂停，请核对题目后恢复' : r ? '本轮已封存' : '等待开始收答';
    $('start').textContent = r?.status === 'paused' ? '恢复本轮' : r ? (q.revealed ? '讲解后练习' : '重新收答') : '开始收答';
    $('start').disabled = disabled || collecting || !q;
    $('stop').disabled = disabled || between;
    $('source').disabled = disabled || !between;
    $('source').textContent = s.source === 'phone' ? '换回本机' : '使用手机';
    $('edit').disabled = disabled || !between || !q;
    $('exempt').disabled = disabled || !r || r.status === 'closed';
    $('reveal').disabled = disabled || !between || !q || q.revealed;
    $('reveal').textContent = q?.answer ? '揭晓答案' : '已在课件讲解';
    $('show-distribution').disabled = disabled || r?.status !== 'closed';
    $('next').disabled = disabled || !between;
    $('temporary').disabled = disabled || !between;
    $('end-session').disabled = disabled;
    $('exempt-cards').querySelectorAll('input').forEach(input=>input.disabled = disabled || !r || r.status === 'closed');
    $('camera-toggle').hidden = ended || !collecting || s.source !== 'board';
    $('camera-toggle').disabled = operation || frozen || data?.context?.revoked;
    $('camera-toggle').textContent = scanner.running ? '关闭相机' : '开启相机';
    $('camera').hidden = ended || s.source !== 'board';
    $('answer-display').hidden = !q?.revealed;
    $('answer-display').textContent = q?.answer ? `标准答案 ${q.answer}` : '已在课件中讲解';
    const roundKey = `${s.id}/${q?.id}/${r?.id}`;
    const showDistribution = r?.status === 'closed' && distributionRound === roundKey;
    $('show-distribution').textContent = showDistribution ? '收起分布' : '展示分布';
    $('distribution').hidden = !showDistribution;
    $('distribution').innerHTML = showDistribution ? Object.entries(summary.distribution).map(([option,count])=>`<span>${option} · ${count} 人 · ${summary.received?(count/summary.received*100).toFixed(1)+'%':'暂无作答'}</span>`).join('') + (q?.type==='multiple'?`<span>未完成 · ${summary.incomplete} 人</span>`:'') + `<span>未答 · ${summary.unanswered} 人</span>` : '';
    $('sync-status').textContent = controller.journal.reviewError ? '待核对：' + controller.journal.reviewError : controller.journal.syncedSeq >= s.seq ? '已同步学校服务' : `已保存在本机 · ${s.seq-(controller.journal.syncedSeq || 0)} 条待同步`;
    scanner.reset(`${s.id}/${s.currentRoundId}/${s.generation}`,q?.type==='multiple'?2:q?.options.length || 4);
    if (!collecting || s.source !== 'board' || frozen || ended) scanner.stop();
    const next = nextFromDeck(); $('next').textContent = next ? '题单下一题' : '下一道临时题';
    renderWheel();
  }
  function nextFromDeck() {
    const questions = deck?.publication?.questions || [], used = session()?.questions.filter(q=>q.bankId).length || 0;
    return questions[used] || null;
  }
  async function createSession() {
    if ((data.journals || []).some(j=>j.session.endedAt === null)) throw new Error('请先恢复并结束尚未结束的课堂。');
    const id = $('publication').value; deck = id ? await request('publication',{id}) : null;
    const questions = deck?.publication?.questions;
    if (id && !questions?.length) throw new Error('题单中没有可用题目。');
    const subjectId = questions?.[0]?.subjectId || $('subject').value;
    if (questions?.some(q=>q.subjectId!==subjectId)) throw new Error('题单包含多个学科，请在教师工作台按学科拆分。');
    const initial = Journal.create(Model.createSession(data.context,subjectId)); initial.publicationId = id || null;
    const persisted = await request('commit',{journal:initial}); controller = newController(persisted); frozen = false;
    await dispatch(command('add_question',questions?.[0] || {type:'single',options:['','','','']}));
    feedback('课堂已保存，可以开始收答。'); scheduleRelay(); scheduleSync();
    if (startInWheel) { await request('compact',{enabled:true,expanded:true}); startInWheel = false; }
  }
  async function restore(id) {
    const latest = await request('load'), journal = latest.journals.find(j=>j.session.id===id);
    if (!journal) throw new Error('本机课堂未找到，请核对记录。');
    data = latest; controller = newController(journal); frozen = false; deck = null; pair = null;
    if (journal.publicationId) {
      try { deck = await request('publication',{id:journal.publicationId,sessionId:id}); }
      catch (error) { feedback('题单缓存未能读取；已保存题目仍可使用。' + error.message,'warning'); }
    }
    if (active()) await dispatch(command('recover'));
    render(); feedback(active() ? '已恢复本机记录并暂停；请核对题目与采集来源后继续。' : '已结束课堂的匿名汇总。');
    scheduleRelay(); scheduleSync();
  }
  function mergeSync(value) {
    data = value;
    const saved = value.journals?.find(j=>j.session.id===session()?.id);
    if (saved && controller) { controller.journal.syncedSeq = saved.syncedSeq; controller.journal.reviewError = saved.reviewError; }
    render();
  }
  function scheduleSync() {
    clearTimeout(syncTimer);
    if (disposed) return;
    syncTimer = setTimeout(async () => {
      try { mergeSync(await request('load')); } catch { /* Native outbox reports state on the next read. */ }
      scheduleSync();
    },5000);
  }
  function scheduleRelay() {
    clearTimeout(relayTimer);
    if (disposed || !active()) return;
    relayTimer = setTimeout(relay, Math.min(15000,750 * 2 ** relayFailures));
  }
  async function relay() {
    if (relayRunning || !active() || frozen || disposed) return;
    relayRunning = true;
    const sent = [...relayReceipts.values()];
    try {
      const value = await request('relay',{sessionId:session().id,state:Model.publicState(session(),data.className),receipts:sent});
      for (const receipt of sent) relayReceipts.delete(receipt.id);
      relayFailures = 0;
      if (pair) {
        const ready = value.pairings?.find(p=>p.pairId === pair.pairId)?.claimed === true;
        $('confirm-phone').disabled = !ready;
        if (ready) $('pair-status').textContent = '老师已配对，请在白板确认使用此手机。';
      }
      for (const incoming of value.commands || []) {
        try {
          if (!active() || incoming.action === 'recover' || session().source !== 'phone') throw new Error('当前采集许可已失效。');
          const result = await dispatch(incoming); relayReceipts.set(incoming.id,{id:incoming.id,result});
        } catch (error) { relayReceipts.set(incoming.id,{id:incoming.id,error:error.message}); }
      }
    } catch (error) {
      relayFailures = Math.min(5,relayFailures+1);
      if (session()?.source === 'phone') feedback('手机连接暂时不可用，未确认的作答不会计为已收。','warning');
    } finally { relayRunning = false; scheduleRelay(); }
  }
  function qrSvg(text) {
    const qr = qrcodegen.QrCode.encodeText(text,qrcodegen.QrCode.Ecc.MEDIUM), paths = [];
    for(let y=0;y<qr.size;y++) for(let x=0;x<qr.size;x++) if(qr.getModule(x,y)) paths.push(`M${x+4},${y+4}h1v1h-1z`);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${qr.size+8} ${qr.size+8}" role="img" aria-label="手机配对二维码"><rect width="100%" height="100%" fill="white"/><path d="${paths.join('')}" fill="black"/></svg>`;
  }
  async function setSource() {
    scanner.stop();
    if (session().source === 'phone') { await dispatch(command('set_source',{source:'board',sourceId:'board'})); pair = null; feedback('采集来源已换回本机。'); return; }
    pair = await request('pair',{sessionId:session().id});
    $('confirm-phone').disabled = true;
    $('pair-code').textContent = pair.code; $('pair-url').textContent = pair.url;
    $('pair-qr').innerHTML = qrSvg(pair.url); $('pair-status').textContent = '配对码 5 分钟内有效。登录配对后，在白板确认切换。';
    $('pair-dialog').showModal();
  }
  function editorAnswer(){return $('edit-answer-multiple').hidden?$('edit-answer').value:[...$('edit-answer-choices').querySelectorAll('input:checked')].map(i=>i.value).join('');}
  function setEditorAnswer(value){
    $('edit-answer').value=value?.length===1?value:'';
    $('edit-answer-choices').querySelectorAll('input').forEach(input=>input.checked=Boolean(value?.includes(input.value)));
  }
  function editOptions() {
    const selected=editorAnswer(),multiple=$('edit-type').value==='multiple';
    const values = [...$('edit-options').querySelectorAll('input')].map(i=>i.value), boolean = $('edit-type').value === 'boolean';
    const snapshot = !editorAdding && Boolean(question()?.bankId);
    $('edit-count').disabled = boolean || snapshot || Boolean(!editorAdding && question()?.rounds.some(r=>Object.keys(r.answers).length)) || Boolean(!editorAdding && question()?.type==='multiple' && question()?.rounds.length);
    const count = boolean ? 2 : Number($('edit-count').value);
    $('edit-options').innerHTML = Array.from({length:count},(_,i)=>`<label>选项 ${letters[i]}<input maxlength="4000" value="${esc(boolean?['正确','错误'][i]:values[i] || '')}"${boolean||snapshot?' readonly':''}></label>`).join('');
    $('edit-answer').innerHTML = '<option value="">暂不设置</option>' + letters.slice(0,count).split('').map(l=>`<option>${l}</option>`).join('');
    $('edit-answer-choices').innerHTML=letters.slice(0,count).split('').map(l=>`<label><input type="checkbox" value="${l}"><span>${l}</span></label>`).join('');
    $('edit-answer-multiple').hidden=!multiple;$('edit-answer-single').hidden=multiple;
    setEditorAnswer(selected);
  }
  function openEditor(adding) {
    editorAdding = adding; const q = adding ? {type:'single',options:['','','',''],answer:null,tags:[],text:''} : question();
    const s = session();
    editorContext = {sessionId:s.id,questionId:s.currentQuestionId,roundId:s.currentRoundId,generation:s.generation,sourceId:s.sourceId,revision:q.revision};
    $('editor-heading').textContent = adding ? '添加临时题' : '题目与答案';
    $('edit-text').value = q.text; $('edit-type').value = q.type; $('edit-count').value = q.options.length;
    $('edit-type').disabled = !adding && (Boolean(q.bankId) || q.rounds.some(r=>Object.keys(r.answers).length) || q.type==='multiple' && q.rounds.length > 0);
    $('edit-type').querySelector('option[value="multiple"]').disabled = !adding && q.type!=='multiple' && q.rounds.length > 0;
    $('editor-snapshot-note').hidden = adding || !q.bankId;
    $('editor-round-note').hidden = adding || Boolean(q.bankId) || !q.rounds.length;
    $('editor-round-note').textContent = q.type==='multiple'?'本题已开始过收答，题型和选项数量已固定；需要更改时请添加临时题。':'本题已有收答轮次；需要改为多选时请添加临时题。';
    $('edit-options').replaceChildren(); editOptions();
    [...$('edit-options').querySelectorAll('input')].forEach((input,i)=>input.value = q.options[i] || '');
    setEditorAnswer(q.answer); $('edit-tags').value = q.tags.join('，'); $('editor-error').textContent = '';
    $('editor').showModal();
  }
  function confirm(title,description) {
    $('confirm-heading').textContent = title; $('confirm-description').textContent = description;
    const dialog = $('confirm-dialog'); dialog.showModal();
    return new Promise(resolve => {
      const close = result => { dialog.close(); $('confirm-ok').onclick = null; $('confirm-cancel').onclick = null; dialog.oncancel = null; resolve(result); };
      $('confirm-ok').onclick = () => close(true); $('confirm-cancel').onclick = () => close(false); dialog.oncancel = event => { event.preventDefault(); close(false); };
    });
  }
  async function startRound() {
    await dispatch(command(round()?.status === 'paused' ? 'resume_round' : 'start_round'));
    if (session().source === 'board' && !data?.context?.revoked) {
      try { await scanner.start(); render(); }
      catch (error) { feedback('课堂正在收答；相机未开启：' + error.message,'error'); }
    }
  }
  async function suspend() {
    scanner.stop(); clearTimeout(relayTimer);
    try {
      if (controller) await controller.queue;
      if (active() && !frozen && round()?.status === 'collecting') await dispatch(command('recover'));
      native?.postMessage({type:'suspended',saved:true});
    } catch (error) { feedback(error.message,'error'); native?.postMessage({type:'suspended',saved:frozen}); }
  }
  async function run(task) {
    if (operation) return;
    operation = true; render();
    try { await task(); } catch (error) { feedback(error.message,'error'); }
    finally { operation = false; render(); }
  }
  $('create-session').onclick = () => run(createSession);
  $('refresh').onclick = () => run(async () => { data = await request('bootstrap'); renderSetup(); feedback(data.error || '名单和题单已刷新。',data.error?'warning':''); });
  $('saved-sessions').onclick = event => { const id = event.target.closest('[data-resume]')?.dataset.resume; if (id) run(()=>restore(id)); };
  $('start').onclick = () => run(startRound);
  $('stop').onclick = () => { scanner.stop(); run(async()=>{ await dispatch(command('end_round')); feedback('本轮已封存。'); }); };
  $('camera-toggle').onclick = () => run(async()=>{ if (scanner.running) scanner.stop(); else await scanner.start(); });
  function switchMultiOption(option){
    if(option===round()?.activeOption)return;
    scanner.stop();return run(async()=>{await dispatch(command('set_multi_option',{option}));feedback(`已切换到 ${option} 项，请学生调整卡面后${session().source==='phone'?'在手机':'再'}开启相机。`);});
  }
  $('multi-option').onchange = event => switchMultiOption(event.target.value);
  $('multi-next').onclick = () => switchMultiOption(letters[letters.indexOf(round()?.activeOption)+1]);
  $('source').onclick = () => run(setSource);
  $('confirm-phone').onclick = () => run(async()=>{
    if (!pair || Date.now() >= pair.expiresAt) throw new Error('配对码已过期，请关闭并重新配对。');
    await dispatch(command('set_source',{source:'phone',sourceId:pair.pairId})); $('pair-dialog').close(); feedback('手机成为本课堂采集来源，请在手机核对题号后开启相机。');
  });
  $('edit').onclick = () => openEditor(false); $('temporary').onclick = () => openEditor(true);
  $('edit-type').onchange = editOptions; $('edit-count').onchange = editOptions;
  $('question-form').onsubmit = event => {
    event.preventDefault(); run(async()=>{
      const s = session(), q = question();
      if (!editorContext || s.id !== editorContext.sessionId || s.currentQuestionId !== editorContext.questionId ||
          s.generation !== editorContext.generation || (!editorAdding && q?.revision !== editorContext.revision)) {
        $('editor-error').textContent = '题目或版本已变化，草稿已保留。请核对当前题目，关闭后重新编辑。'; return;
      }
      const payload = {type:$('edit-type').value,text:$('edit-text').value,options:[...$('edit-options').querySelectorAll('input')].map(i=>i.value),answer:editorAnswer() || null,tags:$('edit-tags').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean)};
      if (!editorAdding) payload.revision = editorContext.revision;
      const value = {...command(editorAdding?'add_question':'edit_question',payload),...editorContext}; delete value.revision;
      const controls = [...$('question-form').querySelectorAll('input,textarea,select,button')].map(node=>[node,node.disabled]);
      controls.forEach(([node])=>node.disabled=true);
      try { await dispatch(value); $('editor').close(); feedback('题目信息已保存。'); }
      catch(error) { $('editor-error').textContent = error.message; }
      finally { controls.forEach(([node,disabled])=>node.disabled=disabled); }
    });
  };
  $('next').onclick = () => run(async()=>{ await dispatch(command('add_question',nextFromDeck() || {type:'single',options:['','','','']})); feedback('新题已准备。'); $('question-heading').focus(); });
  $('reveal').onclick = () => run(async()=>{ await dispatch(command('reveal',{external:!question().answer})); feedback('本题已标记讲解；后续重答记为练习。'); });
  $('show-distribution').onclick = () => { const key = `${session().id}/${question()?.id}/${round()?.id}`; distributionRound = distributionRound === key ? '' : key; render(); };
  $('exempt').onclick = () => {
    $('exempt-cards').innerHTML = session().roster.map(s=>`<label><input type="checkbox" data-student="${esc(s.id)}"${round().exempt.includes(s.id)?' checked':''}>${s.cardNumber} 号</label>`).join(''); $('exempt-dialog').showModal();
  };
  $('exempt-cards').onchange = event => { const input = event.target; if (input.dataset.student) run(async()=>{try{await dispatch(command('set_exempt',{studentId:input.dataset.student,exempt:input.checked}));}catch(error){input.checked=!input.checked;throw error;}}); };
  $('end-session').onclick = () => run(async()=>{
    if (!await confirm('结束本课堂？','当前轮次将封存。本机记录保留，联网后同步到教师工作台。')) return;
    scanner.stop(); await dispatch(command('end_session')); clearTimeout(relayTimer);
    try { mergeSync(await request('sync')); } catch(error) { feedback('课堂已结束，本机记录保留待同步。' + error.message,'warning'); }
  });
  $('sync').onclick = () => run(async()=>{ mergeSync(await request('sync',{retry:true})); feedback(controller.journal.reviewError || '已核对本机同步状态。',controller.journal.reviewError?'warning':''); });
  $('compact').onclick = () => run(()=>request('compact',{enabled:true,expanded:true}));
  $('close').onclick = () => request('close').catch(error=>feedback(error.message,'error'));
  document.querySelectorAll('[data-dismiss]').forEach(button=>button.onclick=() => $(button.dataset.dismiss).close());
  document.addEventListener('visibilitychange',()=>{if(document.hidden)suspend();});
  window.addEventListener('pagehide',()=>{disposed=true;scanner.stop();clearTimeout(relayTimer);clearTimeout(syncTimer);});
  if (native) native.addEventListener('message',event=>{
    const value = event.data; if (!value || typeof value !== 'object') return;
    if (value.type === 'response') { const task = pending.get(value.id); if (!task) return; clearTimeout(task.timeout); pending.delete(value.id); value.error ? task.reject(new Error(value.error)) : task.resolve(value.value); }
    else if (value.type === 'suspend') suspend();
    else if (value.type === 'authorization' && value.revoked) { scanner.stop(); if (data?.context) data.context.revoked = true; render(); feedback(value.message || '设备授权已失效，采集已停止，本机记录保留待核对。','error'); }
    else if (value.type === 'compact') { if (value.value && !session()) startInWheel = true; renderWheel(); }
    else if (value.type === 'companion-action') { if (value.action === 'multi') { if (!operation && wheel.targets.multi && !wheel.targets.multi.disabled && !wheel.targets.multi.hidden) wheel.targets.multi.click(); } else activateWheel(value.action); }
  });
  (async()=>{
    native?.postMessage({type:'ready'});
    try {
      data = await request('load'); render();
      feedback(data.error || '本班纸卡可重复使用；请先核对学科与出题方式。',data.error?'warning':'');
      try { data = await request('bootstrap'); renderSetup(); } catch(error) { feedback(error.message,'warning'); }
    } catch(error) { feedback(error.message,'error'); }
  })();
})();

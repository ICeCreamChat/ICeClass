(() => {
  'use strict';
  const $ = id => document.getElementById(id), Model = window.CardQuizModel, Journal = window.CardQuizJournal;
  const native = window.chrome?.webview, pending = new Map(), letters = 'ABCD';
  const subjects = {chinese:'语文',math:'数学',english:'英语',physics:'物理',chemistry:'化学',biology:'生物',politics:'政治',history:'历史',geography:'地理'};
  const slideTemplates = [
    ['single:4','单选 · A-D'], ['single:3','单选 · A-C'], ['single:2','单选 · A-B'],
    ['boolean:2','判断 · A 对 / B 错'],
    ['multiple:4','多选 · A-D'], ['multiple:3','多选 · A-C'], ['multiple:2','多选 · A-B']
  ];
  for (const id of ['first-template','next-template']) $(id).append(...slideTemplates.map(([value,label])=>new Option(label,value)));
  function slideQuestion(template) {
    const [type,count] = template.split(':');
    return {type,options:Array(Number(count)).fill('')};
  }
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let requestId = 0, data, controller, deck, pair, operation = false, frozen = false, disposed = false;
  let relayTimer, relayRunning = false, relayFailures = 0, syncTimer, editorAdding = false, editorContext, distributionRound = '';
  let hostVisible = true, suspension, visibilityRevision = 0;
  const companion = location.hash === '#banban';
  document.body.classList.toggle('banban',companion);
  let pane = '', paneQuestion = null, checkedRound = null;
  let pendingStatus = '';
  const titles = {capture:'收答控制',question:'题目与答案',distribution:'作答分布',next:'下一题',summary:'课堂汇总',history:'待同步课堂'};
  const paneNodes = [...document.querySelectorAll('[data-panes]')];
  function showPane(name) {
    pane = name;
    paneQuestion = question()?.id;
    document.body.dataset.pane = name;
    for (const node of paneNodes) node.classList.toggle('off-pane',!node.dataset.panes.split(' ').includes(name));
    $('pane-header').hidden = !name;
    $('pane-heading').textContent = titles[name] || '';
    if (name === 'summary') renderSummary();
    if (name === 'history') renderSetup();
    if (name === 'next') {
      const text = nextFromDeck()?.text;
      $('next-preview').textContent = `第 ${session().questions.length + 1} 题` + (text ? ' · ' + text : '');
    }
    if (name) { window.scrollTo(0,0); $('pane-heading').focus({preventScroll:true}); }
    renderWheel();
  }
  function openDialog(id) {
    $(id).showModal();
    renderWheel();
  }
  function back(dismissAll = false) {
    const dialog = document.querySelector('dialog[open]');
    if (dialog?.id === 'confirm-dialog') $('confirm-cancel').click();
    else if (dialog) dialog.close();
    if (!dialog || dismissAll) showPane('');
  }
  const relayReceipts = new Map();
  const relayUnavailable = '手机连接暂时不可用，未确认的作答不会计为已收。';
  function feedback(message, kind = '') {
    $('feedback').textContent = message; $('feedback').className = 'feedback ' + kind;
    const dialog = document.querySelector('dialog[open]');
    if (dialog && kind === 'error' && dialog.id !== 'editor') {
      let note = dialog.querySelector('[role="alert"]');
      if (!note) { note = document.createElement('p'); note.setAttribute('role','alert'); note.className = 'error'; dialog.append(note); }
      note.textContent = message;
    }
    if (!operation) renderWheel();
  }
  const wheel = new CardQuizWheel();
  const kindNames = {single:'单选',boolean:'判断',multiple:'多选'};
  function companionLesson(s,q,r,counts,setup) {
    const phase = !s ? 'home' : s.endedAt !== null ? 'done' : !r ? 'ready' :
      r.status === 'closed' ? 'result' : r.status === 'paused' ? 'paused' : 'collect';
    const number = s && q ? s.questions.indexOf(q) + 1 : 0;
    const multi = q?.type === 'multiple';
    const inRound = phase === 'collect' || phase === 'paused';
    const missing = inRound ? s.roster.filter(student => !r.exempt.includes(student.id) &&
      (multi ? !Object.hasOwn(r.answers[student.id]?.choices || {},r.activeOption) : !r.answers[student.id]))
      .map(student => student.cardNumber).sort((a,b)=>a-b) : [];
    const expected = counts?.expected ?? 0, received = multi && inRound ? counts.optionReceived : counts?.received ?? 0;
    const option = r?.activeOption || '', next = multi && option ? letters.slice(0,q.options.length)[letters.indexOf(option)+1] : '';
    const kind = kindNames[q?.type] || '';
    let primary = 'collect', label, enabled, heading, caption = '';
    switch (phase) {
      case 'home':
        primary = setup?.recovery ? 'setup-restore' : 'setup-start';
        label = setup?.recovery ? '恢复课堂' : '开始课堂'; heading = '班班课堂';
        caption = setup?.recovery?.label || (setup?.canCreate ?
          [data.className,subjects[setup.selection.subject],data.context.students.length+' 人'].filter(Boolean).join(' · ') : setup?.roster || '正在读取课堂…');
        enabled = setup?.recovery || setup?.canCreate; break;
      case 'ready':
        heading = '第 '+number+' 题'; label = q ? '开始收答' : '准备第一题';
        if (!q) primary = 'advance';
        enabled = q ? !$('start').disabled : !$('next').disabled;
        caption = !q ? '' : q.bankId ? '题单 · '+kind+'题' : [data.className,subjects[s.subjectId]].filter(Boolean).join(' · ');
        break;
      case 'paused':
        heading = '第 '+number+' 题 · '+(multi ? option+' 项暂停' : '已暂停');
        label = '继续收答'; enabled = !$('start').disabled; break;
      case 'collect':
        heading = '第 '+number+' 题 · '+(multi ? '收 '+option+' 项' : kind);
        if (s.source === 'board' && !scanner.running) {
          primary = 'open-camera'; label = '开启相机'; enabled = !$('camera-toggle').disabled;
        } else if (next) { primary = 'multi'; label = '收 '+next+' 项'; enabled = !$('multi-next').disabled; }
        else { label = '结束收答'; enabled = !$('stop').disabled; }
        break;
      case 'result':
        heading = '第 '+number+' 题 · 选择分布';
        primary = s.questions.length >= 100 ? 'finish' : 'advance';
        label = primary === 'finish' ? '结束课堂' : '下一题'; enabled = !$('next').disabled || primary === 'finish';
        caption = ['已答 '+received,counts.incomplete ? '未完成 '+counts.incomplete : '', '未答 '+counts.unanswered].filter(Boolean).join(' · ');
        break;
      case 'done':
        heading = '课堂已结束'; label = '返回班班'; primary = 'return-setup';
        enabled = !$('return-setup').disabled; caption = $('sync-status').textContent;
        break;
    }
    const canChooseType = phase === 'ready' && !!q && !q.bankId && !q.rounds.length && !q.answer && !q.imageId &&
      !q.text && !q.tags.length && (q.type === 'boolean' || !q.options.some(Boolean));
    return {phase,heading,caption,primary,label,enabled:Boolean(enabled && !operation && !frozen),number,
      kind:q?.type || '',option,optionCount:q?.options.length || 0,received,expected,missing,
      counts:phase==='result' ? Object.values(counts.distribution) : [],canChooseType:canChooseType && !data?.context?.revoked,
      busy:operation,questionCount:s?.questions.length || 0,phone:s?.source==='phone',
      needsSync:phase==='done' && (controller.journal.syncedSeq < s.seq || Boolean(controller.journal.reviewError)),
      records:phase!=='done' ? [] : s.questions.map(item => {
        const official = Model.officialRound(item);
        const totals = official && Model.roundSummary(s,official);
        return {kind:item.type,counts:totals ? Object.values(totals.distribution) : [],received:totals?.received || 0,
          expected:totals?.expected || 0,unanswered:totals?.unanswered || 0,incomplete:totals?.incomplete || 0};
      }),
      key:[s?.id,q?.id,s?.generation,phase,primary].join('/')};
  }
  function renderWheel() {
    const s = session(), q = question(), r = round(), summary = s && Model.roundSummary(s,r);
    const collecting = r?.status === 'collecting', ended = Boolean(s && !active()), setup = !s && data && !frozen ? wheelSetup() : null;
    const multiple = collecting && q?.type === 'multiple';
    const nextOption = multiple && letters.slice(0,q.options.length)[letters.indexOf(r.activeOption) + 1];
    const history = !s && data && savedJournals().some(j => j.session.endedAt !== null);
    const captureControls = (collecting || r?.status === 'paused') && !ended;
    const openCamera = collecting && s.source === 'board' && !scanner.running;
    const target = $(ended ? 'return-setup' : collecting ? 'stop' : 'start');
    const collectLabel = !s ? (setup?.recovery ? '恢复课堂' : '开始课堂') : ended ? '下一堂课' : target.textContent;
    const notice = $('feedback');
    let status = !s ? '' : ended ? $('sync-status').textContent : $('round-status').textContent;
    if (multiple) {
      const camera = s.source === 'phone' ? '手机收答中' : scanner.running ? '本机相机收答中' : '等待开启相机';
      status = `收 ${r.activeOption} 项 · 本项 ${summary.optionReceived} / ${summary.expected} 人\nA 朝上选，B 朝上不选\n${camera}`;
    }
    if (active() && notice.classList.contains('warning')) status = notice.textContent;
    wheel.update({
      hasSession:Boolean(s),setup,lesson:companionLesson(s,q,r,summary,setup),panel:document.querySelector('dialog[open]')?.id || pane,retry:frozen || !data && notice.classList.contains('error'),
      enabled:{collect:setup ? !operation && !frozen : undefined,camera:captureControls && !operation && !frozen && !data?.context?.revoked,
        edit:Boolean(q && active() && !operation),
        'end-session':ended || history ? !operation : undefined},
      targets:s?{collect:target,camera:$('camera-toggle'),source:$('source'),next:$('next'),
        'end-session':$('end-session'),exempt:$('exempt'),edit:$('edit'),distribution:$('show-distribution'),multi:$('multi-next')}:{},
      labels:{collect:collectLabel,camera:openCamera ? '开启相机' : captureControls ? '收答控制' : '本机相机',
        edit:captureControls ? '查看题目' : '题目答案',
        source:s?.source==='phone'?'换回本机':'手机扫码','end-session':ended?'课堂汇总':history?'待同步课':'结束课堂'},
      progress:setup ? setup.roster : s ? `第 ${s.questions.indexOf(q)+1} 题 · 已收 ${summary.received} / ${summary.expected} 人` : '正在读取纸卡课堂…',
      status:pendingStatus || status,
      multiple,multiEnabled:multiple && !$('multi-next').disabled,multiLabel:nextOption ? `收 ${nextOption} 项` : '',
      cameraRunning:scanner.running,feedback:notice.textContent,error:notice.classList.contains('error')
    });
  }
  function activateWheel(id) {
    if (id === 'back' || id === 'dismiss') { back(id === 'dismiss'); return; }
    if (operation || disposed || !wheel.actions?.some(action => action.id === id && action.enabled) || document.querySelector('dialog[open]')) return;
    const target = wheel.targets[id];
    if (id === 'end-session' && !active()) { showPane(session() ? 'summary' : 'history'); return; }
    if (id === 'camera') {
      showPane('capture');
      if (round()?.status === 'collecting' && session().source === 'board' && !scanner.running && !target.disabled) target.click();
      return;
    }
    if (id === 'edit') { showPane('question'); return; }
    if (id === 'next') { showPane('next'); return; }
    if (id === 'distribution') {
      if ($('distribution').hidden) target.click();
      showPane('distribution'); return;
    }
    if (target && !target.disabled && !target.hidden) target.click();
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
  const canCapture = () => hostVisible && !document.hidden && !suspension && !disposed && !data?.context?.revoked && !frozen;
  const canPrepareRound = () => active() && Boolean(question()) && !operation && !disposed && !data?.context?.revoked && !frozen;
  function command(action,payload = {},s = session()) {
    return {id:crypto.randomUUID(),sessionId:s.id,questionId:s.currentQuestionId,roundId:s.currentRoundId,generation:s.generation,sourceId:s.sourceId,action,payload};
  }
  const scanner = new CardQuizScanner({video:$('camera'),readTrack:companion,onRead:async read => {
    if (data?.context?.revoked) throw new Error('设备授权已失效，采集已停止。');
    if (!active() || !canCapture() || session().source !== 'board' || round()?.status !== 'collecting') return;
    if (!session().roster.some(student => student.cardNumber === read.cardNumber)) return;
    await dispatch(command('answer',{...read,...(question()?.type==='multiple'?{targetOption:round().activeOption}:{})}));
  },onStatus:({message,kind}) => {
    if (kind === 'error' && !scanner.running) render();
    $('camera-status').textContent = message;
    if (kind === 'error') feedback(message,'error');
  }});
  function newController(journal) {
    return new Journal.Controller(journal,next => request('commit',{journal:next}));
  }
  async function commit(target,value) {
    try { return await target.dispatch(value); }
    catch (error) {
      if (!target.pending) throw error;
      frozen = true; scanner.stop(); render();
      const message = '保存尚未确认。' + (companion ? '请返回圆环，点“重读记录”核对。' : '请关闭并重新打开，核对本机记录。') + error.message;
      feedback(message,'error'); throw new Error(message);
    }
  }
  async function dispatch(value) {
    if (frozen) throw new Error('请先重新打开，核对本机已保存的记录。');
    if (data?.context?.revoked && !['recover','end_round','end_session'].includes(value.action)) throw new Error('设备授权已失效，采集已停止，本机记录保留。');
    const result = await commit(controller,value); render(); return {...result,state:{...result.state,className:data?.className || ''}};
  }
  const savedJournals = () => (data?.journals || []).filter(j => j.session.id !== session()?.id &&
    (j.session.endedAt === null || j.syncedSeq < j.session.seq || j.reviewError)).sort((a,b) => b.session.startedAt-a.session.startedAt);
  const unfinishedJournal = () => savedJournals().find(j => j.session.endedAt === null);
  const journalLabel = ({session:s}) => `${subjects[s.subjectId] || s.subjectId} · ${new Date(s.startedAt).toLocaleString('zh-CN')}`;
  const setupSelection = () => ({publication:$('publication').value,subject:$('subject').value,template:$('first-template').value});
  function wheelSetup() {
    const options = id => [...$(id).options].map(option => ({value:option.value,label:option.text}));
    const unfinished = unfinishedJournal();
    const feedback = $('feedback');
    return {
      roster:$('roster-status').textContent,publications:options('publication'),subjects:options('subject'),templates:options('first-template'),
      selection:setupSelection(),recovery:unfinished ? {value:unfinished.session.id,label:journalLabel(unfinished)} : null,
      canCreate:!$('create-session').hidden && !$('create-session').disabled,canRefresh:!$('refresh').disabled,busy:operation,
      notice:feedback.matches('.warning,.refreshed') ? feedback.textContent : ''
    };
  }
  function renderSetup() {
    if (!data) return;
    $('class-name').textContent = data.className || '创意工坊';
    const context = data.context;
    const saved = savedJournals();
    const unfinished = saved.some(j => j.session.endedAt === null);
    let ready = false;
    if (unfinished) $('roster-status').textContent = '本机有一堂未结束的课，可恢复原题和已收记录。';
    else if (context?.revoked) $('roster-status').textContent = '本机绑定已失效，请在教室设置中重新绑定。';
    else {
      try {
        $('roster-status').textContent = `已准备 ${Model.classRoster(context).length} 张本班纸卡。`;
        ready = true;
      } catch (error) { $('roster-status').textContent = error.message; }
    }
    $('setup-fields').hidden = $('create-session').hidden = unfinished;
    $('create-session').disabled = !ready || operation || frozen;
    $('refresh').disabled = operation;
    $('publication').disabled = $('subject').disabled = $('first-template').disabled = operation;
    const selected = $('publication').value;
    $('publication').innerHTML = '<option value="">配合课件临时出题</option>' + (context?.publications || []).map(p=>`<option value="${esc(p.id)}">${esc(p.title)} · ${p.questionCount} 题${p.cached?' · 已缓存':''}</option>`).join('');
    if ([...$('publication').options].some(o=>o.value===selected)) $('publication').value = selected;
    updateSetupFields();
    const entries = pane === 'history' ? saved.filter(j=>j.session.endedAt !== null) : saved;
    $('saved-sessions').innerHTML = entries.map(j=>`<div class="saved-session"><span>${esc(journalLabel(j))}<br><small>${j.session.endedAt===null?'课堂尚未结束':j.reviewError?'记录待核对':'记录待同步'}</small></span><button type="button" data-resume="${esc(j.session.id)}"${operation?' disabled':''}>${j.session.endedAt===null?'恢复课堂':'查看汇总'}</button></div>`).join('');
    $('history-empty').hidden = pane !== 'history' || entries.length > 0;
  }
  function updateSetupFields() {
    $('subject-field').hidden = $('first-template-field').hidden = Boolean($('publication').value);
  }
  function renderCardCheck(r,disabled) {
    if (!$('exempt-dialog').open || !r) return;
    const q = question(), sealed = r.status === 'closed';
    const currentOption = q?.type === 'multiple' && !sealed ? r.activeOption : null;
    $('card-check-scope').textContent = (currentOption ? `当前收答项 ${currentOption}。` : '') +
      (r.status === 'closed' ? '本轮已封存，可核对各卡状态。' : '勾选卡号设为本轮免答，已收答案保留。');
    for (const input of $('exempt-cards').querySelectorAll('input')) {
      const id = input.dataset.student, answer = r.answers[id], exempt = r.exempt.includes(id);
      const choices = answer?.choices || {};
      const received = currentOption ? Object.hasOwn(choices,currentOption) : Boolean(answer);
      const partial = sealed && received && !Model.completeAnswer(q,answer);
      const status = input.nextElementSibling.querySelector('.card-check-state');
      if (!operation) input.checked = exempt;
      input.disabled = disabled || r.status === 'closed';
      status.dataset.state = exempt ? 'exempt' : received && !partial ? 'received' : 'pending';
      status.textContent = exempt ? '免答' : partial ? '未完成' : received ? '已收' : sealed ? '未答' : '待收';
    }
  }
  function render() {
    const s = session(), q = question(), r = round(), exists = Boolean(s), ended = exists && !active();
    if ($('exempt-dialog').open && r?.id !== checkedRound) $('exempt-dialog').close();
    if (['question','next','distribution','capture'].includes(pane) &&
        (q?.id !== paneQuestion || pane === 'capture' && (!r || r.status === 'closed') ||
         pane === 'distribution' && distributionRound !== `${s?.id}/${q?.id}/${r?.id}`)) showPane('');
    $('setup').hidden = exists; $('workspace').hidden = !exists;
    $('workspace').classList.toggle('is-ended',ended);
    if (!active()) renderSetup();
    if (!exists) { renderWheel(); return; }
    native?.postMessage({type:'activity',busy:active()});
    $('class-name').textContent = `${data.className} · ${subjects[s.subjectId] || s.subjectId}`;
    const collecting = r?.status === 'collecting', between = !r || r.status === 'closed';
    const readOnly = operation || frozen || ended, disabled = readOnly || data?.context?.revoked;
    const summary = Model.roundSummary(s,r);
    $('question-number').textContent = q ? `第 ${s.questions.indexOf(q)+1} 题 · 共 ${s.questions.length} 题` : '尚无题目';
    $('question-heading').textContent = q ? (q.type === 'boolean' ? '判断题' : q.type === 'multiple' ? `多选题 · ${q.options.length} 个选项` : `${q.options.length} 选一`) : '准备出题';
    $('question-text').textContent = q?.text || '题目请看课件或黑板';
    const image = deck?.images?.[q?.imageId];
    $('question-image').hidden = !image;
    if (image && $('question-image').firstElementChild?.getAttribute('src') !== image) {
      const picture = document.createElement('img'); picture.alt = '题目配图'; picture.src = image; $('question-image').replaceChildren(picture);
    }
    if (!image) $('question-image').replaceChildren();
    $('options').hidden = !q?.options.some(Boolean);
    $('options').innerHTML = $('options').hidden ? '' : q.options.map(text=>`<li>${esc(text || '见课件')}</li>`).join('');
    $('round-kind').textContent = r?.purpose === 'practice' ? '讲解后练习 · 不覆盖正式记录' : '正式作答';
    $('round-kind').hidden = !r;
    $('received').textContent = summary.received; $('expected').textContent = ` / ${summary.expected} 人${q?.type==='multiple'?'整题完成':'已收'}`;
    const missing = summary.expected - (q?.type==='multiple' ? summary.optionReceived : summary.received);
    $('capture-progress').hidden = !r || r.status === 'closed';
    $('capture-progress').textContent = !summary.expected ? '本轮无人须答' : missing ? `待收 ${missing} 人` : q?.type==='multiple' ? '本项已收齐' : '本轮已收齐';
    $('multi-capture').hidden = q?.type !== 'multiple';
    if(q?.type==='multiple'){
      if($('multi-option').options.length!==q.options.length)$('multi-option').innerHTML=letters.slice(0,q.options.length).split('').map(l=>`<option value="${l}">${l} 项</option>`).join('');
      $('multi-option').value = r?.activeOption || 'A';
      $('multi-option').disabled = disabled || !collecting;
      $('multi-next').disabled = disabled || !collecting || letters.indexOf(r?.activeOption)>=q.options.length-1;
      $('multi-progress').textContent = !r ? '逐项收答，A 朝上选，B 朝上不选。' : `本项已收 ${summary.optionReceived} / ${summary.expected} 人${r.status==='closed'?` · 未完成 ${summary.incomplete} 人`:companion && s.source==='board'?' · 换项时请放下再举卡。':' · 换项后请开启相机。'}`;
    }
    $('round-status').textContent = ended ? '本课堂已结束' : collecting ? (s.source === 'phone' ? '手机收答中，白板保存后确认' : scanner.running ? '本机相机收答中' : '本轮进行中，相机未开启') : r?.status === 'paused' ? '已暂停，已收答案保留' : r ? '本轮已封存' : '等待开始收答';
    $('start').textContent = r?.status === 'paused' ? '恢复本轮' : r ? (q.revealed ? '讲解后练习' : '重新收答') : '开始收答';
    $('start').hidden = collecting || ended;
    $('start').classList.toggle('primary',r?.status !== 'closed');
    $('start').disabled = collecting || !canPrepareRound() || !canCapture();
    $('stop').hidden = between || ended;
    $('stop').classList.toggle('primary',collecting);
    $('stop').disabled = readOnly || between;
    $('pause').hidden = !collecting || ended;
    $('pause').disabled = disabled || !collecting;
    $('source').hidden = collecting;
    $('source').disabled = disabled || collecting;
    $('source').textContent = s.source === 'phone' ? '换回本机' : '使用手机';
    $('edit').hidden = !between || !q;
    $('edit').disabled = disabled || !between || !q;
    $('exempt').hidden = !r;
    $('exempt').disabled = operation || !r;
    $('reveal').hidden = !between || !q || q.revealed;
    $('reveal').disabled = disabled || !between || !q || q.revealed;
    $('reveal').textContent = q?.answer ? '揭晓答案' : '已在课件讲解';
    $('show-distribution').hidden = r?.status !== 'closed';
    $('show-distribution').disabled = operation || r?.status !== 'closed';
    $('next').disabled = disabled || !between;
    $('temporary').disabled = disabled || !between;
    $('end-session').hidden = ended;
    $('continue-actions').hidden = ended || !between;
    $('end-session').disabled = readOnly;
    $('return-setup').hidden = !ended;
    $('return-setup').disabled = operation;
    renderCardCheck(r,disabled);
    $('camera-toggle').hidden = ended || !collecting || s.source !== 'board';
    $('camera-toggle').disabled = operation || !canCapture();
    $('camera-toggle').textContent = scanner.running ? '关闭相机' : '开启相机';
    $('camera-status').hidden = !collecting || s.source !== 'board';
    $('camera').hidden = $('camera-status').hidden || !scanner.running;
    $('answer-display').hidden = !q?.revealed;
    $('answer-display').textContent = q?.answer ? `标准答案 ${q.answer}` : '已在课件中讲解';
    const roundKey = `${s.id}/${q?.id}/${r?.id}`;
    const showDistribution = r?.status === 'closed' && distributionRound === roundKey;
    $('show-distribution').textContent = showDistribution ? '收起分布' : '展示分布';
    $('show-distribution').setAttribute('aria-expanded',String(showDistribution));
    $('distribution').hidden = !showDistribution;
    $('distribution').innerHTML = showDistribution ? Object.entries(summary.distribution).map(([option,count])=>`<span>${option} · ${count} 人 · ${summary.received?(count/summary.received*100).toFixed(1)+'%':'暂无作答'}</span>`).join('') + (q?.type==='multiple'?`<span>未完成 · ${summary.incomplete} 人</span>`:'') + `<span>未答 · ${summary.unanswered} 人</span>` : '';
    $('sync-status').textContent = controller.journal.reviewError ? '待核对：' + controller.journal.reviewError : controller.journal.syncedSeq >= s.seq ? '已同步学校服务' : `已保存在本机 · ${s.seq-(controller.journal.syncedSeq || 0)} 条待同步`;
    $('sync').disabled = operation;
    $('summary-questions').hidden = !ended || !companion;
    scanner.reset(`${s.id}/${s.currentRoundId}/${s.generation}`,q?.type==='multiple'?2:q?.options.length || 4,
      `${s.id}/${s.currentRoundId}/${s.sourceId}/${r?.activeOption || ''}`);
    if (!collecting || s.source !== 'board' || frozen || ended) scanner.stop();
    const next = nextFromDeck();
    $('next').textContent = !q ? '准备第一题' : next ? '题单下一题' : '下一道课件题';
    $('next').classList.toggle('primary',r?.status === 'closed');
    $('next-template-field').hidden = !between || Boolean(next);
    $('next-template').disabled = disabled;
    renderWheel();
  }
  function renderSummary() {
    const s = session();
    $('summary-questions').innerHTML = s.questions.map((item,index) => {
      const formal = Model.officialRound(item), counts = formal && Model.roundSummary(s,formal);
      const label = {single:'单选',boolean:'判断',multiple:'多选'}[item.type];
      const result = counts ? `已答 ${counts.received} / ${counts.expected} 人${counts.incomplete ? ` · 未完成 ${counts.incomplete} 人` : ''}` : '无正式收答';
      const options = counts ? Object.entries(counts.distribution).map(([option,count]) => `${option} ${count} 人`).join(' · ') : '';
      const grade = counts?.received ? (counts.correct === null ? '未设标准答案' : `已答正确 ${counts.correct} / ${counts.received} 人`) : '';
      return `<li><strong>第 ${index + 1} 题 · ${label}</strong><span>${result}</span>${grade ? `<span>${grade}</span>` : ''}${options ? `<small>${options}</small>` : ''}</li>`;
    }).join('');
  }
  function nextFromDeck() {
    const questions = deck?.publication?.questions || [], used = session()?.questions.filter(q=>q.bankId).length || 0;
    return questions[used] || null;
  }
  async function createSession({publication:id,subject,template} = setupSelection()) {
    if (active() || unfinishedJournal()) throw new Error('请先恢复并结束尚未结束的课堂。');
    const hasOption = (field,value) => [...$(field).options].some(option => option.value === value);
    if (!hasOption('publication',id) || (!id && (!hasOption('subject',subject) || !hasOption('first-template',template))))
      throw new Error('开课选项已变化，请重新选择。');
    const selectedDeck = id ? await request('publication',{id}) : null;
    const questions = selectedDeck?.publication?.questions;
    if (id && !questions?.length) throw new Error('题单中没有可用题目。');
    const subjectId = questions?.[0]?.subjectId || subject;
    if (questions?.some(q=>q.subjectId!==subjectId)) throw new Error('题单包含多个学科，请在教师工作台按学科拆分。');
    const initial = Journal.create(Model.createSession(data.context,subjectId)); initial.publicationId = id || null;
    const created = newController(initial);
    await commit(created,command('add_question', questions?.[0] || slideQuestion(template), created.session));
    resetSessionControls();
    controller = created; deck = selectedDeck;
    $('publication').value = id;
    if (!id) { $('subject').value = subject; $('first-template').value = template; }
    $('next-template').value = id ? $('first-template').value : template;
    feedback('课堂已保存，可以开始收答。'); scheduleRelay(); scheduleSync();
  }
  async function restore(id) {
    const latest = await request('load'), journal = latest.journals.find(j=>j.session.id===id);
    if (!journal) throw new Error('本机课堂未找到，请核对记录。');
    data = latest;
    const restored = newController(journal);
    let restoredDeck = null, issue = '';
    if (journal.publicationId) {
      try { restoredDeck = await request('publication',{id:journal.publicationId,sessionId:id}); }
      catch (error) { issue = '题单缓存未能读取，已保存题目仍可使用。' + error.message; }
    }
    if (restored.session.endedAt === null) await commit(restored,command('recover',{},restored.session));
    resetSessionControls();
    controller = restored; deck = restoredDeck; frozen = false;
    const q = question(), template = q && `${q.type}:${q.options.length}`;
    if (slideTemplates.some(([value])=>value===template)) $('next-template').value = template;
    feedback(issue || (active() ? '已恢复本机记录，请核对题目与采集来源后继续。' : '已结束课堂的匿名汇总。'),issue?'warning':'');
    scheduleRelay(); scheduleSync();
  }
  function mergeSync(value) {
    data = value;
    const saved = value.journals?.find(j=>j.session.id===session()?.id);
    if (saved && saved.syncedSeq >= controller.journal.syncedSeq) {
      controller.journal.syncedSeq = saved.syncedSeq;
      controller.journal.reviewError = saved.reviewError;
    }
    render();
  }
  function scheduleSync() {
    clearTimeout(syncTimer);
    if (disposed || !controller) return;
    const current = controller;
    syncTimer = setTimeout(async () => {
      try {
        const value = await request('load');
        if (controller === current) mergeSync(value);
      } catch { /* Native outbox reports state on the next read. */ }
      if (controller === current) scheduleSync();
    },5000);
  }
  function scheduleRelay() {
    clearTimeout(relayTimer);
    if (!canCapture() || !active()) return;
    relayTimer = setTimeout(relay, Math.min(15000,750 * 2 ** relayFailures));
  }
  async function relay() {
    if (relayRunning || !active() || !canCapture()) return;
    relayRunning = true;
    const current = controller, visibleAt = visibilityRevision;
    const isCurrent = () => controller === current && active() && canCapture() && visibleAt === visibilityRevision;
    const sent = [...relayReceipts.values()];
    try {
      const value = await request('relay',{sessionId:session().id,state:Model.publicState(session(),data.className),receipts:sent});
      if (controller !== current) return;
      for (const receipt of sent) relayReceipts.delete(receipt.id);
      if (relayFailures && $('feedback').textContent === relayUnavailable) feedback('');
      relayFailures = 0;
      if (!isCurrent()) return;
      if (pair) {
        const ready = value.pairings?.find(p=>p.pairId === pair.pairId)?.claimed === true;
        $('confirm-phone').disabled = !ready;
        if (ready) $('pair-status').textContent = '老师已配对，请在白板确认使用此手机。';
      }
      for (const incoming of value.commands || []) {
        if (!isCurrent()) break;
        try {
          if (incoming.action === 'recover' || session().source !== 'phone') throw new Error('当前采集许可已失效。');
          const result = await dispatch(incoming); relayReceipts.set(incoming.id,{id:incoming.id,result});
        } catch (error) { relayReceipts.set(incoming.id,{id:incoming.id,error:error.message}); }
      }
    } catch (error) {
      if (!isCurrent()) return;
      relayFailures = Math.min(5,relayFailures+1);
      if (session()?.source === 'phone') feedback(relayUnavailable,'warning');
    } finally { relayRunning = false; scheduleRelay(); }
  }
  function qrSvg(text) {
    const qr = qrcodegen.QrCode.encodeText(text,qrcodegen.QrCode.Ecc.MEDIUM), paths = [];
    for(let y=0;y<qr.size;y++) for(let x=0;x<qr.size;x++) if(qr.getModule(x,y)) paths.push(`M${x+4},${y+4}h1v1h-1z`);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${qr.size+8} ${qr.size+8}" role="img" aria-label="手机配对二维码"><rect width="100%" height="100%" fill="white"/><path d="${paths.join('')}" fill="black"/></svg>`;
  }
  async function setSource() {
    scanner.stop();
    if (session().source === 'phone') { await saveSource('board','board'); pair = null; feedback('已换回本机，可以继续收答。'); return; }
    pair = await request('pair',{sessionId:session().id});
    $('confirm-phone').disabled = true;
    $('pair-code').textContent = pair.code; $('pair-url').textContent = pair.url;
    $('pair-qr').innerHTML = qrSvg(pair.url); $('pair-status').textContent = '配对码 5 分钟内有效。登录配对后，在白板确认切换。';
    openDialog('pair-dialog');
  }
  async function saveSource(source,sourceId) {
    await dispatch(command('set_source',{source,sourceId}));
    if (round()?.status !== 'paused') return;
    const current = controller;
    void request('sync').then(value => {
      if (controller === current) mergeSync(value);
    }).catch(() => { /* The native outbox retries the saved handoff. */ });
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
    openDialog('editor');
  }
  function confirm(title,description) {
    $('confirm-heading').textContent = title; $('confirm-description').textContent = description;
    const dialog = $('confirm-dialog'); openDialog('confirm-dialog');
    return new Promise(resolve => {
      const close = result => { dialog.close(); $('confirm-ok').onclick = null; $('confirm-cancel').onclick = null; dialog.oncancel = null; resolve(result); };
      $('confirm-ok').onclick = () => close(true); $('confirm-cancel').onclick = () => close(false); dialog.oncancel = event => { event.preventDefault(); close(false); };
    });
  }
  async function startRound() {
    const visibleAt = visibilityRevision;
    await dispatch(command(round()?.status === 'paused' ? 'resume_round' : 'start_round'));
    await openBoardCamera(visibleAt);
  }
  async function openBoardCamera(visibleAt) {
    if (visibleAt === visibilityRevision && canCapture() && session().source === 'board' && round()?.status === 'collecting') {
      try { await scanner.start(); }
      catch (error) {
        if (canCapture() && round()?.status === 'collecting') await pauseRound();
        feedback('本机相机未开启。可恢复本轮重试，或使用手机继续。' + error.message,'error');
      }
    }
  }
  async function pauseRound() {
    scanner.stop();
    await dispatch(command('recover'));
    feedback('已暂停本轮。可恢复收答或切换设备。');
  }
  async function savePause() {
    try {
      if (controller) await controller.queue;
      if (active() && !frozen && round()?.status === 'collecting') await dispatch(command('recover'));
      native?.postMessage({type:'suspended',saved:true});
    } catch (error) { feedback(error.message,'error'); native?.postMessage({type:'suspended',saved:frozen}); }
  }
  function suspend() {
    visibilityRevision++;
    scanner.stop(); clearTimeout(relayTimer);
    suspension ??= savePause().finally(() => { suspension = null; render(); });
    return suspension;
  }
  function updateVisibility() {
    if (!hostVisible || document.hidden) { void suspend(); return; }
    render();
    if (suspension) void suspension.then(scheduleRelay);
    else scheduleRelay();
  }
  async function run(task, status = '') {
    if (operation) return;
    operation = true; pendingStatus = status;
    if (active() && !frozen && !data?.context?.revoked && $('feedback').matches('.error,.warning')) feedback('');
    render();
    try { await task(); } catch (error) { feedback(error.message,'error'); }
    finally { operation = false; pendingStatus = ''; render(); }
  }
  function resetSessionControls() {
    pair = null; relayReceipts.clear(); relayFailures = 0; distributionRound = '';
    clearTimeout(relayTimer); clearTimeout(syncTimer);
  }
  async function refreshSetup() {
    data = await request('bootstrap');
    render();
    const error = data.errors?.join(' ') || data.error;
    feedback(error || '名单和题单已刷新。',error?'warning':'refreshed');
  }
  function activateSetup({action,selection,sessionId}) {
    if (!data || active() || operation || disposed) return;
    if (action === 'setup-start' && selection && !$('create-session').hidden && !$('create-session').disabled)
      void run(() => createSession(selection));
    else if (action === 'setup-restore' && unfinishedJournal()?.session.id === sessionId)
      void run(() => restore(sessionId));
    else if (action === 'setup-refresh' && !$('refresh').disabled) void run(refreshSetup);
  }
  $('create-session').onclick = () => run(createSession);
  $('publication').onchange = updateSetupFields;
  $('refresh').onclick = () => run(refreshSetup);
  $('saved-sessions').onclick = event => {
    const id = event.target.closest('[data-resume]')?.dataset.resume;
    if (id && !active()) run(async () => { await restore(id); if (companion) showPane(active() ? '' : 'summary'); });
  };
  $('start').onclick = () => run(startRound,'正在开始收答…');
  $('stop').onclick = () => { scanner.stop(); run(async()=>{ await dispatch(command('end_round')); feedback('本轮已封存。'); if (pane === 'capture') showPane(''); }); };
  $('pause').onclick = () => run(async () => { await pauseRound(); if (pane === 'capture') showPane(''); });
  $('camera-toggle').onclick = () => run(async()=>{
    if (scanner.running) { scanner.stop(); $('camera-status').textContent = '相机已关闭，已收记录保留。'; }
    else if (canCapture()) await scanner.start();
  });
  function switchMultiOption(option){
    if(operation || !option || option===round()?.activeOption)return;
    const visibleAt = visibilityRevision, autoOpen = companion && session().source === 'board';
    const previousCards = autoOpen ? scanner.cardsInView() : null;
    scanner.stop();
    return run(async()=>{
      await dispatch(command('set_multi_option',{option}));
      if (autoOpen) scanner.waitForNewPresentation(previousCards);
      feedback(autoOpen ? `收 ${option} 项，请放下再举卡。` : `收 ${option} 项，请调整卡面后在${session().source==='phone'?'手机':'本机'}开启相机。`);
      if (autoOpen) await openBoardCamera(visibleAt);
    },'正在切换收答项…');
  }
  $('multi-option').onchange = event => switchMultiOption(event.target.value);
  $('multi-next').onclick = () => switchMultiOption(letters[letters.indexOf(round()?.activeOption)+1]);
  $('source').onclick = () => run(setSource,session().source === 'board' ? '正在获取配对码…' : '正在换回本机…');
  $('confirm-phone').onclick = () => run(async()=>{
    if (!pair || Date.now() >= pair.expiresAt) throw new Error('配对码已过期，请关闭并重新配对。');
    await saveSource('phone',pair.pairId); $('pair-dialog').close(); feedback('已切换到手机，请在手机上开始或恢复收答。');
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
      try { await dispatch(value); $('editor').close(); feedback('题目信息已保存。'); if (editorAdding && pane === 'next') showPane(''); }
      catch(error) { $('editor-error').textContent = error.message; }
      finally { controls.forEach(([node,disabled])=>node.disabled=disabled); }
    });
  };
  $('next').onclick = () => run(async()=>{ await dispatch(command('add_question',nextFromDeck() || slideQuestion($('next-template').value))); feedback('新题已准备。'); if (pane) showPane(''); else $('question-heading').focus({preventScroll:true}); });
  $('reveal').onclick = () => run(async()=>{ await dispatch(command('reveal',{external:!question().answer})); feedback('本题已标记讲解；后续重答记为练习。'); });
  $('show-distribution').onclick = () => { const key = `${session().id}/${question()?.id}/${round()?.id}`; distributionRound = distributionRound === key ? '' : key; render(); };
  $('exempt').onclick = () => {
    checkedRound = round()?.id;
    $('exempt-cards').innerHTML = [...session().roster].sort((a,b)=>a.cardNumber-b.cardNumber).map(s=>`<label><input type="checkbox" data-student="${esc(s.id)}" aria-label="${s.cardNumber} 号免答" aria-describedby="card-check-${s.cardNumber}"><span>${s.cardNumber} 号 <small id="card-check-${s.cardNumber}" class="card-check-state"></small></span></label>`).join('');
    openDialog('exempt-dialog'); renderCardCheck(round(),frozen || !active() || data?.context?.revoked);
  };
  $('exempt-cards').onchange = event => {
    const {checked,dataset:{student}} = event.target;
    if (student && active() && !frozen && !data?.context?.revoked && round()?.id === checkedRound && round()?.status !== 'closed')
      run(()=>dispatch(command('set_exempt',{studentId:student,exempt:checked})));
  };
  $('end-session').onclick = () => run(async()=>{
    if (!await confirm('结束本课堂？','当前轮次将封存。本机记录保留，联网后同步到学校服务。')) return;
    await finishSession(true);
  });
  async function finishSession(showSummary) {
    scanner.stop(); await dispatch(command('end_session')); clearTimeout(relayTimer);
    if (companion && showSummary) showPane('summary');
    feedback('课堂已结束，记录已保存在本机。');
    const ended = controller;
    void request('sync').then(value => {
      if (controller === ended) mergeSync(value);
    }).catch(error => {
      if (controller === ended) feedback('本机记录待同步。' + error.message,'warning');
    });
  }
  async function returnToSetup(collapse = false) {
    data = await request('load');
    controller = deck = null;
    resetSessionControls();
    if (pane) showPane('');
    render(); feedback('可以开始下一堂课。'); $('setup-heading').focus();
    if (collapse) native?.postMessage({type:'collapse'});
  }
  $('return-setup').onclick = () => run(() => returnToSetup());
  $('sync').onclick = () => run(async()=>{ mergeSync(await request('sync',{retry:true})); feedback(controller.journal.reviewError || '已核对本机同步状态。',controller.journal.reviewError?'warning':''); });
  $('pane-back').onclick = () => back();
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close',() => {
    dialog.querySelector('p[role="alert"]:not(#editor-error)')?.remove();
    if (dialog.id === 'pair-dialog') pair = null;
    renderWheel();
  }));
  document.addEventListener('keydown',event => {
    if (!companion || event.defaultPrevented) return;
    if (event.key === 'Escape' && !document.querySelector('dialog[open]') && pane) { event.preventDefault(); back(); }
    else if (event.key === 'F4' && !event.altKey) { event.preventDefault(); native?.postMessage({type:'collapse'}); }
  });
  document.querySelectorAll('[data-dismiss]').forEach(button=>button.onclick=() => $(button.dataset.dismiss).close());
  document.addEventListener('visibilitychange',updateVisibility);
  window.addEventListener('pagehide',()=>{disposed=true;scanner.stop();clearTimeout(relayTimer);clearTimeout(syncTimer);});
  if (native) native.addEventListener('message',event=>{
    const value = event.data; if (!value || typeof value !== 'object') return;
    if (value.type === 'response') { const task = pending.get(value.id); if (!task) return; clearTimeout(task.timeout); pending.delete(value.id); value.error ? task.reject(new Error(value.error)) : task.resolve(value.value); }
    else if (value.type === 'suspend') void suspend();
    else if (value.type === 'visibility') { hostVisible = value.visible === true; updateVisibility(); }
    else if (value.type === 'authorization' && value.revoked) { scanner.stop(); if (data?.context) data.context.revoked = true; render(); feedback(value.message || '设备授权已失效，采集已停止，本机记录保留待核对。','error'); }
    else if (value.type === 'companion-action' && typeof value.action === 'string') {
      const lesson = wheel.lesson;
      if (value.key && value.key !== lesson?.key) return;
      if (value.action.startsWith('setup-')) activateSetup(value);
      else if (value.action === 'advance' && !operation && !$('next').disabled) $('next').click();
      else if (value.action === 'open-camera' && canCapture() && !operation && round()?.status === 'collecting' && !scanner.running)
        void run(() => openBoardCamera(visibilityRevision));
      else if (value.action === 'finish-confirmed' && active() && !operation && !frozen) void run(() => finishSession(false));
      else if (value.action === 'return-setup' && session()?.endedAt && !$('return-setup').disabled) void run(() => returnToSetup(true));
      else if (value.action === 'sync-now' && lesson?.needsSync && !operation) $('sync').click();
      else if (value.action.startsWith('kind-') && lesson?.canChooseType && !operation && !frozen) {
        const type = value.action.slice(5);
        if (!Object.hasOwn(kindNames,type) || type === question().type) return;
        const template = type+':'+(type==='boolean'?2:4);
        void run(async () => {
          await dispatch(command('edit_question',{...slideQuestion(template),revision:question().revision}));
          $('next-template').value=template;
        });
      }
      else if (value.action === 'multi') {
        if (!operation && wheel.targets.multi && !wheel.targets.multi.disabled && !wheel.targets.multi.hidden) wheel.targets.multi.click();
      } else activateWheel(value.action);
    }
  });
  (async()=>{
    if (companion) showPane('');
    native?.postMessage({type:'ready'});
    try {
      data = await request('load'); render();
      const error = data.errors?.join(' ') || data.error;
      feedback(error || '',error?'warning':'');
      try {
        mergeSync(await request('bootstrap'));
        const issue = data.errors?.join(' ') || data.error;
        if (!controller && !operation && !frozen) feedback(issue || '',issue?'warning':'');
      } catch(error) { if (!controller && !operation && !frozen) feedback(error.message,'warning'); }
    } catch(error) { feedback(error.message,'error'); }
  })();
})();

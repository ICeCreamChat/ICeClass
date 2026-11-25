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
  let hostVisible = true, suspension, pendingPause, visibilityRevision = 0;
  const companion = location.hash === '#banban';
  document.body.classList.toggle('banban',companion);
  let pane = '', paneQuestion = null, paneOption = null, recordIndex = null, checkedRound = null, historyRecord = null;
  const cardsPerPage = 6;
  let cardPage = 0;
  let cardStates = [], pendingCardsOnly = false, locatedCard = null;
  let pendingStatus = '';
  const titles = {capture:'收答控制',options:'调整收答项',question:'题目与答案',distribution:'作答分布',next:'下一题',summary:'课堂汇总',history:'待同步课堂'};
  const paneNodes = [...document.querySelectorAll('[data-panes]')];
  const disc = companion ? new CardQuizDisc(renderWheel) : null;
  const discEditor = companion ? new CardQuizDiscEditor(renderWheel) : null;
  let currentDiscPage = null;
  function showPane(name, record = null) {
    pane = name;
    recordIndex = record;
    paneQuestion = question()?.id;
    paneOption = name === 'options' ? round()?.activeOption : null;
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
    if (!dismissAll && currentDiscPage && (dialog?.id === 'editor' ? discEditor : disc).back()) return;
    if (!dismissAll && dialog?.id === 'exempt-dialog' && returnToCardMap()) return;
    if (!dismissAll && !dialog && pane === 'summary' && historyRecord && historyRecord === session()?.id) {
      if (!operation) void run(() => returnToSetup(false, 'history'));
      return;
    }
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
    const missing = inRound ? Model.roundRoster(s,r).filter(student => !r.exempt.includes(student.id) &&
      (multi ? !Object.hasOwn(r.answers[student.id]?.choices || {},r.activeOption) : !r.answers[student.id]))
      .map(student => student.cardNumber).sort((a,b)=>a-b) : [];
    const expected = counts?.expected ?? 0, received = multi && inRound ? counts.optionReceived : counts?.received ?? 0;
    const option = r?.activeOption || '', next = multi && option ? letters.slice(0,q.options.length)[letters.indexOf(option)+1] : '';
    const kind = kindNames[q?.type] || '';
    const canChooseType = phase === 'ready' && !!q && !q.bankId && !q.rounds.length && !q.answer && !q.imageId &&
      !q.text && !q.tags.length && (q.type === 'boolean' || !q.options.some(Boolean)) && !data?.context?.revoked;
    let primary = 'collect', label, enabled, heading, caption = '';
    switch (phase) {
      case 'home': {
        primary = setup?.recovery ? 'setup-restore' : 'setup-start';
        label = setup?.recovery ? '恢复课堂' : '开始课堂'; heading = data?.className || '班班课堂';
        const previous = setup?.recovery && unfinishedJournal()?.session;
        if (previous) {
          const index = previous.questions.findIndex(item => item.id === previous.currentQuestionId);
          caption = [subjects[previous.subjectId] || previous.subjectId, index >= 0 ? '第 '+(index+1)+' 题' : ''].filter(Boolean).join(' · ');
        } else if (setup?.canCreate) {
          caption = [subjects[setup.selection.subject], setup.selection.cardMode === 'scanned' ? '随发随扫' : data.context.students.length+' 人'].filter(Boolean).join(' · ');
        } else caption = setup?.roster || '';
        enabled = setup?.recovery || setup?.canCreate; break;
      }
      case 'ready':
        heading = q ? '第 '+number+' 题' : '尚未出题'; label = q ? '开始收答' : '准备第一题';
        if (!q) primary = 'advance';
        enabled = q ? !$('start').disabled : !$('next').disabled;
        if (q && !canChooseType) caption = (q.bankId ? '题单 · ' : '')+kind+'题';
        break;
      case 'paused':
        heading = '第 '+number+' 题'+(multi ? '' : ' · '+kind);
        label = '继续收答'; enabled = !$('start').disabled; break;
      case 'collect':
        heading = '第 '+number+' 题'+(multi ? '' : ' · '+kind);
        if (s.source === 'board' && !scanner.running) {
          primary = 'open-camera'; label = '开启相机'; enabled = !$('camera-toggle').disabled;
        } else if (next) { primary = 'multi'; label = '下一项 '+next; enabled = !$('multi-next').disabled; }
        else { label = '结束收答'; enabled = !$('stop').disabled; }
        break;
      case 'result':
        heading = '第 '+number+' 题';
        if ((expected > 0 || counts.participantCount === 0) && received === 0 && !counts.incomplete && !data?.context?.revoked) {
          primary = 'collect'; label = q.revealed ? '练习' : '重收'; enabled = !$('start').disabled;
        } else if (s.questions.length >= 100) {
          primary = 'finish'; label = '结课'; enabled = !$('end-session').disabled;
        } else {
          primary = 'advance'; label = '下一题'; enabled = !$('next').disabled;
        }
        caption = [counts.incomplete ? '未完成 '+counts.incomplete : '', counts.unanswered ? '未答 '+counts.unanswered : '', counts.abstained ? '弃权 '+counts.abstained : ''].filter(Boolean).join(' · ');
        break;
      case 'done':
        heading = '课堂已结束'; label = '返回班班'; primary = 'return-setup';
        enabled = !$('return-setup').disabled; caption = $('sync-status').textContent;
        break;
    }
    return {phase,heading,caption,primary,label,enabled:Boolean(enabled && !operation && !frozen),number,
      kind:q?.type || '',option,received,expected,missing,incomplete:counts?.incomplete ?? 0,
      noCardPolicy:r?.noCardPolicy,abstained:counts?.abstained || 0,
      participantCount:counts?.participantCount,
      bars:phase==='result' ? Model.distributionBars(q.type,counts.distribution) : [],canChooseType,
      busy:operation,questionCount:s?.questions.length || 0,phone:s?.source==='phone',
      needsSync:phase==='done' && (controller.journal.syncedSeq < s.seq || Boolean(controller.journal.reviewError)),
      records:phase!=='done' ? [] : s.questions.map(item => {
        const official = Model.officialRound(item);
        const totals = official && Model.roundSummary(s,official);
        return {kind:item.type,bars:totals ? Model.distributionBars(item.type,totals.distribution) : null,received:totals?.received || 0,
          expected:totals?.expected || 0,participantCount:totals?.participantCount,unanswered:totals?.unanswered || 0,incomplete:totals?.incomplete || 0,abstained:totals?.abstained || 0};
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
      status = `收 ${r.activeOption} 项 · 本项 ${tally(summary,summary.optionReceived)}\n${r.noCardPolicy === 'abstain' ? '选才举卡，A 朝上' : 'A 朝上选，B 朝上不选'}\n${camera}`;
    }
    if (active() && notice.classList.contains('warning')) status = notice.textContent;
    const dialog = document.querySelector('dialog[open]');
    const panelTitle = dialog?.id === 'confirm-dialog' ? '操作确认' :
      dialog ? $(dialog.getAttribute('aria-labelledby')).textContent : titles[pane] || '';
    const onCardMap = dialog?.id === 'exempt-dialog' && !$('card-overview').hidden;
    const cardHint = onCardMap ? (summary.participantCount === 0 ? (r.status === 'closed' ? '本轮未收到卡' : '等待举卡') : pendingCardsOnly
      ? (q?.type === 'multiple' ? r.activeOption + ' 项 · ' : '') + (summary.expected ? '待收 ' + (summary.expected - (q?.type === 'multiple' ? summary.optionReceived : summary.received)) + ' 人' : '全员免答')
      : q?.type === 'multiple' && captureControls
      ? `${r.activeOption} 项 · ${tally(summary,summary.optionReceived)}`
      : `${r.status === 'closed' ? '已答' : '已收'} ${tally(summary)}`)
      : r?.status === 'closed' ? '已封存 · 只读' : pendingCardsOnly || frozen || data?.context?.revoked ? '只读' : '点卡号切换免答';
    let cardPanel = null;
    if (dialog?.id === 'exempt-dialog' && document.body.classList.contains('in-disc')) {
      const marks = onCardMap && pendingCardsOnly ? cardStates.filter(card => card.state === 'pending') : cardStates;
      const grouped = onCardMap && marks.length > 12;
      const radial = !dialog.querySelector('[role="alert"]');
      cardPanel = {overview:onCardMap, radial, grouped, pendingOnly:pendingCardsOnly, page:cardPage, pages:Math.ceil(cardStates.length / cardsPerPage),
        cards:!radial ? [] : onCardMap ? marks : cardStates.slice(cardPage * cardsPerPage, (cardPage + 1) * cardsPerPage),
        readOnly:pendingCardsOnly || r.status === 'closed' || frozen || !active() || Boolean(data?.context?.revoked), located:locatedCard};
    }
    const lesson = companionLesson(s,q,r,summary,setup);
    const inDisc = companion && document.body.classList.contains('in-disc');
    const preview = cameraPreview();
    currentDiscPage = !inDisc ? null : dialog?.id === 'editor' ? discEditor.describe() :
      disc.describe({pane,dialog,s,q,r,summary,lesson,recordIndex,operation,frozen,revoked:Boolean(data?.context?.revoked),renderDistribution:distributionRows,images:deck?.images,
        saved:pane === 'history' ? savedJournals() : [],nextQuestion:pane === 'next' ? nextFromDeck() : null});
    wheel.update({
      inDisc,hasSession:Boolean(s),setup,lesson,preview,panel:dialog?.id || pane,panelTitle,cardPanel,discPage:currentDiscPage,
      panelHint:dialog?.id === 'exempt-dialog' ? (!onCardMap && q?.type === 'multiple' && captureControls ? r.activeOption + ' 项 · ' : '') + cardHint : '',
      retry:frozen || !data && notice.classList.contains('error'),
      enabled:{collect:setup ? !operation && !frozen : undefined,camera:captureControls && !operation && !frozen && !data?.context?.revoked,
        pause:collecting && !$('pause').disabled && canCapture(),
        seal:captureControls && (lesson.phase === 'paused' || lesson.primary !== 'collect') && !$('stop').disabled,
        options:multiple && !$('multi-option').disabled && canCapture(),
        source:inDisc ? active() && canCapture() && !operation && !preview : undefined,
        exempt:inDisc ? lesson.phase === 'result' && !$('exempt').disabled : undefined,
        edit:Boolean(q && active() && !operation),
        'end-session':ended || history ? !operation : undefined},
      targets:s?{collect:target,camera:$('camera-toggle'),pause:$('pause'),seal:$('stop'),source:$('source'),next:$('next'),
        'end-session':$('end-session'),exempt:$('exempt'),edit:$('edit'),distribution:$('show-distribution'),multi:$('multi-next')}:{},
      labels:{collect:collectLabel,camera:openCamera ? '开启相机' : captureControls ? '收答控制' : '本机相机',
        edit:captureControls ? '查看题目' : inDisc && lesson.phase === 'result' ? '设置与揭晓答案' : '题目答案',
        source:s?.source==='phone'?'换回本机':'手机扫码','end-session':ended?'课堂汇总':history?'待同步课堂':'结束课堂'},
      progress:setup ? setup.roster : s ? `第 ${s.questions.indexOf(q)+1} 题 · 已收 ${tally(summary)}` : '正在读取纸卡课堂…',
      status:pendingStatus || status,
      multiple,multiEnabled:multiple && !$('multi-next').disabled,multiLabel:nextOption ? `下一项 ${nextOption}` : '',
      cameraRunning:scanner.running,feedback:notice.textContent,error:notice.classList.contains('error')
    });
    const displayTrack = preview?.phone ? (!previewPeer?.follow || previewPeer.liveKey === preview.key ? previewPeer?.track : null) :
      scanner.stream?.getVideoTracks()[0];
    liveVideo.set(preview && !preview.folded ? preview.key : null, displayTrack);
  }
  function activateWheel(id) {
    if (id === 'back' || id === 'dismiss') { back(id === 'dismiss'); return; }
    if (operation || disposed || !wheel.actions?.some(action => action.id === id && action.enabled) || document.querySelector('dialog[open]')) return;
    const target = wheel.targets[id];
    if (id === 'end-session' && !active()) { showPane(session() ? 'summary' : 'history'); return; }
    if (id === 'source') { changeSource(); return; }
    if (id === 'options') { showPane('options'); return; }
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
  const liveVideo = new CardQuizClassroomVideo(native);
  let previewPeer = null, previewSetup = null, phoneLens = null, foldedPreview = '', nextPeerAt = 0, unsupportedScope = '';
  let cancelBoardOpen;
  function previewScope() {
    const s = session();
    return companion && document.body.classList.contains('in-disc') && canCapture() && active() && round()?.status === 'collecting'
      ? [s.id,s.currentRoundId,s.sourceId,question()?.type==='multiple' ? 'multiple' : s.generation].join('/') : '';
  }
  function closePreviewPeer() {
    const peer = previewPeer;
    previewPeer = null; previewSetup = null;
    peer?.close();
  }
  function cameraPreview() {
    const scope = previewScope(), s = session(), phone = s?.source === 'phone';
    const peer = previewPeer;
    const samePhone = phone && active() && canCapture() && document.body.classList.contains('in-disc') &&
      peer?.sessionId === s.id && peer.sourceId === s.sourceId;
    if (previewSetup?.scope !== scope) previewSetup = null;
    if (peer && (!samePhone || peer.scope !== scope)) {
      if (!samePhone || !peer.follow) closePreviewPeer();
      else {
        clearTimeout(peer.viewTimer);
        peer.scope = scope; peer.liveKey = ''; peer.viewSent = '';
        if (!scope) peer.send('rest');
      }
    }
    if (phoneLens?.scope !== scope) phoneLens = null;
    if (!scope) { foldedPreview = ''; return null; }
    let key;
    if (phone) {
      if (typeof RTCPeerConnection !== 'function' || scope === unsupportedScope) return null;
      phoneLens ??= {scope,key:scope+'/'+crypto.randomUUID(),hidden:false};
      if (phoneLens.hidden) return null;
      key = phoneLens.key;
      if (peer?.follow && samePhone) {
        const visible = foldedPreview !== key, stamp = key + '/' + visible;
        if (peer.viewSent !== stamp) {
          peer.viewSent = stamp; peer.liveKey = '';
          peer.send(JSON.stringify({view:key,round:s.currentRoundId,generation:s.generation,visible}));
          clearTimeout(peer.viewTimer);
          peer.viewTimer=setTimeout(()=>peer.close(),4000);
        }
      }
    } else {
      if (!scanner.running && !scanner.starting) { foldedPreview = ''; return null; }
      key = scope + '/board-' + scanner.opening;
    }
    return {key,phone,folded:foldedPreview === key};
  }
  function postPreview(view,frame) {
    if (view && !view.folded && CardQuizPreview.validFrame(frame))
      native?.postMessage({type:'preview-frame',key:view.key,frame});
  }
  function previewSignal() {
    const scope = previewScope();
    if (!scope || session().source !== 'phone' || typeof RTCPeerConnection !== 'function' || scope === unsupportedScope) return;
    if (!previewPeer && performance.now() >= nextPeerAt) {
      if (previewSetup?.scope !== scope) previewSetup = {scope, id:crypto.randomUUID()};
      return {id:previewSetup.id, prepare:true};
    }
    if (!previewPeer?.offer) return;
    // Carry the existing connection's offer when the board authorizes the next option.
    return {id:previewPeer.id, ...(previewPeer.offeredGeneration===session().generation ? {} : {offer:previewPeer.offer}), answered:Boolean(previewPeer.pc.remoteDescription)};
  }
  function openPreviewPeer({id, scope}, iceServers, video) {
    let peer;
    try {
      peer = new CardQuizPreview.Peer(id, {
        gatherAll: nextPeerAt > 0 && !phoneLens?.hidden,
        onOpen: () => {
          if (previewPeer !== peer || previewScope() !== scope) return peer.close();
          nextPeerAt = 0;
          if (phoneLens?.hidden) phoneLens = null;
          const view = cameraPreview();
          if (video) peer.send('follow-rounds?');
          peer.send('wide'); peer.send(view?.folded ? 'hide' : 'show'); renderWheel();
        },
        onTrack: track => {
          if (previewPeer !== peer) return;
          peer.track = track; renderWheel();
        },
        onMessage: frame => {
          if (previewPeer !== peer) return;
          if (frame === 'follow-rounds' && video) { peer.follow = true; renderWheel(); return; }
          if (!peer.scope || previewScope() !== peer.scope) return;
          if (frame === 'camera-off') {
            if (phoneLens) phoneLens.hidden = true;
            renderWheel(); return;
          }
          if (CardQuizPreview.validFrame(frame)) postPreview(cameraPreview(),frame);
          else if (typeof frame === 'string' && frame.length <= 65536 && frame[0] === '{') {
            try {
              const message = JSON.parse(frame);
              if (peer.follow && message.seen && message.seen === phoneLens?.key) clearTimeout(peer.viewTimer);
              else if (peer.follow && message.live && message.live === phoneLens?.key && !phoneLens.hidden && foldedPreview !== message.live) {
                peer.liveKey = message.live; renderWheel();
              } else if (message.corners) liveVideo.markers(message.corners);
            } catch { /* Ignore incomplete overlays. */ }
          }
        },
        onClose: () => {
          clearTimeout(peer.viewTimer);
          if (previewPeer !== peer) return;
          if (phoneLens?.scope === peer.scope && !phoneLens.hidden && foldedPreview !== phoneLens.key) phoneLens = null;
          previewPeer = null; nextPeerAt = performance.now()+1500; renderWheel();
        }
      }, iceServers);
      peer.scope = scope; peer.sessionId = session().id; peer.sourceId = session().sourceId; previewPeer = peer;
      void peer.describe('offer',undefined,video).then(sdp => { peer.offer = sdp; }).catch(() => peer.close());
    } catch { nextPeerAt = performance.now()+5000; }
  }
  function acceptPreview(signal, sent, generation) {
    if (sent?.prepare) {
      if (sent.id !== previewSetup?.id || previewSetup.scope !== previewScope() || signal?.preparing) return;
      // Older schools reply with needOffer or no preview capability. Try the original LAN offer.
      openPreviewPeer(previewSetup, signal?.iceServers || [], signal?.video === true);
      previewSetup = null;
      return;
    }
    const peer = previewPeer;
    if (!peer || !sent || peer.id !== sent.id || peer.scope !== previewScope()) return;
    if (signal === undefined) { unsupportedScope = peer.scope; closePreviewPeer(); renderWheel(); return; }
    if (signal?.id !== peer.id) return;
    if (signal.needOffer) peer.offeredGeneration = null;
    else if (sent.offer) peer.offeredGeneration = generation;
    if (signal.answer && !peer.applying && !peer.pc.remoteDescription) {
      peer.applying = true;
      void peer.pc.setRemoteDescription({type:'answer',sdp:signal.answer})
        .then(() => peer.waitForChannel()).catch(() => peer.close());
    }
  }
  function previewAction(action,key) {
    const view = cameraPreview();
    if (!view || key !== view.key) return;
    if (action === 'preview-stop' && !view.phone && cancelBoardOpen) {
      scanner.stop(); cancelBoardOpen(false); renderWheel(); return;
    }
    if (action === 'preview-fold' || action === 'preview-open') {
      foldedPreview = action === 'preview-fold' ? key : '';
      if (!previewPeer?.follow) previewPeer?.send(foldedPreview ? 'hide' : 'show');
      renderWheel();
    } else if (!operation && action === 'preview-stop') {
      if (view.phone) {
        if (previewPeer?.channel?.readyState === 'open') {
          phoneLens.hidden = true; previewPeer.send('stop'); renderWheel();
        } else void run(pauseRound);
      }
      else $('camera-toggle').click();
    } else if (!operation && action === (view.phone ? 'preview-board' : 'preview-phone')) {
      void changeSource();
    }
  }
  const canPrepareRound = () => active() && Boolean(question()) && !operation && !disposed && !data?.context?.revoked && !frozen;
  function command(action,payload = {},s = session()) {
    return {id:crypto.randomUUID(),sessionId:s.id,questionId:s.currentQuestionId,roundId:s.currentRoundId,generation:s.generation,sourceId:s.sourceId,action,payload};
  }
  const scanner = new CardQuizScanner({video:$('camera'),readTrack:companion,onPreview:(canvas,markers) => {
    if (liveVideo.run && session()?.source === 'board')
      liveVideo.markers(markers.map(({corners})=>corners.map(p=>[p.x/canvas.width,p.y/canvas.height])));
  },onRead:async read => {
    if (data?.context?.revoked) throw new Error('设备授权已失效，采集已停止。');
    if (!active() || !canCapture() || session().source !== 'board' || round()?.status !== 'collecting') return;
    if (session().attendanceMode !== 'scanned' && !session().roster.some(student => student.cardNumber === read.cardNumber)) return;
    await dispatch(command('answer',{...read,...(question()?.type==='multiple'?{targetOption:round().activeOption}:{})}));
  },onStatus:({message,kind}) => {
    $('camera-status').textContent = message;
    if (kind === 'error' && !scanner.running) {
      if (document.body.classList.contains('in-disc') && !operation && canCapture() && round()?.status === 'collecting' && session().source === 'board') {
        void run(() => pauseForCameraError(message));
        return;
      }
      render();
    }
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
  const setupSelection = () => ({publication:$('publication').value,subject:$('subject').value,template:$('first-template').value,cardMode:$('card-mode').value});
  function wheelSetup() {
    const options = id => [...$(id).options].map(option => ({value:option.value,label:option.text}));
    const unfinished = unfinishedJournal();
    const feedback = $('feedback');
    const canCreate = !$('create-session').hidden && !$('create-session').disabled;
    return {
      roster:$('roster-status').textContent,publications:options('publication'),subjects:options('subject'),templates:options('first-template'),
      selection:setupSelection(),recovery:unfinished ? {value:unfinished.session.id,label:journalLabel(unfinished)} : null,
      cardModes:$('card-mode-field').hidden ? [] : options('card-mode'),
      assignedCardCount:!$('card-mode-field').hidden && canCreate ? data.context.students.length : null,
      canCreate,cardCount:canCreate && $('card-mode').value === 'assigned' ? data.context.students.length : null,canRefresh:!$('refresh').disabled,busy:operation,
      notice:feedback.matches('.warning,.refreshed') ? feedback.textContent : '',refreshed:feedback.matches('.refreshed')
    };
  }
  function renderSetup() {
    if (!data) return;
    $('class-name').textContent = data.className || '创意工坊';
    const context = data.context;
    const saved = savedJournals();
    const unfinished = saved.some(j => j.session.endedAt === null);
    let ready = false;
    $('card-mode-field').hidden = true;
    if (unfinished) $('roster-status').textContent = '上次课堂未结束';
    else if (context?.revoked) $('roster-status').textContent = '本机绑定已失效，请在教室设置中重新绑定。';
    else if (context?.classId && context.deviceId && Array.isArray(context.students)) {
      let assigned = 0;
      try { assigned = Model.classRoster(context).length; } catch { /* 通用卡按实际举卡登记。 */ }
      $('card-mode-field').hidden = !assigned;
      if (!assigned) $('card-mode').value = 'scanned';
      $('roster-status').textContent = $('card-mode').value === 'assigned' ? `本班 ${assigned} 张个人卡` : '举卡即计人数';
      ready = true;
    } else {
      $('roster-status').textContent = '请联网刷新，读取本机绑定的班级。';
    }
    $('setup-fields').hidden = $('create-session').hidden = unfinished;
    $('create-session').disabled = !ready || operation || frozen;
    $('refresh').disabled = operation;
    $('card-mode').disabled = $('publication').disabled = $('subject').disabled = $('first-template').disabled = operation;
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
    if (r.participantCount !== undefined && r.participantCount !== cardStates.length) {
      const focused = document.activeElement?.dataset.student;
      buildCardList(r, false);
      if (focused) [...$('exempt-cards').querySelectorAll('input')].find(input => input.dataset.student === focused)?.focus({preventScroll:true});
    }
    const q = question(), sealed = r.status === 'closed';
    if (pendingCardsOnly && sealed) {
      pendingCardsOnly = false;
      $('exempt-heading').textContent = '本轮卡号';
    }
    const currentOption = q?.type === 'multiple' && !sealed ? r.activeOption : null;
    const totals = {received:0, pending:0, unanswered:0, abstained:0, partial:0, exempt:0};
    const words = {received:'已收', pending:'待收', unanswered:'未答', abstained:'弃权', partial:'未完成', exempt:'免答'};
    const marks = $('card-map').querySelectorAll('[data-card]');
    for (const [i,input] of $('exempt-cards').querySelectorAll('input').entries()) {
      const id = input.dataset.student, answer = r.answers[id], exempt = r.exempt.includes(id);
      const choices = answer?.choices || {};
      const received = currentOption ? Object.hasOwn(choices,currentOption) : Boolean(answer);
      const partial = sealed && received && !Model.completeAnswer(q,answer,r);
      const status = input.nextElementSibling.querySelector('.card-check-state');
      if (!operation) input.checked = exempt;
      input.disabled = disabled || sealed || pendingCardsOnly;
      const missingState = sealed ? (r.noCardPolicy === 'abstain' ? 'abstained' : 'unanswered') : 'pending';
      const state = exempt ? 'exempt' : partial ? 'partial' : received ? 'received' : missingState;
      if (marks[i]) marks[i].hidden = pendingCardsOnly && state !== 'pending';
      totals[state]++;
      if (status.dataset.state !== state) {
        status.dataset.state = state;
        status.textContent = words[state];
        cardStates[i].state = state;
        const mark = marks[i];
        if (mark) {
          mark.dataset.state = state;
          mark.title = mark.dataset.card + ' 号 · ' + words[state];
        }
      }
    }
    for (const row of $('card-map').children)
      row.hidden = pendingCardsOnly && !row.querySelector('[data-card]:not([hidden])');
    for (const key of $('card-key').children) key.hidden = totals[key.dataset.state] === 0 || pendingCardsOnly && key.dataset.state !== 'pending';
    const scope = !$('card-overview').hidden
      ? !cardStates.length ? '等待本节第一张卡。' : pendingCardsOnly ? `待收 ${totals.pending} 人。` :
        Object.entries(totals).filter(([,count]) => count).map(([key,count]) => words[key] + ' ' + count).join('，') + '。点阵可查看卡号。'
      : sealed ? '本轮已封存，可核对各卡状态。' : pendingCardsOnly || frozen || data?.context?.revoked ? '当前只读，可核对各卡状态。' : '勾选卡号设为本轮免答，已收答案保留。';
    $('card-check-scope').textContent = (currentOption ? `当前收答项 ${currentOption}。` : '') + scope;
  }
  function emptyResult(summary) {
    if (summary.received) return null;
    if (summary.participantCount === 0) return {label:'本轮未收到卡',note:''};
    if (!summary.expected) return {label:'全员免答',note:''};
    if (summary.abstained) return {label:`弃权 ${summary.abstained} 人`,note:''};
    if (!summary.incomplete) return {label:'无人作答',note:`应答 ${summary.expected} 人`};
    const note = [`未完成 ${summary.incomplete} 人`, summary.unanswered ? `未答 ${summary.unanswered} 人` : ''].filter(Boolean).join(' · ');
    return {label:'暂无完整作答',note};
  }
  function tally(summary,received = summary.received) {
    return summary.participantCount === undefined ? `${received} / ${summary.expected} 人` : `${received} 人`;
  }
  function distributionRows(q, summary, bars = Model.distributionBars(q.type,summary.distribution)) {
    const empty = companion && emptyResult(summary);
    if (empty) return `<strong class="distribution-empty">${empty.label}</strong>` +
      (empty.note ? `<small class="distribution-note">${empty.note}</small>` : '');
    const most = Math.max(0, ...Object.values(summary.distribution));
    const options = bars.map(({label,count}) => {
      const percent = summary.received ? (100 * count / summary.received).toFixed(1) : '';
      if (!companion) return `<span>${esc(label)} · ${count} 人 · ${percent ? percent+'%' : '暂无作答'}</span>`;
      const leading = count > 0 && count === most;
      return `<div class="option-result${leading ? ' leading' : ''}"${leading ? ` role="group" aria-label="${esc(label)}，${count} 人，人数最多"` : ''}><strong>${esc(label)}</strong>
        <meter aria-hidden="true" min="0" max="${Math.max(1, summary.received)}" value="${count}"></meter>
        <span>${count} 人</span><small>${percent ? Number(percent)+'%' : ''}</small></div>`;
    });
    const notes = [], numberSeparator = companion ? ' ' : ' · ';
    if (companion) options.unshift(`<div class="distribution-scale" aria-hidden="true"><small><span>0</span><span>${summary.received} 人</span></small></div>`);
    if (summary.abstained) notes.push(`弃权${numberSeparator}${summary.abstained} 人`);
    if (q.type === 'multiple' && ((!companion && summary.abstained === undefined) || summary.incomplete)) notes.push(`未完成${numberSeparator}${summary.incomplete} 人`);
    if ((!companion && summary.abstained === undefined) || summary.unanswered) notes.push(`未答${numberSeparator}${summary.unanswered} 人`);
    if (companion && notes.length) options.push(`<small class="distribution-note">${notes.join(' · ')}</small>`);
    else options.push(...notes.map(note => `<span>${note}</span>`));
    return options.join('');
  }
  function render() {
    const s = session(), q = question(), r = round(), exists = Boolean(s), ended = exists && !active();
    if ($('exempt-dialog').open && r?.id !== checkedRound) $('exempt-dialog').close();
    if (['question','next','distribution','capture','options'].includes(pane) &&
        (q?.id !== paneQuestion || pane === 'capture' && (!r || r.status === 'closed') ||
         pane === 'options' && (q?.type !== 'multiple' || r?.status !== 'collecting' || r.activeOption !== paneOption) ||
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
    const questionNumber = s.questions.indexOf(q) + 1;
    $('question-number').textContent = q ? `第 ${questionNumber} 题` + (companion ? '' : ` · 共 ${s.questions.length} 题`) : '尚无题目';
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
    $('round-kind').hidden = !r || companion && r.purpose !== 'practice';
    $('received').textContent = summary.received;
    $('expected').textContent = summary.participantCount !== undefined ? ' 人已举卡' : companion && r?.status === 'closed' ? ` / ${summary.expected}` :
      ` / ${summary.expected} 人${q?.type === 'multiple' && r && !r.noCardPolicy ? '整题完成' : '已举卡'}`;
    const missing = summary.expected - (q?.type==='multiple' ? summary.optionReceived : summary.received);
    $('capture-progress').hidden = !r || r.status === 'closed';
    $('capture-progress').textContent = summary.participantCount !== undefined
      ? (questionNumber > 1 ? `本节已参与 ${summary.participantCount} 人` : summary.participantCount ? '' : '等待举卡') + (missing ? ` · 待收 ${missing} 人` : '')
      : !summary.expected ? '本轮无人须答' : missing ? `待收 ${missing} 人` : q?.type==='multiple' ? '本项已收齐' : '本轮已收齐';
    $('multi-capture').hidden = q?.type !== 'multiple';
    if(q?.type==='multiple'){
      if($('multi-option').options.length!==q.options.length)$('multi-option').innerHTML=letters.slice(0,q.options.length).split('').map(l=>`<option value="${l}">${l} 项</option>`).join('');
      $('multi-option').value = r?.activeOption || 'A';
      $('multi-option').disabled = disabled || !collecting;
      $('multi-next').disabled = disabled || !collecting || letters.indexOf(r?.activeOption)>=q.options.length-1;
      $('multi-instruction').textContent = !r || r.noCardPolicy === 'abstain' ? '选才举卡，A 朝上。改为不选时举 B。' : 'A 朝上表示选，B 朝上表示不选。';
      $('multi-progress').textContent = !r ? '' : r.status === 'closed'
        ? (r.noCardPolicy === 'abstain' ? `弃权 ${summary.abstained} 人` : `未完成 ${summary.incomplete} 人`)
        : `本项已收 ${tally(summary,summary.optionReceived)} · ${companion || s.source === 'phone' ? '换项时放下再举。' : '换项后请开启相机。'}`;
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
    $('next').disabled = $('temporary').disabled = disabled || !between || s.questions.length >= 100;
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
    if (showDistribution) {
      $('distribution').classList.toggle('multiple', q.type === 'multiple');
      $('distribution').setAttribute('aria-label', `匿名${q.type === 'multiple' ? '组合' : '选项'}分布，按 ${summary.received} 位完整作答者统计`);
    }
    if (!(showDistribution && pane === 'distribution' && document.body.classList.contains('in-disc')))
      $('distribution').innerHTML = showDistribution ? distributionRows(q, summary) : '';
    $('sync-status').textContent = controller.journal.reviewError ? '待核对：' + controller.journal.reviewError :
      controller.journal.syncedSeq >= s.seq ? '已同步学校服务' : '已存本机 · 待同步';
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
      const empty = counts && emptyResult(counts);
      const result = !counts ? '无正式收答' : empty ? [empty.label, empty.note].filter(Boolean).join(' · ') :
        `已答 ${tally(counts)}${counts.abstained ? ` · 弃权 ${counts.abstained} 人` : ''}${counts.incomplete ? ` · 未完成 ${counts.incomplete} 人` : ''}`;
      const options = counts?.received ? Model.distributionBars(item.type,counts.distribution).map(({label,count}) => `${esc(label)} ${count} 人`).join(' · ') : '';
      const grade = counts?.received ? (counts.correct === null ? '未设标准答案' : `已答正确 ${counts.correct} / ${counts.received} 人`) : '';
      return `<li><strong>第 ${index + 1} 题 · ${label}</strong><span>${result}</span>${grade ? `<span>${grade}</span>` : ''}${options ? `<small>${options}</small>` : ''}</li>`;
    }).join('');
  }
  function nextFromDeck() {
    const questions = deck?.publication?.questions || [], used = session()?.questions.filter(q=>q.bankId).length || 0;
    return questions[used] || null;
  }
  async function createSession({publication:id,subject,template,cardMode = $('card-mode').value} = setupSelection()) {
    if (active() || unfinishedJournal()) throw new Error('请先恢复并结束尚未结束的课堂。');
    const hasOption = (field,value) => [...$(field).options].some(option => option.value === value);
    if (!hasOption('publication',id) || (!id && (!hasOption('subject',subject) || !hasOption('first-template',template))))
      throw new Error('开课选项已变化，请重新选择。');
    const selectedDeck = id ? await request('publication',{id}) : null;
    const questions = selectedDeck?.publication?.questions;
    if (id && !questions?.length) throw new Error('题单中没有可用题目。');
    const subjectId = questions?.[0]?.subjectId || subject;
    if (questions?.some(q=>q.subjectId!==subjectId)) throw new Error('题单包含多个学科，请在教师工作台按学科拆分。');
    const initial = Journal.create(Model.createSession(data.context,subjectId,Date.now(),cardMode)); initial.publicationId = id || null;
    const created = newController(initial);
    await commit(created,command('add_question', questions?.[0] || slideQuestion(template), created.session));
    resetSessionControls();
    controller = created; deck = selectedDeck;
    $('publication').value = id;
    $('card-mode').value = cardMode;
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
      await current.queue;
      if (!isCurrent()) return;
      const preview = previewSignal();
      const state = Model.publicState(session(),data.className);
      const value = await request('relay',{sessionId:session().id,state,receipts:sent,preview,retrySuperseded:true});
      if (controller !== current) return;
      if (Object.hasOwn(value,'supersededSeq')) {
        await current.queue;
        if (!isCurrent()) return;
        if (!Number.isSafeInteger(value.supersededSeq) || value.supersededSeq <= state.seq || value.supersededSeq > session().seq)
          throw new Error('学校记录与本机进度不一致。');
        return; // Retry with the saved state and the original, unacknowledged receipts.
      }
      for (const receipt of sent) relayReceipts.delete(receipt.id);
      if (relayFailures && $('feedback').textContent === relayUnavailable) feedback('');
      relayFailures = 0;
      if (!isCurrent()) return;
      acceptPreview(value.preview,preview,state.generation);
      if (pair && $('pair-dialog').open) {
        const ready = value.pairings?.find(p=>p.pairId === pair.pairId)?.claimed === true;
        if (pair.mode === 'scan') {
          if (pair.seq !== session().seq || Date.now() >= pair.expiresAt) {
            const stale = pair.seq !== session().seq;
            cancelScanOffer(pair); pair = null;
            $('pair-qr').hidden = true;
            $('pair-qr').replaceChildren();
            $('pair-status').textContent = stale ? '课堂已变化，请返回后重新扫码。' : '二维码已过期，请返回后重新扫码。';
          } else if (ready && !operation && !frozen) {
            const offered = pair;
            await run(async () => {
              offered.accepting = true;
              try {
                await saveSource('phone', offered.pairId);
                if (!isCurrent() || pair !== offered || !$('pair-dialog').open) return;
                if (question() && (!round() || round().status === 'paused')) await startRound();
                feedback('手机已连接。');
              } catch(error) {
                if (session()?.sourceId !== offered.pairId) cancelScanOffer(offered);
                throw error;
              } finally {
                if (pair === offered && $('pair-dialog').open) $('pair-dialog').close();
              }
            });
          }
        } else {
          $('confirm-phone').disabled = !ready;
          if (ready) $('pair-status').textContent = '手机已连接，请确认使用。';
        }
        if ($('pair-dialog').open) renderWheel();
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
      closePreviewPeer();
      if (session()?.source === 'phone') feedback(relayUnavailable,'warning');
    } finally { relayRunning = false; scheduleRelay(); }
  }
  function cancelScanOffer(offer) {
    if (offer?.mode === 'scan')
      void request('cancel-pair',{sessionId:offer.sessionId,pairId:offer.pairId}).catch(() => {
        // The board also drops its local offer immediately. An offline invitation expires at the service.
      });
  }
  function releasePair() {
    if (!pair?.accepting) cancelScanOffer(pair);
    pair = null;
  }
  function phoneAddressIssue(address) {
    let url;
    try { url = new URL(address); }
    catch { return '学校地址无效，请检查白板绑定。'; }
    const host = url.hostname.replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '[::1]')
      return '当前是本机模拟班。请打开学校的「纸卡测试班」扫码。';
    if (url.protocol !== 'https:' || host === '0.0.0.0' || host === '[::]')
      return '请将白板连接到学校的 HTTPS 地址，再用手机扫码。';
    return '';
  }
  function showPhoneInvite(offer, message) {
    pair = offer;
    const manual = Boolean(offer && offer.mode !== 'scan');
    $('confirm-phone').hidden = !manual;
    $('confirm-phone').disabled = true;
    $('pair-code').hidden = !manual;
    $('pair-code').textContent = manual ? offer.code : '';
    $('pair-qr').hidden = !offer;
    $('pair-qr').innerHTML = offer ? CardQuizQr.svg(offer.url) : '';
    $('pair-status').textContent = message || (manual ? '扫码登录后在白板确认。' : '请用手机扫码');
    openDialog('pair-dialog');
  }
  async function setSource() {
    if (!active() || !canCapture()) return;
    const at = visibilityRevision;
    if (session().source === 'board' && data.endpoint) {
      const issue = phoneAddressIssue(data.endpoint);
      if (issue) { showPhoneInvite(null, issue); return; }
    }
    if (round()?.status === 'collecting') await pauseRound();
    else scanner.stop();
    if (!active() || !canCapture() || at !== visibilityRevision) return;
    if (session().source === 'phone') { await saveSource('board','board'); pair = null; feedback('已换回本机，可以继续收答。'); return; }
    const current = controller, {id:sessionId,seq} = session();
    const offer = {...await request('pair',{sessionId}),sessionId,seq};
    if (controller !== current || !canCapture() || at !== visibilityRevision || seq !== session().seq) {
      cancelScanOffer(offer); return;
    }
    const issue = phoneAddressIssue(offer.url);
    if (issue) cancelScanOffer(offer);
    showPhoneInvite(issue ? null : offer, issue);
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
    [...$('edit-options').querySelectorAll('input')].forEach((input,i) => {
      // Text inputs strip line breaks from value. Keep the original text for read-only options.
      if (input.readOnly) input.defaultValue = q.options[i] || '';
      input.value = q.options[i] || '';
    });
    setEditorAnswer(q.answer); $('edit-tags').value = q.tags.join('，'); $('editor-error').textContent = '';
    if (document.body.classList.contains('in-disc')) discEditor.open(adding);
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
      const generation = session().generation;
      let issue;
      const cancelled=new Promise(resolve=>{ cancelBoardOpen=resolve; });
      try {
        const started=scanner.start(); renderWheel();
        if (await Promise.race([started.then(()=>true),cancelled]) === false) return;
      } catch (error) { issue = error.message; }
      finally { cancelBoardOpen=null; }
      if (!scanner.running && visibleAt === visibilityRevision && canCapture() && session()?.generation === generation)
        await pauseForCameraError(issue || $('camera-status').textContent);
    }
  }
  async function pauseForCameraError(message) {
    await pauseRound();
    feedback('本机相机未开启。可恢复本轮重试，或使用手机继续。' + message,'error');
  }
  async function pauseRound() {
    scanner.stop();
    await dispatch(command('recover'));
    feedback('已暂停本轮。可恢复收答或切换设备。');
  }
  async function savePause(retryPause) {
    try {
      if (controller) await controller.queue;
      if (frozen) {
        // Only an explicit exit retries its own pause. Other unconfirmed writes need a journal reload.
        if (!retryPause || !pendingPause || controller?.pending?.id !== pendingPause.id) return false;
        await commit(controller,pendingPause);
        frozen = false;
        feedback('本轮暂停已保存。');
      } else if (active() && round()?.status === 'collecting') {
        pendingPause = command('recover');
        await dispatch(pendingPause);
      }
      pendingPause = null;
      return true;
    } catch (error) {
      const canRetry = pendingPause && controller?.pending?.id === pendingPause.id;
      feedback(error.message + (canRetry ? '也可再次退出，重试保存本轮暂停。' : ''),'error');
      return false;
    }
  }
  function suspend(retryPause = false) {
    visibilityRevision++;
    if (pair?.mode === 'scan' && $('pair-dialog').open) {
      releasePair();
      $('pair-dialog').close();
    }
    closePreviewPeer(); foldedPreview = '';
    cancelBoardOpen?.(false);
    scanner.stop(); clearTimeout(relayTimer);
    suspension ??= savePause(retryPause).finally(() => { suspension = null; render(); });
    return suspension;
  }
  async function confirmSuspend(suspendId) {
    const paused = await suspend(true);
    // Opening or restoring a classroom can still be saving a controller not yet displayed.
    if (paused && operation) feedback('课堂操作尚未完成，请完成后再退出。','warning');
    const saved = paused && !operation;
    if (!saved) scheduleRelay();
    native?.postMessage({type:'suspended',suspendId,saved});
  }
  function updateVisibility() {
    if (!hostVisible || document.hidden) { void suspend(); return; }
    render();
    if (suspension) void suspension.then(scheduleRelay);
    else scheduleRelay();
  }
  async function run(task, status = '') {
    if (operation || suspension) return;
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
  $('card-mode').onchange = render;
  $('refresh').onclick = () => run(refreshSetup);
  $('saved-sessions').onclick = event => {
    const id = event.target.closest('[data-resume]')?.dataset.resume;
    if (!id || active()) return;
    const fromHistory = pane === 'history' && document.body.classList.contains('in-disc');
    run(async () => {
      await restore(id);
      historyRecord = fromHistory && !active() ? id : null;
      if (companion) showPane(active() ? '' : 'summary');
    });
  };
  $('start').onclick = () => run(startRound,'正在开始收答…');
  $('stop').onclick = () => { scanner.stop(); run(async()=>{ await dispatch(command('end_round')); feedback('本轮已封存。'); if (pane === 'capture') showPane(''); }); };
  $('pause').onclick = () => run(async () => { await pauseRound(); if (pane === 'capture') showPane(''); });
  $('camera-toggle').onclick = () => run(async()=>{
    if (scanner.running) { scanner.stop(); $('camera-status').textContent = '相机已关闭，已收记录保留。'; }
    else await openBoardCamera(visibilityRevision);
  });
  function switchMultiOption(option){
    if(operation || !option || option===round()?.activeOption)return;
    const visibleAt = visibilityRevision, autoOpen = companion && session().source === 'board';
    const previousCards = autoOpen ? scanner.cardsInView() : null;
    scanner.stop();
    return run(async()=>{
      await dispatch(command('set_multi_option',{option}));
      if (autoOpen) scanner.waitForNewPresentation(previousCards);
      feedback(autoOpen || session().source==='phone' ? `收 ${option} 项，请放下再举卡。` : `收 ${option} 项，请调整卡面后在本机开启相机。`);
      if (autoOpen) await openBoardCamera(visibleAt);
    },'正在切换收答项…');
  }
  $('multi-option').onchange = event => switchMultiOption(event.target.value);
  $('multi-next').onclick = () => switchMultiOption(letters[letters.indexOf(round()?.activeOption)+1]);
  function changeSource() {
    return run(setSource,session().source === 'board' ? '正在获取二维码…' : '正在换回本机…');
  }
  $('source').onclick = changeSource;
  $('confirm-phone').onclick = () => run(async()=>{
    if (!canCapture() || !pair || pair.sessionId !== session()?.id || pair.seq !== session().seq || Date.now() >= pair.expiresAt)
      throw new Error('配对已失效，请关闭并重新配对。');
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
      const options = [...$('edit-options').querySelectorAll('input')].map(input => input.readOnly ? input.defaultValue : input.value);
      const payload = {type:$('edit-type').value,text:$('edit-text').value,options,answer:editorAnswer() || null,tags:$('edit-tags').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean)};
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
  function showCardPage(index) {
    const cards = [...$('exempt-cards').children];
    const pages = Math.max(1, Math.ceil(cards.length / cardsPerPage));
    cardPage = Math.max(0, Math.min(index, pages - 1));
    cards.forEach((card, i) => { card.hidden = companion && Math.floor(i / cardsPerPage) !== cardPage; });
    $('card-pages').hidden = !companion || pages === 1;
    $('card-page').value = String(cardPage);
    $('card-prev').disabled = cardPage === 0;
    $('card-next').disabled = cardPage === pages - 1;
  }
  $('card-page').onchange = () => { showCardPage(Number($('card-page').value)); renderWheel(); };
  function returnToCardMap() {
    if (!$('card-overview').hidden || !$('card-map').childElementCount) return false;
    $('card-overview').hidden = false;
    $('card-details').hidden = true;
    render();
    $('card-overview').focus({preventScroll:true});
    return true;
  }
  $('exempt-dialog').addEventListener('cancel',event => {
    if (returnToCardMap()) event.preventDefault();
  });
  function locateCard(i) {
    if (i == null) i = pendingCardsOnly ? cardStates.findIndex(card => card.state === 'pending') : cardPage * cardsPerPage;
    const card = $('exempt-cards').children[i];
    if (!card || $('card-overview').hidden || pendingCardsOnly && cardStates[i].state !== 'pending') return;
    locatedCard = cardStates[i].number;
    $('card-overview').hidden = true;
    $('card-details').hidden = false;
    showCardPage(Math.floor(i / cardsPerPage));
    render();
    (card.firstElementChild.disabled ? card : card.firstElementChild).focus({preventScroll:true});
  }
  $('card-overview').onclick = event => {
    const mark = event.target.closest('[data-index]');
    if (mark || !event.target.closest('#card-map')) locateCard(mark ? Number(mark.dataset.index) : null);
  };
  $('card-prev').onclick = () => { showCardPage(cardPage - 1); renderWheel(); if ($('card-prev').disabled) $('card-next').focus(); };
  $('card-next').onclick = () => { showCardPage(cardPage + 1); renderWheel(); if ($('card-next').disabled) $('card-prev').focus(); };
  function openCardCheck(pendingOnly = false) {
    checkedRound = round()?.id;
    pendingCardsOnly = pendingOnly; locatedCard = null;
    $('exempt-heading').textContent = pendingOnly ? '待收卡号' : '本轮卡号';
    buildCardList(round(), true);
    $('exempt-dialog').showModal();
    render();
  }
  function buildCardList(r, opening) {
    const roster = [...Model.roundRoster(session(),r)].sort((a,b)=>a.cardNumber-b.cardNumber);
    const anchor = opening ? null : locatedCard ?? cardStates[cardPage * cardsPerPage]?.number;
    cardStates = roster.map(s => ({number:s.cardNumber, state:''}));
    const overview = companion && (roster.length > cardsPerPage || document.body.classList.contains('in-disc'));
    if (opening || locatedCard === null) {
      $('card-overview').hidden = !overview;
      $('card-details').hidden = overview;
    }
    const map = $('card-map');
    map.replaceChildren();
    $('card-page').replaceChildren();
    if (overview) {
      // Group by printed number. A gap in the roster leaves its column empty.
      const decades = new Set(roster.map(s => Math.floor((s.cardNumber - 1) / 10)));
      const columns = decades.size > 8 ? 20 : 10;
      let row, rowStart;
      for (const [index, {cardNumber}] of roster.entries()) {
        const offset = (cardNumber - 1) % columns, first = cardNumber - offset;
        if (first !== rowStart) {
          rowStart = first;
          row = document.createElement('span');
          row.className = 'card-map-row';
          const label = document.createElement('span');
          label.className = 'card-row-start'; label.textContent = first;
          row.append(label); map.append(row);
        }
        const dot = document.createElement('span');
        dot.className = 'card-dot'; dot.dataset.card = cardNumber; dot.dataset.index = index;
        dot.style.gridColumn = String(offset + 2);
        row.append(dot);
      }
      map.style.setProperty('--columns', columns);
      map.style.setProperty('--rows', map.childElementCount);
      map.style.setProperty('--dot-size', columns === 20 ? '6px' : '9px');
      for (let i = 0; i < roster.length; i += cardsPerPage) {
        const last = Math.min(i + cardsPerPage, roster.length) - 1;
        const range = i === last ? String(roster[i].cardNumber) : roster[i].cardNumber + '-' + roster[last].cardNumber;
        $('card-page').add(new Option(range, String(i / cardsPerPage)));
      }
    }
    $('exempt-cards').innerHTML = roster.map(s=>`<label tabindex="-1"><input type="checkbox" data-student="${esc(s.id)}" aria-label="${s.cardNumber} 号免答" aria-describedby="card-check-${s.cardNumber}"><span>${s.cardNumber} 号 <small id="card-check-${s.cardNumber}" class="card-check-state"></small></span></label>`).join('');
    const position = roster.findIndex(student => student.cardNumber === anchor);
    showCardPage(position < 0 ? 0 : Math.floor(position / cardsPerPage));
  }
  $('exempt').onclick = () => openCardCheck();
  $('exempt-cards').onchange = async event => {
    const input = event.target, student = input.dataset.student;
    if (!student || pendingCardsOnly || !active() || frozen || data?.context?.revoked || round()?.id !== checkedRound || round()?.status === 'closed') return;
    const focused = document.activeElement === input;
    await run(() => dispatch(command('set_exempt',{studentId:student,exempt:input.checked})));
    const dialog = $('exempt-dialog');
    // Disabling the checkbox during a slow save can move keyboard focus to the document.
    if (focused && document.hasFocus() && dialog.open && input.isConnected && !input.disabled && !input.closest('[hidden]') &&
        (document.activeElement === document.body || document.activeElement === dialog))
      input.focus({preventScroll:true});
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
  async function returnToSetup(collapse = false, destination = '') {
    data = await request('load');
    controller = deck = null;
    historyRecord = null;
    $('card-mode').value = 'scanned';
    resetSessionControls();
    if (pane || destination) showPane(destination);
    render(); feedback(destination ? '' : '可以开始下一堂课。');
    if (!destination) $('setup-heading').focus();
    if (collapse) native?.postMessage({type:'collapse'});
  }
  $('return-setup').onclick = () => run(() => returnToSetup());
  $('sync').onclick = () => run(async()=>{ mergeSync(await request('sync',{retry:true})); feedback(controller.journal.reviewError || '已核对本机同步状态。',controller.journal.reviewError?'warning':''); });
  $('pane-back').onclick = () => back();
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close',() => {
    dialog.querySelector('p[role="alert"]:not(#editor-error)')?.remove();
    if (dialog.id === 'pair-dialog' && !dialog.open) releasePair();
    renderWheel();
  }));
  document.addEventListener('keydown',event => {
    if (!companion || event.defaultPrevented) return;
    if (event.key === 'Escape' && !event.isComposing && (currentDiscPage || !document.querySelector('dialog[open]') && pane)) { event.preventDefault(); back(); }
    else if (event.key === 'F4' && !event.altKey) { event.preventDefault(); native?.postMessage({type:'collapse'}); }
  });
  document.querySelectorAll('[data-dismiss]').forEach(button=>button.onclick=() => $(button.dataset.dismiss).close());
  document.addEventListener('visibilitychange',updateVisibility);
  window.addEventListener('pagehide',()=>{disposed=true;liveVideo.stop();closePreviewPeer();scanner.stop();clearTimeout(relayTimer);clearTimeout(syncTimer);});
  if (native) native.addEventListener('message',event=>{
    const value = event.data; if (!value || typeof value !== 'object') return;
    if (value.type === 'response') { const task = pending.get(value.id); if (!task) return; clearTimeout(task.timeout); pending.delete(value.id); value.error ? task.reject(new Error(value.error)) : task.resolve(value.value); }
    else if (value.type === 'preview-consumed' || value.type === 'preview-buffer-unavailable') liveVideo.acknowledge(value);
    else if (value.type === 'suspend') void confirmSuspend(value.suspendId);
    else if (value.type === 'visibility') {
      document.body.classList.toggle('in-disc', companion && value.nativeDisc === true);
      hostVisible = value.visible === true; updateVisibility();
    }
    else if (value.type === 'authorization' && value.revoked) { scanner.stop(); if (data?.context) data.context.revoked = true; render(); feedback(value.message || '设备授权已失效，采集已停止，本机记录保留待核对。','error'); }
    else if (value.type === 'companion-action' && typeof value.action === 'string') {
      const lesson = wheel.lesson;
      if (!hostVisible || document.hidden || suspension || disposed) return;
      if (value.action.startsWith('preview-')) { previewAction(value.action,value.key); return; }
      if (value.key && value.key !== lesson?.key) return;
      if (value.action === 'back' && value.pageKey && value.pageKey !== currentDiscPage?.key) return;
      if (document.body.classList.contains('in-disc') && (pane || document.querySelector('dialog[open]')) &&
          !['back','dismiss'].includes(value.action) && !value.action.startsWith('disc-') && !value.action.startsWith('card-')) return;
      if (value.action.startsWith('disc-')) {
        const id = value.action.slice(5);
        if (!hostVisible || disposed || !currentDiscPage || value.pageKey !== currentDiscPage.key ||
            !currentDiscPage.items.some(item => item.id === id && item.enabled !== false)) return;
        ($('editor').open ? discEditor : disc).activate(id);
      }
      else if (value.action.startsWith('setup-')) activateSetup(value);
      else if (value.action === 'missing' && !operation && !document.querySelector('dialog[open]') &&
          ['collect','paused'].includes(lesson?.phase) && !$('exempt').disabled)
        openCardCheck(lesson.participantCount === undefined || (lesson.number === 1 && lesson.missing.length > 0));
      else if (value.action.startsWith('card-') && !operation && $('exempt-dialog').open && checkedRound === round()?.id) {
        if (value.action === 'card-scope' && document.body.classList.contains('in-disc') && !$('card-overview').hidden &&
            ['collect','paused'].includes(lesson.phase)) {
          pendingCardsOnly = !pendingCardsOnly;
          locatedCard = null;
          $('exempt-heading').textContent = pendingCardsOnly ? '待收卡号' : '本轮卡号';
          render();
        } else if (value.action === 'card-locate') locateCard(value.cardNumber == null ? null :
          cardStates.findIndex(card => card.number === value.cardNumber));
        else if ($('card-overview').hidden && value.action === 'card-toggle' && !operation && !pendingCardsOnly) {
          const index = cardStates.findIndex(card => card.number === value.cardNumber);
          const input = $('exempt-cards').children[index]?.querySelector('input');
          if (Math.floor(index / cardsPerPage) === cardPage && input && !input.disabled) input.click();
        } else if ($('card-overview').hidden && (value.action === 'card-prev' || value.action === 'card-next')) $(value.action).click();
      }
      else if (value.action === 'advance' && !operation && !$('next').disabled) $('next').click();
      else if (value.action === 'open-camera' && canCapture() && !operation && round()?.status === 'collecting' && !scanner.running)
        void run(() => openBoardCamera(visibilityRevision));
      else if (value.action === 'finish-confirmed' && active() && !operation && !frozen) void run(() => finishSession(false));
      else if (value.action === 'record-chart' && lesson?.phase === 'done' && !operation && document.body.classList.contains('in-disc') &&
          Number.isInteger(value.questionIndex) && lesson.records[value.questionIndex]?.bars?.length)
        showPane('record-chart', value.questionIndex);
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

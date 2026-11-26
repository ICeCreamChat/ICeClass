(() => {
  'use strict';
  const $=id=>document.getElementById(id), pending=new Map();
  const letters = 'ABCD';
  const subjects={chinese:'语文',math:'数学',english:'英语',physics:'物理',chemistry:'化学',biology:'生物',politics:'政治',history:'历史',geography:'地理'};
  let user, pair, state, connected=false, pollTimer, polling=false, failures=0, disposed=false, controlBusy=false, uncertain=0, editQuestionId, editContext, cameraIntent=0, captureKey='';
  let cameraOpening=false;
  let followRounds=false, collectingMultiRound='', cardsBeforePause=null;
  const pollTimeout=5000, reconnectGrace=12000;
  let reconnectTimer;
  const pairStorage = 'iceclass.cardQuizPair';
  const rescan = '请在班班点「手机扫码」，扫新码连接。';
  let scan = null, claimingScan = false, waitingOffline = false;
  const previewFrame = CardQuizPreview.frameSampler();
  let previewPeer = null, previewVisible = false, widePreview = false, previewRetryAt = 0;
  function releasePreview() {
    const peer = previewPeer;
    previewPeer = null;
    previewVisible = widePreview = false;
    $('on-board').hidden = true;
    peer?.close();
  }
  function viewMatchesRound(peer) {
    const view=peer?.view;
    return Boolean(view && connected && !disposed && !document.hidden && state && !state.ended &&
      state.sourceId===pair?.pairId && state.roundStatus==='collecting' && state.roundId===view.round &&
      (state.generation===view.generation || state.questionType==='multiple' && state.generation>view.generation));
  }
  function updatePreviewTrack() {
    const peer=previewPeer;
    if (!peer?.follow) return;
    const currentTrack=scanner.stream?.getVideoTracks()[0];
    // Hold the already authorized view during a short signaling outage. New views need fresh classroom state.
    const keepTrack=reconnectTimer && peer.videoKey===peer.view?.view && peer.sentTrack===currentTrack;
    const track=scanner.running && peer.view?.visible && (viewMatchesRound(peer) || keepTrack) ? currentTrack : null;
    const key=track ? peer.view.view : '';
    if (peer.videoKey===key && peer.sentTrack===track) return;
    peer.videoKey=key; peer.sentTrack=track;
    previewVisible=false; $('on-board').hidden=true;
    peer.videoSender.replaceTrack(track).then(()=>{
      if (previewPeer!==peer || peer.videoKey!==key || peer.sentTrack!==track || !track) return;
      previewVisible=true; $('on-board').hidden=false;
      peer.send(JSON.stringify({live:key}));
    }).catch(()=>peer.close());
  }
  async function connectPreview(signal) {
    if (!signal?.offer || signal.id === previewPeer?.id || !scanner.running || !connected ||
        document.hidden || disposed || state?.sourceId !== pair?.pairId || state?.roundStatus !== 'collecting') return;
    if (performance.now() < previewRetryAt) return;
    releasePreview();
    const path = '/api/card-quiz/pairs/' + encodeURIComponent(pair.pairId) + '/preview';
    let peer;
    const failed = () => {
      previewRetryAt = performance.now() + 3000;
      setText('preview-status','白板取景重连中，仍可收卡。');
    };
    try {
      const track = scanner.stream?.getVideoTracks()[0];
      peer = new CardQuizPreview.Peer(signal.id, {
        gatherAll: previewRetryAt > 0,
        onOpen: () => {
          if (previewPeer === peer) { previewRetryAt=0; setText('preview-status',''); }
        },
        onMessage: value => {
          if (previewPeer !== peer) return;
          if (scan && peer.videoSender && value === 'follow-rounds?') {
            peer.send('follow-rounds');
          } else if (scan && peer.videoSender && value === 'rest') {
            peer.follow=true; peer.view=null;
            stopCamera(true); show();
          } else if (scan && peer.videoSender && typeof value==='string' && value.length<=1024 && value[0]==='{') {
            let view;
            try { view=JSON.parse(value); } catch { return; }
            if (typeof view.view!=='string' || !view.view || typeof view.round!=='string' ||
                !Number.isSafeInteger(view.generation) || typeof view.visible!=='boolean') return;
            peer.follow=true; peer.view=view;
            peer.send(JSON.stringify({seen:view.view}));
            updatePreviewTrack();
            if (followRounds && viewMatchesRound(peer)) void openCamera(true);
          } else if (value === 'wide') widePreview = true;
          else if (value === 'show' || value === 'hide') {
            if (peer.follow) return;
            const visible = value === 'show';
            if (visible === previewVisible) return;
            previewVisible = visible;
            $('on-board').hidden = !visible;
            if (peer.videoSender) peer.videoSender.replaceTrack(visible ? track : null).catch(() => peer.close());
          }
          else if (value === 'stop') { stopCamera(); show(); }
        },
        onClose: () => {
          if (previewPeer !== peer) return;
          releasePreview();
          if (scanner.running) failed();
        }
      }, signal.iceServers || []);
      previewPeer = peer;
      const answer = await peer.describe('answer',signal.offer,track);
      if (previewPeer === peer) await api(path,{id:signal.id,answer});
    } catch {
      if (peer && previewPeer === peer) peer.close();
      else if (!peer) failed();
    }
  }
  function setText(id, message) {
    const element = $(id);
    if (element.textContent !== message) element.textContent = message;
  }
  function feedback(message, kind = '') {
    setText('feedback', message);
    $('feedback').className = ('feedback ' + kind).trim();
  }
  function sendPreview(canvas, markers) {
    const peer = previewPeer;
    if (!previewVisible || !peer || peer.channel?.bufferedAmount > 0) return;
    if (peer.videoSender) {
      const unit = (value, size) => Math.max(0, Math.min(1, Math.round(10000 * value / size) / 10000));
      const corners = [];
      for (const {corners: points} of markers) {
        if (points?.length !== 4 || !points.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.y))) continue;
        corners.push(points.map(p => [unit(p.x, canvas.width), unit(p.y, canvas.height)]));
        if (corners.length === 157) break; // Number of paper cards supported by the detector and board overlay.
      }
      peer.send(JSON.stringify({corners}));
    } else {
      const frame = previewFrame(canvas,markers,widePreview);
      if (frame) peer.send(frame);
    }
  }
  const scanner = new CardQuizScanner({
    video: $('camera'),
    waitForFrames: true,
    onPreview: sendPreview,
    onRead: read => send('answer', {...read, ...(state?.questionType === 'multiple' ? {targetOption: state.activeOption} : {})}),
    onStatus: ({kind, message}) => {
      if(kind==='error' && !scanner.running) followRounds=false;
      $('camera-status').dataset.kind = kind;
      setText('camera-status', kind === 'ready' ? '' : message);
      show();
    }
  });
  const entryQuery=new URLSearchParams(location.search);
  let initialCode=entryQuery.get('code')||'';
  function savedPair() {
    try { return JSON.parse(sessionStorage.getItem(pairStorage)); } catch { return null; }
  }
  function remember(value) {
    try {
      if (value) sessionStorage.setItem(pairStorage, JSON.stringify(value));
      else sessionStorage.removeItem(pairStorage);
      return true;
    } catch { return false; }
  }
  async function api(path,body,timeout=15000){
    const headers=body?{'Content-Type':'application/json'}:{};
    if(scan) headers['X-ICeClass-Scanner']=scan.key;
    else if(body) headers['X-CSRF-Token']=user?.csrfToken||'';
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(),timeout);
    try {
      const response=await fetch(path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,
        credentials:scan?'omit':'same-origin',redirect:'error',cache:'no-store',signal:abort.signal});
      const value=await response.json().catch(()=>({}));
      if(!response.ok){const error=new Error(value.error||'连接未完成，请重试。');error.status=response.status;throw error;}
      return value;
    } finally { clearTimeout(timer); }
  }
  function showProgress(multiple, inRound) {
    const perOption = multiple && inRound;
    const received = perOption ? state.optionReceived || 0 : state.received;
    const expected = state.expected;
    const label = perOption ? '本项已收' : multiple && !state.noCardPolicy ? '整题完成' : '已收';
    const ring = $('progress-ring');
    const scanned = state.participantCount !== undefined;
    ring.hidden = !state.questionId || !scanned && !expected;
    ring.classList.toggle('three-digits', expected >= 100);
    ring.setAttribute('role', scanned ? 'status' : 'progressbar');
    ring.setAttribute('aria-label', scanned ? label + ' ' + received + ' 人' : label);
    if (scanned) {
      for (const attribute of ['aria-valuemin','aria-valuemax','aria-valuenow','aria-valuetext']) ring.removeAttribute(attribute);
    } else {
      ring.setAttribute('aria-valuemin', '0');
      ring.setAttribute('aria-valuemax', expected || 1);
      ring.setAttribute('aria-valuenow', received);
      ring.setAttribute('aria-valuetext', received + ' / ' + expected + ' 人');
    }
    setText('received', String(received));
    setText('expected', scanned ? ' 人' : ' / ' + expected);
    setText('ring-label', !scanned && !multiple && inRound && expected && received === expected ? '已收齐' : label);
    const arc = $('progress-arc');
    arc.toggleAttribute('hidden', scanned || !received || !expected);
    arc.setAttribute('stroke-dashoffset', expected ? 100 * (1 - received / expected) : 100);

    const sealed = state.roundStatus === 'closed' && state.noCardPolicy === 'abstain';
    const notes = [];
    if (scanned && state.questionNumber > 1) notes.push('本节已参与 ' + state.participantCount + ' 人');
    if (scanned && !state.participantCount) notes.push(sealed ? '本轮未收到卡' : '等待举卡');
    else if (!expected) notes.push('全员免答');
    else if (expected > received && (sealed || (inRound && (scanned || !perOption)))) {
      notes.push((sealed ? '弃权 ' : '待收 ') + (expected - received) + ' 人');
    }
    $('capture-progress').hidden = !state.questionId || !notes.length;
    setText('capture-progress', notes.join(' · '));
    $('multi-progress').hidden = !perOption || !expected;
    setText('multi-progress', perOption ? (state.noCardPolicy === 'abstain' ? '本题已举卡 ' : '整题完成 ') + state.received + (scanned ? ' 人' : ' / ' + expected) : '');
  }

  function showEditor(multiple, editable) {
    $('next-type').disabled = $('next').disabled = !editable;
    $('next-count').disabled = !editable || $('next-type').value === 'boolean';
    $('reveal').disabled = $('question-edit').disabled = !editable || !state.questionId;
    $('edit-value').disabled = $('edit-field').disabled = $('edit-reset').disabled = $('question-edit').disabled;
    if (editQuestionId !== state.questionId) {
      editQuestionId = state.questionId;
      resetEdit();
    }
    const field = $('edit-field').value;
    const multiEdit = multiple && field === 'answer';
    $('edit-multiple-answer').hidden = !multiEdit;
    $('edit-value-label').hidden = multiEdit;
    setText('edit-hint', field === 'tags' ? '知识点用逗号分隔，留空清除' :
      field === 'text' ? '题干，留空清除' : '答案 A-' + letters[state.optionCount - 1] + '，留空清除');
    const options = $('edit-multiple-options');
    if (multiEdit && options.children.length !== state.optionCount) {
      options.innerHTML = [...letters.slice(0, state.optionCount)].map(letter =>
        `<label><input type="checkbox" value="${letter}"><span>${letter}</span></label>`).join('');
    }
    options.querySelectorAll('input').forEach(input => { input.disabled = $('question-edit').disabled; });
  }

  function show() {
    $('login').hidden = Boolean(scan || user);
    $('pairing').hidden = Boolean(scan || !user || pair);
    $('capture').hidden = !pair;
    $('round').hidden = !state;
    $('account').hidden = !user || Boolean(pair);
    setText('account', user?.displayName || user?.username || '');
    $('connection').hidden = !pair;
    $('login-form').querySelector('button').disabled = controlBusy;
    $('pair-form').querySelector('button').disabled = controlBusy;
    if (!state) {
      setText('connection', failures ? '正在重连' : waitingOffline ? '白板离线' : '正在连接白板');
      setText('disconnect', '断开手机');
      $('stop').hidden = $('stop').disabled = true;
      $('round-tools').hidden = true;
      $('courseware').open = $('question-settings').open = false;
      return;
    }

    const selected = state.source === 'phone' && state.sourceId === pair?.pairId;
    const own = connected && selected && !state.ended;
    const collecting = own && state.roundStatus === 'collecting';
    const reconnecting = Boolean(reconnectTimer && selected && !state.ended);
    const canShowCamera = (own || reconnecting) && state.roundStatus === 'collecting';
    if (!scanner.running && previewPeer && !(previewPeer.follow && (own || reconnecting))) releasePreview();
    const paused = state.roundStatus === 'paused';
    const between = !state.roundId || state.roundStatus === 'closed';
    const inRound = !between && !state.ended;
    const multiple = state.questionType === 'multiple';
    const active = state.activeOption || 'A';
    const nextOption = letters.slice(0, state.optionCount)[letters.indexOf(active) + 1];
    const nextKey = `${state.sessionId}/${state.roundId}/${state.generation}`;
    const multiRound = scan && canShowCamera && multiple ? state.roundId : '';
    const sameMultiRound = Boolean(multiRound && multiRound === collectingMultiRound);
    const held = captureKey !== nextKey && sameMultiRound && scanner.running ? scanner.cardsInView() : null;
    if (captureKey !== nextKey || !canShowCamera) {
      if (!sameMultiRound && (cameraOpening || scanner.running)) stopCamera(own);
      setText('camera-status', '');
    }
    collectingMultiRound = multiRound;
    captureKey = nextKey;

    const awaitingBoard = !selected && failures === 0 && !document.hidden;
    const connection = state.ended ? '已结课' : reconnecting ? '正在重连' : awaitingBoard ? (scan ? '正在连接白板' : '请在白板确认') : !connected ? '白板离线' :
      collecting ? '正在收答' : paused ? '已暂停' : state.roundId ? '已封存' : '已连接';
    setText('connection', connection);
    $('connection').dataset.state = collecting ? 'live' : !own && !state.ended ? 'waiting' : 'idle';
    setText('disconnect', state.ended && !scan ? '连接下一堂课' : '断开手机');
    setText('class-name', [state.className, subjects[state.subjectId] || state.subjectId].filter(Boolean).join(' · '));
    setText('question-number', state.questionId ? '第 ' + state.questionNumber + ' 题' : '尚未出题');
    setText('question-type', !state.questionId ? '' : multiple ? (scan && inRound ? '多选 · 收 ' + active + ' 项' : '多选') : state.questionType === 'boolean' ? '判断' : '单选 A-' + letters[state.optionCount - 1]);
    showProgress(multiple, inRound);

    $('multi-capture').hidden = Boolean(scan) || !multiple || !inRound;
    $('multi-option').disabled = Boolean(scan) || !collecting || controlBusy;
    for (const button of $('multi-option').querySelectorAll('button')) {
      button.hidden = letters.indexOf(button.value) >= state.optionCount;
      button.setAttribute('aria-pressed', String(button.value === active));
    }
    const guide = $('card-guide');
    guide.hidden = !inRound || !(multiple || state.questionType === 'boolean');
    if (!guide.hidden) {
      setText('card-a', multiple ? '选' : '对');
      const raised = multiple && state.noCardPolicy === 'abstain';
      setText('guide-label', raised ? '选才举卡' : '字母朝上');
      setText('card-b', multiple ? (raised ? '改为不选' : '不选') : '错');
      guide.setAttribute('aria-label', raised ? '选才举卡，A 朝上。改为不选时举 B。' : multiple ? 'A 朝上表示选，B 朝上表示不选' : 'A 朝上表示正确，B 朝上表示错误');
    }

    $('start').hidden = Boolean(scan) || !own || !state.questionId || state.roundStatus === 'collecting';
    $('start').disabled = Boolean(scan) || !own || (!between && !paused) || controlBusy || !state.questionId;
    setText('start', paused ? '恢复本轮' : state.roundId ? '重新收答' : '开始收答');
    $('camera-panel').hidden = !canShowCamera;
    $('camera').hidden = !canShowCamera || (!cameraOpening && !scanner.running);
    $('camera-idle').hidden = scanner.running || cameraOpening;
    $('viewfinder').classList.toggle('is-live', scanner.running);
    $('camera-toggle').hidden = !canShowCamera;
    $('camera-toggle').disabled = controlBusy || !collecting && !(reconnecting && (cameraOpening || scanner.running));
    setText('camera-toggle', scanner.running ? '关闭相机' : cameraOpening ? '取消开启' : '开启相机');
    $('camera-toggle').classList.toggle('primary', collecting && !scanner.running && !cameraOpening);
    const canAdvance = !scan && collecting && multiple && Boolean(nextOption);
    $('multi-next').hidden = !canAdvance;
    $('multi-next').disabled = !canAdvance || controlBusy;
    if (canAdvance) setText('multi-next', '下一项 ' + nextOption);
    $('multi-next').classList.toggle('primary', canAdvance && scanner.running);
    const stop = $('stop');
    if (canAdvance && stop.parentElement !== $('link-actions')) $('link-actions').prepend(stop);
    if (!canAdvance && stop.parentElement !== $('round-actions')) $('round-actions').append(stop);
    $('stop').hidden = Boolean(scan) || !own || between;
    $('stop').disabled = Boolean(scan) || !own || between || controlBusy;
    setText('stop', canAdvance ? '提前封存' : '结束收答');
    $('stop').classList.toggle('primary', collecting && scanner.running && !canAdvance);

    const submission = $('submission-status');
    submission.dataset.kind = uncertain ? 'warning' : '';
    const receipts = [];
    if (pending.size) receipts.push(pending.size + ' 条待白板确认');
    if (uncertain) receipts.push(uncertain + ' 条未确认，请核对白板');
    setText('submission-status', receipts.join(' · '));
    $('round-tools').hidden = Boolean(scan) || !between || !own;
    $('question-settings').hidden = !state.questionId;
    if (!between || state.ended) $('courseware').open = $('question-settings').open = false;
    if (!scan) showEditor(multiple, own && between && !controlBusy);
    scanner.reset(nextKey, multiple ? 2 : state.optionCount);
    if (held) scanner.waitForNewPresentation(held);
    scanner.setReading(collecting);
    updatePreviewTrack();
  }
  function clearReconnect(){
    clearTimeout(reconnectTimer);
    reconnectTimer=undefined;
  }
  function interrupted(message){
    connected=false;
    if (scan && !document.hidden && state?.source==='phone' && state.sourceId===pair?.pairId && !state.ended &&
        (cameraOpening || scanner.running || followRounds)) {
      reconnectTimer ??= setTimeout(()=>{
        stopCamera();show();
        feedback('连接尚未恢复。恢复后请点“开启相机”。','warning transport');
      },reconnectGrace);
    } else stopCamera();
    feedback(message,reconnectTimer?'warning transport':'error transport');
    show();
  }
  function stopCamera(keepFollowing=false){
    if (keepFollowing && followRounds && scanner.running) cardsBeforePause=scanner.cardsInView();
    if (!keepFollowing) {
      clearReconnect();
      followRounds=false;
      cardsBeforePause=null;
      collectingMultiRound='';
    }
    ++cameraIntent;
    if (!keepFollowing || !previewPeer?.follow) {
      if (!keepFollowing && previewPeer?.follow) previewPeer.send('camera-off');
      releasePreview();
    }
    previewRetryAt = 0; setText('preview-status','');
    cameraOpening=false;
    scanner.stop();
    updatePreviewTrack();
    $('camera-status').textContent='';
  }
  async function openCamera(automatic=false){
    if(cameraOpening||scanner.running||!connected||document.hidden||state?.roundStatus!=='collecting')return;
    if (scan?.openOnConnect) { scan.openOnConnect=false; remember(scan); }
    if (cardsBeforePause) {
      scanner.waitForNewPresentation(cardsBeforePause);
      cardsBeforePause=null;
    }
    const intent=++cameraIntent;
    cameraOpening=true;
    $('camera-status').dataset.kind='starting';
    setText('camera-status','请允许相机访问…');
    show();
    const preview=$('camera'), viewport=window.visualViewport;
    const bottom=viewport?viewport.offsetTop+viewport.height:window.innerHeight;
    if(preview.getBoundingClientRect().top>=bottom)preview.scrollIntoView({block:'nearest'});
    try{
      await scanner.start();
      if(intent===cameraIntent && scanner.running) followRounds=Boolean(scan);
    }
    catch(error){
      if(intent!==cameraIntent)return;
      followRounds=false;
      let message=error.message||'相机未能打开，请重试。';
      if(error.name==='NotAllowedError'||error.name==='SecurityError')
        message=automatic ? '点“开启相机”，并允许访问相机。' : '相机权限未开启，请在浏览器的网站设置中允许相机后重试。';
      else if(error.name==='NotSupportedError')message='当前浏览器无法访问相机，请用系统浏览器打开扫码页。';
      else if(error.name==='NotFoundError')message='没有找到摄像头，请检查设备后重试。';
      else if(error.name==='NotReadableError')message='相机暂时无法读取，请关闭其他使用相机的应用后重试。';
      $('camera-status').dataset.kind='error';
      setText('camera-status', message);
    }finally{
      if(intent===cameraIntent){cameraOpening=false;show();}
    }
  }
  function settle(id,value){
    const item=pending.get(id);if(!item)return;
    if(value.status==='confirmed'){
      pending.delete(id);item.resolve(value.result||value);
      if(value.result?.state&&(!state||value.result.state.seq>=state.seq))state=value.result.state;
      if(item.command.action==='edit_question')feedback('本题已保存。');
      else if(item.command.action==='reveal')feedback('已标记讲解。');
    }else if(value.status==='rejected'){
      pending.delete(id);item.reject(new Error(value.error||'白板拒绝了这次操作。'));feedback(value.error||'操作被拒绝，请核对题目。','error');
    }
    show();
  }
  function unconfirmed(id,message){
    const item=pending.get(id);if(!item)return;
    pending.delete(id);uncertain++;stopCamera();item.reject(new Error(message));feedback(message,'warning');
  }
  function clearPending(message){for(const id of [...pending.keys()])unconfirmed(id,message);}
  function resumeConnection() {
    if (disposed || document.hidden) return;
    if (pair) void poll();
    else if (scan?.invite) void claimScan();
  }
  function schedule(){
    clearTimeout(pollTimer);
    if (!disposed && !document.hidden && (pair || scan?.invite) && !(scan && state?.ended))
      pollTimer=setTimeout(resumeConnection,reconnectTimer ? 1200 : Math.min(15000,1200*2**failures));
  }
  function leavePair() {
    pair=state=null; connected=false; failures=0; waitingOffline=false;
    if (scan) scan={mode:'scan'};
    remember(scan);
  }
  async function poll(){
    if(polling||!pair||disposed)return;polling=true;const pairId=pair.pairId;
    try{
      const query=new URLSearchParams();for(const id of pending.keys())query.append('commandId',id);
      if(scanner.running || scan?.openOnConnect || followRounds)query.set('preview',previewPeer?.id || 'open');
      const value=await api('/api/card-quiz/pairs/'+encodeURIComponent(pair.pairId)+(query.size?'?'+query:''),undefined,pollTimeout);
      if(pair?.pairId!==pairId||disposed)return;
      if (scan && value.state === null) {
        connected=false; failures=0; state=null; waitingOffline=value.boardOnline===false;
        stopCamera();
        feedback(waitingOffline ? '请确认白板联网，并保持扫码圆环打开。' : '',waitingOffline?'warning transport':'');
        show(); return;
      }
      if(!value.state || !Number.isSafeInteger(value.state.seq) || typeof value.connected!=='boolean')
        throw new Error('未收到白板状态。');
      clearReconnect();
      if(!state||value.state.seq>=state.seq)state=value.state;
      connected=value.connected&&!document.hidden;failures=0;
      if($('feedback').classList.contains('transport') && (connected || state.sourceId!==pairId))feedback('');
      for(const receipt of value.receipts||[])settle(receipt.id,receipt);
      const found=new Set((value.receipts||[]).map(r=>r.id));
      for(const[id,item]of pending){
        if(item.deliveryUnknown&&!found.has(id))item.missing=(item.missing||0)+1;
        if(item.missing>=2||Date.now()-item.at>60000)unconfirmed(id,'操作状态尚未确认，请在白板核对后继续；本手机不会自动重发。');
      }
      if(!connected)stopCamera();
      show();
      const autoOpen=(scan?.openOnConnect || followRounds) && connected && state.sourceId===pairId &&
        state.roundStatus==='collecting' && !state.ended && (!previewPeer?.follow || viewMatchesRound(previewPeer));
      const opening=autoOpen && !scanner.running ? openCamera(true) : null;
      const acceptOffer=()=>{
        if (!scanner.running || !connected || pair?.pairId!==pairId || state?.generation!==value.state.generation ||
            state.roundId!==value.state.roundId || state.sourceId!==pairId || state.roundStatus!=='collecting') return;
        if (previewPeer && value.preview?.id !== previewPeer.id && (value.preview || previewPeer.channel?.readyState !== 'open')) releasePreview();
        if (value.preview) void connectPreview(value.preview);
      };
      if (opening) void opening.then(acceptOffer); else acceptOffer();
    }catch(error){
      if(pair?.pairId!==pairId||disposed)return;
      if(error.status===429)return;
      failures=Math.min(failures+1,4);
      if([401,403,404,410].includes(error.status)){
        stopCamera();
        clearPending('连接已失效，未确认的作答请在白板核对。');
        if(error.status===401)user=null;
        leavePair();
        show();
        feedback(scan ? '连接已结束。'+rescan : error.message,'error');
      } else interrupted(scan ? '连接暂时中断，正在重试…' : error.status ? error.message : '网络中断。恢复连接后请核对白板人数。');
    }finally{polling=false;schedule();}
  }
  function send(action,payload={},context){
    if(scan && action!=='answer')return Promise.reject(new Error('请在白板操作课堂。'));
    if(!pair||!state||!connected||state.sourceId!==pair.pairId||state.ended)return Promise.reject(new Error('白板尚未连接或采集来源已变化。'));
    if(action==='answer' && state.roundStatus!=='collecting')return Promise.reject(new Error('本轮已停止收答。'));
    if(pending.size>=128)return Promise.reject(new Error('待确认队列已满，请等待白板保存。'));
    if(context&&Object.keys(context).some(key=>context[key]!==state[key]))return Promise.reject(new Error('题目或版本已变化，草稿已保留。请核对后清空重填。'));
    const command={id:crypto.randomUUID(),sessionId:state.sessionId,questionId:state.questionId,roundId:state.roundId,generation:state.generation,sourceId:state.sourceId,action,payload};
    const result=new Promise((resolve,reject)=>pending.set(command.id,{command,resolve,reject,at:Date.now()}));
    api('/api/card-quiz/pairs/'+encodeURIComponent(pair.pairId)+'/commands',command).then(value=>{
      if(value.status==='confirmed')settle(command.id,{status:'confirmed',result:value});else settle(command.id,value);
      show();
    }).catch(error=>{
      const item=pending.get(command.id);
      if(!item)return;
      if(error.status && error.status!==408 && error.status<500){pending.delete(command.id);item.reject(error);feedback(error.message,'error');}
      else{item.deliveryUnknown=true;interrupted('发送尚未确认，请在连接恢复后核对白板。');}
      show();
    });
    show();return result;
  }
  async function claim(){
    pair=await api('/api/card-quiz/pair',{code:$('code').value.trim().toUpperCase()});
    remember(pair);state=null;connected=false;uncertain=0;feedback('');show();await poll();
  }
  async function claimScan() {
    if (claimingScan || !scan?.invite || disposed || document.hidden) return;
    const current=scan;
    claimingScan=true;
    try {
      const result=await api('/api/card-quiz/scan',{invite:scan.invite});
      if (disposed || scan!==current) return;
      if (!result.pairId || result.mode!=='scan') {
        leavePair(); feedback('扫码入口未就绪，请在白板重新打开手机扫码。','error'); show(); return;
      }
      scan.pairId=result.pairId;
      pair=scan;
      remember(scan); failures=0; feedback(''); show();
      await poll();
    } catch (error) {
      if (disposed || scan!==current) return;
      if (error.status>=400 && error.status<500 && error.status!==429) {
        leavePair(); feedback(error.message,'error');
      } else {
        failures=Math.min(failures+1,4);
        feedback('连接中断，正在重试…','warning transport');
      }
      show(); schedule();
    } finally { claimingScan=false; }
  }
  async function control(task) {
    if (controlBusy) return;
    const trigger = document.activeElement;
    controlBusy = true;
    feedback('');
    show();
    try { await task(); }
    catch (error) { feedback(error.message, 'error'); }
    finally {
      controlBusy = false;
      show();
      if (trigger && trigger !== document.body && document.activeElement === document.body && !document.hidden) {
        const target = [trigger, $('camera-toggle'), $('start'), $('courseware').querySelector('summary'),
          $('disconnect'), $('code'), $('username')].find(el => el.getClientRects().length && !el.matches(':disabled'));
        target?.focus({preventScroll:true});
      }
    }
  }
  $('login-form').onsubmit=event=>{event.preventDefault();void control(async()=>{const value=await api('/api/auth/login',{username:$('username').value,password:$('password').value});$('password').value='';user=value.user;show();if(initialCode){initialCode='';await claim();}});};
  $('pair-form').onsubmit=event=>{event.preventDefault();void control(claim);};
  $('start').onclick=()=>void control(async()=>{const intent=++cameraIntent,pairId=pair.pairId,questionId=state.questionId;await send(state.roundStatus==='paused'?'resume_round':'start_round');if(intent===cameraIntent&&!disposed&&!document.hidden&&connected&&pair?.pairId===pairId&&state.questionId===questionId&&state.sourceId===pairId&&state.roundStatus==='collecting')void openCamera();});
  $('stop').onclick=()=>{stopCamera();void control(()=>send('end_round'));};
  $('camera-toggle').onclick=()=>{
    if(cameraOpening||scanner.running){stopCamera();show();}
    else void openCamera();
  };
  function switchMultiOption(option){
    if(!option||option===state?.activeOption||controlBusy)return;
    stopCamera();void control(()=>send('set_multi_option',{option}));
  }
  $('multi-option').onclick=event=>switchMultiOption(event.target.closest('button')?.value);
  $('multi-next').onclick=()=>switchMultiOption(letters[letters.indexOf(state?.activeOption)+1]);
  $('next-type').onchange=show;
  $('next').onclick=()=>void control(async()=>{
    await send('add_question',{type:$('next-type').value,options:$('next-type').value==='boolean'?['正确','错误']:Array(Number($('next-count').value)).fill('')});
    $('courseware').open=false;
  });
  $('reveal').onclick=()=>void control(()=>send('reveal',{external:true}));
  const resetEdit=()=>{editContext=null;$('edit-value').value='';$('edit-multiple-options').querySelectorAll('input').forEach(input=>input.checked=false);};
  const captureEdit=()=>{if(!editContext&&state)editContext={sessionId:state.sessionId,questionId:state.questionId,seq:state.seq,generation:state.generation,sourceId:state.sourceId};};
  $('edit-reset').onclick=()=>{
    resetEdit();
    ($('edit-multiple-answer').hidden?$('edit-value'):$('edit-multiple-options').querySelector('input'))?.focus();
  };
  $('edit-field').onchange=()=>{resetEdit();captureEdit();show();};
  $('edit-value').onfocus=captureEdit;
  $('edit-value').oninput=captureEdit;
  $('edit-multiple-options').onchange=()=>{captureEdit();$('edit-value').value=[...$('edit-multiple-options').querySelectorAll('input:checked')].map(input=>input.value).join('');};
  $('question-form').onsubmit=event=>{event.preventDefault();void control(async()=>{
    const context=editContext||{sessionId:state.sessionId,questionId:state.questionId,seq:state.seq,generation:state.generation,sourceId:state.sourceId};
    const payload={expectedSeq:context.seq},field=$('edit-field').value,value=$('edit-value').value;
    if(field==='answer')payload.answer=value.trim().toUpperCase()||null;
    else if(field==='tags')payload.tags=[...new Set(value.split(/[,，]/).map(t=>t.trim()).filter(Boolean))];
    else payload.text=value;
    await send('edit_question',payload,context);resetEdit();
  });};
  $('disconnect').onclick=()=>{
    const checkBoard=pending.size>0||uncertain>0;
    const usingPhone=state&&!state.ended&&state.sourceId===pair?.pairId;
    stopCamera();clearTimeout(pollTimer);clearPending('未确认的操作请在白板核对。');
    leavePair();resetEdit();show();
    feedback(checkBoard?'已断开，未确认的操作请在白板核对。':usingPhone?'已断开。继续收答请在白板换回本机。':scan?rescan:'',checkBoard?'warning':'');
  };
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stopCamera();connected=false;clearTimeout(pollTimer);show();}else resumeConnection();});
  window.addEventListener('online',resumeConnection);
  window.addEventListener('pagehide',()=>{disposed=true;stopCamera();clearTimeout(pollTimer);clearPending('页面已离开，未确认操作请在白板核对。');});
  window.addEventListener('pageshow',event=>{if(event.persisted){disposed=false;resumeConnection();}});
  window.addEventListener('hashchange',()=>{
    if(new URLSearchParams(location.hash.slice(1)).has('scan'))location.reload();
  });
  (async()=>{try{
    const invite=new URLSearchParams(location.hash.slice(1)).get('scan');
    const saved=savedPair();
    const manual=entryQuery.get('manual')==='1';
    if(invite!==null || (!initialCode && !manual && (saved?.mode==='scan' || !saved?.pairId))){
      scan=saved?.mode==='scan' ? saved : {mode:'scan'};
      if(invite!==null && (!invite || invite!==scan.invite)){
        scan={mode:'scan'};
        if (/^[A-Za-z0-9_-]{32}$/.test(invite)) {
          const bytes=crypto.getRandomValues(new Uint8Array(32));
          scan.invite=invite;
          scan.key=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
          scan.openOnConnect=true;
        }
      }
      if(remember(scan) && invite!==null)history.replaceState(null,'',location.pathname);
      pair=scan.pairId ? scan : null;
      show();
      feedback(pair ? '' : scan.invite ? '正在连接白板…' : rescan);
      resumeConnection();
      return;
    }
    if(initialCode){
      $('code').value=initialCode;remember(null);history.replaceState(null,'',location.pathname);
    }
    const value=await api('/api/session');user=value.authenticated?value.user:null;
    show();
    feedback('');
    if(!user)return;
    if(initialCode){
      initialCode='';await claim();return;
    }
    pair=saved?.mode==='scan'?null:saved;
    if(pair){show();await poll();}
  }catch(error){show();feedback(error.message,'error');}})();
})();

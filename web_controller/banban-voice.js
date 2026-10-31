(() => {
  'use strict';
  const wakeWords = ['你好班班', '你好斑斑', '你好班伴', '班班你好'];
  const normalize = text => String(text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  const unrecognized = text => /(?:<|\[)\s*(?:unk|unknown)\s*(?:>|\])|\uFFFD/i.test(String(text || ''));
  const stopPhrases = ['停一下','停止播报','别说了','等一下','先停一下','暂停播报','别念了'];
  const intent = text => {
    const value = normalize(text).replace(/^(?:斑斑|班伴|斑班)/u, '班班').replace(/^再见(?:斑斑|班伴|斑班)$/u, '再见班班');
    if (['取消操作','班班取消操作','先别做了','算了','取消刚才的操作'].includes(value)) return 'cancel';
    if (stopPhrases.some(phrase => value === phrase || value === '班班' + phrase)) return 'interrupt';
    if (['再见班班','班班再见','结束对话'].includes(value)
      || /^(?:班班)?请?你?先?(?:退下|离开|回去|去休息|休息)(?:吧|了)?$/u.test(value)) return 'leave';
    if (['确认执行','确认这项操作'].includes(value)) return 'confirm';
    if (['好','好的','好哒','嗯','嗯嗯','知道了','明白了','收到'].includes(value)) return 'acknowledge';
    if (/^(?:班班)?(?:你好|您好|谢谢|谢谢你|谢谢您|辛苦了)(?:班班)?$/.test(value)) return 'social';
    return 'question';
  };
  const spoken = text => String(text || '').replace(/```[\s\S]*?```/g, '详细内容请看文字结果。')
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1').replace(/^[\s]*[-*#>]+\s*/gm, '')
    .replace(/[`*_]/g, '').trim().slice(0, 1000);
  function confirmationText(operation, renewed = false) {
    const title = String(operation.title || '这项操作').trim(), target = String(operation.target || '').trim();
    let summary = target && !normalize(title).includes(normalize(target)) ? target + '，' + title : title;
    const impact = String(operation.impact || '').trim();
    if (impact && !normalize(summary).includes(normalize(impact))) summary += '。' + impact;
    return summary.replace(/[。！？!?；;\s]+$/, '') + '。请' + (renewed ? '再次' : '') + '说“确认执行”。';
  }
  let current = null;

  function mount(client) {
    current?.dispose();
    const native = window.ICeClassVoiceHost?.version === 1 && Boolean(window.chrome?.webview);
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const input = client.root.querySelector('#bbInput');
    const inputPlaceholder = input.placeholder;
    const caption = client.root.querySelector('.bb-privacy');
    const mic = document.createElement('button');
    mic.type = 'button'; mic.className = 'bb-voice-button'; mic.setAttribute('aria-pressed', 'false');
    mic.setAttribute('aria-label', '开启语音对话'); mic.title = native ? '开启后台语音唤醒' : '开启本页语音对话';
    mic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>';
    input.before(mic);
    caption.setAttribute('role', 'status'); caption.setAttribute('aria-live', 'polite');
    let enabled = false, active = false, disposed = false, speaking = false, working = false, voiceTurn = false, speechPaused = false;
    let state = 'off', binding = null, recognition = null, restart = 0, failures = 0, generation = 0, dismissed = false;
    let nativeConversation = 0;
    let lastActivity = Date.now(), lastText = '', lastHeard = 0, prompt = null, cancelling = 0, consentBusy = false;
    let inputSequence = 0, speechSequence = 0, ignoreUntil = 0, cancelTask = null, startTimeout = 0;
    let speechStream = null, streamed = false, streamEnded = false, streamPlaying = false;
    const speechQueue = [];
    const operations = new Map(), prompted = new Set();
    const post = (kind, data = {}) => { if (native) window.chrome.webview.postMessage({type:'banban-voice', kind, ...data}); };
    function paint(next, text) {
      if (disposed) return;
      state = next; speaking = next === 'speaking';
      if (!enabled || !['listening','confirming','thinking'].includes(next)) input.placeholder = inputPlaceholder;
      mic.dataset.state = next; mic.setAttribute('aria-pressed', String(enabled));
      mic.setAttribute('aria-label', enabled ? '关闭语音对话' : '开启语音对话');
      mic.title = enabled ? '关闭语音对话' : native ? '开启后台语音唤醒' : '开启本页语音对话';
      caption.textContent = text || (enabled ? '等候“你好班班”' : native ? '开启后，说“你好班班”' : '按您的权限分析和操作');
      caption.dataset.voiceState = next;
      if (!enabled || next === 'error') delete mic.dataset.level;
    }
    function work(next = 'listening') {
      if (!enabled || !active) return;
      post('work', {text:next});
      if (!speaking) paint(next, next === 'thinking' ? '正在处理…' : next === 'confirming' ? '等您确认' : '您说，我在听');
    }
    function stopSpeech(notify = true) {
      speechSequence++;
      speechQueue.length = 0; streamPlaying = false;
      if (notify) post('stop-speech');
      if (!native) window.speechSynthesis?.cancel();
      speaking = false;
    }
    function interruptSpeech(nativeStopped = false) {
      // Stopping playback also silences late callbacks from this turn. The task
      // keeps its real status; only a fresh voice request or wake resumes speech.
      speechPaused = true;
      stopSpeech(!nativeStopped); work(prompt ? 'confirming' : working ? 'thinking' : 'listening');
    }
    function say(text) {
      if (!enabled || !active || disposed || speechPaused) return;
      text = spoken(text); if (!text) { work(); return; }
      lastActivity = Date.now(); stopSpeech(); paint('speaking', '班班正在说…');
      if (native) { post('speak', {text}); return; }
      if (!window.speechSynthesis) { work(); return; }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN'; utterance.rate = 1.05;
      const voice = speechSynthesis.getVoices().find(v => /^zh[-_]/i.test(v.lang));
      if (voice) utterance.voice = voice;
      const token = generation, speechToken = speechSequence;
      utterance.onend = () => { if (token === generation && speechToken === speechSequence && !disposed) { speaking = false; lastActivity = Date.now(); ignoreUntil = Date.now() + 900; work(prompt ? 'confirming' : working ? 'thinking' : 'listening'); } };
      utterance.onerror = e => { if (token === generation && speechToken === speechSequence && !disposed && e.error !== 'canceled' && e.error !== 'interrupted') paint('error', '播报失败，文字结果已保留'); };
      speechSynthesis.speak(utterance);
    }
    function nextSentence() {
      if (native || streamPlaying || !enabled || !active || disposed || speechPaused) return;
      const text = speechQueue.shift();
      if (!text) {
        if (streamEnded) { speaking = false; ignoreUntil = Date.now() + 900; work(prompt ? 'confirming' : working ? 'thinking' : 'listening'); }
        return;
      }
      if (!window.speechSynthesis) { speechQueue.length = 0; work(); return; }
      streamPlaying = true; paint('speaking', '班班正在说…'); lastActivity = Date.now();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN'; utterance.rate = 1.03;
      const voice = speechSynthesis.getVoices().find(v => /^zh[-_]/i.test(v.lang));
      if (voice) utterance.voice = voice;
      const token = generation, speechToken = speechSequence;
      utterance.onend = () => {
        if (token !== generation || speechToken !== speechSequence || disposed) return;
        streamPlaying = false; lastActivity = Date.now(); nextSentence();
      };
      utterance.onerror = e => {
        if (token !== generation || speechToken !== speechSequence || disposed || ['canceled','interrupted'].includes(e.error)) return;
        speechQueue.length = 0; streamPlaying = false; paint('error', '播报失败，文字结果已保留');
      };
      speechSynthesis.speak(utterance);
    }
    function sentence(event) {
      if (!enabled || !active || disposed || speechPaused || !/^[a-f0-9]{32}$/.test(event.turnId || '') || !Number.isInteger(event.sequence)) return;
      if (!speechStream) {
        if (event.sequence !== 0) return;
        stopSpeech(); speechStream = {id:event.turnId, sequence:0}; streamed = true; streamEnded = false;
      }
      if (event.turnId !== speechStream.id || event.sequence < speechStream.sequence || streamEnded) return;
      if (event.sequence !== speechStream.sequence) { interruptSpeech(); return; }
      speechStream.sequence++; streamEnded = event.end === true;
      const text = spoken(event.text);
      if (native) {
        post('speech-segment', {turnId:event.turnId, sequence:event.sequence, text, end:streamEnded});
      } else {
        if (text) speechQueue.push(text);
        if (speechQueue.length > 48) { interruptSpeech(); return; }
        nextSentence();
      }
    }
    function authorize(value) {
      if (!native || disposed) return;
      binding = value;
      const allowed = client.setBinding(value);
      post('authorized', {value:allowed});
      if (!allowed) { enabled = false; paint('error', '班级关联已变化，请重新连接班班'); }
    }
    function refreshAuthorization() {
      // A restored session can mount the chat before its class request finishes.
      // Recheck the same native binding after loading and after scope changes.
      if (native && binding) authorize(binding);
    }
    async function cancelCurrent(announce = true, supersede = true) {
      if (supersede) inputSequence++;
      if (announce) speechPaused = false;
      if (cancelTask) return cancelTask;
      const token = ++generation;
      stopSpeech(); prompt = null; voiceTurn = false; working = false; cancelling++;
      const ids = [...operations.values()].filter(o => ['awaiting_confirmation','running','stopping','unconfirmed'].includes(o.status)).map(o => o.id);
      cancelTask = (async () => { try {
        await client.interrupt();
        const results = await window.ICeClassBanbanOperations.cancelVoice(ids);
        if (token !== generation || disposed) return;
        if (announce) say(results.some(o => ['running','stopping','unconfirmed'].includes(o.status))
          ? '已请求停止，还需要设备确认。'
          : results.some(o => o.status === 'succeeded') ? '任务已经完成，无法取消。'
          : results.some(o => o.status === 'cancelled') ? '已取消。' : '这轮已停止。');
        else work();
      } catch (error) { if (token === generation && !disposed && active) paint('error', '停止结果未确认：' + error.message); throw error; }
      finally { cancelling--; }
      })();
      try { return await cancelTask; } finally { cancelTask = null; }
    }
    function leave(notify = true) {
      if (dismissed) return;
      dismissed = true; active = false; speechPaused = true;
      void cancelCurrent(false).catch(() => {});
      stopSpeech(); prompt = null;
      if (notify) post('leave', {conversation:nativeConversation});
      paint('standby');
    }
    function resumeConversation() {
      if (dismissed) generation++;
      dismissed = false; active = true; lastActivity = Date.now();
    }
    async function confirm() {
      const waiting = [...operations.values()].filter(o => o.status === 'awaiting_confirmation');
      if (prompt && waiting.length === 1 && waiting[0].id === prompt.operation.id && Date.now() - prompt.at > 45000) {
        prompt.at = Date.now();
        say(confirmationText(prompt.operation, true)); return;
      }
      if (!prompt || waiting.length !== 1 || waiting[0].id !== prompt.operation.id) {
        say(waiting.length > 1 ? '有多项待确认操作，请在窗口选择。' : '当前没有待确认的操作。'); return;
      }
      if (prompt.operation.needsPassword) { say('这项操作需要在窗口填写密码，请手动确认。'); return; }
      if (consentBusy) return;
      consentBusy = true;
      const pending = prompt, token = generation; prompt = null; work('thinking');
      try {
        const result = await window.ICeClassBanbanOperations.confirmVoice(pending.operation, () => token === generation && enabled && active && !disposed);
        if (token !== generation || disposed) return;
        if (!working) say(result.status === 'succeeded' ? '已完成。'
          : result.status === 'running' ? '已确认，等电脑执行。' : result.result?.detail || '操作还没有完成。');
      } catch (error) { if (token === generation && !disposed) say(error.message); }
      finally { consentBusy = false; }
    }
    function observe(operation, allowPrompt = true) {
      if (!operation?.id || disposed) return;
      const previous = operations.get(operation.id)?.status;
      operations.set(operation.id, operation);
      if (voiceTurn && enabled && active && allowPrompt && previous !== operation.status && ['succeeded','failed','cancelled'].includes(operation.status))
        post('task-result', {text:operation.status});
      if (prompt?.operation.id === operation.id && operation.status !== 'awaiting_confirmation') prompt = null;
      if (!enabled || !active || !allowPrompt || cancelling || operation.status !== 'awaiting_confirmation') return;
      const stamp = JSON.stringify([operation.id, operation.title, operation.target, operation.impact, operation.parameters, operation.expiresAt]);
      if (prompted.has(stamp)) return;
      prompted.add(stamp);
      prompt = {operation, at:Date.now()}; work('confirming');
      say(operation.needsPassword ? `${operation.title}需要在窗口填写密码，请手动确认。`
        : confirmationText(operation));
    }
    async function question(text) {
      if (!enabled || !active || disposed) return;
      if (unrecognized(text)) {
        input.placeholder = inputPlaceholder; speechPaused = false; lastActivity = Date.now();
        say(prompt ? '没听清，请重新说。待确认操作还未执行。' : '没听清，请完整再说一遍。');
        return;
      }
      const kind = intent(text); lastActivity = Date.now();
      if (kind === 'social' && (working || prompt)) return;
      // Acknowledging the assistant is neither a new instruction nor consent.
      // Do not invalidate a running request or discard its confirmation card.
      if (kind === 'acknowledge') {
        if (prompt && !prompt.reminded) { prompt.reminded = true; say('请说“确认执行”。'); }
        else if (!prompt && !working) say('好。');
        return;
      }
      const ticket = ++inputSequence;
      if (kind === 'interrupt') { interruptSpeech(); return; }
      speechPaused = false;
      if (kind === 'cancel') { await cancelCurrent().catch(() => {}); return; }
      if (kind === 'leave') {
        leave(); return;
      }
      if (kind === 'confirm') { await confirm(); return; }
      stopSpeech();
      // A new request replaces a pending plan. Never replay or blindly retry a write.
      if (cancelTask || working || prompt || [...operations.values()].some(o => ['running','stopping'].includes(o.status))) {
        try { await cancelCurrent(false, false); } catch { return; }
      }
      if (ticket !== inputSequence || disposed || !enabled || !active) return;
      const token = ++generation;
      voiceTurn = true; operations.clear(); prompted.clear(); prompt = null;
      if (!native) client.open();
      if (!navigator.onLine) { say('网络已断开，请联网后重新告诉我要做什么。'); return; }
      working = true;
      try { await client.ask(text, () => ticket === inputSequence && !disposed && enabled && active); }
      catch (error) { if (token === generation && !disposed) say(error.message); }
      finally { if (token === generation && !disposed) { working = false; work(prompt ? 'confirming' : 'listening'); } }
    }
    function heard(text) {
      if (!enabled || disposed) return;
      const value = normalize(text), now = Date.now();
      if (now < ignoreUntil) return;
      if (!value || value === lastText && now - lastHeard < 1200) return;
      lastText = value; lastHeard = now;
      const wake = wakeWords.find(word => value.startsWith(word));
      if (wake) {
        resumeConversation(); stopSpeech();
        let count = 0, position = 0;
        for (const char of text) { position += char.length; count += normalize(char).length; if (count >= wake.length) break; }
        const rest = text.slice(position).replace(/^[\s\p{P}\p{S}]+/u, '');
        if (rest) void question(rest);
        else { const paused = speechPaused; speechPaused = false; say('我在，请说。'); speechPaused = paused; }
        return;
      }
      if (!active || speaking && !value.startsWith('班班') && intent(text) !== 'leave') return;
      void question(text);
    }
    function startBrowser() {
      if (!Recognition || disposed || !enabled || document.hidden) return;
      clearTimeout(restart);
      if (recognition) return;
      const engine = new Recognition(); recognition = engine;
      engine.lang = 'zh-CN'; engine.continuous = true; engine.interimResults = true; engine.maxAlternatives = 1;
      function fail(text, code) {
        if (disposed || recognition !== engine) return;
        enabled = active = false; clearTimeout(startTimeout); clearTimeout(restart);
        stopSpeech(); mic.dataset.error = code;
        paint('error', text); engine.abort();
        if (voiceTurn || operations.size) void cancelCurrent(false).catch(() => {});
      }
      engine.onstart = () => {
        clearTimeout(startTimeout);
        if (disposed || !enabled || recognition !== engine) { engine.abort(); return; }
        delete mic.dataset.error;
        paint(active ? 'listening' : 'standby', active ? '您说，我在听' : '等候“你好班班”');
      };
      engine.onresult = e => {
        if (disposed || !enabled || recognition !== engine) return;
        failures = 0;
        for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) heard(e.results[i][0].transcript);
      };
      engine.onerror = e => {
        if (disposed || !enabled || recognition !== engine) return;
        const errors = {
          'not-allowed':'麦克风未获授权，请允许麦克风后重试',
          'service-not-allowed':'此浏览器的语音服务不可用，请用本机“班班 · 语音助手”',
          'audio-capture':'未找到麦克风，请检查 Windows 声音设置',
          'language-not-supported':'此浏览器不支持中文语音，请用本机“班班 · 语音助手”',
          'network':'本页未连上语音识别服务，请用本机“班班 · 语音助手”'
        };
        if (errors[e.error]) fail(errors[e.error], e.error);
        else if (!['no-speech','aborted'].includes(e.error) && ++failures >= 3)
          fail('本页语音未能启动，请用本机“班班 · 语音助手”', e.error);
      };
      engine.onend = () => {
        if (recognition !== engine) return;
        clearTimeout(startTimeout);
        recognition = null;
        if (enabled && !disposed && !document.hidden) restart = setTimeout(startBrowser, Math.min(5000, 500 * (failures + 1)));
      };
      paint('connecting', '正在连接语音…');
      startTimeout = setTimeout(() => fail('本页语音连接超时，请用本机“班班 · 语音助手”', 'start-timeout'), 12000);
      try { engine.start(); }
      catch { fail('本页语音未能启动，请用本机“班班 · 语音助手”', 'start-failed'); }
    }
    function toggle() {
      if (native) { post('enabled', {value:!enabled}); return; }
      if (!Recognition) { paint('error', '后台语音唤醒请使用 Windows 教室端'); return; }
      enabled = !enabled; active = false; stopSpeech();
      if (enabled) startBrowser();
      else { clearTimeout(startTimeout); clearTimeout(restart); recognition?.abort(); recognition = null; void cancelCurrent(false).catch(() => {}); paint('off'); }
    }
    function nativeEvent(e) {
      const data = e.data;
      if (disposed || !data || data.type !== 'banban-voice') return;
      if (data.kind === 'binding') { authorize(data); return; }
      if (data.kind === 'partial') {
        if (enabled && active && !speaking) input.placeholder = unrecognized(data.text) ? inputPlaceholder : String(data.text || '').slice(0, 120) || inputPlaceholder;
        return;
      }
      if (data.kind === 'unrecognized') { input.placeholder = inputPlaceholder; return; }
      if (data.kind === 'audio-level') {
        if (enabled) mic.dataset.level = String(Math.min(3, Math.max(0, Math.ceil(Number(data.level || 0) / 25))));
        return;
      }
      if (data.kind === 'state') {
        if (data.conversation < nativeConversation) return;
        const wasEnabled = enabled; enabled = data.enabled === true;
        if (!enabled || data.state === 'standby' || data.state === 'login' || data.state === 'error') active = false;
        paint(data.state, data.text);
        if (wasEnabled && !enabled) void cancelCurrent(false).catch(() => {});
      } else if (data.kind === 'wake') { nativeConversation = data.conversation; resumeConversation(); }
      else if (data.kind === 'transcript') void question(data.text);
      else if (data.kind === 'cancel') void cancelCurrent().catch(() => {});
      else if (['interrupt','barge-in'].includes(data.kind)) interruptSpeech(data.kind === 'barge-in');
      else if (data.kind === 'leave') { if (data.conversation === nativeConversation) leave(false); }
      else if (data.kind === 'idle') { void cancelCurrent(false).catch(() => {}); active = false; prompt = null; }
      else if (data.kind === 'suspended') { void cancelCurrent(false).catch(() => {}); active = false; prompt = null; paint('off', '电脑已锁定或休眠，语音已暂停'); }
      else if (data.kind === 'audio-device-changed') { void cancelCurrent(false).catch(() => {}); active = false; prompt = null; paint('connecting', '音频设备已切换，正在重新连接…'); }
    }
    function updated(e) { if (operations.has(e.detail?.id)) observe(e.detail); }
    function visibility() {
      if (native || !document.hidden || !enabled) return;
      enabled = active = false; stopSpeech(); clearTimeout(startTimeout); clearTimeout(restart); recognition?.abort(); recognition = null;
      void cancelCurrent(false).catch(() => {}); paint('off', '页面已隐藏，语音已暂停');
    }
    function offline() { if (enabled && active) { void cancelCurrent(false).catch(() => {}); paint('error', '网络已断开，联网后请重新下达指令'); } }
    const timer = setInterval(() => {
      if (!native && active && !working && !speaking && Date.now() - lastActivity > 180000) {
        void cancelCurrent(false).catch(() => {}); active = false; paint('standby');
      }
    }, 1000);
    mic.addEventListener('click', toggle);
    window.addEventListener('banban-operation-updated', updated);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visibility);
    if (native) {
      window.chrome.webview.addEventListener('message', nativeEvent);
      window.addEventListener('iceclass-ready', refreshAuthorization);
      window.addEventListener('iceclass-classes-changed', refreshAuthorization);
      queueMicrotask(() => { if (!disposed) { client.open(); post('ready'); } });
    }
    paint('off');
    const controller = {
      context: () => ({mode:'voice', ...(binding ? {deviceId:binding.deviceId, classId:binding.classId} : {})}),
      hide: () => post('hide'),
      begin: mode => {
        working = true; voiceTurn = mode === 'voice';
        speechStream = null; streamed = false; streamEnded = false;
        if (voiceTurn) work('thinking');
        else { generation++; inputSequence++; stopSpeech(); prompt = null; operations.clear(); prompted.clear(); }
      },
      event: event => {
        if (!voiceTurn || !enabled || !active) return;
        if (event.type === 'operation') observe(event.operation);
        if (event.type === 'confirmation') work(event.waiting ? 'confirming' : 'thinking');
        if (event.type === 'speech') sentence(event);
        if (event.type === 'done') {
          if (!prompt && !streamed) say(event.message.content);
        }
      },
      failed: message => { if (voiceTurn) say(message); },
      settled: () => {
        working = false;
        if (streamed && !streamEnded) interruptSpeech();
        if (enabled && active) work(prompt ? 'confirming' : 'listening');
      },
      dispose: () => {
        if (disposed) return;
        post('logout'); stopSpeech();
        if (working || operations.size) { void client.interrupt().catch(() => {}); void window.ICeClassBanbanOperations.cancelVoice([...operations.keys()]).catch(() => {}); }
        disposed = true; enabled = active = false; generation++; inputSequence++;
        input.placeholder = inputPlaceholder;
        clearInterval(timer); clearTimeout(startTimeout); clearTimeout(restart); recognition?.abort(); recognition = null;
        window.removeEventListener('banban-operation-updated', updated); window.removeEventListener('offline', offline);
        document.removeEventListener('visibilitychange', visibility);
        if (native) {
          window.chrome.webview.removeEventListener('message', nativeEvent);
          window.removeEventListener('iceclass-ready', refreshAuthorization);
          window.removeEventListener('iceclass-classes-changed', refreshAuthorization);
        }
        mic.removeEventListener('click', toggle); mic.remove(); operations.clear();
        if (current === controller) current = null;
      }
    };
    current = controller; return controller;
  }
  window.ICeClassBanbanVoice = {mount};
})();

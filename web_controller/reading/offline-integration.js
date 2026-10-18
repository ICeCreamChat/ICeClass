/* The native host owns durable storage and credentials; activities never wait for the network. */
(() => {
  'use strict';
  if (!window.ICeClassDesktop?.offline) return;
  const pending = new Map(), sessions = new Map();
  let snapshot = {}, anchor = Date.now(), anchoredAt = performance.now(), current, lastSecond = -1;
  let seconds = 0, leaving = false, busy = false, diskError = '', status, clockLabel, classLabel;
  window.chrome.webview.addEventListener('message', event => {
    const message = event.data;
    if (message?.type !== 'reading-local-reply') return;
    const request = pending.get(message.requestId);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.requestId);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.data);
  });
  function rpc(action, payload) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('本机保存未确认，正在重试')); }, 5000);
      pending.set(requestId, { resolve, reject, timer });
      window.chrome.webview.postMessage({ type: 'reading-local', requestId, action, payload });
    });
  }
  const now = () => Math.round(anchor + performance.now() - anchoredAt);
  function update(data) {
    snapshot = data;
    if (data.config) window.ReadingIntegration.settings = data.config;
    if (data.serverTime) { anchor = data.serverTime; anchoredAt = performance.now(); }
    if (classLabel) classLabel.textContent = data.className || '本班早读';
  }
  const state = () => { try { return window.ReadingMonitor?.getState() || { active: false }; } catch { return { active: false }; } };
  const inPeriod = at => {
    const config = window.ReadingIntegration.settings, local = new Date(at + 8 * 3600000);
    const day = local.getUTCDay() || 7, minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    return config.enabled && config.periods.some(p => p.weekdays.includes(day) && minute >= p.start && minute < p.end);
  };
  function getSession(sample) {
    const key = sample.mode + ':' + sample.run;
    if (!sessions.has(key)) {
      const at = now();
      sessions.set(key, { id: crypto.randomUUID(), mode: sample.mode, startedAt: at, samples: [], events: [] });
    }
    const session = sessions.get(key);
    if (current !== session) { current = session; seconds = 0; lastSecond = -1; }
    return session;
  }
  async function saveSession(session) {
    // Retain the exact batch (including its id) when a disk ACK is lost or delayed.
    if (!session.batch && (session.samples.length || session.events.length)) session.batch = {
      id: crypto.randomUUID(), sessionId: session.id, mode: session.mode, startedAt: session.startedAt,
      samples: session.samples.slice(0, 90), events: session.events.slice(0, 100)
    };
    if (!session.batch) return;
    const batch = session.batch;
    update(await rpc('store', batch));
    session.samples.splice(0, batch.samples.length); session.events.splice(0, batch.events.length);
    session.batch = null; diskError = '';
  }
  async function saveAll() {
    if (busy) return;
    busy = true;
    try { for (const session of sessions.values()) await saveSession(session); }
    catch (error) { diskError = error.message; }
    finally { busy = false; render(); }
  }
  function render() {
    if (!status) return;
    const sample = state();
    const label = diskError || (snapshot.reviewCount ? `有 ${snapshot.reviewCount} 组记录待管理员核实` : snapshot.revoked ? '绑定已停用 · 记录留在本机'
      : !snapshot.hasRules ? '活动可离线使用 · 首次联网后确认统计规则'
      : !snapshot.online ? `离线可用 · ${snapshot.pendingCount || 0} 组记录待补传`
      : snapshot.pendingCount ? `已保存到本机 · ${snapshot.pendingCount} 组待同步`
      : !inPeriod(now()) ? '当前不在统计时段 · 已同步'
      : sample.active ? '正在记录 · 已同步' : '早读就绪 · 已同步');
    status.textContent = label;
    clockLabel.textContent = `本次达标约 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    document.getElementById('reading-session-status').dataset.warning = String(!!diskError || !!snapshot.reviewCount || !!snapshot.revoked);
  }
  function tick() {
    const sample = state();
    if (!leaving && !document.hidden && sample.active) {
      const session = getSession(sample), at = now(), second = Math.floor(at / 1000);
      if (second !== lastSecond) {
        lastSecond = second;
        const volume = Math.max(0, Math.min(100, Number(sample.volume) || 0));
        session.samples.push({ at, volume, active: true });
        if (inPeriod(at) && volume >= window.ReadingIntegration.settings.threshold) ++seconds;
        void saveAll();
      }
    }
    render();
  }
  window.ReadingIntegration = {
    settings: { enabled: false, threshold: 30, periods: [], classic: { duration: 15, targetCount: 10 }, rocket: { duration: 15, targetCount: 10 }, carving: { speed: 1 }, particle: { speed: 1 } },
    connectionReady: true,
    async flushNow() {
      leaving = true;
      // Network uploads run in the native background worker. Exit waits only for local disk writes.
      while (busy) await new Promise(resolve => setTimeout(resolve, 10));
      for (const session of sessions.values()) {
        while (session.samples.length || session.events.length || session.batch) await saveSession(session);
      }
    },
    completed(kind, title) {
      if (leaving || document.hidden) return;
      const sample = state();
      if (!['classic', 'carving', 'particle', 'rocket'].includes(sample.mode)) return;
      const event = { id: crypto.randomUUID(), at: now(), kind, title: String(title || '').slice(0, 100) };
      // A short activity can finish before the first sampling tick observes it running.
      getSession(sample).events.push(event); void saveAll();
    }
  };
  async function init() {
    const panel = document.createElement('div'); panel.id = 'reading-session-status';
    classLabel = document.createElement('strong'); status = document.createElement('span'); status.setAttribute('role', 'status');
    clockLabel = document.createElement('span'); clockLabel.setAttribute('aria-live', 'off');
    panel.append(classLabel, status, clockLabel); document.body.append(panel);
    try { update(await rpc('bootstrap')); }
    catch (error) { diskError = error.message; }
    document.body.classList.remove('reading-loading');
    window.ICeClassDesktop.send('reading-ready');
    render();
    setInterval(tick, 250);
    setInterval(() => { if (!leaving) void saveAll(); }, 1000);
    setInterval(async () => { if (!leaving) { try { update(await rpc('status')); } catch { } render(); } }, 5000);
    document.addEventListener('visibilitychange', () => { if (document.hidden) void saveAll(); });
    window.addEventListener('pagehide', () => { leaving = true; void saveAll(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
  else void init();
})();

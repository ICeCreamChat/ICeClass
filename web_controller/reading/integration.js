(() => {
  'use strict';
  const defaults = { threshold: 30, enabled: false, periods: [], classic: { duration: 15, targetCount: 10 }, rocket: { duration: 15, targetCount: 10 }, carving: { speed: 1 }, particle: { speed: 1 } };
  let connected = false, preview = false, offset = 0, current = null, starting = false, leaving = false;
  let status, clockLabel, localSeconds = 0, lastSecond = -1, waitingEvents = [], lastError = '';
  async function request(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error || '连接暂时中断。'), { status: response.status });
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('连接超时，请检查网络后重试。');
      if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('暂时连接不上平台，请检查网络后重试。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  const api = async (path, body) => {
    const data = await request('/api/reading/' + path, body);
    if (data.serverTime) offset = data.serverTime - Date.now();
    if (data.config) window.ReadingIntegration.settings = data.config;
    return data;
  };
  const now = () => Date.now() + offset;
  const inPeriod = () => {
    const config = window.ReadingIntegration.settings, local = new Date(now() + 8 * 3600000);
    const day = local.getUTCDay() || 7, minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    return config.enabled && config.periods.some(p => p.weekdays.includes(day) && minute >= p.start && minute < p.end);
  };
  const state = () => {
    try { return window.ReadingMonitor?.getState() || { active: false, mode: 'home' }; }
    catch { return { active: false, mode: 'home' }; }
  };
  window.ReadingIntegration = {
    settings: defaults,
    async flushNow() {
      leaving = true;
      if (current?.pending) await current.pending;
      if (current) await flush(current);
    },
    completed(kind, title) {
      if (!connected || preview || document.hidden) return;
      const sample = state();
      const event = { id: crypto.randomUUID(), at: now(), kind, title };
      const key = sample.mode + ':' + sample.run;
      if (current?.key === key) { current.events.push(event); void flush(current); }
      else waitingEvents.push({ key, event });
    }
  };
  function flush(session) {
    if (session?.pending) return session.pending;
    const work = sendBatch(session);
    if (session) session.pending = work.finally(() => { session.pending = null; });
    return session?.pending || work;
  }
  async function sendBatch(session) {
    if (!session || session.busy || (!session.samples.length && !session.events.length)) return;
    session.busy = true;
    const samples = session.samples.splice(0, 90), events = session.events.splice(0, 100);
    try {
      await api('device/pulse', { sessionId: session.id, samples, events });
      lastError = '';
    } catch (error) {
      lastError = error.message;
      session.samples.unshift(...samples); session.events.unshift(...events);
      session.samples = session.samples.filter(s => s.at >= now() - 85000).slice(-90);
      session.events = session.events.filter(e => e.at >= now() - 85000).slice(-100);
      if (error.status === 401) connected = false;
    } finally { session.busy = false; }
  }
  function updateStatus(sample) {
    if (!status) return;
    const label = preview ? '预览 · 活动不计入成绩' : !connected ? (lastError || '请从已绑定的教室端打开，活动才能计入本班成绩')
      : lastError ? '连接中断，正在重试统计上报' : !inPeriod() ? '当前不在早读统计时段' : !sample.active ? '统计时段内 · 等待开始或继续'
      : sample.volume >= window.ReadingIntegration.settings.threshold ? '统计中 · 声量达标' : '统计中 · 等待声量达标';
    if (status.textContent !== label) status.textContent = label;
    clockLabel.textContent = `本次有效 ${Math.floor(localSeconds / 60)} 分 ${localSeconds % 60} 秒`;
    document.getElementById('reading-session-status').dataset.warning = String(!connected && !preview || !!lastError);
  }
  async function tick() {
    const sample = state();
    updateStatus(sample);
    if (leaving || !connected || preview || document.hidden || !sample.active) return;
    const key = sample.mode + ':' + sample.run;
    if (current?.key !== key) {
      if (starting) return;
      starting = true;
      if (current) await flush(current);
      try {
        const data = await api('device/sessions', { mode: sample.mode });
        current = { key, id: data.sessionId, samples: [], events: waitingEvents.filter(e => e.key === key).map(e => e.event), busy: false };
        waitingEvents = waitingEvents.filter(e => e.key !== key);
        localSeconds = 0; lastSecond = -1; lastError = '';
      } catch (error) { lastError = error.message; }
      finally { starting = false; }
    }
    if (leaving || !current || current.key !== key) return;
    const at = now(), second = Math.floor(at / 1000);
    if (second === lastSecond) return;
    lastSecond = second;
    current.samples.push({ at, volume: Math.max(0, Math.min(100, Number(sample.volume) || 0)), active: true });
    if (inPeriod() && sample.volume >= window.ReadingIntegration.settings.threshold) ++localSeconds;
    if (current.samples.length >= 5) void flush(current);
    updateStatus(sample);
  }
  async function init() {
    if (document.getElementById('reading-session-status')) return;
    const panel = document.createElement('div'); panel.id = 'reading-session-status';
    const classLabel = document.createElement('strong'); status = document.createElement('span'); status.setAttribute('role', 'status');
    clockLabel = document.createElement('span'); clockLabel.setAttribute('aria-live', 'off');
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新连接'; retry.hidden = true;
    panel.append(classLabel, status, clockLabel, retry); document.body.append(panel);
    const fragment = new URLSearchParams(location.hash.slice(1)), ticket = fragment.get('launch');
    history.replaceState(null, '', location.pathname + location.search);
    preview = new URLSearchParams(location.search).get('preview') === '1';
    let connecting = false, first = true;
    async function connect() {
      if (connecting || leaving) return;
      connecting = true; retry.disabled = true;
      status.textContent = '正在连接本班…';
      try {
        // A timed-out ticket may already have established the device cookie.
        let data;
        if (preview) data = await previewSettings();
        else if (first && ticket) data = await api('device/connect', { launchToken: ticket });
        else {
          try { data = await api('device/settings'); }
          catch (error) { if (error.status !== 401 || !ticket) throw error; data = await api('device/connect', { launchToken: ticket }); }
        }
        if (!window.ReadingMonitor) throw new Error('活动页面未能载入，请重新打开。');
        if (data.config) window.ReadingIntegration.settings = data.config;
        if (data.serverTime) offset = data.serverTime - Date.now();
        connected = !preview; lastError = ''; classLabel.textContent = preview ? '早读预览' : data.className;
        retry.hidden = true;
        window.ICeClassDesktop?.send('reading-ready');
      } catch (error) {
        connected = false; lastError = error.message; classLabel.textContent = '连接未完成'; retry.hidden = false;
        window.ICeClassDesktop?.send('reading-error');
      } finally {
        first = false; connecting = false; retry.disabled = false;
        document.body.classList.remove('reading-loading');
        window.ReadingIntegration.connectionReady = connected || preview && !lastError;
        updateStatus(state());
      }
    }
    retry.addEventListener('click', () => {
      if (window.ICeClassDesktop?.connectionHandshake) window.ICeClassDesktop.send('reading-retry');
      else void connect();
    });
    await connect();
    state(); updateStatus(state());
    setInterval(() => void tick(), 250);
    setInterval(() => { if (current) void flush(current); }, 5000);
    setInterval(async () => {
      if (preview || connecting || !connected) return;
      try { const data = await api('device/settings'); connected = true; classLabel.textContent = data.className; lastError = ''; }
      catch (error) { lastError = error.message; if (error.status === 401) { connected = false; retry.hidden = false; } }
    }, 15000);
    window.addEventListener('pagehide', () => {
      if (current && connected) {
        const body = JSON.stringify({ sessionId: current.id, samples: current.samples, events: current.events });
        void fetch('/api/reading/device/pulse', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
      }
    });
  }
  async function previewSettings() {
    const session = await request('/api/session');
    if (!session.authenticated) throw new Error('请先登录班伴再打开预览。');
    if (session.user.role !== 'superadmin') return {config:defaults};
    return request('/api/reading/settings');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
  else void init();
})();

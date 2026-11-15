export async function loadPreparationPage(revision) {
  const { preparationProgress } = await import('./preparation-progress.js?load=' + revision);
  return () => {
    const params = new URLSearchParams(location.hash.slice(1)), storageKey = 'videobooth-preparation-return';
    let envelope, working = false;
    try {
      if (params.get('session') && params.get('payload')) {
        envelope = { sessionId: params.get('session'), payload: params.get('payload'), startedAt: Date.now() };
        sessionStorage.setItem(storageKey, JSON.stringify(envelope));
        history.replaceState(null, '', location.pathname);
      } else envelope = JSON.parse(sessionStorage.getItem(storageKey));
    } catch (_) { /* Show a useful failure below instead of a blank page. */ }
    const progress = preparationProgress(envelope?.startedAt || Date.now());
    async function readJson(uri, options = {}) {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(uri, { ...options, cache: 'no-store', signal: controller.signal });
        if (!response.ok) {
          const error = new Error(response.status === 400 || response.status === 401
            ? '本次连接已失效，请扫描电脑当前的第 2 张码。' : '电脑暂时未响应，正在自动恢复连接。');
          error.transient = response.status >= 500 || response.status === 408;
          throw error;
        }
        return await response.json();
      } catch (error) {
        if (error.name === 'TypeError' || error.name === 'AbortError') error.transient = true;
        throw error;
      } finally { clearTimeout(timeout); }
    }
    async function connect() {
      if (working) return;
      working = true; document.getElementById('preparationRetry').hidden = true;
      try {
        if (!envelope || !/^[a-f0-9]{32}$/.test(envelope.sessionId || '') || !envelope.payload
          || Date.now() - envelope.startedAt >= 15 * 60000) throw new Error('本次连接已失效，请扫描电脑当前的第 2 张码。');
        for (let attempt = 0; ; attempt++) {
          try {
            progress.set('准备已完成，正在打开摄像头…', 3);
            const result = await readJson('/api/phone-preparation/complete', { method: 'POST',
              headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: envelope.sessionId, payload: envelope.payload }) });
            const phone = new URL(result.phoneUrl);
            if (phone.protocol !== 'https:') throw new Error('连接地址不可用，请重新扫码。');
            // Verify real browser TLS and DNS before leaving this recoverable local page.
            const verify = new URL(phone); verify.pathname = '/api/verify-phone';
            if (!(await readJson(verify, { method: 'POST' })).ready) throw new Error('连接尚未准备完成。');
            sessionStorage.removeItem(storageKey);
            location.replace(phone.href); return;
          } catch (error) {
            if (!error.transient || attempt >= 4) throw error;
            await progress.wait([1000, 2000, 5000, 10000][attempt], '正在恢复摄像头连接');
          }
        }
      } catch (error) { progress.fail(error.transient ? '暂时无法打开摄像头，请保持展台 Wi-Fi，点“重试连接”。' : error.message); }
      finally { working = false; }
    }
    document.getElementById('preparationRetry').onclick = connect;
    window.addEventListener('pagehide', () => progress.stop());
    connect();
  };
}

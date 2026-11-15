export async function loadPreparationPage(revision) {
  const [{ decode, prepare }, { preparationProgress }] = await Promise.all([
    import('./preparation-client.js?load=' + revision), import('./preparation-progress.js?load=' + revision)
  ]);
  return () => {
    const status = document.getElementById('preparationStatus'), retry = document.getElementById('preparationRetry');
    let retryAt = 0, working = false, failures = 0, progress = null;
    function stateKey(id) { return 'videobooth-phone-preparation-' + id; }
    function bootstrapState(value) {
      const bootstrap = JSON.parse(new TextDecoder().decode(decode(value)));
      const uri = new URL(bootstrap.returnUrl), bytes = uri.hostname.split('.').map(Number);
      const local = bytes.length === 4 && bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
        && (bytes[0] === 10 || bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31 || bytes[0] === 192 && bytes[1] === 168 || uri.hostname === '127.0.0.1');
      if (!/^[a-f0-9]{32}$/.test(bootstrap.sessionId || '') || decode(bootstrap.key).length !== 32 || !local
        || uri.protocol !== 'http:' || uri.username || uri.password || uri.search || uri.hash || uri.pathname !== '/phone-preparation/return')
        throw new Error('二维码不可用，请扫描电脑当前的第 2 张码。');
      return bootstrap;
    }
    async function run() {
      if (working) return;
      working = true;
      retry.hidden = true;
      try {
        if (!crypto.subtle) throw new Error('请用系统相机重新扫码，在 Safari 或 Chrome 中打开。');
        const hash = new URLSearchParams(location.hash.slice(1)), encoded = hash.get('bootstrap');
        if (encoded) {
          const bootstrap = bootstrapState(encoded);
          const startedAt = Date.now();
          sessionStorage.setItem(stateKey(bootstrap.sessionId), JSON.stringify({ bootstrap, startedAt }));
          progress = preparationProgress(startedAt);
          progress.set('正在连接这台展台…', 1);
          history.replaceState(null, '', location.pathname);
          const relay = new URL(bootstrap.returnUrl); relay.pathname = '/phone-preparation/relay'; relay.searchParams.set('session', bootstrap.sessionId);
          location.replace(relay.href); return;
        }
        const envelope = JSON.parse(document.getElementById('preparationRelay').textContent);
        if (!envelope || !/^[a-f0-9]{32}$/.test(envelope.sessionId || '')) throw new Error('请重新扫描电脑当前的第 2 张码。');
        const saved = sessionStorage.getItem(stateKey(envelope.sessionId));
        if (!saved) throw new Error('当前浏览器未保留连接状态，请用系统相机重新扫码，在 Safari 或 Chrome 中打开。');
        const state = JSON.parse(saved), bootstrap = state.bootstrap || state;
        const startedAt = state.startedAt || Date.now();
        if (Date.now() - startedAt >= 15 * 60000) throw new Error('本次连接已超时，请扫描电脑当前的第 2 张码。');
        if (!progress) progress = preparationProgress(startedAt);
        progress.set('已连到展台，正在自动准备…', 1);
        const payload = await prepare(bootstrap, envelope.payload, progress.set, progress);
        // Keep bootstrap state until delivery: a transient return failure must not discard it.
        const destination = new URL(bootstrap.returnUrl);
        destination.hash = new URLSearchParams({ session: bootstrap.sessionId, payload }).toString();
        location.replace(destination.href);
      } catch (error) {
        if (progress?.signal.aborted) return;
        const message = error.name === 'OperationError' ? '连接信息未通过检查，请重新扫描电脑当前的二维码。'
          : error.message || '暂时无法连接。请保持手机联网和展台 Wi-Fi 后重试。';
        retryAt = Date.now() + (error.retryAfter || 0);
        if (error.transient && failures++ < 2 && progress) {
          try {
            await progress.wait(Math.max(error.retryAfter || 0, 10000), message);
            setTimeout(run, 0);
          } catch (waitingError) { if (!progress.signal.aborted) progress.fail(waitingError.message); }
        } else if (progress) progress.fail(message); else { status.textContent = message; retry.hidden = false; }
      } finally { working = false; }
    }
    retry.onclick = () => {
      if (Date.now() < retryAt) { status.textContent = '准备服务繁忙，请稍后再重试。'; return; }
      run();
    };
    window.addEventListener('pagehide', () => progress?.stop());
    run();
  };
}

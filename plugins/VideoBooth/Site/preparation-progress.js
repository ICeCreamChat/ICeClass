export function preparationProgress(startedAt = Date.now()) {
  const status = document.getElementById('preparationStatus');
  const elapsed = document.getElementById('preparationElapsed');
  const retry = document.getElementById('preparationRetry');
  const cancellation = new AbortController(), expiresAt = startedAt + 15 * 60000;
  let waitingUntil = 0, waitingText = '', stopped = false;
  function render() {
    if (elapsed) {
      const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      elapsed.textContent = seconds < 60 ? '已等待 ' + seconds + ' 秒' : '已等待 ' + Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒';
    }
    if (waitingUntil) status.textContent = waitingText + '，' + Math.max(0, Math.ceil((waitingUntil - Date.now()) / 1000)) + ' 秒后自动重试。';
  }
  const timer = setInterval(render, 1000);
  render();
  const set = (message, step) => {
    waitingUntil = 0; status.textContent = message;
    document.querySelectorAll('[data-preparation-step]').forEach(item => {
      const current = Number(item.dataset.preparationStep);
      item.classList.toggle('complete', current < step);
      item.classList.toggle('active', current === step);
      if (current === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    });
  };
  return {
    set,
    signal: cancellation.signal,
    async wait(milliseconds, message, signal = cancellation.signal) {
      const until = Date.now() + milliseconds;
      waitingUntil = until; waitingText = message; render();
      while (!stopped && !signal.aborted && Date.now() < until && Date.now() < expiresAt)
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, until - Date.now(), expiresAt - Date.now())));
      if (stopped || signal.aborted) throw Object.assign(new Error('页面已离开，请重新打开。'), { name: 'AbortError' });
      if (Date.now() >= expiresAt) throw new Error('本次连接已超时，请扫描电脑当前的第 2 张码。');
      if (waitingUntil === until) { waitingUntil = 0; status.textContent = '正在恢复连接…'; }
    },
    stop() { stopped = true; cancellation.abort(); clearInterval(timer); },
    fail(message) { set(message); if (retry) retry.hidden = false; }
  };
}

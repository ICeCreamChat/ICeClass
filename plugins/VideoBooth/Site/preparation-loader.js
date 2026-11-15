(() => {
  const script = document.currentScript;
  const main = script.dataset.main, directory = new URL('.', script.src);
  const status = document.getElementById('preparationStatus'), retry = document.getElementById('preparationRetry');
  const elapsed = document.getElementById('preparationElapsed'), startedAt = Date.now();
  let loading = false, attempt = 0, stopped = false, nextLoad = 0;
  const clock = setInterval(() => {
    if (elapsed) elapsed.textContent = '已等待 ' + Math.floor((Date.now() - startedAt) / 1000) + ' 秒';
  }, 1000);
  function load() {
    if (loading || stopped) return;
    loading = true; retry.hidden = true;
    const revision = attempt++;
    let active = true;
    // Imports cannot be aborted. Expired loads may finish, but cannot start the page.
    const timeout = setTimeout(() => failed(), 12000);
    function failed(error) {
      if (!active || stopped) return;
      active = false; loading = false; clearTimeout(timeout);
      if (error && error.name === 'SyntaxError') {
        status.textContent = '当前浏览器无法打开连接页面，请用 Chrome 或 Safari 重新扫码。';
        retry.hidden = false; return;
      }
      status.textContent = '连接页面暂时未加载完整，正在自动重新加载…';
      if (attempt < 4) nextLoad = setTimeout(load, [2000, 5000, 10000][attempt - 1]);
      else { status.textContent = '连接页面未加载完整，请保持手机联网，再点“重试连接”。'; retry.hidden = false; }
    }
    import(new URL(main + '?load=' + revision, directory))
      .then(module => active && !stopped ? module.loadPreparationPage(revision) : null)
      .then(start => {
        if (!active || stopped) return;
        try { start(); } catch (error) { failed(error); return; }
        active = false; loading = false; clearTimeout(timeout); clearInterval(clock);
        retry.removeEventListener('click', load);
      }, failed);
  }
  window.addEventListener('pagehide', () => { stopped = true; clearInterval(clock); clearTimeout(nextLoad); });
  retry.addEventListener('click', load);
  load();
})();

(() => {
  "use strict";
  if (window.top !== window || location.origin !== __SCHOOL_ORIGIN__) return;
  const successes = new Map();
  let sent = 0, interval = performance.now();
  function safeUrl(value) {
    try {
      if (!value || !(typeof value === "string" || value instanceof URL)) return "";
      const url = new URL(value, location.href);
      if (url.origin !== location.origin || url.username || url.password) return "";
      return url.origin + url.pathname + (/^#[A-Za-z0-9_/-]{0,80}$/.test(url.hash) ? url.hash : "");
    } catch { return ""; }
  }
  function emit(kind, name, extra = {}) {
    try {
      const now = performance.now();
      if (now - interval >= 10000) { interval = now; sent = 0; }
      if (sent++ >= 100) return;
      window.chrome.webview.postMessage({type: "iceclass-diagnostic", kind, name, url: safeUrl(location.href), ...extra});
    } catch { /* Diagnostics must not interrupt the workbench. */ }
  }
  const originalFetch = window.fetch;
  window.fetch = async function(input, options) {
    const url = safeUrl(typeof input === "string" || input instanceof URL ? input : input?.url);
    const method = String(options?.method || input?.method || "GET").toUpperCase();
    if (!url || !new URL(url).pathname.startsWith("/api/")) return originalFetch.apply(this, arguments);
    const started = performance.now();
    try {
      const response = await originalFetch.apply(this, arguments);
      const duration = performance.now() - started, key = method + " " + url;
      if (!response.ok || method !== "GET" || duration >= 1000 || started - (successes.get(key) ?? -Infinity) >= 30000) {
        emit("request", method, {url, status: response.status, duration});
        if (successes.size >= 128) successes.clear();
        successes.set(key, started);
      }
      return response;
    } catch (error) {
      emit("request", method, {url, status: 0, duration: performance.now() - started,
        detail: error?.name === "AbortError" ? "cancelled" : navigator.onLine ? "network-failure" : "offline"});
      throw error;
    }
  };
  const labels = new Set(["登录", "进入工作台", "查询", "刷新", "保存", "保存并下发", "预览浮岛", "编辑作息时间", "重新载入", "复制到其他班级", "导入 Excel", "导出 Excel", "导出 XLSX", "收听", "停止", "转文字", "上一条", "下一条", "发送通知", "确认发送", "取消", "完成", "创建班级", "创建用户", "修改密码"]);
  document.addEventListener("click", event => {
    const control = event.target?.closest?.("button");
    if (!control) return;
    const label = control.textContent?.trim().replace(/\s+/g, " ");
    if (labels.has(label)) emit("action", label);
  }, true);
  window.addEventListener("hashchange", () => emit("action", "切换页面"));
  window.addEventListener("online", () => emit("connection", "online"));
  window.addEventListener("offline", () => emit("connection", "offline"));
  window.addEventListener("error", event => {
    const source = safeUrl(event.filename || event.target?.src || event.target?.href);
    const name = /^[A-Za-z][A-Za-z0-9]{0,50}$/.test(event.error?.name) ? event.error.name : "ResourceError";
    if (source) emit("javascript", name, {detail: source + ":" + (event.lineno || 0) + ":" + (event.colno || 0)});
  }, true);
  window.addEventListener("unhandledrejection", event => {
    const name = /^[A-Za-z][A-Za-z0-9]{0,50}$/.test(event.reason?.name) ? event.reason.name : "UnhandledRejection";
    emit("javascript", name);
  });
  if (typeof PerformanceObserver === "function") {
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) if (entry.duration >= 200)
          emit("performance", "long-task", {duration: entry.duration});
      }).observe({type: "longtask", buffered: true});
    } catch { /* Older runtimes can still report requests and errors. */ }
  }
  emit("connection", navigator.onLine ? "online" : "offline");
})();

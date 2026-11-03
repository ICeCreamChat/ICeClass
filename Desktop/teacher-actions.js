(() => {
  "use strict";
  if (window.top !== window || location.origin !== __SCHOOL_ORIGIN__ || !window.chrome?.webview) return;
  const transport = window.chrome.webview, clientId = crypto.randomUUID();
  const pending = new Map(), operations = new Map();
  const limit = 256, timeoutMs = 90000;
  let active = true;
  const refused = (code, detail) => ({success: false, verified: false, state: "rejected", code, detail});
  const validId = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
  const failure = method => method === "catalog"
    ? {clientId, actions: [], code: "host-unavailable", detail: "本机能力暂不可用，请检查教师端窗口。"}
    : refused("host-unavailable", "本机操作结果尚未确认，请检查教师端窗口。请勿自动重试。");
  const current = () => active && window.top === window && location.origin === __SCHOOL_ORIGIN__;

  function request(method, extra = {}) {
    if (!current() || pending.size >= limit) return Promise.resolve(failure(method));
    const requestId = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(requestId); resolve(failure(method));
      }, timeoutMs);
      pending.set(requestId, {method, resolve, timer});
      try { transport.postMessage({type: "iceclass-teacher-action", requestId, clientId, method, ...extra}); }
      catch {
        clearTimeout(timer); pending.delete(requestId); resolve(failure(method));
      }
    });
  }
  transport.addEventListener("message", event => {
    const reply = event.data;
    if (!current() || !reply || reply.type !== "iceclass-teacher-action-result" || reply.clientId !== clientId) return;
    const item = pending.get(reply.requestId);
    if (!item) return;
    const result = reply.result;
    const valid = item.method === "catalog"
      ? result?.clientId === clientId && Array.isArray(result.actions)
      : typeof result?.success === "boolean" && typeof result.verified === "boolean" && typeof result.detail === "string";
    if (!valid) return;
    pending.delete(reply.requestId); clearTimeout(item.timer); item.resolve(result);
  });
  window.addEventListener("pagehide", () => {
    active = false;
    for (const item of pending.values()) { clearTimeout(item.timer); item.resolve(failure(item.method)); }
    pending.clear();
  }, {once: true});

  async function execute(action, payload, operationId) {
    if (!current()) return failure("execute");
    if (typeof action !== "string" || action.length > 80 || !validId(operationId))
      return refused("invalid-request", "本机操作名称或编号无效。");
    let copy, fingerprint;
    try {
      if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(payload)))
        return refused("invalid-fields", "本机操作参数必须是普通对象。");
      const text = JSON.stringify(payload);
      if (typeof text !== "string" || text.length > 4096) return refused("invalid-fields", "本机操作参数无效。");
      copy = JSON.parse(text);
      if (!copy || typeof copy !== "object" || Array.isArray(copy)) return refused("invalid-fields", "本机操作参数无效。");
      fingerprint = JSON.stringify([action, copy]);
    } catch { return refused("invalid-fields", "本机操作参数无效。"); }
    const previous = operations.get(operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return refused("operation-conflict", "此操作编号已用于另一请求，不能重新执行。");
      // Once settled, only ask for a receipt. The host rechecks login without retrying an action.
      return previous.finished ? request("receipt", {action, payload: copy, operationId}) : previous.promise;
    }
    if (operations.size >= limit) return refused("operation-limit", "此页面的本机操作记录已满，请保存内容后重新打开页面。");
    const operation = {fingerprint, finished: false};
    operation.promise = request("execute", {action, payload: copy, operationId}).then(result => {
      operation.finished = true; return result;
    });
    operations.set(operationId, operation);
    return operation.promise;
  }
  Object.defineProperty(window, "ICeClassTeacherHost", {
    value: Object.freeze({clientId, catalog: async () => request("catalog"), execute}),
    configurable: false, writable: false
  });
})();

"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const origin = "https://school.example";
const source = fs.readFileSync(path.join(__dirname, "../Desktop/teacher-actions.js"), "utf8")
  .replaceAll("__SCHOOL_ORIGIN__", JSON.stringify(origin));
let checks = 0;
function check(condition, label) { assert.ok(condition, label); checks++; }
function host({iframe = false, foreign = false, transport = true, respond} = {}) {
  const messages = [], listeners = new Map(), events = new Map(), timers = new Map();
  let timerId = 0;
  const webview = {
    postMessage(message) { messages.push(message); if (respond) respond(message, reply); },
    addEventListener(name, handler) { listeners.set(name, handler); }
  };
  const window = {
    chrome: transport ? {webview} : undefined,
    addEventListener(name, handler) { events.set(name, handler); }
  };
  window.top = iframe ? {} : window;
  const context = vm.createContext({window, location: {origin: foreign ? "https://attacker.example" : origin}, crypto,
    setTimeout(handler) { timers.set(++timerId, handler); return timerId; }, clearTimeout(id) { timers.delete(id); }});
  function reply(message, result, extra = {}) {
    listeners.get("message")?.({data: {type: "iceclass-teacher-action-result", requestId: message.requestId,
      clientId: message.clientId, result, ...extra}});
  }
  vm.runInContext(source, context);
  return {window, messages, timers, reply, run: text => vm.runInContext(text, context),
    hide: () => events.get("pagehide")?.(),
    timeout: () => { const entry = timers.entries().next().value; if (entry) { timers.delete(entry[0]); entry[1](); } }};
}
const opened = {success: true, verified: true, state: "opened", detail: "已打开，尚未保存。"};

(async () => {
  for (const options of [{iframe: true}, {foreign: true}, {transport: false}])
    check(host(options).window.ICeClassTeacherHost === undefined, "Only trusted top-level WebView documents receive the API");
  const h = host();
  const api = h.window.ICeClassTeacherHost;
  check(h.messages.length === 0, "Injection never executes historical work or requests a catalog automatically");
  check(Object.isFrozen(api) && /^[0-9a-f-]{36}$/.test(api.clientId), "The API and per-document client ID are immutable");
  check(host().window.ICeClassTeacherHost.clientId !== api.clientId, "Every document gets a fresh client ID");
  const catalogPromise = api.catalog();
  check(typeof catalogPromise.then === "function", "Catalog is asynchronous across the document boundary");
  const catalogRequest = h.messages[0];
  const catalog = {clientId: api.clientId, actions: [{id: "teacher.about", title: "关于", fields: [], confirmation: false}]};
  h.reply(catalogRequest, catalog, {clientId: crypto.randomUUID()});
  check(h.timers.size === 1, "A reply from another document cannot settle a request");
  h.reply(catalogRequest, catalog, {requestId: crypto.randomUUID()});
  check(h.timers.size === 1, "An unrelated request ID cannot settle a request");
  h.reply(catalogRequest, catalog);
  check((await catalogPromise).actions[0].id === "teacher.about" && h.timers.size === 0, "Catalog preserves registered fields and clears its timeout");

  const first = h.run('window.ICeClassTeacherHost.execute("teacher.about", {}, "same-operation")');
  const duplicate = h.run('window.ICeClassTeacherHost.execute("teacher.about", {}, "same-operation")');
  check(h.messages.length === 2, "Concurrent duplicate execute calls post one action message");
  h.reply(h.messages[1], opened);
  check((await first).state === "opened" && (await duplicate).state === "opened", "Both callers receive an opened receipt without implying saved");
  const receipt = h.run('window.ICeClassTeacherHost.execute("teacher.about", {}, "same-operation")');
  check(h.messages[2].method === "receipt", "A completed duplicate only reads a receipt and cannot retry the action");
  h.reply(h.messages[2], {success: false, verified: false, state: "rejected", code: "sign-in-required", detail: "请登录"});
  check((await receipt).code === "sign-in-required", "A cached operation cannot bypass a later sign-out");
  const beforeConflict = h.messages.length;
  check((await h.run('window.ICeClassTeacherHost.execute("teacher.refresh", {}, "same-operation")')).code === "operation-conflict",
    "Reusing an operation ID with different arguments is refused");
  check(h.messages.length === beforeConflict, "Conflicting operations never reach native code");
  for (const expression of ["null", "[]", '"text"', "42", "new Date()", "{get x() {throw new Error('password=secret-input')}}",
      "(() => {const value = {}; value.self = value; return value})()", '({large: "x".repeat(4097)})', "{toJSON() {return []}}"])
    check((await h.run(`window.ICeClassTeacherHost.execute("teacher.about", ${expression}, "invalid-payload")`)).code === "invalid-fields",
      "Invalid or secret-throwing payloads return a safe failure");
  check((await h.run('window.ICeClassTeacherHost.execute("teacher.about", {}, "x".repeat(129))')).code === "invalid-request", "Operation IDs are bounded");
  check((await h.run('window.ICeClassTeacherHost.execute("teacher.about", {}, "bad id")')).code === "invalid-request", "Operation IDs cannot contain arbitrary text");
  const unknown = h.run('window.ICeClassTeacherHost.execute("teacher.unknown", {}, "unknown")');
  h.reply(h.messages.at(-1), {success: false, verified: false, state: "rejected", code: "unknown-action", detail: "未注册"});
  check((await unknown).code === "unknown-action", "Native unknown-action refusals reach the caller");
  const fields = h.run('window.ICeClassTeacherHost.execute("teacher.about", {unexpected: true}, "fields")');
  h.reply(h.messages.at(-1), {success: false, verified: false, state: "rejected", code: "invalid-fields", detail: "参数无效"});
  check((await fields).code === "invalid-fields", "Native field validation is preserved");

  const expired = h.run('window.ICeClassTeacherHost.execute("teacher.about", {}, "timeout-operation")');
  h.timeout();
  const expiredResult = await expired;
  check(!expiredResult.success && !expiredResult.verified && h.timers.size === 0, "A timeout never claims completion");
  const afterTimeout = h.messages.length;
  await Promise.resolve();
  check(h.messages.length === afterTimeout, "Timeouts never automatically retry");
  const missingReceipt = h.run('window.ICeClassTeacherHost.execute("teacher.about", {}, "timeout-operation")');
  check(h.messages.at(-1).method === "receipt", "Even an explicit duplicate after timeout cannot resend execute");
  h.reply(h.messages.at(-1), {success: false, verified: false, detail: "未执行", code: "receipt-missing"});
  check((await missingReceipt).code === "receipt-missing", "Missing receipts remain unconfirmed");

  const pending = api.catalog();
  h.hide();
  check((await pending).actions.length === 0 && h.timers.size === 0, "Leaving the page settles pending requests without retaining timers");
  const count = h.messages.length;
  check(!(await h.run('window.ICeClassTeacherHost.execute("teacher.about", {}, "after-hide")')).success && h.messages.length === count,
    "A hidden historical document cannot execute more actions");
  const throwing = host({respond() { throw new Error("Authorization: secret-transport"); }});
  const safe = await throwing.run('window.ICeClassTeacherHost.execute("teacher.about", {}, "transport-error")');
  check(!safe.success && !JSON.stringify(safe).includes("secret-transport"), "Transport exceptions never throw or disclose their text");

  let effects = 0;
  const bounded = host({respond(message, reply) { if (message.method === "execute") effects++; reply(message, opened); }});
  for (let index = 0; index < 256; index++)
    await bounded.run(`window.ICeClassTeacherHost.execute("teacher.about", {}, "bounded-${index}")`);
  check((await bounded.run('window.ICeClassTeacherHost.execute("teacher.about", {}, "too-many")')).code === "operation-limit" && effects === 256,
    "A full JS operation cache refuses new effects instead of evicting old IDs");
  await bounded.run('window.ICeClassTeacherHost.execute("teacher.about", {}, "bounded-0")');
  check(effects === 256 && bounded.messages.at(-1).method === "receipt", "The oldest JS receipt remains protected at capacity");
  const saturated = host();
  const requests = Array.from({length: 256}, () => saturated.window.ICeClassTeacherHost.catalog());
  check((await saturated.window.ICeClassTeacherHost.catalog()).actions.length === 0 && saturated.messages.length === 256,
    "In-flight requests are bounded");
  saturated.hide(); await Promise.all(requests);
  console.log(`Teacher action JavaScript checks passed: ${checks}`);
})().catch(error => { console.error(error); process.exitCode = 1; });

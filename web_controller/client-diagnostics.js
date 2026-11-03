(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  let serial = 0, detailSerial = 0, offset = 0, total = 0, busy = false, current = null;
  const allowed = () => window.ICeClass?.state?.user?.role === 'superadmin'
    && !window.ICeClass.state.user.classroom && window.ICeClassVoiceHost?.classroomAccount !== true;
  function status(text, error = false) {
    const element = byId('clientDiagnosticStatus'); element.textContent = text;
    element.setAttribute('role', error ? 'alert' : 'status'); element.classList.toggle('danger-text', error);
  }
  function controls() {
    byId('clientDiagnosticFilters').querySelectorAll('button').forEach(button => { button.disabled = busy; });
    byId('clientDiagnosticRows').querySelectorAll('button').forEach(button => { button.disabled = busy; });
    byId('diagnosticPrevious').disabled = busy || offset === 0;
    byId('diagnosticNext').disabled = busy || offset + 20 >= total;
  }
  function text(tag, value) { const element = document.createElement(tag); element.textContent = value; return element; }
  const time = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const readError = error => error instanceof TypeError ? '无法连接学校平台，请检查网络后点击“刷新日志”重试。'
    : error.message || '读取失败，请点击“刷新日志”重试。';
  async function showDetail(id) {
    if (busy || !allowed()) return;
    const request = ++detailSerial;
    const listRequest = serial;
    try {
      const item = await window.ICeClass.api('/api/client-diagnostics/' + encodeURIComponent(id));
      if (request !== detailSerial || listRequest !== serial || !allowed()) return;
      current = item; byId('clientDiagnosticDetail').hidden = false;
      byId('diagnosticDetailTitle').textContent = item.kind === 'manual' ? '手动诊断' : '自动错误';
      byId('diagnosticDetailMeta').textContent = `${item.actor} · ${item.deviceName} · ${item.version} · ${time(item.receivedAt)} · 编号 ${item.id}`;
      byId('diagnosticReport').textContent = item.report;
      byId('diagnosticDetailTitle').focus({ preventScroll: true });
      byId('clientDiagnosticDetail').scrollIntoView({ block: 'nearest', behavior: 'instant' });
    } catch (error) { if (request === detailSerial && listRequest === serial && allowed()) status(readError(error), true); }
  }
  async function load() {
    if (!allowed()) return;
    const request = ++serial;
    detailSerial++; current = null; byId('clientDiagnosticDetail').hidden = true;
    busy = true; controls(); status('正在读取客户端日志…');
    const filters = new FormData(byId('clientDiagnosticFilters'));
    const query = new URLSearchParams({ limit: '20', offset: String(offset) });
    for (const [key, raw] of filters) {
      const value = raw.trim(); if (!value) continue;
      if (key === 'since' || key === 'until') query.set(key, String(Date.parse(value + 'T00:00:00+08:00') + (key === 'until' ? 86400000 : 0)));
      else query.set(key, value);
    }
    try {
      const result = await window.ICeClass.api('/api/client-diagnostics?' + query);
      if (request !== serial || !allowed()) return;
      total = result.total;
      const rows = byId('clientDiagnosticRows'); rows.replaceChildren();
      for (const item of result.items) {
        const row = document.createElement('tr'); row.append(text('td', time(item.receivedAt)));
        const device = text('td', `${item.edition === 'classroom' ? '教室端' : '教师端'} · ${item.actor}`);
        device.append(text('small', item.deviceName)); row.append(device);
        row.append(text('td', item.kind === 'manual' ? '手动诊断' : '自动错误'), text('td', item.version));
        const action = document.createElement('td'), button = text('button', '查看详情');
        button.type = 'button'; button.className = 'btn'; button.setAttribute('aria-label', `查看${item.deviceName}在${time(item.receivedAt)}的日志`);
        button.addEventListener('click', () => showDetail(item.id)); action.append(button); row.append(action); rows.append(row);
      }
      status(total ? `共 ${total} 条记录` : '暂无符合条件的日志。新版客户端运行后开始上报，也可从“关于”手动提交。');
      byId('diagnosticPage').textContent = total ? `${offset + 1}–${offset + result.items.length} / ${total}` : '0 条记录';
    } catch (error) { if (request === serial && allowed()) status(readError(error), true); }
    finally { if (request === serial) { busy = false; controls(); } }
  }
  function init() {
    byId('clientDiagnosticsSection').classList.toggle('hidden', !allowed());
    if (!allowed()) { serial++; detailSerial++; current = null; byId('clientDiagnosticRows').replaceChildren(); byId('clientDiagnosticDetail').hidden = true; }
  }
  byId('clientDiagnosticsPanel').addEventListener('toggle', () => { if (byId('clientDiagnosticsPanel').open) void load(); });
  byId('clientDiagnosticFilters').addEventListener('submit', event => { event.preventDefault(); offset = 0; void load(); });
  byId('diagnosticReset').addEventListener('click', () => { byId('clientDiagnosticFilters').reset(); offset = 0; void load(); });
  byId('diagnosticRefresh').addEventListener('click', () => { void load(); });
  byId('diagnosticPrevious').addEventListener('click', () => { offset = Math.max(0, offset - 20); void load(); });
  byId('diagnosticNext').addEventListener('click', () => { offset += 20; void load(); });
  byId('diagnosticCopy').addEventListener('click', async () => {
    if (!current || !allowed()) return;
    try { await navigator.clipboard.writeText(current.report); status('日志已复制。'); }
    catch { status('复制失败，可选择下方正文后手动复制。', true); }
  });
  window.addEventListener('iceclass-ready', init);
  init(); controls();
})();

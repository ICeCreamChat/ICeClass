(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let owner = '', serial = 0, detailSerial = 0, offset = 0, total = 0, busy = false, loaded = false, current = null, detailTrigger = null;
  const allowed = () => window.ICeClass?.state.user?.role === 'superadmin'
    && !window.ICeClass.state.user.classroom && window.ICeClassVoiceHost?.classroomAccount !== true;
  const identity = () => allowed() ? window.ICeClass.state.user.id + ':' + window.ICeClass.state.csrf : '';
  const time = value => new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}).replaceAll('/','-');
  const visible = () => window.ICeClassSettings?.visible && window.ICeClassSettings.section === 'logs';
  function node(tag,text,className='') { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; }
  function status(message,error=false) {
    $('clientDiagnosticStatus').textContent = message;
    $('clientDiagnosticStatus').setAttribute('role',error ? 'alert' : 'status');
  }
  function controls() {
    $('clientDiagnosticFilters').querySelectorAll('button').forEach(button => { button.disabled = busy; });
    $('clientDiagnosticRows').querySelectorAll('button').forEach(button => { button.disabled = busy; });
    $('diagnosticRefresh').disabled = busy;
    $('diagnosticPrevious').disabled = busy || offset === 0;
    $('diagnosticNext').disabled = busy || offset + 20 >= total;
    $('clientDiagnosticsSection').setAttribute('aria-busy',String(busy));
  }
  const readError = error => error instanceof TypeError ? '读取失败，请检查连接后点击“刷新”重试。' : error.message || '读取失败，请点击“刷新”重试。';
  function closeDetail(returnFocus = true) {
    detailSerial++; current = null; $('clientDiagnosticDetail').hidden = true;
    if (returnFocus && visible()) (detailTrigger?.isConnected ? detailTrigger : $('diagnosticQuery')).focus({preventScroll:true});
    detailTrigger = null;
  }
  async function showDetail(id, trigger) {
    if (busy || !allowed()) return;
    const request = ++detailSerial, listRequest = serial, account = identity();
    trigger.disabled = true; trigger.setAttribute('aria-busy','true');
    try {
      const item = await window.ICeClass.api('/api/client-diagnostics/' + encodeURIComponent(id));
      if (request !== detailSerial || listRequest !== serial || identity() !== account) return;
      current = item; detailTrigger = trigger; $('clientDiagnosticDetail').hidden = false;
      $('diagnosticDetailTitle').textContent = item.kind === 'manual' ? '手动诊断' : '自动错误';
      $('diagnosticDetailMeta').textContent = `${item.actor} · ${item.deviceName} · ${item.version} · ${time(item.receivedAt)} · 编号 ${item.id}`;
      $('diagnosticReport').textContent = item.report;
      if (visible()) {
        $('diagnosticDetailTitle').focus({preventScroll:true});
        $('clientDiagnosticDetail').scrollIntoView({block:'nearest',behavior:'instant'});
      }
    } catch (error) { if (request === detailSerial && listRequest === serial && identity() === account) status(readError(error),true); }
    finally { trigger.disabled = false; trigger.removeAttribute('aria-busy'); }
  }
  async function load() {
    if (busy || !allowed()) return;
    $('diagnosticUntil').removeAttribute('aria-invalid');
    const since = $('diagnosticSince').value, until = $('diagnosticUntil').value;
    if (since && until && since > until) {
      status('结束日期不能早于起始日期。',true); $('diagnosticUntil').setAttribute('aria-invalid','true');
      $('diagnosticUntil').setAttribute('aria-errormessage','clientDiagnosticStatus'); $('diagnosticUntil').focus(); return;
    }
    const request = ++serial, account = identity(); closeDetail(false); busy = true; controls(); status('正在读取日志…');
    const query = new URLSearchParams({limit:'20',offset:String(offset)});
    for (const [key,raw] of new FormData($('clientDiagnosticFilters'))) {
      const value = raw.trim(); if (!value) continue;
      if (key === 'since' || key === 'until') query.set(key,String(Date.parse(value + 'T00:00:00+08:00') + (key === 'until' ? 86400000 : 0)));
      else query.set(key,value);
    }
    try {
      const result = await window.ICeClass.api('/api/client-diagnostics?' + query);
      if (request !== serial || identity() !== account) return;
      total = result.total; loaded = true; const fragment = document.createDocumentFragment();
      for (const item of result.items) {
        const row = node('li','','log-overview'), identity = node('div','');
        identity.append(node('strong',[item.actor,item.deviceName].filter(Boolean).join(' · ')), node('span',`${item.edition === 'classroom' ? '教室端' : '教师端'} · ${item.version}`));
        const kind = node('div',''); kind.append(node('span',item.kind === 'manual' ? '手动诊断' : '自动错误','badge ' + (item.kind === 'error' ? 'danger' : 'neutral')));
        const received = node('div',new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(item.receivedAt)).replaceAll('/','-'),'log-time');
        received.append(node('small',new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(item.receivedAt))));
        const button = node('button','查看详情','button quiet small-button'); button.type = 'button';
        button.setAttribute('aria-label',`查看${item.deviceName}在${time(item.receivedAt)}的日志`); button.addEventListener('click',() => showDetail(item.id,button));
        row.append(identity,kind,received,button); fragment.append(row);
      }
      $('clientDiagnosticRows').replaceChildren(fragment); document.querySelector('#clientDiagnosticsSection .log-table-head').hidden = total === 0;
      status(total ? `共 ${total} 条记录` : '暂无符合条件的日志。两端可从“关于”提交近期诊断。');
      $('diagnosticPage').textContent = total ? `${offset + 1}-${offset + result.items.length} / ${total}` : '0 条记录';
    } catch (error) {
      if (request === serial && identity() === account) status((loaded ? '刷新失败，已保留上次列表。' : '') + readError(error),true);
    } finally { if (request === serial && identity() === account) { busy = false; controls(); } }
  }
  function init() {
    const account = identity(); $('clientDiagnosticsSection').classList.toggle('hidden',!account);
    if (account !== owner) {
      owner = account; serial++; closeDetail(false); offset = total = 0; busy = loaded = false;
      $('clientDiagnosticRows').replaceChildren(); $('clientDiagnosticFilters').reset(); $('diagnosticPage').textContent = ''; status(''); controls();
    }
    if (account && visible() && !loaded) void load();
  }
  window.addEventListener('iceclass-settings-section',event => { if (event.detail === 'logs' && !loaded) void load(); });
  $('clientDiagnosticFilters').addEventListener('submit',event => { event.preventDefault(); if (busy) return; offset = 0; void load(); });
  $('diagnosticReset').addEventListener('click',() => { $('clientDiagnosticFilters').reset(); offset = 0; void load(); });
  $('diagnosticRefresh').addEventListener('click',() => { void load(); });
  $('diagnosticPrevious').addEventListener('click',() => { if (!busy) { offset = Math.max(0,offset - 20); void load(); } });
  $('diagnosticNext').addEventListener('click',() => { if (!busy && offset + 20 < total) { offset += 20; void load(); } });
  $('closeLog').addEventListener('click',() => closeDetail());
  $('diagnosticCopy').addEventListener('click',async () => {
    if (!current || !allowed()) return;
    try { await navigator.clipboard.writeText(current.report); status('日志已复制。'); }
    catch { status('复制失败，请在正文中选择并手动复制。',true); $('diagnosticReport').focus(); }
  });
  window.addEventListener('iceclass-ready',init); init(); controls();
})();

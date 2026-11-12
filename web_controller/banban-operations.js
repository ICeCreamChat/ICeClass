(() => {
  'use strict';
  const labels = {prepared:'准备执行', awaiting_input:'请选择文件', awaiting_confirmation:'待您确认', awaiting_client:'等待本机执行', running:'正在执行', stopping:'正在停止', succeeded:'已完成', failed:'未完成', cancelled:'已取消', expired:'已过期', unconfirmed:'结果待确认'};
  const names = {name:'名称', username:'账号', displayName:'姓名', role:'角色', enabled:'启用', classIds:'授权班级', headClassNames:'带班班级', teachingClassNames:'任教班级', grade:'年级',
    text:'内容', alertLevel:'通知类型', ttsVolume:'播报音量', ttsSpeed:'播报语速', displayDurationSec:'显示秒数', threshold:'声量门槛',
    reminderEnabled:'晨读提醒', periods:'时段', weekdays:'星期', start:'开始', end:'结束', startTime:'开始时间', endTime:'结束时间',
    kind:'记录类型', allDates:'全部日期', revision:'当前版本', config:'教室配置', slots:'作息时段', lessons:'常规课表', overrides:'临时调课',
    weekAnchor:'起始周', dutyRotations:'循环值班', midday:'午间静校', evening:'晚自习', cycleWeeks:'循环周数', slotIds:'时段',
    reminders:'提醒', prepare:'课前', prepareMinutes:'提前分钟', sound:'提示音', speech:'语音', volume:'音量', displaySeconds:'显示秒数',
    appearance:'外观', position:'位置', width:'宽度', opacity:'不透明度', theme:'主题', material:'材质', clickThrough:'鼠标穿透', hideFullscreen:'全屏时隐藏',
    hideDuringLessons:'上课时隐藏', offsetX:'水平偏移', offsetY:'垂直偏移', components:'组件', title:'标题', date:'日期', type:'类型',
    rotationSeconds:'轮播秒数', automation:'自动化', trigger:'触发时机', value:'设置值', minute:'时间', label:'名称', subject:'课程',
    teacher:'教师', room:'地点', weekday:'星期', weekType:'单双周', cancelled:'取消', bindingNote:'绑定备注', verified:'已核实', changes:'班级更名',
    url:'网站', page:'页码', query:'课件名称', find:'查找文字', application:'应用', file:'课件', control:'控件', note:'绑定备注', classNames:'授权班级',
    targetClassName:'改绑到班级', slotId:'作息时段', week:'单双周', deviceLimit:'每台教室设备 / 月',
    accountLimit:'每个教师账号 / 月', individualLimits:'单独上限', monthlyLimit:'每月次数'};
  const values = {teacher:'班主任', subject_teacher:'任课老师', grade_leader:'年级部', director:'主任', principal:'校长', info:'普通', warning:'重要', urgent:'紧急',
    reading:'晨读', history:'通知', voice:'来音', all:'每周', odd:'单周', even:'双周', light:'浅色', dark:'深色', system:'跟随系统'};
  let root = null, timer = 0, epoch = 0, navigatingPage = false, documentClientId;
  const cards = new Map(), operations = new Map(), refreshed = new Set();
  // Keep IDs for this page's lifetime. At capacity, refuse new dispatches rather than evicting replay protection.
  const liveIds = new Set(), liveLimit = 256;
  const finalStates = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'unconfirmed']);
  const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const api = (...args) => window.ICeClass.api(...args);
  const node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  const button = (text, fn, cls = 'bb-tool', control = text) => { const e = node('button', text, cls); e.type = 'button'; e.dataset.control = control; e.addEventListener('click', fn); return e; };
  const path = id => `/api/banban/operations/${encodeURIComponent(id)}`;
  function refreshBusiness(operation) {
    if (operation.kind !== 'platform' || operation.status !== 'succeeded' || refreshed.has(operation.id)) return;
    refreshed.add(operation.id);
    Promise.resolve().then(() => window.ICeClass.refreshManagement()).catch(() => {});
  }
  function field(title, control) {
    const label = node('label', undefined, 'bb-operation-field');
    control.setAttribute('aria-label', title);
    if (control.id) control.name = control.id;
    if (!control.autocomplete) control.autocomplete = 'off';
    label.append(node('span', title), control); return label;
  }
  function updateCards(operation) {
    const previous = operations.get(operation.id);
    if (previous && (previous.updatedAt > operation.updatedAt || previous.updatedAt === operation.updatedAt
      && finalStates.has(previous.status) && !finalStates.has(operation.status))) operation = previous;
    operations.set(operation.id, operation);
    window.dispatchEvent(new CustomEvent('banban-operation-updated', {detail: operation}));
    const set = cards.get(operation.id);
    if (set) for (const e of [...set]) { if (e.isConnected) paint(e, operation); else set.delete(e); }
    if (previous && previous.status !== operation.status) refreshBusiness(operation);
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (!root || document.hidden && !window.ICeClassVoiceHost && !window.ICeClassTeacherHost || document.getElementById('bbPanel')?.hidden) return;
    const pending = [...cards.entries()].some(([id, set]) => [...set].some(e => e.isConnected)
      && needsRefresh(operations.get(id)));
    if (pending) timer = setTimeout(refreshOperations, 1500);
  }
  function needsRefresh(operation) {
    return operation && (['running', 'stopping', 'awaiting_confirmation', 'awaiting_input', 'awaiting_client'].includes(operation.status)
      || operation.status === 'unconfirmed' && Date.now() < operation.expiresAt);
  }
  async function refreshOperations() {
    const generation = epoch;
    await Promise.allSettled([...cards.entries()].map(async ([id, set]) => {
      if (![...set].some(e => e.isConnected) || !needsRefresh(operations.get(id))) return;
      const previous = operations.get(id);
      try {
        const operation = await api(path(id), {cache:'no-store'});
        if (generation === epoch && root && operations.get(id) === previous) updateCards(operation);
      } catch { /* A revoked or deleted operation is never actionable from history. */ }
    }));
    schedule();
  }
  function parameters(parent, data, depth = 0) {
    if (depth > 7) return;
    const list = node('dl', undefined, 'bb-operation-fields');
    Object.entries(data || {}).forEach(([key, value]) => {
      if (['action','classId','deviceId','targetId','controlId','schemaVersion','id','_quietPeriod'].includes(key)) return;
      const row = node('div'); row.append(node('dt', names[key] || key));
      const content = node('dd');
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          if (!value.length) content.textContent = '无';
          else if (value.every(v => v === null || typeof v !== 'object')) content.textContent = value.join('、');
          else value.forEach(v => { const group = node('div', undefined, 'bb-operation-group'); parameters(group, v, depth + 1); content.append(group); });
        } else parameters(content, value, depth + 1);
      } else content.textContent = typeof value === 'boolean' ? value ? '是' : '否' : values[value] || String(value ?? '无');
      row.append(content); list.append(row);
    });
    parent.append(list);
  }
  function feedback(card, text, error = false, focus = false) {
    const state = card.querySelector('.bb-operation-feedback');
    if (!state) return;
    state.classList.remove('sr-only'); state.dataset.error = String(error); state.textContent = text;
    if (focus) state.focus({preventScroll:true});
  }
  function operationUrl(value, operation, endpoint) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const url = new URL(value, window.location.href);
      return /^https?:$/.test(url.protocol) && url.origin === window.location.origin && !url.username && !url.password
        && url.pathname === `${path(operation.id)}/${endpoint}` && !url.search && !url.hash ? url.pathname : null;
    } catch { return null; }
  }
  async function submit(card, operation, endpoint, options, progress) {
    if (card.dataset.busy || !root || !card.isConnected || operations.get(operation.id)?.status !== operation.status) return;
    const generation = epoch;
    card.dataset.restoreFocus = String(card.contains(document.activeElement));
    card.dataset.busy = 'true'; card.setAttribute('aria-busy', 'true');
    const controls = [...card.querySelectorAll('button, input')].map(control => [control, control.disabled]);
    controls.forEach(([control]) => { control.disabled = true; });
    feedback(card, progress);
    try {
      const result = await api(`${path(operation.id)}/${endpoint}`, options);
      if (generation !== epoch) return;
      if (result?.id !== operation.id) throw new Error('操作回执不匹配，请重新读取操作状态。');
      // Repaint even if an unchanged response follows a request, so the controls leave their busy state.
      delete card.dataset.busy; delete card.dataset.signature; card.setAttribute('aria-busy', 'false');
      card.querySelector('input[type=password]')?.setAttribute('aria-invalid', 'false');
      if (endpoint === 'confirm' || endpoint === 'file') {
        const input = card.querySelector(endpoint === 'file' ? 'input[type=file]' : 'input[type=password]');
        if (input) input.value = '';
      }
      updateCards(result); refreshBusiness(result);
    } catch (error) {
      if (generation !== epoch) return;
      delete card.dataset.busy; delete card.dataset.restoreFocus; card.setAttribute('aria-busy', 'false');
      controls.forEach(([control, disabled]) => { control.disabled = disabled; });
      feedback(card, error.message || '操作未提交，请重试。', true, true);
    }
  }
  function upload(card, operation) {
    const input = card.querySelector('input[type=file]'), file = input?.files?.[0];
    let error = '';
    if (!file) error = '请先选择 XLSX 文件。';
    else if (!/\.xlsx$/i.test(file.name)) error = '请选择 .xlsx 格式的课表文件。';
    else if (!file.size || file.size > 5 * 1024 * 1024) error = '文件须非空且不超过 5 MB，请重新选择。';
    if (error) { input?.setAttribute('aria-invalid', 'true'); feedback(card, error, true, true); return; }
    input.setAttribute('aria-invalid', 'false');
    // File is the raw request body; its contents never enter chat, operation metadata or local storage.
    return submit(card, operation, 'file', {method:'POST', headers:{'Content-Type':xlsxType, 'X-CSRF-Token':window.ICeClass.state.csrf}, body:file}, '正在读取配置…');
  }
  async function reveal(card, url, control) {
    const generation = epoch, content = card.querySelector('.bb-operation-private');
    if (!content.hidden) { content.replaceChildren(); content.hidden = true; control.textContent = '显示私密结果'; return; }
    control.disabled = true; feedback(card, '正在读取…');
    try {
      const result = await api(url, {cache:'no-store'});
      if (generation !== epoch || !root || !content.isConnected) return;
      const code = typeof result === 'string' ? result : result?.code;
      if (typeof code !== 'string' || !code) throw new Error('私密结果暂不可用，请重新读取。');
      const output = node('output', code); output.setAttribute('aria-label', '私密结果');
      content.replaceChildren(output); content.hidden = false; control.textContent = '隐藏私密结果'; feedback(card, '');
    } catch (error) { if (generation === epoch) feedback(card, error.message || '私密结果未读取，请重试。', true, true); }
    finally { if (generation === epoch) control.disabled = false; }
  }
  function paint(card, operation) {
    // Timestamp-only polls must not replace file inputs, passwords, revealed results or keyboard focus.
    const formStamp = JSON.stringify([operation.action, operation.parameters, operation.needsPassword, operation.input]);
    const signature = JSON.stringify([operation.status, operation.title, operation.target, operation.impact, formStamp, operation.result, operation.clientId]);
    if (card.dataset.busy) return;
    if (card.dataset.signature === signature) return;
    const previousStatus = card.dataset.state;
    const sameState = previousStatus === operation.status;
    const sameForm = sameState && card.dataset.formStamp === formStamp;
    const previousInput = sameForm ? card.querySelector('input') : null;
    const opened = new Map([...card.querySelectorAll('details')].map(e => [e.dataset.section, e.open]));
    const focused = card.contains(document.activeElement) ? document.activeElement : null;
    const selection = focused?.type === 'password' ? [focused.selectionStart, focused.selectionEnd] : null;
    const focusedControl = focused?.dataset.control;
    const focusedSummary = focused?.tagName === 'SUMMARY' ? focused.parentElement.dataset.section : null;
    const hadFocus = card.contains(document.activeElement) || card.dataset.restoreFocus === 'true';
    delete card.dataset.restoreFocus;
    card.dataset.signature = signature; card.dataset.state = operation.status; card.dataset.formStamp = formStamp;
    card.replaceChildren();
    const heading = node('div', undefined, 'bb-operation-heading');
    heading.append(node('strong', operation.title), node('span', operation.status === 'awaiting_client' && operation.action?.startsWith('teacher.page.') ? '等待打开页面' : labels[operation.status] || operation.status, 'bb-operation-state'));
    const succeeded = operation.status === 'succeeded';
    let content = card;
    if (succeeded) {
      const more = node('details', undefined, 'bb-operation-more bb-operation-record');
      more.dataset.section = 'record'; more.open = sameState && Boolean(opened.get('record'));
      const summary = node('summary'); summary.append(heading);
      content = node('div', undefined, 'bb-operation-record-body');
      more.append(summary, content); card.append(more);
    } else card.append(heading);
    if (operation.target) content.append(node('p', operation.target, 'bb-operation-target'));
    const detail = operation.status === 'awaiting_confirmation' ? operation.impact : operation.result?.detail || operation.impact;
    if (detail) content.append(node('p', detail, 'bb-operation-detail'));
    if (operation.kind === 'teacher' && !operation.action?.startsWith('teacher.page.') && operation.status === 'awaiting_client' && !window.ICeClassTeacherHost) {
      content.append(node('p', '请在发起操作的教师端窗口中继续。', 'bb-operation-detail'));
    }
    if (operation.result?.coverage && operation.result.coverage !== detail) content.append(node('p', operation.result.coverage, 'bb-operation-detail'));
    if (operation.action === 'read_document' && operation.result?.text) {
      content.append(node('p', operation.result.text, 'bb-document-text'));
    }
    if (operation.parameters && Object.keys(operation.parameters).length) {
      if (succeeded) parameters(content, operation.parameters);
      else {
        const more = node('details', undefined, 'bb-operation-more');
        more.dataset.section = 'parameters'; more.open = sameState ? Boolean(opened.get('parameters')) : operation.status === 'awaiting_confirmation';
        more.append(node('summary', '操作内容')); parameters(more, operation.parameters); content.append(more);
      }
    }
    const state = node('p', '', 'bb-operation-feedback'); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite'); state.tabIndex = -1; card.append(state);
    const actions = node('div', undefined, 'bb-operation-actions');
    if (operation.status === 'awaiting_input' && operation.input === 'island-import') {
      const input = previousInput || node('input'); input.type = 'file'; input.name = 'islandImport'; input.accept = `.xlsx,${xlsxType}`;
      card.append(field('课表文件（XLSX，最大 5 MB）', input));
      actions.append(button('预览配置', () => upload(card, operation), 'bb-send', 'preview'));
    }
    if (operation.status === 'awaiting_confirmation') {
      let password;
      if (operation.needsPassword) {
        password = previousInput || node('input'); password.type = 'password'; password.name = 'newPassword'; password.autocomplete = 'new-password'; password.maxLength = 128;
        card.append(field('新密码', password));
      }
      actions.append(button('确认执行', () => submit(card, operation, 'confirm', {method:'POST', body:JSON.stringify({confirmed:true, ...(password ? {password:password.value} : {})})}, '正在提交…'), 'bb-send', 'confirm'));
    }
    if (['awaiting_input','awaiting_client','awaiting_confirmation','running','stopping'].includes(operation.status) || operation.kind === 'computer' && operation.status === 'unconfirmed') {
      const waiting = ['awaiting_input','awaiting_client','awaiting_confirmation'].includes(operation.status);
      actions.append(button(waiting ? '取消' : '停止操作', () => submit(card, operation, 'cancel', {method:'POST'}, '正在取消…'), 'bb-tool', 'cancel'));
    }
    if (succeeded) {
      const downloadUrl = operationUrl(operation.result?.downloadUrl, operation, 'download');
      if (downloadUrl) {
        const link = node('a', '保存文件', 'bb-tool bb-operation-download'); link.href = downloadUrl;
        link.download = typeof operation.result.fileName === 'string' ? operation.result.fileName : '';
        actions.append(link);
      }
      const privateUrl = operationUrl(operation.result?.privateUrl, operation, 'private-result');
      if (privateUrl) {
        const privateContent = node('div', undefined, 'bb-operation-private'); privateContent.hidden = true;
        privateContent.setAttribute('aria-live', 'polite'); card.append(privateContent);
        actions.append(button('显示私密结果', e => reveal(card, privateUrl, e.currentTarget), 'bb-tool', 'private'));
      }
    }
    if (actions.children.length) card.append(actions);
    if (hadFocus) {
      const nextFocus = focused && card.contains(focused) ? focused
        : sameState && focusedControl ? [...card.querySelectorAll('button')].find(e => e.dataset.control === focusedControl)
        : sameState && focusedSummary ? [...card.querySelectorAll('details')].find(e => e.dataset.section === focusedSummary)?.querySelector('summary')
        : succeeded ? card.querySelector('summary') : null;
      if (nextFocus) { nextFocus.focus({preventScroll:true}); if (selection && nextFocus === focused) focused.setSelectionRange(...selection); }
      else {
        state.textContent = labels[operation.status] || operation.status;
        state.classList.add('sr-only'); state.focus({preventScroll:true});
      }
    }
  }
  function render(container, operation) {
    let card = [...container.querySelectorAll('.bb-operation')].find(e => e.dataset.operationId === operation.id);
    if (!card) {
      card = node('article', undefined, 'bb-operation'); card.dataset.operationId = operation.id;
      card.setAttribute('aria-label', operation.title || '班班操作'); container.append(card);
      if (!cards.has(operation.id)) cards.set(operation.id, new Set()); cards.get(operation.id).add(card);
    }
    if (operations.has(operation.id)) updateCards(operation);
    else { operations.set(operation.id, operation); paint(card, operation); schedule(); }
    return card;
  }
  async function hydrate(container, references) {
    const generation = epoch;
    await Promise.allSettled((references || []).map(async reference => {
      try {
        const operation = await api(`/api/banban/operations/${encodeURIComponent(reference.id)}`);
        if (generation === epoch && container.isConnected) render(container, operation);
      } catch { /* A deleted conversation, revoked scope or old action is not an executable card. */ }
    }));
  }
  function mount(element) {
    dispose(); root = element;
    root.querySelector('#bbLauncher')?.addEventListener('click', schedule);
  }
  function invalidate(force = false) {
    // The existing nav handler must run during an explicitly claimed page action without cancelling its receipt.
    if (navigatingPage && !force) return false;
    epoch++; clearTimeout(timer);
    for (const set of cards.values()) for (const card of set) {
      card.querySelectorAll('input').forEach(input => { input.value = ''; });
      const privateContent = card.querySelector('.bb-operation-private');
      if (privateContent) { privateContent.replaceChildren(); privateContent.hidden = true; }
      const control = [...card.querySelectorAll('button')].find(e => e.dataset.control === 'private');
      if (control) { control.textContent = '显示私密结果'; control.disabled = false; }
      delete card.dataset.busy; delete card.dataset.signature; card.setAttribute('aria-busy', 'false');
      const current = operations.get(card.dataset.operationId);
      if (current) paint(card, current);
    }
    schedule();
    return true;
  }
  function dispose() { invalidate(true); clearTimeout(timer); cards.clear(); operations.clear(); refreshed.clear(); root?.querySelector('#bbLauncher')?.removeEventListener('click', schedule); root = null; }
  function pageEntries() {
    return [...document.querySelectorAll('#mainNav button[data-view]')].filter(control => !control.disabled && !control.hidden
      && !control.closest('[hidden], .hidden') && control.getClientRects().length && window.getComputedStyle(control).visibility === 'visible'
      && /^[a-z][a-z0-9-]*$/.test(control.dataset.view) && control.textContent.trim()).map(control => ({control, view:control.dataset.view,
      id:`teacher.page.${control.dataset.view.replace(/-/g, '.')}`, title:control.textContent.trim().replace(/\s+/g, ' ')}));
  }
  async function nativeCatalog() {
    const host = window.ICeClassTeacherHost;
    if (typeof host?.catalog !== 'function' || typeof host?.execute !== 'function') return null;
    try {
      const catalog = await host.catalog();
      if (typeof catalog?.clientId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(catalog.clientId) || !Array.isArray(catalog.actions)) return null;
      return {clientId:catalog.clientId, actions:catalog.actions.filter(a => typeof a?.id === 'string' && typeof a.title === 'string')
        .map(({id, title, fields = [], confirmation = true, impact}) => ({id, title, fields, confirmation, ...(impact ? {impact} : {})}))};
    } catch { return null; }
  }
  async function clientCatalog() {
    const native = await nativeCatalog();
    const actions = [...(native?.actions.filter(a => !a.id.startsWith('teacher.page.')) || []),
      ...pageEntries().map(({id, title}) => ({id, title, fields:[], confirmation:false, impact:'仅打开页面，不会保存或提交内容。'}))];
    if (!actions.length || actions.length > 30) return null;
    return {clientId:native?.clientId || (documentClientId ||= window.crypto.randomUUID()), actions};
  }
  // Only freshly received stream events enter here. Rendering, history and polling never dispatch native actions.
  async function live(operation, valid = () => true) {
    if (!root || !valid()) return;
    refreshBusiness(operation);
    if (finalStates.has(operations.get(operation.id)?.status)) return;
    if (operation.kind !== 'teacher' || operation.status !== 'awaiting_client' || liveIds.has(operation.id)) return;
    const notify = text => { for (const card of cards.get(operation.id) || []) feedback(card, text, true); };
    if (liveIds.size >= liveLimit) { notify('本页本机操作已达上限，请重新打开教师端窗口。'); return; }
    liveIds.add(operation.id);
    const generation = epoch, host = window.ICeClassTeacherHost;
    const user = window.ICeClass.state?.user, csrf = window.ICeClass.state?.csrf;
    const sameAccount = () => Boolean(user) && window.ICeClass.state?.user === user && window.ICeClass.state?.csrf === csrf;
    const active = () => generation === epoch && root && sameAccount() && valid() && !finalStates.has(operations.get(operation.id)?.status);
    const unconfirmed = detail => ({success:false, verified:false, detail});
    let claimAttempted = false, result;
    try {
      const catalog = await clientCatalog();
      if (!active()) return;
      if (!catalog || window.ICeClassTeacherHost !== host) { notify('当前窗口的能力暂不可用，请重新打开后再试。'); return; }
      if (catalog.clientId !== operation.clientId) { notify('此操作属于另一个窗口，请返回原窗口继续。'); return; }
      if (!catalog.actions.some(a => a.id === operation.action)) { notify('此教师端不支持该操作，请刷新能力后重新提出。'); return; }
      claimAttempted = true;
      const claim = await api(`${path(operation.id)}/client-start`, {method:'POST', body:JSON.stringify({clientId:catalog.clientId})});
      if (claim.claimed !== true) { if (active() && claim.operation?.id === operation.id) updateCards(claim.operation); return; }
      const current = claim.operation;
      if (!active() || window.ICeClassTeacherHost !== host) result = unconfirmed('页面已切换，本机操作未执行，请重新检查状态。');
      else if (current?.id !== operation.id || current.kind !== 'teacher' || current.clientId !== catalog.clientId
        || current.action !== operation.action || current.status !== 'running') result = unconfirmed('本机操作内容已变化，未执行，请重新核对。');
      else {
        updateCards(current);
        let receipt;
        if (!active() || window.ICeClassTeacherHost !== host) receipt = unconfirmed('页面已切换，操作未执行，请重新检查状态。');
        else if (current.action.startsWith('teacher.page.')) {
          const page = pageEntries().find(p => p.id === current.action);
          if (!page || Object.keys(current.parameters || {}).length) receipt = {success:false, verified:true, detail:'页面当前不可用，请检查账号权限或未保存的内容。'};
          else {
            navigatingPage = true;
            try { page.control.click(); } finally { navigatingPage = false; }
            const view = document.getElementById(`view-${page.view}`);
            const opened = page.control.classList.contains('active') && view && !view.hidden && !view.classList.contains('hidden') && view.getClientRects().length > 0;
            receipt = !active() ? unconfirmed('页面已离开，打开结果未确认，请重新检查。')
              : {success:Boolean(opened), verified:true, detail:opened ? `已打开${page.title}。` : '页面未打开，请先处理当前页面未保存的内容。'};
          }
        } else receipt = await host.execute(current.action, current.parameters || {}, current.id);
        result = typeof receipt?.success === 'boolean' && typeof receipt.verified === 'boolean' && typeof receipt.detail === 'string'
          ? {success:receipt.success, verified:receipt.verified, detail:receipt.detail.slice(0, 300)}
          : unconfirmed('未收到有效本机回执，请检查教师端状态；不会自动重试。');
      }
    } catch { result = unconfirmed('本机操作结果未确认，请检查教师端状态；不会自动重试。'); }
    if (!claimAttempted || !result || !sameAccount()) return;
    try {
      const updated = await api(`${path(operation.id)}/client-result`, {method:'POST', body:JSON.stringify({clientId:operation.clientId, ...result})});
      if (active()) updateCards(updated);
    } catch {
      if (active()) updateCards({...operations.get(operation.id) || operation, status:'unconfirmed', result:{detail:'本机回执尚未确认，请检查教师端状态；不会自动重试。'}});
    }
  }
  document.addEventListener('visibilitychange', schedule);
  // Voice consent is tied to one freshly re-read, unchanged operation.
  const consentStamp = operation => JSON.stringify([operation.id, operation.title, operation.target, operation.impact, operation.parameters, operation.expiresAt]);
  async function confirmVoice(operation, valid = () => true) {
    const generation = epoch;
    const fresh = await api(`/api/banban/operations/${encodeURIComponent(operation.id)}`);
    if (generation !== epoch || !valid()) throw new Error('这次确认已取消。');
    if (fresh.status !== 'awaiting_confirmation' || fresh.needsPassword || fresh.expiresAt <= Date.now()
      || consentStamp(fresh) !== consentStamp(operation)) throw new Error('操作内容已变化或已过期，请重新核对后确认。');
    const result = await api(`/api/banban/operations/${encodeURIComponent(operation.id)}/confirm`, {method:'POST', body:JSON.stringify({confirmed:true})});
    if (generation !== epoch || !valid()) throw new Error('这次确认已取消。');
    updateCards(result); refreshBusiness(result);
    return result;
  }
  async function cancelVoice(ids) {
    const generation = epoch;
    const results = [];
    for (const id of ids) {
      const fresh = await api(`/api/banban/operations/${encodeURIComponent(id)}`);
      if (generation !== epoch) break;
      if (!['awaiting_input','awaiting_client','awaiting_confirmation','running','stopping','unconfirmed'].includes(fresh.status)) continue;
      const result = await api(`/api/banban/operations/${encodeURIComponent(id)}/cancel`, {method:'POST'});
      if (generation !== epoch) break;
      updateCards(result); results.push(result);
    }
    return results;
  }
  window.ICeClassBanbanOperations = {mount, dispose, invalidate, render, hydrate, live, clientCatalog, confirmVoice, cancelVoice};
})();

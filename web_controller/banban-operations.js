(() => {
  'use strict';
  const labels = {prepared:'准备执行', awaiting_confirmation:'待您确认', running:'正在执行', stopping:'正在停止', succeeded:'已完成', failed:'未完成', cancelled:'已取消', expired:'已过期', unconfirmed:'结果待确认'};
  const names = {name:'名称', username:'账号', displayName:'姓名', role:'角色', enabled:'启用', classIds:'授权班级', grade:'年级',
    text:'内容', alertLevel:'通知类型', ttsVolume:'播报音量', ttsSpeed:'播报语速', displayDurationSec:'显示秒数', threshold:'声量门槛',
    reminderEnabled:'晨读提醒', periods:'时段', weekdays:'星期', start:'开始', end:'结束', startTime:'开始时间', endTime:'结束时间',
    kind:'记录类型', allDates:'全部日期', revision:'当前版本', config:'教室配置', slots:'作息时段', lessons:'常规课表', overrides:'临时调课',
    weekAnchor:'起始周', dutyRotations:'循环值班', midday:'午间静校', evening:'晚自习', cycleWeeks:'循环周数', slotIds:'时段',
    reminders:'提醒', prepare:'课前', prepareMinutes:'提前分钟', sound:'提示音', speech:'语音', volume:'音量', displaySeconds:'显示秒数',
    appearance:'外观', position:'位置', width:'宽度', opacity:'不透明度', theme:'主题', clickThrough:'鼠标穿透', hideFullscreen:'全屏时隐藏',
    hideDuringLessons:'上课时隐藏', offsetX:'水平偏移', offsetY:'垂直偏移', components:'组件', title:'标题', date:'日期', type:'类型',
    rotationSeconds:'轮播秒数', automation:'自动化', trigger:'触发时机', value:'设置值', minute:'时间', label:'名称', subject:'课程',
    teacher:'教师', room:'地点', weekday:'星期', weekType:'单双周', cancelled:'取消', bindingNote:'绑定备注', verified:'已核实', changes:'班级更名',
    url:'网站', page:'页码', query:'课件名称', find:'查找文字', application:'应用', file:'课件', control:'控件', note:'绑定备注', classNames:'授权班级',
    targetClassName:'改绑到班级', slotId:'作息时段', week:'单双周'};
  const values = {teacher:'班主任教师', grade_leader:'年级部长', director:'主任', principal:'校长', info:'普通', warning:'重要', urgent:'紧急',
    reading:'晨读', history:'通知', voice:'来音', all:'每周', odd:'单周', even:'双周', light:'浅色', dark:'深色', system:'跟随系统'};
  let root = null, timer = 0, epoch = 0;
  const cards = new Map(), operations = new Map();
  const api = (...args) => window.ICeClass.api(...args);
  const node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  const button = (text, fn, cls = 'bb-tool') => { const e = node('button', text, cls); e.type = 'button'; e.addEventListener('click', fn); return e; };
  function field(title, control) {
    const label = node('label', undefined, 'bb-operation-field');
    control.setAttribute('aria-label', title);
    if (control.id) control.name = control.id;
    if (!control.autocomplete) control.autocomplete = 'off';
    label.append(node('span', title), control); return label;
  }
  function updateCards(operation) {
    operations.set(operation.id, operation);
    window.dispatchEvent(new CustomEvent('banban-operation-updated', {detail: operation}));
    const set = cards.get(operation.id);
    if (set) for (const e of [...set]) { if (e.isConnected) paint(e, operation); else set.delete(e); }
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (!root || document.hidden && !window.ICeClassVoiceHost || document.getElementById('bbPanel')?.hidden) return;
    const pending = [...cards.entries()].some(([id, set]) => [...set].some(e => e.isConnected)
      && needsRefresh(operations.get(id)));
    if (pending) timer = setTimeout(refreshOperations, 1500);
  }
  function needsRefresh(operation) {
    return operation && (['running', 'stopping', 'awaiting_confirmation'].includes(operation.status)
      || operation.status === 'unconfirmed' && Date.now() < operation.expiresAt);
  }
  async function refreshOperations() {
    const generation = epoch;
    await Promise.allSettled([...cards.entries()].map(async ([id, set]) => {
      if (![...set].some(e => e.isConnected) || !needsRefresh(operations.get(id))) return;
      try {
        const operation = await api(`/api/banban/operations/${encodeURIComponent(id)}`);
        if (generation === epoch && root) updateCards(operation);
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
  function paint(card, operation) {
    // Preserve in-progress password entry and keyboard focus while polling.
    const signature = JSON.stringify([operation.status, operation.updatedAt, operation.result]);
    if (card.dataset.signature === signature) return;
    const previous = card.querySelector('input[type=password]')?.value || '';
    const previousStatus = card.dataset.state;
    const wasOpen = card.querySelector('.bb-operation-more')?.open;
    const focusedField = document.activeElement?.matches('input[type=password]') ? 'input[type=password]'
      : document.activeElement?.tagName === 'SUMMARY' ? 'summary' : null;
    const hadFocus = card.contains(document.activeElement) || card.dataset.restoreFocus === 'true';
    delete card.dataset.restoreFocus;
    card.dataset.signature = signature; card.dataset.state = operation.status;
    card.replaceChildren();
    const heading = node('div', undefined, 'bb-operation-heading');
    heading.append(node('strong', operation.title), node('span', labels[operation.status] || operation.status, 'bb-operation-state'));
    const succeeded = operation.status === 'succeeded';
    const sameState = previousStatus === operation.status;
    let content = card;
    if (succeeded) {
      const more = node('details', undefined, 'bb-operation-more bb-operation-record');
      more.open = sameState && Boolean(wasOpen);
      const summary = node('summary'); summary.append(heading);
      content = node('div', undefined, 'bb-operation-record-body');
      more.append(summary, content); card.append(more);
    } else card.append(heading);
    if (operation.target) content.append(node('p', operation.target, 'bb-operation-target'));
    const detail = operation.status === 'awaiting_confirmation' ? operation.impact : operation.result?.detail || operation.impact;
    if (detail) content.append(node('p', detail, 'bb-operation-detail'));
    if (operation.result?.coverage && operation.result.coverage !== detail) content.append(node('p', operation.result.coverage, 'bb-operation-detail'));
    if (operation.action === 'read_document' && operation.result?.text) {
      content.append(node('p', operation.result.text, 'bb-document-text'));
    }
    if (operation.parameters && Object.keys(operation.parameters).length) {
      if (succeeded) parameters(content, operation.parameters);
      else {
        const more = node('details', undefined, 'bb-operation-more');
        more.open = sameState ? Boolean(wasOpen) : operation.status === 'awaiting_confirmation';
        more.append(node('summary', '操作内容')); parameters(more, operation.parameters); content.append(more);
      }
    }
    const state = node('p', '', 'bb-operation-feedback'); state.setAttribute('role', 'status'); state.tabIndex = -1; card.append(state);
    const actions = node('div', undefined, 'bb-operation-actions');
    if (operation.status === 'awaiting_confirmation') {
      let password;
      if (operation.needsPassword) {
        password = node('input'); password.type = 'password'; password.name = 'newPassword'; password.autocomplete = 'new-password'; password.maxLength = 128; password.value = previous;
        card.append(field('新密码', password));
      }
      actions.append(button('确认执行', async e => {
        card.dataset.restoreFocus = String(card.contains(document.activeElement));
        actions.querySelectorAll('button').forEach(b => b.disabled = true);
        state.classList.remove('sr-only'); state.textContent = '正在提交…';
        const generation = epoch;
        try {
          const result = await api(`/api/banban/operations/${encodeURIComponent(operation.id)}/confirm`, {method:'POST', body:JSON.stringify({confirmed:true, ...(password ? {password:password.value} : {})})});
          if (password) password.value = '';
          if (generation !== epoch) return;
          updateCards(result);
          if (result.kind === 'platform' && result.status === 'succeeded') window.ICeClass.refreshManagement().catch(() => {});
        } catch (error) { if (generation === epoch) { delete card.dataset.restoreFocus; state.classList.remove('sr-only'); state.dataset.error = 'true'; state.textContent = error.message; actions.querySelectorAll('button').forEach(b => b.disabled = false); state.focus({preventScroll:true}); } }
      }, 'bb-send'));
    }
    if (['awaiting_confirmation','running','stopping'].includes(operation.status) || operation.kind === 'computer' && operation.status === 'unconfirmed') {
      actions.append(button(operation.status === 'awaiting_confirmation' ? '取消' : '停止操作', async () => {
        const generation = epoch;
        card.dataset.restoreFocus = String(card.contains(document.activeElement));
        actions.querySelectorAll('button').forEach(b => b.disabled = true);
        try { const data = await api(`/api/banban/operations/${encodeURIComponent(operation.id)}/cancel`, {method:'POST'}); if (generation === epoch) updateCards(data); }
        catch (error) { if (generation === epoch) { delete card.dataset.restoreFocus; state.classList.remove('sr-only'); state.dataset.error = 'true'; state.textContent = error.message; actions.querySelectorAll('button').forEach(b => b.disabled = false); state.focus({preventScroll:true}); } }
      }));
    }
    if (actions.children.length) card.append(actions);
    if (hadFocus) {
      const nextFocus = sameState && focusedField ? card.querySelector(focusedField) : succeeded ? card.querySelector('summary') : null;
      if (nextFocus) nextFocus.focus({preventScroll:true});
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
    operations.set(operation.id, operation); paint(card, operation); schedule(); return card;
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
  function dispose() { epoch++; clearTimeout(timer); cards.clear(); operations.clear(); root?.querySelector('#bbLauncher')?.removeEventListener('click', schedule); root = null; }
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
    updateCards(result);
    if (result.kind === 'platform' && result.status === 'succeeded') window.ICeClass.refreshManagement().catch(() => {});
    return result;
  }
  async function cancelVoice(ids) {
    const results = [];
    for (const id of ids) {
      const fresh = await api(`/api/banban/operations/${encodeURIComponent(id)}`);
      if (!['awaiting_confirmation','running','stopping','unconfirmed'].includes(fresh.status)) continue;
      const result = await api(`/api/banban/operations/${encodeURIComponent(id)}/cancel`, {method:'POST'});
      updateCards(result); results.push(result);
    }
    return results;
  }
  window.ICeClassBanbanOperations = {mount, dispose, render, hydrate, confirmVoice, cancelVoice};
})();

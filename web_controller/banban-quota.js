(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#settings-i-${name}"/></svg>`;
  const clone = value => structuredClone(value);
  const feedback = (id, message, type = '') => {
    $(id).textContent = message; $(id).className = `feedback ${type}`;
    $(id).setAttribute('role', type === 'error' ? 'alert' : 'status');
  };
  const allowed = () => window.ICeClass?.state.user?.role === 'superadmin'
    && !window.ICeClass.state.user.classroom && window.ICeClassVoiceHost?.classroomAccount !== true;
  const identity = () => allowed() ? window.ICeClass.state.user.id + ':' + window.ICeClass.state.csrf : '';
  const api = (...args) => window.ICeClass.api(...args);
  let owner = '', generation = 0, saved = null, conflict = false;
  const targets = {device:[], account:[]};
  let quota = {defaults:{device:null, account:null}, overrides:{}};
  let savedQuota = clone(quota), kind = 'device', quotaPage = 0, savingQuota = false;
  const openEditors = {device:null, account:null};
  const editorDrafts = {};
  const pageSize = 5;
  const custom = target => Object.hasOwn(quota.overrides, target.id);
  const limitOf = target => custom(target) ? quota.overrides[target.id] : quota.defaults[kind];
  const serialize = value => JSON.stringify({defaults:value.defaults, overrides:Object.entries(value.overrides).sort(([a],[b]) => a.localeCompare(b))});
  const quotaDirty = () => serialize(quota) !== serialize(savedQuota);
  const defaultMode = value => value === null ? 'unlimited' : value === 0 ? 'paused' : 'limited';
  const limitLabel = value => value === null ? '不限次数' : value === 0 ? '已停用' : `${value.toLocaleString()} 次 / 月`;
  const activeEditor = () => openEditors.device || openEditors.account;
  function pendingEditor() {
    const editorKind = openEditors[kind] ? kind : kind === 'device' ? 'account' : 'device';
    const key = openEditors[editorKind];
    if (!key) return null;
    const name = key === 'default' ? `${editorKind === 'device' ? '教室设备' : '教师账号'}默认规则`
      : targets[editorKind].find(target => target.id === key).name;
    return {kind:editorKind, key, name};
  }
  function updateQuotaFooter(message) {
    const dirty = quotaDirty(), pending = pendingEditor();
    $('quotaWorkspace').disabled = savingQuota || !saved || !allowed();
    $('quotaReload').disabled = savingQuota || !allowed();
    $('quotaSave').disabled = !saved || !allowed() || conflict || !dirty || savingQuota || Boolean(activeEditor());
    $('quotaSave').textContent = savingQuota ? '请稍候…' : '保存更改';
    $('banbanQuotaSection').setAttribute('aria-busy', String(savingQuota));
    $('quotaResume').disabled = savingQuota;
    $('quotaRevert').hidden = !dirty && !pending;
    $('quotaRevert').disabled = savingQuota;
    $('quotaResume').hidden = !pending;
    if (pending) $('quotaResume').setAttribute('aria-label', `继续调整${pending.name}`);
    if (savingQuota || !saved) return;
    if (conflict) { feedback('quotaStatus', '设置已在其他页面修改，请重新载入后核对。', 'error'); return; }
    if (pending) feedback('quotaStatus', `尚未确定：${pending.name}`, 'changed');
    else if (message) feedback('quotaStatus', message, dirty ? 'changed' : '');
    else feedback('quotaStatus', dirty ? '有未保存的更改' : '当前规则已保存', dirty ? 'changed' : '');
  }
  function filteredTargets() {
    const query = $('quotaSearch').value.trim().toLowerCase(), filter = $('quotaFilter').value;
    return targets[kind].filter(target => {
      const limit = limitOf(target);
      return `${target.name} ${target.detail}`.toLowerCase().includes(query)
        && (filter === 'all' || filter === 'custom' && custom(target) || filter === 'default' && !custom(target)
          || filter === 'exhausted' && limit !== null && limit > 0 && target.used >= limit);
    });
  }
  function renderDefault() {
    const value = quota.defaults[kind];
    $('defaultLabel').textContent = kind === 'device' ? '每台设备默认' : '每个账号默认';
    $('defaultValue').textContent = value === null ? '不限次数' : value === 0 ? '停用班班' : value.toLocaleString();
    $('defaultUnit').hidden = value === null || value === 0;
    $('defaultDirty').hidden = value === savedQuota.defaults[kind];
    const open = openEditors[kind] === 'default';
    $('editDefault').setAttribute('aria-expanded', String(open));
    $('defaultEditor').hidden = !open;
    $('defaultEditor').replaceChildren();
    if (open) $('defaultEditor').append(createEditor('default'));
  }
  function renderQuotaRows() {
    const rows = filteredTargets(), total = rows.length;
    quotaPage = Math.min(quotaPage, Math.max(0, Math.ceil(total / pageSize) - 1));
    $('quotaCount').textContent = `${total} ${kind === 'device' ? '台' : '个'}`;
    $('quotaIdentityHeading').textContent = kind === 'device' ? '教室设备' : '教师账号';
    $('quotaRows').setAttribute('aria-label', `${kind === 'device' ? '教室设备' : '教师账号'}本月用量`);
    const fragment = document.createDocumentFragment();
    for (const target of rows.slice(quotaPage * pageSize, (quotaPage + 1) * pageSize)) {
      const limit = limitOf(target), source = custom(target) ? '单独设置' : '沿用默认';
      const remaining = limit === null ? null : Math.max(0, limit - target.used);
      const tone = limit > 0 && remaining === 0 ? 'danger' : limit > 0 && remaining / limit < .1 ? 'warning' : '';
      const changed = custom(target) !== Object.hasOwn(savedQuota.overrides, target.id)
        || custom(target) && quota.overrides[target.id] !== savedQuota.overrides[target.id];
      const editing = openEditors[kind] === target.id;
      const li = document.createElement('li'); li.dataset.id = target.id; li.classList.toggle('editing', editing);
      const usage = limit === null ? '<p class="usage-none">不限次数</p>' : limit === 0 ? '<p class="usage-none">暂停新对话与操作</p>'
        : `<div class="usage-progress ${tone}" aria-hidden="true" ><i></i></div>`;
      const remainingText = limit === null ? '不限次' : limit === 0 ? '已停用' : `${remaining.toLocaleString()}<small>${remaining === 0 ? '已用完' : '次可用'}</small>`;
      li.innerHTML = `<div class="quota-overview"><div class="target-identity">${icon(kind === 'device' ? 'monitor' : 'user')}<div class="target-copy"><h3 class="target-name">${escape(target.name)}</h3><span class="muted">${escape(target.detail)}<span class="mobile-source">${source}</span></span></div></div><div class="usage" aria-label="本月已用 ${target.used} 次，${escape(limitLabel(limit))}"><strong class="usage-number">${target.used.toLocaleString()}<span>${limit !== null && limit > 0 ? `/ ${limit.toLocaleString()}` : '次'}</span></strong>${usage}</div><div class="remaining ${tone}" aria-label="剩余${limit === null ? '不限次数' : limit === 0 ? '已停用' : `${remaining} 次`}">${remainingText}</div><div class="rule-source">${source}${changed ? '<span class="draft-label">待保存</span>' : ''}</div><button id="adjust-${target.id}" class="row-adjust" type="button" data-adjust="${target.id}" aria-label="调整${escape(target.name)}的次数" aria-expanded="${editing}" aria-controls="editor-${target.id}">调整${icon('down')}</button></div>`;
      li.querySelector('.usage-progress')?.style.setProperty('--used-percent', Math.min(100, target.used / limit * 100) + '%');
      const editor = document.createElement('div'); editor.id = `editor-${target.id}`; editor.hidden = !editing;
      if (editing) { editor.className = 'inline-editor'; editor.append(createEditor(target.id)); }
      li.append(editor); fragment.append(li);
    }
    $('quotaRows').replaceChildren(fragment);
    $('quotaEmpty').hidden = total > 0;
    document.querySelector('.quota-table-head').hidden = total === 0;
    $('quotaPage').textContent = total ? `${quotaPage * pageSize + 1}-${Math.min(total, (quotaPage + 1) * pageSize)} / ${total}` : '0 个结果';
    $('quotaPrevious').disabled = quotaPage === 0;
    $('quotaNext').disabled = (quotaPage + 1) * pageSize >= total;
    updateQuotaFooter();
  }
  function createEditor(key) {
    const target = targets[kind].find(item => item.id === key), isDefault = key === 'default';
    const value = isDefault ? quota.defaults[kind] : limitOf(target);
    const draftKey = `${kind}:${key}`;
    const draft = editorDrafts[draftKey] || {mode:!isDefault && !custom(target) ? 'default' : defaultMode(value), value:value > 0 ? String(value) : '300'};
    editorDrafts[draftKey] = draft;
    const form = document.createElement('form'); form.noValidate = true;
    form.setAttribute('aria-label', isDefault ? '调整默认月度规则' : `调整${target.name}月度规则`);
    const modes = [...(!isDefault ? [['default', '沿用默认']] : []), ['limited', '设置上限'], ['unlimited', '不限次数'], ['paused', '停用班班']];
    form.innerHTML = `<fieldset><legend>${isDefault ? '调整默认规则' : `调整${escape(target.name)}`}</legend>${modes.map(([mode, label]) => `<label class="mode-choice"><input type="radio" name="mode-${draftKey}" value="${mode}" ${draft.mode === mode ? 'checked' : ''}>${label}</label>`).join('')}</fieldset><div class="editor-bottom"><div class="field editor-limit"><label for="limit-${draftKey}">每月上限（次）</label><input id="limit-${draftKey}" type="number" min="1" max="1000000" step="1" inputmode="numeric" autocomplete="off" name="monthlyLimit" value="${escape(draft.value)}"></div><p class="editor-help"></p><div class="editor-actions"><button class="button quiet" type="button" data-cancel-editor>取消</button><button class="button" type="submit">确定调整</button></div></div><p id="error-${draftKey}" class="form-error" role="alert"></p>`;
    const updateMode = () => {
      form.querySelector('.editor-limit').hidden = draft.mode !== 'limited';
      const defaultRule = limitLabel(quota.defaults[kind]);
      form.querySelector('.editor-help').textContent = isDefault ? '应用于沿用默认的对象，本月已用次数保留'
        : draft.mode === 'default' ? `当前默认：${defaultRule}。本月用量保留`
        : draft.mode === 'paused' ? '暂停新对话与操作，保留历史和本月用量'
        : `本月已用 ${target.used} 次，调整后保留用量`;
    };
    updateMode();
    form.addEventListener('change', event => {
      if (event.target.type === 'radio') { draft.mode = event.target.value; updateMode(); }
    });
    form.querySelector('input[type=number]').addEventListener('input', event => {
      draft.value = event.target.value;
      event.target.removeAttribute('aria-invalid'); form.querySelector('.form-error').textContent = '';
    });
    const close = () => {
      openEditors[kind] = null; delete editorDrafts[draftKey]; renderDefault(); renderQuotaRows();
      (isDefault ? $('editDefault') : $(`adjust-${key}`))?.focus({preventScroll:true});
    };
    form.querySelector('[data-cancel-editor]').addEventListener('click', close);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (savingQuota || !allowed()) return;
      let newLimit = draft.mode === 'unlimited' ? null : draft.mode === 'paused' ? 0 : Number(draft.value);
      if (draft.mode === 'limited' && (!draft.value.trim() || !Number.isSafeInteger(newLimit) || newLimit < 1 || newLimit > 1000000)) {
        const input = form.querySelector('input[type=number]'); input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', `error-${draftKey}`);
        form.querySelector('.form-error').textContent = '请输入 1-1000000 之间的整数。'; input.focus(); return;
      }
      if (isDefault) quota.defaults[kind] = newLimit;
      else if (draft.mode === 'default') delete quota.overrides[key];
      else quota.overrides[key] = newLimit;
      close();
    });
    return form;
  }
  function toggleEditor(key) {
    if (!saved || savingQuota || !allowed()) return;
    if (openEditors[kind] && openEditors[kind] !== key) {
      const current = openEditors[kind] === 'default' ? $('defaultEditor') : $(`editor-${openEditors[kind]}`);
      current?.scrollIntoView({block:'nearest',behavior:'instant'}); current?.querySelector('input:checked')?.focus();
      feedback('quotaStatus', '请先确定或取消当前调整。', 'changed'); return;
    }
    if (openEditors[kind] === key) delete editorDrafts[`${kind}:${key}`];
    openEditors[kind] = openEditors[kind] === key ? null : key;
    renderDefault(); renderQuotaRows();
    const region = key === 'default' ? $('defaultEditor') : $(`editor-${key}`);
    region?.querySelector('input:checked')?.focus({preventScroll:true});
  }
  $('editDefault').addEventListener('click', () => toggleEditor('default'));
  $('quotaRows').addEventListener('click', event => {
    const button = event.target.closest('[data-adjust]'); if (button) toggleEditor(button.dataset.adjust);
  });
  function changeKind(next) {
    kind = next; quotaPage = 0; $('quotaSearch').value = ''; $('quotaFilter').value = 'all';
    document.querySelectorAll('#banbanQuotaSection [data-kind]').forEach(tab => {
      const selected = tab.dataset.kind === kind;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    });
    $('quotaPanel').setAttribute('aria-labelledby', `tab-${kind}`);
    $('quotaSearch').placeholder = kind === 'device' ? '搜索班级或设备' : '搜索姓名或账号';
    renderDefault(); renderQuotaRows();
  }
  document.querySelectorAll('#banbanQuotaSection [data-kind]').forEach(tab => {
    tab.addEventListener('click', () => changeKind(tab.dataset.kind));
    tab.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 'device' : event.key === 'End' ? 'account' : kind === 'device' ? 'account' : 'device';
        changeKind(next); $(`tab-${next}`).focus();
      }
    });
  });
  $('quotaSearch').addEventListener('input', () => { quotaPage = 0; renderQuotaRows(); });
  $('quotaFilter').addEventListener('change', () => { quotaPage = 0; renderQuotaRows(); });
  $('clearQuotaSearch').addEventListener('click', () => {
    $('quotaSearch').value = ''; $('quotaFilter').value = 'all'; quotaPage = 0; renderQuotaRows(); $('quotaSearch').focus();
  });
  $('quotaPrevious').addEventListener('click', () => { quotaPage--; renderQuotaRows(); });
  $('quotaNext').addEventListener('click', () => { quotaPage++; renderQuotaRows(); });
  $('quotaResume').addEventListener('click', () => {
    const pending = pendingEditor(); if (!pending) return;
    changeKind(pending.kind);
    if (pending.key !== 'default') {
      quotaPage = Math.floor(targets[kind].findIndex(target => target.id === pending.key) / pageSize);
      renderQuotaRows();
    }
    const editor = pending.key === 'default' ? $('defaultEditor') : $(`editor-${pending.key}`);
    editor.scrollIntoView({block:'center', behavior:'instant'});
    editor.querySelector('input:checked')?.focus({preventScroll:true});
  });
  $('quotaRevert').addEventListener('click', () => {
    quota = clone(savedQuota); openEditors.device = null; openEditors.account = null;
    Object.keys(editorDrafts).forEach(key => delete editorDrafts[key]); renderDefault(); renderQuotaRows(); feedback('quotaStatus', '已撤销未保存的更改'); $('quotaSearch').focus();
  });
  function clearEditors() {
    openEditors.device = openEditors.account = null;
    Object.keys(editorDrafts).forEach(key => delete editorDrafts[key]);
  }
  function adopt(value) {
    saved = value; conflict = false; clearEditors();
    quota = {defaults:{device:value.deviceLimit, account:value.accountLimit}, overrides:{}};
    for (const targetKind of ['device','account']) {
      targets[targetKind] = value.targets.filter(target => target.kind === targetKind).map(target => ({...target,
        originalId:target.id, id:targetKind + '-' + encodeURIComponent(target.id),
        detail:target.detail + (target.enabled ? '' : ' · 已停用')}));
      for (const target of targets[targetKind]) if (target.source !== 'default') quota.overrides[target.id] = target.limit;
    }
    $('quotaDeviceCount').textContent = targets.device.length; $('quotaAccountCount').textContent = targets.account.length;
    $('banbanQuotaMonth').textContent = value.month;
    savedQuota = clone(quota); renderDefault(); renderQuotaRows();
  }
  async function load() {
    if (savingQuota || !allowed()) return;
    const request = ++generation, account = identity(); savingQuota = true; updateQuotaFooter();
    feedback('quotaStatus','正在读取次数设置…');
    try {
      const value = await api('/api/banban/quotas',{cache:'no-store'});
      if (request !== generation || identity() !== account) return;
      adopt(value); feedback('quotaStatus','当前规则已保存');
    } catch (error) {
      if (request === generation && identity() === account)
        feedback('quotaStatus',error instanceof TypeError ? '读取失败，请检查连接后重新载入。' : error.message,'error');
    } finally {
      if (request === generation && identity() === account) {
        savingQuota = false;
        // Retain load/error feedback; controls alone must not replace it.
        const message = $('quotaStatus').textContent, role = $('quotaStatus').getAttribute('role');
        updateQuotaFooter(); feedback('quotaStatus',message,role === 'alert' ? 'error' : '');
      }
    }
  }
  $('quotaSave').addEventListener('click', async () => {
    if (!saved || !allowed() || conflict || !quotaDirty() || activeEditor() || savingQuota) return;
    const request = ++generation, account = identity(); savingQuota = true; updateQuotaFooter(); feedback('quotaStatus','正在保存次数设置…');
    const overrides = [...targets.device,...targets.account].filter(custom).map(target => ({kind:target.kind,id:target.originalId,limit:quota.overrides[target.id]}));
    const body = {revision:saved.revision,deviceLimit:quota.defaults.device,accountLimit:quota.defaults.account,overrides};
    try {
      const value = await api('/api/banban/quotas',{method:'PUT',body:JSON.stringify(body)});
      if (request !== generation || identity() !== account) return;
      adopt(value); feedback('quotaStatus','已保存，即时生效。','success');
      window.dispatchEvent(new Event('iceclass-banban-quota-changed'));
    } catch (error) {
      if (request !== generation || identity() !== account) return;
      conflict = error.status === 409;
      feedback('quotaStatus',error instanceof TypeError ? '保存失败，修改已保留。请检查连接后重试。' : error.message,'error');
    } finally {
      if (request === generation && identity() === account) {
        savingQuota = false; const message = $('quotaStatus').textContent, type = $('quotaStatus').className;
        updateQuotaFooter(); feedback('quotaStatus',message,type.includes('error') ? 'error' : type.includes('success') ? 'success' : '');
      }
    }
  });
  $('quotaReload').addEventListener('click', () => {
    if ((quotaDirty() || activeEditor()) && !window.confirm('重新载入会放弃尚未保存的次数修改，继续吗？')) return;
    void load();
  });
  function init() {
    const account = identity(); $('banbanQuotaSection').classList.toggle('hidden',!account);
    if (account !== owner) {
      generation++; owner = account; saved = null; conflict = savingQuota = false; quotaPage = 0;
      targets.device = []; targets.account = []; quota = {defaults:{device:null,account:null},overrides:{}};
      savedQuota = clone(quota); clearEditors(); $('banbanQuotaMonth').textContent = '';
      changeKind('device'); $('defaultValue').textContent = '-'; feedback('quotaStatus',''); updateQuotaFooter();
    }
    if (account && window.ICeClassSettings?.visible && window.ICeClassSettings.section === 'quota' && !saved) void load();
  }
  window.addEventListener('iceclass-settings-section', event => { if (event.detail === 'quota' && !saved) void load(); });
  window.ICeClassBanbanQuota = {discardChanges() {
    quota = clone(savedQuota); clearEditors(); renderDefault(); renderQuotaRows();
  },canLogout() {
    if (!allowed()) return true;
    if (savingQuota) { window.ICeClass.toast('次数设置正在处理，请稍候。'); return false; }
    return !(quotaDirty() || activeEditor()) || window.confirm('次数修改尚未保存，放弃修改并退出登录吗？');
  }};
  window.addEventListener('beforeunload', event => {
    if (allowed() && (quotaDirty() || activeEditor() || savingQuota)) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('iceclass-ready',init); init();
})();

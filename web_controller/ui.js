(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const svgNS = 'http://www.w3.org/2000/svg';
  // Names come from the local workbench UI; icons are decorative beside readable labels.
  const icon = name => `<svg class="wb-icon" aria-hidden="true"><use href="#settings-i-${name}"/></svg>`;
  function iconNode(name) {
    const svg = document.createElementNS(svgNS, 'svg'), use = document.createElementNS(svgNS, 'use');
    svg.setAttribute('class', 'wb-icon');
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '#settings-i-' + name);
    svg.append(use);
    return svg;
  }
  function meter(value, max = 1) {
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return '';
    return `<meter class="wb-meter" aria-hidden="true" max="${max}" value="${Math.min(max, Math.max(0, value))}"></meter>`;
  }
  const escapeText = value => String(value).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  function metric(label, value, glyph, {unit = '', bar = '', className = ''} = {}) {
    return `<div class="wb-metric ${className}"><span class="wb-metric-label">${icon(glyph)}${escapeText(label)}</span><span><strong>${escapeText(value)}</strong>${unit ? ` <small>${escapeText(unit)}</small>` : ''}</span>${bar}</div>`;
  }
  const mobile = matchMedia('(max-width: 880px)');
  const switchGroups = '.mode-picker, #islandTabs, .ranking-switch, #readingGradeFilter, #classGradeFilter, #userRoleTabs, .island-duty-choices, .island-duty-weeks';
  function clearSwitchHeights() {
    document.querySelectorAll('main > .view').forEach(view => view.style.removeProperty('min-height'));
  }
  function keepSwitchViewport(event) {
    if (event.type === 'keydown' && !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const view = event.target.closest(switchGroups)?.closest('.view');
    if (!view) return;
    if (!window.scrollY) { view.style.removeProperty('min-height'); return; }
    // A shorter panel must not clamp the current scroll position. Reserve only
    // the remaining viewport, outside the cards; reset on navigation or resize.
    const bottom = parseFloat(getComputedStyle(view.parentElement).paddingBottom) || 0;
    view.style.minHeight = Math.max(0, Math.ceil(innerHeight - view.getBoundingClientRect().top - bottom)) + 'px';
  }
  document.addEventListener('click', keepSwitchViewport, true);
  document.addEventListener('keydown', keepSwitchViewport, true);
  window.addEventListener('resize', clearSwitchHeights);
  $('topbarDate').textContent = new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long'}).format(new Date());
  function closeNav(returnFocus = false) {
    document.body.classList.remove('nav-open'); $('menuToggle').setAttribute('aria-expanded', 'false');
    $('mainContent').inert = false; document.querySelector('.topbar').inert = false;
    if ($('banbanRoot')) $('banbanRoot').inert = false;
    $('appSidebar').removeAttribute('role'); $('appSidebar').removeAttribute('aria-modal');
    if (returnFocus) $('menuToggle').focus();
  }
  $('menuToggle').onclick = () => {
    if (document.body.classList.contains('nav-open')) return closeNav(true);
    document.body.classList.add('nav-open'); $('menuToggle').setAttribute('aria-expanded', 'true');
    $('mainContent').inert = true; document.querySelector('.topbar').inert = true;
    if ($('banbanRoot')) $('banbanRoot').inert = true;
    $('appSidebar').setAttribute('role', 'dialog'); $('appSidebar').setAttribute('aria-modal', 'true');
    $('mainNav').querySelector('button.active')?.focus();
  };
  $('sidebarClose').onclick = () => closeNav(true);
  $('navBackdrop').onclick = () => closeNav(true);
  const drafts = new Map();
  let leavingDocument = false, activeConfirmation = null, refreshConsent = null, contextRevision = 0;
  const dialog = $('workbenchConfirm');
  const dialogText = $('workbenchConfirmText'), dialogError = $('workbenchConfirmError');
  const accept = $('workbenchConfirmAccept'), cancel = $('workbenchConfirmCancel'), extra = $('workbenchConfirmExtra');
  async function ask({title, message, acceptLabel = '确认', cancelLabel = '取消', danger = false, additional}) {
    // close() clears open before the close event delivers the previous decision.
    while (activeConfirmation && !dialog.open) await activeConfirmation;
    if (dialog.open) return false;
    $('workbenchConfirmTitle').textContent = title;
    dialogText.textContent = message;
    dialogError.textContent = '';
    accept.textContent = acceptLabel;
    accept.classList.toggle('danger', danger);
    accept.classList.toggle('primary', !danger);
    cancel.textContent = cancelLabel;
    extra.hidden = !additional;
    extra.textContent = additional?.label || '';
    const controls = [...dialog.querySelectorAll('button')];
    const onCancel = event => { if (extra.disabled) event.preventDefault(); };
    activeConfirmation = new Promise(resolve => {
      dialog.addEventListener('cancel', onCancel);
      dialog.addEventListener('close', () => {
        dialog.removeEventListener('cancel', onCancel);
        activeConfirmation = null; accept.onclick = extra.onclick = null;
        resolve(dialog.returnValue === 'accept');
      }, {once:true});
      accept.onclick = () => dialog.close('accept');
      extra.onclick = async () => {
        controls.forEach(control => { control.disabled = true; });
        dialog.setAttribute('aria-busy', 'true'); dialogError.textContent = '';
        try {
          const error = await additional.run();
          if (error) dialogError.textContent = error;
          else dialog.close('accept');
        } catch (error) { dialogError.textContent = error.message || '保存失败，请重试。'; }
        finally {
          controls.forEach(control => { control.disabled = false; });
          dialog.removeAttribute('aria-busy');
          if (dialog.open) (extra.hidden ? cancel : extra).focus();
        }
      };
      dialog.returnValue = '';
      dialog.showModal(); cancel.focus();
    });
    return activeConfirmation;
  }
  function leaveState({exclude, only} = {}) {
    const dirty = [], busy = [];
    for (const [label, read] of drafts) {
      if (label === exclude || (only && ![].concat(only).includes(label))) continue;
      const value = read();
      if (value.dirty) dirty.push(label);
      if (value.busy) busy.push(label);
    }
    return {dirty, busy};
  }
  async function confirmLeave(action, {only, exclude, whenClean = false} = {}) {
    const {dirty, busy} = leaveState({only, exclude});
    if (busy.length) {
      window.ICeClass.toast('正在处理：' + busy.join('、') + '。请稍候再试。');
      return false;
    }
    if (!dirty.length && !whenClean) return true;
    const reading = !window.ICeClass.state.sessionExpired && dirty.includes('早读规则') && window.ICeClassReadingAdmin;
    const savesAll = reading && dirty.length === 1;
    const lose = dirty.length ? '未保存或尚未导出的内容：' + dirty.join('、') + '。' : '';
    if (!await ask({title: action + '？', message: lose + (dirty.length ? '继续后，上述内容将无法恢复。' : '工作台将重新载入。'),
      acceptLabel: dirty.length ? '放弃并继续' : action, cancelLabel: dirty.length ? '继续编辑' : '取消', danger: Boolean(dirty.length),
      additional: reading && {label: savesAll ? '保存并继续' : '保存早读规则，放弃其余修改', run: reading.saveBeforeLeave}})) return false;
    const current = leaveState({only, exclude});
    if (current.busy.length || current.dirty.some(label => !dirty.includes(label))) {
      window.ICeClass.toast('页面内容已变化，操作未执行。请重新确认。');
      return false;
    }
    return true;
  }
  function reloadConfirmed() {
    leavingDocument = true;
    location.reload();
    // An intercepted or failed navigation must not disable the next unload guard.
    setTimeout(() => { leavingDocument = false; }, 1000);
  }
  window.addEventListener('beforeunload', event => {
    if (leavingDocument) return;
    const state = leaveState();
    if (state.dirty.length || state.busy.length) { event.preventDefault(); event.returnValue = ''; }
  });

  const pendingFocus = new WeakMap();
  const keyOf = item => item.id ? '#' + item.id : JSON.stringify([item.tagName, item.name, item.type,
    [...item.attributes].filter(attr => attr.name.startsWith('data-') && attr.name !== 'data-dirty').map(attr => [attr.name, attr.value])]);
  const canFocus = item => item?.isConnected && !item.matches(':disabled, [aria-disabled=true]') &&
    !item.closest('[inert]') && item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden';
  function preserveFocus(root, update, fallback) {
    const controls = 'button, input, textarea, select, a[href], summary, [tabindex]';
    const active = document.activeElement;
    let saved = active === root ? pendingFocus.get(root) : undefined;
    if (active !== root && root.contains(active) && active.matches(controls)) {
      const key = keyOf(active);
      saved = {key, index: [...root.querySelectorAll(controls)].filter(item => keyOf(item) === key).indexOf(active)};
    }
    pendingFocus.delete(root);
    update();
    if (!saved || (document.activeElement !== document.body && document.activeElement !== root && document.activeElement !== active)) return;
    const item = [...root.querySelectorAll(controls)].filter(element => keyOf(element) === saved.key)[saved.index];
    if (canFocus(item)) item.focus({preventScroll:true});
    else if (item && item.matches(':disabled, [aria-disabled=true]') && item.getClientRects().length && canFocus(root)) {
      pendingFocus.set(root, saved); root.focus({preventScroll:true});
    } else {
      const next = fallback?.();
      if (canFocus(next)) next.focus({preventScroll:true});
      else if (canFocus(root)) root.focus({preventScroll:true});
    }
  }

  const menuItems = menu => [...menu.querySelectorAll('[role="menuitem"]')].filter(canFocus);
  function focusMenu(menu, last = false) { const items = menuItems(menu); (last ? items.at(-1) : items[0])?.focus({preventScroll:true}); }
  function menuKeys(menu, close) {
    menu.addEventListener('keydown', event => {
      if (!['ArrowDown','ArrowUp','Home','End','Escape','Tab'].includes(event.key) || event.defaultPrevented) return;
      if (event.key === 'Escape' || event.key === 'Tab') {
        close(true);
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
        return;
      }
      const items = menuItems(menu), index = items.indexOf(document.activeElement);
      if (!items.length) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items[next].focus({preventScroll:true});
    });
  }
  function bindActionMenu(details) {
    const trigger = details.querySelector(':scope > summary'), menu = details.querySelector('.action-menu-content');
    if (!trigger || !menu) return;
    trigger.setAttribute('aria-haspopup','menu'); trigger.setAttribute('aria-expanded',String(details.open));
    menu.setAttribute('role','menu');
    menu.querySelectorAll('button').forEach(item => item.setAttribute('role','menuitem'));
    const close = (restore = false) => { details.open = false; if (restore && canFocus(trigger)) trigger.focus({preventScroll:true}); };
    const open = last => { if (!canFocus(trigger)) return; details.open = true; focusMenu(menu, last); };
    details.addEventListener('toggle', () => trigger.setAttribute('aria-expanded',String(details.open)));
    trigger.addEventListener('click', event => { event.preventDefault(); if (details.open) close(); else open(false); });
    trigger.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault(); open(event.key === 'ArrowUp');
    });
    menuKeys(menu, close);
    // Put focus back before a menu item opens a dialog or replaces its row.
    menu.addEventListener('click', event => { if (event.target.closest('[role=menuitem]')) close(true); }, true);
  }
  document.querySelectorAll('details.action-menu').forEach(bindActionMenu);
  for (const type of ['pointerdown', 'focusin']) document.addEventListener(type, event => {
    document.querySelectorAll('.action-menu[open]').forEach(menu => {
      if (!menu.contains(event.target)) menu.open = false;
    });
  });
  const clearRefreshConsent = () => { refreshConsent = null; };
  for (const type of ['input','change','click']) document.addEventListener(type, clearRefreshConsent, true);
  const invalidateRefreshContext = () => { contextRevision++; clearRefreshConsent(); };
  window.addEventListener('iceclass-logout', invalidateRefreshContext);
  window.addEventListener('iceclass-view-changed', invalidateRefreshContext);
  window.addEventListener('iceclass-session-expired', () => {
    invalidateRefreshContext();
    if (dialog.open && !extra.hidden) {
      if (document.activeElement === extra) cancel.focus();
      extra.hidden = true;
    }
  });
  const sameRefreshContext = context => context.revision === contextRevision && context.url === location.href;
  async function confirmRefresh(token) {
    clearRefreshConsent();
    const context = {token, revision:contextRevision, url:location.href};
    if (!await confirmLeave('刷新页面', {whenClean:true})) return false;
    if (!sameRefreshContext(context)) {
      window.ICeClass.toast('登录状态或页面已变化，刷新未执行。');
      return false;
    }
    refreshConsent = {...context, dirty:leaveState().dirty};
    return true;
  }
  function reloadAfterConfirmation(token) {
    const consent = refreshConsent;
    if (!consent || token !== consent.token) return false;
    clearRefreshConsent();
    const current = leaveState();
    if (!sameRefreshContext(consent) || current.busy.length || current.dirty.some(label => !consent.dirty.includes(label))) return false;
    reloadConfirmed();
    return true;
  }
  window.ICeClassUI = {icon, iconNode, meter, metric, ask, confirmLeave, leaveState, confirmRefresh, reloadAfterConfirmation, reloadConfirmed, preserveFocus, bindActionMenu, menuKeys, focusMenu,
    registerDraft(label, read) { drafts.set(label, read); }};
  window.ICeClassUI.registerDraft('禁言时间表', () => ({dirty:window.ICeClass.state.quietScheduleDirty, busy:$('saveQuietSchedule').disabled && window.ICeClass.state.quietScheduleDirty}));
  window.ICeClassUI.registerDraft('待发送通知', () => ({dirty:Boolean($('shoutText').value.trim() || window.ICeClass.state.voiceBlob),
    busy:$('confirmSend').getAttribute('aria-disabled') === 'true' || window.ICeClass.state.voiceBusy}));
  mobile.addEventListener('change', () => closeNav());
  document.querySelector('.skip-link').addEventListener('click', event => {
    event.preventDefault(); $('mainContent').focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const dialog = event.target.closest?.('dialog[open]') || [...document.querySelectorAll('dialog[open]')].at(-1);
    if (!dialog) return;
    const items = [...dialog.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
      .filter(item => item.tabIndex >= 0 && !item.disabled && item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden');
    const first = items[0], last = items.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (!dialog.contains(document.activeElement) || event.shiftKey && document.activeElement === first) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });
  document.addEventListener('keydown', event => {
    if (!mobile.matches || !document.body.classList.contains('nav-open') || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeNav(true); }
    if (event.key !== 'Tab') return;
    const items = [...$('appSidebar').querySelectorAll('button, a')].filter(n => n.getClientRects().length && !n.disabled);
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  function syncNavigation() {
    const active = $('mainNav').querySelector('button.active');
    $('breadcrumbView').textContent = active?.querySelector('[data-label]')?.textContent || '早读统计';
    $('mainNav').querySelectorAll('[data-view]').forEach(button => {
      if (button === active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
  }
  window.addEventListener('iceclass-view-changed', () => {
    clearSwitchHeights(); syncNavigation();
    if (mobile.matches) { closeNav(); $('mainContent').focus({preventScroll: true}); }
    window.scrollTo({top: 0, behavior: 'instant'});
  });
  $('loginPasswordToggle').onclick = () => {
    const input = $('loginPassword'), visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    $('loginPasswordToggle').textContent = visible ? '隐藏' : '显示';
    $('loginPasswordToggle').setAttribute('aria-pressed', String(visible));
    $('loginPasswordToggle').setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  };
  function avatarLabel(user) {
    const username = (user.username || '').trim(), name = (user.displayName || username).trim();
    if (/^ice$/i.test(username)) return 'ICe';
    if (/^\p{Script=Han}/u.test(name)) {
      const compound = ['欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙', '慕容', '司徒', '司空', '夏侯', '令狐', '长孙', '宇文', '轩辕'];
      return compound.find(surname => name.startsWith(surname)) || [...name][0];
    }
    const initials = name.split(/\s+/).filter(Boolean);
    return initials.length > 1 ? initials.slice(0, 2).map(part => [...part][0]).join('').toUpperCase() : [...name].slice(0, 3).join('') || '师';
  }
  window.addEventListener('iceclass-ready', () => {
    const user = window.ICeClass.state.user;
    $('userAvatar').textContent = avatarLabel(user);
    $('userAvatar').title = user.displayName + '（' + user.username + '）';
    syncNavigation();
  });
  syncNavigation();
})();

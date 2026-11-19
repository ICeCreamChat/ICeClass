(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const host = window.ICeClassTeacherHost;
  const native = host?.workbenchHeader === true;
  const shell = $('appShell');
  const menus = [[$('headerToolsMenu'), $('headerToolsToggle')], [$('headerAccountMenu'), $('headerAccount')]];

  function syncHost() {
    if (native) host.setWorkbenchHeader(!shell.classList.contains('hidden'));
  }
  if (native) {
    document.body.classList.add('teacher-native-header');
    document.querySelectorAll('[data-header-native]').forEach(button => { button.hidden = false; });
    $('headerEnvironment').textContent = '桌面端';
    new MutationObserver(syncHost).observe(shell, {attributes: true, attributeFilter: ['class']});
  } else $('headerEnvironment').textContent = '网页端';
  syncHost();

  function position(menu, trigger) {
    const rect = trigger.getBoundingClientRect();
    menu.style.setProperty('--header-menu-top', Math.min(rect.bottom + 10, innerHeight - 64) + 'px');
    menu.style.setProperty('--header-menu-right', Math.max(16, innerWidth - rect.right) + 'px');
  }
  function closeMenus(restoreFocus = false) {
    for (const [menu, trigger] of menus) if (menu.matches(':popover-open')) {
      menu.hidePopover();
      if (restoreFocus) trigger.focus();
    }
  }
  const ui = window.ICeClassUI;
  for (const [menu, trigger] of menus) {
    let focusLast = false;
    menu.addEventListener('beforetoggle', event => { if (event.newState === 'open') position(menu, trigger); });
    menu.addEventListener('toggle', event => {
      trigger.setAttribute('aria-expanded', String(event.newState === 'open'));
      if (event.newState === 'open') { ui.focusMenu(menu, focusLast); focusLast = false; }
    });
    trigger.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault(); focusLast = event.key === 'ArrowUp';
      if (!menu.matches(':popover-open')) menu.showPopover({source:trigger});
      else { ui.focusMenu(menu, focusLast); focusLast = false; }
    });
    ui.menuKeys(menu, closeMenus);
  }
  function positionOpenMenus() {
    for (const [menu, trigger] of menus) if (menu.matches(':popover-open')) position(menu, trigger);
  }
  window.addEventListener('resize', positionOpenMenus);
  window.addEventListener('scroll', positionOpenMenus, {passive: true});

  const pending = new Set();
  document.querySelectorAll('[data-header-native]').forEach(button => button.addEventListener('click', async () => {
    closeMenus(true);
    if (!native) {
      if (button.dataset.headerNative !== 'teacher.refresh') return;
      const token = crypto.randomUUID();
      if (await ui.confirmRefresh(token) && !ui.reloadAfterConfirmation(token)) window.ICeClass.toast('页面内容已变化，刷新未执行。请重新确认。');
      return;
    }
    const action = button.dataset.headerNative;
    if (pending.has(action)) return;
    pending.add(action);
    const controls = [...document.querySelectorAll('[data-header-native]')].filter(item => item.dataset.headerNative === action);
    controls.forEach(item => item.setAttribute('aria-disabled', 'true'));
    try {
      const result = await host.execute(action, {}, crypto.randomUUID());
      if (!result.success && result.state !== 'cancelled') window.ICeClass.toast(result.detail || '操作未完成，请稍后重试。');
    } catch { window.ICeClass.toast('本机操作未完成，请重新打开工作台后再试。'); }
    finally {
      pending.delete(action);
      controls.forEach(item => item.removeAttribute('aria-disabled'));
    }
  }));
  document.querySelectorAll('[data-header-account]').forEach(button => button.addEventListener('click', async () => {
    closeMenus(true);
    const settings = $('mainNav').querySelector('[data-view="settings"]');
    if (!await window.ICeClass.selectView(settings)) return;
    if (button.dataset.headerAccount === 'password') window.ICeClassSettings?.select('account');
    (button.dataset.headerAccount === 'password' ? $('currentPassword') : $('mainContent')).focus({preventScroll:false});
  }));
  $('logoutButton').addEventListener('click', () => closeMenus(true), {capture:true});
  $('menuToggle').addEventListener('click', () => closeMenus());
  window.addEventListener('iceclass-ready', () => {
    const user = window.ICeClass.state.user;
    $('headerAccountName').textContent = user.displayName;
    $('headerAccountRole').textContent = $('userRole').textContent;
    $('headerAccount').setAttribute('aria-label', user.displayName + '，账号菜单');
    $('headerAccount').title = user.displayName + '（' + user.username + '）';
    syncHost();
  });
})();

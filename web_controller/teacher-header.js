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
    menu.style.setProperty('--header-trigger-right', rect.right + 'px');
  }
  let currentMenu = null;
  function closeMenu(restoreFocus = false) {
    if (!currentMenu) return;
    const {menu, trigger} = currentMenu;
    currentMenu = null;
    menu.hidePopover?.();
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({preventScroll:true});
  }
  const ui = window.ICeClassUI;
  for (const [menu, trigger] of menus) {
    // Use the top layer when available. Both engines use HTML hidden for the closed state.
    if (menu.showPopover) menu.popover = 'manual';
    function openMenu(last = false) {
      if (menu.hidden) {
        closeMenu();
        position(menu, trigger);
        menu.hidden = false;
        menu.showPopover?.({source:trigger});
        currentMenu = {menu, trigger};
        trigger.setAttribute('aria-expanded', 'true');
      }
      ui.focusMenu(menu, last);
    }
    trigger.addEventListener('click', () => { if (menu.hidden) openMenu(); else closeMenu(true); });
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openMenu(event.key === 'ArrowUp');
      } else if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        closeMenu(true);
      }
    });
    ui.menuKeys(menu, closeMenu);
  }
  function dismissOutside(event) {
    if (currentMenu && !currentMenu.menu.contains(event.target) && !currentMenu.trigger.contains(event.target)) closeMenu();
  }
  document.addEventListener('pointerdown', dismissOutside, true);
  document.addEventListener('focusin', dismissOutside, true);
  function positionOpenMenu() {
    if (!currentMenu) return;
    const {menu, trigger} = currentMenu;
    if (trigger.getClientRects().length) position(menu, trigger);
    else {
      closeMenu();
      $('teacherRefresh').focus({preventScroll:true});
    }
  }
  window.addEventListener('resize', positionOpenMenu);
  window.addEventListener('scroll', positionOpenMenu, {passive:true});
  window.addEventListener('iceclass-view-changed', () => closeMenu(true));
  window.addEventListener('iceclass-logout', () => closeMenu());
  window.addEventListener('iceclass-session-expired', () => closeMenu());
  window.addEventListener('pagehide', () => closeMenu());

  const pending = new Set();
  document.querySelectorAll('[data-header-native]').forEach(button => button.addEventListener('click', async () => {
    closeMenu(true);
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
    closeMenu(true);
    const settings = $('mainNav').querySelector('[data-view="settings"]');
    if (!await window.ICeClass.selectView(settings)) return;
    if (button.dataset.headerAccount === 'password') window.ICeClassSettings?.select('account');
    (button.dataset.headerAccount === 'password' ? $('currentPassword') : $('mainContent')).focus({preventScroll:false});
  }));
  $('logoutButton').addEventListener('click', () => closeMenu(true), {capture:true});
  $('menuToggle').addEventListener('click', () => closeMenu());
  window.addEventListener('iceclass-ready', () => {
    const user = window.ICeClass.state.user;
    $('headerAccountName').textContent = user.displayName;
    $('headerAccountRole').textContent = $('userRole').textContent;
    $('headerAccount').setAttribute('aria-label', user.displayName + '，账号菜单');
    $('headerAccount').title = user.displayName + '（' + user.username + '）';
    syncHost();
  });
})();

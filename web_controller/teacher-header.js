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

  function items(menu) {
    return [...menu.querySelectorAll('[role="menuitem"]')].filter(item => !item.disabled && item.getClientRects().length);
  }
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
  for (const [menu, trigger] of menus) {
    let focusLast = false;
    menu.addEventListener('beforetoggle', event => { if (event.newState === 'open') position(menu, trigger); });
    menu.addEventListener('toggle', event => {
      trigger.setAttribute('aria-expanded', String(event.newState === 'open'));
      if (event.newState === 'open') {
        const choices = items(menu);
        (focusLast ? choices.at(-1) : choices[0])?.focus();
        focusLast = false;
      }
    });
    trigger.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault(); focusLast = event.key === 'ArrowUp'; menu.showPopover();
      const choices = items(menu);
      (event.key === 'ArrowUp' ? choices.at(-1) : choices[0])?.focus();
    });
    menu.addEventListener('keydown', event => {
      const choices = items(menu), current = choices.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.hidePopover(); trigger.focus(); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
        choices[index]?.focus();
      }
    });
  }
  window.addEventListener('resize', () => { for (const [menu, trigger] of menus) if (menu.matches(':popover-open')) position(menu, trigger); });
  window.addEventListener('scroll', () => closeMenus(), {passive: true});

  document.querySelectorAll('[data-header-native]').forEach(button => button.addEventListener('click', async () => {
    closeMenus(true);
    if (!native) {
      if (button.dataset.headerNative === 'teacher.refresh' && confirm('刷新工作台？请先保存尚未提交的内容。')) location.reload();
      return;
    }
    const action = button.dataset.headerNative;
    const controls = [...document.querySelectorAll('[data-header-native]')].filter(item => item.dataset.headerNative === action);
    controls.forEach(item => { item.disabled = true; });
    try {
      const result = await host.execute(action, {}, crypto.randomUUID());
      if (!result.success && result.state !== 'cancelled') window.ICeClass.toast(result.detail || '操作未完成，请稍后重试。');
    } catch { window.ICeClass.toast('本机操作未完成，请重新打开工作台后再试。'); }
    finally { controls.forEach(item => { item.disabled = false; }); }
  }));
  document.querySelectorAll('[data-header-account]').forEach(button => button.addEventListener('click', () => {
    closeMenus();
    const settings = $('mainNav').querySelector('[data-view="settings"]');
    settings.click();
    if (!settings.classList.contains('active')) return;
    if (button.dataset.headerAccount === 'password') window.ICeClassSettings?.select('account');
    (button.dataset.headerAccount === 'password' ? $('currentPassword') : $('mainContent')).focus({preventScroll:false});
  }));
  $('logoutButton').addEventListener('click', () => closeMenus(true));
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

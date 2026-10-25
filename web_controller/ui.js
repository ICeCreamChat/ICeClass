(() => {
  'use strict';
  const $ = id => document.getElementById(id);
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
  document.addEventListener('click', event => {
    document.querySelectorAll('.action-menu[open]').forEach(menu => {
      if (!menu.contains(event.target) || event.target.closest('.action-menu-content button')) menu.open = false;
    });
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('.action-menu[open]').forEach(menu => {
      event.preventDefault(); menu.open = false; menu.querySelector('summary').focus();
    });
  });
  mobile.addEventListener('change', () => closeNav());
  document.querySelector('.skip-link').addEventListener('click', event => {
    event.preventDefault(); $('mainContent').focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
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
    if (!mobile.matches || !document.body.classList.contains('nav-open')) return;
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
  $('mainNav').addEventListener('click', event => {
    if (!event.target.closest('[data-view]')) return;
    clearSwitchHeights();
    syncNavigation();
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
  window.addEventListener('iceclass-ready', async () => {
    const user = window.ICeClass.state.user;
    $('userAvatar').textContent = avatarLabel(user);
    $('userAvatar').title = user.displayName + '（' + user.username + '）';
    syncNavigation();
    try {
      const response = await fetch('/api/session', {cache:'no-store'});
      if (response.headers.get('X-ICeClass-Preview') === '1' && !document.getElementById('previewNotice')) {
        const notice = document.createElement('p'); notice.id = 'previewNotice'; notice.className = 'preview-notice';
        notice.textContent = '本地验收 · 当前展示演示数据。';
        $('mainContent').prepend(notice);
      }
    } catch {}
  });
  syncNavigation();
})();

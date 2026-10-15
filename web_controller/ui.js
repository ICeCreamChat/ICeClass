(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const mobile = matchMedia('(max-width: 880px)');
  const kickers = { reading: '晨读有声 · 成长有迹', console: '连接课堂 · 传递关心', 'classroom-voice': '来自教室 · 听见同学', controls: '你的教室 · 随时连接', history: '每一次通知 · 都有回应', quiet: '留一份安静 · 给专注的课堂', classes: '班级空间 · 一起成长', teachers: '校园协同 · 各司其职', settings: '账号与设备 · 安心相伴' };
  for (const [view, text] of Object.entries(kickers)) {
    const heading = $(`view-${view}`)?.querySelector('.view-head > div');
    if (!heading) continue;
    const kicker = document.createElement('span'); kicker.className = 'page-kicker'; kicker.textContent = text; heading.prepend(kicker);
  }
  $('topbarDate').textContent = new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long'}).format(new Date());
  function closeNav(returnFocus = false) {
    document.body.classList.remove('nav-open'); $('menuToggle').setAttribute('aria-expanded', 'false');
    if (returnFocus) $('menuToggle').focus();
  }
  $('menuToggle').onclick = () => {
    if (document.body.classList.contains('nav-open')) return closeNav(true);
    document.body.classList.add('nav-open'); $('menuToggle').setAttribute('aria-expanded', 'true');
    $('mainNav').querySelector('button.active')?.focus();
  };
  $('sidebarClose').onclick = () => closeNav(true);
  $('navBackdrop').onclick = () => closeNav(true);
  mobile.addEventListener('change', () => closeNav());
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
  window.addEventListener('iceclass-ready', async () => {
    $('userAvatar').textContent = window.ICeClass.state.user.username.slice(0, 2).toUpperCase();
    syncNavigation();
    try {
      const response = await fetch('/api/session', {cache:'no-store'});
      if (response.headers.get('X-ICeClass-Preview') === '1' && !document.getElementById('previewNotice')) {
        const notice = document.createElement('p'); notice.id = 'previewNotice'; notice.className = 'preview-notice';
        notice.textContent = '本地验收 · 此处的班级、设备与成绩为演示数据，用于检查界面和功能。';
        $('mainContent').prepend(notice);
      }
    } catch {}
  });
  syncNavigation();
})();

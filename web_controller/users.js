(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const labels = {principal: '校长', director: '主任', grade_leader: '年级部', teacher: '班主任', subject_teacher: '任课老师'};
  const roles = ['principal', 'director', 'grade_leader', 'teacher', 'subject_teacher'];
  const hasRole = (user, role) => user.role === role || role === 'subject_teacher' && user.role === 'teacher' && !!user.teachingClasses?.length;
  const filters = {role: 'all', page: 1};
  const pageSize = 12;
  let context;
  let menuTrigger;
  function node(tag, text, cls) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (cls) item.className = cls;
    return item;
  }
  function grade(name) {
    const match = String(name).normalize('NFKC').replace(/\s/g, '').match(/^高([一二三123])(?=[^0-9]|$)/);
    return match ? '高' + ({1: '一', 2: '二', 3: '三'}[match[1]] || match[1]) : '其他';
  }
  function scope(user) {
    if (user.role === 'principal') return ['全校管理', ''];
    if (user.role === 'director') return ['高一 · 高二 · 高三', ''];
    if (user.role === 'grade_leader') return [user.grade ? user.grade + '全部班级' : '待分配年级', ''];
    const heads = (user.headClasses || []).map(c => c.name).join('、');
    const teaching = (user.teachingClasses || []).map(c => c.name).join('、');
    return user.role === 'teacher' ? [heads ? '带班：' + heads : '待分配带班班级', teaching ? '任教：' + teaching : '']
      : [teaching ? '任教：' + teaching : '待分配任教班级', ''];
  }
  function matchesGrade(user, selected) {
    if (selected === 'all') return true;
    if (user.role === 'principal') return true;
    if (user.role === 'director') return ['高一', '高二', '高三'].includes(selected);
    if (user.role === 'grade_leader') return user.grade === selected;
    return (user.classes || []).some(c => grade(c.name) === selected);
  }
  function isUnassigned(user) {
    return user.role === 'teacher' && !user.headClasses?.length
      || user.role === 'subject_teacher' && !user.teachingClasses?.length
      || user.role === 'grade_leader' && !user.grade;
  }
  function button(text, handler, cls = 'btn') {
    const item = node('button', text, cls); item.type = 'button'; item.onclick = handler; return item;
  }
  function closeMenu(returnFocus = false) {
    const menu = $('userActionsPopover');
    if (menu?.matches(':popover-open')) menu.hidePopover();
    if (returnFocus && menuTrigger?.isConnected) menuTrigger.focus();
  }
  function more(user, anchor) {
    const menu = $('userActionsPopover');
    const alreadyOpen = menu.matches(':popover-open') && menu.dataset.user === user.id;
    closeMenu();
    if (alreadyOpen) return;
    menuTrigger = anchor;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', user.display_name + '的账号操作');
    menu.dataset.user = user.id;
    menu.replaceChildren(node('span', user.display_name + '的账号', 'user-menu-title'));
    for (const [label, action, danger] of [
      ['重置密码', () => context.onPassword(user)],
      [Number(user.enabled) === 1 ? '停用账号' : '启用账号', () => context.onToggle(user)],
      ['删除账号', () => context.onDelete(user), true]
    ]) {
      const item = button(label, () => { closeMenu(); action(); }, 'btn' + (danger ? ' danger' : ''));
      item.setAttribute('role', 'menuitem'); menu.append(item);
    }
    menu.showPopover();
    const box = anchor.getBoundingClientRect(), menuBox = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(innerWidth - menuBox.width - 8, box.right - menuBox.width)) + 'px';
    menu.style.top = (box.bottom + menuBox.height + 8 <= innerHeight ? box.bottom + 6 : Math.max(8, box.top - menuBox.height - 6)) + 'px';
    menu.querySelector('button')?.focus();
  }
  function draw() {
    if (!context) return;
    closeMenu();
    const users = context.teachers;
    const tabs = $('userRoleTabs');
    const visibleRoles = roles.filter(role => users.some(user => hasRole(user, role)) || context.user.permissions?.assignableRoles?.includes(role));
    if (filters.role !== 'all' && !visibleRoles.includes(filters.role)) filters.role = 'all';
    const existingTabs = new Map([...tabs.children].map(tab => [tab.dataset.roleFilter, tab]));
    for (const [role, tab] of existingTabs) if (role !== 'all' && !visibleRoles.includes(role)) tab.remove();
    for (const role of ['all', ...visibleRoles]) {
      const count = role === 'all' ? users.length : users.filter(u => hasRole(u, role)).length;
      let tab = existingTabs.get(role);
      if (!tab) {
        tab = button(role === 'all' ? '全部用户' : labels[role], () => { filters.role = role; filters.page = 1; draw(); }, 'user-role-tab');
        tab.dataset.roleFilter = role;
        tab.append(node('span', '', 'user-tab-count')); tabs.append(tab);
      }
      const badge = tab.querySelector('.user-tab-count');
      if (badge.textContent !== String(count)) badge.textContent = String(count);
      tab.setAttribute('aria-pressed', String(filters.role === role));
    }
    const keyword = $('userSearch').value.trim().toLocaleLowerCase();
    const selectedGrade = $('userGradeFilter').value, status = $('userStatusFilter').value;
    const result = users.filter(u => (filters.role === 'all' || hasRole(u, filters.role))
      && (!keyword || [u.display_name, u.username, ...roles.filter(role => hasRole(u, role)).map(role => labels[role]), ...scope(u)].some(v => v.toLocaleLowerCase().includes(keyword)))
      && matchesGrade(u, selectedGrade)
      && (status === 'all' || status === 'unassigned' && isUnassigned(u) || status === 'enabled' && Number(u.enabled) === 1 || status === 'disabled' && Number(u.enabled) !== 1))
      .sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role) || Number(isUnassigned(b)) - Number(isUnassigned(a)) || ['高一','高二','高三','其他'].indexOf(a.grade || grade(a.classes?.[0]?.name)) - ['高一','高二','高三','其他'].indexOf(b.grade || grade(b.classes?.[0]?.name)) || scope(a)[0].localeCompare(scope(b)[0], 'zh-CN', {numeric: true}) || a.display_name.localeCompare(b.display_name, 'zh-CN'));
    const pages = Math.max(1, Math.ceil(result.length / pageSize)); filters.page = Math.min(filters.page, pages);
    $('userResultCount').textContent = `共 ${result.length} 位用户`;
    $('userUnassigned').textContent = `待分配 ${users.filter(isUnassigned).length}`;
    $('userUnassigned').hidden = !users.some(isUnassigned);
    $('userPageLabel').textContent = `${filters.page} / ${pages}`;
    $('userPrevPage').disabled = filters.page === 1; $('userNextPage').disabled = filters.page === pages;
    $('userPagination').hidden = !result.length;
    const container = $('teachersContainer'); container.replaceChildren();
    if (!result.length) {
      const empty = node('div', undefined, 'empty');
      empty.append(node('strong', users.length ? '没有符合条件的用户' : '还没有用户账号'), node('span', users.length ? '尝试调整筛选条件或搜索关键词。' : '点击“创建用户”，选择身份并分配管理范围。'));
      if (users.length) empty.append(button('清除筛选', reset)); container.append(empty); return;
    }
    const table = node('table', undefined, 'users-table'), head = table.createTHead().insertRow();
    for (const label of ['用户', '身份', '管理范围', '状态', '操作']) { const th = node('th', label); th.scope = 'col'; head.append(th); }
    const body = table.createTBody();
    for (const user of result.slice((filters.page - 1) * pageSize, filters.page * pageSize)) {
      const row = body.insertRow(), identity = node('div', undefined, 'user-identity');
      identity.append(node('span', [...user.display_name][0] || '师', 'user-list-avatar'));
      const name = node('div'); name.append(node('strong', user.display_name), node('small', user.username)); identity.append(name); row.insertCell().append(identity);
      const badges = node('div', undefined, 'user-role-badges');
      for (const role of roles.filter(role => hasRole(user, role))) badges.append(node('span', labels[role], 'user-role-badge role-' + role));
      row.insertCell().append(badges);
      const range = row.insertCell(), [title, hint] = scope(user); range.className = 'user-scope';
      range.append(node('span', title, isUnassigned(user) ? 'user-unassigned' : ''));
      if (hint) range.append(node('small', hint));
      row.insertCell().append(node('span', Number(user.enabled) === 1 ? '启用' : '已停用', 'status ' + (Number(user.enabled) === 1 ? 'enabled' : 'disabled')));
      const actions = node('div', undefined, 'user-row-actions');
      if (user.canManage) {
        actions.append(button('编辑权限', () => context.onEdit(user), 'btn user-edit'));
        const moreButton = button('更多', () => more(user, moreButton)); moreButton.setAttribute('aria-label', user.display_name + '的更多操作'); moreButton.setAttribute('aria-haspopup', 'menu');
        moreButton.setAttribute('aria-controls', 'userActionsPopover'); moreButton.setAttribute('aria-expanded', 'false'); actions.append(moreButton);
      } else actions.append(node('span', '当前账号', 'hint'));
      row.insertCell().append(actions);
    }
    const wrap = node('div', undefined, 'table-wrap users-table-wrap'); wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', '用户列表，可左右滚动'); wrap.append(table); container.append(wrap);
  }
  function reset() { filters.role = 'all'; filters.page = 1; $('userSearch').value = ''; $('userGradeFilter').value = 'all'; $('userStatusFilter').value = 'all'; draw(); }
  for (const id of ['userSearch', 'userGradeFilter', 'userStatusFilter']) $(id).addEventListener(id === 'userSearch' ? 'input' : 'change', () => { filters.page = 1; draw(); });
  $('userUnassigned').onclick = () => { $('userStatusFilter').value = 'unassigned'; filters.role = 'all'; filters.page = 1; draw(); };
  $('userClearFilters').onclick = reset;
  $('userPrevPage').onclick = () => { filters.page--; draw(); };
  $('userNextPage').onclick = () => { filters.page++; draw(); };
  $('userActionsPopover').addEventListener('toggle', event => menuTrigger?.setAttribute('aria-expanded', String(event.newState === 'open')));
  $('userActionsPopover').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...$('userActionsPopover').querySelectorAll('button')];
    const current = items.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[index]?.focus();
  });
  window.addEventListener('resize', () => closeMenu()); window.addEventListener('scroll', () => closeMenu(), true);
  window.ICeClassUsers = {render(value) { context = value; draw(); }};
  window.dispatchEvent(new Event('iceclass-users-ready'));
})();

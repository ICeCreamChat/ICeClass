(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const DAY = 86400000;
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const iso = value => new Date(value).toISOString().slice(0, 10);
  const stamp = day => Date.parse(day + 'T00:00:00Z');
  const duration = value => { const s = Math.max(0, Math.floor(value || 0)); return s >= 3600 ? `${Math.floor(s / 3600)} 时 ${Math.floor(s % 3600 / 60)} 分` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`; };
  const level = s => !s ? 0 : s < 300 ? 1 : s < 600 ? 2 : s < 1200 ? 3 : 4;
  const dateLabel = day => new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(stamp(day)));
  function node(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
  let initialized = false, generation = 0, loadedKey = '', inFlightKey = '', selected = '', focusDay = '', lastFetched = 0;
  let daily = new Map(), buttons = new Map(), tooltip, activeTip = null;
  const key = () => $('calendarClass').value + '/' + $('calendarYear').value;
  const count = (r, name) => Number(r?.[name]) || 0;

  function message(text, isError = false) {
    $('calendarMessage').textContent = text;
    $('calendarMessage').classList.toggle('hidden', !text);
    $('calendarMessage').dataset.error = String(isError);
    $('calendarRetry').classList.toggle('hidden', !isError);
  }
  function hideTip() { activeTip = null; if (tooltip) tooltip.classList.add('hidden'); }
  function describe(day) {
    const row = daily.get(day);
    return `${day} ${dateLabel(day)}\n` + (row ? `有效发声 ${duration(row.effectiveSeconds)} · ${row.sessions} 次使用` : '无软件记录');
  }
  function showTip(button) {
    hideTip();
    if (button.disabled) return;
    activeTip = button;
    tooltip.textContent = describe(button.dataset.day); tooltip.classList.remove('hidden');
    const rect = button.getBoundingClientRect(), box = tooltip.getBoundingClientRect();
    tooltip.style.left = Math.max(12, Math.min(innerWidth - box.width - 12, rect.left + rect.width / 2 - box.width / 2)) + 'px';
    tooltip.style.top = (rect.top > box.height + 12 ? rect.top - box.height - 9 : rect.bottom + 9) + 'px';
  }
  function scrollToDay(day) {
    const button = buttons.get(day); if (!button) return;
    const scroll = $('calendarScroll'), rect = button.getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
    if (rect.left < viewport.left + 8 || rect.right > viewport.right - 8) scroll.scrollLeft += rect.left - viewport.left - viewport.width / 2;
  }
  function selectDay(day, moveFocus = false) {
    const target = buttons.get(day); if (!target || target.disabled) return;
    if (buttons.has(selected)) buttons.get(selected).setAttribute('aria-pressed', 'false');
    if (buttons.has(focusDay)) buttons.get(focusDay).tabIndex = -1;
    selected = focusDay = day; target.tabIndex = 0; target.setAttribute('aria-pressed', 'true');
    $('calendarDate').value = day;
    updateDetail();
    if (moveFocus) { target.focus({ preventScroll: true }); scrollToDay(day); }
  }
  function updateDetail() {
    const row = daily.get(selected), c = row?.completed || {};
    $('calendarDayTitle').textContent = dateLabel(selected);
    $('calendarDayStatus').textContent = row ? count(row, 'effectiveSeconds') > 0 ? '已记录当天晨读活动' : '有运行记录，尚无达标发声' : '暂无软件记录，不代表当天没有早读。';
    const completion = [['carrots', '颗萝卜'], ['poems', '篇诗词'], ['badges', '次徽章'], ['launches', '次发射'], ['energy', '格能量']].filter(([k]) => c[k]).map(([k, label]) => `${c[k]} ${label}`).join('、') || '暂无完成记录';
    $('calendarDayDetail').replaceChildren(...[
      ['有效发声', duration(count(row, 'effectiveSeconds'))], ['运行时长', duration(count(row, 'activeSeconds'))], ['使用次数', count(row, 'sessions') + ' 次'], ['完成量', completion]
    ].map(([label, value]) => { const item = node('div'); item.append(node('dt', label), node('dd', value)); return item; }));
  }
  function buildGrid(year) {
    hideTip(); buttons = new Map();
    const start = stamp(`${year}-01-01`), end = stamp(`${year}-12-31`), offset = (new Date(start).getUTCDay() + 6) % 7;
    const weeks = Math.ceil(((end - start) / DAY + 1 + offset) / 7), currentDay = today();
    const grid = $('calendarGrid'), months = $('calendarMonths'); grid.replaceChildren(); months.replaceChildren();
    grid.style.setProperty('--weeks', weeks); months.style.setProperty('--weeks', weeks);
    for (let month = 0; month < 12; ++month) {
      const label = node('span', `${month + 1}月`), position = Math.floor(((Date.UTC(year, month, 1) - start) / DAY + offset) / 7) + 1;
      label.style.gridColumn = position; label.style.gridRow = 1; months.append(label);
    }
    const fragment = document.createDocumentFragment();
    for (let at = start, index = offset; at <= end; at += DAY, ++index) {
      const day = iso(at), button = node('button', undefined, 'calendar-cell');
      button.type = 'button'; button.dataset.day = day; button.tabIndex = -1;
      button.disabled = day > currentDay; button.style.gridRow = index % 7 + 1; button.style.gridColumn = Math.floor(index / 7) + 1;
      button.dataset.today = String(day === currentDay); button.setAttribute('aria-pressed', 'false');
      buttons.set(day, button); fragment.append(button);
    }
    grid.append(fragment);
    $('calendarDate').min = `${year}-01-01`; $('calendarDate').max = currentDay.startsWith(String(year)) ? currentDay : `${year}-12-31`;
    selected = selected.startsWith(String(year)) && buttons.has(selected) && !buttons.get(selected).disabled ? selected : currentDay.startsWith(String(year)) ? currentDay : `${year}-12-31`;
    focusDay = selected;
  }
  function render(data, rebuild) {
    daily = new Map(data.daily.map(r => [r.day, r]));
    if (rebuild) buildGrid(Number($('calendarYear').value));
    const currentDay = today();
    buttons.forEach((button, day) => {
      const row = daily.get(day); button.dataset.level = level(count(row, 'effectiveSeconds'));
      button.disabled = day > currentDay; button.dataset.today = String(day === currentDay);
      button.dataset.running = String(count(row, 'activeSeconds') > 0);
      button.setAttribute('aria-label', describe(day).replace('\n', '，') + (button.disabled ? '，未来日期' : ''));
    });
    $('calendarDate').max = currentDay.startsWith($('calendarYear').value) ? currentDay : $('calendarYear').value + '-12-31';
    const total = data.daily.reduce((n, r) => n + r.effectiveSeconds, 0), days = data.daily.filter(r => r.activeSeconds > 0).length;
    const lead = node('span'); lead.append(document.createTextNode(`${$('calendarYear').value} 年 · 有效发声 `), node('strong', duration(total)));
    const used = node('span'); used.append(node('strong', days + ' 天'), document.createTextNode(' 有使用记录'));
    const times = node('span'); times.append(node('strong', data.daily.reduce((n, r) => n + r.sessions, 0) + ' 次'), document.createTextNode(' 晨读活动'));
    $('calendarSummary').replaceChildren(lead, used, times);
    message(data.daily.length ? '' : '这一年还没有软件记录。每一次在统计时段内的晨读，都会留在这里。');
    $('calendarBody').classList.remove('hidden');
    selectDay(selected);
    if (rebuild) requestAnimationFrame(() => scrollToDay(selected));
    if (activeTip) showTip(activeTip);
  }
  async function refresh(force = false) {
    if (!initialized || !$('calendarClass').value) return;
    const requestedKey = key();
    if (inFlightKey === requestedKey || !force && requestedKey === loadedKey && Date.now() - lastFetched < 14000) return;
    const request = ++generation, changed = requestedKey !== loadedKey;
    inFlightKey = requestedKey;
    if (changed) { hideTip(); daily = new Map(); $('calendarBody').classList.add('hidden'); $('calendarSummary').replaceChildren(); message('正在读取全年记录…'); }
    $('readingCalendar').setAttribute('aria-busy', 'true');
    try {
      const year = $('calendarYear').value;
      const data = await window.ICeClass.api('/api/reading/report?' + new URLSearchParams({ start: year + '-01-01', end: year + '-12-31', classId: $('calendarClass').value }));
      if (request !== generation || key() !== requestedKey) return;
      render(data, changed); loadedKey = requestedKey; lastFetched = Date.now();
    } catch (error) {
      if (request === generation) message('日历暂时无法更新：' + error.message, true);
    } finally {
      if (request === generation) { inFlightKey = ''; $('readingCalendar').setAttribute('aria-busy', 'false'); }
    }
  }
  function syncClasses() {
    if (!initialized) return;
    const select = $('calendarClass'), previous = select.value;
    select.replaceChildren(...window.ICeClass.state.classes.map(c => new Option(c.name, c.id)));
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
    select.disabled = !select.options.length; $('calendarYear').disabled = select.disabled;
    if (!select.options.length) {
      ++generation; inFlightKey = loadedKey = ''; hideTip(); $('calendarBody').classList.add('hidden'); $('calendarSummary').replaceChildren();
      $('readingCalendar').setAttribute('aria-busy', 'false'); message('还没有获授权的班级。');
    }
  }
  function initialize() {
    if (initialized || !window.ICeClass?.state.user) return;
    initialized = true;
    const year = Number(today().slice(0, 4));
    for (let y = year; y >= year - 8; --y) $('calendarYear').append(new Option(y + ' 年', y));
    tooltip = node('div', undefined, 'calendar-tooltip hidden'); tooltip.setAttribute('aria-hidden', 'true'); document.body.append(tooltip);
    syncClasses();
    ['calendarClass', 'calendarYear'].forEach(id => $(id).addEventListener('change', () => void refresh(true)));
    $('calendarRetry').onclick = () => void refresh(true);
    $('calendarDate').onchange = () => { selectDay($('calendarDate').value); scrollToDay(selected); };
    const grid = $('calendarGrid');
    grid.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { selectDay(b.dataset.day); hideTip(); } });
    grid.addEventListener('pointerover', e => { const b = e.target.closest('button'); if (b) showTip(b); });
    grid.addEventListener('pointerout', hideTip);
    grid.addEventListener('focusin', e => { if (e.target.dataset.day) showTip(e.target); });
    grid.addEventListener('focusout', hideTip);
    grid.addEventListener('keydown', e => {
      if (e.key === 'Escape') { hideTip(); return; }
      const delta = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[e.key];
      if (!delta || !e.target.dataset.day) return;
      e.preventDefault(); selectDay(iso(stamp(e.target.dataset.day) + delta * DAY), true);
    });
    $('calendarScroll').addEventListener('scroll', hideTip, { passive: true });
    window.addEventListener('scroll', hideTip, { passive: true }); window.addEventListener('resize', hideTip);
    void refresh();
  }
  window.ICeClassCalendar = { initialize, syncClasses, refresh };
  window.addEventListener('iceclass-ready', initialize);
  initialize();
})();

(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const modes = { classic: '兔拔萝卜', carving: '诗词镌刻', particle: '粒子浮雕', rocket: '火箭升空' };
  const syncLabels = { current: '已同步', pending: '待补传', review: '待核实', unconfirmed: '待同步确认' };
  const duration = seconds => `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  let view = 'chart', selectedClass = '', latest = null, lastRange = '', chartScroll = 0;
  function node(tag, text, cls) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  function icon(path, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    if (cls) svg.setAttribute('class', cls);
    const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', path); svg.append(p); return svg;
  }
  function syncBadge(row) {
    const badge = node('span', syncLabels[row.sync?.state] || syncLabels.unconfirmed, 'ranking-sync');
    badge.dataset.state = row.sync?.state || 'unconfirmed'; return badge;
  }
  function classButton(row, cls) {
    const b = node('button', undefined, cls); b.type = 'button'; b.dataset.classId = row.classId;
    b.setAttribute('aria-label', `查看${row.className}的早读日历，有效发声${duration(row.effectiveSeconds)}，${syncLabels[row.sync?.state] || syncLabels.unconfirmed}`);
    b.onclick = () => window.ICeClassCalendar.showClass(row.classId, latest.end);
    b.classList.toggle('is-selected', row.classId === selectedClass);
    return b;
  }
  function rank(row) {
    const badge = node('span', row.rank === null ? '—' : String(row.rank).padStart(2, '0'), 'ranking-number');
    badge.dataset.rank = row.rank ?? ''; badge.setAttribute('aria-label', row.rank === null ? '暂无名次' : `第${row.rank}名`); return badge;
  }
  function sparkline(row, report) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 180 35'); svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'ranking-spark'); svg.setAttribute('aria-hidden', 'true');
    // Include zero-record dates; a gap must not become invented activity.
    const start = Date.parse(report.start + 'T00:00:00Z'), end = Date.parse(report.end + 'T00:00:00Z');
    const daily = new Map(report.daily.filter(r => r.className === row.className).map(r => [r.day, r.effectiveSeconds]));
    const points = [];
    for (let at = start; at <= end; at += 86400000) points.push(daily.get(new Date(at).toISOString().slice(0, 10)) || 0);
    if (points.length < 2) return null;
    const max = Math.max(1, ...points), path = document.createElementNS(svg.namespaceURI, 'polyline');
    path.setAttribute('points', points.map((value, i) => `${i * 180 / (points.length - 1)},${33 - value * 29 / max}`).join(' '));
    svg.append(path); return svg;
  }
  function leaders(report) {
    const rows = report.rows.filter(row => row.activeSeconds > 0).slice(0, 3);
    const wrap = node('div', undefined, 'ranking-leaders');
    wrap.setAttribute('aria-label', '前三名');
    rows.forEach(row => {
      const card = classButton(row, 'ranking-leader'); card.dataset.rank = row.rank;
      const top = node('span', undefined, 'leader-top');
      const tied = report.rows.filter(other => other.rank === row.rank).length > 1;
      const medal = node('span', undefined, 'leader-medal');
      medal.append(icon('M8 3h8v3a4 4 0 0 1-8 0V3ZM8 4H5v2a4 4 0 0 0 4 4m7-6h3v2a4 4 0 0 1-4 4m-3 0v5m-4 4h8m-7-4h6v4H9z'));
      const place = node('span', undefined, 'leader-place');
      place.append(node('span', `${tied ? '并列' : ''}第 ${row.rank} 名`), syncBadge(row));
      top.append(place, medal);
      const number = node('span', undefined, 'leader-score');
      number.append(node('strong', Math.floor(row.effectiveSeconds / 60)), node('small', '分'), node('strong', row.effectiveSeconds % 60), node('small', '秒'));
      card.append(top, node('strong', row.className, 'leader-class'), number);
      const bottom = node('span', undefined, 'leader-bottom');
      bottom.append(node('span', `${row.sessions} 次使用 · ${row.ratio === null ? '—' : row.ratio + '%'} 达标`), node('span', '查看日历 ↗'));
      card.append(bottom);
      const line = sparkline(row, report); if (line) card.append(line);
      wrap.append(card);
    });
    while (wrap.children.length < 3) {
      const place = wrap.children.length + 1, card = node('div', undefined, 'ranking-leader leader-vacant');
      const top = node('span', undefined, 'leader-top'); top.append(node('span', `第 ${place} 名`, 'leader-place'));
      card.append(top, node('strong', '待上榜', 'leader-class'), node('span', '—', 'leader-vacant-score'), node('span', '等待更多班级同步成绩', 'leader-bottom'));
      wrap.append(card);
    }
    return wrap;
  }
  function chart(report, animate) {
    const section = node('div'); section.id = 'rankingChart';
    section.dataset.animate = String(animate);
    section.append(leaders(report));
    const max = Math.max(0, ...report.rows.map(row => row.effectiveSeconds));
    // Keep a 30-minute reference even for very short records, rather than enlarging seconds into a full-height column.
    const scale = Math.max(1800, Math.ceil(max / 600) * 600);
    const caption = node('div', undefined, 'ranking-chart-caption');
    const label = node('div', undefined, 'ranking-chart-label');
    label.append(node('strong', '班级成绩对比'), node('span', `${report.grades?.join(' + ') || '全部年级'} · ${report.rows.length} 个班级 · 点击打开日历`));
    const legend = node('span', undefined, 'ranking-grade-legend');
    ['高一', '高二', '高三', '其他'].filter(grade => report.rows.some(row => row.grade === grade)).forEach(grade => {
      const item = node('span', grade); item.dataset.grade = grade; legend.append(item);
    });
    if (legend.children.length > 1) label.append(legend);
    const controls = node('div', undefined, 'ranking-scroll-controls');
    for (const [direction, text] of [[-1, '←'], [1, '→']]) {
      const b = node('button', text); b.type = 'button'; b.dataset.direction = direction;
      b.setAttribute('aria-label', direction < 0 ? '查看前面的班级' : '查看后面的班级');
      b.setAttribute('aria-controls', 'rankingScroll');
      b.onclick = () => {
        const scroll = $('rankingScroll');
        scroll.scrollBy({ left: direction * scroll.clientWidth * .8, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      };
      controls.append(b);
    }
    caption.append(label, controls);
    section.append(caption);
    const stage = node('div', undefined, 'ranking-stage'), axis = node('div', undefined, 'ranking-y-axis'); axis.setAttribute('aria-hidden', 'true');
    for (const fraction of [1, 2 / 3, 1 / 3, 0]) {
      const tick = node('span', Math.round(scale * fraction / 6) / 10 + '分');
      tick.style.bottom = fraction * 100 + '%'; axis.append(tick);
    }
    const scroll = node('div', undefined, 'ranking-scroll'); scroll.id = 'rankingScroll';
    scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', '横向班级成绩图，可以左右滚动'); scroll.tabIndex = 0;
    const list = node('ol', undefined, 'ranking-columns'); list.setAttribute('aria-label', '班级从左到右按有效发声时长排列');
    report.rows.forEach(row => {
      const item = node('li'), b = classButton(row, 'ranking-column'); b.dataset.rank = row.rank ?? '';
      b.dataset.grade = row.grade || '其他';
      const plot = node('span', undefined, 'ranking-column-plot');
      plot.style.setProperty('--score', row.effectiveSeconds / scale);
      const value = node('strong', `${Math.floor(row.effectiveSeconds / 60)}分${row.effectiveSeconds % 60}秒`, 'ranking-column-value');
      const fill = node('span', undefined, 'ranking-column-fill'); fill.setAttribute('aria-hidden', 'true');
      if (!row.effectiveSeconds) fill.classList.add('is-zero');
      plot.append(value, fill);
      const info = node('span', undefined, 'ranking-column-info');
      info.append(rank(row), node('strong', row.className, 'ranking-class'), syncBadge(row), node('span', row.activeSeconds ? `${row.sessions} 次 · 达标 ${row.ratio}%` : '暂无已同步记录', 'ranking-column-meta'), node('span', '查看日历 ↗', 'ranking-column-link'));
      b.append(plot, info); item.append(b); list.append(item);
    });
    list.addEventListener('keydown', event => {
      const button = event.target.closest('.ranking-column'); if (!button) return;
      const items = [...list.querySelectorAll('.ranking-column')], index = items.indexOf(button);
      const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: items.length - 1 }[event.key];
      if (next === undefined || !items[next]) return;
      event.preventDefault(); items[next].focus({ preventScroll: true }); items[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    scroll.append(list); stage.append(axis, scroll); section.append(stage);
    scroll.addEventListener('scroll', updateScroll, { passive: true });
    const foot = node('div', undefined, 'ranking-axis');
    foot.append(node('span', `有效发声 · 统一 0–${Math.round(scale / 60)} 分钟刻度`), node('span', max ? `当前最高 ${duration(max)}` : '尚无有效发声记录'));
    section.append(foot); return section;
  }
  function table(report) {
    const wrap = node('div', undefined, 'table-wrap'); wrap.id = 'rankingTable';
    const t = node('table'), head = t.createTHead().insertRow();
    ['名次', '班级', '使用次数 / 天数', '运行时长', '有效发声', '达标占比', '模式', '完成量', '同步'].forEach(label => {
      const th = node('th', label); th.scope = 'col'; head.append(th);
    });
    const body = t.createTBody();
    report.rows.forEach(row => {
      const b = classButton(row, 'ranking-table-link'); b.textContent = row.className;
      const tags = node('div'); row.modes.forEach(mode => tags.append(node('span', modes[mode] || mode, 'mode-tag')));
      const completed = [['carrots', '颗萝卜'], ['poems', '篇诗词'], ['badges', '次徽章'], ['launches', '次发射'], ['energy', '格能量']]
        .filter(([key]) => row.completed[key]).map(([key, label]) => row.completed[key] + label).join('、') || '—';
      const tr = body.insertRow();
      [rank(row), b, `${row.sessions} 次 / ${row.days} 天`, duration(row.activeSeconds), duration(row.effectiveSeconds), row.ratio === null ? '—' : row.ratio + '%', tags, completed, syncBadge(row)].forEach(value => tr.insertCell().append(value instanceof Node ? value : document.createTextNode(value)));
    });
    wrap.append(t); return wrap;
  }
  function setView(next) {
    if (view === 'chart' && next !== 'chart') chartScroll = $('rankingScroll')?.scrollLeft ?? chartScroll;
    view = next;
    $('rankingChartView').setAttribute('aria-pressed', String(view === 'chart'));
    $('rankingTableView').setAttribute('aria-pressed', String(view === 'table'));
    $('rankingChart')?.classList.toggle('hidden', view !== 'chart');
    $('rankingTable')?.classList.toggle('hidden', view !== 'table');
    if (view === 'chart') {
      const restore = chartScroll;
      requestAnimationFrame(() => { if ($('rankingScroll')) $('rankingScroll').scrollLeft = restore; updateScroll(); });
    }
  }
  function render(report) {
    latest = report;
    const range = report.start + '/' + report.end + '/' + report.rows.map(row => row.classId).sort().join(',');
    const root = $('readingRanking'), scroll = range === lastRange ? (view === 'chart' ? ($('rankingScroll')?.scrollLeft ?? chartScroll) : chartScroll) : 0;
    const focused = root.contains(document.activeElement) ? { id: document.activeElement.dataset.classId, cls: document.activeElement.className.split(' ')[0] } : null;
    root.replaceChildren(chart(report, range !== lastRange), table(report)); lastRange = range;
    if (!report.rows.length) {
      const empty = report.grades?.length ? '所选年级暂无获授权班级，可以切换年级查看。' : '还没有获授权的班级。';
      $('rankingChart').replaceChildren(node('div', empty, 'empty'));
      $('rankingTable').replaceChildren(node('div', empty, 'empty'));
    }
    chartScroll = scroll;
    root.setAttribute('aria-busy', 'false'); setView(view);
    if ($('rankingScroll')) $('rankingScroll').scrollLeft = scroll;
    requestAnimationFrame(updateScroll);
    if (focused?.id) [...root.querySelectorAll('button[data-class-id]')].find(button => button.dataset.classId === focused.id && button.classList.contains(focused.cls))?.focus({ preventScroll: true });
  }
  function updateScroll() {
    const scroll = $('rankingScroll'); if (!scroll) return;
    if (view === 'chart' && scroll.clientWidth) chartScroll = scroll.scrollLeft;
    document.querySelectorAll('.ranking-scroll-controls button').forEach(button => {
      button.disabled = Number(button.dataset.direction) < 0 ? scroll.scrollLeft < 2 : scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 2;
    });
  }
  $('rankingChartView').onclick = () => setView('chart');
  $('rankingTableView').onclick = () => setView('table');
  window.addEventListener('resize', updateScroll);
  window.addEventListener('iceclass-calendar-selected', event => {
    selectedClass = event.detail.classId;
    document.querySelectorAll('#readingRanking button[data-class-id]').forEach(button => button.classList.toggle('is-selected', button.dataset.classId === selectedClass));
  });
  window.ICeClassRanking = { render };
})();

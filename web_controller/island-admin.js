(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = (...args) => window.ICeClass.api(...args);
  const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const weekNames = { all: '每周', odd: '单周', even: '双周' };
  const tabs = ['timetable', 'duties', 'slots', 'overrides', 'settings', 'components', 'automation'];
  const dutyNames = { midday: '午间静校', evening: '晚自习' };
  const schedule = window.ICeClassIslandSchedule;
  let dutyKind = 'midday', dutyWeek = 1;
  let dutyDrafts = {};
  let profile, config, dirty = false, busy = false, loadedClass = '', tab = 'timetable', week = 'all';
  let fieldId = 0, loadId = 0, polling = false, livePreview = true, previewOpen = false;
  const ribbon = new window.ICeClassIslandRibbon($('islandPreview'), $('islandPreviewStage'));
  ribbon.onChange = updatePreviewControls;
  const workspaceHead = document.querySelector('.island-workspace-head');
  new ResizeObserver(() => {
    const height = workspaceHead.getBoundingClientRect().height + (parseFloat(getComputedStyle(workspaceHead).top) || 0) + 16;
    $('view-island').style.setProperty('--island-sticky-height', Math.ceil(height) + 'px');
  }).observe(workspaceHead);
  function updateTableOverflow() {
    const root = $('islandTabContent');
    root.dataset.tableOverflow = String([...root.querySelectorAll('.table-wrap')].some(node => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1));
  }
  new ResizeObserver(updateTableOverflow).observe($('islandTabContent'));

  const clock = n => Number.isFinite(n) ? `${Math.floor(n / 60)}`.padStart(2, '0') + ':' + `${n % 60}`.padStart(2, '0') : '';
  const minute = value => /^\d{2}:\d{2}$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const nowClock = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const className = () => $('islandClass').selectedOptions[0]?.text || '班级配置';
  const validDate = schedule.validDate;
  const isClassroom = value => !value || ['本班', '本班教室', '本教室'].includes(value.trim());

  function el(tag, text, cls) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }
  function keyed(node, path, focusKey = path) {
    if (path) node.dataset.path = path;
    if (focusKey) node.dataset.focusKey = focusKey;
    return node;
  }
  function button(label, action, cls = 'btn', focusKey) {
    const node = keyed(el('button', label, cls), null, focusKey);
    node.type = 'button';
    node.onclick = action;
    return node;
  }
  function clearFieldError(node) {
    node.setCustomValidity?.('');
    node.removeAttribute('aria-invalid');
    const errorId = node.dataset.errorId;
    if (errorId) {
      $(errorId)?.remove();
      node.setAttribute('aria-describedby', (node.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== errorId).join(' '));
      delete node.dataset.errorId;
    }
  }
  function input(value, action, type = 'text', extra = {}, path, tracked = true) {
    const node = keyed(el('input'), path);
    node.type = type;
    node.name = path || '';
    node.autocomplete = 'off';
    Object.assign(node, extra);
    if (type === 'checkbox') node.checked = !!value;
    else node.value = value ?? '';
    node.addEventListener('input', () => {
      clearFieldError(node);
      action(type === 'checkbox' ? node.checked : type === 'number' ? (node.value === '' ? null : Number(node.value)) : node.value);
      if (tracked) mark();
    });
    return node;
  }
  function select(value, choices, action, path, tracked = true) {
    const node = keyed(el('select'), path);
    node.name = path || '';
    choices.forEach(([key, label]) => node.append(new Option(label, key)));
    node.value = value;
    node.onchange = () => { clearFieldError(node); action(node.value); if (tracked) mark(); };
    return node;
  }
  function area(value, action, maximum, path) {
    const node = keyed(el('textarea'), path);
    node.name = path || '';
    node.autocomplete = 'off';
    node.value = value || '';
    node.maxLength = maximum;
    node.rows = 2;
    node.oninput = () => { clearFieldError(node); action(node.value.replace(/[\r\n\t]+/g, ' ')); mark(); };
    return node;
  }
  function field(label, control, hint, cls = '') {
    const wrap = el('div', undefined, 'island-field' + (cls ? ' ' + cls : ''));
    control.id ||= `island-field-${++fieldId}`;
    control.name ||= label;
    const caption = el('label', label);
    caption.htmlFor = control.id;
    wrap.append(caption, control);
    if (hint) {
      const note = el('small', hint);
      note.id = control.id + '-hint';
      control.setAttribute('aria-describedby', note.id);
      wrap.append(note);
    }
    return wrap;
  }
  function toggle(label, object, key, path, hint, changed) {
    const wrap = el('label', undefined, 'island-toggle');
    const control = input(object[key], value => { object[key] = value; changed?.(); }, 'checkbox', {}, path);
    control.name ||= key;
    const copy = el('span');
    copy.append(el('span', label));
    if (hint) {
      const note = el('small', hint);
      note.id = `island-toggle-hint-${++fieldId}`;
      control.setAttribute('aria-describedby', note.id);
      copy.append(note);
    }
    wrap.append(control, copy);
    return wrap;
  }
  function switchToggle(label, object, key, path, hint, changed) {
    const node = toggle(label, object, key, path, hint, changed);
    node.classList.add('island-switch');
    node.querySelector('input').setAttribute('role', 'switch');
    return node;
  }
  function disabled(control, value) {
    control.disabled = value;
    control.closest('.island-field, .island-toggle')?.classList.toggle('is-disabled', value);
  }
  function needsSave() {
    return !!config && (dirty || (profile?.revision === 0 && config.slots.length > 0));
  }
  function status(message) {
    $('view-island').dataset.dirty = String(dirty);
    $('islandEditingClass').textContent = loadedClass ? className() : '班级配置';
    $('islandDirty').textContent = message || (dirty ? '有未保存的修改' : profile?.revision ? `版本 ${profile.revision} · 已保存` : needsSave() ? '已带入年级默认作息 · 尚未保存' : '尚未保存配置');
    $('islandSave').disabled = busy || !needsSave();
  }
  function mark() {
    dirty = true;
    $('islandError').textContent = '';
    status();
    renderPreview();
  }
  function showError(error, focus = true) {
    const node = $('islandError');
    node.textContent = error.message || String(error);
    if (focus && !$('view-island').classList.contains('hidden')) {
      node.focus({ preventScroll: true });
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }
  function setBusy(value, label) {
    busy = value;
    $('islandEditor').inert = value || !config;
    $('islandEditor').setAttribute('aria-busy', String(value));
    $('islandSave').disabled = value || !needsSave();
    $('islandSave').textContent = label || '保存并下发';
    $('islandReload').disabled = value;
    $('islandClass').disabled = value;
    ['islandCopy', 'islandImport', 'islandExport', 'islandImportFile'].forEach(id => $(id).disabled = value || !config);
    updatePreviewControls();
  }
  function regularLesson(slotId, weekday, scope) {
    return config.lessons.find(l => l.slotId === slotId && l.weekday === weekday && l.week === scope)
      || (scope !== 'all' ? config.lessons.find(l => l.slotId === slotId && l.weekday === weekday && l.week === 'all') : null);
  }
  function scheduleFor(on) {
    return schedule.forDate(config, on);
  }
  function componentName(component) {
    return component.title || { date: '日期', countdown: '倒数日', text: '班级寄语' }[component.type];
  }
  function componentText(component, on) {
    if (component.type === 'date') return validDate(on) ? on.replaceAll('-', '.') + ' ' + weekdays[(new Date(on + 'T12:00:00Z').getUTCDay() + 6) % 7] : '日期';
    if (component.type === 'countdown') {
      const days = Math.round((Date.parse(component.date + 'T12:00:00Z') - Date.parse(on + 'T12:00:00Z')) / 86400000);
      return `${component.title || '倒数日'} · ${Number.isFinite(days) ? days > 0 ? `还有 ${days} 天` : days === 0 ? '就是今天' : `已过 ${-days} 天` : '请选择日期'}`;
    }
    return component.text || component.title || '尚未填写文字';
  }
  function renderPreview() {
    if (!config) return;
    if (livePreview) {
      if (document.activeElement !== $('islandPreviewDate')) $('islandPreviewDate').value = today();
      if (document.activeElement !== $('islandPreviewTime')) $('islandPreviewTime').value = nowClock();
    }
    const on = $('islandPreviewDate').value, m = minute($('islandPreviewTime').value);
    const lessons = scheduleFor(on);
    const current = m === null ? null : lessons.find(l => l.start <= m && m < l.end);
    const next = m === null ? null : lessons.find(l => l.start > m);
    const message = !validDate(on) || m === null ? '请选择完整的预览日期和时间'
      : current ? `${current.subject} · 距下课 ${current.end - m} 分钟`
      : next ? `下节 ${next.subject} · ${clock(next.start)}`
      : lessons.length ? '当日课程已结束' : '这一天没有课程';
    const valid = validDate(on) && m !== null;
    if (!valid && previewOpen) ribbon.pause();
    const firstLesson = config.lessons.find(l => config.slots.some(s => s.id === l.slotId));
    const demoLesson = lessons[0] || (firstLesson && { ...config.slots.find(s => s.id === firstLesson.slotId), ...firstLesson }) || { subject: '示例课程', start: 480, end: 525 };
    const second = livePreview ? new Date().getSeconds() : 0;
    ribbon.update({ date: on, minute: m, second, live: livePreview, valid,
      epochSeconds: valid ? Date.parse(on + 'T' + clock(m) + ':00+08:00') / 1000 + second : NaN,
      lessons, demoLesson, enabled: config.enabled, appearance: config.appearance, reminders: config.reminders,
      components: config.components.filter(c => c.enabled).map(c => ({ id: c.id, title: componentName(c), text: componentText(c, on) })),
      rotationSeconds: config.rotationSeconds, message, classId: loadedClass, className: className() });
    $('islandPreviewSummary').textContent = !config.enabled ? '教室浮岛已关闭。保存后，教室端将隐藏悬浮岛。'
      : current && config.appearance.hideDuringLessons ? `上课期间自动隐藏 · ${message}` : message;
    $('islandTodayTitle').textContent = `当日课程${lessons.length ? ` · ${lessons.length} 节` : ''}`;
    $('islandTabContent').querySelectorAll('[data-component-preview]').forEach(node => {
      const component = config.components.find(c => c.id === node.dataset.componentPreview);
      if (component) node.textContent = componentText(component, on);
    });
    updatePreviewControls();
  }
  function updatePreviewControls() {
    const valid = !!config && !busy && validDate($('islandPreviewDate').value) && minute($('islandPreviewTime').value) !== null;
    const state = ribbon.currentState, scene = ribbon.scene;
    $('islandPreviewToggle').disabled = !previewOpen && !valid;
    $('islandPreviewToggle').textContent = previewOpen ? '收起预览' : '预览浮岛';
    $('islandPreviewToggle').setAttribute('aria-expanded', String(previewOpen));
    $('islandPreviewPanel').dataset.open = String(previewOpen);
    ['islandFloatingStatus', 'islandMotionControls', 'islandPreviewClock', 'islandPreviewPause'].forEach(id => { $(id).hidden = !previewOpen; });
    document.querySelectorAll('[data-preview-scene]').forEach(node => {
      node.disabled = !valid;
      node.setAttribute('aria-pressed', String(node.dataset.previewScene === scene));
    });
    $('islandPreviewPause').textContent = ribbon.playing ? '暂停' : '继续';
    $('islandPreviewPause').disabled = !valid;
    $('islandPreviewPause').setAttribute('aria-label', ribbon.playing ? '暂停悬浮预览' : '继续悬浮预览');
    $('islandMotionSeekLabel').hidden = !previewOpen || ribbon.elapsed === null;
    $('islandMotionSeek').value = ribbon.elapsed || 0;
    $('islandMotionSeek').disabled = !valid;
    $('islandFloatingStatus').textContent = !valid ? '请选择时间' : state?.hidden ? '已隐藏' : ribbon.playing ? '播放中' : '已暂停';
    const note = !valid ? '请选择完整的预览日期和时间。' : state?.hidden ? state.text + '，可在“提醒与外观”中调整。'
      : scene !== 'daily' && !ribbon.data?.lessons.length ? `当天没有课程，提醒以“${ribbon.data?.demoLesson.subject || '示例课程'}”演示。` : '';
    $('islandFloatingHint').textContent = note;
    $('islandFloatingHint').hidden = !note;
    $('islandPreviewExtras').hidden = !previewOpen || (ribbon.elapsed === null && !note);
  }
  function openFloatingPreview(scene = 'daily') {
    if (!config || busy || !validDate($('islandPreviewDate').value) || minute($('islandPreviewTime').value) === null) return;
    if (!previewOpen) {
      previewOpen = true; $('islandPreviewStage').hidden = false;
      ribbon.setActive(true);
    }
    ribbon.show(scene);
    updatePreviewControls();
  }
  function closeFloatingPreview(restoreFocus = true) {
    if (!previewOpen) return;
    previewOpen = false; ribbon.setActive(false); $('islandPreviewStage').hidden = true;
    $('islandPreviewClock').open = false;
    if (config && (!validDate($('islandPreviewDate').value) || minute($('islandPreviewTime').value) === null)) {
      livePreview = true; renderPreview();
    } else updatePreviewControls();
    if (restoreFocus && !$('islandPreviewToggle').disabled && !$('view-island').classList.contains('hidden')) $('islandPreviewToggle').focus({ preventScroll: true });
  }
  function table(headers, cls, label) {
    const wrap = el('div', undefined, 'table-wrap ' + (cls || ''));
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', label || '可横向滚动的表格');
    const node = el('table'), row = node.createTHead().insertRow();
    headers.forEach(title => { const cell = el('th', title); cell.scope = 'col'; row.append(cell); });
    wrap.append(node);
    return { wrap, body: node.createTBody() };
  }
  function addRow(body, controls, rowHeader = false) {
    const row = body.insertRow();
    controls.forEach((control, index) => {
      const cell = rowHeader && index === 0 ? el('th') : el('td');
      if (rowHeader && index === 0) cell.scope = 'row';
      row.append(cell);
      cell.append(control instanceof Node ? control : document.createTextNode(control));
      cell.querySelectorAll('input,select').forEach(node => {
        if (!node.hasAttribute('aria-label')) node.setAttribute('aria-label', body.parentElement.tHead.rows[0].cells[index].textContent + ' · 第 ' + row.rowIndex + ' 行');
      });
    });
  }
  function empty(title, description, action) {
    const node = el('div', undefined, 'island-empty');
    node.append(el('strong', title));
    if (description) node.append(el('div', description));
    if (action) node.append(action);
    return node;
  }
  function heading(title, note, action) {
    if (!note && !action) return el('h2', title, 'sr-only');
    const row = el('div', undefined, 'island-section-heading'), copy = el('div');
    copy.append(el('h2', title, 'sr-only'));
    if (note) copy.append(el('p', note, 'hint'));
    row.append(copy);
    if (action) row.append(action);
    return row;
  }
  function focusKey(key) {
    const node = [...$('islandTabContent').querySelectorAll('[data-focus-key]')].find(n => n.dataset.focusKey === key && !n.disabled);
    node?.focus({ preventScroll: true });
    return node;
  }
  function prepareConfig(raw) {
    const next = structuredClone(raw);
    next.dutyRotations ||= {};
    for (const kind of Object.keys(dutyNames)) next.dutyRotations[kind] ||= {
      enabled: false, cycleWeeks: 2, weekAnchor: next.weekAnchor, lessons: [],
      slotIds: kind === 'evening' ? next.slots.filter(s => ['evening-study-1', 'evening-study-2'].includes(s.id)).map(s => s.id) : []
    };
    return next;
  }
  function confirmDutyChange(title, message, label, returnFocus) {
    return new Promise(resolve => {
      const { dialog, form } = dialogForm(title, returnFocus);
      const note = el('p', message, 'hint');
      note.id = `island-duty-confirm-${++fieldId}`;
      dialog.setAttribute('aria-describedby', note.id);
      const actions = el('div', undefined, 'island-inline');
      const cancel = button('取消', () => dialog.close());
      const submit = el('button', label, 'btn primary'); submit.type = 'submit';
      let approved = false;
      actions.append(cancel, submit); form.append(note, actions);
      form.onsubmit = event => { event.preventDefault(); approved = true; dialog.close(); };
      dialog.addEventListener('close', () => resolve(approved), { once: true });
      dialog.showModal(); cancel.focus();
    });
  }
  async function applyDutyRule(kind) {
    const duty = config.dutyRotations[kind], draft = dutyDrafts[kind];
    if (!draft) return true;
    const weeks = Number(draft.cycleWeeks);
    const invalid = (path, message) => {
      dutyKind = kind;
      showValidation({ tab: 'duties', path: `duty.${kind}.${path}`, message });
      return false;
    };
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 20) return invalid('cycleWeeks', '请填写 1-20 的整数。');
    if (!validDate(draft.weekAnchor) || new Date(draft.weekAnchor + 'T12:00:00Z').getUTCDay() !== 1) return invalid('weekAnchor', '第 1 周必须从周一开始。');
    const removed = duty.lessons.filter(l => l.cycleWeek > weeks).length;
    if (removed && !await confirmDutyChange('缩短循环周期', `缩短为 ${weeks} 周循环，将移除第 ${weeks + 1} 周起的 ${removed} 项${dutyNames[kind]}安排。其他循环周会保留。`, '确认缩短', `duty.${kind}.cycleWeeks`)) return false;
    const changed = duty.cycleWeeks !== weeks || duty.weekAnchor !== draft.weekAnchor;
    duty.cycleWeeks = weeks; duty.weekAnchor = draft.weekAnchor;
    duty.lessons = duty.lessons.filter(l => l.cycleWeek <= weeks);
    delete dutyDrafts[kind];
    if (kind === dutyKind) dutyWeek = Math.min(dutyWeek, weeks);
    if (changed) mark();
    return true;
  }
  function renderDuties(root) {
    const duty = config.dutyRotations[dutyKind], name = dutyNames[dutyKind];
    const draft = dutyDrafts[dutyKind] ||= { cycleWeeks: String(duty.cycleWeeks), weekAnchor: duty.weekAnchor };
    dutyWeek = Math.min(Math.max(dutyWeek, 1), duty.cycleWeeks);
    const header = el('div', undefined, 'island-duty-header');
    const choices = el('div', undefined, 'island-duty-choices');
    choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', '值班类型');
    for (const [kind, label] of Object.entries(dutyNames)) {
      const d = config.dutyRotations[kind];
      const card = button('', () => { dutyKind = kind; dutyWeek = 1; render(`duty.${kind}.choice`); }, 'island-duty-choice', `duty.${kind}.choice`);
      card.setAttribute('aria-pressed', String(kind === dutyKind));
      card.append(el('strong', label), el('span', `${d.cycleWeeks} 周`));
      choices.append(card);
    }
    const state = el('div', undefined, 'island-duty-state');
    const activeWeek = schedule.cycleWeek(duty, today());
    if (duty.enabled) state.append(el('span', activeWeek === null ? '尚未开始' : `当前第 ${activeWeek} 周`, 'island-duty-status'));
    state.append(switchToggle('启用轮换', duty, 'enabled', `duty.${dutyKind}.enabled`, null, () => render()));
    header.append(choices, state);
    root.append(heading('值班安排'), header);
    const rule = el('section', undefined, 'island-duty-rule');
    rule.setAttribute('aria-label', name + '轮换规则');
    const form = el('form', undefined, 'island-duty-settings');
    const count = input(draft.cycleWeeks, value => { draft.cycleWeeks = value; }, 'number', { min: 1, max: 20, required: true }, `duty.${dutyKind}.cycleWeeks`);
    const anchor = input(draft.weekAnchor, value => { draft.weekAnchor = value; }, 'date', { required: true }, `duty.${dutyKind}.weekAnchor`);
    const apply = el('button', '更新周期', 'btn'); apply.type = 'submit';
    form.append(field('循环周数', count), field('首周周一', anchor), apply);
    form.onsubmit = async event => {
      event.preventDefault();
      if (await applyDutyRule(dutyKind)) render();
    };
    rule.append(form);
    const times = el('div', undefined, 'island-duty-times');
    const labels = duty.slotIds.map(id => config.slots.find(s => s.id === id)).filter(Boolean);
    const timesCopy = el('div', undefined, 'island-duty-time-list');
    timesCopy.append(el('strong', '值班时段'));
    labels.forEach(s => timesCopy.append(el('span', `${s.label} ${clock(s.start)}-${clock(s.end)}`)));
    if (labels.length) times.append(timesCopy, button('调整时段', () => editDutyTimes(duty, dutyKind), 'island-duty-link', `duty.${dutyKind}.times`));
    const details = el('details', undefined, 'island-details island-duty-details');
    details.append(el('summary', '时段与规则'));
    if (labels.length) details.append(times);
    details.append(el('p', '按自然周循环；单日换班请在“临时调课”中调整。', 'hint'));
    if (duty.enabled && (!labels.length || config.lessons.some(l => duty.slotIds.includes(l.slotId)))) rule.append(el('p', !labels.length ? '请先选择值班时段。' : '该时段已有固定课程，请先在周课表中清空，再启用轮换。', 'island-field-error'));
    root.append(rule);
    if (!labels.length) {
      root.append(empty('先选择值班时段', '使用已设置的作息，无需重复填写时间。',
        button('选择作息时段', () => editDutyTimes(duty, dutyKind), 'btn primary', `duty.${dutyKind}.times`)), details);
      return;
    }
    const toolbar = el('div', undefined, 'island-duty-toolbar');
    const weeks = el('div', undefined, 'island-duty-weeks');
    weeks.setAttribute('role', 'tablist'); weeks.setAttribute('aria-label', name + '循环周次');
    for (let n = 1; n <= duty.cycleWeeks; n++) {
      const b = button(`第 ${n} 周`, () => { dutyWeek = n; render(`duty.week.${n}`); }, 'btn', `duty.week.${n}`);
      b.id = 'island-duty-week-' + n; b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(n === dutyWeek)); b.setAttribute('aria-controls', 'island-duty-week-panel');
      b.tabIndex = n === dutyWeek ? 0 : -1; weeks.append(b);
    }
    weeks.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); dutyWeek = event.key === 'Home' ? 1 : event.key === 'End' ? duty.cycleWeeks : (dutyWeek - 1 + (event.key === 'ArrowRight' ? 1 : -1) + duty.cycleWeeks) % duty.cycleWeeks + 1;
      render(`duty.week.${dutyWeek}`);
    };
    const panel = el('section', undefined, 'island-duty-board'); panel.id = 'island-duty-week-panel';
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'island-duty-week-' + dutyWeek);
    const filled = new Set(duty.lessons.filter(l => l.cycleWeek === dutyWeek).map(l => l.weekday)).size;
    const actions = el('div', undefined, 'island-duty-actions');
    const copy = button('从其他周复制', () => copyDutyWeek(duty), 'btn', 'duty.copy'); copy.disabled = duty.cycleWeeks < 2;
    const clear = button('清空本周', async () => {
      if (!await confirmDutyChange('清空本周安排', `清空${name}第 ${dutyWeek} 周的 ${filled} 天安排？其他循环周会保留。`, '确认清空', 'duty.clear')) return;
      duty.lessons = duty.lessons.filter(l => l.cycleWeek !== dutyWeek); mark(); render('duty.clear');
    }, 'btn danger', 'duty.clear'); clear.disabled = filled === 0;
    actions.append(copy, clear);
    toolbar.append(weeks, actions); root.append(toolbar);
    const selectedWeek = weeks.children[dutyWeek - 1];
    weeks.scrollLeft = Math.max(0, selectedWeek.offsetLeft - weeks.firstElementChild.offsetLeft - (weeks.clientWidth - selectedWeek.offsetWidth) / 2);
    const boardHeading = el('div', undefined, 'island-duty-board-heading');
    boardHeading.append(el('span', `已安排 ${filled} / 7 天`));
    panel.append(boardHeading);
    const { wrap, body } = table(['值班时段', ...weekdays], 'island-duty-grid', name + '循环第' + dutyWeek + '周，左右滚动查看所有星期');
    const row = body.insertRow(), rowHeader = el('th'); rowHeader.scope = 'row';
    const label = el('div', undefined, 'island-slot-label');
    label.append(el('strong', name));
    labels.forEach(slot => label.append(el('small', `${clock(slot.start)}-${clock(slot.end)}`)));
    rowHeader.append(label); row.append(rowHeader);
    weekdays.forEach((day, index) => {
      const lessons = labels.map(slot => duty.lessons.find(l => l.cycleWeek === dutyWeek && l.weekday === index + 1 && l.slotId === slot.id));
      const split = lessons.some(l => dutySignature(l) !== dutySignature(lessons[0]));
      const lesson = lessons.find(Boolean), key = `duty.cell.${dutyKind}.${index + 1}`;
      const cell = button('', () => editDutyDay(duty, labels, index + 1, key), 'island-cell', key);
      const description = split ? labels.map((slot, i) => `${slot.label}：${lessons[i] ? [lessons[i].subject, lessons[i].teacher, lessons[i].location].filter(Boolean).join('，') : '未安排'}`).join('；') : lesson ? [lesson.subject, lesson.teacher, lesson.location].filter(Boolean).join('，') : '未安排';
      cell.setAttribute('aria-label', `${name}第${dutyWeek}周 ${day}，${description}`);
      cell.classList.toggle('is-empty', !lesson);
      cell.append(el('strong', split ? '分节安排' : lesson?.subject || '添加安排'));
      if (split) {
        labels.forEach((slot, i) => cell.append(el('small', `${slot.label}：${lessons[i] ? [lessons[i].subject, lessons[i].teacher].filter(Boolean).join(' · ') : '未安排'}`)));
      } else if (lesson) {
        cell.append(el('small', lesson.teacher || '教师待填写'));
        if (!isClassroom(lesson.location)) cell.append(el('small', lesson.location, 'island-duty-location'));
      }
      row.insertCell().append(cell);
    });
    panel.append(wrap, el('p', '左右滑动查看所有星期。', 'hint island-duty-scroll-hint'));
    root.append(panel, details);
  }
  function copyDutyWeek(duty) {
    const { dialog, form } = dialogForm(`复制到第 ${dutyWeek} 周`, 'duty.copy');
    const source = select('', Array.from({ length: duty.cycleWeeks }, (_, i) => i + 1).filter(n => n !== dutyWeek).map(n => [String(n), `第 ${n} 周 · ${new Set(duty.lessons.filter(l => l.cycleWeek === n).map(l => l.weekday)).size} 天安排`]), () => {}, null, false);
    source.selectedIndex = 0;
    const note = el('p', `仅复制${dutyNames[dutyKind]}的学科、教师和地点；目标周已有内容将被替换。`, 'hint');
    form.append(note, field('从哪一周复制', source));
    const error = el('p', '', 'island-field-error'); error.setAttribute('role', 'alert'); form.append(error);
    const actions = el('div', undefined, 'island-inline'), submit = el('button', `复制到第 ${dutyWeek} 周`, 'btn primary'); submit.type = 'submit';
    actions.append(button('取消', () => dialog.close()), submit); form.append(actions);
    form.onsubmit = async event => {
      event.preventDefault();
      const rows = duty.lessons.filter(l => l.cycleWeek === Number(source.value));
      if (!rows.length) { error.textContent = '来源周还没有安排，请选择已填写的循环周。'; return; }
      if (duty.lessons.some(l => l.cycleWeek === dutyWeek) && !await confirmDutyChange('替换本周安排', `替换第 ${dutyWeek} 周现有的值班安排？来源周会保留。`, '确认替换')) return;
      duty.lessons = duty.lessons.filter(l => l.cycleWeek !== dutyWeek).concat(rows.map(l => ({ ...l, cycleWeek: dutyWeek })));
      mark(); render(); dialog.close();
    };
    dialog.showModal(); source.focus();
  }
  function dutySignature(lesson) {
    return lesson ? JSON.stringify([lesson.subject, lesson.teacher || '', lesson.location || '']) : '';
  }
  function editDutyDay(duty, slots, weekday, key) {
    const kind = dutyKind, editingWeek = dutyWeek, name = dutyNames[kind];
    const lessons = slots.map(slot => duty.lessons.find(l => l.cycleWeek === editingWeek && l.weekday === weekday && l.slotId === slot.id));
    const wasSplit = lessons.some(l => dutySignature(l) !== dutySignature(lessons[0]));
    let split = wasSplit, separateOpened = wasSplit;
    const draft = lesson => ({ subject: lesson?.subject || '', teacher: lesson?.teacher || '', location: lesson?.location || '' });
    const shared = draft(lessons.find(Boolean)), separate = lessons.map(draft);
    const { dialog, form } = dialogForm(`${name} · 第 ${editingWeek} 周 · ${weekdays[weekday - 1]}`, key);
    const mode = el('div', undefined, 'island-duty-mode');
    mode.setAttribute('role', 'group'); mode.setAttribute('aria-label', '晚自习填写方式');
    if (slots.length > 1) {
      for (const [label, value] of [['两节统一', false], ['按节分别', true]]) {
        const choice = button(label, () => {
          if (value && !separateOpened) { separate.forEach(values => Object.assign(values, shared)); separateOpened = true; }
          split = value; renderFields();
        }, 'btn');
        choice.dataset.split = String(value); mode.append(choice);
      }
      form.append(mode);
    }
    const fields = el('div', undefined, 'island-duty-edit-fields'); form.append(fields);
    const error = el('p', '', 'island-field-error'); error.setAttribute('role', 'alert'); form.append(error);
    function renderFields() {
      fields.replaceChildren(); error.textContent = '';
      [...mode.children].forEach(b => b.setAttribute('aria-pressed', String(b.dataset.split === String(split))));
      const drafts = split ? separate : [shared];
      drafts.forEach((values, index) => {
        const group = el('fieldset', undefined, 'island-duty-edit-group');
        const slot = slots[index];
        group.append(el('legend', split ? `${slot.label} · ${clock(slot.start)}-${clock(slot.end)}` : slots.length > 1 ? '本日两节' : name));
        const pair = el('div', undefined, 'island-duty-edit-pair');
        const subject = input(values.subject, value => { values.subject = value; error.textContent = ''; }, 'text', { maxLength: 40, placeholder: `留空显示“${name}”` }, null, false);
        const teacher = input(values.teacher, value => { values.teacher = value; error.textContent = ''; }, 'text', { maxLength: 40, placeholder: '填写老师姓名' }, null, false);
        pair.append(field('学科（选填）', subject), field('值班教师', teacher)); group.append(pair);
        const details = el('details', undefined, 'island-details island-duty-place');
        details.open = !isClassroom(values.location);
        details.append(el('summary', '地点 · ' + (values.location || '本班教室')));
        const location = input(values.location, value => { values.location = value; }, 'text', { maxLength: 60, placeholder: '本班教室' }, null, false);
        details.append(field('其他地点（选填）', location)); group.append(details); fields.append(group);
      });
    }
    renderFields();
    function remove() { duty.lessons = duty.lessons.filter(l => l.cycleWeek !== editingWeek || l.weekday !== weekday || !slots.some(s => s.id === l.slotId)); }
    const actions = el('div', undefined, 'island-inline');
    const clear = button('清空本日', () => { remove(); mark(); render(); dialog.close(); }, 'btn danger'); clear.disabled = !lessons.some(Boolean);
    const submit = el('button', '应用修改', 'btn primary'); submit.type = 'submit';
    actions.append(clear, button('取消', () => dialog.close()), submit); form.append(actions);
    form.onsubmit = async event => {
      event.preventDefault();
      const entries = slots.map((slot, index) => {
        const values = split ? separate[index] : shared;
        return { slotId: slot.id, weekday, cycleWeek: editingWeek, subject: values.subject.trim(), teacher: values.teacher.trim(), location: values.location.trim() };
      });
      if (entries.some(l => l.location && !l.subject && !l.teacher)) { error.textContent = '请填写学科或教师，地点不能单独作为值班安排。'; return; }
      const arranged = entries.filter(l => l.subject || l.teacher).map(l => ({ ...l, subject: l.subject || name }));
      if (!arranged.length) { error.textContent = '请至少填写学科或教师；移除安排请点“清空本日”。'; fields.querySelector('input')?.focus(); return; }
      if (wasSplit && !split && !await confirmDutyChange('统一两节晚自习', '本日两节原有安排不同，是否都替换为当前填写的安排？', '确认统一')) return;
      remove(); duty.lessons.push(...arranged);
      mark(); render(); dialog.close();
    };
    dialog.showModal(); fields.querySelector('input')?.focus();
  }
  function editDutyTimes(duty, kind) {
    const { dialog, form } = dialogForm(`${dutyNames[kind]} · 值班时段`, `duty.${kind}.times`);
    form.append(el('p', '选择已有作息，或填写学校实际时间新增。已有时段的时间可在“作息时间”中调整。', 'hint'));
    const reserved = Object.entries(config.dutyRotations).filter(([key]) => key !== kind).flatMap(([, d]) => d.slotIds);
    const available = config.slots.filter(s => !reserved.includes(s.id));
    const controls = [];
    for (let n = 0; n < (kind === 'midday' ? 1 : 2); n++) {
      const start = input('', () => {}, 'time', {}, null, false), end = input('', () => {}, 'time', {}, null, false);
      const choice = select(duty.slotIds[n] || '', [['', '未设置'], ...available.map(s => [s.id, `${s.label} · ${clock(s.start)}-${clock(s.end)}`]), ['new', '新增时段']], refresh, null, false);
      function refresh() {
        const slot = available.find(s => s.id === choice.value);
        start.value = slot ? clock(slot.start) : ''; end.value = slot ? clock(slot.end === 1440 ? 0 : slot.end) : '';
        start.disabled = end.disabled = choice.value !== 'new'; start.required = end.required = choice.value === 'new';
      }
      const row = el('div', undefined, 'island-fields');
      row.append(field(kind === 'midday' ? '午间时段' : `晚自习第 ${n + 1} 节`, choice), field('开始时间', start), field('结束时间', end));
      form.append(row); controls.push({ choice, start, end }); refresh();
    }
    const error = el('p', '', 'island-field-error'); error.setAttribute('role', 'alert'); form.append(error);
    const actions = el('div', undefined, 'island-inline'), submit = el('button', '应用时段', 'btn primary'); submit.type = 'submit';
    actions.append(button('取消', () => dialog.close()), submit); form.append(actions);
    form.onsubmit = async event => {
      event.preventDefault(); error.textContent = '';
      const ids = [], added = [];
      controls.forEach(({ choice, start, end }, n) => {
        if (choice.value === 'new') {
          const s = { id: crypto.randomUUID(), label: kind === 'midday' ? '午间静校' : `晚自习第${n + 1}节`, start: minute(start.value), end: end.value ? minute(end.value) || 1440 : null };
          added.push(s); ids.push(s.id);
        } else if (choice.value) ids.push(choice.value);
      });
      if (!ids.length || new Set(ids).size !== ids.length) { error.textContent = '请选择至少一个时段，两节晚自习不可使用同一个时段。'; return; }
      if (config.slots.length + added.length > 32) { error.textContent = '最多支持 32 个作息时段，请先整理已有作息。'; return; }
      const sorted = [...config.slots, ...added].sort((a, b) => a.start - b.start);
      if (added.some(s => s.start === null || s.end === null || s.start >= s.end) || sorted.some((s, i) => i && sorted[i - 1].end > s.start)) { error.textContent = '请填写完整起止时间，结束时间应晚于开始，且不可与已有作息重叠。'; return; }
      if (duty.enabled && config.lessons.some(l => ids.includes(l.slotId))) { error.textContent = '所选时段已有固定课程，请先清空对应的周课表，或关闭循环后再调整。'; return; }
      const removed = duty.lessons.filter(l => !ids.includes(l.slotId)).length;
      if (removed && !await confirmDutyChange('更换值班时段', `更换时段会移除原时段的 ${removed} 项循环值班，是否继续？`, '确认更换')) return;
      config.slots.push(...added); duty.slotIds = ids; duty.lessons = duty.lessons.filter(l => ids.includes(l.slotId));
      mark(); render(); dialog.close();
    };
    dialog.showModal(); controls[0].choice.focus();
  }
  function renderTimetable(root) {
    root.append(heading('每周课程安排'));
    if (profile?.revision === 0 && !dirty && config.slots.length) {
      root.append(el('p', '已带入本年级默认作息，保存后生效。', 'hint'));
    }
    const filters = el('div', undefined, 'island-filters');
    filters.append(field('首周周一', input(config.weekAnchor, value => config.weekAnchor = value, 'date', { required: true }, 'weekAnchor'), '用于计算单双周。'),
      field('周次', select(week, [['all', '全部课程'], ['odd', '单周课程'], ['even', '双周课程']], value => { week = value; render(); }, 'editingWeek', false)),
      button('编辑作息时间', () => changeTab('slots')));
    root.append(filters);
    if (!config.slots.length) {
      root.append(empty('先设置作息时间', '添加上课、下课时间后，再填写各节课的科目。', button('添加作息时段', () => changeTab('slots'), 'btn primary')));
      return;
    }
    root.append(el('p', '窄屏可在表格中左右滚动，查看周一至周日。', 'hint island-scroll-hint'));
    const { wrap, body } = table(['时段', ...weekdays], 'island-week', '周课表，左右滚动查看所有星期');
    [...config.slots].sort((a, b) => a.start - b.start).forEach(slot => {
      const label = el('div', undefined, 'island-slot-label');
      label.append(el('strong', slot.label), el('small', `${clock(slot.start)}-${clock(slot.end)}`));
      const cells = [label];
      const dutyOwner = Object.entries(config.dutyRotations).find(([, duty]) => duty.enabled && duty.slotIds.includes(slot.id));
      weekdays.forEach((dayName, index) => {
        if (dutyOwner) {
          cells.push(button('查看循环值班', () => { dutyKind = dutyOwner[0]; dutyWeek = 1; changeTab('duties'); }, 'island-cell island-duty-owned'));
          return;
        }
        const lesson = regularLesson(slot.id, index + 1, week);
        const split = week === 'all' ? ['odd', 'even'].map(scope => regularLesson(slot.id, index + 1, scope)).filter(l => l && l.week !== 'all') : [];
        const key = `lesson.${slot.id}.${index + 1}`;
        const cell = button('', () => editLesson(slot, index + 1, key), 'island-cell', key);
        const detail = lesson ? [lesson.teacher, lesson.location, lesson.week === 'all' && week !== 'all' ? '每周相同' : ''].filter(Boolean).join(' · ') : '';
        const description = lesson ? [lesson.subject, detail].filter(Boolean).join('，') : split.length ? split.map(l => `${weekNames[l.week]}：${l.subject}`).join('；') : '添加课程';
        cell.setAttribute('aria-label', `${dayName} ${slot.label}，${description}`);
        cell.title = `${dayName} ${slot.label} · ${description}`;
        if (split.length) split.forEach(l => cell.append(el('span', `${weekNames[l.week]} · ${l.subject}`, 'island-split-lesson')));
        else {
          cell.append(el('strong', lesson?.subject || '添加课程'));
          if (detail) cell.append(el('small', detail));
        }
        cell.classList.toggle('is-empty', !lesson && !split.length);
        cells.push(cell);
      });
      addRow(body, cells, true);
    });
    root.append(wrap);
  }
  function dialogForm(title, returnFocus) {
    const dialog = el('dialog', undefined, 'island-dialog'), form = el('form');
    const titleNode = el('h2', title);
    titleNode.id = `island-dialog-title-${++fieldId}`;
    dialog.setAttribute('aria-labelledby', titleNode.id);
    form.method = 'dialog';
    form.append(titleNode);
    dialog.append(form);
    document.body.append(dialog);
    dialog.onclose = () => { dialog.remove(); if (returnFocus) focusKey(returnFocus) || $(returnFocus)?.focus({ preventScroll: true }); };
    return { dialog, form };
  }
  function editLesson(slot, weekday, returnFocus) {
    const split = !regularLesson(slot.id, weekday, 'all') && config.lessons.some(l => l.slotId === slot.id && l.weekday === weekday);
    let scope = week === 'all' && split ? (regularLesson(slot.id, weekday, 'odd') ? 'odd' : 'even') : week;
    const { dialog, form } = dialogForm(`${weekdays[weekday - 1]} · ${slot.label}`, returnFocus);
    const subject = input('', () => {}, 'text', { required: true, maxLength: 40 }, null, false);
    const teacher = input('', () => {}, 'text', { maxLength: 40 }, null, false);
    const location = input('', () => {}, 'text', { maxLength: 60 }, null, false);
    const note = el('p', '', 'hint');
    function fill() {
      const lesson = regularLesson(slot.id, weekday, scope);
      subject.value = lesson?.subject || '';
      teacher.value = lesson?.teacher || '';
      location.value = lesson?.location || '';
      clear.disabled = !config.lessons.some(l => l.slotId === slot.id && l.weekday === weekday && (scope === 'all' || l.week === 'all' || l.week === scope));
      place.open = !isClassroom(location.value);
      placeSummary.textContent = '上课地点 · ' + (location.value || '本班教室');
      note.textContent = scope === 'all' ? '保存为“每周”会同时设置本格的单周和双周课程。' : `仅修改${weekNames[scope]}；另一周的课程会保留。`;
    }
    const fields = el('div', undefined, 'island-dialog-fields');
    fields.append(field('生效周次', select(scope, [['all', '每周'], ['odd', '单周'], ['even', '双周']], value => { scope = value; fill(); }, null, false), null, 'is-full'),
      field('科目', subject), field('任课教师（选填）', teacher));
    const place = el('details', undefined, 'island-details'), placeSummary = el('summary');
    place.append(placeSummary, field('其他地点（选填）', location));
    note.classList.add('island-dialog-note');
    form.append(el('p', `${clock(slot.start)}-${clock(slot.end)}`, 'hint'), fields, place, note);
    function removeScope() {
      config.lessons = config.lessons.flatMap(lesson => {
        if (lesson.slotId !== slot.id || lesson.weekday !== weekday) return [lesson];
        if (scope === 'all' || lesson.week === scope) return [];
        if (lesson.week === 'all') return [{ ...lesson, week: scope === 'odd' ? 'even' : 'odd' }];
        return [lesson];
      });
    }
    const actions = el('div', undefined, 'island-inline');
    const clear = button('清空本格课程', () => { removeScope(); mark(); render(); dialog.close(); }, 'btn danger');
    actions.append(clear, button('取消', () => dialog.close()));
    const submit = el('button', '应用修改', 'btn primary');
    submit.type = 'submit';
    actions.append(submit);
    form.append(actions);
    form.onsubmit = event => {
      event.preventDefault();
      if (!subject.value.trim()) { subject.setCustomValidity('请填写科目。'); subject.reportValidity(); return; }
      removeScope();
      config.lessons.push({ slotId: slot.id, weekday, week: scope, subject: subject.value.trim(), teacher: teacher.value.trim(), location: location.value.trim() });
      mark(); render(); dialog.close();
    };
    fill(); dialog.showModal(); subject.focus();
  }
  function renderSlots(root) {
    const add = button('添加时段', () => {
      const end = Math.max(470, ...config.slots.map(slot => slot.end || 0));
      if (end > 1390) { showError(new Error('当天已没有足够的空闲时间。请先调整已有时段。')); return; }
      const start = end + 10;
      config.slots.push({ id: crypto.randomUUID(), label: `第 ${config.slots.length + 1} 节`, start, end: start + 40 });
      mark(); render(`slots.${config.slots.length - 1}.label`);
    }, 'btn', 'add-slot');
    add.disabled = config.slots.length >= 32;
    root.append(heading('作息时间', '调整后同步课表时间，最多 32 个时段。', add));
    if (!config.slots.length) { root.append(empty('还没有作息时段', '点击“添加时段”，填写名称和上课、下课时间。')); return; }
    const { wrap, body } = table(['时段名称', '上课时间', '下课时间', '操作'], 'island-slots', '作息时间表');
    config.slots.forEach((slot, index) => addRow(body, [
      input(slot.label, value => slot.label = value, 'text', { maxLength: 30, required: true, ariaLabel: `第 ${index + 1} 个时段名称` }, `slots.${index}.label`),
      input(clock(slot.start), value => slot.start = minute(value), 'time', { required: true, ariaLabel: `${slot.label}上课时间` }, `slots.${index}.start`),
      input(clock(slot.end === 1440 ? 0 : slot.end), value => slot.end = value ? minute(value) || 1440 : null, 'time', { required: true, ariaLabel: `${slot.label}下课时间` }, `slots.${index}.end`),
      button('删除', async () => {
        if ((config.lessons.some(l => l.slotId === slot.id) || config.overrides.some(o => o.slotId === slot.id) || Object.values(config.dutyRotations).some(d => d.slotIds.includes(slot.id))) && !await confirmDutyChange('删除作息时段', `删除“${slot.label}”后，关联的周课表、循环值班和临时调课也会移除。`, '确认删除', `slots.${index}.delete`)) return;
        config.slots.splice(index, 1);
        config.lessons = config.lessons.filter(l => l.slotId !== slot.id);
        config.overrides = config.overrides.filter(o => o.slotId !== slot.id);
        Object.values(config.dutyRotations).forEach(d => {
          d.slotIds = d.slotIds.filter(id => id !== slot.id); d.lessons = d.lessons.filter(l => l.slotId !== slot.id);
          if (!d.slotIds.length) d.enabled = false;
        });
        mark(); render(config.slots.length ? `slots.${Math.min(index, config.slots.length - 1)}.label` : 'add-slot');
      }, 'btn danger', `slots.${index}.delete`)
    ]));
    root.append(wrap, el('p', '时段之间不能重叠。下课时间填写 00:00，表示当天 24:00。', 'hint'));
  }
  function renderOverrides(root) {
    const add = button('添加临时调整', () => {
      if (!config.slots.length) { changeTab('slots'); return; }
      config.overrides.push({ date: today(), slotId: config.slots[0].id, subject: '', teacher: '', location: '', cancelled: false });
      mark(); render(`overrides.${config.overrides.length - 1}.date`);
    }, 'btn', 'add-override');
    add.disabled = config.overrides.length >= 500;
    root.append(heading('临时调课与停课', '仅指定日期生效，优先于周课表与循环值班，不改变轮换顺序。', add));
    if (!config.overrides.length) { root.append(empty('暂无临时调整', '')); return; }
    config.overrides.forEach((override, index) => {
      const card = el('section', undefined, 'island-rule');
      const top = el('div', undefined, 'island-rule-heading');
      const title = el('h3');
      const updateTitle = () => {
        const slot = config.slots.find(s => s.id === override.slotId);
        title.textContent = [override.date || '选择日期', slot?.label, override.cancelled ? '停课' : '调课'].filter(Boolean).join(' ');
      };
      updateTitle();
      top.append(title, button('删除调整', () => {
        config.overrides.splice(index, 1); mark(); render('add-override');
      }, 'btn danger'));
      const fields = el('div', undefined, 'island-fields');
      const path = `overrides.${index}`;
      fields.append(field('生效日期', input(override.date, value => { override.date = value; updateTitle(); }, 'date', { required: true }, path + '.date')),
        field('调整时段', select(override.slotId, config.slots.map(slot => [slot.id, `${slot.label} · ${clock(slot.start)}`]), value => { override.slotId = value; updateTitle(); }, path + '.slotId')),
        field('调整方式', select(override.cancelled ? 'cancel' : 'lesson', [['lesson', '更换课程'], ['cancel', '停课']], value => { override.cancelled = value === 'cancel'; render(path + '.cancelled'); }, path + '.cancelled')));
      const subject = input(override.subject, value => override.subject = value, 'text', { maxLength: 40 }, path + '.subject');
      const teacher = input(override.teacher, value => override.teacher = value, 'text', { maxLength: 40 }, path + '.teacher');
      const location = input(override.location, value => override.location = value, 'text', { maxLength: 60, placeholder: '本班教室' }, path + '.location');
      const course = el('div', undefined, 'island-override-course'), lessonFields = el('div', undefined, 'island-fields');
      lessonFields.append(field('调整后的科目', subject), field('任课教师（选填）', teacher));
      const place = el('details', undefined, 'island-details island-override-place');
      place.open = !isClassroom(override.location);
      place.append(el('summary', '上课地点 · ' + (override.location || '本班教室')), field('其他地点（选填）', location));
      course.hidden = override.cancelled;
      course.append(lessonFields, place);
      card.append(top, fields, course);
      [subject, teacher, location].forEach(control => disabled(control, override.cancelled));
      if (override.cancelled) card.append(el('p', '当天该时段的课程提醒和自动化暂停，原课程信息保留。', 'hint'));
      root.append(card);
    });
  }
  function group(title, note, controls) {
    const node = el('fieldset', undefined, 'island-settings-card');
    node.append(el('legend', title));
    if (note) node.append(el('p', note, 'hint'));
    const fields = el('div', undefined, 'island-settings-fields');
    fields.append(...controls);
    node.append(fields);
    return node;
  }
  function renderSettings(root) {
    const r = config.reminders, a = config.appearance;
    root.append(heading('提醒与外观'));
    function refresh() {
      root.querySelectorAll('[data-path^="reminders."]').forEach(control => {
        const key = control.dataset.path.split('.')[1];
        if (key === 'enabled') return;
        disabled(control, !r.enabled || (key === 'prepareMinutes' && !r.prepare) || (key === 'volume' && !r.sound && !r.speech));
      });
    }
    const full = node => { node.classList.add('is-full'); return node; };
    const timing = el('fieldset', undefined, 'island-reminder-timing is-full');
    timing.append(el('legend', '提醒时机'),
      toggle('课前准备', r, 'prepare', 'reminders.prepare', null, refresh),
      toggle('上课', r, 'start', 'reminders.start'), toggle('下课', r, 'end', 'reminders.end'));
    const reminderCard = group('课程提醒', null, [
      full(switchToggle('启用上下课提醒', r, 'enabled', 'reminders.enabled', null, refresh)), timing,
      field('提前提醒（分钟）', input(r.prepareMinutes, value => r.prepareMinutes = value, 'number', { min: 1, max: 30, required: true }, 'reminders.prepareMinutes'), '1-30 分钟'),
      field('提醒停留（秒）', input(r.displaySeconds, value => r.displaySeconds = value, 'number', { min: 3, max: 60, required: true }, 'reminders.displaySeconds'), '3-60 秒')
    ]);
    reminderCard.querySelector('.island-settings-fields').append(el('h4', '提醒声音', 'island-settings-subheading is-full'),
      switchToggle('提示音', r, 'sound', 'reminders.sound', null, refresh),
      switchToggle('语音播报', r, 'speech', 'reminders.speech', null, refresh),
      full(field('提醒音量（%）', input(r.volume, value => r.volume = value, 'number', { min: 0, max: 100, required: true }, 'reminders.volume'), '提示音和语音共用音量。')));
    const appearanceCard = group('浮岛显示', null, [
      full(switchToggle('显示教室浮岛', config, 'enabled', 'enabled')),
      field('屏幕位置', select(a.position, [['top-center', '顶部居中'], ['top-left', '左上角'], ['top-right', '右上角'], ['bottom-center', '底部居中']], value => a.position = value, 'appearance.position')),
      field('显示主题', select(a.theme, [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']], value => a.theme = value, 'appearance.theme')),
      field('浮岛宽度（像素）', input(a.width, value => a.width = value, 'number', { min: 380, max: 1000, required: true }, 'appearance.width'), '380-1000，默认 560。'),
      field('不透明度（%）', input(a.opacity, value => a.opacity = value, 'number', { min: 30, max: 100, required: true }, 'appearance.opacity'), '30–100，越高越清晰。'),
      el('h4', '自动隐藏', 'island-settings-subheading is-full'),
      full(switchToggle('全屏演示时隐藏', a, 'hideFullscreen', 'appearance.hideFullscreen')),
      full(switchToggle('上课期间隐藏', a, 'hideDuringLessons', 'appearance.hideDuringLessons'))
    ]);
    const details = el('details', undefined, 'island-details island-settings-advanced is-full');
    details.append(el('summary', '位置微调与鼠标操作'));
    const fields = el('div', undefined, 'island-fields');
    fields.append(field('水平偏移', input(a.offsetX, value => a.offsetX = value, 'number', { min: -2000, max: 2000, required: true }, 'appearance.offsetX'), '正数向右，负数向左。'),
      field('垂直偏移', input(a.offsetY, value => a.offsetY = value, 'number', { min: -2000, max: 2000, required: true }, 'appearance.offsetY'), '正数向下，负数向上。'),
      full(switchToggle('鼠标穿透', a, 'clickThrough', 'appearance.clickThrough', '开启后，从教室首页或托盘恢复操作。')));
    details.append(fields); appearanceCard.querySelector('.island-settings-fields').append(details);
    const layout = el('div', undefined, 'island-settings-layout');
    layout.append(reminderCard, appearanceCard); root.append(layout); refresh();
  }
  function renderComponents(root) {
    const add = button('添加信息', () => {
      config.components.push({ id: crypto.randomUUID(), type: 'text', enabled: true, title: '班级寄语', text: '', date: '' });
      mark(); render(`components.${config.components.length - 1}.type`);
    }, 'btn primary', 'add-component');
    add.disabled = config.components.length >= 16;
    root.append(heading('轮播信息'));
    const toolbar = el('div', undefined, 'island-component-toolbar');
    toolbar.append(field('切换间隔（秒）', input(config.rotationSeconds, value => config.rotationSeconds = value, 'number', { min: 3, max: 120, required: true }, 'rotationSeconds')),
      el('span', `${config.components.length} / 16 项`, 'island-component-count'), add);
    root.append(toolbar);
    config.components.forEach((component, index) => {
      const card = el('section', undefined, 'island-component-card'), top = el('div', undefined, 'island-component-heading');
      const name = componentName(component);
      const title = keyed(el('h3', name), null, `component.${component.id}.heading`);
      title.tabIndex = -1;
      const identity = el('div', undefined, 'island-component-identity');
      const number = el('span', String(index + 1).padStart(2, '0'), 'island-component-index');
      number.setAttribute('aria-hidden', 'true'); identity.append(number, title);
      const actions = el('div', undefined, 'island-rule-actions');
      const up = button('上移', () => {
        [config.components[index - 1], config.components[index]] = [component, config.components[index - 1]];
        mark(); render(`component.${component.id}.${index === 1 ? 'heading' : 'up'}`);
      }, 'btn', `component.${component.id}.up`);
      const down = button('下移', () => {
        [config.components[index + 1], config.components[index]] = [component, config.components[index + 1]];
        mark(); render(`component.${component.id}.${index === config.components.length - 2 ? 'heading' : 'down'}`);
      }, 'btn', `component.${component.id}.down`);
      up.disabled = index === 0; down.disabled = index === config.components.length - 1;
      up.setAttribute('aria-label', `上移“${name}”`); down.setAttribute('aria-label', `下移“${name}”`);
      const remove = button('删除', () => { config.components.splice(index, 1); mark(); render('add-component'); }, 'btn danger');
      remove.setAttribute('aria-label', `删除“${name}”`);
      const path = `components.${index}`;
      actions.append(up, down, remove); top.append(identity, switchToggle('显示', component, 'enabled', path + '.enabled'), actions);
      const fields = el('div', undefined, 'island-component-fields');
      fields.append(field('信息类型', select(component.type, [['date', '日期'], ['countdown', '倒数日'], ['text', '班级寄语']], value => {
          component.type = value;
          if (value === 'countdown' && !component.date) component.date = today();
          render();
        }, path + '.type')),
        field('标题（选填）', input(component.title, value => {
          component.title = value;
          const name = componentName(component);
          title.textContent = name;
          up.setAttribute('aria-label', `上移“${name}”`);
          down.setAttribute('aria-label', `下移“${name}”`);
          remove.setAttribute('aria-label', `删除“${name}”`);
        }, 'text', { maxLength: 40 }, path + '.title')));
      if (component.type === 'text') fields.append(field('显示内容', area(component.text, value => component.text = value, 240, path + '.text'), '240 字以内。', 'is-full'));
      if (component.type === 'countdown') fields.append(field('目标日期', input(component.date, value => component.date = value, 'date', { required: true }, path + '.date')));
      const preview = el('div', undefined, 'island-component-sample'), content = el('span');
      content.dataset.componentPreview = component.id;
      preview.append(el('span', '预览', 'island-component-sample-label'), content);
      card.append(top, fields, preview); root.append(card);
    });
    if (!config.components.length) root.append(empty('还没有轮播信息', '可以添加日期、重要日子的倒计时，或给班级的一句寄语。'));
  }
  function renderAutomation(root) {
    const add = button('添加规则', () => {
      config.automation.push({ id: crypto.randomUUID(), name: '新规则', enabled: true, trigger: 'time', minute: 480, weekdays: [1, 2, 3, 4, 5], action: 'reminder', value: '' });
      mark(); render(`automation.${config.automation.length - 1}.name`);
    }, 'btn', 'add-rule');
    add.disabled = config.automation.length >= 40;
    root.append(heading('自动化', '同步后可离线执行，最多 40 条。', add));
    config.automation.forEach((rule, index) => {
      const card = el('section', undefined, 'island-rule island-automation-rule'), top = el('div', undefined, 'island-rule-heading island-automation-heading');
      const path = `automation.${index}`;
      const title = el('h3', rule.name || '未命名规则', 'sr-only');
      title.id = `island-rule-title-${++fieldId}`;
      card.setAttribute('aria-labelledby', title.id);
      const remove = button('删除规则', () => { config.automation.splice(index, 1); mark(); render('add-rule'); }, 'btn danger');
      const name = input(rule.name, value => {
        rule.name = value; title.textContent = value || '未命名规则'; remove.setAttribute('aria-label', '删除规则“' + title.textContent + '”');
      }, 'text', { maxLength: 60, required: true, placeholder: '填写规则名称' }, path + '.name');
      remove.setAttribute('aria-label', '删除规则“' + title.textContent + '”');
      top.append(title, field('规则名称', name), switchToggle('启用', rule, 'enabled', path + '.enabled'), remove);
      const fields = el('div', undefined, 'island-fields island-automation-fields');
      fields.dataset.timed = String(rule.trigger === 'time');
      fields.append(field('触发时机', select(rule.trigger, [['time', '指定时间'], ['prepare', '课前准备'], ['start', '上课时'], ['end', '下课时']], value => {
          rule.trigger = value;
          if (value !== 'time' && !Number.isInteger(rule.minute)) rule.minute = 480;
          render(path + '.trigger');
        }, path + '.trigger')));
      if (rule.trigger === 'time') fields.append(field('执行时间', input(clock(rule.minute), value => rule.minute = minute(value), 'time', { required: true }, path + '.minute')));
      fields.append(field('执行动作', select(rule.action, [['reminder', '显示提醒'], ['website', '打开网页'], ['app', '打开本机应用'], ['reading', '打开早读']], value => { rule.action = value; render(path + '.action'); }, path + '.action')));
      if (rule.action === 'reminder') fields.append(field('提醒内容', area(rule.value, value => rule.value = value, 500, path + '.value'), '最多 500 字。', 'is-full'));
      if (rule.action === 'website') fields.append(field('网页地址', input(rule.value, value => rule.value = value, 'url', { maxLength: 500, placeholder: 'https://example.com', required: true }, path + '.value'), '请填写以 https:// 开头的完整地址。', 'is-full'));
      if (rule.action === 'app') fields.append(field('应用完整路径', input(rule.value, value => rule.value = value, 'text', { maxLength: 500, placeholder: 'C:\\School\\Lesson.exe', required: true }, path + '.value'), '首次使用需在教室端“自动化应用”中允许这个应用。只填写 exe 路径。', 'is-full'));
      const days = el('fieldset', undefined, 'island-weekdays');
      days.append(el('legend', '生效星期'));
      weekdays.forEach((name, day) => {
        const choice = el('label', undefined, 'island-toggle');
        choice.append(input(rule.weekdays.includes(day + 1), value => {
          rule.weekdays = rule.weekdays.filter(n => n !== day + 1);
          if (value) rule.weekdays.push(day + 1);
          clearFieldError(days.querySelector('input'));
        }, 'checkbox', {}, day === 0 ? path + '.weekdays' : path + `.weekday-${day + 1}`), el('span', name));
        days.append(choice);
      });
      card.append(top, fields, days);
      if (rule.trigger !== 'time') card.append(el('p', rule.trigger === 'prepare' ? '按所选星期的课表触发，提前量使用“提醒与外观”中的课前提前分钟数。' : '按所选星期的课表触发。没有课程或临时停课的时段不会执行。', 'hint'));
      root.append(card);
    });
    if (!config.automation.length) root.append(empty('还没有自动化规则', '例如：早读前打开活动，下课时显示护眼提醒。'));
  }
  function changeTab(next) {
    if (!tabs.includes(next) || !config || busy || next === tab) return;
    tab = next; render();
  }
  function render(restoreFocus) {
    if (!config) return;
    const key = restoreFocus || document.activeElement?.dataset.focusKey;
    $('islandTabs').querySelectorAll('button').forEach(node => {
      const active = node.dataset.tab === tab;
      node.id = 'island-tab-' + node.dataset.tab;
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-controls', 'islandTabContent');
      node.setAttribute('aria-selected', String(active));
      node.removeAttribute('aria-pressed');
      node.tabIndex = active ? 0 : -1;
      node.classList.toggle('active', active);
    });
    const root = $('islandTabContent');
    const dutyScroll = tab === 'duties' ? root.querySelector('.island-duty-grid')?.scrollLeft || 0 : 0;
    root.dataset.panel = tab;
    root.setAttribute('aria-labelledby', 'island-tab-' + tab);
    root.replaceChildren();
    ({ timetable: renderTimetable, duties: renderDuties, slots: renderSlots, overrides: renderOverrides, settings: renderSettings, components: renderComponents, automation: renderAutomation })[tab](root);
    const dutyGrid = root.querySelector('.island-duty-grid');
    if (dutyGrid) dutyGrid.scrollLeft = dutyScroll;
    updateTableOverflow();
    if (key) focusKey(key);
    renderPreview();
  }
  function validationIssue() {
    const issue = (targetTab, path, message) => ({ tab: targetTab, path, message });
    if (!validDate(config.weekAnchor) || new Date(config.weekAnchor + 'T12:00:00Z').getUTCDay() !== 1) return issue('timetable', 'weekAnchor', '第一周的起始日期必须是周一。');
    const sorted = config.slots.map((slot, index) => ({ ...slot, index })).sort((a, b) => a.start - b.start);
    for (const [index, slot] of config.slots.entries()) {
      if (!slot.label.trim()) return issue('slots', `slots.${index}.label`, '请填写时段名称。');
      if (!Number.isInteger(slot.start) || slot.start < 0 || slot.start > 1439) return issue('slots', `slots.${index}.start`, `请填写“${slot.label}”的上课时间。`);
      if (!Number.isInteger(slot.end) || slot.end <= slot.start || slot.end > 1440) return issue('slots', `slots.${index}.end`, `“${slot.label}”的下课时间应晚于上课时间。`);
    }
    for (let i = 1; i < sorted.length; i++) if (sorted[i - 1].end > sorted[i].start) return issue('slots', `slots.${sorted[i].index}.start`, `“${sorted[i].label}”与“${sorted[i - 1].label}”的时间重叠，请调整。`);
    for (const [kind, duty] of Object.entries(config.dutyRotations)) {
      if (duty.enabled && !duty.slotIds.length) {
        dutyKind = kind; return issue('duties', `duty.${kind}.times`, `请先设置${dutyNames[kind]}的时段。`);
      }
      if (duty.enabled && config.lessons.some(l => duty.slotIds.includes(l.slotId))) {
        dutyKind = kind; return issue('duties', `duty.${kind}.enabled`, `${dutyNames[kind]}时段已有固定课程，请先清空该时段的周课表，再启用循环。`);
      }
    }
    const seen = new Set();
    for (const [index, override] of config.overrides.entries()) {
      const path = `overrides.${index}`;
      if (!validDate(override.date)) return issue('overrides', path + '.date', `请填写第 ${index + 1} 项临时调整的日期。`);
      if (!config.slots.some(slot => slot.id === override.slotId)) return issue('overrides', path + '.slotId', '请选择存在的作息时段。');
      const key = override.date + ':' + override.slotId;
      if (seen.has(key)) return issue('overrides', path + '.slotId', `${override.date} 的同一时段已有临时调整，请合并为一项。`);
      seen.add(key);
      if (!override.cancelled && !override.subject.trim()) return issue('overrides', path + '.subject', '请填写调整后的科目，或将调整方式改为“停课”。');
    }
    const ranges = [
      ['reminders.prepareMinutes', '课前提前分钟数', 1, 30], ['reminders.displaySeconds', '提醒停留秒数', 3, 60],
      ['reminders.volume', '提醒音量', 0, 100], ['appearance.width', '悬浮岛宽度', 380, 1000],
      ['appearance.opacity', '不透明度', 30, 100], ['appearance.offsetX', '水平偏移', -2000, 2000],
      ['appearance.offsetY', '垂直偏移', -2000, 2000], ['rotationSeconds', '轮播停留秒数', 3, 120]
    ];
    for (const [path, label, low, high] of ranges) {
      const value = path.split('.').reduce((object, key) => object[key], config);
      if (!Number.isInteger(value) || value < low || value > high) return issue(path === 'rotationSeconds' ? 'components' : 'settings', path, `${label}应为 ${low}–${high} 的整数。`);
    }
    for (const [index, component] of config.components.entries()) if (component.type === 'countdown' && !validDate(component.date)) return issue('components', `components.${index}.date`, '请为倒数日选择目标日期。');
    for (const [index, rule] of config.automation.entries()) {
      const path = `automation.${index}`;
      if (!rule.name.trim()) return issue('automation', path + '.name', '请填写规则名称。');
      if (!rule.weekdays.length) return issue('automation', path + '.weekdays', `请为“${rule.name}”至少选择一个生效星期。`);
      if (!Number.isInteger(rule.minute) || rule.minute < 0 || rule.minute > 1439) return issue('automation', path + '.minute', `请填写“${rule.name}”的执行时间。`);
      if (rule.action !== 'reading' && !rule.value.trim()) return issue('automation', path + '.value', rule.action === 'reminder' ? '请填写提醒内容。' : rule.action === 'app' ? '请填写应用完整路径。' : '请填写网页地址。');
      if (rule.action === 'website') {
        let valid = false;
        try { const url = new URL(rule.value); valid = url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !/\s/.test(rule.value); } catch { /* Show a field error below. */ }
        if (!valid) return issue('automation', path + '.value', '请使用以 https:// 开头、不含空格的完整网页地址。');
      }
      if (rule.action === 'app' && !/^[A-Za-z]:\\[^\x00-\x1f"<>|*?]+\.exe$/i.test(rule.value)) return issue('automation', path + '.value', '请填写本机 exe 的完整路径，不要附加命令或参数。');
    }
    return null;
  }
  function showValidation(issue) {
    tab = issue.tab; render();
    showError(new Error(issue.message), false);
    const control = [...$('islandTabContent').querySelectorAll('[data-path]')].find(node => node.dataset.path === issue.path);
    if (!control) { showError(new Error(issue.message)); return; }
    const details = control.closest('details');
    if (details) details.open = true;
    // Disabled options still need valid values, so make an invalid saved value editable.
    disabled(control, false);
    control.setAttribute('aria-invalid', 'true');
    const note = el('small', issue.message, 'island-field-error');
    note.id = `island-field-error-${++fieldId}`;
    control.dataset.errorId = note.id;
    control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), note.id].filter(Boolean).join(' '));
    control.closest('.island-field, .island-weekdays')?.append(note);
    if (!note.isConnected) control.parentElement.append(note);
    control.focus({ preventScroll: true });
    control.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
  function renderDelivery(devices, revision = profile?.revision) {
    const list = $('islandDelivery');
    list.replaceChildren();
    $('islandDeliveryNote').textContent = !devices.length ? '未绑定教室设备。' : revision ? '联网后自动同步。' : '尚未保存配置。';
    devices.forEach(device => {
      const row = el('div', undefined, 'island-delivery-row'), top = el('div', undefined, 'island-delivery-heading');
      const current = device.revision === revision && revision > 0;
      top.append(el('strong', device.name), el('span', current ? '已同步' : '等待同步', current ? 'success-text' : 'muted'));
      row.append(top);
      if (device.revision !== null && device.revision !== undefined) row.append(el('small', `设备版本 ${device.revision}`));
      if (device.synced_at) row.append(el('small', '最近回报：' + new Date(device.synced_at).toLocaleString('zh-CN')));
      if (device.detail) row.append(el('small', device.detail));
      list.append(row);
    });
  }
  function clearClass() {
    closeFloatingPreview(false);
    profile = config = null; loadedClass = ''; dirty = false;
    $('islandTabContent').replaceChildren(empty('暂无可配置的班级', '请先创建班级，或联系管理员分配班级权限。'));
    $('islandDelivery').replaceChildren();
    $('islandTodayTitle').textContent = '当日课程';
    ribbon.clear();
    $('islandPreviewSummary').textContent = '';
    $('islandDeliveryNote').textContent = '';
    $('islandSyncNotice').textContent = '';
    status('暂无可配置的班级'); setBusy(false);
  }
  async function load(force = false) {
    if (busy) return;
    if (dirty && !force && !await confirmDutyChange('重新载入', '重新载入会放弃当前未保存的修改。', '重新载入', 'islandReload')) return;
    const classId = $('islandClass').value, requestId = ++loadId;
    closeFloatingPreview(false);
    if (!classId) { clearClass(); return; }
    $('islandError').textContent = '';
    setBusy(true); status('正在载入班级配置…');
    try {
      const data = await api('/api/island/classes/' + encodeURIComponent(classId));
      if (requestId !== loadId) return;
      profile = data; config = prepareConfig(data.config); dutyDrafts = {}; loadedClass = classId; dirty = false;
      $('islandSyncNotice').textContent = '';
      status(); renderDelivery(data.devices); render();
    } catch (error) {
      if (requestId !== loadId) return;
      if (loadedClass && [...$('islandClass').options].some(option => option.value === loadedClass)) $('islandClass').value = loadedClass;
      else clearClass();
      status(config ? (dirty ? '载入失败 · 未保存的修改已保留' : '载入失败 · 仍显示上次配置') : '载入失败，请重试');
      showError(error);
    } finally { if (requestId === loadId) setBusy(false); }
  }
  async function save() {
    if (!config || busy) return;
    for (const kind of Object.keys(dutyDrafts)) if (!await applyDutyRule(kind)) return;
    const issue = validationIssue();
    if (issue) { showValidation(issue); return; }
    setBusy(true, '保存中…'); $('islandError').textContent = '';
    try {
      profile = await api('/api/island/classes/' + encodeURIComponent(loadedClass), { method: 'PUT', body: JSON.stringify({ revision: profile.revision, config }) });
      config = prepareConfig(profile.config); dutyDrafts = {}; dirty = false;
      $('islandSyncNotice').textContent = '';
      status(); renderDelivery(profile.devices); render();
      window.ICeClass.toast('已保存。教室端联网后会自动同步。');
    } catch (error) {
      if (error.status === 409) $('islandSyncNotice').textContent = '其他老师已更新本班配置。当前修改仍保留，请核对后重新载入。';
      showError(error);
    } finally { setBusy(false); }
  }
  async function importFile(file) {
    if (!file || !config || busy) return;
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error('请选择 .xlsx 格式的 Excel 课表。');
      if (file.size > 2000000) throw new Error('文件不能超过 2 MB。');
      if (!await confirmDutyChange('导入课表', `将课表导入“${className()}”的编辑预览，替换未保存的课程和值班安排。上课时间沿用本班作息，检查后保存并下发。`, '导入预览', 'islandImport')) return;
      setBusy(true); $('islandError').textContent = '';
      const data = await api('/api/island/classes/' + encodeURIComponent(loadedClass) + '/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      // Import previews are based on the server's saved profile. Merge only schedule
      // fields so an unsaved appearance, component or automation edit survives import.
      if (data.scheduleOnly) {
        const currentSlots = new Set(config.slots.map(slot => slot.id));
        const referenced = [...data.config.lessons, ...data.config.overrides,
          ...Object.values(data.config.dutyRotations).flatMap(duty => duty.slotIds.map(slotId => ({ slotId })))];
        if (referenced.some(row => !currentSlots.has(row.slotId))) throw new Error('当前未保存的作息与模板不一致，请先保存作息设置，再重新导入课表。');
      }
      for (const key of ['weekAnchor', 'lessons', 'overrides', ...(data.scheduleOnly ? [] : ['slots'])]) config[key] = structuredClone(data.config[key]);
      if (data.dutiesIncluded) { config.dutyRotations = prepareConfig(data.config).dutyRotations; dutyDrafts = {}; }
      tab = 'timetable'; mark(); render();
      const parts = [`日常课程 ${config.lessons.length} 节`];
      if (data.dutiesIncluded) {
        for (const [kind, name] of [['midday', '午间静校'], ['evening', '晚自习']]) {
          const duty = config.dutyRotations[kind];
          parts.push(`${name} ${duty.cycleWeeks} 周循环、${duty.lessons.length} 项${duty.enabled ? '' : '（未启用）'}`);
        }
      }
      parts.push(`临时调课 ${config.overrides.length} 项`);
      $('islandSyncNotice').textContent = `${data.sourceClass ? `已读取“${data.sourceClass}”的课表。` : ''}已识别：${parts.join('；')}。${data.scheduleOnly ? '上课时间沿用本班已设置的作息。' : ''}当前为“${className()}”的预览，检查后保存并下发。`;
      window.ICeClass.toast('课表已导入预览。检查后点击“保存并下发”。');
    } catch (error) { showError(error); }
    finally { setBusy(false); $('islandImportFile').value = ''; }
  }
  function copyDialog() {
    if (!config || busy) return;
    if (needsSave()) { showError(new Error('请先保存本班配置，再复制到其他班级。')); return; }
    const classes = window.ICeClass.state.classes.filter(c => c.id !== loadedClass && Number(c.enabled) === 1);
    const { dialog, form } = dialogForm('复制到其他班级', 'islandCopy');
    form.append(el('p', `使用“${className()}”已保存的全部教室浮岛设置，替换所选班级的现有配置。`, 'hint'));
    const search = input('', () => {
      rows.forEach(({ node, name }) => node.hidden = !name.includes(search.value.trim()));
    }, 'search', { placeholder: '输入班级名称' }, null, false);
    form.append(field('查找班级', search));
    const selected = new Set(), rows = [], list = el('div', undefined, 'island-copy-list');
    const count = el('p', '已选择 0 个班级', 'island-copy-summary');
    classes.forEach(c => {
      const row = el('label', undefined, 'island-toggle');
      const control = input(false, value => {
        if (value) selected.add(c.id); else selected.delete(c.id);
        count.textContent = `已选择 ${selected.size} 个班级`;
      }, 'checkbox', {}, null, false);
      row.append(control, el('span', c.name)); list.append(row); rows.push({ node: row, name: c.name, control, id: c.id });
    });
    if (!classes.length) list.append(el('p', '暂无其他可配置的班级。', 'hint'));
    form.append(list, count);
    const result = el('p', undefined, 'form-error');
    result.setAttribute('role', 'status'); form.append(result);
    const actions = el('div', undefined, 'island-inline');
    let copying = false;
    const cancel = button('取消', () => dialog.close()), submit = el('button', '复制并下发', 'btn primary');
    submit.type = 'submit'; submit.disabled = !classes.length;
    actions.append(cancel, submit); form.append(actions);
    dialog.oncancel = event => { if (copying) event.preventDefault(); };
    form.onsubmit = async event => {
      event.preventDefault();
      if (!selected.size) { result.textContent = '请至少选择一个班级。'; return; }
      copying = true; submit.disabled = cancel.disabled = search.disabled = true;
      rows.forEach(row => row.control.disabled = true);
      let completed = 0;
      const errors = [];
      for (const classId of [...selected]) {
        const row = rows.find(item => item.id === classId);
        result.textContent = `正在复制到“${row.name}”…`;
        try {
          const target = await api('/api/island/classes/' + encodeURIComponent(classId));
          await api('/api/island/classes/' + encodeURIComponent(classId), { method: 'PUT', body: JSON.stringify({ revision: target.revision, config: profile.config }) });
          completed++; selected.delete(classId); row.control.checked = false; row.node.dataset.copied = 'true';
        } catch (error) { errors.push(`${row.name}：${error.message}`); }
      }
      copying = false;
      if (!errors.length) { dialog.close(); window.ICeClass.toast(`已复制到 ${completed} 个班级，教室端联网后自动同步。`); }
      else {
        result.textContent = `已完成 ${completed} 个班级。${errors.join('；')}。可重试剩余班级。`;
        count.textContent = `剩余 ${selected.size} 个班级`;
        submit.disabled = cancel.disabled = search.disabled = false;
        rows.forEach(row => row.control.disabled = row.node.dataset.copied === 'true');
        submit.textContent = '重试剩余班级';
      }
    };
    dialog.showModal(); search.focus();
  }
  function fillClasses() {
    const previous = loadedClass || $('islandClass').value;
    $('islandClass').replaceChildren();
    window.ICeClass.state.classes.filter(c => Number(c.enabled) === 1).forEach(c => $('islandClass').append(new Option(c.name, c.id)));
    if ([...$('islandClass').options].some(option => option.value === previous)) $('islandClass').value = previous;
  }
  $('islandTabs').onclick = event => {
    const node = event.target.closest('button[data-tab]');
    if (node) changeTab(node.dataset.tab);
  };
  $('islandTabs').onkeydown = event => {
    const active = event.target.closest('button[data-tab]');
    if (!active || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let index = tabs.indexOf(active.dataset.tab);
    index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    changeTab(tabs[index]);
    const selected = $('island-tab-' + tabs[index]), strip = $('islandTabs');
    selected.focus({ preventScroll: true });
    const itemBox = selected.getBoundingClientRect(), stripBox = strip.getBoundingClientRect();
    if (itemBox.left < stripBox.left) strip.scrollLeft += itemBox.left - stripBox.left;
    else if (itemBox.right > stripBox.right) strip.scrollLeft += itemBox.right - stripBox.right;
  };
  $('islandClass').onchange = async () => {
    const nextClass = $('islandClass').value;
    $('islandClass').value = loadedClass;
    if (dirty && !await confirmDutyChange('切换班级', '切换班级会放弃当前未保存的修改。', '确认切换', 'islandClass')) return;
    $('islandClass').value = nextClass;
    void load(true);
  };
  $('islandReload').onclick = () => void load();
  $('islandSave').onclick = () => void save();
  $('islandCopy').onclick = copyDialog;
  $('islandImportFile').onchange = event => void importFile(event.target.files[0]);
  $('islandImport').onclick = () => $('islandImportFile').click();
  $('islandExport').onclick = async () => {
    if (!loadedClass || busy) return;
    if (dirty && !await confirmDutyChange('导出 Excel', '导出的是最近保存的课表，不包含当前未保存的修改。', '继续导出', 'islandExport')) return;
    location.href = '/api/island/classes/' + encodeURIComponent(loadedClass) + '/export';
  };
  $('islandPreviewDate').value = today(); $('islandPreviewTime').value = nowClock();
  [$('islandPreviewDate'), $('islandPreviewTime')].forEach(node => node.addEventListener('input', () => { livePreview = false; renderPreview(); }));
  $('islandPreviewNow').onclick = () => { livePreview = true; renderPreview(); };
  $('islandPreviewToggle').onclick = () => previewOpen ? closeFloatingPreview() : openFloatingPreview();
  $('islandPreviewPause').onclick = () => {
    if (ribbon.playing) ribbon.pause();
    else { ribbon.play(); renderPreview(); }
  };
  document.querySelectorAll('[data-preview-scene]').forEach(node => {
    node.onclick = () => openFloatingPreview(node.dataset.previewScene);
  });
  $('islandMotionSeek').oninput = event => ribbon.seek(Number(event.target.value));
  document.addEventListener('pointerdown', event => {
    if ($('islandPreviewClock').open && !$('islandPreviewClock').contains(event.target)) $('islandPreviewClock').open = false;
  });
  document.addEventListener('focusin', event => {
    if ($('islandPreviewClock').open && !$('islandPreviewClock').contains(event.target)) $('islandPreviewClock').open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && previewOpen && !document.querySelector('dialog[open]') && !event.target.closest('input, select, textarea')) {
      if ($('islandPreviewClock').open) {
        $('islandPreviewClock').open = false; $('islandPreviewClock').querySelector('summary').focus({ preventScroll: true }); event.preventDefault(); return;
      }
      closeFloatingPreview(); event.preventDefault();
    }
  });
  new MutationObserver(() => { if ($('view-island').classList.contains('hidden')) closeFloatingPreview(false); }).observe($('view-island'), { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  $('logoutButton').addEventListener('click', async event => {
    if (!dirty) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!await confirmDutyChange('退出登录', '退出登录会放弃教室浮岛中未保存的修改。', '确认退出', 'logoutButton')) return;
    dirty = false;
    $('logoutButton').click();
  }, true);
  window.addEventListener('iceclass-ready', () => { fillClasses(); void load(true); });
  window.addEventListener('iceclass-classes-changed', () => {
    fillClasses();
    if (!$('islandClass').value || $('islandClass').value !== loadedClass) {
      // A class removed from the authorized list must never remain editable.
      ++loadId; busy = false; profile = config = null; loadedClass = ''; dirty = false;
      void load(true);
    }
  });
  setInterval(async () => {
    if (document.hidden || !config || busy || polling || $('view-island').classList.contains('hidden')) return;
    renderPreview();
    const classId = loadedClass, requestId = loadId;
    polling = true;
    try {
      const remote = await api('/api/island/classes/' + encodeURIComponent(classId));
      if (classId !== loadedClass || requestId !== loadId || busy) return;
      renderDelivery(remote.devices, remote.revision);
      if (remote.revision > profile.revision) $('islandSyncNotice').textContent = `本班配置已被其他老师更新到版本 ${remote.revision}。当前编辑内容未改变，重新载入可查看最新版。`;
    } catch {
      if (classId === loadedClass && requestId === loadId) $('islandDeliveryNote').textContent = '暂时无法获取设备状态，正在显示上次结果。';
    } finally { polling = false; }
  }, 15000);
  if (window.ICeClass?.state.user) { fillClasses(); void load(true); }
})();

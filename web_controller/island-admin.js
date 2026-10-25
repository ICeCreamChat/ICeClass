(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = (...args) => window.ICeClass.api(...args);
  const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const weekNames = { all: '每周', odd: '单周', even: '双周' };
  const tabs = ['timetable', 'slots', 'overrides', 'settings', 'components', 'automation'];
  let profile, config, dirty = false, busy = false, loadedClass = '', tab = 'timetable', week = 'all';
  let fieldId = 0, loadId = 0, polling = false, livePreview = true;
  const ribbon = new window.ICeClassIslandRibbon($('islandPreview'), $('islandPreviewStage'));
  ribbon.onChange = () => {
    $('islandPreviewPlay').textContent = ribbon.playing ? '暂停演示' : ribbon.elapsed === null ? '播放提醒' : '继续演示';
    $('islandMotionSeekLabel').hidden = ribbon.elapsed === null;
    $('islandMotionSeek').value = ribbon.elapsed || 0;
  };

  const clock = n => Number.isFinite(n) ? `${Math.floor(n / 60)}`.padStart(2, '0') + ':' + `${n % 60}`.padStart(2, '0') : '';
  const minute = value => /^\d{2}:\d{2}$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const nowClock = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const className = () => $('islandClass').selectedOptions[0]?.text || '班级配置';
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value + 'T12:00:00Z'));

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
    choices.forEach(([key, label]) => node.append(new Option(label, key)));
    node.value = value;
    node.onchange = () => { clearFieldError(node); action(node.value); if (tracked) mark(); };
    return node;
  }
  function area(value, action, maximum, path) {
    const node = keyed(el('textarea'), path);
    node.value = value || '';
    node.maxLength = maximum;
    node.rows = 2;
    node.oninput = () => { clearFieldError(node); action(node.value.replace(/[\r\n\t]+/g, ' ')); mark(); };
    return node;
  }
  function field(label, control, hint, cls = '') {
    const wrap = el('div', undefined, 'island-field' + (cls ? ' ' + cls : ''));
    control.id ||= `island-field-${++fieldId}`;
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
  function disabled(control, value) {
    control.disabled = value;
    control.closest('.island-field, .island-toggle')?.classList.toggle('is-disabled', value);
  }
  function status(message) {
    $('view-island').dataset.dirty = String(dirty);
    $('islandEditingClass').textContent = loadedClass ? className() : '班级配置';
    $('islandDirty').textContent = message || (dirty ? '有未保存的修改' : profile?.revision ? `版本 ${profile.revision} · 已保存` : '尚未保存配置');
    $('islandSave').disabled = busy || !config || !dirty;
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
    $('islandSave').disabled = value || !config || !dirty;
    $('islandSave').textContent = label || '保存并下发';
    $('islandReload').disabled = value;
    $('islandClass').disabled = value;
    ['islandCopy', 'islandImport', 'islandExport', 'islandImportFile'].forEach(id => $(id).disabled = value || !config);
  }
  function regularLesson(slotId, weekday, scope) {
    return config.lessons.find(l => l.slotId === slotId && l.weekday === weekday && l.week === scope)
      || (scope !== 'all' ? config.lessons.find(l => l.slotId === slotId && l.weekday === weekday && l.week === 'all') : null);
  }
  function scheduleFor(on) {
    if (!validDate(on) || !validDate(config.weekAnchor)) return [];
    const date = new Date(on + 'T12:00:00Z');
    const weekday = date.getUTCDay() || 7;
    const parity = ((Math.floor((date - new Date(config.weekAnchor + 'T12:00:00Z')) / 604800000) % 2) + 2) % 2 === 0 ? 'odd' : 'even';
    return [...config.slots].sort((a, b) => a.start - b.start).flatMap(slot => {
      const override = config.overrides.find(o => o.date === on && o.slotId === slot.id);
      const lesson = override || regularLesson(slot.id, weekday, parity);
      return lesson && !lesson.cancelled ? [{ ...slot, ...lesson, temporary: !!override }] : [];
    });
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
    ribbon.update({ date: on, minute: m, lessons, appearance: config.appearance, reminders: config.reminders, message, className: className() });
    $('islandPreviewPlay').disabled = !lessons.length;
    $('islandMotionNote').textContent = lessons.length ? '播放仅用于预览，不会向教室发送通知。' : '设置当日课程后，可以播放提醒动画。';
    $('islandPreviewSummary').textContent = !config.enabled ? '教室岛已关闭。保存后，教室端将隐藏悬浮岛。'
      : current && config.appearance.hideDuringLessons ? `上课期间自动隐藏 · ${message}` : message;
    $('islandTodayTitle').textContent = `当日课程${lessons.length ? ` · ${lessons.length} 节` : ''}`;
    const list = $('islandToday');
    list.replaceChildren();
    lessons.forEach(lesson => {
      const row = el('div', undefined, 'island-today-row');
      row.classList.toggle('is-current', lesson === current);
      row.append(el('span', `${clock(lesson.start)}—${clock(lesson.end)}`, 'muted'), el('strong', lesson.subject),
        el('span', [lesson.teacher, lesson.location, lesson.temporary ? '临时调课' : ''].filter(Boolean).join(' · '), 'muted'));
      list.append(row);
    });
    if (!lessons.length) list.append(el('p', '这一天没有课程；请检查周课表、周次或临时调课。', 'hint'));
    const components = $('islandComponentPreview');
    components.replaceChildren();
    config.components.filter(c => c.enabled).forEach(component => {
      let content = component.text || component.title || '尚未填写文字';
      if (component.type === 'date') content = validDate(on) ? on.replaceAll('-', '.') + ' ' + weekdays[(new Date(on + 'T12:00:00Z').getUTCDay() + 6) % 7] : '日期';
      if (component.type === 'countdown') {
        const days = Math.round((Date.parse(component.date + 'T12:00:00Z') - Date.parse(on + 'T12:00:00Z')) / 86400000);
        content = `${component.title || '倒数日'} · ${Number.isFinite(days) ? days > 0 ? `还有 ${days} 天` : days === 0 ? '就是今天' : `已过 ${-days} 天` : '请选择日期'}`;
      }
      components.append(el('span', content));
    });
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
  function addRow(body, controls) {
    const row = body.insertRow();
    controls.forEach((control, index) => {
      const cell = row.insertCell();
      cell.append(control instanceof Node ? control : document.createTextNode(control));
      cell.querySelectorAll('input,select').forEach(node => {
        if (!node.hasAttribute('aria-label')) node.setAttribute('aria-label', body.parentElement.tHead.rows[0].cells[index].textContent + ' · 第 ' + row.rowIndex + ' 行');
      });
    });
  }
  function empty(title, description, action) {
    const node = el('div', undefined, 'island-empty');
    node.append(el('strong', title), el('div', description));
    if (action) node.append(action);
    return node;
  }
  function heading(title, note, action) {
    const row = el('div', undefined, 'island-section-heading'), copy = el('div');
    copy.append(el('h2', title));
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
  function renderTimetable(root) {
    root.append(heading('每周课程安排', '点击课程格编辑。可分别设置单周、双周课程；临时调整请使用“临时调课”。', button('编辑作息时间', () => changeTab('slots'))));
    const filters = el('div', undefined, 'island-filters');
    filters.append(field('第一周的周一', input(config.weekAnchor, value => config.weekAnchor = value, 'date', { required: true }, 'weekAnchor'), '从这一天起计算单双周。'),
      field('查看与编辑周次', select(week, [['all', '每周 · 显示全部安排'], ['odd', '单周课程'], ['even', '双周课程']], value => { week = value; render(); }, 'editingWeek', false)));
    root.append(filters);
    if (!config.slots.length) {
      root.append(empty('先设置作息时间', '添加上课、下课时间后，再填写各节课的科目。', button('添加作息时段', () => changeTab('slots'), 'btn primary')));
      return;
    }
    root.append(el('p', '窄屏可在表格中左右滚动，查看周一至周日。', 'hint island-scroll-hint'));
    const { wrap, body } = table(['时段', ...weekdays], 'island-week', '周课表，左右滚动查看所有星期');
    [...config.slots].sort((a, b) => a.start - b.start).forEach(slot => {
      const label = el('div', undefined, 'island-slot-label');
      label.append(el('strong', slot.label), el('small', `${clock(slot.start)}—${clock(slot.end)}`));
      const cells = [label];
      weekdays.forEach((dayName, index) => {
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
      addRow(body, cells);
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
      note.textContent = scope === 'all' ? '保存为“每周”会同时设置本格的单周和双周课程。' : `仅修改${weekNames[scope]}；另一周的课程会保留。`;
    }
    form.append(el('p', `${clock(slot.start)}—${clock(slot.end)}`, 'hint'),
      field('生效周次', select(scope, [['all', '每周'], ['odd', '单周'], ['even', '双周']], value => { scope = value; fill(); }, null, false)),
      field('科目', subject), field('任课教师（选填）', teacher), field('上课地点（选填）', location), note);
    function removeScope() {
      config.lessons = config.lessons.flatMap(lesson => {
        if (lesson.slotId !== slot.id || lesson.weekday !== weekday) return [lesson];
        if (scope === 'all' || lesson.week === scope) return [];
        if (lesson.week === 'all') return [{ ...lesson, week: scope === 'odd' ? 'even' : 'odd' }];
        return [lesson];
      });
    }
    const actions = el('div', undefined, 'island-inline');
    actions.append(button('清空本格课程', () => { removeScope(); mark(); render(); dialog.close(); }, 'btn danger'), button('取消', () => dialog.close()));
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
    root.append(heading('作息时间', '按本班作息设置时段。修改时间后，周课表中的课程会一起更新。最多 32 个时段。', add));
    if (!config.slots.length) { root.append(empty('还没有作息时段', '点击“添加时段”，填写名称和上课、下课时间。')); return; }
    const { wrap, body } = table(['时段名称', '上课时间', '下课时间', '操作'], 'island-slots', '作息时间表');
    config.slots.forEach((slot, index) => addRow(body, [
      input(slot.label, value => slot.label = value, 'text', { maxLength: 30, required: true }, `slots.${index}.label`),
      input(clock(slot.start), value => slot.start = minute(value), 'time', { required: true }, `slots.${index}.start`),
      input(clock(slot.end === 1440 ? 0 : slot.end), value => slot.end = value ? minute(value) || 1440 : null, 'time', { required: true }, `slots.${index}.end`),
      button('删除', () => {
        if ((config.lessons.some(l => l.slotId === slot.id) || config.overrides.some(o => o.slotId === slot.id)) && !confirm(`删除“${slot.label}”后，关联的周课表和临时调课也会移除。继续删除？`)) return;
        config.slots.splice(index, 1);
        config.lessons = config.lessons.filter(l => l.slotId !== slot.id);
        config.overrides = config.overrides.filter(o => o.slotId !== slot.id);
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
    root.append(heading('临时调课与停课', '只影响指定日期，不改变每周课表。停课后，该节课的课程提醒和自动化也会暂停。', add));
    if (!config.overrides.length) { root.append(empty('没有临时调整', '教室端会按每周课表运行。临时换课或停课时，在这里添加。')); return; }
    config.overrides.forEach((override, index) => {
      const card = el('section', undefined, 'island-rule');
      const top = el('div', undefined, 'island-rule-heading');
      top.append(el('h3', `调整 ${index + 1}`), button('删除调整', () => {
        config.overrides.splice(index, 1); mark(); render('add-override');
      }, 'btn danger'));
      const fields = el('div', undefined, 'island-fields');
      const path = `overrides.${index}`;
      fields.append(field('生效日期', input(override.date, value => override.date = value, 'date', { required: true }, path + '.date')),
        field('调整时段', select(override.slotId, config.slots.map(slot => [slot.id, `${slot.label} · ${clock(slot.start)}`]), value => override.slotId = value, path + '.slotId')),
        field('调整方式', select(override.cancelled ? 'cancel' : 'lesson', [['lesson', '更换课程'], ['cancel', '停课']], value => { override.cancelled = value === 'cancel'; render(); }, path + '.cancelled')));
      const subject = input(override.subject, value => override.subject = value, 'text', { maxLength: 40 }, path + '.subject');
      const teacher = input(override.teacher, value => override.teacher = value, 'text', { maxLength: 40 }, path + '.teacher');
      const location = input(override.location, value => override.location = value, 'text', { maxLength: 60 }, path + '.location');
      fields.append(field('调整后的科目', subject), field('任课教师（选填）', teacher), field('上课地点（选填）', location));
      card.append(top, fields);
      [subject, teacher, location].forEach(control => disabled(control, override.cancelled));
      if (override.cancelled) card.append(el('p', '当天该时段停课，不触发课程提醒。原课程信息会保留，方便改回调课。', 'hint'));
      root.append(card);
    });
  }
  function group(title, note, controls) {
    const node = el('fieldset', undefined, 'island-group');
    node.append(el('legend', title));
    if (note) node.append(el('p', note, 'hint'));
    const fields = el('div', undefined, 'island-fields');
    fields.append(...controls);
    node.append(fields);
    return node;
  }
  function renderSettings(root) {
    const r = config.reminders, a = config.appearance;
    root.append(heading('提醒与外观', '提醒会从悬浮岛展开，结束后自动收起。以下设置在保存后同步到本班教室端。'));
    function refresh() {
      root.querySelectorAll('[data-path^="reminders."]').forEach(control => {
        const key = control.dataset.path.split('.')[1];
        if (key === 'enabled') return;
        disabled(control, !r.enabled || (key === 'prepareMinutes' && !r.prepare) || (key === 'volume' && !r.sound && !r.speech));
      });
    }
    root.append(group('上下课提醒', '选择提醒时机，并设置课前提前量。', [
      toggle('启用上下课提醒', r, 'enabled', 'reminders.enabled', null, refresh),
      toggle('课前准备提醒', r, 'prepare', 'reminders.prepare', null, refresh),
      toggle('上课提醒', r, 'start', 'reminders.start'),
      toggle('下课提醒', r, 'end', 'reminders.end'),
      field('课前提前（分钟）', input(r.prepareMinutes, value => r.prepareMinutes = value, 'number', { min: 1, max: 30, required: true }, 'reminders.prepareMinutes'), '可设置 1–30 分钟。'),
      field('提醒停留（秒）', input(r.displaySeconds, value => r.displaySeconds = value, 'number', { min: 3, max: 60, required: true }, 'reminders.displaySeconds'), '可设置 3–60 秒。')
    ]), group('提醒声音', '声音和语音使用同一音量。关闭后仍可显示文字提醒。', [
      toggle('播放提示音', r, 'sound', 'reminders.sound', null, refresh),
      toggle('语音播报提醒', r, 'speech', 'reminders.speech', null, refresh),
      field('提醒音量（%）', input(r.volume, value => r.volume = value, 'number', { min: 0, max: 100, required: true }, 'reminders.volume'), '0 为静音，100 为最大音量。')
    ]), group('显示外观', '教室端收起时保持单行显示；屏幕缩放会影响实际大小。', [
      toggle('显示教室岛', config, 'enabled', 'enabled', '关闭后保留本班的课表和设置。'),
      field('屏幕位置', select(a.position, [['top-center', '顶部居中'], ['top-left', '左上角'], ['top-right', '右上角'], ['bottom-center', '底部居中']], value => a.position = value, 'appearance.position')),
      field('显示主题', select(a.theme, [['light', '浅色'], ['dark', '深色'], ['system', '跟随教室电脑系统']], value => a.theme = value, 'appearance.theme')),
      field('悬浮岛宽度', input(a.width, value => a.width = value, 'number', { min: 380, max: 1000, required: true }, 'appearance.width'), '380-1000；默认 560。数值越大，内容空间越宽。'),
      field('不透明度（%）', input(a.opacity, value => a.opacity = value, 'number', { min: 30, max: 100, required: true }, 'appearance.opacity'), '30–100；数值越低，背景越透明。')
    ]), group('自动隐藏', '减少悬浮岛对课堂演示的遮挡。', [
      toggle('全屏演示时隐藏', a, 'hideFullscreen', 'appearance.hideFullscreen'),
      toggle('上课期间隐藏', a, 'hideDuringLessons', 'appearance.hideDuringLessons', '按本班课表判断上课时间。')
    ]));
    const details = el('details', undefined, 'island-details');
    details.append(el('summary', '位置微调与鼠标操作'));
    const fields = el('div', undefined, 'island-fields');
    fields.append(field('水平偏移', input(a.offsetX, value => a.offsetX = value, 'number', { min: -2000, max: 2000, required: true }, 'appearance.offsetX'), '正数向右，负数向左；0 为不偏移。'),
      field('垂直偏移', input(a.offsetY, value => a.offsetY = value, 'number', { min: -2000, max: 2000, required: true }, 'appearance.offsetY'), '正数向下，负数向上；0 为不偏移。'),
      toggle('鼠标点击穿过悬浮岛', a, 'clickThrough', 'appearance.clickThrough', '开启后，从教室首页或托盘恢复操作。'));
    details.append(fields); root.append(details); refresh();
  }
  function renderComponents(root) {
    const add = button('添加信息', () => {
      config.components.push({ id: crypto.randomUUID(), type: 'text', enabled: true, title: '班级寄语', text: '', date: '' });
      mark(); render(`components.${config.components.length - 1}.type`);
    }, 'btn', 'add-component');
    add.disabled = config.components.length >= 16;
    root.append(heading('轮播信息', '日期、倒数日和班级寄语会按下列顺序轮流显示。最多添加 16 项。', add),
      field('每项停留（秒）', input(config.rotationSeconds, value => config.rotationSeconds = value, 'number', { min: 3, max: 120, required: true }, 'rotationSeconds'), '可设置 3–120 秒。', 'is-short'));
    config.components.forEach((component, index) => {
      const card = el('section', undefined, 'island-rule'), top = el('div', undefined, 'island-rule-heading');
      const name = component.title || { date: '日期', countdown: '倒数日', text: '自定义文字' }[component.type];
      const title = keyed(el('h3', `${index + 1} · ${name}`), null, `component.${component.id}.heading`);
      title.tabIndex = -1;
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
      actions.append(up, down, remove); top.append(title, actions);
      const fields = el('div', undefined, 'island-fields'), path = `components.${index}`;
      fields.append(toggle('显示此项', component, 'enabled', path + '.enabled'),
        field('信息类型', select(component.type, [['date', '日期'], ['countdown', '倒数日'], ['text', '自定义文字']], value => {
          component.type = value;
          if (value === 'countdown' && !component.date) component.date = today();
          render();
        }, path + '.type')),
        field('标题（选填）', input(component.title, value => component.title = value, 'text', { maxLength: 40 }, path + '.title')));
      if (component.type === 'text') fields.append(field('显示文字', area(component.text, value => component.text = value, 240, path + '.text'), '最多 240 字，在教室岛中单行显示。', 'is-full'));
      if (component.type === 'countdown') fields.append(field('目标日期', input(component.date, value => component.date = value, 'date', { required: true }, path + '.date')));
      card.append(top, fields); root.append(card);
    });
    if (!config.components.length) root.append(empty('还没有轮播信息', '可以添加日期、重要日子的倒计时，或给班级的一句寄语。'));
  }
  function renderAutomation(root) {
    const add = button('添加规则', () => {
      config.automation.push({ id: crypto.randomUUID(), name: '新规则', enabled: true, trigger: 'time', minute: 480, weekdays: [1, 2, 3, 4, 5], action: 'reminder', value: '' });
      mark(); render(`automation.${config.automation.length - 1}.name`);
    }, 'btn', 'add-rule');
    add.disabled = config.automation.length >= 40;
    root.append(heading('自动化', '在指定时间，或按课表的上课、下课时机执行。同步后，教室端断网也能按规则运行。最多 40 条。', add));
    config.automation.forEach((rule, index) => {
      const card = el('section', undefined, 'island-rule'), top = el('div', undefined, 'island-rule-heading');
      top.append(el('h3', `规则 ${index + 1}`), button('删除规则', () => { config.automation.splice(index, 1); mark(); render('add-rule'); }, 'btn danger'));
      const fields = el('div', undefined, 'island-fields'), path = `automation.${index}`;
      fields.append(toggle('启用此规则', rule, 'enabled', path + '.enabled'),
        field('规则名称', input(rule.name, value => rule.name = value, 'text', { maxLength: 60, required: true }, path + '.name')),
        field('触发时机', select(rule.trigger, [['time', '指定时间'], ['prepare', '课前准备'], ['start', '上课时'], ['end', '下课时']], value => {
          rule.trigger = value;
          if (value !== 'time' && !Number.isInteger(rule.minute)) rule.minute = 480;
          render();
        }, path + '.trigger')));
      if (rule.trigger === 'time') fields.append(field('执行时间', input(clock(rule.minute), value => rule.minute = minute(value), 'time', { required: true }, path + '.minute')));
      fields.append(field('执行动作', select(rule.action, [['reminder', '显示提醒'], ['website', '打开网页'], ['app', '打开本机应用'], ['reading', '打开早读']], value => { rule.action = value; render(); }, path + '.action')));
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
    root.setAttribute('aria-labelledby', 'island-tab-' + tab);
    root.replaceChildren();
    ({ timetable: renderTimetable, slots: renderSlots, overrides: renderOverrides, settings: renderSettings, components: renderComponents, automation: renderAutomation })[tab](root);
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
    $('islandDeliveryNote').textContent = revision ? `当前已保存版本：${revision}` : '此班级尚未保存教室岛配置。';
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
    if (!devices.length) list.append(el('p', '该班还没有绑定教室设备。绑定后会自动获取已保存的配置。', 'hint'));
  }
  function clearClass() {
    profile = config = null; loadedClass = ''; dirty = false;
    $('islandTabContent').replaceChildren(empty('暂无可配置的班级', '请先创建班级，或联系管理员分配班级权限。'));
    ['islandToday', 'islandComponentPreview', 'islandDelivery'].forEach(id => $(id).replaceChildren());
    ribbon.clear();
    $('islandPreviewSummary').textContent = '';
    $('islandDeliveryNote').textContent = '';
    $('islandSyncNotice').textContent = '';
    status('暂无可配置的班级'); setBusy(false);
  }
  async function load(force = false) {
    if (busy) return;
    if (dirty && !force && !confirm('重新载入会放弃当前未保存的修改。继续载入？')) return;
    const classId = $('islandClass').value, requestId = ++loadId;
    if (!classId) { clearClass(); return; }
    $('islandError').textContent = '';
    setBusy(true); status('正在载入班级配置…');
    try {
      const data = await api('/api/island/classes/' + encodeURIComponent(classId));
      if (requestId !== loadId) return;
      profile = data; config = structuredClone(data.config); loadedClass = classId; dirty = false;
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
    const issue = validationIssue();
    if (issue) { showValidation(issue); return; }
    setBusy(true, '保存中…'); $('islandError').textContent = '';
    try {
      profile = await api('/api/island/classes/' + encodeURIComponent(loadedClass), { method: 'PUT', body: JSON.stringify({ revision: profile.revision, config }) });
      config = structuredClone(profile.config); dirty = false;
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
      if (!confirm('导入会替换当前的作息、周课表和临时调课，其他设置会保留。导入后可先检查，再保存下发。继续导入？')) return;
      setBusy(true); $('islandError').textContent = '';
      const data = await api('/api/island/classes/' + encodeURIComponent(loadedClass) + '/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      // Import previews are based on the server's saved profile. Merge only schedule
      // fields so an unsaved appearance, component or automation edit survives import.
      for (const key of ['weekAnchor', 'slots', 'lessons', 'overrides']) config[key] = structuredClone(data.config[key]);
      tab = 'timetable'; mark(); render();
      window.ICeClass.toast('课表已导入预览。检查后点击“保存并下发”。');
    } catch (error) { showError(error); }
    finally { setBusy(false); $('islandImportFile').value = ''; }
  }
  function copyDialog() {
    if (!config || busy) return;
    if (dirty) { showError(new Error('请先保存本班配置，再复制到其他班级。')); return; }
    const classes = window.ICeClass.state.classes.filter(c => c.id !== loadedClass && Number(c.enabled) === 1);
    const { dialog, form } = dialogForm('复制到其他班级', 'islandCopy');
    form.append(el('p', `使用“${className()}”已保存的全部教室岛设置，替换所选班级的现有配置。`, 'hint'));
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
  $('islandClass').onchange = () => {
    if (dirty && !confirm('切换班级会放弃当前未保存的修改。继续切换？')) { $('islandClass').value = loadedClass; return; }
    void load(true);
  };
  $('islandReload').onclick = () => void load();
  $('islandSave').onclick = () => void save();
  $('islandCopy').onclick = copyDialog;
  $('islandImportFile').onchange = event => void importFile(event.target.files[0]);
  $('islandImport').onclick = () => $('islandImportFile').click();
  $('islandExport').onclick = () => {
    if (!loadedClass || busy) return;
    if (dirty && !confirm('导出的是最近保存的课表，不包含当前未保存的修改。继续导出？')) return;
    location.href = '/api/island/classes/' + encodeURIComponent(loadedClass) + '/export';
  };
  $('islandPreviewDate').value = today(); $('islandPreviewTime').value = nowClock();
  [$('islandPreviewDate'), $('islandPreviewTime')].forEach(node => node.addEventListener('input', () => { livePreview = false; renderPreview(); }));
  $('islandPreviewNow').onclick = () => { livePreview = true; renderPreview(); };
  $('islandPreviewPlay').onclick = () => ribbon.play();
  $('islandMotionSeek').oninput = event => ribbon.seek(Number(event.target.value));
  $('islandPreviewExpand').onclick = () => {
    const dialog = el('dialog', undefined, 'island-motion-dialog');
    dialog.setAttribute('aria-label', '教室岛动画预览');
    const stage = $('islandPreviewStage'), controls = $('islandMotionControls'), marker = document.createComment('island-preview');
    stage.before(marker);
    const replay = button('重新播放', () => ribbon.reset()), close = button('关闭预览', () => dialog.close());
    const actions = el('div', undefined, 'island-motion-controls'); actions.append(replay, close);
    dialog.append(stage, controls, actions); document.body.append(dialog);
    $('islandPreviewExpand').disabled = true;
    dialog.addEventListener('close', () => {
      ribbon.stop(); marker.before(stage, controls); marker.remove(); dialog.remove();
      $('islandPreviewExpand').disabled = false; $('islandPreviewExpand').focus();
    }, { once: true });
    dialog.showModal(); close.focus();
  };
  new MutationObserver(() => { if ($('view-island').classList.contains('hidden')) ribbon.stop(); }).observe($('view-island'), { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  $('logoutButton').addEventListener('click', event => {
    if (dirty && !confirm('退出登录会放弃教室岛中未保存的修改。确认退出？')) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    dirty = false;
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

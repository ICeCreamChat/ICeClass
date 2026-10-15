(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const modes = { classic: '拔萝卜', carving: '诗词镌刻', particle: '粒子浮雕', rocket: '火箭升空' };
  let initialized = false, config = null, report = null, settingsDirty = false, boundClasses = new Set();
  const api = (...args) => window.ICeClass.api(...args);
  const error = e => window.ICeClass.toast(e.message);
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const duration = seconds => `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  const clock = minutes => minutes === 1440 ? '24:00' : `${Math.floor(minutes / 60)}`.padStart(2, '0') + ':' + `${minutes % 60}`.padStart(2, '0');
  const completed = c => [['carrots', '颗萝卜'], ['poems', '篇诗词'], ['badges', '次徽章'], ['launches', '次发射'], ['energy', '格能量']].filter(([k]) => c[k]).map(([k, label]) => c[k] + label).join('、') || '—';
  const minute = text => { const parts = text.split(':').map(Number); return parts[0] * 60 + parts[1]; };
  function node(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
  function table(headers, rows) {
    const wrap = node('div', undefined, 'table-wrap'), t = document.createElement('table');
    const head = t.createTHead().insertRow(); headers.forEach(h => { const th = node('th', h); th.scope = 'col'; head.append(th); });
    const body = t.createTBody(); rows.forEach(values => { const row = body.insertRow(); values.forEach(v => row.insertCell().append(v instanceof Node ? v : document.createTextNode(v ?? '—'))); });
    wrap.append(t); return wrap;
  }
  function query() {
    return new URLSearchParams({ start: $('readingStart').value, end: $('readingEnd').value, classId: $('readingClass').value });
  }
  function addPeriod(value = { weekdays: [1, 2, 3, 4, 5], start: 440, end: 470 }) {
    const row = node('div', undefined, 'reading-period'), days = node('div', undefined, 'reading-days');
    ['一', '二', '三', '四', '五', '六', '日'].forEach((label, i) => {
      const item = node('label'), input = document.createElement('input'); input.type = 'checkbox'; input.value = i + 1; input.checked = value.weekdays.includes(i + 1);
      item.append(input, document.createTextNode('周' + label)); days.append(item);
    });
    const start = document.createElement('input'), end = document.createElement('input');
    start.type = end.type = 'time'; start.required = end.required = true;
    start.value = clock(value.start); end.value = clock(value.end === 1440 ? 0 : value.end);
    start.setAttribute('aria-label', '早读开始时间'); end.setAttribute('aria-label', '早读结束时间');
    end.title = '结束时间 00:00 表示当天结束（24:00）';
    const remove = node('button', '删除时段', 'btn'); remove.type = 'button'; remove.onclick = () => { row.remove(); settingsDirty = true; };
    row.append(days, start, node('span', '至'), end, remove); $('readingPeriods').append(row);
  }
  async function loadSettings(refreshEditor = false) {
    if (window.ICeClass.state.user.role !== 'superadmin') return;
    const data = await api('/api/reading/settings'); config = data.config;
    $('readingRuleStatus').textContent = config.enabled ? `已启用统计 · 声量门槛 ${config.threshold} · ${config.periods.length} 个时段 · 北京时间 · 晨读提醒${config.reminderEnabled !== false ? '已开启' : '已关闭'}` : '尚未启用统计。管理员保存统计时段后，各班活动自动计入。';
    $('readingRuleStatus').dataset.enabled = String(config.enabled);
    if (!refreshEditor || settingsDirty) return;
    $('readingEnabled').checked = config.enabled; $('readingThreshold').value = config.threshold; $('readingPeriods').replaceChildren(); config.periods.forEach(addPeriod);
    $('readingReminderEnabled').checked = config.reminderEnabled !== false;
  }
  async function saveSettings(event) {
    event.preventDefault(); $('readingSettingsError').textContent = '';
    const num = id => Number($(id).value);
    const value = { enabled: $('readingEnabled').checked, reminderEnabled: $('readingReminderEnabled').checked, threshold: num('readingThreshold'), periods: [...$('readingPeriods').children].map(row => {
      const times = row.querySelectorAll('input[type=time]'); return { weekdays: [...row.querySelectorAll('input[type=checkbox]:checked')].map(n => Number(n.value)), start: minute(times[0].value), end: minute(times[1].value) || 1440 };
    }) };
    const button = event.submitter; if (button) button.disabled = true;
    try { await api('/api/reading/settings', { method: 'PUT', body: JSON.stringify(value) }); settingsDirty = false; await loadSettings(true); window.ICeClass.toast('早读规则已保存，教室端将在 15 秒内同步。'); }
    catch (e) { $('readingSettingsError').textContent = e.message; }
    finally { if (button) button.disabled = false; }
  }
  async function loadReport() {
    report = await api('/api/reading/report?' + query());
    const used = report.rows.filter(r => r.activeSeconds > 0), total = report.rows.reduce((sum, r) => sum + r.effectiveSeconds, 0);
    $('readingOverview').replaceChildren();
    const symbols = ['M5 12h2l3-7 4 14 3-7h2', 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z', 'M6 5v14l12-7z'];
    [['有效发声总时长', duration(total), '每一秒投入，都在积累'], ['使用班级', `${used.length} / ${report.rows.length}`, '当前范围内有早读记录的班级'], ['使用次数', used.reduce((sum, r) => sum + r.sessions, 0), '所选日期内的早读活动']].forEach(([label, value, note], i) => {
      const item = node('div', undefined, 'metric'), heading = node('div',undefined,'metric-heading'), symbol = node('span',undefined,'metric-symbol');
      const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'), path = document.createElementNS(svg.namespaceURI,'path'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true'); path.setAttribute('d',symbols[i]); svg.append(path); symbol.append(svg);
      heading.append(node('span',label),symbol); const strong = node('strong');
      String(value).split(/(分|秒|\/)/).filter(Boolean).forEach(part => strong.append(node(/^(分|秒|\/)$/.test(part)?'small':'span',part.trim())));
      item.append(heading, strong, node('span',note,'metric-note')); $('readingOverview').append(item);
    });
    const rank = value => { const marker = node('span',value ?? '—','rank-marker'); marker.dataset.rank = value ?? ''; return marker; };
    const tags = values => { const wrap = node('div'); values.forEach(m => wrap.append(node('span',modes[m],'mode-tag'))); if (!values.length) wrap.textContent='—'; return wrap; };
    const ratio = value => { const wrap = node('div',undefined,'ratio-cell'); wrap.append(node('span',value === null?'—':value+'%')); if(value !== null) {const bar=node('div',undefined,'ratio-bar'),fill=node('span');fill.style.width=Math.min(100,Math.max(0,value))+'%';bar.append(fill);wrap.append(bar);}return wrap; };
    $('readingRanking').replaceChildren(report.rows.length ? table(['名次', '班级', '使用次数 / 天数', '运行时长', '有效发声', '达标占比', '模式', '完成量'], report.rows.map(r => [
      rank(r.rank), r.className, r.activeSeconds ? `${r.sessions} 次 / ${r.days} 天` : '未使用', duration(r.activeSeconds), duration(r.effectiveSeconds), ratio(r.ratio), tags(r.modes), completed(r.completed)
    ])) : node('div', '还没有获授权的班级。', 'empty'));
    $('readingDaily').replaceChildren(report.daily.length ? table(['日期', '班级', '使用次数', '运行时长', '有效发声', '完成量'], report.daily.map(r => [r.day, r.className, `${r.sessions} 次`, duration(r.activeSeconds), duration(r.effectiveSeconds), completed(r.completed)])) : node('div', '所选日期还没有早读记录。', 'empty'));
    $('readingReportStatus').textContent = '更新于 ' + new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'}).format(new Date());
    void window.ICeClassCalendar?.refresh();
  }
  async function loadControls() {
    const data = await api('/api/classroom-controls');
    const available = window.ICeClass.state.classes.filter(c => Number(c.enabled)===1 && data.devices.some(d => d.class_id===c.id && Number(d.enabled)===1));
    boundClasses = new Set(available.map(c=>c.id));
    const previous=$('controlClass').value;
    $('controlClass').replaceChildren(new Option('请选择已绑定班级',''));
    if (available.length) $('controlClass').append(new Option('全部已绑定班级','all'));
    available.forEach(c=>$('controlClass').append(new Option(c.name + (data.devices.some(d=>d.class_id===c.id && d.online)?' · 在线':' · 离线'),c.id)));
    if([...$('controlClass').options].some(o=>o.value===previous)) $('controlClass').value=previous;
    const selected=$('controlClass').value;
    const rows = data.devices.filter(d => !selected || selected === 'all' || d.class_id === selected);
    $('controlOverview').textContent = `${available.length} 个已绑定班级 · ${data.devices.filter(d=>d.online).length} 台设备在线 · ${data.devices.length} 台已绑定设备`;
    document.querySelectorAll('.control-actions button').forEach(b=>b.disabled=!available.length);
    const badge = (text, cls) => node('span',text,'status '+cls);
    $('controlDevices').replaceChildren(rows.length ? table(['班级 / 电脑', '绑定核实', '在线状态', '当前音量', '管理员设置', '应用状态', '操作'], rows.map(d => {
      const supports = d.capabilities.includes('volume');
      const state = !d.enabled ? '已停用' : !supports ? '需安装班伴教室端 2.0.0' : d.command_error && d.command_id === d.desired_command ? d.command_error
        : d.desired_volume === null ? '尚未设置' : !d.online ? '待上线应用' : d.command_id !== d.desired_command ? '等待教室确认'
        : d.actual_volume === null ? '无法读取当前音量' : d.actual_volume !== d.desired_volume ? '当前音量已变化' : '已应用';
      const identity=node('div',undefined,'device-detail');identity.append(node('strong',d.class_name+' / '+d.name),node('span',d.computer_name || '等待电脑上报'),node('span',d.device_code,'device-code'),node('span',(d.local_addresses || []).join('、') || '局域网地址尚未上报'));
      if(d.binding_note)identity.append(node('span',d.binding_note));
      const verification=node('div',undefined,'device-detail');verification.append(badge(d.verified_at?'已核实':'待核实',d.verified_at?'enabled':'offline'));
      if(d.class_device_count>1)verification.append(node('span',`同班 ${d.class_device_count} 台 · 请核对`));
      const manage=node('button','核实 / 改绑','btn');manage.type='button';manage.onclick=()=>window.ICeClassAdmin.openDevice(d);
      return [identity, verification, badge(d.online ? '在线' : '离线',d.online?'enabled':'offline'), d.actual_volume === null ? '—' : d.actual_volume + '%', d.desired_volume === null ? '—' : d.desired_volume + '%', state+' · '+(d.receiver_version || '版本未上报'), manage];
    })) : node('div', '所选班级还没有绑定教室设备。', 'empty'));
  }
  async function control(action, volume) {
    const selected = $('controlClass').value;
    if (!selected) return window.ICeClass.toast('请先选择操作班级。');
    if (action === 'set_volume' && (!Number.isInteger(volume) || volume < 0 || volume > 100)) return window.ICeClass.toast('音量需要在 0 至 100 之间。');
    const classes = window.ICeClass.state.classes.filter(c => boundClasses.has(c.id) && Number(c.enabled) === 1 && (selected === 'all' || c.id === selected));
    if (!classes.length) return window.ICeClass.toast('该班级没有启用的已绑定设备，请刷新后重试。');
    const buttons = [...document.querySelectorAll('.control-actions button')]; buttons.forEach(b => b.disabled = true);
    try {
      const results = await Promise.all(classes.map(c => api(`/api/classes/${encodeURIComponent(c.id)}/control`, { method: 'POST', body: JSON.stringify({ action, volume }) })));
      const delivered = results.reduce((sum, r) => sum + r.delivered, 0);
      $('controlMessage').textContent = action === 'set_volume' ? `已为 ${classes.length} 个班级保存 ${volume}% 播放音量，发往 ${delivered} 台在线教室端。请查看下方应用状态。` : `打开早读的指令已发往 ${delivered} 台在线教室端。`;
      await loadControls();
    } catch (e) { error(e); } finally { buttons.forEach(b => b.disabled = !boundClasses.size); }
  }
  function syncClasses() {
    const reading = $('readingClass').value, control = $('controlClass').value;
    $('readingClass').replaceChildren(new Option('全部获授权班级', ''));
    window.ICeClass.state.classes.forEach(c => { $('readingClass').append(new Option(c.name, c.id)); });
    if ([...$('readingClass').options].some(o => o.value === reading)) $('readingClass').value = reading;
    if ([...$('controlClass').options].some(o => o.value === control)) $('controlClass').value = control;
    window.ICeClassCalendar?.syncClasses();
  }
  function initialize() {
    if (initialized || !window.ICeClass?.state.user) return;
    initialized = true;
    $('readingStart').value = $('readingEnd').value = today();
    syncClasses();
    $('readingSettingsForm').addEventListener('input', () => { settingsDirty = true; });
    $('readingSettingsForm').addEventListener('submit', saveSettings);
    $('readingAddPeriod').onclick = () => { addPeriod(); settingsDirty = true; };
    $('readingRefresh').onclick = () => loadReport().catch(error);
    $('readingClass').onchange = () => loadReport().catch(error);
    $('readingToday').onclick = () => { $('readingStart').value = $('readingEnd').value = today(); $('readingToday').classList.add('active');$('readingWeek').classList.remove('active'); void loadReport().catch(error); };
    $('readingWeek').onclick = () => { const now = new Date(today() + 'T00:00:00Z'); now.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7)); $('readingStart').value = now.toISOString().slice(0, 10); $('readingEnd').value = today(); $('readingWeek').classList.add('active');$('readingToday').classList.remove('active'); void loadReport().catch(error); };
    ['readingStart','readingEnd'].forEach(id=>$(id).onchange=()=>{$('readingToday').classList.remove('active');$('readingWeek').classList.remove('active');});
    $('readingExport').onclick = () => { location.href = '/api/reading/export?' + query(); };
    $('controlApply').onclick = () => void control('set_volume', Number($('controlVolume').value));
    $('control30').onclick = () => { $('controlVolume').value = 30; void control('set_volume', 30); };
    $('control50').onclick = () => { $('controlVolume').value = 50; void control('set_volume', 50); };
    $('controlOpenReading').onclick = () => void control('open_reading');
    $('controlRefresh').onclick = () => loadControls().catch(error);
    $('controlClass').onchange = () => loadControls().catch(error);
    $('mainNav').addEventListener('click', e => {
      const view = e.target.closest('[data-view]')?.dataset.view;
      if (view === 'reading' || view === 'controls') syncClasses();
      if (view === 'reading') { void loadReport().catch(error); void loadSettings().catch(error); }
      if (view === 'controls') void loadControls().catch(error);
    });
    void loadSettings(true).catch(error);
    void loadReport().catch(error);
    setInterval(() => { if (!$('view-reading').classList.contains('hidden')) void loadReport().catch(() => {}); }, 15000);
    setInterval(() => { if (!$('view-controls').classList.contains('hidden') && window.ICeClass.state.user.role === 'superadmin') void loadControls().catch(() => {}); }, 5000);
  }
  window.addEventListener('iceclass-ready', initialize);
  window.addEventListener('iceclass-classes-changed', () => {syncClasses();void loadReport().catch(error);if(window.ICeClass.state.user.role==='superadmin')void loadControls().catch(error);});
  initialize();
})();

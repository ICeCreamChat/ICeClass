(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const modes = { classic: '拔萝卜', carving: '诗词镌刻', particle: '粒子浮雕', rocket: '火箭升空' };
  let initialized = false, config = null, report = null, settingsDirty = false;
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
    const data = await api('/api/reading/settings'); config = data.config;
    $('readingRuleStatus').textContent = config.enabled ? `已启用统计 · 声量门槛 ${config.threshold} · ${config.periods.length} 个时段 · 北京时间` : '尚未启用统计。管理员保存统计时段后，各班活动自动计入。';
    if (!refreshEditor || settingsDirty) return;
    $('readingEnabled').checked = config.enabled; $('readingThreshold').value = config.threshold; $('readingPeriods').replaceChildren(); config.periods.forEach(addPeriod);
    for (const [id, value] of Object.entries({ readingClassicDuration: config.classic.duration, readingClassicTarget: config.classic.targetCount, readingRocketDuration: config.rocket.duration, readingRocketTarget: config.rocket.targetCount, readingCarvingSpeed: config.carving.speed, readingParticleSpeed: config.particle.speed })) $(id).value = value;
  }
  async function saveSettings(event) {
    event.preventDefault(); $('readingSettingsError').textContent = '';
    const num = id => Number($(id).value);
    const value = { enabled: $('readingEnabled').checked, threshold: num('readingThreshold'), periods: [...$('readingPeriods').children].map(row => {
      const times = row.querySelectorAll('input[type=time]'); return { weekdays: [...row.querySelectorAll('input[type=checkbox]:checked')].map(n => Number(n.value)), start: minute(times[0].value), end: minute(times[1].value) || 1440 };
    }), classic: { duration: num('readingClassicDuration'), targetCount: num('readingClassicTarget') }, rocket: { duration: num('readingRocketDuration'), targetCount: num('readingRocketTarget') }, carving: { speed: num('readingCarvingSpeed') }, particle: { speed: num('readingParticleSpeed') } };
    const button = event.submitter; if (button) button.disabled = true;
    try { await api('/api/reading/settings', { method: 'PUT', body: JSON.stringify(value) }); settingsDirty = false; await loadSettings(true); window.ICeClass.toast('早读规则已保存，教室页面会自动同步。'); }
    catch (e) { $('readingSettingsError').textContent = e.message; }
    finally { if (button) button.disabled = false; }
  }
  async function loadReport() {
    report = await api('/api/reading/report?' + query());
    const used = report.rows.filter(r => r.activeSeconds > 0), total = report.rows.reduce((sum, r) => sum + r.effectiveSeconds, 0);
    $('readingOverview').replaceChildren();
    [['有效发声总时长', duration(total)], ['使用班级', `${used.length} / ${report.rows.length}`], ['使用次数', used.reduce((sum, r) => sum + r.sessions, 0)]].forEach(([label, value]) => {
      const item = node('div'); item.append(node('span', label, 'reading-note'), node('strong', value)); $('readingOverview').append(item);
    });
    $('readingRanking').replaceChildren(report.rows.length ? table(['名次', '班级', '使用次数 / 天数', '运行时长', '有效发声', '达标占比', '模式', '完成量'], report.rows.map(r => [
      r.rank ?? '—', r.className, r.activeSeconds ? `${r.sessions} 次 / ${r.days} 天` : '未使用', duration(r.activeSeconds), duration(r.effectiveSeconds), r.ratio === null ? '—' : r.ratio + '%', r.modes.map(m => modes[m]).join('、') || '—', completed(r.completed)
    ])) : node('div', '还没有获授权的班级。', 'empty'));
    $('readingDaily').replaceChildren(report.daily.length ? table(['日期', '班级', '使用次数', '运行时长', '有效发声', '完成量'], report.daily.map(r => [r.day, r.className, `${r.sessions} 次`, duration(r.activeSeconds), duration(r.effectiveSeconds), completed(r.completed)])) : node('div', '所选日期还没有早读记录。', 'empty'));
  }
  async function loadControls() {
    const data = await api('/api/classroom-controls'), selected = $('controlClass').value;
    const rows = data.devices.filter(d => !selected || selected === 'all' || d.class_id === selected);
    $('controlDevices').replaceChildren(rows.length ? table(['班级 / 设备', '在线状态', '当前音量', '管理员设置', '应用状态', '教室端版本'], rows.map(d => {
      const supports = d.capabilities.includes('volume');
      const state = !d.enabled ? '已停用' : !supports ? '需安装班伴教室端 2.0.0' : d.command_error && d.command_id === d.desired_command ? d.command_error
        : d.desired_volume === null ? '尚未设置' : !d.online ? '待上线应用' : d.command_id !== d.desired_command ? '等待教室确认'
        : d.actual_volume === null ? '无法读取当前音量' : d.actual_volume !== d.desired_volume ? '当前音量已变化' : '已应用';
      return [d.class_name + ' / ' + d.name, d.online ? '在线' : '离线', d.actual_volume === null ? '—' : d.actual_volume + '%', d.desired_volume === null ? '—' : d.desired_volume + '%', state, d.receiver_version || '—'];
    })) : node('div', '所选班级还没有绑定教室设备。', 'empty'));
  }
  async function control(action, volume) {
    const selected = $('controlClass').value;
    if (!selected) return window.ICeClass.toast('请先选择操作班级。');
    if (action === 'set_volume' && (!Number.isInteger(volume) || volume < 0 || volume > 100)) return window.ICeClass.toast('音量需要在 0 至 100 之间。');
    const classes = window.ICeClass.state.classes.filter(c => Number(c.enabled) === 1 && (selected === 'all' || c.id === selected));
    const buttons = [...document.querySelectorAll('.control-actions button')]; buttons.forEach(b => b.disabled = true);
    try {
      const results = await Promise.all(classes.map(c => api(`/api/classes/${encodeURIComponent(c.id)}/control`, { method: 'POST', body: JSON.stringify({ action, volume }) })));
      const delivered = results.reduce((sum, r) => sum + r.delivered, 0);
      $('controlMessage').textContent = action === 'set_volume' ? `已为 ${classes.length} 个班级保存 ${volume}% 播放音量，发往 ${delivered} 台在线教室端。请查看下方应用状态。` : `打开早读的指令已发往 ${delivered} 台在线教室端。`;
      await loadControls();
    } catch (e) { error(e); } finally { buttons.forEach(b => b.disabled = false); }
  }
  function syncClasses() {
    const reading = $('readingClass').value, control = $('controlClass').value;
    $('readingClass').replaceChildren(new Option('全部获授权班级', ''));
    $('controlClass').replaceChildren(new Option('请选择班级', ''), new Option('全部启用班级', 'all'));
    window.ICeClass.state.classes.forEach(c => { $('readingClass').append(new Option(c.name, c.id)); if (Number(c.enabled) === 1) $('controlClass').append(new Option(c.name, c.id)); });
    if ([...$('readingClass').options].some(o => o.value === reading)) $('readingClass').value = reading;
    if ([...$('controlClass').options].some(o => o.value === control)) $('controlClass').value = control;
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
    $('readingToday').onclick = () => { $('readingStart').value = $('readingEnd').value = today(); void loadReport().catch(error); };
    $('readingWeek').onclick = () => { const now = new Date(today() + 'T00:00:00Z'); now.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7)); $('readingStart').value = now.toISOString().slice(0, 10); $('readingEnd').value = today(); void loadReport().catch(error); };
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
  initialize();
})();

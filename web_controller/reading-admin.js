(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let initialized = false, config = null, report = null, settingsDirty = false, boundClasses = new Set(), reportGeneration = 0;
  let reportRequest = null, controlsRequest = null, controlsSignature = '';
  const visible = view => !document.hidden && !$(`view-${view}`).classList.contains('hidden');
  const selectedGrades = new Set();
  const gradeOf = name => {
    const match = String(name || '').normalize('NFKC').replace(/\s/g, '').match(/^高([一二三123])(?=[^0-9]|$)/);
    return match ? '高' + ({1: '一', 2: '二', 3: '三'}[match[1]] || match[1]) : '其他';
  };
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
    const params = new URLSearchParams({ start: $('readingStart').value, end: $('readingEnd').value, classId: $('readingClass').value });
    if (selectedGrades.size) params.set('grades', [...selectedGrades].join(','));
    return params;
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
    if (!['superadmin', 'principal'].includes(window.ICeClass.state.user.role)) return;
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
    const key = query().toString();
    if (reportRequest?.key === key) return reportRequest.promise;
    const promise = fetchReport(key);
    reportRequest = {key, promise};
    try { return await promise; }
    finally { if (reportRequest?.promise === promise) reportRequest = null; }
  }
  async function fetchReport(key) {
    const request = ++reportGeneration;
    $('readingRanking').setAttribute('aria-busy', 'true');
    let data;
    try { data = await api('/api/reading/report?' + key); }
    catch (e) {
      if (request === reportGeneration) {
        $('readingRanking').setAttribute('aria-busy', 'false');
        $('readingReportStatus').textContent = report ? '刷新失败，当前为上次查询的记录。请重试。' : '暂时无法读取成绩，请点击“查询”重试。';
        if (!report) $('readingRanking').replaceChildren(node('div', '成绩暂时无法读取，请重新查询。', 'empty'));
      }
      throw e;
    }
    if (request !== reportGeneration) return;
    const unchanged = report && JSON.stringify(report) === JSON.stringify(data);
    report = data;
    const scope = report.grades?.join('、') || '全部年级';
    $('readingReportStatus').textContent = `${scope} · ${report.start} — ${report.end} · 更新于 ` + new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'}).format(new Date());
    if (unchanged) {
      $('readingRanking').setAttribute('aria-busy', 'false');
      void window.ICeClassCalendar?.refresh();
      return;
    }
    $('rankingTitle').textContent = (report.grades?.length ? scope : '') + '班级排行榜';
    const used = report.rows.filter(r => r.activeSeconds > 0), total = report.rows.reduce((sum, r) => sum + r.effectiveSeconds, 0);
    $('readingOverview').replaceChildren();
    const symbols = ['M5 12h2l3-7 4 14 3-7h2', 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z', 'M6 5v14l12-7z'];
    [['有效发声总时长', duration(total)], ['使用班级 / 总班级', `${used.length} / ${report.rows.length}`], ['使用次数', used.reduce((sum, r) => sum + r.sessions, 0)]].forEach(([label, value], i) => {
      const item = node('div', undefined, 'metric'), heading = node('div',undefined,'metric-heading'), symbol = node('span',undefined,'metric-symbol');
      const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'), path = document.createElementNS(svg.namespaceURI,'path'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true'); path.setAttribute('d',symbols[i]); svg.append(path); symbol.append(svg);
      heading.append(node('span',label),symbol); const strong = node('strong');
      String(value).split(/(分|秒|\/)/).filter(Boolean).forEach(part => strong.append(node(/^(分|秒|\/)$/.test(part)?'small':'span',part.trim())));
      item.append(heading, strong); $('readingOverview').append(item);
    });
    window.ICeClassRanking.render(report);
    $('readingDaily').replaceChildren(report.daily.length ? table(['日期', '班级', '使用次数', '运行时长', '有效发声', '完成量'], report.daily.map(r => [r.day, r.className, `${r.sessions} 次`, duration(r.activeSeconds), duration(r.effectiveSeconds), completed(r.completed)])) : node('div', '所选日期还没有早读记录。', 'empty'));
    void window.ICeClassCalendar?.refresh();
  }
  async function exportReport() {
    const button = $('readingExport'), params = query(); params.set('format', 'xlsx');
    button.disabled = true; button.textContent = '正在导出…';
    try {
      const response = await fetch('/api/reading/export?' + params, { credentials: 'same-origin' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `导出失败 (${response.status})，请重试。`);
      }
      const url = URL.createObjectURL(await response.blob()), link = node('a');
      link.href = url; link.download = `ICeClass 班伴-早读-${params.get('grades')?.replaceAll(',', '·') || '全部年级'}-${params.get('start')}-${params.get('end')}.xlsx`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { error(e); }
    finally { button.disabled = false; button.textContent = '导出 XLSX'; }
  }
  async function loadControls() {
    if (controlsRequest) return controlsRequest;
    controlsRequest = fetchControls();
    try { return await controlsRequest; }
    finally { controlsRequest = null; }
  }
  async function fetchControls() {
    const data = await api('/api/classroom-controls');
    const available = window.ICeClass.state.classes.filter(c => Number(c.enabled)===1 && data.devices.some(d => d.class_id===c.id && Number(d.enabled)===1));
    const signature = JSON.stringify([data, available, $('controlClass').value]);
    if (signature === controlsSignature) return;
    controlsSignature = signature;
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
      const state = !d.enabled ? '已停用' : !supports ? '需安装 ICeClass 班伴 · 教室端 2.0.0' : d.command_error && d.command_id === d.desired_command ? d.command_error
        : d.desired_volume === null ? '尚未设置' : !d.online ? '待上线应用' : d.command_id !== d.desired_command ? '等待教室确认'
        : d.actual_volume === null ? '无法读取当前音量' : d.actual_volume !== d.desired_volume ? '当前音量已变化' : '已应用';
      const identity=node('div',undefined,'device-detail');identity.append(node('strong',d.class_name+' / '+d.name),node('span',d.computer_name || '等待电脑上报'),node('span',d.device_code,'device-code'),node('span',(d.local_addresses || []).join('、') || '局域网地址尚未上报'));
      if(d.binding_note)identity.append(node('span',d.binding_note));
      const verification=node('div',undefined,'device-detail');verification.append(badge(d.verified_at?'已核实':'待核实',d.verified_at?'enabled':'offline'));
      if(d.class_device_count>1)verification.append(node('span',`同班 ${d.class_device_count} 台 · 请核对`));
      const manage=node('button','核实 / 改绑','btn');manage.type='button';manage.onclick=()=>window.ICeClassAdmin.openDevice(d);
      return [identity, verification, badge(d.online ? '在线' : '离线',d.online?'enabled':'offline'), d.actual_volume === null ? '—' : d.actual_volume + '%', d.desired_volume === null ? '—' : d.desired_volume + '%', state+' · '+(d.receiver_version || '版本未上报'), manage];
    })) : node('div', '所选班级还没有绑定教室设备。', 'empty'));
    const controlsTable = $('controlDevices').querySelector('table');
    if (controlsTable) {
      controlsTable.classList.add('control-device-table');
      const wrap = controlsTable.parentElement;
      wrap.tabIndex = 0; wrap.setAttribute('role', 'region');
      wrap.setAttribute('aria-label', '教室设备状态，可左右滚动');
    }
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
    $('readingClass').replaceChildren(new Option(selectedGrades.size ? '所选年级全部班级' : '全部获授权班级', ''));
    window.ICeClass.state.classes.filter(c => !selectedGrades.size || selectedGrades.has(gradeOf(c.name))).forEach(c => { $('readingClass').append(new Option(c.name, c.id)); });
    if ([...$('readingClass').options].some(o => o.value === reading)) $('readingClass').value = reading;
    if ([...$('controlClass').options].some(o => o.value === control)) $('controlClass').value = control;
    document.querySelector('[data-reading-grade="其他"]').classList.toggle('hidden', !window.ICeClass.state.classes.some(c => gradeOf(c.name) === '其他') && !selectedGrades.has('其他'));
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
    $('readingGradeFilter').onclick = event => {
      const grade = event.target.closest('[data-reading-grade]')?.dataset.readingGrade;
      if (!grade) return;
      if (grade === 'all') selectedGrades.clear();
      else if (selectedGrades.has(grade)) selectedGrades.delete(grade);
      else selectedGrades.add(grade);
      if (selectedGrades.size === 4) selectedGrades.clear();
      $('readingGradeFilter').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.readingGrade === 'all' ? !selectedGrades.size : selectedGrades.has(button.dataset.readingGrade))));
      $('readingGradeScope').textContent = selectedGrades.size ? '已选年级：' + [...selectedGrades].join('、') : '全部年级';
      $('readingClass').value = '';
      syncClasses();
      void loadReport().catch(error);
    };
    $('readingToday').onclick = () => { $('readingStart').value = $('readingEnd').value = today(); $('readingToday').classList.add('active');$('readingWeek').classList.remove('active'); void loadReport().catch(error); };
    $('readingWeek').onclick = () => { const now = new Date(today() + 'T00:00:00Z'); now.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7)); $('readingStart').value = now.toISOString().slice(0, 10); $('readingEnd').value = today(); $('readingWeek').classList.add('active');$('readingToday').classList.remove('active'); void loadReport().catch(error); };
    ['readingStart','readingEnd'].forEach(id=>$(id).onchange=()=>{$('readingToday').classList.remove('active');$('readingWeek').classList.remove('active');});
    $('readingExport').onclick = exportReport;
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
    setInterval(() => { if (visible('reading') && !reportRequest) void loadReport().catch(() => {}); }, 15000);
    setInterval(() => { if (visible('controls') && !controlsRequest) void loadControls().catch(() => {}); }, 5000);
    document.addEventListener('visibilitychange', () => {
      if (visible('reading')) void loadReport().catch(() => {});
      if (visible('controls')) void loadControls().catch(() => {});
    });
  }
  window.addEventListener('iceclass-ready', initialize);
  window.addEventListener('iceclass-classes-changed', () => {syncClasses();void loadReport().catch(error);void loadControls().catch(error);});
  initialize();
})();

(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const asset = name => `/assets/banban/${name}.webp`;
  let initialized = false, scope = {}, snapshot = null, connection = null, pending = null;
  let history = [], revision = 0, contextRevision = 0, moved = false, lastQuestion = '';
  let analysisClasses = null, schoolAnalysis = false;
  let panelPosition = null, settingsScroll = 0, settingsConfig = null, settingsBusy = false;
  let settingsTarget = 'account', settingsKeyAddress = '';
  let conversationReady = Promise.resolve(), lastIncomplete = null, changingConversation = false;
  let conversationId = null, threads = [], threadCursor = null, threadLoading = false, threadRevision = 0;
  let olderCursor = null, olderLoading = false, historyPolicy = null, historyPolicyBusy = false, conversationLoaded = false;
  let accountGeneration = 0;
  let deletingThread = null, deleteBusy = false;
  const drafts = new Map();
  let character = null;
  let reminder = null, reminderTimer = 0, lastActivity = Date.now(), reminderShown = false, disposed = false;
  let helloCount = 0, helloAt = 0;
  const grades = new Set();
  const api = (...args) => window.ICeClass.api(...args);
  const connectionProviders = [
    {id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash', 'deepseek-v4-pro'], docs: 'https://api-docs.deepseek.com/', addresses: /^https:\/\/api\.deepseek\.com(?:\/v1)?$/},
    {id: 'qwen', name: '阿里云百炼 · 千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-flash'], docs: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope', addresses: /^https:\/\/(?:dashscope(?:-intl|-us)?\.aliyuncs\.com|[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1|us-east-1)\.maas\.aliyuncs\.com)\/compatible-mode\/v1$/, addressNote: '默认使用中国内地地址；如平台提供业务空间专属地址，请在此替换。密钥需与地域一致。'},
    {id: 'glm', name: '智谱 · GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.7'], docs: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction', addresses: /^https:\/\/open\.bigmodel\.cn\/api\/paas\/v4$/},
    {id: 'kimi', name: 'Kimi · 月之暗面', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2.6'], docs: 'https://platform.kimi.com/docs/get-api-key', addresses: /^https:\/\/api\.moonshot\.(?:cn|ai)\/v1$/},
    {id: 'doubao', name: '豆包 · 火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-2-1-pro-260915'], docs: 'https://docs.volcengine.com/docs/ark/compatible-with-openai-sdk?lang=zh', addresses: /^https:\/\/ark\.cn-beijing\.volces\.com\/api\/v3$/, modelNote: '请确认已开通该模型；使用自建推理接入点时，请填写平台提供的 ep-… ID。'}
  ];
  function node(tag, text, cls) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  function mascot() {
    const result = node('span', undefined, 'bb-mascot'); result.setAttribute('aria-hidden', 'true');
    const image = document.createElement('img'); image.src = asset('portrait'); image.alt = ''; image.draggable = false; image.className = 'bb-portrait'; result.append(image);
    return result;
  }
  function button(text, cls, action) {
    const b = node('button', text, cls); b.type = 'button'; b.onclick = action; return b;
  }
  function icon(name) { return `/assets/banban/icons/${name}.svg`; }
  function composeState() {
    const input = $('bbInput'), count = input.value.length;
    $('bbInputCount').textContent = `${count} / 2000`;
    $('bbInputCount').hidden = count < 1600;
    input.style.height = 'auto';
    input.style.height = Math.min(120, Math.max(44, input.scrollHeight)) + 'px';
    $('bbSend').disabled = !conversationLoaded || changingConversation || (!pending && !input.value.trim());
  }
  function setScopeEditor(show, focus = true) {
    $('bbScopeEditor').hidden = !show;
    $('bbScopeToggle').setAttribute('aria-expanded', String(show));
    if (show) { options(false); $('bbStart').focus({preventScroll: true}); }
    else {
      grades.clear(); (scope.grades || '').split(',').filter(Boolean).forEach(g => grades.add(g));
      syncScope(); $('bbScopeError').textContent = '';
      if (focus) $('bbScopeToggle').focus({preventScroll: true});
    }
  }
  function duration(seconds) { return `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`; }
  function localDay() {
    return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
  }
  function classesForAnalysis() { return analysisClasses || window.ICeClass.state.classes; }
  function gradeOf(name) {
    const m = String(name || '').normalize('NFKC').replace(/\s/g, '').match(/^高([一二三123])(?=[^0-9]|$)/);
    return m ? '高' + ({1: '一', 2: '二', 3: '三'}[m[1]] || m[1]) : '其他';
  }
  function canOpenScope(target) {
    if (!analysisClasses) return false;
    const own = new Set(window.ICeClass.state.classes.map(c => c.id));
    if (target.classId) return own.has(target.classId);
    const selected = classesForAnalysis().filter(c => (!target.classId || c.id === target.classId) && (!target.grades?.length || target.grades.includes(gradeOf(c.name))));
    return selected.length > 0 && selected.every(c => own.has(c.id));
  }
  function canOpenView(view) {
    return !['classes', 'teachers'].includes(view) || ['superadmin', 'principal', 'director', 'grade_leader'].includes(window.ICeClass.state.user.role);
  }
  function fromPage() {
    const view = document.querySelector('#mainNav button.active')?.dataset.view;
    scope = {start: $('readingStart').value || localDay(), end: $('readingEnd').value || localDay(), classId: ''};
    const id = view === 'classroom-voice' ? $('classroomVoiceClass')?.value : view === 'history' ? $('historyClass')?.value : view === 'console' ? $('targetClass')?.value : view === 'reading' ? $('readingClass')?.value : '';
    if (classesForAnalysis().some(c => c.id === id)) scope.classId = id;
    grades.clear();
    if (view === 'reading') document.querySelectorAll('[data-reading-grade][aria-pressed=true]').forEach(b => { if (b.dataset.readingGrade !== 'all') grades.add(b.dataset.readingGrade); });
    scope.grades = [...grades].join(',');
    syncScope();
  }
  function classOptions(selected) {
    const select = $('bbClass'); select.replaceChildren(new Option(grades.size ? '所选年级的全部班级' : schoolAnalysis ? '全校班级' : '我的全部班级', ''));
    const order = ['高一', '高二', '高三', '其他'];
    classesForAnalysis().filter(c => !grades.size || grades.has(gradeOf(c.name)))
      .sort((a, b) => order.indexOf(gradeOf(a.name)) - order.indexOf(gradeOf(b.name)) || a.name.localeCompare(b.name, 'zh-CN', {numeric:true}))
      .forEach(c => select.append(new Option(c.name, c.id)));
    select.value = [...select.options].some(o => o.value === selected) ? selected : '';
  }
  function syncScope(keepDraft = false) {
    if (!keepDraft) {
      $('bbStart').value = scope.start; $('bbEnd').value = scope.end;
      classOptions(scope.classId || '');
      $('bbGrades').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.grade === 'all' ? !grades.size : grades.has(b.dataset.grade))));
    }
    const className = classesForAnalysis().find(c => c.id === scope.classId)?.name;
    const range = className || (scope.grades || '').split(',').filter(Boolean).join('、') || (schoolAnalysis ? '全校' : classesForAnalysis().length === 1 ? classesForAnalysis()[0].name : '我的班级');
    const dates = scope.start === scope.end ? scope.start.slice(5) : `${scope.start.slice(5)} — ${scope.end.slice(5)}`;
    $('bbScopeLabel').textContent = `${dates} · ${range}`;
    $('bbScopeLabel').title = `${scope.start} 至 ${scope.end} · ${range} · ${schoolAnalysis ? '全校数据分析' : '仅分析本人负责范围内的班级'}`;
    $('bbScopeToggle').setAttribute('aria-label', '分析范围：' + $('bbScopeLabel').title);
  }
  function modeNote() {
    const enabled = connection?.configured && connection?.enabled;
    $('bbModeNote').textContent = enabled ? '智能分析' : '数据速览';
    $('bbModeNote').title = enabled ? '仅分析您有权限查看的数据' : '智能分析尚未启用，当前提供服务器计算的数据速览';
    $('bbModeNote').dataset.state = enabled ? 'ready' : 'overview';
  }
  async function loadContext() {
    const rev = ++contextRevision;
    $('bbModeNote').textContent = '读取中';
    $('bbModeNote').title = '正在读取当前范围的数据';
    $('bbModeNote').dataset.state = 'loading';
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const data = await api('/api/banban/context?' + new URLSearchParams(scope), {signal: controller.signal});
      if (rev !== contextRevision) return;
      snapshot = data.snapshot; connection = data.connection;
      analysisClasses = data.classes || null; schoolAnalysis = Boolean(data.schoolAnalysis);
      syncScope(!$('bbScopeEditor').hidden); modeNote();
    } catch (e) {
      if (rev === contextRevision) {
        $('bbModeNote').textContent = '读取未完成';
        $('bbModeNote').title = e.name === 'AbortError' ? '读取较慢，可以直接提问重试' : '数据暂时无法读取，提问时将重新尝试';
        $('bbModeNote').dataset.state = 'error';
      }
    } finally { clearTimeout(timer); }
  }
  function movePanel(left, top) {
    const panel = $('bbPanel'), margin = innerWidth <= 600 ? 8 : 16;
    panelPosition = {
      left: Math.max(margin, Math.min(document.documentElement.clientWidth - panel.offsetWidth - margin, left)),
      top: Math.max(margin, Math.min(innerHeight - panel.offsetHeight - margin, top))
    };
    Object.assign(panel.style, {position: 'fixed', right: 'auto', bottom: 'auto', left: panelPosition.left + 'px', top: panelPosition.top + 'px'});
  }
  function positionPanel() {
    const panel = $('bbPanel');
    if (!panel || panel.hidden) return;
    if (panelPosition) { movePanel(panelPosition.left, panelPosition.top); return; }
    if (innerWidth <= 600) { ['position', 'left', 'right', 'bottom', 'top'].forEach(k => panel.style.removeProperty(k)); return; }
    const anchor = $('banbanRoot').getBoundingClientRect();
    panel.style.position = 'fixed'; panel.style.right = 'auto';
    panel.style.left = Math.max(16, Math.min(document.documentElement.clientWidth - panel.offsetWidth - 16, anchor.right - panel.offsetWidth)) + 'px';
    panel.style.bottom = Math.max(16, Math.min(innerHeight - panel.offsetHeight - 16, innerHeight - anchor.bottom)) + 'px';
  }
  function wave() {
    character?.greet();
  }
  function hideReminder() { if ($('bbNudge')) $('bbNudge').hidden = true; clearTimeout(reminderTimer); }
  function positionLauncher() {
    const root = $('banbanRoot'), launcher = $('bbLauncher');
    if (launcher.hidden || !root.style.left) return;
    root.style.left = Math.max(8, Math.min(document.documentElement.clientWidth - launcher.offsetWidth - 8, parseFloat(root.style.left))) + 'px';
    root.style.top = Math.max(8, Math.min(innerHeight - launcher.offsetHeight - 8, parseFloat(root.style.top))) + 'px';
  }
  function positionReminder() {
    const bubble = $('bbNudge'); if (!bubble || bubble.hidden) return;
    const rect = $('bbLauncher').getBoundingClientRect();
    const width = document.documentElement.clientWidth, margin = 12, gap = 16;
    const anchor = rect.left + rect.width / 2;
    const left = Math.max(margin, Math.min(width - bubble.offsetWidth - margin, anchor - bubble.offsetWidth + 40));
    const above = rect.top - bubble.offsetHeight - gap;
    const below = rect.bottom + gap;
    const useAbove = above >= margin || (below + bubble.offsetHeight > innerHeight - margin && rect.top > innerHeight - rect.bottom);
    bubble.style.left = left + 'px';
    bubble.style.top = Math.max(margin, Math.min(innerHeight - bubble.offsetHeight - margin, useAbove ? above : below)) + 'px';
    bubble.style.setProperty('--bb-tail-x', Math.max(24, Math.min(bubble.offsetWidth - 24, anchor - left)) + 'px');
    bubble.dataset.placement = useAbove ? 'above' : 'below';
  }
  function reminderKey(suffix) { return `iceclass-banban-${window.ICeClass.state.user.id}-${suffix}`; }
  function reminders() {
    clearTimeout(reminder);
    if (disposed || reminderShown) return;
    reminder = setTimeout(() => {
      if (disposed || reminderShown) return;
      const page = document.querySelector('#mainNav button.active')?.dataset.view;
      const notes = {reading: '这页的晨读，要一起看看吗？', history: '通知的显示回执，要一起核对吗？', console: '发出的通知，要一起看看回执吗？', 'classroom-voice': '来音的数量和时长，我陪您整理。'};
      // Wait until the teacher is idle. No network requests or automatic questions.
      if (document.hidden || !$('bbPanel').hidden || pending || Date.now() - lastActivity < 8000 || document.activeElement?.matches('input, textarea, select, [contenteditable=true]') || !notes[page]) { reminders(); return; }
      let seen = false;
      try { seen = localStorage.getItem(reminderKey('reminded')) === localDay(); } catch {}
      reminderShown = true;
      if (seen) return;
      $('bbNudgeText').textContent = notes[page]; $('bbNudge').hidden = false; positionReminder();
      try { localStorage.setItem(reminderKey('reminded'), localDay()); } catch {}
      reminderTimer = setTimeout(hideReminder, 18000);
    }, 30000);
  }
  function activity() { lastActivity = Date.now(); }
  function open() {
    hideReminder();
    renderPrompts();
    $('bbPanel').hidden = false; $('bbLauncher').hidden = true; $('bbLauncher').setAttribute('aria-expanded', 'true');
    if (!history.length && !$('bbMessages').children.length) fromPage();
    wave(); positionPanel(); composeState(); if (history.length) scrollBottom(); loadContext();
    // Keep the welcome content visible on touch devices without opening the soft keyboard.
    if (matchMedia('(pointer: fine)').matches) $('bbInput').focus({preventScroll: true});
  }
  function close() {
    options(false);
    setScopeEditor(false, false);
    $('bbPanel').hidden = true; $('bbLauncher').hidden = false; $('bbLauncher').setAttribute('aria-expanded', 'false');
    positionLauncher(); $('bbLauncher').focus({preventScroll: true});
  }
  function options(show, focus = false) {
    if (show) { setScopeEditor(false, false); showHistory(false, false); }
    $('bbOptions').hidden = !show;
    $('bbMore').setAttribute('aria-expanded', String(show));
    if (show && focus) $('bbOptions').querySelector('button:not([hidden]):not(:disabled)')?.focus();
  }
  function dismissOptions(e) {
    if (!e.target.closest('#bbOptions, #bbMore')) options(false);
    if (!e.target.closest('#bbScopeEditor, #bbScopeToggle') && !$('bbScopeEditor').hidden) setScopeEditor(false, false);
  }
  function headerMascot() {
    $('bbHeaderMascot').hidden = !$('bbWelcome').hidden && !$('bbConversation').hidden;
  }
  function appendMessage(role, text, mode, detailRequested = false) {
    const block = node('article', undefined, 'bb-message bb-message-' + role);
    const avatar = node('span', undefined, 'bb-message-avatar bb-message-avatar-' + role);
    if (role === 'assistant') {
      const image = document.createElement('img');
      image.src = asset('portrait'); image.alt = ''; image.draggable = false;
      avatar.append(image); avatar.setAttribute('aria-hidden', 'true');
    } else {
      const user = window.ICeClass.state.user;
      avatar.textContent = $('userAvatar')?.textContent.trim() || '我';
      avatar.title = user.displayName || user.username;
      avatar.setAttribute('role', 'img');
      avatar.setAttribute('aria-label', `${avatar.title}的头像`);
    }
    block.append(avatar);
    if (role === 'assistant') {
      const author = node('div', undefined, 'bb-message-author');
      author.append(node('strong', '班班'));
      if (mode === 'overview') author.append(node('span', '数据速览', 'bb-answer-mode'));
      block.append(author);
    }
    const content = node('div', undefined, 'bb-message-content');
    // Render only text and emphasis. Model/user HTML and links never become executable markup.
    if (role === 'assistant') renderAnswer(content, text, detailRequested); else renderText(content, text);
    block.append(content); $('bbMessages').append(block); return block;
  }
  function renderText(content, text) {
    content.replaceChildren();
    String(text).split(/(\*\*[^*]+\*\*)/g).forEach(part => content.append(part.startsWith('**') && part.endsWith('**') ? node('strong', part.slice(2, -2)) : document.createTextNode(part)));
  }
  function renderAnswer(content, text, detailRequested = false) {
    text = String(text).split('\n当时的数据来源（追问时须重新查询）：', 1)[0];
    const wasOpen = content.querySelector('.bb-answer-extra')?.open;
    const ends = [...text.matchAll(/[。！？\n]/g)].map(m => m.index + 1);
    const cut = ends.find(i => i >= 90) || ends[0];
    const present = value => {
      content.replaceChildren();
      const end = value.search(/[。！？]/);
      const balanced = ((value.slice(0, end + 1).match(/\*\*/g) || []).length % 2) === 0;
      if (!detailRequested && end >= 12 && end < 80 && balanced) {
        const lead = node('div', undefined, 'bb-answer-lead'); renderText(lead, value.slice(0, end + 1)); content.append(lead);
        const remaining = value.slice(end + 1).trim();
        if (remaining) { const body = node('div', undefined, 'bb-answer-body'); renderText(body, remaining); content.append(body); }
      } else renderText(content, value);
    };
    if (detailRequested || text.length <= 220 || !cut || cut >= text.length) { present(text); return; }
    present(text.slice(0, cut).trimEnd());
    const more = node('details', undefined, 'bb-answer-extra'), summary = node('summary', '展开补充');
    const rest = node('div'); renderText(rest, text.slice(cut).trim());
    more.append(summary, rest); more.open = Boolean(wasOpen);
    more.addEventListener('toggle', () => { summary.textContent = more.open ? '收起补充' : '展开补充'; });
    content.append(more);
  }
  function metricText(metric, value = metric.value) {
    if (metric.unit === 'seconds') return duration(Math.abs(value));
    const units = {classes: '个班', times: '次', items: '条', devices: '台', accounts: '个'};
    return `${Math.abs(value)} ${units[metric.unit] || ''}`;
  }
  function sourceCard(block, data) {
    if (!data?.scope || !Array.isArray(data.metrics)) return;
    const key = [data.topic, data.scope.start, data.scope.end, data.scope.classId, String(data.scope.grades)].join('|');
    let group = block.querySelector('.bb-results');
    if (!group) { group = node('details', undefined, 'bb-results'); group.append(node('summary', '查看依据', 'bb-evidence-toggle')); block.append(group); }
    const existing = [...group.children].find(c => c.dataset.sourceKey === key);
    const card = node('section', undefined, 'bb-result'); card.dataset.sourceKey = key;
    card.setAttribute('aria-label', data.title + '数据来源');
    const head = node('div', undefined, 'bb-result-head');
    const tag = data.previousScope ? '时段对比' : data.temporal === 'current' ? '当前状态' : data.temporal === 'mixed' ? '时段与当前状态' : '已核对记录';
    head.append(node('strong', data.title), node('span', tag, 'bb-result-tag')); card.append(head);
    const className = classesForAnalysis().find(c => c.id === data.scope.classId)?.name;
    const rangeName = className || data.scope.grades?.join('、') || '全部授权班级';
    const dateLabel = data.scope.start === data.scope.end ? data.scope.start : `${data.scope.start} — ${data.scope.end}`;
    card.append(node('p', data.scopeLabel || (data.temporal === 'current' ? rangeName + ' · 当前' : `${dateLabel} · ${rangeName}`), 'bb-result-range'));
    const figures = node('div', undefined, 'bb-result-metrics');
    data.metrics.forEach(metric => {
      const item = node('div'); item.append(node('span', metric.label), node('strong', metricText(metric)));
      if (typeof metric.delta === 'number') item.append(node('small', metric.delta === 0 ? '记录与对照期持平' : `比对照期${metric.delta > 0 ? '多' : '少'} ${metricText(metric, metric.delta)}`, 'bb-metric-change'));
      figures.append(item);
    }); if (data.metrics.length) card.append(figures);
    if (data.previousScope) card.append(node('p', `对照期 ${data.previousScope.start} — ${data.previousScope.end}`, 'bb-result-range'));
    if (data.rows?.length) {
      const rows = node('div', undefined, 'bb-result-classes'), maximum = Math.max(1, ...data.rows.map(r => r.value));
      data.rows.forEach(row => {
        const canOpen = canOpenScope({...data.scope, classId: row.classId});
        const item = canOpen ? button('', 'bb-result-class', () => { navigate('reading', {...data.scope, classId: row.classId}); window.ICeClassCalendar?.showClass(row.classId, data.scope.end); }) : node('div', undefined, 'bb-result-class bb-result-static');
        if (canOpen) item.setAttribute('aria-label', `查看${row.label}的早读日历`);
        const line = node('span', undefined, 'bb-class-line'); line.append(node('span', row.label), node('strong', duration(row.value)));
        const track = node('span', undefined, 'bb-class-track'), fill = node('span'); fill.style.width = `${Math.max(2, row.value / maximum * 100)}%`; track.append(fill);
        item.append(line, track); rows.append(item);
      }); card.append(rows);
    }
    const names = {reading: '查看晨读', history: '查看回执', console: '班级通知', 'classroom-voice': '查看来音', controls: '查看设备', classes: '班级管理', teachers: '用户管理', quiet: '禁言时间', settings: '账号设置'};
    const allowed = view => Boolean(names[view]) && canOpenView(view) && (['quiet', 'settings'].includes(view) || canOpenScope(data.scope));
    const findings = Array.isArray(data.findings) ? data.findings : [];
    function findingItem(item) {
      const line = allowed(item.view) ? button('', 'bb-finding', () => navigate(item.view, data.scope)) : node('div', undefined, 'bb-finding');
      const copy = node('span'); copy.append(node('strong', item.title), node('span', item.text)); line.append(copy);
      if (typeof item.count === 'number') line.append(node('span', String(item.count), 'bb-finding-count'));
      return line;
    }
    if (findings.length) {
      const list = node('div', undefined, 'bb-findings'); findings.slice(0, 3).forEach(item => list.append(findingItem(item))); card.append(list);
    }
    if (findings.length > 3 || data.details?.length) {
      const more = node('details', undefined, 'bb-result-details');
      more.append(node('summary', data.topic === 'help' ? '更多操作指南' : '查看检查与说明'));
      findings.slice(3).forEach(item => more.append(findingItem(item)));
      (data.details || []).forEach(text => more.append(node('p', text)));
      if (data.findingsOmitted) more.append(node('p', `另有 ${data.findingsOmitted} 项，可在对应页面查看。`));
      card.append(more);
    }
    if (data.note) card.append(node('p', data.note, 'bb-result-note'));
    const bottom = node('div', undefined, 'bb-result-footer');
    const actions = node('div', undefined, 'bb-result-actions');
    (data.actions || (data.view ? [{view: data.view}] : [])).forEach(item => { if (allowed(item.view)) actions.append(button(names[item.view], 'bb-source', () => navigate(item.view, data.scope, item.anchor))); });
    bottom.append(actions);
    const time = new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit'}).format(new Date(data.generatedAt));
    bottom.append(node('small', `${time} 核对`, 'bb-answer-time')); card.append(bottom);
    if (existing) existing.replaceWith(card); else group.append(card);
    const count = group.querySelectorAll(':scope > .bb-result').length;
    const chevron = node('img', undefined, 'bb-icon'); chevron.src = icon('chevron-down'); chevron.alt = '';
    group.querySelector(':scope > summary').replaceChildren(chevron, node('strong', '查看依据'), node('span', `${count} 项记录`));
  }
  function followups(cards = []) {
    const row = $('bbFollowups'); row.replaceChildren(); row.hidden = !cards.length;
    const topic = cards.at(-1)?.topic;
    const admin = ['superadmin', 'principal'].includes(window.ICeClass.state.user.role);
    const choices = topic === 'platform' ? [['看看晨读同步', '核对刚才范围各班的晨读同步情况。'], [admin ? '检查设备与绑定' : '通知回执呢？', admin ? '核对当前设备连接、版本和班级绑定，有哪些需要人工检查？' : '核对刚才范围的通知回执。']]
      : topic === 'devices' || topic === 'bindings' ? [[admin ? '绑定核查' : '操作指南', admin ? '检查当前范围的班级绑定，哪些班级无设备或有多台设备，需要怎样核实？' : '教室客户端怎样绑定和更新？'], ['统计规则', '解释当前统计规则与通知禁言规则。']]
      : topic === 'rules' || topic === 'accounts' || topic === 'help' ? [['平台检查', '综合检查当前范围的晨读、通知、来音与设备状态。']]
      : topic === 'sync' ? [['查看晨读', '分析刚才范围的晨读，注意同步数据完整性。']]
      : topic === 'reading' ? [['上周同期呢？', '和刚才范围的上周同期晨读数据比较一下。'], ['同步情况呢？', '刚才这些班级的同步情况如何，哪些结论需要谨慎？']]
      : topic === 'notifications' ? [['关注哪些回执？', '刚才的通知中，哪些回执状态值得继续核对？'], ['与上期比较', '比较刚才范围与前一个同样长时段的通知回执统计。']]
      : topic === 'voice' ? [['与上期比较', '比较刚才范围与前一个同样长时段的来音数量和时长。']] : [];
    choices.forEach(([label, question]) => row.append(button(label, 'bb-followup', () => ask(question))));
  }
  function renderSaved(messages) {
    const fragment = document.createDocumentFragment();
    messages.forEach(m => {
      const block = appendMessage(m.role, m.content, m.mode, m.detailRequested);
      (m.cards || []).forEach(c => sourceCard(block, c)); fragment.append(block);
    });
    return fragment;
  }
  function applyConversation(saved) {
    conversationLoaded = true; conversationId = saved.id;
    history = saved.messages.map(m => ({role: m.role, content: m.content})); lastIncomplete = null;
    $('bbMessages').replaceChildren(renderSaved(saved.messages));
    $('bbWelcome').hidden = Boolean(history.length);
    olderCursor = saved.hasMore ? saved.beforeId : null;
    olderLoading = false;
    $('bbOlder').hidden = !olderCursor; $('bbOlder').disabled = false;
    $('bbRestore').hidden = true; $('bbPresence').hidden = true; $('bbLiveStatus').hidden = true;
    if (saved.scope?.start) {
      scope = saved.scope; grades.clear(); (scope.grades || '').split(',').filter(Boolean).forEach(g => grades.add(g)); syncScope();
    } else fromPage();
    $('bbInput').value = drafts.get(conversationId || 'new') || '';
    $('bbTitle').title = saved.title || '班班';
    followups(saved.messages.at(-1)?.cards); headerMascot(); composeState(); scrollBottom();
    paintHistoryPolicy(saved.policy); renderThreads();
    $('bbHeaderStatus').textContent = history.length ? '上次聊到的还在，我们接着看' : '新对话';
  }
  async function restoreConversation() {
    const generation = accountGeneration;
    try {
      const saved = await api('/api/banban/conversation');
      if (!disposed && generation === accountGeneration) applyConversation(saved);
    } catch (error) {
      if (disposed || generation !== accountGeneration) return;
      conversationLoaded = false; composeState(); $('bbRestore').hidden = false;
      $('bbHeaderStatus').textContent = '历史对话暂未读取，请重新读取后继续';
    }
  }
  function historyDate(timestamp, full = false) {
    return new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai', month:'numeric', day:'numeric',
      ...(full ? {hour:'2-digit', minute:'2-digit', hour12:false} : {})}).format(new Date(timestamp));
  }
  function paintHistoryPolicy(policy) {
    if (!policy) return;
    historyPolicy = policy;
    $('bbHistoryPolicy').textContent = policy.cycle === 'weekly' ? '每周一清理' : '每月1日清理';
    $('bbHistoryNext').replaceChildren(node('span', `下次 ${historyDate(policy.nextCleanupAt, true)}`), node('span', '北京时间'));
    $('bbHistoryPolicyPlan').textContent = `下次清理：${historyDate(policy.nextCleanupAt, true)}（北京时间）`;
    if ($('bbHistoryPolicyEditor').hidden) $('bbHistoryCycle').value = policy.cycle;
    historyPolicyControls();
  }
  function historyPolicyControls() {
    $('bbHistoryAdmin').disabled = historyPolicyBusy || !historyPolicy;
    $('bbHistoryPolicyBack').disabled = historyPolicyBusy;
    $('bbHistoryCycle').disabled = historyPolicyBusy;
    $('bbHistoryPolicySave').disabled = historyPolicyBusy || !historyPolicy || $('bbHistoryCycle').value === historyPolicy.cycle;
    $('bbHistoryPolicySave').textContent = historyPolicyBusy ? '正在保存…' : '保存设置';
  }
  function showHistoryPolicy(show, focus = true) {
    $('bbHistoryOverview').hidden = show; $('bbHistoryPolicyEditor').hidden = !show;
    if (show) {
      $('bbHistoryCycle').value = historyPolicy?.cycle || 'monthly';
      $('bbHistoryPolicyStatus').textContent = '';
      historyPolicyControls();
      if (focus) $('bbHistoryPolicyBack').focus({preventScroll:true});
    } else if (focus) $('bbHistoryAdmin').focus({preventScroll:true});
  }
  function renderThreads() {
    const list = $('bbHistoryList'); list.replaceChildren();
    let lastGroup = '';
    threads.forEach(thread => {
      const day = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date(thread.updatedAt));
      const group = day === localDay() ? '今天' : historyDate(thread.updatedAt);
      if (group !== lastGroup) { list.append(node('h3', group, 'bb-history-day')); lastGroup = group; }
      const item = button('', 'bb-thread', () => switchConversation(thread.id));
      item.title = thread.title; item.dataset.conversationId = thread.id;
      if (thread.id === conversationId) item.setAttribute('aria-current', 'true');
      item.disabled = Boolean(pending) || changingConversation;
      const heading = node('span', undefined, 'bb-thread-heading');
      heading.append(node('strong', thread.title));
      const time = new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai', hour:'2-digit', minute:'2-digit', hour12:false}).format(new Date(thread.updatedAt));
      const meta = node('span', undefined, 'bb-thread-meta');
      meta.append(node('small', `${time} · ${Math.floor(thread.messageCount / 2)}轮`));
      if (thread.id === conversationId) meta.append(node('span', '当前', 'bb-thread-current'));
      item.append(heading, meta);
      const row = node('div', undefined, 'bb-thread-row');
      const remove = button('', 'bb-tool bb-icon-button bb-thread-delete', () => showHistoryDelete(thread));
      remove.dataset.deleteId = thread.id;
      remove.setAttribute('aria-controls', 'bbHistoryDeleteEditor');
      remove.setAttribute('aria-label', `删除对话：${thread.title}`); remove.title = '删除这段对话';
      remove.disabled = item.disabled;
      const trash = document.createElement('img'); trash.className = 'bb-icon'; trash.src = icon('trash-2'); trash.alt = '';
      remove.append(trash); row.append(item, remove); list.append(row);
    });
    $('bbHistoryEmpty').hidden = threadLoading || Boolean(threads.length);
    $('bbHistoryMore').hidden = !threadCursor;
    $('bbHistoryMore').disabled = threadLoading;
    $('bbHistoryNew').disabled = changingConversation || Boolean(pending) || !conversationLoaded;
    $('bbNew').disabled = changingConversation || Boolean(pending) || !conversationLoaded;
  }
  async function loadThreads(more = false) {
    if (threadLoading || disposed) return;
    const rev = ++threadRevision;
    threadLoading = true; $('bbHistoryStatus').textContent = '正在加载对话…'; $('bbHistoryRetry').hidden = true;
    $('bbHistoryList').setAttribute('aria-busy', 'true'); renderThreads();
    const params = more && threadCursor ? '?' + new URLSearchParams({beforeUpdated:threadCursor.updatedAt, beforeId:threadCursor.id}) : '';
    try {
      const data = await api('/api/banban/conversations' + params);
      if (disposed || rev !== threadRevision) return;
      const unique = new Map((more ? threads : []).map(t => [t.id, t]));
      data.conversations.forEach(t => unique.set(t.id, t)); threads = [...unique.values()]; threadCursor = data.nextCursor;
      paintHistoryPolicy(data.policy); $('bbHistoryStatus').textContent = '';
    } catch (error) {
      if (!disposed && rev === threadRevision) { $('bbHistoryStatus').textContent = '暂时无法加载对话，请重试。'; $('bbHistoryRetry').hidden = false; }
    } finally {
      if (rev === threadRevision) {
        threadLoading = false;
        if (!disposed) { $('bbHistoryList').setAttribute('aria-busy', 'false'); renderThreads(); }
      }
    }
  }
  function closeHistoryDelete(focus = false) {
    const id = deletingThread?.id;
    deletingThread = null; $('bbHistoryDeleteEditor').hidden = true; $('bbHistoryOverview').hidden = false;
    if (focus) ($('bbHistoryList').querySelector(`[data-delete-id="${CSS.escape(id || '')}"]`) || $('bbHistoryClose')).focus({preventScroll:true});
  }
  function showHistoryDelete(thread) {
    if (pending || changingConversation || deleteBusy) return;
    deletingThread = thread; showHistoryPolicy(false, false);
    $('bbHistoryOverview').hidden = true; $('bbHistoryDeleteEditor').hidden = false;
    $('bbHistoryDeleteTitle').textContent = thread.title; $('bbHistoryDeleteStatus').textContent = '';
    $('bbHistoryDeleteCancel').focus({preventScroll:true});
  }
  async function deleteConversation(e) {
    e.preventDefault();
    if (!deletingThread || deleteBusy || pending || changingConversation) return;
    const target = deletingThread, generation = accountGeneration;
    deleteBusy = true; changingConversation = true; composeState(); renderThreads();
    $('bbHistoryDeleteCancel').disabled = true; $('bbHistoryDeleteConfirm').disabled = true;
    $('bbHistoryDeleteConfirm').textContent = '删除中…'; $('bbHistoryDeleteStatus').textContent = '';
    // A list request started before deletion must not restore its stale row.
    threadRevision++; threadLoading = false;
    if (conversationId === target.id) revision++;
    try {
      const result = await api(`/api/banban/conversations/${encodeURIComponent(target.id)}`, {method:'DELETE'});
      if (disposed || generation !== accountGeneration) return;
      drafts.delete(target.id); threads = threads.filter(t => t.id !== target.id);
      if (conversationId === target.id) {
        character.reset(); applyConversation(result.conversation); loadContext();
      }
      closeHistoryDelete(); $('bbHistoryClose').focus({preventScroll:true});
      window.ICeClass.toast('对话已永久删除');
      await loadThreads();
    } catch (error) {
      if (!disposed && generation === accountGeneration) {
        $('bbHistoryDeleteStatus').textContent = error.message;
        window.ICeClass.toast('对话未删除：' + error.message);
      }
    } finally {
      if (!disposed && generation === accountGeneration) {
        deleteBusy = false; changingConversation = false;
        $('bbHistoryDeleteCancel').disabled = false; $('bbHistoryDeleteConfirm').disabled = false;
        $('bbHistoryDeleteConfirm').textContent = '永久删除'; composeState(); renderThreads();
      }
    }
  }
  function showHistory(show, focus = true) {
    closeHistoryDelete();
    showHistoryPolicy(false, false);
    $('bbHistory').hidden = !show; $('bbHistoryScrim').hidden = !show;
    $('bbPanel').classList.toggle('bb-history-open', show);
    $('bbHistoryToggle').setAttribute('aria-expanded', String(show));
    syncHistoryInert();
    if (show) {
      setScopeEditor(false, false); $('bbOptions').hidden = true; $('bbMore').setAttribute('aria-expanded', 'false');
      if (focus) $('bbHistoryClose').focus({preventScroll:true});
      loadThreads();
    } else if (focus) $('bbHistoryToggle').focus({preventScroll:true});
  }
  function syncHistoryInert() {
    const sideBySide = $('bbPanel').classList.contains('bb-expanded') && innerWidth > 900;
    $('bbChatPane').inert = !$('bbHistory').hidden && !sideBySide;
  }
  async function switchConversation(id = null) {
    if (changingConversation || pending || !conversationLoaded) return;
    const generation = accountGeneration;
    const keepSidebar = !$('bbHistory').hidden && $('bbPanel').classList.contains('bb-expanded') && innerWidth > 900;
    if (id && id === conversationId) { showHistory(keepSidebar, false); $('bbInput').focus({preventScroll:true}); return; }
    drafts.set(conversationId || 'new', $('bbInput').value);
    changingConversation = true; composeState(); renderThreads();
    $('bbHistoryStatus').textContent = id ? '正在打开对话…' : '正在新建对话…';
    try {
      const saved = await api(id ? `/api/banban/conversations/${encodeURIComponent(id)}/open` : '/api/banban/conversations', {method:'POST'});
      if (disposed || generation !== accountGeneration) return;
      if (!id) drafts.delete(saved.id);
      revision++; character.reset(); applyConversation(saved); showHistory(keepSidebar, false); options(false);
      if (!$('bbSettings').hidden) closeSettings();
      if (!id) { $('bbWelcomeLine').textContent = '换个角度，一起看看。'; wave(); }
      $('bbInput').focus({preventScroll:true}); loadContext();
    } catch (error) {
      if (!disposed && generation === accountGeneration) { $('bbHistoryStatus').textContent = error.message; window.ICeClass.toast('对话未切换：' + error.message); }
    } finally {
      if (generation === accountGeneration) {
        changingConversation = false;
        if (!disposed) { composeState(); renderThreads(); }
      }
    }
  }
  async function loadOlder() {
    if (!olderCursor || olderLoading || changingConversation || pending) return;
    olderLoading = true; $('bbOlder').disabled = true; $('bbOlder').textContent = '正在读取…';
    const id = conversationId, scroller = $('bbScroll'), rev = revision;
    try {
      const saved = await api('/api/banban/conversation?' + new URLSearchParams({conversationId:id, before:olderCursor}));
      if (disposed || id !== conversationId || rev !== revision) return;
      const height = scroller.scrollHeight, top = scroller.scrollTop;
      $('bbMessages').prepend(renderSaved(saved.messages));
      history.unshift(...saved.messages.map(m => ({role:m.role,content:m.content})));
      olderCursor = saved.hasMore ? saved.beforeId : null; $('bbOlder').hidden = !olderCursor;
      scroller.scrollTop = top + scroller.scrollHeight - height;
    } catch (error) { if (!disposed) window.ICeClass.toast('历史消息未读取：' + error.message); }
    finally { if (rev === revision) { olderLoading = false; if (!disposed) { $('bbOlder').disabled = false; $('bbOlder').textContent = '查看更早的消息'; } } }
  }
  async function streamQuestion(text, signal, receive) {
    const page = document.querySelector('#mainNav button.active')?.dataset.view || 'reading';
    const response = await fetch('/api/banban/chat/stream', {method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: {'Content-Type': 'application/json', 'X-CSRF-Token': window.ICeClass.state.csrf}, body: JSON.stringify({message: text, scope: {...scope}, page, conversationId}), signal});
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || `请求失败 (${response.status})`); }
    if (!response.body || !response.headers.get('Content-Type')?.includes('application/x-ndjson')) throw new Error('连接未返回完整回复，请刷新后重试。');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', finished = false, received = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) { buffer += decoder.decode(); break; }
        received += value.byteLength;
        if (received > 2000000) throw new Error('回复过长，请缩小范围后重试。');
        buffer += decoder.decode(value, {stream: true});
        let position;
        while ((position = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, position); buffer = buffer.slice(position + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === 'error') throw new Error(event.error);
          if (event.type === 'done') finished = true;
          receive(event);
        }
      }
      if (!finished || buffer.trim()) throw new Error('回复中途断开，已收到的内容保留，可以重试。');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  function navigate(view, target = {}, anchor) {
    if (!['reading', 'history', 'console', 'classroom-voice', 'controls', 'classes', 'teachers', 'quiet', 'settings'].includes(view)) return;
    if (!canOpenView(view)) return;
    const nav = document.querySelector(`#mainNav button[data-view="${view}"]`);
    if (!nav || nav.disabled) return;
    nav.click();
    if (view === 'reading') {
      $('readingStart').value = target.start; $('readingEnd').value = target.end;
      const expected = new Set(target.grades || []);
      // Use the existing grade controls, including their class-option synchronization.
      document.querySelector('[data-reading-grade="all"]')?.click();
      expected.forEach(g => document.querySelector(`[data-reading-grade="${g}"]`)?.click());
      $('readingClass').value = target.classId || ''; $('readingRefresh').click();
      if (anchor === 'rules' && ['superadmin', 'principal'].includes(window.ICeClass.state.user.role)) {
        const rules = $('readingSettingsForm')?.closest('details');
        if (rules) { rules.open = true; rules.scrollIntoView({block: 'start'}); }
      }
    } else if (view === 'history') {
      $('historyClass').value = target.classId || ''; $('historyClass').dispatchEvent(new Event('change'));
    } else if (view === 'classroom-voice') {
      const field = $('classroomVoiceClass'); if (field) { field.value = target.classId || ''; field.dispatchEvent(new Event('change')); }
    } else if (view === 'console' && target.classId) {
      const field = $('targetClass');
      if (field && [...field.options].some(option => option.value === target.classId)) { field.value = target.classId; field.dispatchEvent(new Event('change')); }
    }
    if (innerWidth < 900) close();
  }
  function renderPrompts() {
    const view = document.querySelector('#mainNav button.active')?.dataset.view || 'reading';
    const pageNames = {reading: '晨读统计', history: '通知记录', console: '班级通知', 'classroom-voice': '教室来音', controls: '教室控制', classes: '班级管理', teachers: '用户管理', quiet: '禁言时间', settings: '账号设置'};
    const prompts = [['看看需要关注什么', '晨读 · 通知 · 教室状态', '综合检查当前范围的晨读、通知、来音与设备状态，有哪些需要我关注？'],
      ['分析晨读表现', '班级表现与数据同步', '分析当前范围的晨读表现和同步完整性。'],
      ['这页怎么用', pageNames[view] || '操作指南', `介绍${pageNames[view] || '当前页面'}的现有功能和操作方法，给我对应入口。`]];
    $('bbPrompts').replaceChildren();
    prompts.forEach(([title, note, question]) => {
      const b = button('', 'bb-prompt', () => ask(question)), copy = node('span', undefined, 'bb-prompt-copy');
      const arrow = node('img', undefined, 'bb-icon'); arrow.src = icon('arrow-right'); arrow.alt = '';
      copy.append(node('strong', title), node('small', note)); b.append(copy, arrow); $('bbPrompts').append(b);
    });
  }
  function scrollBottom() { const el = $('bbScroll'); el.scrollTop = el.scrollHeight; }
  function busy(value) {
    character?.busy(value);
    headerMascot();
    $('bbSendLabel').textContent = value ? '停止' : '发送';
    $('bbSendIcon').src = icon(value ? 'minus' : 'arrow-up');
    $('bbSend').setAttribute('aria-label', value ? '停止回答' : '发送问题');
    composeState();
    $('bbMessages').setAttribute('aria-busy', String(value));
    $('bbScopeToggle').disabled = value; $('bbSettingsOpen').disabled = value;
    $('bbOlder').disabled = value; renderThreads();
  }
  async function ask(text, reuse = false) {
    await conversationReady;
    text = text.trim(); if (disposed || !conversationLoaded || changingConversation || !text || text.length > 2000 || pending) return;
    options(false); showHistory(false, false);
    const rev = ++revision; lastQuestion = text;
    $('bbWelcome').hidden = true;
    setScopeEditor(false, false);
    if (!reuse) appendMessage('user', text);
    if (reuse && lastIncomplete) { lastIncomplete.remove(); lastIncomplete = null; }
    $('bbFollowups').hidden = true;
    $('bbInput').value = ''; composeState();
    $('bbMessages').querySelectorAll('.bb-error').forEach(n => n.remove());
    const waiting = $('bbPresence'); waiting.hidden = false;
    $('bbPresenceTitle').textContent = '我在看。';
    $('bbPresenceNote').textContent = '正在连接班班';
    $('bbHeaderStatus').textContent = '正在连接';
    const controller = new AbortController(); pending = controller; busy(true); scrollBottom();
    let reply = null, answer = '', replyMode = 'deepseek', replyDetail = false, completed = false, cards = [];
    const scroller = $('bbScroll'); let followAnswer = true;
    const readingAbove = e => { if (e.type !== 'wheel' || e.deltaY < 0) followAnswer = false; else if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60) followAnswer = true; };
    const resumeAtEnd = () => { if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 20) followAnswer = true; };
    scroller.addEventListener('wheel', readingAbove, {passive: true});
    scroller.addEventListener('pointerdown', readingAbove, {passive: true});
    scroller.addEventListener('scroll', resumeAtEnd, {passive: true});
    const ensureReply = () => reply ||= appendMessage('assistant', '', replyMode);
    const slowTimer = setTimeout(() => {
      if (revision !== rev || pending !== controller) return;
      if (!answer) { $('bbPresenceTitle').textContent = '还在处理这次问题。'; $('bbPresenceNote').textContent = '可以继续等，也可以停止。'; }
    }, 8100);
    const timer = setTimeout(() => controller.abort('timeout'), 100000);
    try {
      await streamQuestion(text, controller.signal, event => {
        if (revision !== rev) return;
        if (event.type === 'meta') {
          conversationId = event.conversationId || conversationId;
          replyMode = event.mode;
          replyDetail = Boolean(event.detailRequested);
          if (replyMode !== 'local') {
            $('bbModeNote').textContent = replyMode === 'deepseek' ? '智能分析' : '数据速览';
            $('bbModeNote').dataset.state = replyMode === 'deepseek' ? 'ready' : 'overview';
          }
        } else if (event.type === 'status') {
          $('bbPresenceNote').textContent = event.text; $('bbHeaderStatus').textContent = event.text;
          if (answer) { character?.busy(true); $('bbLiveStatus').textContent = event.text; $('bbLiveStatus').hidden = false; }
        } else if (event.type === 'delta') {
          answer += event.text; waiting.hidden = true; $('bbLiveStatus').hidden = true;
          ensureReply().classList.add('bb-streaming'); renderAnswer(reply.querySelector('.bb-message-content'), answer, replyDetail);
          character?.speak(event.text); headerMascot(); $('bbHeaderStatus').textContent = '正在回答';
        } else if (event.type === 'card') {
          cards.push(event.card); sourceCard(ensureReply(), event.card);
        } else if (event.type === 'done') {
          conversationId = event.conversationId || conversationId; drafts.delete(conversationId || 'new');
          completed = true; answer = event.message.content; replyMode = event.message.mode; cards = event.message.cards || [];
          renderAnswer(ensureReply().querySelector('.bb-message-content'), answer, event.message.detailRequested);
          const evidenceOpen = reply.querySelector('.bb-results')?.open;
          reply.querySelector('.bb-results')?.remove(); cards.forEach(c => sourceCard(reply, c));
          if (evidenceOpen && reply.querySelector('.bb-results')) reply.querySelector('.bb-results').open = true;
          reply.classList.remove('bb-streaming');
          history.push({role: 'user', content: text}, {role: 'assistant', content: answer});
          if (event.scope?.start) { scope = event.scope; grades.clear(); (scope.grades || '').split(',').filter(Boolean).forEach(g => grades.add(g)); syncScope(); }
          $('bbHeaderStatus').textContent = '我在，接着聊'; followups(cards);
          character?.reply(cards.some(c => c.attention || c.note?.includes('待确认同步')) ? 'careful' : 'neutral');
        }
        if (followAnswer) scrollBottom();
      });
    } catch (e) {
      if (revision !== rev) return;
      waiting.hidden = true;
      $('bbHeaderStatus').textContent = controller.signal.aborted && controller.signal.reason !== 'timeout' ? '问题还在，随时可以继续' : '这次没连上，陪您再试一次';
      if (!controller.signal.aborted || controller.signal.reason === 'timeout') character?.fail();
      else character?.reset();
      if (reply && !completed) { lastIncomplete = reply; reply.classList.remove('bb-streaming'); reply.append(node('small', '回复未完成', 'bb-incomplete')); }
      const error = node('div', controller.signal.aborted ? (controller.signal.reason === 'timeout' ? '等待时间较长，问题已保留，可以稍后重试。' : '已停止等待，问题已保留。') : e.message, 'bb-error');
      error.setAttribute('role', 'alert'); error.append(button('重试这个问题', 'bb-source', () => ask(lastQuestion, true))); $('bbMessages').append(error);
    } finally {
      clearTimeout(timer);
      clearTimeout(slowTimer);
      scroller.removeEventListener('wheel', readingAbove); scroller.removeEventListener('pointerdown', readingAbove); scroller.removeEventListener('scroll', resumeAtEnd);
      if (revision === rev) {
        waiting.hidden = true; $('bbLiveStatus').hidden = true;
        pending = null; busy(false);
        headerMascot();
        if (!completed || followAnswer) scrollBottom();
      }
    }
  }
  function dragLauncher() {
    const launcher = $('bbLauncher'), root = $('banbanRoot'); let start = null;
    launcher.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const rect = root.getBoundingClientRect(); start = {x: e.clientX, y: e.clientY, left: rect.left, top: rect.top}; moved = false; launcher.setPointerCapture(e.pointerId);
    });
    launcher.addEventListener('pointermove', e => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > 7) moved = true;
      if (!moved) return;
      hideReminder();
      character?.drag(dx);
      root.style.right = 'auto'; root.style.bottom = 'auto';
      root.style.left = Math.max(4, Math.min(document.documentElement.clientWidth - launcher.offsetWidth - 4, start.left + dx)) + 'px';
      root.style.top = Math.max(4, Math.min(innerHeight - launcher.offsetHeight - 4, start.top + dy)) + 'px';
    });
    const stop = e => {
      if (start && moved && e.type === 'pointerup') {
        const rect = launcher.getBoundingClientRect(), width = document.documentElement.clientWidth;
        root.style.left = (rect.left + rect.width / 2 < width / 2 ? 12 : Math.max(12, width - rect.width - 12)) + 'px';
      }
      start = null; character?.release();
    }; launcher.addEventListener('pointerup', stop); launcher.addEventListener('pointercancel', stop); launcher.addEventListener('lostpointercapture', stop);
    launcher.addEventListener('click', e => { if (moved) { e.preventDefault(); moved = false; return; } open(); });
    addEventListener('resize', () => {
      if (!root.isConnected) return;
      positionLauncher();
      positionPanel();
      if (!$('bbPanel').hidden && !$('bbComposer').hidden) composeState();
      positionReminder();
    });
  }
  function dragPanel() {
    const handle = $('bbDragHandle'), panel = $('bbPanel'); let start = null;
    handle.addEventListener('pointerdown', e => {
      if (!e.isPrimary || e.button !== 0 || e.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
      const rect = panel.getBoundingClientRect();
      start = {id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false};
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', e => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 6) return;
      start.moved = true; panel.classList.add('bb-dragging');
      character?.drag(dx);
      movePanel(start.left + dx, start.top + dy); e.preventDefault();
    });
    const stop = e => {
      if (!start || e.pointerId !== start.id) return;
      start = null; panel.classList.remove('bb-dragging');
      character?.release();
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => handle.addEventListener(type, stop));
  }
  function settingsStatus(message, state = 'info') {
    $('bbSettingsStatus').textContent = message;
    $('bbSettingsStatus').dataset.state = state;
  }
  function settingsBadge(text, state = 'info') {
    $('bbConnectionBadge').textContent = text;
    $('bbConnectionBadge').dataset.state = state;
  }
  function settingsBaseIdentity(value) {
    const raw = value.trim();
    try {
      const address = new URL(raw), match = raw.match(/^https:\/\/[^/?#]+(\/[^?#]*)?$/i);
      if (!match || address.protocol !== 'https:' || address.username || address.password || /[\s\\\x00-\x1f\x7f]/.test(raw)) return raw;
      let path = (match[1] || '').replace(/\/+$/, '');
      if (path.endsWith('/chat/completions')) path = path.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
      return 'https://' + address.hostname.replace(/\.+$/, '').toLowerCase() + (address.port ? ':' + address.port : '') + path;
    } catch { return raw; }
  }
  function settingsAddressChanged(saved) {
    return settingsBaseIdentity($('bbBaseUrl').value) !== settingsBaseIdentity(saved.baseUrl);
  }
  function settingsProviderForAddress(value) {
    const address = settingsBaseIdentity(value);
    return connectionProviders.find(provider => provider.addresses.test(address));
  }
  function settingsDirty() {
    if (!settingsConfig) return false;
    if (settingsTarget === 'account' && !$('bbSourcePersonal').checked) return settingsConfig.source !== 'school';
    const saved = settingsTarget === 'school' ? settingsConfig : settingsConfig.personal;
    return Boolean((settingsTarget === 'account' && settingsConfig.source !== 'personal') || $('bbKey').value.trim() ||
      $('bbEnabled').checked !== saved.enabled || $('bbModel').value.trim() !== saved.model || settingsAddressChanged(saved));
  }
  function settingsEditable() { return settingsTarget === 'school' || $('bbSourcePersonal').checked; }
  function settingsSavedConnection() {
    return settingsTarget === 'school' ? settingsConfig : settingsConfig?.source === 'personal' ? settingsConfig.personal : settingsConfig?.school;
  }
  function settingsControls() {
    const unavailable = settingsBusy || !settingsConfig, editable = settingsEditable(), saved = settingsSavedConnection();
    ['bbEnabled', 'bbKey', 'bbModel', 'bbBaseUrl', 'bbProvider'].forEach(id => { $(id).disabled = unavailable || !editable; });
    ['bbSourceSchool', 'bbSourcePersonal'].forEach(id => { $(id).disabled = unavailable; });
    $('bbSettingsSave').disabled = unavailable || !settingsDirty();
    $('bbTestConnection').disabled = unavailable || !saved?.configured || !saved.enabled || settingsDirty();
    $('bbTestConnection').title = settingsDirty() ? '请先保存修改，再测试新配置' : !saved?.configured ? '请先保存连接配置' : !saved.enabled ? '请先开启智能分析并保存' : '测试已保存的连接，不发送班级数据';
    const willTest = editable ? $('bbEnabled').checked : settingsConfig?.school?.enabled && settingsConfig.school.configured;
    $('bbSettingsSave').textContent = settingsBusy ? '请稍候…' : willTest ? '保存并测试' : editable ? '保存设置' : '保存选择';
    $('bbSettingsSave').title = !settingsDirty() ? '修改设置后可保存' : '';
    $('bbSettingsReload').disabled = settingsBusy;
    $('bbManageSchool').disabled = unavailable || settingsDirty();
    $('bbManageSchool').title = settingsDirty() ? '请先保存当前修改' : '';
    $('bbSourceChoices').hidden = settingsTarget === 'school';
    $('bbProviderFields').hidden = !editable;
    $('bbSchoolSummary').hidden = editable;
    $('bbSettings').setAttribute('aria-busy', String(settingsBusy));
  }
  function settingsModelNote() {
    const provider = connectionProviders.find(item => item.id === $('bbProvider').value);
    $('bbModelSuggestions').replaceChildren(...(provider?.models || []).map(value => { const option = document.createElement('option'); option.value = value; return option; }));
    if (provider) $('bbModel').setAttribute('list', 'bbModelSuggestions'); else $('bbModel').removeAttribute('list');
    $('bbBaseNote').textContent = provider?.addressNote || (provider ? '已填写常用地址，您可按平台的配置说明修改。' : '填写兼容 OpenAI 的 HTTPS 接口地址，不含 /chat/completions。');
    $('bbModelNote').textContent = provider?.modelNote || '可改为您已开通的模型 ID，需支持流式对话和工具调用。';
    $('bbProviderLink').hidden = !provider;
    if (provider) $('bbProviderLink').href = provider.docs;
    const saved = settingsTarget === 'school' ? settingsConfig : settingsConfig?.personal;
    const addressChanged = saved?.configured && settingsAddressChanged(saved);
    $('bbKeyState').textContent = $('bbKey').value.trim() ? '待保存' : addressChanged ? '需重新填写' : saved?.configured ? '已保存' : '未设置';
    $('bbKey').placeholder = saved?.configured && !addressChanged ? '不更换密钥时留空' : '粘贴该服务的 API Key';
    $('bbKeyNote').textContent = addressChanged ? '地址已更改，请填写该服务对应的密钥。' : saved?.configured ? '不更换密钥时，无需填写。' : '填写上方服务地址对应的 API Key。';
  }
  function settingsRestingBadge() {
    const saved = settingsSavedConnection();
    settingsBadge(saved && !saved.enabled ? '已关闭' : !saved?.configured ? '未配置' : '已配置');
  }
  function paintSettingsConfig(data) {
    settingsConfig = data;
    if (settingsTarget === 'account') { connection = data; modeNote(); }
    const own = settingsTarget === 'school' ? data : data.personal;
    $('bbEnabled').checked = own.enabled; $('bbModel').value = own.model; $('bbBaseUrl').value = own.baseUrl; $('bbKey').value = '';
    $('bbProvider').value = settingsProviderForAddress(own.baseUrl)?.id || 'custom';
    $('bbSourceSchool').checked = data.source !== 'personal'; $('bbSourcePersonal').checked = data.source === 'personal';
    ['bbKey', 'bbBaseUrl', 'bbModel'].forEach(id => $(id).removeAttribute('aria-invalid'));
    $('bbSettingsTitle').textContent = settingsTarget === 'school' ? '学校服务设置' : '连接设置';
    $('bbSettingsIntro').textContent = settingsTarget === 'school' ? '修改后将影响选择“学校提供”的账号。' : '选择班班使用的 AI 服务。';
    $('bbManageSchool').hidden = !['superadmin', 'principal'].includes(window.ICeClass.state.user.role);
    $('bbManageSchool').textContent = settingsTarget === 'school' ? '返回个人设置' : '管理学校服务';
    const school = data.school;
    $('bbSchoolTitle').textContent = !school?.configured ? '学校服务尚未配置' : !school.enabled ? '学校智能分析已关闭' : '学校服务已配置';
    $('bbSchoolNote').textContent = school?.configured && school.enabled ? '无需填写密钥，班班按您的账号权限分析。' : '当前可查看数据速览。您也可以选择“自行配置”，或联系超级管理员。';
    settingsRestingBadge();
    settingsModelNote();
  }
  function settingsChanged() {
    ['bbKey', 'bbBaseUrl', 'bbModel'].forEach(id => $(id).removeAttribute('aria-invalid')); settingsModelNote();
    if (settingsDirty()) {
      settingsBadge('待保存');
      settingsStatus('修改尚未保存。');
    } else if (settingsConfig) {
      settingsRestingBadge(); settingsStatus('');
    }
    settingsControls();
  }
  async function readSettings() {
    if (settingsBusy) return;
    const generation = accountGeneration;
    settingsConfig = null; settingsBusy = true; settingsControls();
    $('bbSettingsReload').hidden = true; settingsBadge('读取中'); settingsStatus('正在读取现有设置…');
    try {
      const data = await api(settingsTarget === 'school' ? '/api/banban/settings' : '/api/banban/connection');
      if (disposed || generation !== accountGeneration) return;
      paintSettingsConfig(data);
      settingsStatus('');
    } catch (e) {
      if (disposed || generation !== accountGeneration) return;
      settingsBadge('读取失败', 'error'); settingsStatus('未能读取设置：' + e.message, 'error'); $('bbSettingsReload').hidden = false;
    } finally { if (generation === accountGeneration) { settingsBusy = false; if (!disposed) settingsControls(); } }
  }
  async function testSettings(savedNow = false) {
    const generation = accountGeneration;
    settingsStatus(savedNow ? '设置已保存，正在测试连接…' : '正在测试已保存的连接…');
    try {
      const result = await api('/api/banban/connection/test' + (settingsTarget === 'school' ? '?target=school' : ''), {method: 'POST'});
      if (disposed || generation !== accountGeneration) return;
      settingsBadge(result.ok ? '测试通过' : '测试未通过', result.ok ? 'success' : 'error');
      settingsStatus(result.ok ? (savedNow ? '设置已保存，连接测试通过。' : '连接测试通过，可返回对话使用。') : (savedNow ? '设置已保存，但连接测试未通过，请检查配置后重试。' : '连接测试未通过，请检查配置后重试。'), result.ok ? 'success' : 'error');
    } catch (e) {
      if (disposed || generation !== accountGeneration) return;
      settingsBadge('测试未通过', 'error');
      settingsStatus((savedNow ? '设置已保存，但测试失败：' : '测试失败：') + e.message, 'error');
    }
  }
  async function openSettings() {
    options(false); showHistory(false, false);
    if (!$('bbSettings').hidden) { $('bbSettingsBack').focus({preventScroll: true}); return; }
    settingsScroll = $('bbScroll').scrollTop;
    $('bbSettings').hidden = false; $('bbConversation').hidden = true; $('bbComposer').hidden = true;
    $('bbScopeBar').hidden = true; $('bbScopeEditor').hidden = true; $('bbScopeToggle').setAttribute('aria-expanded', 'false');
    $('bbScroll').scrollTop = 0; headerMascot(); $('bbSettingsBack').focus({preventScroll: true});
    if (!settingsBusy) { settingsTarget = 'account'; await readSettings(); }
  }
  function closeSettings() {
    $('bbSettings').hidden = true; $('bbConversation').hidden = false; $('bbComposer').hidden = false;
    $('bbScopeBar').hidden = false; $('bbKey').value = ''; modeNote(); headerMascot(); $('bbMore').focus();
    $('bbScroll').scrollTop = settingsScroll;
  }
  function init() {
    if (initialized || !window.ICeClass?.state.user) return;
    initialized = true; disposed = false; accountGeneration++;
    deletingThread = null; deleteBusy = false;
    settingsTarget = 'account'; settingsConfig = null; settingsBusy = false;
    history = []; conversationId = null; threads = []; threadCursor = null; threadLoading = false;
    historyPolicy = null; historyPolicyBusy = false; olderCursor = null; olderLoading = false; conversationLoaded = false;
    changingConversation = false; pending = null; lastIncomplete = null; drafts.clear();
    analysisClasses = null; schoolAnalysis = false; panelPosition = null; settingsConfig = null; settingsBusy = false; reminderShown = false;
    const root = node('div', undefined, 'banban-root'); root.id = 'banbanRoot';
    root.innerHTML = `
      <button id="bbLauncher" class="bb-launcher" type="button" aria-label="打开班班" aria-controls="bbPanel" aria-expanded="false"><span class="bb-launcher-name">班班</span></button>
      <aside id="bbNudge" class="bb-nudge" aria-label="班班轻提醒" hidden><p id="bbNudgeText" role="status" aria-live="polite"></p><div><button id="bbNudgeOpen" class="bb-source bb-nudge-open" type="button">一起看看<img class="bb-icon" src="${icon('arrow-right')}" alt=""></button><button id="bbNudgeDismiss" class="bb-tool bb-nudge-dismiss" type="button" aria-label="收起提醒">知道了</button></div></aside>
      <section id="bbPanel" class="bb-panel" role="dialog" aria-labelledby="bbTitle" hidden>
        <header id="bbDragHandle" class="bb-header" title="按住这里拖动窗口"><span id="bbHeaderMascot" class="bb-avatar" aria-hidden="true" hidden></span><div class="bb-heading"><strong id="bbTitle">班班</strong><span id="bbModeNote" class="bb-mode-note" role="status"></span><span id="bbHeaderStatus" class="sr-only" role="status">您的校园数据助手</span></div><div class="bb-window-tools"><button id="bbHistoryToggle" class="bb-tool bb-icon-button bb-history-toggle" type="button" aria-expanded="false" aria-controls="bbHistory" aria-label="历史对话" title="历史对话">历史</button><button id="bbMore" class="bb-tool bb-icon-button" type="button" aria-expanded="false" aria-controls="bbOptions" aria-label="班班更多选项" title="更多选项"><img class="bb-icon" src="${icon('ellipsis')}" alt=""></button><button id="bbExpand" class="bb-tool bb-icon-button bb-expand" type="button" aria-pressed="false" aria-label="放大窗口" title="放大窗口"><img id="bbExpandIcon" class="bb-icon" src="${icon('maximize-2')}" alt=""></button><button id="bbClose" class="bb-tool bb-icon-button" type="button" aria-label="收起班班" title="收起班班"><img class="bb-icon" src="${icon('minus')}" alt=""></button></div></header>
        <div id="bbOptions" class="bb-options" role="group" aria-label="班班更多操作" hidden><button id="bbNew" class="bb-tool bb-new" type="button" title="开始新的对话，保留历史"><img class="bb-icon" src="${icon('plus')}" alt="">新对话</button><button id="bbSettingsOpen" class="bb-tool" type="button"><img class="bb-icon" src="${icon('settings-2')}" alt="">连接设置</button></div>
        <div class="bb-workspace">
        <button id="bbHistoryScrim" class="bb-history-scrim" type="button" aria-label="返回当前对话" tabindex="-1" hidden></button>
        <aside id="bbHistory" class="bb-history" aria-labelledby="bbHistoryTitle" hidden>
          <div id="bbHistoryOverview" class="bb-history-overview">
          <div class="bb-history-head"><div><h2 id="bbHistoryTitle">历史对话</h2><p>仅您可见</p></div><button id="bbHistoryClose" class="bb-tool bb-history-back" type="button" aria-label="返回对话"><img class="bb-icon bb-back-icon" src="${icon('arrow-right')}" alt="">返回</button></div>
          <button id="bbHistoryNew" class="bb-history-new bb-tool" type="button"><img class="bb-icon" src="${icon('plus')}" alt="">新对话</button>
          <div class="bb-history-records"><p id="bbHistoryEmpty" class="bb-history-empty" hidden>还没有历史对话<br>开始提问后，对话会保存在这里。</p><nav id="bbHistoryList" class="bb-history-list" aria-label="我的历史对话" aria-busy="false"></nav><button id="bbHistoryMore" class="bb-tool bb-history-more" type="button" hidden>加载更多对话</button><p id="bbHistoryStatus" class="bb-history-status" role="status"></p><button id="bbHistoryRetry" class="bb-tool" type="button" hidden>重试</button></div>
          <div class="bb-history-footer"><div><strong id="bbHistoryPolicy">每月1日清理</strong><button id="bbHistoryAdmin" class="bb-tool" type="button" aria-controls="bbHistoryPolicyEditor" aria-label="清理设置" title="清理设置" disabled hidden>设置<img class="bb-icon" src="${icon('arrow-right')}" alt=""></button></div><small id="bbHistoryNext"></small></div>
          </div>
          <form id="bbHistoryPolicyEditor" class="bb-history-policy-editor" aria-labelledby="bbHistoryPolicyTitle" hidden>
            <div class="bb-history-policy-body">
              <button id="bbHistoryPolicyBack" class="bb-tool bb-history-back" type="button"><img class="bb-icon bb-back-icon" src="${icon('arrow-right')}" alt="">返回历史</button>
              <h2 id="bbHistoryPolicyTitle">清理设置</h2><p class="bb-history-policy-intro">此设置对全校账号生效</p>
              <label for="bbHistoryCycle">统一清理周期</label><select id="bbHistoryCycle" aria-describedby="bbHistoryPolicyHelp"><option value="monthly">每月 1 日</option><option value="weekly">每周一</option></select>
              <p id="bbHistoryPolicyPlan" class="bb-history-policy-plan"></p>
              <div id="bbHistoryPolicyHelp" class="bb-history-policy-help"><p>到期自动删除往期对话，保留本周期对话。</p><p>晨读、通知等业务数据不受影响。</p></div>
            </div>
            <div class="bb-history-policy-actions"><p id="bbHistoryPolicyStatus" role="status"></p><button id="bbHistoryPolicySave" class="bb-send" type="submit" disabled>保存设置</button></div>
          </form>
          <form id="bbHistoryDeleteEditor" class="bb-history-delete-editor" aria-labelledby="bbHistoryDeleteHeading" hidden>
            <div class="bb-history-policy-body"><h2 id="bbHistoryDeleteHeading">删除这段对话？</h2><p id="bbHistoryDeleteTitle" class="bb-history-delete-title"></p><p class="bb-history-delete-note">对话及全部信息将永久删除，无法恢复。</p></div>
            <div class="bb-history-policy-actions"><p id="bbHistoryDeleteStatus" role="alert"></p><div class="bb-history-delete-actions"><button id="bbHistoryDeleteCancel" class="bb-tool" type="button">取消</button><button id="bbHistoryDeleteConfirm" class="bb-send" type="submit">永久删除</button></div></div>
          </form>
        </aside>
        <div id="bbChatPane" class="bb-chat-pane">
        <div id="bbScopeBar" class="bb-scope-bar"><button id="bbScopeToggle" class="bb-scope-trigger" type="button" aria-expanded="false" aria-controls="bbScopeEditor"><span class="bb-scope-kicker">分析范围</span><span id="bbScopeLabel" class="bb-scope-label"></span><img class="bb-icon" src="${icon('chevron-down')}" alt=""></button></div>
        <form id="bbScopeEditor" class="bb-scope-editor" aria-label="修改分析范围" hidden>
          <div class="bb-scope-head"><strong>分析范围</strong><button id="bbScopeClose" class="bb-tool" type="button">取消</button></div>
          <div class="bb-date-row"><div><label for="bbStart">开始日期</label><input id="bbStart" type="date" required></div><div><label for="bbEnd">结束日期</label><input id="bbEnd" type="date" required></div></div>
          <div class="bb-scope-field"><div class="bb-scope-field-heading"><span id="bbGradesLabel">年级</span><small>可多选</small></div>
            <div id="bbGrades" class="bb-grade-picks" role="group" aria-labelledby="bbGradesLabel"><button data-grade="all" type="button" aria-pressed="true">全部</button><button data-grade="高一" type="button" aria-pressed="false">高一</button><button data-grade="高二" type="button" aria-pressed="false">高二</button><button data-grade="高三" type="button" aria-pressed="false">高三</button><button data-grade="其他" type="button" aria-pressed="false">其他</button></div>
          </div>
          <div class="bb-scope-field"><label for="bbClass">班级</label><select id="bbClass"></select></div>
          <p id="bbScopeError" class="form-error" role="alert"></p>
          <div class="bb-scope-actions"><button id="bbFollowPage" class="bb-tool" type="button" title="使用当前页面已选择的日期和班级">使用页面范围</button><button class="bb-send" type="submit">应用范围</button></div>
        </form>
        <div id="bbScroll" class="bb-scroll"><div id="bbConversation" class="bb-conversation"><button id="bbRestore" class="bb-tool bb-older" type="button" hidden>历史对话未读取，点击重试</button><button id="bbOlder" class="bb-tool bb-older" type="button" hidden>查看更早的消息</button><div id="bbWelcome" class="bb-welcome"><div id="bbWelcomeIntro" class="bb-welcome-intro"><button id="bbSayHello" class="bb-say-hello" type="button" aria-label="和班班打个招呼" title="点点班班，打个招呼"></button><div><h2>您好，我是班班</h2><p id="bbWelcomeLine" aria-live="polite">学校里的变化，陪您一起看清楚。</p></div></div><p class="bb-prompt-heading">想先了解什么？</p><div id="bbPrompts" class="bb-prompts"></div></div><div id="bbMessages" class="bb-messages" aria-label="与班班的对话" aria-busy="false"></div><div id="bbFollowups" class="bb-followups" aria-label="继续聊聊" hidden></div><p id="bbLiveStatus" class="bb-live-status" role="status" hidden></p><div id="bbPresence" class="bb-presence" hidden><span class="bb-thinking-mark" aria-hidden="true"></span><div class="bb-presence-copy" role="status" aria-live="polite"><strong id="bbPresenceTitle">我来陪您看看。</strong><p id="bbPresenceNote">正在等待这次请求的回复。</p></div></div></div>
          <form id="bbSettings" class="bb-settings" aria-label="班班连接设置" novalidate hidden>
            <div class="bb-settings-body">
            <button id="bbSettingsBack" class="bb-tool bb-settings-back" type="button"><img class="bb-icon bb-back-icon" src="${icon('arrow-right')}" alt="">返回对话</button>
            <div class="bb-settings-heading"><h2 id="bbSettingsTitle">连接设置</h2><span id="bbConnectionBadge" class="bb-connection-badge" role="status">读取中</span></div>
            <p id="bbSettingsIntro" class="bb-settings-intro">选择班班使用的 AI 服务。</p>
            <fieldset id="bbSourceChoices" class="bb-connection-choices"><legend class="sr-only">选择连接方式</legend><label class="bb-connection-choice"><input id="bbSourceSchool" name="bbSource" type="radio" value="school" checked><span><strong>学校提供</strong><small>无需填写密钥</small></span></label><label class="bb-connection-choice"><input id="bbSourcePersonal" name="bbSource" type="radio" value="personal"><span><strong>自行配置</strong><small>使用您的 API</small></span></label></fieldset>
            <div id="bbSchoolSummary" class="bb-school-summary"><strong id="bbSchoolTitle">正在读取学校服务</strong><p id="bbSchoolNote">按您的账号权限分析。</p></div>
            <div id="bbProviderFields" hidden>
            <div class="bb-field"><div class="bb-field-heading bb-provider-heading"><label for="bbProvider">AI 服务商</label><a id="bbProviderLink" class="bb-settings-link" target="_blank" rel="noopener noreferrer" hidden>配置说明<img class="bb-icon" src="${icon('arrow-right')}" alt=""></a></div><select id="bbProvider" aria-describedby="bbProviderNote"><option value="custom">自定义</option>${connectionProviders.map(provider => `<option value="${provider.id}">${provider.name}</option>`).join('')}</select><p id="bbProviderNote">选择常用服务商可自动填写地址和模型。</p></div>
            <div class="bb-field"><label for="bbBaseUrl">服务地址 <span class="bb-field-translation">Base URL</span></label><input id="bbBaseUrl" type="url" inputmode="url" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="1000" aria-describedby="bbBaseNote"><p id="bbBaseNote">填写兼容 OpenAI 的 HTTPS 接口地址，不含 /chat/completions。</p></div>
            <div class="bb-field"><div class="bb-field-heading"><label for="bbKey">API 密钥 <span>API Key</span></label><span id="bbKeyState" class="bb-key-state">未设置</span></div><input id="bbKey" name="banban-api-key" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="off" maxlength="4096" aria-describedby="bbKeyNote"><p id="bbKeyNote"></p></div>
            <div class="bb-field"><label for="bbModel">模型 <span class="bb-field-translation">Model ID</span></label><input id="bbModel" type="text" placeholder="填写平台提供的模型 ID" autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="200" aria-describedby="bbModelNote"><datalist id="bbModelSuggestions"></datalist><p id="bbModelNote"></p></div>
            <label class="bb-enable-row" for="bbEnabled"><span><strong>智能分析</strong><small>关闭后仅查看数据速览</small></span><input id="bbEnabled" class="bb-toggle" type="checkbox" role="switch" aria-label="启用智能分析" aria-describedby="bbDataUse" checked></label>
            </div>
            <details class="bb-settings-privacy"><summary>数据与密钥如何使用</summary><p id="bbDataUse">智能分析会将您的问题、当前对话的相关内容和分析所需的授权数据发送至所选服务，可能包含统计与通知文字样本。教室来音仅使用数量和时长，不发送录音。</p><p>密钥保存在本平台服务器，调用时用于所选服务的身份验证，保存后不回显。测试连接不发送班级数据。</p><p>个人配置仅作用于当前账号。更换连接不改变数据权限，也不会删除历史对话。</p></details>
            <button id="bbManageSchool" class="bb-tool bb-school-manage" type="button" hidden>管理学校服务</button>
            </div>
            <div class="bb-settings-footer">
            <div class="bb-settings-result"><p id="bbSettingsStatus" role="status" aria-live="polite"></p><button id="bbSettingsReload" class="bb-tool" type="button" hidden>重新读取</button></div>
            <div class="bb-settings-actions"><button id="bbTestConnection" class="bb-tool" type="button">测试连接</button><button id="bbSettingsSave" class="bb-send" type="submit">保存并测试</button></div>
            </div>
          </form>
        </div>
        <form id="bbComposer" class="bb-compose"><div class="bb-input-box"><label for="bbInput" class="sr-only">向班班提问</label><textarea id="bbInput" placeholder="问问班班…" maxlength="2000" rows="1"></textarea><button id="bbSend" class="bb-send" type="submit" aria-label="发送问题" disabled><span id="bbSendLabel">发送</span><img id="bbSendIcon" class="bb-icon" src="${icon('arrow-up')}" alt=""></button></div><div class="bb-compose-footer"><span class="bb-privacy">仅分析您有权限查看的数据</span><small id="bbInputCount" hidden>0 / 2000</small><span class="bb-key-hint">Enter 发送</span></div></form>
        </div></div>
      </section>`;
    document.body.append(root); $('bbLauncher').prepend(mascot()); $('bbSayHello').append(mascot()); $('bbHeaderMascot').append(mascot());
    character = window.ICeClassBanbanMotion(root);
    renderPrompts();
    $('bbHistoryAdmin').hidden = !['superadmin', 'principal'].includes(window.ICeClass.state.user.role);
    const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
    function motion() { root.classList.toggle('bb-reduced', motionPreference.matches); character.reduce(motionPreference.matches); }
    motion();
    motionPreference.addEventListener('change', motion);
    root.classList.add('bb-compact');
    $('bbClose').onclick = close;
    $('bbMore').onclick = () => options($('bbOptions').hidden, true);
    document.addEventListener('pointerdown', dismissOptions);
    $('bbSayHello').onclick = () => {
      if (Date.now() - helloAt < 1600) return;
      helloAt = Date.now(); character.pet();
      const lines = ['我在呢。想从哪个班级开始看？', '收到您的招呼啦，今天也一起慢慢看。', '把问题交给我，我们有记录可查。'];
      $('bbWelcomeLine').textContent = lines[helloCount++ % lines.length];
    };
    $('bbNudgeDismiss').onclick = hideReminder;
    $('bbNudgeOpen').onclick = open;
    document.addEventListener('pointerdown', activity, {passive: true});
    document.addEventListener('keydown', activity, {passive: true});
    reminders();
    $('bbExpand').onclick = () => {
      const value = $('bbPanel').classList.toggle('bb-expanded'), label = value ? '缩小窗口' : '放大窗口';
      $('bbExpandIcon').src = icon(value ? 'minimize-2' : 'maximize-2');
      $('bbExpand').setAttribute('aria-pressed', String(value)); $('bbExpand').setAttribute('aria-label', label); $('bbExpand').title = label;
      positionPanel(); composeState(); syncHistoryInert();
    };
    $('bbComposer').onsubmit = async e => {
      e.preventDefault();
      if (!pending) { ask($('bbInput').value); return; }
      changingConversation = true; $('bbSend').disabled = true; pending.abort('user');
      try { await api('/api/banban/chat/cancel', {method: 'POST'}); }
      catch (error) { window.ICeClass.toast('停止请求尚未确认：' + error.message); }
      finally { changingConversation = false; composeState(); }
    };
    $('bbInput').oninput = () => { composeState(); character.type(); };
    $('bbInput').onfocus = () => character.listen(true);
    $('bbInput').onblur = () => character.listen(false);
    $('bbInput').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!pending) ask($('bbInput').value); } };
    $('bbNew').onclick = () => switchConversation();
    $('bbHistoryNew').onclick = () => switchConversation();
    $('bbHistoryToggle').onclick = () => showHistory($('bbHistory').hidden);
    $('bbHistoryClose').onclick = () => showHistory(false);
    $('bbHistoryScrim').onclick = () => showHistory(false);
    $('bbHistoryMore').onclick = () => loadThreads(true);
    $('bbHistoryRetry').onclick = () => loadThreads();
    $('bbHistoryDeleteCancel').onclick = () => closeHistoryDelete(true);
    $('bbHistoryDeleteEditor').onsubmit = deleteConversation;
    $('bbOlder').onclick = loadOlder;
    $('bbRestore').onclick = () => { conversationReady = restoreConversation(); };
    window.addEventListener('resize', syncHistoryInert);
    $('bbHistoryAdmin').onclick = () => showHistoryPolicy(true);
    $('bbHistoryPolicyBack').onclick = () => showHistoryPolicy(false);
    $('bbHistoryCycle').onchange = () => { $('bbHistoryPolicyStatus').textContent = ''; historyPolicyControls(); };
    $('bbHistoryPolicyEditor').onsubmit = async e => {
      e.preventDefault();
      if ($('bbHistoryPolicySave').disabled) return;
      const generation = accountGeneration;
      historyPolicyBusy = true; historyPolicyControls(); $('bbHistoryPolicyStatus').textContent = '正在保存…';
      try {
        const policy = await api('/api/banban/history-policy', {method:'PUT', body:JSON.stringify({cycle:$('bbHistoryCycle').value})});
        if (!disposed && generation === accountGeneration) { paintHistoryPolicy(policy); showHistoryPolicy(false); window.ICeClass.toast('清理周期已保存'); }
      } catch (error) { if (!disposed && generation === accountGeneration) $('bbHistoryPolicyStatus').textContent = '未保存：' + error.message; }
      finally { if (!disposed && generation === accountGeneration) { historyPolicyBusy = false; historyPolicyControls(); } }
    };
    $('bbScopeToggle').onclick = () => {
      const show = $('bbScopeEditor').hidden;
      if (show) { grades.clear(); (scope.grades || '').split(',').filter(Boolean).forEach(g => grades.add(g)); syncScope(); }
      setScopeEditor(show);
    };
    $('bbScopeClose').onclick = () => setScopeEditor(false);
    $('bbGrades').onclick = e => {
      const g = e.target.closest('[data-grade]')?.dataset.grade; if (!g) return;
      if (g === 'all') grades.clear(); else if (grades.has(g)) grades.delete(g); else grades.add(g);
      classOptions($('bbClass').value);
      $('bbGrades').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.grade === 'all' ? !grades.size : grades.has(b.dataset.grade))));
    };
    $('bbScopeEditor').onsubmit = e => {
      e.preventDefault(); const start = $('bbStart').value, end = $('bbEnd').value;
      if (!start || !end || start > end || (Date.parse(end) - Date.parse(start)) / 86400000 > 366) { $('bbScopeError').textContent = '请选择有效日期范围，最长一年。'; return; }
      scope = {start, end, classId: $('bbClass').value, grades: [...grades].join(',')}; syncScope();
      $('bbScopeError').textContent = ''; setScopeEditor(false); loadContext();
    };
    $('bbFollowPage').onclick = () => { fromPage(); setScopeEditor(false); loadContext(); };
    $('bbSettingsOpen').onclick = openSettings;
    $('bbSettingsBack').onclick = closeSettings;
    $('bbSettingsReload').onclick = readSettings;
    $('bbEnabled').onchange = settingsChanged;
    $('bbSourceSchool').onchange = settingsChanged;
    $('bbSourcePersonal').onchange = settingsChanged;
    $('bbModel').oninput = settingsChanged;
    $('bbBaseUrl').oninput = () => {
      if ($('bbKey').value && settingsKeyAddress !== settingsBaseIdentity($('bbBaseUrl').value)) $('bbKey').value = '';
      $('bbProvider').value = settingsProviderForAddress($('bbBaseUrl').value)?.id || 'custom'; settingsChanged();
    };
    $('bbProvider').onchange = () => {
      const provider = connectionProviders.find(item => item.id === $('bbProvider').value);
      if (provider) {
        if (settingsBaseIdentity($('bbBaseUrl').value) !== settingsBaseIdentity(provider.baseUrl)) $('bbKey').value = '';
        $('bbBaseUrl').value = provider.baseUrl; $('bbModel').value = provider.models[0];
      }
      settingsChanged();
    };
    $('bbManageSchool').onclick = async () => { if (settingsBusy || settingsDirty()) return; const generation = accountGeneration; settingsTarget = settingsTarget === 'school' ? 'account' : 'school'; await readSettings(); if (!disposed && generation === accountGeneration) $('bbSettingsTitle')?.scrollIntoView({block:'nearest'}); };
    $('bbKey').oninput = () => { settingsKeyAddress = settingsBaseIdentity($('bbBaseUrl').value); settingsChanged(); };
    $('bbSettings').onsubmit = async e => {
      e.preventDefault();
      if ($('bbSettingsSave').disabled) return;
      const editable = settingsEditable(), previous = settingsTarget === 'school' ? settingsConfig : settingsConfig.personal;
      if (editable) {
        const invalid = (id, message) => { settingsStatus(message, 'error'); $(id).setAttribute('aria-invalid', 'true'); $(id).focus(); };
        if ($('bbEnabled').checked && !$('bbBaseUrl').value.trim()) return invalid('bbBaseUrl', '请填写服务商提供的 Base URL。');
        try { if ($('bbBaseUrl').value.trim()) { const address = new URL($('bbBaseUrl').value.trim()); if (address.protocol !== 'https:' || address.username || address.password || address.search || address.hash) throw new Error(); } }
        catch { return invalid('bbBaseUrl', '请填写不含密钥的完整 HTTPS 服务地址。'); }
        if ($('bbEnabled').checked && !$('bbModel').value.trim()) return invalid('bbModel', '请填写服务商提供的模型 ID。');
        if (($('bbEnabled').checked && !previous.configured || previous.configured && settingsAddressChanged(previous)) && !$('bbKey').value.trim()) return invalid('bbKey', previous.configured ? '服务地址已更改，请重新填写对应的 API Key。' : '请填写该服务对应的 API Key。');
      }
      const generation = accountGeneration;
      settingsBusy = true; settingsControls(); settingsStatus('正在保存设置…');
      try {
        const body = editable ? {enabled: $('bbEnabled').checked, baseUrl: $('bbBaseUrl').value.trim(), model: $('bbModel').value.trim(), apiKey: $('bbKey').value.trim()} : {};
        if (settingsTarget === 'account') body.source = $('bbSourcePersonal').checked ? 'personal' : 'school';
        const data = await api(settingsTarget === 'school' ? '/api/banban/settings' : '/api/banban/connection', {method: 'PUT', body: JSON.stringify(body)});
        if (disposed || generation !== accountGeneration) return;
        paintSettingsConfig(data);
        if (data.enabled && data.configured) await testSettings(true);
        else settingsStatus(settingsTarget === 'school' ? '学校连接设置已保存。使用该连接的账号将仅获得数据速览。' : '设置已保存，当前账号仅使用数据速览。', 'success');
        if (settingsTarget === 'school') loadContext();
      } catch (e) { if (!disposed && generation === accountGeneration) settingsStatus('保存失败：' + e.message, 'error'); }
      finally { if (generation === accountGeneration) { settingsBusy = false; if (!disposed) settingsControls(); } }
    };
    $('bbTestConnection').onclick = async () => {
      const saved = settingsSavedConnection(), generation = accountGeneration;
      if (settingsBusy || !saved?.configured || !saved.enabled || settingsDirty()) return;
      settingsBusy = true; settingsControls();
      try { await testSettings(); }
      finally { if (generation === accountGeneration) { settingsBusy = false; if (!disposed) settingsControls(); } }
    };
    root.onkeydown = e => { if (e.key === 'Escape' && !$('bbPanel').hidden) { e.stopPropagation(); if (!$('bbHistory').hidden) { if (!$('bbHistoryDeleteEditor').hidden) { if (!deleteBusy) closeHistoryDelete(true); } else if (!$('bbHistoryPolicyEditor').hidden) showHistoryPolicy(false); else showHistory(false); } else if (!$('bbOptions').hidden) { options(false); $('bbMore').focus(); } else if (!$('bbScopeEditor').hidden) setScopeEditor(false); else close(); } };
    function dispose() { if (disposed) return; disposed = true; initialized = false; accountGeneration++; revision++; contextRevision++; threadRevision++; pending?.abort(); clearTimeout(reminder); hideReminder(); motionPreference.removeEventListener('change', motion); window.removeEventListener('pagehide', dispose); window.removeEventListener('resize', syncHistoryInert); document.removeEventListener('pointerdown', activity); document.removeEventListener('keydown', activity); document.removeEventListener('pointerdown', dismissOptions); character.dispose(); history = []; drafts.clear(); analysisClasses = null; schoolAnalysis = false; }
    $('logoutButton').addEventListener('click', () => { dispose(); root.remove(); }, {once:true});
    window.addEventListener('pagehide', dispose, {once: true});
    composeState(); dragLauncher(); dragPanel(); fromPage(); conversationReady = restoreConversation();
  }
  window.addEventListener('iceclass-ready', init);
  window.addEventListener('iceclass-classes-changed', () => { if (initialized) { if (!classesForAnalysis().some(c => c.id === scope.classId)) scope.classId = ''; syncScope(); loadContext(); } });
  if (window.ICeClass?.state.user) init();
})();

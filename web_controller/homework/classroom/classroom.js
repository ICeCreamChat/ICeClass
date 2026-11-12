(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const modal = $('homework-dialog'), confirmDialog = $('confirm-dialog');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let data, selectedSubject = '', selectedItem = '', missing = new Set(), draftStatus = 'submitted';
  let search = '', onlyMissing = false, busy = false, pendingConfirm, feedbackTimer;
  let refreshPending = false;
  const dayFormat = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
  const today = () => window.ICeClassNativeHome ? window.ICeClassHost.date || data?.serverDate : dayFormat.format(new Date());
  const term = () => data?.value.terms.find(t => t.id === data.value.activeTermId);
  const subject = () => term()?.subjects.find(s => s.id === selectedSubject);
  const items = s => s?.items.filter(i => i.active) || [];
  const item = () => items(subject()).find(i => i.id === selectedItem);
  const record = id => data?.records.find(r => r.itemId === (id || selectedItem));
  const roster = () => record()?.students || data?.value.students || [];
  const selection = values => JSON.stringify([...values].sort());
  function dirty() {
    const saved = record();
    return Boolean(selectedItem && (draftStatus !== (saved?.status || 'submitted') || selection(missing) !== selection(saved?.missing || [])));
  }
  function activity() {
    if (window.ICeClassNativeHome) window.chrome.webview.postMessage({type:'homework-activity',busy:busy || modal.open});
  }
  function feedback(message = '', success = false) {
    clearTimeout(feedbackTimer);
    const target = modal.open ? $('entry-feedback') : $('page-feedback');
    target.textContent = message; target.hidden = !message;
    target.classList.toggle('success', success); target.setAttribute('role', success ? 'status' : 'alert');
    if (success) feedbackTimer = setTimeout(() => {target.hidden = true;}, 3600);
  }
  async function api(path, body) {
    if (window.ICeClassNativeHome) return window.ICeClassHost.request('homework', {path,body});
    const response = await fetch('/api/homework/classroom' + path, {
      method: body ? 'PUT' : 'GET', credentials:'omit', cache:'no-store',
      headers: body ? {'Content-Type':'application/json'} : {},
      body: body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(25000)
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '请求失败，请稍后重试。');
    return value;
  }
  function lock() {
    modal.querySelectorAll('button,input,select').forEach(control => { control.disabled = busy; });
    document.querySelectorAll('[data-action="homework"],[data-action="reload"]').forEach(control => {control.disabled = busy;});
    const unavailable = !item() || !roster().length;
    document.querySelector('[data-action="save-homework"]').disabled = busy || unavailable || (!dirty() && Boolean(record()));
    ['missing-filter','student-search'].forEach(id => {$(id).disabled = busy || unavailable || draftStatus === 'no_homework';});
    document.querySelector('[data-action="select-all"]').disabled = busy || unavailable || draftStatus === 'no_homework';
    $('no-homework').disabled = busy || unavailable;
    $('homework-date').disabled = busy || !data;
    $('homework-subject').disabled = busy || !term()?.subjects.length;
    $('homework-item').disabled = busy || !items(subject()).length;
    activity();
  }
  function ask(title, description, action = '放弃修改') {
    if (pendingConfirm) return Promise.resolve(false);
    $('confirm-title').textContent = title; $('confirm-description').textContent = description;
    $('discard').textContent = action; confirmDialog.showModal();
    return new Promise(resolve => { pendingConfirm = resolve; });
  }
  function settle(value) { confirmDialog.close(); const resolve = pendingConfirm; pendingConfirm = null; resolve?.(value); }
  async function canLeave() {
    if (busy) { feedback('正在连接或保存，请稍候再关闭。'); return false; }
    return !dirty() || await ask('有尚未保存的修改', '放弃本次修改并继续？已保存的记录会保留。');
  }
  async function load(selectedDate, guard = true) {
    if (busy) return false;
    if (guard && !await canLeave() || busy) return false;
    busy = true; lock(); feedback();
    try {
      const fresh = await api(selectedDate ? '?date=' + encodeURIComponent(selectedDate) : '');
      data = fresh; prepare(selectedSubject, selectedItem); renderPage(); if (modal.open) render();
      return true;
    } catch (error) {
      feedback(error.name === 'TimeoutError' ? '连接超时，请检查网络后重新载入。' : error.message);
      if (data) $('homework-date').value = data.date;
      return false;
    } finally { busy = false; if (modal.open && data) updateCount(); lock(); resumeRefresh(); }
  }
  function resumeRefresh() {
    if (refreshPending && !busy && !modal.open && !pendingConfirm && !dirty() && !document.hidden)
      queueMicrotask(() => {void refreshToday();});
  }
  async function refreshToday(force = false) {
    if (!force && !refreshPending && data?.date === today()) return true;
    refreshPending = true;
    if (busy || modal.open || pendingConfirm || dirty() || document.hidden) return false;
    refreshPending = false;
    return load(undefined, false);
  }
  function renderPage() {
    const count = data.records.filter(r => r.status === 'submitted').length;
    $('class-context').textContent = `${data.value.students.length} 位同学`;
    $('student-count').textContent = `${data.value.students.length} 位同学`;
    $('subject-count').textContent = `${term().subjects.length} 科`;
    const noHomework = data.records.length - count;
    $('record-summary').textContent = data.records.length ? [count ? `已登记 ${count} 项` : '', noHomework ? `无作业 ${noHomework} 项` : ''].filter(Boolean).join(' · ') : '待登记';
    $('record-summary').parentElement.classList.toggle('is-saved', data.records.length > 0);
    const label = term().label.replace(/(\d{4})\s*[–—－]\s*(\d{4})(?=\s*学年)/g,'$1-$2');
    window.dispatchEvent(new CustomEvent('homework-context',{detail:{className:data.className,term:label}}));
  }
  function prepare(sid, iid) {
    selectedSubject = sid || ''; selectedItem = iid || '';
    if (!subject()) selectedSubject = term()?.subjects[0]?.id || '';
    if (!item()) selectedItem = items(subject())[0]?.id || '';
    const saved = record(); missing = new Set(saved?.missing || []);
    draftStatus = saved?.status || 'submitted'; search = ''; onlyMissing = false;
  }
  function renderSubjects() {
    $('homework-subject').innerHTML = (term()?.subjects || []).map(s => `<option value="${esc(s.id)}"${s.id === selectedSubject ? ' selected' : ''}>${esc(s.name)}</option>`).join('') || '<option value="">暂无学科</option>';
  }
  function renderItems() {
    $('homework-item').innerHTML = items(subject()).map(i => {
      const saved = record(i.id);
      const status = saved?.status === 'no_homework' ? ' · 无作业' : saved ? ' · 已登记' : '';
      return `<option value="${esc(i.id)}"${i.id === selectedItem ? ' selected' : ''}>${esc(i.name)}${status}</option>`;
    }).join('') || '<option value="">暂无作业项目</option>';
  }
  function renderRoster() {
    const none = draftStatus === 'no_homework', students = roster();
    const keyword = search.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    const pinyinKeyword = keyword.replace(/v/g, 'ü');
    const filtered = students.filter(s => (!keyword || s.name.toLowerCase().includes(keyword)
      || PinyinMatch.match(s.name, pinyinKeyword)) && (!onlyMissing || missing.has(s.id)));
    $('student-grid').hidden = none || !item(); $('none-message').hidden = !none;
    $('empty-roster').hidden = none || Boolean(item() && students.length && filtered.length);
    $('empty-roster').textContent = !item() ? '本学科暂无作业项目，请班主任在教师端设置学期预设。' : !students.length
      ? '本班尚未设置学生名单，请班主任在教师端设置。' : keyword ? '没有找到匹配的同学，请换个关键词试试。' : '全部已交，没有未交同学。';
    $('student-grid').innerHTML = none ? '' : filtered.map(s => `<label class="student-tile" title="${esc(s.name)}"><input type="checkbox" name="submitted-student" data-student="${esc(s.id)}" ${missing.has(s.id) ? '' : 'checked'} aria-label="${esc(s.name)}，已交"><span>${esc(s.name)}</span></label>`).join('');
    updateCount();
  }
  function updateCount() {
    const none = draftStatus === 'no_homework', students = roster();
    $('missing-badge').textContent = missing.size;
    $('submitted-count').innerHTML = none ? '无作业' : `${students.length-missing.size}<span> / ${students.length}</span>`;
    $('submission-label').textContent = none ? '不计入统计' : '人已交';
    $('unsaved-label').textContent = dirty() || !record() ? '尚未保存' : '已保存';
    $('no-homework').textContent = none ? '恢复正常登记' : '本次无作业';
    document.querySelector('[data-action="save-homework"] span').textContent = busy ? '正在保存…' : !dirty() && record() ? '已保存' : '保存登记';
    $('selection-live').textContent = none ? '本次无作业，不计入上交统计' : `已勾选 ${students.length-missing.size} 人，未勾选 ${missing.size} 人`;
    lock();
  }
  function render() {
    $('homework-title').textContent = data.date === data.serverDate ? '登记今日作业' : '登记作业';
    $('homework-date').value = data.date; $('homework-date').max = data.serverDate;
    $('student-search').value = search; $('missing-filter').setAttribute('aria-pressed', String(onlyMissing));
    renderSubjects(); renderItems(); renderRoster();
    const historical = record() && JSON.stringify(record().students) !== JSON.stringify(data.value.students);
    $('homework-description').textContent = historical ? `沿用首次登记的 ${roster().length} 位同学，补交请按此核对。` : `${roster().length} 位同学，默认全部已交，取消勾选未交同学。`;
  }
  async function save(status = draftStatus) {
    if (busy || !item() || !roster().length) return;
    busy = true; feedback(); updateCount();
    try {
      const result = await api('/records', {classId:data.classId, termId:data.value.activeTermId,
        profileRevision:data.revision, date:data.date, subjectId:selectedSubject, itemId:selectedItem,
        revision:record()?.revision || 0, status, missing:status === 'no_homework' ? [] : [...missing]});
      data.records = data.records.filter(r => r.itemId !== selectedItem).concat(result.record);
      prepare(selectedSubject, selectedItem); renderPage(); render(); feedback('登记已保存，教师端可查看。', true);
    } catch (error) {
      feedback(['TimeoutError','TypeError'].includes(error.name) ? '保存结果尚未确认。当前选择已保留，请联网后重新载入核对。' : error.message);
    } finally { busy = false; updateCount(); resumeRefresh(); }
  }
  async function close() { if (await canLeave()) {prepare('', ''); modal.close(); activity(); await refreshToday();} }
  document.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    try {
      const action = button.dataset.action;
      if (action === 'homework') {
        if (await load(undefined, false)) {render(); modal.showModal(); feedback(); $('homework-title').focus(); activity();}
      } else if (action === 'close-homework') await close();
      else if (action === 'reload') await (modal.open ? load(data?.date) : refreshToday(true));
      else if (action === 'save-homework') await save();
      else if (action === 'no-homework') {
        if (draftStatus === 'no_homework') {draftStatus='submitted';missing.clear();feedback();render();}
        else if (await ask('本次无作业','将这份作业标记为本次无需提交，并立即保存？该项目不计入应交统计。','确认无作业')) await save('no_homework');
      } else if (action === 'restore-assignment') {draftStatus='submitted';missing.clear();feedback();render();}
      else if (action === 'select-all') {missing.clear();if ($('entry-feedback').classList.contains('success')) feedback();renderItems();renderRoster();}
    } catch (error) {feedback(error.message);}
  });
  modal.addEventListener('change', async event => {
    const control = event.target;
    if (!['homework-subject', 'homework-item'].includes(control.id)) return;
    const isSubject = control.id === 'homework-subject', value = control.value;
    const previous = isSubject ? selectedSubject : selectedItem;
    if (value === previous) return;
    try {
      if (!await canLeave()) {control.value = previous; control.focus({preventScroll:true}); return;}
      prepare(isSubject ? value : selectedSubject, isSubject ? '' : value);
      feedback(); render(); control.focus({preventScroll:true});
      modal.querySelector('.roster-scroll').scrollTop = 0;
    } catch (error) {control.value = previous; feedback(error.message);}
  });
  $('homework-date').addEventListener('change', async event => {if (event.target.value) await load(event.target.value);if (data) event.target.value=data.date;});
  $('student-search').addEventListener('input', event => {search=event.target.value.trim();renderRoster();});
  $('missing-filter').addEventListener('click', () => {onlyMissing=!onlyMissing;$('missing-filter').setAttribute('aria-pressed',String(onlyMissing));renderRoster();});
  $('student-grid').addEventListener('change', event => {
    const target=event.target; if (!target.dataset.student) return;
    target.checked ? missing.delete(target.dataset.student) : missing.add(target.dataset.student);
    if ($('entry-feedback').classList.contains('success')) feedback();
    renderItems();updateCount();
    if (onlyMissing && target.checked) target.addEventListener('blur',renderRoster,{once:true});
  });
  $('keep-editing').addEventListener('click',()=>settle(false));$('discard').addEventListener('click',()=>settle(true));
  confirmDialog.addEventListener('cancel',event=>{event.preventDefault();settle(false);});
  modal.addEventListener('cancel',event=>{event.preventDefault();void close();});
  modal.addEventListener('click',event=>{if(event.target!==modal)return;const r=modal.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)void close();});
  window.addEventListener('beforeunload',event=>{if(dirty()||busy){event.preventDefault();event.returnValue='';}});
  window.addEventListener('classroom-day-change',()=>{void refreshToday();});
  window.addEventListener('classroom-view-change',event=>{if(event.detail==='management')void refreshToday();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshToday();});
  // Standalone embedded pages do not receive native island date events.
  if (!window.ICeClassNativeHome) setInterval(()=>{if(!document.hidden)void refreshToday();},60000);
  window.ICeClassHomework={prepareToLeave:canLeave,reload:()=>refreshToday(true)};
  load(undefined,false);
})();

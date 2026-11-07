(() => {
  'use strict';
  const root = document.getElementById('homeworkAdminRoot');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const app = () => window.ICeClass;
  const localDay = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai'}).format(new Date());
  const subjects = [['chinese','语文'],['math','数学'],['english','英语'],['physics','物理'],['chemistry','化学'],['biology','生物'],['politics','政治'],['history','历史'],['geography','地理']];
  let owner = '', generation = 0, profile, draft, report, cid = '', termId = '', editTerm = '';
  let start = localDay(), end = start, subjectId = '', group = 'assignments', tab = 'report', page = 1;
  let loading = false, saving = false, exporting = false, conflict = false, message = '', failed = false;
  let pendingNames = '', pendingTerm = '';
  let leaveAction;
  const leaveDialog = document.createElement('dialog');
  leaveDialog.className = 'hw-confirm';
  leaveDialog.setAttribute('aria-labelledby','hw-leave-title');
  leaveDialog.innerHTML = '<h2 id="hw-leave-title">有尚未保存的设置</h2><p>放弃名单与学期预设的修改并继续？已保存的数据会保留。</p><div class="hw-actions"><button type="button" class="btn" data-hw-keep autofocus>继续编辑</button><button type="button" class="btn primary" data-hw-discard>放弃修改</button></div>';
  document.body.append(leaveDialog);
  leaveDialog.querySelector('[data-hw-keep]').addEventListener('click',() => {leaveAction = undefined; leaveDialog.close();});
  leaveDialog.addEventListener('cancel',() => {leaveAction = undefined;});
  leaveDialog.querySelector('[data-hw-discard]').addEventListener('click',() => {
    const proceed = leaveAction; leaveAction = undefined;
    draft = clone(profile.value); pendingNames = pendingTerm = ''; conflict = false;
    leaveDialog.close(); proceed?.();
  });
  const dirty = () => Boolean(profile && draft && (JSON.stringify(profile.value) !== JSON.stringify(draft) || pendingNames.trim() || pendingTerm.trim()));
  const editable = () => Boolean(profile?.canEdit && cid && profile.classId === cid);
  const currentTerm = () => draft?.terms.find(t => t.id === editTerm);
  const visible = () => !document.getElementById('view-homework')?.classList.contains('hidden');
  const options = (values, selected) => values.map(([id,label]) => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
  const button = (action,text,primary = false,disabled = false) => `<button type="button" class="btn${primary ? ' primary' : ''}" data-hw-action="${action}" ${disabled ? 'disabled' : ''}>${text}</button>`;
  function notify(text = '', error = false) {
    message = text; failed = error;
    const node = root.querySelector('.hw-feedback');
    if (node) {node.textContent = text; node.hidden = !text; node.classList.toggle('hw-error',error); node.setAttribute('role',error ? 'alert' : 'status');}
  }
  function canLeave(proceed) {
    if (saving || loading || exporting) {app()?.toast('正在载入、保存或导出，请稍候。'); return false;}
    if (dirty()) {
      if (!leaveDialog.open) {leaveAction = proceed; leaveDialog.showModal();}
      return false;
    }
    return true;
  }
  function query(pagination = true) {
    const params = new URLSearchParams({start,end,group});
    if (cid) params.set('classId',cid);
    if (termId) params.set('termId',termId);
    if (subjectId) params.set('subjectId',subjectId);
    if (pagination) {params.set('page',page); params.set('pageSize',30);}
    return params;
  }
  function updateSave() {
    const save = root.querySelector('[data-hw-action="save"]');
    if (save) {save.disabled = saving || loading || conflict || !dirty(); save.textContent = saving ? '正在保存…' : '保存设置';}
    const state = root.querySelector('#hw-dirty');
    if (state) state.textContent = conflict ? '设置有冲突，请重新载入核对' : dirty() ? '尚未保存' : '已载入已保存设置';
    root.querySelector('[data-hw-tab="settings"]')?.setAttribute('data-dirty',String(dirty()));
  }
  function summaryHTML() {
    if (!report) return '';
    const t = report.totals, rate = t.expected ? `${(t.submitted / t.expected * 100).toFixed(1)}%` : '—';
    return `<div class="hw-summary" aria-label="作业汇总"><span>已登记作业 <strong>${t.assignments}</strong> 项</span><span>应交 <strong>${t.expected}</strong> 人次</span><span>已交 <strong>${t.submitted}</strong> 人次</span><span class="hw-missing">未交 <strong>${t.missing}</strong> 人次</span><span>上交率 <strong>${rate}</strong></span></div><p class="hw-note">未登记与今日无作业不计入应交统计。本次范围有 ${t.noHomework} 项标记为无作业。</p>`;
  }
  function tableHTML() {
    if (!report) return loading ? '' : '<div class="hw-empty">选择班级和日期后查询作业上交情况。</div>';
    if (!report.rows.length) return '<div class="hw-empty"><h2>这个范围还没有登记记录</h2><p>课代表在教室端保存后，可在这里查询。可更换日期或学科后重试。</p></div>';
    const student = report.group === 'students';
    const header = student ? ['班级','学期','学生','应交次数','已交次数','未交次数'] : ['日期','班级','学科','作业','状态','应交','已交','未交','未交名单'];
    const rows = report.rows.map(r => student ? `<tr><td>${esc(r.className)}</td><td>${esc(r.termName)}</td><th scope="row">${esc(r.studentName)}</th><td>${r.expected}</td><td>${r.submitted}</td><td class="${r.missing ? 'hw-missing' : ''}">${r.missing}</td></tr>`
      : `<tr><td class="hw-nowrap">${esc(r.date)}</td><td>${esc(r.className)}</td><td>${esc(r.subjectName)}</td><th scope="row">${esc(r.itemName)}</th><td class="hw-nowrap">${r.status === 'submitted' ? '已登记' : '今日无作业'}</td><td>${r.expected}</td><td>${r.submitted}</td><td class="${r.missing ? 'hw-missing' : ''}">${r.missing}</td><td class="hw-names">${esc(r.missingNames.join('、')) || '—'}</td></tr>`).join('');
    const pages = Math.max(1,Math.ceil(report.total / 30));
    return `<div class="hw-table-wrap" tabindex="0" role="region" aria-label="作业统计明细，可横向滚动"><table class="hw-table"><caption class="sr-only">${student ? '按学生汇总' : '按作业汇总'}，${esc(start)} 至 ${esc(end)}</caption><thead><tr>${header.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><div class="hw-pagination"><span>共 ${report.total} 条 · 第 ${page} / ${pages} 页</span><div>${button('previous','上一页',false,page <= 1 || loading)}${button('next','下一页',false,page >= pages || loading)}</div></div>`;
  }
  function settingsHTML() {
    if (!cid) return '<div class="hw-empty"><h2>请选择一个班级</h2><p>名单和学期作业项目按班级维护。</p></div>';
    if (!profile || !draft) return `<div class="hw-empty"><p>暂未载入设置，请重新载入。</p>${button('reload','重新载入',false,loading)}</div>`;
    const writable = editable(), term = currentTerm(), disabled = writable && !saving && !loading ? '' : 'disabled';
    return `<div class="hw-settings-head"><div><h2>名单与学期预设</h2><p id="hw-dirty" role="status"></p></div><div class="hw-actions">${button('reload','重新载入',false,loading || saving)}${writable ? button('save','保存设置',true,true) : ''}</div></div>
      ${writable ? '' : '<p class="hw-note">当前为查看权限。名单和学期预设由班主任或有管理权限的老师维护。</p>'}
      <section class="hw-section"><div class="hw-section-title"><h3>学生名单</h3><span>${draft.students.length} 人 · 顺序与教室端一致</span></div><div class="hw-students">${draft.students.map((s,index) => `<div class="hw-student"><span>${String(index + 1).padStart(2,'0')}</span><label class="sr-only" for="hw-student-${esc(s.id)}">第 ${index + 1} 位学生姓名</label><input id="hw-student-${esc(s.id)}" data-hw-student="${esc(s.id)}" value="${esc(s.name)}" maxlength="40" autocomplete="off" ${disabled}>${writable ? `<button type="button" class="hw-remove" data-hw-remove-student="${esc(s.id)}" aria-label="移除第 ${index + 1} 位学生 ${esc(s.name)}" ${disabled}>移除</button>` : ''}</div>`).join('') || '<p class="hw-note">本班尚未设置名单。</p>'}</div>
      ${writable ? `<div class="hw-roster-add"><label for="hw-new-students">批量添加学生，每行一人</label><textarea id="hw-new-students" rows="3" maxlength="15000" autocomplete="off" ${disabled}>${esc(pendingNames)}</textarea>${button('add-students','添加到名单',false,saving || loading)}</div>` : ''}</section>
      <section class="hw-section"><div class="hw-section-title"><h3>学期作业项目</h3><span>停用项目后，历史登记仍保留</span></div><div class="hw-term-controls"><label>查看学期<select id="hw-edit-term">${options(draft.terms.map(t => [t.id,t.label]),editTerm)}</select></label><label>教室当前学期<select id="hw-active-term" ${disabled}>${options(draft.terms.map(t => [t.id,t.label]),draft.activeTermId)}</select></label></div>
      ${term ? `<label class="hw-term-name">学期名称<input id="hw-term-name" value="${esc(term.label)}" maxlength="60" ${disabled}></label><div class="hw-subjects">${term.subjects.map(s => `<section class="hw-subject"><div class="hw-section-title"><h4>${esc(s.name)}</h4>${writable ? `<button type="button" class="btn" data-hw-add-item="${esc(s.id)}" ${disabled}>添加项目</button>` : ''}</div><div class="hw-items">${s.items.map(i => `<div class="hw-item"><label class="sr-only" for="hw-item-${esc(i.id)}">${esc(s.name)}作业名称</label><input id="hw-item-${esc(i.id)}" data-hw-item="${esc(i.id)}" value="${esc(i.name)}" maxlength="50" autocomplete="off" ${disabled}><label class="hw-active"><input type="checkbox" data-hw-active="${esc(i.id)}" ${i.active ? 'checked' : ''} ${disabled}>启用</label>${writable ? `<button type="button" class="hw-remove" data-hw-remove-item="${esc(i.id)}" aria-label="移除${esc(s.name)}作业 ${esc(i.name)}" ${disabled}>移除</button>` : ''}</div>`).join('') || '<p class="hw-note">暂无作业项目</p>'}</div></section>`).join('')}</div>` : ''}
      ${writable ? `<div class="hw-new-term"><label for="hw-new-term">新增学期</label><input id="hw-new-term" value="${esc(pendingTerm)}" placeholder="填写新学期名称" maxlength="60" ${disabled}>${button('add-term','创建新学期',false,saving || loading)}<p class="hw-note">沿用当前查看学期的作业项目，保存后可设为教室当前学期。</p></div>` : ''}</section>`;
  }
  function render() {
    const classes = app()?.state.classes || [];
    root.innerHTML = `<div class="hw-heading"><div><h1>作业统计</h1><p>查看上交情况，及时了解需要关注的学生。</p></div><div class="hw-tabs" role="group" aria-label="作业统计页面"><button type="button" class="btn" data-hw-tab="report" aria-pressed="${tab === 'report'}">统计概览</button><button type="button" class="btn" data-hw-tab="settings" aria-pressed="${tab === 'settings'}">名单与学期预设</button></div></div>
      <div class="hw-scope"><label>班级<select id="hw-class" ${loading || saving ? 'disabled' : ''}>${options([['','权限内全部班级'],...classes.map(c => [c.id,c.name])],cid)}</select></label>${tab === 'report' ? `<label>学期<select id="hw-term" ${loading ? 'disabled' : ''}>${options([['','全部学期'],...(profile?.value.terms || []).map(t => [t.id,t.label])],termId)}</select></label><label>开始日期<input id="hw-start" type="date" value="${esc(start)}" ${loading ? 'disabled' : ''}></label><label>结束日期<input id="hw-end" type="date" value="${esc(end)}" ${loading ? 'disabled' : ''}></label><label>学科<select id="hw-subject" ${loading ? 'disabled' : ''}>${options([['','全部学科'],...subjects],subjectId)}</select></label><div class="hw-actions">${button('query',loading ? '正在查询…' : '查询',true,loading)}${button('export',exporting ? '正在导出…' : '导出 CSV',false,loading || exporting)}</div>` : ''}</div>
      <p class="hw-feedback${failed ? ' hw-error' : ''}" role="${failed ? 'alert' : 'status'}" ${message ? '' : 'hidden'}>${esc(message)}</p>${loading ? '<p class="hw-loading" role="status">正在载入作业统计…</p>' : ''}
      ${tab === 'settings' ? settingsHTML() : `<div class="hw-group" role="group" aria-label="统计方式"><button type="button" class="btn" data-hw-group="assignments" aria-pressed="${group === 'assignments'}">按作业</button><button type="button" class="btn" data-hw-group="students" aria-pressed="${group === 'students'}">按学生</button></div><div aria-busy="${loading}">${summaryHTML()}${tableHTML()}</div>`}`;
    updateSave();
    if (loading || saving || exporting) root.querySelectorAll('button,input,select,textarea').forEach(control => {control.disabled = true;});
  }
  async function load({reset = false} = {}) {
    if (!root || !app()?.state.user) return;
    const identity = `${app().state.user.id}:${app().state.user.csrfToken}`;
    if (owner !== identity) {destroy(); owner = identity; reset = true;}
    if (reset) {cid = app().state.classes[0]?.id || ''; termId = '';}
    const request = ++generation; loading = true; profile = draft = report = undefined; notify(); render();
    try {
      const fresh = cid ? await app().api(`/api/homework/classes/${encodeURIComponent(cid)}/profile`,{cache:'no-store'}) : undefined;
      if (request !== generation) return;
      profile = fresh; draft = fresh ? clone(fresh.value) : undefined; conflict = false; pendingNames = pendingTerm = '';
      editTerm = fresh?.value.activeTermId || '';
      if (fresh && !termId) termId = fresh.value.activeTermId;
      if (!cid) termId = '';
      report = undefined;
      if (tab === 'report') {
        const result = await app().api('/api/homework/report?' + query(),{cache:'no-store'});
        if (request === generation) report = result;
      }
    } catch (error) {if (request === generation) notify(error.message,true);}
    finally {if (request === generation) {loading = false; render();}}
  }
  async function fetchReport() {
    if (loading) return;
    const request = ++generation; loading = true; report = undefined; notify(); render();
    try {const result = await app().api('/api/homework/report?' + query(),{cache:'no-store'}); if (request === generation) report = result;}
    catch (error) {if (request === generation) notify(error.message,true);}
    finally {if (request === generation) {loading = false; render();}}
  }
  async function saveProfile() {
    if (!editable() || !dirty() || saving || conflict) return;
    if (pendingNames.trim() || pendingTerm.trim()) return notify('请先将待添加的姓名加入名单，或创建填写中的新学期，再保存。',true);
    if (draft.students.some(s => !s.name.trim()) || draft.terms.some(t => !t.label.trim() || t.subjects.some(s => s.items.some(i => !i.name.trim())))) return notify('请填写所有学生姓名、学期名称和作业名称，或移除空白项目。',true);
    const request = generation; saving = true; notify(); render();
    try {
      const result = await app().api(`/api/homework/classes/${encodeURIComponent(cid)}/profile`,{method:'PUT',body:JSON.stringify({revision:profile.revision,value:draft})});
      if (request !== generation) return;
      profile = result; draft = clone(result.value); notify('设置已保存。教室端重新打开作业统计后使用新名单和预设。');
    } catch (error) {if (request === generation) {conflict = error.status === 409; notify(error.message,true);}}
    finally {if (request === generation) {saving = false; render();}}
  }
  async function exportCSV() {
    if (exporting || loading) return;
    exporting = true; notify(); render(); const request = generation;
    try {
      const text = await app().api('/api/homework/export?' + query(false)); if (request !== generation) return;
      const url = URL.createObjectURL(new Blob(['\ufeff',text.replace(/^\uFEFF/,'')],{type:'text/csv;charset=utf-8'}));
      const link = document.createElement('a'); link.href = url; link.download = `作业统计-${start}-${end}.csv`; link.click();
      setTimeout(() => URL.revokeObjectURL(url),1000); notify('CSV 已导出。');
    } catch (error) {if (request === generation) notify(error.message,true);}
    finally {if (request === generation) {exporting = false; render();}}
  }
  function findItem(id) {return currentTerm()?.subjects.flatMap(s => s.items).find(i => i.id === id);}
  root.addEventListener('input',event => {
    if (!editable() || saving || loading) return;
    const t = event.target;
    if (t.dataset.hwStudent) draft.students.find(s => s.id === t.dataset.hwStudent).name = t.value;
    else if (t.dataset.hwItem) findItem(t.dataset.hwItem).name = t.value;
    else if (t.id === 'hw-term-name') currentTerm().label = t.value;
    else if (t.id === 'hw-new-students') pendingNames = t.value;
    else if (t.id === 'hw-new-term') pendingTerm = t.value;
    else return;
    updateSave();
  });
  root.addEventListener('change',async event => {
    const t = event.target; if (loading || saving) return;
    if (t.id === 'hw-class') {
      const next = t.value;
      const change = () => {cid = next; termId = ''; page = 1; return load();};
      if (!canLeave(change)) {t.value = cid; return;} await change();
    }
    else if (t.id === 'hw-edit-term') {editTerm = t.value; render();}
    else if (editable() && t.id === 'hw-active-term') {draft.activeTermId = t.value; updateSave();}
    else if (editable() && t.dataset.hwActive) {findItem(t.dataset.hwActive).active = t.checked; updateSave();}
    else if (['hw-term','hw-subject','hw-start','hw-end'].includes(t.id)) {
      if (t.id === 'hw-term') termId = t.value;
      if (t.id === 'hw-subject') subjectId = t.value;
      if (t.id === 'hw-start') start = t.value;
      if (t.id === 'hw-end') end = t.value;
      page = 1; report = undefined; render();
    }
  });
  root.addEventListener('click',async event => {
    const b = event.target.closest('button'); if (!b || b.disabled || saving || loading || exporting) return;
    try {
      if (b.dataset.hwTab) {tab = b.dataset.hwTab; render(); if (tab === 'report') await fetchReport(); return;}
      if (b.dataset.hwGroup) {group = b.dataset.hwGroup; page = 1; await fetchReport(); return;}
      const action = b.dataset.hwAction;
      if (action === 'query') {page = 1; await fetchReport();}
      else if (action === 'save') await saveProfile();
      else if (action === 'reload') {if (canLeave(() => load())) await load();}
      else if (action === 'export') await exportCSV();
      else if (action === 'previous' || action === 'next') {page += action === 'next' ? 1 : -1; await fetchReport();}
      else if (editable()) {
        if (action === 'add-students') {
          const names = pendingNames.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
          if (!names.length) return notify('请先填写要添加的学生姓名。',true);
          if (draft.students.length + names.length > 300 || names.some(n => n.length > 40)) return notify('名单最多 300 人，每个姓名最多 40 字。',true);
          if (new Set(names).size !== names.length || names.some(n => draft.students.some(s => s.name === n))) return notify('添加内容有重复姓名，请核对名单后再添加。',true);
          draft.students.push(...names.map(name => ({id:crypto.randomUUID(),name}))); pendingNames = ''; render();
        } else if (b.dataset.hwRemoveStudent) {draft.students = draft.students.filter(s => s.id !== b.dataset.hwRemoveStudent); render();}
        else if (b.dataset.hwAddItem) {
          const subject = currentTerm().subjects.find(s => s.id === b.dataset.hwAddItem);
          if (subject.items.length >= 40) return notify('每个学科最多设置 40 个作业项目。',true);
          const entry = {id:crypto.randomUUID(),name:'',active:true}; subject.items.push(entry); render(); root.querySelector(`[data-hw-item="${entry.id}"]`).focus();
        } else if (b.dataset.hwRemoveItem) {currentTerm().subjects.forEach(s => {s.items = s.items.filter(i => i.id !== b.dataset.hwRemoveItem);}); render();}
        else if (action === 'add-term') {
          const label = pendingTerm.trim(); if (!label) return notify('请填写新学期名称。',true);
          if (draft.terms.length >= 30) return notify('最多保留 30 个学期。',true);
          if (draft.terms.some(t => t.label === label)) return notify('已有同名学期，请使用不同名称。',true);
          const next = clone(currentTerm()); next.id = crypto.randomUUID(); next.label = label;
          next.subjects.forEach(s => s.items.forEach(i => {i.id = crypto.randomUUID();}));
          draft.terms.push(next); editTerm = next.id; pendingTerm = ''; render(); notify('新学期已加入草稿。需要在教室使用时，将它设为当前学期并保存。');
        }
      }
    } catch (error) {notify(error.message,true);}
  });
  function destroy() {
    leaveDialog.close(); leaveAction = undefined;
    generation++; owner = ''; profile = draft = report = undefined; cid = termId = editTerm = '';
    start = localDay(); end = start; subjectId = ''; group = 'assignments'; tab = 'report'; page = 1;
    loading = saving = exporting = conflict = failed = false; message = pendingNames = pendingTerm = ''; if (root) root.replaceChildren();
  }
  window.addEventListener('beforeunload',event => {if (dirty() || saving) {event.preventDefault(); event.returnValue = '';}});
  window.addEventListener('iceclass-classes-changed',() => {if (visible() && !dirty() && !saving) load();});
  window.ICeClassHomeworkAdmin = {load,canLeave,destroy};
})();

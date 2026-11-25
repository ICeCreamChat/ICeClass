(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const subjects = {chinese:'语文',math:'数学',english:'英语',physics:'物理',chemistry:'化学',biology:'生物',politics:'政治',history:'历史',geography:'地理'};
  const statuses = {correct:'正确',wrong:'错误',incomplete:'未完成',unanswered:'未答',abstained:'弃权',exempt:'免答',ungraded:'未判定',practice:'练习'};
  const types = {single:'单选',boolean:'判断',multiple:'多选'};
  const pageSize = 20;
  let student, report, view = 'records', page = 0, busy = false, hasCard = false, lifecycle = 0, sessionCheckPending = false;
  const rate = value => value == null ? '暂无判定样本' : (value * 100).toFixed(1) + '%';
  function date(value) {
    const d = new Date(value);
    if (!value || !Number.isFinite(d.getTime())) return '时间未记录';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function feedback(id, text = '', error = false) {
    const node = $(id);
    node.textContent = text;
    node.classList.toggle('error', error);
    node.setAttribute('role', error ? 'alert' : 'status');
  }
  function records() { return (report?.records || []).filter(r => view !== 'wrong' || r.status === 'wrong' && r.counted); }
  function controls(value = busy) {
    if (!value && sessionCheckPending) {
      sessionCheckPending = false;
      clearCard(); $('student-workspace').hidden = true;
      value = true;
      queueMicrotask(() => { busy = false; void restoreSession(); });
    }
    busy = value;
    $('student-main').setAttribute('aria-busy', String(value));
    document.querySelectorAll('button,input,select').forEach(node => node.disabled = value);
    $('student-print').disabled = value || !hasCard || !student;
    const previous = $('student-previous'), next = $('student-next');
    if (previous) previous.disabled = value || page === 0;
    if (next) next.disabled = value || (page + 1) * pageSize >= records().length;
  }
  function clearCard() {
    hasCard = false;
    $('cards').replaceChildren();
    $('student-card-actions').hidden = true;
    $('student-print').disabled = true;
  }
  function clearPasswords() {
    document.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; input.removeAttribute('aria-invalid'); input.setCustomValidity(''); });
  }
  function clearWorkspace() {
    student = report = undefined; page = 0; view = 'records';
    clearCard(); clearPasswords();
    $('student-workspace').hidden = true;
    $('student-identity').textContent = '';
    $('student-report').replaceChildren(); $('student-totals').replaceChildren();
    $('student-subject').value = '';
    for (const id of ['student-card-error','student-password-error','student-report-feedback']) feedback(id);
  }
  function returnToLogin(notice) {
    lifecycle++; sessionCheckPending = false; clearWorkspace();
    const params = new URLSearchParams({login:'student'});
    if (notice) params.set('notice', notice);
    location.replace('/?' + params);
  }
  function signedIn(value) {
    const identityChanged = !student || student.id !== value.id || student.csrfToken !== value.csrfToken;
    if (identityChanged) clearWorkspace();
    student = value;
    $('student-password-title').closest('section').hidden = Boolean(value.numberCard);
    $('student-analysis-title').textContent = value.numberCard ? '本卡最近一节课堂' : '个人课堂分析';
    $('student-subject').hidden = Boolean(value.numberCard);
    document.querySelector('label[for="student-subject"]').hidden = Boolean(value.numberCard);
    $('student-workspace').hidden = false;
    $('student-identity').replaceChildren(...[
      [value.className, ' student-identity-class'],
      ['编号 ' + value.username, ''],
      [value.cardNumber == null ? '尚未分配卡号' : '卡号 ' + value.cardNumber, '']
    ].map(([text, modifier]) => {
      const segment = document.createElement('span');
      segment.className = 'student-identity-segment' + modifier;
      segment.textContent = text;
      return segment;
    }));
    if (identityChanged) clearPasswords();
    feedback('student-feedback');
  }
  async function request(path, method = 'GET', body) {
    const headers = {'Accept':'application/json'};
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (student?.csrfToken) headers['X-CSRF-Token'] = student.csrfToken;
    }
    let response;
    try {
      response = await fetch('/api/student' + path, {
        method, headers, credentials:'same-origin', cache:'no-store',
        ...(body ? {body:JSON.stringify(body)} : {}),
        ...(method === 'GET' ? {signal:AbortSignal.timeout(15000)} : {})
      });
    } catch (error) {
      throw new Error(error.name === 'TimeoutError' ? '读取超时，请检查连接后重试。' : '连接未完成，请检查网络后重试。');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('服务未返回完整结果，请稍后重试。'); }
    if (!response.ok) {
      const error = new Error(data.error || `请求失败 (${response.status})`);
      error.status = response.status; error.code = data.code;
      throw error;
    }
    return data;
  }
  function failure(error, id, inputId) {
    if (student && error.status === 401 && error.code !== 'invalid_credentials') {
      returnToLogin('expired');
      return;
    }
    feedback(id, error.message, true);
    if (inputId && error.code === 'invalid_credentials') $(inputId).setAttribute('aria-invalid', 'true');
    $(id).focus();
  }
  function answerText(record) {
    if (record.status === 'abstained') return '弃权';
    if (record.status === 'exempt' && record.option == null) return '—';
    if (record.type !== 'multiple') return record.option ? record.type === 'boolean' ? record.option === 'A' ? 'A 正确' : 'B 错误' : record.option : '未答';
    const letters = 'ABCD'.slice(0, record.options.length).split(''), choices = record.choices || {};
    const complete = record.noCardPolicy === 'abstain' ? Object.keys(choices).length > 0 : letters.every(letter => typeof choices[letter] === 'boolean');
    if (complete) return record.option || '全不选';
    if (Object.keys(choices).length) return letters.map(letter => letter + ' ' + (choices[letter] === true ? '选' : choices[letter] === false ? '不选' : '未答')).join(' · ');
    return '未答';
  }
  function roundText(record) {
    if (student?.numberCard) return record.purpose === 'practice' ? '练习轮次' : record.isOfficial ? '本题正式结果' : '较早的正式轮次';
    if (record.purpose === 'practice') return '练习轮次 · 不计入正式判分';
    if (!record.isOfficial) return '非最终正式轮次 · 不计入汇总';
    return record.counted ? '已计入跨课汇总' : '本节正式记录 · 跨课汇总已采用后续作答';
  }
  function recordHTML(record) {
    const status = statuses[record.status] || '状态待确认';
    const title = record.text || (record.imageId ? '图片题' : '临时题，老师尚未补录题干');
    const answer = record.answer ? record.type === 'boolean' ? record.answer === 'A' ? 'A 正确' : 'B 错误' : record.answer : '未设置标准答案';
    return `<details class="student-record"><summary><span class="student-record-title">${record.questionNumber ? '第 ' + record.questionNumber + ' 题 · ' : ''}${esc(types[record.type] || '题目')} · ${esc(title.length > 100 ? title.slice(0,100) + '…' : title)}</span><span class="student-record-state"><span class="student-status" data-status="${esc(record.status)}">${status}</span><span>${esc(roundText(record))}</span></span></summary><div class="student-record-content">
      <p class="student-round-note">${esc(date(record.startedAt))} · ${esc(roundText(record))}</p>
      <p class="student-question">${esc(record.text || (record.imageId ? '请结合配图作答。' : '临时题，老师尚未补录题干。'))}</p>
      ${record.imageId ? `<img class="student-question-image" src="/api/student/images/${encodeURIComponent(record.imageId)}" alt="本题配图" loading="lazy"><p class="student-error student-image-error" hidden>题图未能载入，请重新载入报告后重试。</p>` : ''}
      <ol class="student-options" type="A">${record.options.map(text => `<li>${esc(text || '选项未补录文字')}</li>`).join('')}</ol>
      <dl class="student-answer"><div><dt>我的作答</dt><dd>${esc(answerText(record))}</dd></div><div><dt>标准答案</dt><dd>${esc(answer)}</dd></div><div><dt>判定</dt><dd>${status}</dd></div></dl>
      ${record.status === 'incomplete' ? '<p class="student-note">多选尚有选项未完成，不计为错误，也不进入正确率分母。</p>' : ''}
      <p class="student-note">${record.tags.length ? '已确认知识点：' + esc(record.tags.join('、')) : '教师尚未确认知识点标签。'}</p>
    </div></details>`;
  }
  function lessonKnowledge(session) {
    if (!session.knowledge.length) return '<p class="student-note">本节暂无带知识点标签的已封存正式题。</p>';
    return '<ul>' + session.knowledge.map(topic => {
      const questions = topic.questionCount === 1 ? '仅 1 题' : topic.questionCount + ' 题';
      const missed = topic.wrongQuestionNumbers;
      const other = ['abstained','exempt','ungraded','incomplete','unanswered'].filter(key => topic[key])
        .map(key => statuses[key] + ' ' + topic[key]);
      return `<li><strong class="student-record-title">${esc(topic.tag)}</strong>
        <p class="student-note">${questions} · 正确 ${topic.correct} / 已判定 ${topic.samples} · 错误 ${topic.wrong}${missed.length ? '（第 ' + missed.join('、') + ' 题）' : ''}${other.length ? ' · ' + other.join('、') : ''}</p></li>`;
    }).join('') + '</ul>';
  }
  function renderLessonKnowledge() {
    const sessions = report.sessions.slice().reverse();
    if (!sessions.length || !sessions[0].knowledge) return '';
    const selectedId = $('student-knowledge-session')?.value;
    const current = sessions.find(s => s.id === selectedId) || sessions[0];
    return `<section class="student-session"><h3>本节知识点</h3>
      <div class="student-report-tools"><label for="student-knowledge-session">选择课堂</label><select id="student-knowledge-session">
      ${sessions.map(s => `<option value="${esc(s.id)}"${s.id === current.id ? ' selected' : ''}>${esc(subjects[s.subjectId] || s.subjectId)} · ${date(s.startedAt)} · ${esc(s.className)}</option>`).join('')}</select></div>
      <div id="student-lesson-knowledge">${lessonKnowledge(current)}</div></section>`;
  }
  function renderKnowledge() {
    const rows = report.knowledge || [];
    const lessons = renderLessonKnowledge();
    if (student?.numberCard) return lessons || '<p class="student-empty">本卡暂无本节知识点记录。</p>';
    if (!rows.length) return lessons + '<h3>跨课知识点汇总</h3><p class="student-empty">暂无带知识点标签的有效作答。</p>';
    return lessons + `<h3>跨课知识点汇总</h3><p class="student-note">仅依据教师已确认的标签汇总，请结合判定样本数阅读正确率。</p><div class="student-table-wrap" role="region" aria-label="本人知识点统计" tabindex="0"><table class="student-table"><thead><tr>${['学科','知识点','题数','作答数','判定样本','正确','错误','未完成','未答','免答','未判定','练习','正确率'].map(text => `<th scope="col">${text}</th>`).join('')}</tr></thead><tbody>${rows.map(k => `<tr><td>${esc(subjects[k.subjectId] || k.subjectId)}</td><td class="student-text">${esc(k.tag)}</td><td>${k.questionCount || 0}</td><td>${k.answers || 0}</td>${['samples','correct','wrong','incomplete','unanswered','exempt','ungraded','practice'].map(key => `<td>${k[key] || 0}</td>`).join('')}<td>${rate(k.samples ? k.accuracy : null)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('student-report').addEventListener('change', event => {
    if (event.target.id !== 'student-knowledge-session') return;
    const session = report.sessions.find(s => s.id === event.target.value);
    if (session) $('student-lesson-knowledge').innerHTML = lessonKnowledge(session);
  });
  function renderReport() {
    document.querySelectorAll('[data-student-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.studentView === view)));
    if (!report) { $('student-report').innerHTML = '<p class="student-empty">暂无可显示的报告，请重新载入。</p>'; return; }
    const totals = report.totals;
    $('student-totals').innerHTML = `<dl class="student-totals">${[['samples','判定样本'],['correct','正确'],['wrong','错误'],['accuracy','正确率'],['incomplete','未完成'],['unanswered','未答'],['abstained','弃权'],['exempt','免答'],['ungraded','未判定'],['practice','练习']].map(([key,label]) => `<div><dt>${label}</dt><dd>${key === 'accuracy' ? rate(totals.samples ? totals.accuracy : null) : totals[key] || 0}</dd></div>`).join('')}</dl>`;
    if (view === 'knowledge') { $('student-report').innerHTML = renderKnowledge(); controls(); return; }
    const all = [...records()].sort((a,b) => b.startedAt - a.startedAt), pages = Math.max(1, Math.ceil(all.length / pageSize));
    page = Math.min(page, pages - 1);
    const groups = new Map();
    for (const record of all.slice(page * pageSize, (page + 1) * pageSize)) {
      if (!groups.has(record.sessionId)) groups.set(record.sessionId, []);
      groups.get(record.sessionId).push(record);
    }
    $('student-report').innerHTML = (student?.numberCard ? '' : view === 'wrong' ? '<p class="student-note">这里展示计入跨课汇总的正式错题。作答记录保留全部轮次。</p>' : '<p class="student-note">保留所有轮次，分别显示判定状态和统计归属。仅包含本人已结束的课堂。</p>') +
      (all.length ? [...groups].map(([sessionId, rows]) => {
        const session = report.sessions.find(s => s.id === sessionId) || rows[0];
        return `<section class="student-session"><h3>${esc(subjects[session.subjectId] || session.subjectId)} · ${date(session.startedAt)}</h3><p class="student-note">${esc(session.className)} · 已结束课堂</p>${rows.map(recordHTML).join('')}</section>`;
      }).join('') : `<p class="student-empty">${view === 'wrong' ? '当前没有计入汇总的错题。' : '暂无已结束课堂的作答记录。'}</p>`) +
      (all.length > pageSize ? `<div class="student-pagination"><span>第 ${page+1}/${pages} 页 · 共 ${all.length} 条记录</span><div class="student-actions"><button type="button" id="student-previous">上一页</button><button type="button" id="student-next">下一页</button></div></div>` : '');
    controls();
  }
  async function loadReport() {
    if (busy || !student) return;
    const current = lifecycle;
    if (student.numberCard) {
      report = undefined;
      $('student-report').replaceChildren();
      $('student-totals').replaceChildren();
    }
    controls(true); $('student-report').setAttribute('aria-busy', 'true');
    feedback('student-report-feedback', '正在读取个人课堂分析…');
    try {
      const subject = $('student-subject').value;
      const result = await request('/report' + (subject ? '?' + new URLSearchParams({subjectId:subject}) : ''));
      if (current !== lifecycle) return;
      if (result.accountId !== student.id) {
        lifecycle++; clearWorkspace(); controls(false);
        await restoreSession();
        return;
      }
      report = result; renderReport();
      if (student.numberCard) feedback('student-report-feedback', report.sessions.length ? `本卡在本班最近一节通用卡课堂中有 ${report.records.length} 条作答记录。` : '本班最近一节已结课的通用卡课堂暂无此卡记录。');
      else feedback('student-report-feedback', `已读取 ${report.sessions.length} 节已结束课堂、${report.records.length} 条本人作答记录。`);
    } catch (error) {
      if (current !== lifecycle) return;
      failure(error, 'student-report-feedback');
      if (student) {
        if (!report) renderReport();
        else $('student-report-feedback').textContent += ' 当前保留上次成功读取的数据。';
      }
    } finally { if (current === lifecycle) { controls(false); $('student-report').setAttribute('aria-busy', 'false'); } }
  }
  async function restoreSession() {
    if (busy) { sessionCheckPending = true; return; }
    const current = ++lifecycle, wasSignedIn = Boolean(student);
    controls(true); $('student-session-retry').hidden = true;
    feedback('student-feedback', '正在核对学生登录状态…');
    try {
      const result = await request('/session');
      if (current !== lifecycle) return;
      if (result.authenticated) signedIn(result.student); else returnToLogin(wasSignedIn ? 'expired' : '');
    } catch (error) {
      if (current !== lifecycle) return;
      clearWorkspace(); feedback('student-feedback', error.message, true); $('student-session-retry').hidden = false;
    } finally { if (current === lifecycle) controls(false); }
    if (current === lifecycle && student) await loadReport();
  }
  $('student-card-form').onsubmit = async event => {
    event.preventDefault();
    if (busy || !student || !$('student-card-form').reportValidity()) return;
    const current = lifecycle, body = {password:$('card-password').value};
    $('card-password').value = ''; clearCard(); feedback('student-card-error'); controls(true);
    $('student-card-form').setAttribute('aria-busy', 'true');
    try {
      const result = await request('/card', 'POST', body);
      if (current !== lifecycle) return;
      $('cards').innerHTML = window.CardQuizPrintCard.render(result.card);
      hasCard = true; $('student-card-actions').hidden = false;
    } catch (error) { if (current === lifecycle) failure(error, 'student-card-error', 'card-password'); }
    finally { body.password = ''; if (current === lifecycle) { controls(false); $('student-card-form').setAttribute('aria-busy', 'false'); } }
    if (current === lifecycle && hasCard) $('student-print').focus();
  };
  $('student-password-form').onsubmit = async event => {
    event.preventDefault();
    if (busy || !student || !$('student-password-form').reportValidity()) return;
    if ($('new-password').value !== $('confirm-password').value) {
      $('confirm-password').setCustomValidity('两次新密码不一致，请重新输入。'); $('confirm-password').reportValidity();
      feedback('student-password-error', '两次新密码不一致，请重新输入。', true); return;
    }
    const current = lifecycle, body = {currentPassword:$('current-password').value,newPassword:$('new-password').value};
    clearPasswords(); feedback('student-password-error'); controls(true);
    $('student-password-form').setAttribute('aria-busy', 'true');
    try {
      await request('/password', 'PUT', body);
      if (current !== lifecycle) return;
      returnToLogin('password-changed');
    } catch (error) { if (current === lifecycle) failure(error, 'student-password-error', 'current-password'); }
    finally { body.currentPassword = body.newPassword = ''; if (current === lifecycle) { controls(false); $('student-password-form').setAttribute('aria-busy', 'false'); } }
  };
  $('student-logout').onclick = async () => {
    if (busy || !student) return;
    const current = lifecycle;
    clearCard(); controls(true);
    try { await request('/logout', 'POST', {}); if (current === lifecycle) returnToLogin('signed-out'); }
    catch (error) { if (current === lifecycle) failure(error, 'student-feedback'); }
    finally { if (current === lifecycle) controls(false); }
  };
  $('student-subject').onchange = () => { report = undefined; page = 0; $('student-totals').replaceChildren(); $('student-report').replaceChildren(); void loadReport(); };
  $('student-report-reload').onclick = restoreSession;
  $('student-session-retry').onclick = restoreSession;
  $('student-print').onclick = () => { if (!busy && student && hasCard) window.print(); };
  $('student-card-clear').onclick = () => { clearCard(); $('card-password').focus(); };
  document.addEventListener('input', event => {
    if (event.target.matches('input')) { event.target.removeAttribute('aria-invalid'); event.target.setCustomValidity(''); }
    if (['new-password','confirm-password'].includes(event.target.id)) $('confirm-password').setCustomValidity('');
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-student-view]');
    if (button && !busy) { view = button.dataset.studentView; page = 0; renderReport(); button.focus(); }
    if (!busy && ['student-previous','student-next'].includes(event.target.id)) {
      page += event.target.id === 'student-next' ? 1 : -1; renderReport();
      const target = $(event.target.id); if (target && !target.disabled) target.focus(); else $('student-report').querySelector('summary')?.focus();
    }
  });
  $('student-report').addEventListener('error', event => {
    if (event.target.matches('.student-question-image')) { event.target.hidden = true; event.target.nextElementSibling.hidden = false; }
  }, true);
  window.addEventListener('pagehide', () => { lifecycle++; clearCard(); clearPasswords(); });
  window.addEventListener('focus', () => { if (student) void restoreSession(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { sessionCheckPending = false; controls(false); clearWorkspace(); void restoreSession(); } });
  void restoreSession();
})();

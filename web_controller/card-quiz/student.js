(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const {escape: esc, math} = window.StudentReportText;
  const formatted = (text, subjectId) => subjectId === 'math' ? math(text) : esc(text);
  const subjects = {chinese:'语文',math:'数学',english:'英语',physics:'物理',chemistry:'化学',biology:'生物',politics:'政治',history:'历史',geography:'地理'};
  const statuses = {correct:'正确',wrong:'错误',incomplete:'未完成',unanswered:'未答',abstained:'弃权',exempt:'免答',ungraded:'未判定',practice:'练习'};
  const types = {single:'单选',boolean:'判断',multiple:'多选'};
  const pageSize = 20;
  const exerciseIndex = new Map(), exerciseChoices = new Map(), positions = new Map();
  let student, report, session, analysis, steps = [], stepIndex = 0;
  let view = 'lesson', page = 0, busy = false, hasCard = false, lifecycle = 0;
  let sessionCheck, reportRead = 0, reading = false, pageActive = true;
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
    busy = value;
    $('student-main').setAttribute('aria-busy', String(busy || reading || Boolean(sessionCheck)));
    $('student-report').setAttribute('aria-busy', String(reading));
    document.querySelectorAll('form button, form input, #student-logout').forEach(node => node.disabled = busy);
    $('student-print').disabled = busy || Boolean(sessionCheck) || !hasCard || !student;
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
    lifecycle++; reportRead++; reading = busy = false;
    student = report = session = undefined; page = stepIndex = 0; view = 'lesson'; steps = [];
    stopAnalysis(); positions.clear(); exerciseIndex.clear(); exerciseChoices.clear();
    clearCard(); clearPasswords();
    $('student-workspace').hidden = $('student-menu-link').hidden = true;
    $('student-identity').textContent = '';
    $('student-report').replaceChildren(); $('student-totals').replaceChildren();
    for (const id of ['student-lesson-counts','student-lesson-meta','student-knowledge-session']) $(id).replaceChildren();
    $('student-analysis-title').textContent = '课后报告';
    $('student-statistics').hidden = $('student-session-field').hidden = true;
    $('student-card-form').setAttribute('aria-busy', 'false');
    $('student-password-form').setAttribute('aria-busy', 'false');
    $('student-subject').value = '';
    for (const id of ['student-card-error','student-password-error','student-report-feedback']) feedback(id);
  }
  function returnToLogin(notice) {
    pageActive = false; sessionCheck = null; clearWorkspace();
    const params = new URLSearchParams({login:'student'});
    if (notice) params.set('notice', notice);
    location.replace('/?' + params);
  }
  function signedIn(value) {
    const identityChanged = !student || student.id !== value.id || student.csrfToken !== value.csrfToken;
    if (identityChanged) clearWorkspace();
    student = value;
    $('student-password-title').closest('section').hidden = Boolean(value.numberCard);
    document.querySelector('[data-student-view=wrong]').hidden = Boolean(value.numberCard);
    $('student-subject').hidden = Boolean(value.numberCard);
    document.querySelector('label[for="student-subject"]').hidden = Boolean(value.numberCard);
    $('student-workspace').hidden = $('student-menu-link').hidden = false;
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
    feedback('student-feedback');
    return identityChanged;
  }
  async function request(path, method = 'GET', body, controller, timeout = method === 'GET' ? 15000 : 0) {
    const headers = {'Accept':'application/json'};
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (student?.csrfToken) headers['X-CSRF-Token'] = student.csrfToken;
    }
    const abort = controller || (timeout ? new AbortController() : null);
    let timedOut = false;
    const timer = timeout && setTimeout(() => { timedOut = true; abort.abort(); }, timeout);
    try {
      const response = await fetch('/api/student' + path, {
        method, headers, credentials:'same-origin', cache:'no-store',
        ...(body ? {body:JSON.stringify(body)} : {}),
        signal: abort?.signal
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error('服务未返回完整结果，请稍后重试。'); }
      if (!response.ok) {
        const error = new Error(data.error || `请求失败 (${response.status})`);
        error.status = response.status; error.code = data.code;
        throw error;
      }
      return data;
    } catch (error) {
      if (timedOut) throw new Error('读取超时，请检查连接后重试。');
      if (error.name === 'TypeError' || error.name === 'AbortError') throw new Error('连接未完成，请检查网络后重试。');
      throw error;
    } finally { clearTimeout(timer); }
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
  function exerciseKey(record, item) {
    return JSON.stringify([record.sessionId, record.questionId, record.roundId, item?.id ?? null]);
  }
  function indexExercises(records) {
    exerciseIndex.clear();
    for (const record of records) {
      if (!record.isOfficial || record.status !== 'wrong') continue;
      for (const item of record.exercises || []) exerciseIndex.set(exerciseKey(record, item), item);
    }
    for (const key of exerciseChoices.keys()) {
      if (!exerciseIndex.has(key)) exerciseChoices.delete(key);
    }
  }
  function exerciseFeedback(item, choice) {
    if (!choice) return '';
    const result = choice === item.answer ? '答对了。' : '应选 ' + item.answer + '。';
    return result + (item.explanation ? ' ' + item.explanation : '');
  }
  function exerciseHTML(record, item) {
    const key = exerciseKey(record, item), choice = exerciseChoices.get(key);
    const format = text => formatted(text, record.subjectId);
    const options = item.options.map((option, index) => {
      const letter = 'ABCD'[index];
      return `<button type="button" data-exercise-choice="${letter}" aria-pressed="${choice === letter}"><span class="student-option-letter">${letter}</span> <span>${format(option)}</span></button>`;
    }).join('');
    return `<fieldset class="student-exercise" data-exercise="${esc(key)}"><legend>${format(item.text)}</legend>
      <div class="student-exercise-options">${options}</div><p class="student-exercise-feedback" role="status">${format(exerciseFeedback(item, choice))}</p></fieldset>`;
  }
  function exercisesHTML(records, tag) {
    const fields = [];
    for (const record of records) {
      for (const item of record.exercises || []) {
        const key = exerciseKey(record, item);
        if (!exerciseIndex.has(key) || (tag && item.tag !== tag)) continue;
        fields.push(exerciseHTML(record, item));
      }
    }
    return fields.length ? '<section class="student-practice"><h4>针对练习</h4>' + fields.join('') + '</section>' : '';
  }
  const subjectName = lesson => subjects[lesson.subjectId] || lesson.subjectId || '';
  const lessonTitle = lesson => lesson.title?.trim() || (subjectName(lesson) ? subjectName(lesson) + '课堂' : '课堂报告');
  function imageHTML(record) {
    return record.imageId ? `<img class="student-question-image" src="/api/student/images/${encodeURIComponent(record.imageId)}" alt="第 ${esc(record.questionNumber || '')} 题配图" loading="lazy"><p class="student-error" hidden>题图未能载入，请重新载入报告后重试。</p>` : '';
  }
  function optionsHTML(record) {
    return '<ol class="student-options" type="A">' + record.options.map(option =>
      '<li>' + formatted(option || '选项未补录文字', record.subjectId) + '</li>').join('') + '</ol>';
  }
  function reviewAnswer(record, value) {
    if (!value) return value === '' && record.type === 'multiple' ? '全不选' : '未记录';
    if (record.type !== 'boolean') return value;
    const option = record.options['AB'.indexOf(value)];
    if (option === '正确') return '对';
    if (option === '错误') return '错';
    return option || value;
  }
  function explanation(record) {
    if (!record.isOfficial || record.status !== 'wrong') return '';
    if (record.explanation?.trim()) return record.explanation;
    const extra = analysis?.status === 'ready' && analysis.sessionId === record.sessionId
      ? analysis.result.explanations?.[record.questionNumber] : null;
    return typeof extra === 'string' ? extra : '';
  }
  function selectLesson(id) {
    session = report.sessions.find(s => s.id === id) || report.sessions[report.sessions.length - 1];
    const official = session ? report.records.filter(r => r.sessionId === session.id && r.isOfficial && r.purpose !== 'practice') : [];
    const wrong = official.filter(r => r.status === 'wrong').sort((a,b) => (a.questionNumber || 0) - (b.questionNumber || 0));
    const counts = new Map();
    for (const {status} of official) counts.set(status, (counts.get(status) || 0) + 1);
    const correct = counts.get('correct') || 0;
    const otherCounts = ['abstained','exempt','ungraded','incomplete','unanswered'].filter(key => counts.has(key))
      .map(key => statuses[key] + ' ' + counts.get(key) + ' 题');
    steps = wrong.flatMap((record, index) => (record.exercises?.length ? record.exercises : [null]).map((item, exerciseIndex) =>
      ({record, item, mistake: index + 1, mistakeCount: wrong.length, exerciseIndex, key: exerciseKey(record, item)})));
    stepIndex = Math.max(0, steps.findIndex(step => step.key === positions.get(session?.id)));
    $('student-lesson-counts').innerHTML = `<span>共 <b>${official.length}</b> 题</span><span>答对 <b>${correct}</b> 题</span><span>答错 <b class="student-wrong-count">${wrong.length}</b> 题</span>` +
      (otherCounts.length ? `<p class="student-other-counts">${otherCounts.join(' · ')}</p>` : '');
    selectAnalysis(correct + wrong.length);
    renderReport();
  }
  function renderReview() {
    if (!session) return `<p class="student-empty">${student.numberCard ? '本班最近一节已结课的通用卡课堂暂无此卡记录。' : '暂无已结束课堂的作答记录。'}</p>`;
    if (!steps.length) return `<p class="student-empty">${analysis.hasSamples ? '本节已判定的题目全部答对了。' : '本节暂无可判定的正式作答。'}</p>`;
    const {record, item, mistake, mistakeCount, exerciseIndex} = steps[stepIndex];
    const format = text => formatted(text, record.subjectId);
    const number = record.questionNumber ? '第 ' + esc(record.questionNumber) + ' 题 · ' : '';
    const additionalTags = (record.tags || []).filter(tag => tag !== item?.tag);
    const reason = explanation(record);
    return `<section class="student-mistake" aria-labelledby="student-mistake-title">
      <div class="student-line-heading"><h2 id="student-mistake-title" tabindex="-1">${number}${esc(types[record.type] || '题目')}</h2>
      ${mistakeCount > 1 ? `<span class="student-progress">错题 ${mistake} / ${mistakeCount}</span>` : ''}</div>
      <p class="student-question">${format(record.text || (record.imageId ? '请结合配图作答。' : '临时题，老师尚未补录题干。'))}</p>
      ${imageHTML(record)}${record.type === 'boolean' ? '' : optionsHTML(record)}
      <p class="student-verdict"><span>你选「<strong>${esc(reviewAnswer(record, record.option))}</strong>」</span>
      <span>${record.type === 'boolean' ? '应判' : '应选'}「<strong>${esc(reviewAnswer(record, record.answer))}</strong>」</span></p>
      <p id="student-mistake-explanation" class="student-reason"${reason ? '' : ' hidden'}>${format(reason)}</p>
      ${additionalTags.length ? `<p class="student-note">知识点 · ${esc(additionalTags.join('、'))}</p>` : ''}
    </section>
    ${item ? `<section class="student-drill" aria-labelledby="student-drill-title">
      <div class="student-line-heading"><h2 id="student-drill-title" tabindex="-1">针对练习</h2><span class="student-progress" aria-label="本题配套练习 ${exerciseIndex + 1}，共 ${record.exercises.length} 道">${exerciseIndex + 1} / ${record.exercises.length}</span></div>
      ${item.tag ? `<p class="student-topic">${esc(item.tag)}</p>` : ''}${exerciseHTML(record, item)}</section>`
      : '<p class="student-note">本题暂无配套练习。</p>'}
    <div class="student-step-actions">${stepIndex ? '<button type="button" id="student-step-back">上一题</button>' : ''}
      <button type="button" class="primary" id="student-step-next">${stepIndex + 1 < steps.length ? '下一题' : '查看学情报告'}</button></div>`;
  }
  function recordHTML(record) {
    const status = statuses[record.status] || '状态待确认';
    const title = record.text || (record.imageId ? '图片题' : '临时题，老师尚未补录题干');
    const answer = record.answer ? record.type === 'boolean' ? record.answer === 'A' ? 'A 正确' : 'B 错误' : record.answer : '未设置标准答案';
    return `<details class="student-record"><summary><span class="student-record-title">${record.questionNumber ? '第 ' + esc(record.questionNumber) + ' 题 · ' : ''}${esc(types[record.type] || '题目')} · ${formatted(title.length > 100 ? title.slice(0,100) + '…' : title, record.subjectId)}</span><span class="student-record-state"><span class="student-status" data-status="${esc(record.status)}">${status}</span><span>${esc(roundText(record))}</span></span></summary><div class="student-record-content">
      <p class="student-round-note">${esc(date(record.startedAt))} · ${esc(roundText(record))}</p>
      <p class="student-question">${formatted(record.text || (record.imageId ? '请结合配图作答。' : '临时题，老师尚未补录题干。'), record.subjectId)}</p>
      ${imageHTML(record)}${optionsHTML(record)}
      <dl class="student-answer"><div><dt>我的作答</dt><dd>${esc(answerText(record))}</dd></div><div><dt>标准答案</dt><dd>${esc(answer)}</dd></div><div><dt>判定</dt><dd>${status}</dd></div></dl>
      ${record.status === 'incomplete' ? '<p class="student-note">多选尚有选项未完成，不计为错误，也不进入正确率分母。</p>' : ''}
      <p class="student-note">${record.tags.length ? '已确认知识点：' + esc(record.tags.join('、')) : '教师尚未确认知识点标签。'}</p>
      ${record.explanation ? `<p class="student-reason">${formatted(record.explanation, record.subjectId)}</p>` : ''}
      ${exercisesHTML([record])}
    </div></details>`;
  }
  function lessonKnowledge(session) {
    if (!session.knowledge?.length) return '<p class="student-note">本节暂无带知识点标签的已封存正式题。</p>';
    const practiceRecords = report.records.filter(r => r.sessionId === session.id && r.exercises?.length);
    return '<ul>' + session.knowledge.map(topic => {
      const questions = topic.questionCount === 1 ? '仅 1 题' : topic.questionCount + ' 题';
      const missed = topic.wrongQuestionNumbers;
      const other = ['abstained','exempt','ungraded','incomplete','unanswered'].filter(key => topic[key])
        .map(key => statuses[key] + ' ' + topic[key]);
      return `<li><strong class="student-record-title">${esc(topic.tag)}</strong>
        <p class="student-note">${questions} · 正确 ${topic.correct} / 已判定 ${topic.samples} · 错误 ${topic.wrong}${missed.length ? '（第 ' + missed.join('、') + ' 题）' : ''}${other.length ? ' · ' + other.join('、') : ''}</p>${topic.wrong ? exercisesHTML(practiceRecords, topic.tag) : ''}</li>`;
    }).join('') + '</ul>';
  }
  function renderKnowledge() {
    const rows = report.knowledge || [];
    const lessons = session ? `<section class="student-session"><h2>本节知识点</h2><p class="student-note">${esc(lessonTitle(session))} · ${esc(date(session.startedAt))}</p><div id="student-lesson-knowledge">${lessonKnowledge(session)}</div></section>` : '';
    if (student?.numberCard) return lessons || '<p class="student-empty">本卡暂无本节知识点记录。</p>';
    if (!rows.length) return lessons + '<h3>跨课知识点汇总</h3><p class="student-empty">暂无带知识点标签的有效作答。</p>';
    return lessons + `<h3>跨课知识点汇总</h3><p class="student-note">仅依据教师已确认的标签汇总，请结合判定样本数阅读正确率。</p><div class="student-table-wrap" role="region" aria-label="本人知识点统计" tabindex="0"><table class="student-table"><thead><tr>${['学科','知识点','题数','作答数','判定样本','正确','错误','未完成','未答','免答','未判定','练习','正确率'].map(text => `<th scope="col">${text}</th>`).join('')}</tr></thead><tbody>${rows.map(k => `<tr><td>${esc(subjects[k.subjectId] || k.subjectId)}</td><td class="student-text">${esc(k.tag)}</td><td>${k.questionCount || 0}</td><td>${k.answers || 0}</td>${['samples','correct','wrong','incomplete','unanswered','exempt','ungraded','practice'].map(key => `<td>${k[key] || 0}</td>`).join('')}<td>${rate(k.samples ? k.accuracy : null)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('student-knowledge-session').onchange = event => {
    if (report && session?.id !== event.target.value) selectLesson(event.target.value);
  };
  $('student-report').addEventListener('click', event => {
    const button = event.target.closest('[data-exercise-choice]');
    if (!button) return;
    const field = button.closest('[data-exercise]'), key = field.dataset.exercise;
    const item = exerciseIndex.get(key);
    if (!item) return;
    const choice = button.dataset.exerciseChoice;
    exerciseChoices.set(key, choice);
    for (const option of field.querySelectorAll('[data-exercise-choice]')) {
      option.setAttribute('aria-pressed', String(option === button));
    }
    field.querySelector('[role=status]').innerHTML = formatted(exerciseFeedback(item, choice), recordSubject(key));
  });
  function recordSubject(key) { return report.sessions.find(s => s.id === JSON.parse(key)[0])?.subjectId; }
  function renderReport() {
    document.querySelectorAll('[data-student-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.studentView === view)));
    const lessonView = view === 'lesson';
    const title = {records:'所有作答记录',wrong:'跨课错题',knowledge:'知识点统计'};
    $('student-analysis-title').textContent = lessonView ? (session ? lessonTitle(session) : '课后报告') : title[view];
    $('student-session-field').hidden = !session || student.numberCard || report.sessions.length < 2 || !(lessonView || view === 'knowledge');
    $('student-lesson-meta').hidden = $('student-lesson-counts').hidden = !(lessonView && session);
    $('student-lesson-meta').textContent = session ? [session.className, subjectName(session)].filter(Boolean).join(' · ') : '';
    $('student-statistics').hidden = lessonView || !report;
    $('student-ai').hidden = !lessonView || !session;
    if (!report) { $('student-report').innerHTML = '<p class="student-empty">暂无可显示的报告，请重新载入。</p>'; return; }
    if (lessonView) { $('student-report').innerHTML = renderReview(); return; }
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
        return `<section class="student-session"><h2>${esc(lessonTitle(session))}</h2><p class="student-note">${esc(session.className)} · ${date(session.startedAt)}</p>${rows.map(recordHTML).join('')}</section>`;
      }).join('') : `<p class="student-empty">${view === 'wrong' ? '当前没有计入汇总的错题。' : '暂无已结束课堂的作答记录。'}</p>`) +
      (all.length > pageSize ? `<div class="student-pagination"><span>第 ${page+1}/${pages} 页 · 共 ${all.length} 条记录</span><div class="student-actions"><button type="button" id="student-previous">上一页</button><button type="button" id="student-next">下一页</button></div></div>` : '');
    controls();
  }
  async function waitForIdentity() {
    // A focus event can start a newer check while a report, analysis or password response is in flight.
    while (sessionCheck) {
      try { await sessionCheck; } catch { /* restoreSession clears the workspace on failure. */ }
    }
  }
  function stopAnalysis() {
    if (analysis) { clearTimeout(analysis.timer); analysis.controller?.abort(); }
    analysis = undefined;
    $('student-ai').hidden = $('student-ai-action').hidden = true;
    $('student-ai-state').textContent = '';
    $('student-ai-content').replaceChildren();
  }
  function paintAnalysis() {
    const {status, result} = analysis;
    const state = $('student-ai-state'), action = $('student-ai-action');
    const messages = {loading:'正在生成本节学情报告…', insufficient:'本节暂无可判定的正式作答，暂时无法生成学情报告。',
      changed:'课堂报告已更新或已不可查看，请重新载入最新报告。', error:analysis.message, ready:'本节学情报告已生成。'};
    state.textContent = messages[status];
    state.classList.toggle('student-quiet', status === 'ready');
    state.classList.toggle('error', status === 'error' || status === 'changed');
    const content = $('student-ai-content');
    content.setAttribute('aria-busy', String(status === 'loading'));
    content.innerHTML = status === 'ready' ? '<dl>' + [['strengths','掌握情况'],['review','复习重点'],['nextStep','下一步']].map(([key,label]) =>
      `<div><dt>${label}</dt><dd>${formatted(result.analysis[key], session.subjectId)}</dd></div>`).join('') + '</dl>' : '';
    action.textContent = status === 'changed' ? '重新载入最新报告' : '重试';
    action.hidden = status !== 'error' && status !== 'changed';
    // Only update the explanation in place. An arriving report must not replace the student's focused option.
    const node = $('student-mistake-explanation'), step = steps[stepIndex];
    if (node && step) {
      const reason = explanation(step.record);
      node.hidden = !reason; node.innerHTML = formatted(reason, step.record.subjectId);
    }
  }
  function selectAnalysis(samples) {
    if (session && analysis?.sessionId === session.id && analysis.hasSamples === Boolean(samples)) return;
    stopAnalysis();
    if (!session) return;
    analysis = {accountId:student.id, sessionId:session.id, revision:session.revision, hasSamples:Boolean(samples),
      status:samples ? 'loading' : 'insufficient'};
    paintAnalysis();
    if (samples) void pollAnalysis(analysis);
  }
  async function pollAnalysis(entry, retry = false) {
    if (!pageActive || analysis !== entry || entry.inFlight || document.hidden) return;
    entry.inFlight = true;
    try {
      await waitForIdentity();
      if (entry !== analysis || !pageActive) return;
      const body = entry.revision == null ? {} : {revision:entry.revision};
      if (retry) body.retry = true;
      entry.controller = new AbortController();
      const data = await request('/report/' + encodeURIComponent(entry.sessionId) + '/analysis', 'POST', body, entry.controller, 60000);
      await waitForIdentity();
      if (entry !== analysis || !pageActive) return;
      if (data.accountId !== entry.accountId || data.sessionId !== entry.sessionId ||
          (entry.revision != null && data.revision != null && data.revision !== entry.revision)) {
        entry.status = 'changed';
      } else if (data.status === 'pending') {
        const delay = Number.isFinite(data.retryAfterMs) && data.retryAfterMs > 0 ? data.retryAfterMs : 2000;
        entry.timer = setTimeout(() => { entry.timer = null; void pollAnalysis(entry); }, delay);
      } else if (data.status === 'insufficient') {
        entry.status = 'insufficient';
      } else if (data.status === 'ready' && ['strengths','review','nextStep'].every(key => typeof data.analysis?.[key] === 'string' && data.analysis[key].trim())) {
        entry.status = 'ready'; entry.result = data;
      } else {
        throw new Error('学情报告暂未生成，请重试。');
      }
    } catch (error) {
      await waitForIdentity();
      if (entry !== analysis || !pageActive) return;
      if (error.status === 401) { returnToLogin('expired'); return; }
      entry.status = error.code === 'analysis_changed' || [403,404].includes(error.status) ? 'changed' : 'error';
      entry.message = error.message || '学情报告未能载入，请重试。';
    } finally {
      entry.inFlight = false; entry.controller = null;
      if (entry === analysis && entry.status !== 'loading') paintAnalysis();
    }
  }
  $('student-ai-action').onclick = () => {
    if (analysis?.status === 'changed') { void restoreSession(); return; }
    if (analysis?.status !== 'error') return;
    analysis.status = 'loading';
    $('student-ai-title').focus({preventScroll:true}); paintAnalysis(); void pollAnalysis(analysis, true);
  };
  function forgetReport() {
    report = session = undefined; steps = []; stepIndex = page = 0;
    positions.clear(); exerciseIndex.clear(); exerciseChoices.clear(); stopAnalysis();
    $('student-knowledge-session').replaceChildren(); $('student-totals').replaceChildren();
    $('student-lesson-counts').replaceChildren(); renderReport();
  }
  function acceptReport(result) {
    // A revision covers the teacher's answers and exercises. Older servers provide only the records themselves.
    if (report) {
      const nextSessions = new Map(result.sessions.map(s => [s.id, s]));
      const used = new Set([session?.id, ...positions.keys(), ...Array.from(exerciseChoices.keys(), key => JSON.parse(key)[0])]);
      for (const old of report.sessions) {
        if (!used.has(old.id)) continue;
        const next = nextSessions.get(old.id);
        const changed = !next || old.revision !== next.revision || (next.revision == null &&
          JSON.stringify(report.records.filter(r => r.sessionId === old.id)) !== JSON.stringify(result.records.filter(r => r.sessionId === old.id)));
        if (!changed) continue;
        positions.delete(old.id);
        for (const key of exerciseChoices.keys()) if (JSON.parse(key)[0] === old.id) exerciseChoices.delete(key);
        if (analysis?.sessionId === old.id) stopAnalysis();
      }
    }
    if (analysis?.status === 'changed') stopAnalysis();
    report = result; indexExercises(result.records);
    const selector = $('student-knowledge-session');
    selector.replaceChildren(...result.sessions.slice().reverse().map(s =>
      new Option(lessonTitle(s) + ' · ' + date(s.startedAt) + ' · ' + s.className, s.id)));
    selectLesson(session?.id);
    if (session) selector.value = session.id;
  }
  async function loadReport(reconcile = true, background = false) {
    if (!student || !pageActive) return;
    const current = ++reportRead;
    reading = true; controls();
    const feedbackNode = $('student-report-feedback');
    feedbackNode.classList.toggle('student-quiet', Boolean(report));
    feedback('student-report-feedback', '正在读取课堂报告…');
    try {
      const subject = student.numberCard ? '' : $('student-subject').value;
      const result = await request('/report' + (subject ? '?' + new URLSearchParams({subjectId:subject}) : ''));
      await waitForIdentity();
      if (current !== reportRead) return;
      if (result.accountId !== student.id) {
        clearWorkspace();
        if (reconcile) await restoreSession(true, false);
        else { feedback('student-feedback', '学生身份已变化，请重新核对登录。', true); $('student-session-retry').hidden = false; }
        return;
      }
      // The student may have moved to another exercise while either kind of reload was in flight.
      if (!report || (!background && analysis?.status === 'changed') || JSON.stringify(report) !== JSON.stringify(result)) {
        acceptReport(result);
      }
      if (document.activeElement === feedbackNode) $('student-analysis-title').focus({preventScroll:true});
      feedbackNode.classList.add('student-quiet');
      feedback('student-report-feedback', `已读取 ${result.sessions.length} 节已结束课堂、${result.records.length} 条本人作答记录。`);
    } catch (error) {
      await waitForIdentity();
      if (current !== reportRead) return;
      feedbackNode.classList.remove('student-quiet');
      if (student.numberCard) forgetReport();
      failure(error, 'student-report-feedback');
      if (student && report) feedbackNode.textContent += ' 当前保留上次成功读取的数据。';
      else if (student) renderReport();
    } finally { if (current === reportRead) { reading = false; controls(); } }
  }
  let reloadRequested = false;
  async function restoreSession(refresh = true, reconcile = true) {
    if (!pageActive) return;
    reloadRequested ||= refresh;
    const check = request('/session');
    sessionCheck = check; controls(); $('student-session-retry').hidden = true;
    $('cards').hidden = true;
    if (!student) feedback('student-feedback', '正在核对学生登录状态…');
    let changed;
    try {
      const result = await check;
      if (sessionCheck !== check) return;
      if (!result.authenticated) { returnToLogin(student ? 'expired' : ''); return; }
      changed = signedIn(result.student);
    } catch (error) {
      if (sessionCheck !== check) return;
      clearWorkspace(); feedback('student-feedback', error.message, true); $('student-session-retry').hidden = false;
      return;
    } finally {
      if (sessionCheck === check) { sessionCheck = null; $('cards').hidden = false; controls(); }
    }
    const explicit = reloadRequested;
    reloadRequested = false;
    if (explicit || changed || (!reading && (!report || student.numberCard))) await loadReport(reconcile, !explicit && !changed);
  }
  let printAssets;
  async function loadPrintCard() {
    if (!printAssets) {
      printAssets = new Promise((resolve, reject) => {
        const loader = document.createElement('script');
        loader.src = '../assets/page-assets.js?v=2';
        loader.onload = () => resolve(window.ICeClassAssets);
        loader.onerror = () => {
          printAssets = null;
          loader.remove();
          reject(new Error('纸卡打印资源未能载入，请检查连接后重试。'));
        };
        document.head.append(loader);
      });
    }
    const {script, styles} = await printAssets;
    await Promise.all([
      styles('print'),
      script('vendor/cv.js').then(() => script('vendor/aruco.js')).then(() => script('cards.js?v=2')),
      script('vendor/qrcodegen.js').then(() => script('qr-code.js'))
    ]);
    await script('print-card.js?v=6');
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
      await loadPrintCard();
      await waitForIdentity();
      if (current !== lifecycle) return;
      if (result.card.accountId !== student.id) { clearWorkspace(); await restoreSession(); return; }
      $('cards').innerHTML = window.CardQuizPrintCard.render(result.card);
      hasCard = true; $('student-card-actions').hidden = false;
    } catch (error) { await waitForIdentity(); if (current === lifecycle) failure(error, 'student-card-error', 'card-password'); }
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
      await waitForIdentity();
      if (current !== lifecycle) return;
      returnToLogin('password-changed');
    } catch (error) { await waitForIdentity(); if (current === lifecycle) failure(error, 'student-password-error', 'current-password'); }
    finally { body.currentPassword = body.newPassword = ''; if (current === lifecycle) { controls(false); $('student-password-form').setAttribute('aria-busy', 'false'); } }
  };
  $('student-logout').onclick = async () => {
    if (busy || !student) return;
    const current = lifecycle;
    clearCard(); controls(true);
    try { await request('/logout', 'POST', {}); await waitForIdentity(); if (current === lifecycle) returnToLogin('signed-out'); }
    catch (error) { await waitForIdentity(); if (current === lifecycle) failure(error, 'student-feedback'); }
    finally { if (current === lifecycle) controls(false); }
  };
  $('student-subject').onchange = () => { forgetReport(); void loadReport(); };
  $('student-report-reload').onclick = () => { void restoreSession(); };
  $('student-session-retry').onclick = () => { void restoreSession(); };
  $('student-print').onclick = () => { if (!busy && student && hasCard) window.print(); };
  $('student-card-clear').onclick = () => { clearCard(); $('card-password').focus(); };
  document.addEventListener('input', event => {
    if (event.target.matches('input')) { event.target.removeAttribute('aria-invalid'); event.target.setCustomValidity(''); }
    if (['new-password','confirm-password'].includes(event.target.id)) $('confirm-password').setCustomValidity('');
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-student-view]');
    if (button && !button.hidden && student) {
      view = button.dataset.studentView; page = 0; renderReport();
      $('student-analysis-title').focus();
    }
    if (['student-step-back','student-step-next'].includes(event.target.id) && steps.length) {
      if (event.target.id === 'student-step-next' && stepIndex === steps.length - 1) { $('student-ai-title').focus(); return; }
      const old = steps[stepIndex];
      stepIndex += event.target.id === 'student-step-next' ? 1 : -1;
      const step = steps[stepIndex];
      positions.set(session.id, step.key);
      $('student-report').innerHTML = renderReview();
      $(step.record === old.record && step.item ? 'student-drill-title' : 'student-mistake-title').focus();
    }
    if (!busy && ['student-previous','student-next'].includes(event.target.id)) {
      page += event.target.id === 'student-next' ? 1 : -1; renderReport();
      const target = $(event.target.id); if (target && !target.disabled) target.focus(); else $('student-report').querySelector('summary')?.focus();
    }
  });
  $('student-report').addEventListener('error', event => {
    if (event.target.matches('.student-question-image')) { event.target.hidden = true; event.target.nextElementSibling.hidden = false; }
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && analysis?.status === 'loading' && !analysis.timer) void pollAnalysis(analysis);
  });
  window.addEventListener('pagehide', () => { pageActive = false; sessionCheck = null; clearWorkspace(); });
  window.addEventListener('focus', event => { if (event.target === window && student) void restoreSession(false); });
  window.addEventListener('pageshow', event => { if (event.persisted) { pageActive = true; void restoreSession(); } });
  void restoreSession();
})();

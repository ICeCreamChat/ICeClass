(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const formatter = window.StudentReportText;
  const escape = formatter ? formatter.escape : text => String(text).replace(/[&<>]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;'
  })[ch]);
  const math = formatter && CSS.supports('math-style', 'normal') ? formatter.math : escape;
  const letter = index => String.fromCharCode(65 + index);
  let report, exercises = [], choices = [], index = 0, version = 0, pending, signingOut = false;

  function answer(question, value) {
    return question.type === 'boolean' ? question.options[value.charCodeAt(0) - 65] : value;
  }

  function heading(question, number) {
    return '第 ' + number + ' 题 · ' + (question.type === 'boolean' ? '判断题' : '单选题');
  }

  function comparison(question) {
    return '你选「' + escape(answer(question, question.chosen)) + '」，正确答案「' +
      escape(answer(question, question.answer)) + '」';
  }

  function renderExercise() {
    const item = exercises[index];
    el('progress').textContent = (index + 1) + ' / ' + exercises.length;
    el('exercise').innerHTML = '<fieldset><legend>' + math(item.text) + '</legend><div class="example-choices">' +
      item.options.map((text, i) => '<button type="button" data-choice="' + letter(i) + '">' +
        letter(i) + '　' + math(text) + '</button>').join('') + '</div></fieldset>';
    el('back').hidden = index === 0;
    el('next').textContent = index + 1 < exercises.length ? '下一题' : '查看 AI 学情报告';
    renderChoice();
  }

  function renderChoice() {
    const selected = choices[index], item = exercises[index];
    el('exercise').querySelectorAll('[data-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.choice === selected));
    });
    const verdict = el('verdict');
    verdict.className = selected === item.answer ? 'correct' : 'incorrect';
    verdict.innerHTML = selected ? (selected === item.answer ? '答对了。' : '正确答案是 ' + escape(item.answer) + '。') +
      math(item.explanation) : '';
  }

  function render(data) {
    const lesson = data.lesson, questions = lesson.questions;
    const mistakeIndex = questions.findIndex(q => q.chosen !== q.answer);
    const mistake = questions[mistakeIndex];
    const correct = questions.filter(q => q.chosen === q.answer).length;
    el('lesson').textContent = lesson.title;
    el('identity').textContent = [data.className, lesson.subject, '学生编号 ' + data.username].join(' · ');
    el('counts').innerHTML = '<span>共 <b>' + questions.length + '</b> 题</span><span>答对 <b>' + correct +
      '</b> 题</span><span>答错 <b class="incorrect">' + (questions.length - correct) + '</b> 题</span>';
    el('mistake').innerHTML = '<h2>' + heading(mistake, mistakeIndex + 1) + '</h2><p class="question-text">' +
      math(mistake.text) + '</p><p>' + comparison(mistake) + '</p><p>' + math(mistake.reason) +
      '</p><p class="example-meta">知识点 · ' + escape(mistake.knowledge.join('、')) + '</p>';
    exercises = mistake.exercises;
    renderExercise();
    el('answers').innerHTML = questions.map((q, i) => '<details class="example-record"><summary>' + heading(q, i + 1) +
      ' · ' + (q.chosen === q.answer ? '答对' : '答错') + '</summary><p class="question-text">' + math(q.text) + '</p>' +
      (q.image ? '<img loading="lazy" src="examples/' + encodeURIComponent(q.image) + '" alt="第 ' + (i + 1) + ' 题配图">' : '') +
      '<ol type="A">' + q.options.map(option => '<li>' + math(option) + '</li>').join('') +
      '</ol><p>' + comparison(q) + '</p><p class="example-meta">知识点 · ' + escape(q.knowledge.join('、')) + '</p></details>').join('');
    el('analysis').innerHTML = [['strengths', '已掌握'], ['review', '需要巩固'], ['nextStep', '下一步练习']].map(
      ([field, title]) => '<dt>' + title + '</dt><dd>' + math(lesson.analysis[field]) + '</dd>').join('');
  }

  el('exercise').addEventListener('click', event => {
    const button = event.target.closest('button[data-choice]');
    if (!button || !report) return;
    choices[index] = button.dataset.choice;
    renderChoice();
  });
  function move(step) {
    index += step;
    renderExercise();
    el('exercise-heading').focus();
  }
  el('back').onclick = () => move(-1);
  el('next').onclick = () => {
    if (index + 1 < exercises.length) move(1);
    else el('ai').focus();
  };

  function hide() {
    el('report').hidden = el('logout').hidden = true;
    el('retry').hidden = true;
    el('status').textContent = '正在核对学生登录状态…';
  }

  async function request(path, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/student/' + path, Object.assign({
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal
      }, options));
      if (response.status === 401) return null;
      if (!response.ok) throw new Error();
      return await response.json();
    } finally { clearTimeout(timeout); }
  }

  async function load() {
    if (document.hidden || signingOut || pending === version) return;
    const current = ++version;
    pending = current;
    hide();
    try {
      const data = await request('report-example');
      if (version !== current) return;
      if (!data) { location.replace('/student'); return; }
      if (!report || data.csrfToken !== report.csrfToken) {
        index = 0; choices = []; el('all-answers').open = false;
        render(data);
      }
      report = data;
      el('status').textContent = '';
      el('report').hidden = el('logout').hidden = false;
    } catch {
      if (version !== current) return;
      el('status').textContent = '报告未能载入，请检查网络后重试。';
      el('retry').hidden = false;
    } finally {
      if (pending === current) pending = undefined;
    }
  }

  el('logout').onclick = async () => {
    if (!report || signingOut) return;
    signingOut = true; ++version;
    hide(); el('status').textContent = '正在退出…';
    try {
      const result = await request('logout', {method: 'POST', headers: {'X-CSRF-Token': report.csrfToken}});
      location.replace(result ? '/?login=student&notice=signed-out' : '/student');
    } catch {
      el('status').textContent = '退出未完成，请重新载入后再试。';
      el('retry').hidden = false;
      signingOut = false;
    }
  };
  el('retry').onclick = load;
  window.addEventListener('pagehide', () => { ++version; report = null; choices = []; hide(); });
  window.addEventListener('pageshow', load);
  window.addEventListener('focus', load);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { ++version; hide(); }
    else load();
  });
})();

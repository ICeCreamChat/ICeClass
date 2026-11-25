/* The disc projects the classroom's current controls. Only reading and navigation live here. */
(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const letters = 'ABCD';
  const kinds = {single: '单选', multiple: '多选', boolean: '判断'};
  const nativeDisc = () => document.body.matches('body.banban.in-disc');
  const present = node => Boolean(node?.isConnected && !node.closest('[hidden], [inert]'));
  const ready = node => present(node) && !node.matches(':disabled');
  const clamp = (value, max) => Math.max(0, Math.min(value, max));
  const clock = new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', hour12: false});
  const dateTime = new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
  const bookmarkKey = 'card-quiz-disc-position';
  const barsPerPage = 4;

  function subject(session) {
    return [...byId('subject').options].find(option => option.value === session.subjectId)?.text || '课堂';
  }

  function choice(id, label, name, icon, run, allowed = () => true, face = {}) {
    return {id, label, name, icon, run, allowed, ...face};
  }

  function button(target, id, label, name, icon, allowed = true) {
    const node = byId(target);
    if (!present(node)) return null;
    return choice(id, label, name, icon, () => node.click(), () => allowed && ready(node));
  }

  function selectOption(control, option) {
    if (control.value === option.value) return;
    control.value = option.value;
    control.dispatchEvent(new Event('change', {bubbles: true}));
  }

  function questionFields(q, picture, answer) {
    const fields = [];
    if (q.text) fields.push({id: 'stem', label: '题干', icon: 'book-open', text: q.text});
    if (q.imageId || picture) fields.push({id: 'image', label: '配图', icon: 'monitor', picture,
      text: '本机暂时无法显示配图。'});
    if (q.options.some(Boolean)) q.options.forEach((text, index) => {
      const mark = letters[index];
      fields.push({id: 'option-' + mark.toLowerCase(), label: '选项', title: '选项 ' + mark,
        mark, icon: 'list-checks', text: text || '见课件'});
    });
    if (answer) fields.push({id: 'answer', label: '答案', icon: 'check', text: answer});
    return fields;
  }

  class CardQuizDisc {
    constructor(repaint) {
      this.repaint = repaint;
      this.serial = 0;
      this.actions = new Map();
      this.journalNumbers = new Map();
      this.journalNumber = 0;
      this.pairChanges = new MutationObserver(() => {
        if (nativeDisc() && byId('pair-dialog').open) this.repaint();
      });
      new MutationObserver(() => {
        if (nativeDisc()) return;
        this.releaseCardAlert();
        this.reader?.remove();
        this.record?.remove();
        this.pairChanges.disconnect();
        this.dialog = this.active = null;
        this.actions.clear();
        delete document.body.dataset.quizDisc;
      }).observe(document.body, {attributes: true, attributeFilter: ['class']});
      // A WebView reload goes through the host's ordinary restore flow. Keep only the
      // reading position for the same lesson/question, never a command, draft or invitation.
      try { this.bookmark = JSON.parse(sessionStorage.getItem(bookmarkKey)); } catch {}
      this.historyPage = Number.isInteger(this.bookmark?.historyPage) ? this.bookmark.historyPage : 0;
      this.historyEntry = this.bookmark?.historyEntry;
      window.addEventListener('pagehide', () => {
        if (!nativeDisc() || !this.main?.identity || !this.context?.pane) return;
        const {identity, path} = this.main;
        const position = path.filter(step => step.view !== 'notice').map(({view, index, part, field}) => ({view, index, part, field}));
        try { sessionStorage.setItem(bookmarkKey, JSON.stringify({identity, path: position,
          historyPage: this.historyPage, historyEntry: this.historyEntry})); } catch {}
      });
    }

    scope(identity) {
      const scope = {identity, serial: ++this.serial, path: [{view: 'root'}]};
      if (this.bookmark?.identity === identity && Array.isArray(this.bookmark.path)) {
        const path = this.bookmark.path.filter(step => step && ['root', 'read', 'record', 'status'].includes(step.view));
        if (path[0]?.view === 'root') scope.path = path;
        this.bookmark = null;
        try { sessionStorage.removeItem(bookmarkKey); } catch {}
      }
      return scope;
    }

    get step() { return this.active.path.at(-1); }

    releaseCardAlert() {
      if (this.cardAlert && this.cardAlert.parentNode === this.columns) this.reader.before(this.cardAlert);
    }

    enter(view, values = {}) {
      this.active.path.push({view, ...values});
      this.repaint();
    }

    isCurrent() {
      return nativeDisc() && this.active && this.context?.pane === document.body.dataset.pane &&
        (this.context.dialog || null) === document.querySelector('dialog[open]');
    }

    activate(id) {
      const action = this.actions.get(id);
      if (!this.isCurrent() || !action?.allowed()) return false;
      action.run();
      return true;
    }

    back() {
      if (!this.isCurrent()) return false;
      if (this.cardAlert) {
        // Only acknowledge the displayed dialog notice. Keep the card, page and
        // global save/recovery status; the host recalculates cardPanel.radial.
        if (this.cardAlert.textContent === this.shownCardError) this.cardAlert.remove();
        this.repaint();
        return true;
      }
      if (this.active.path.length < 2) return false;
      this.active.path.pop();
      this.repaint();
      return true;
    }

    page(layout, title, items, {value, hint, focusId, key = '', surface = 'ring'} = {}) {
      if (surface !== 'record' && this.record?.isConnected) this.record.remove();
      document.body.dataset.quizDisc = surface;
      return {key: [this.context.dialog?.id || this.context.pane, this.active.serial, this.step.view, key].join('/'),
        layout, title, value, hint, ...(focusId ? {focusId} : {}), items: items.filter(Boolean).map(action => {
          const {allowed, run, ...item} = action;
          const enabled = Boolean(allowed());
          if (enabled) this.actions.set(item.id, action);
          return {...item, enabled};
        })};
    }

    describe(context) {
      this.context = context;
      this.actions.clear();
      const {pane, dialog, s, q} = context;
      const scope = [pane, s?.id, ['question', 'options', 'distribution', 'next'].includes(pane) ? q?.id : null];
      if (pane === 'distribution') scope.push(context.r?.id);
      if (pane === 'record-chart') scope.push(s?.questions[context.recordIndex]?.id);
      const identity = JSON.stringify(scope);
      if (this.main?.identity !== identity) this.main = this.scope(identity);
      if (this.dialog !== dialog) {
        this.releaseCardAlert();
        this.pairChanges.disconnect();
        this.dialog = dialog;
        this.modal = dialog ? this.scope(dialog.id) : null;
        if (dialog?.id === 'pair-dialog') {
          // Relay claims and expiry change the original DOM between wheel renders.
          for (const id of ['pair-qr', 'pair-code', 'pair-status', 'confirm-phone'])
            this.pairChanges.observe(byId(id), {attributes: true, attributeFilter: ['hidden', 'disabled'], childList: true, characterData: true, subtree: true});
        }
      }
      this.active = dialog ? this.modal : this.main;
      this.cardAlert = dialog?.id === 'exempt-dialog' ? dialog.querySelector('[role="alert"]') : null;
      this.shownCardError = this.cardAlert?.textContent;
      const supported = nativeDisc() && (dialog ? this.shownCardError || ['pair-dialog', 'confirm-dialog'].includes(dialog.id) :
        ['options', 'question', 'distribution', 'next', 'history', 'summary', 'record-chart'].includes(pane));
      if (!supported) {
        this.active = null;
        this.record?.remove();
        delete document.body.dataset.quizDisc;
        return null;
      }
      if (this.shownCardError) return this.read([{id: 'card-error', label: '核卡提示', text: this.shownCardError, alert: this.cardAlert}]);

      const feedback = byId('feedback');
      const notice = dialog ? dialog.querySelector('[role="alert"]')?.textContent :
        feedback.matches('.warning,.error') ? feedback.textContent : '';
      if (notice !== this.active.notice) {
        this.active.notice = notice;
        if (notice && this.step.view !== 'notice' && !(!dialog && ['summary', 'record-chart'].includes(pane)))
          this.active.path.push({view: 'notice'});
        if (!notice && this.step.view === 'notice') this.active.path.pop();
      }
      if (this.step.view === 'notice') return this.read([{id: 'notice', label: '操作提示', text: notice}]);
      if (dialog?.id === 'pair-dialog') return this.pairPage();
      if (dialog?.id === 'confirm-dialog') return this.confirmPage();
      switch (pane) {
        case 'options': return this.optionsPage();
        case 'question': return this.questionPage();
        case 'distribution': return this.distributionPage();
        case 'record-chart': return this.recordPage(context.recordIndex);
        case 'next': return this.nextPage();
        case 'history': return this.historyList();
        case 'summary': return this.summaryPage();
      }
    }

    get writable() {
      const {s, operation, frozen, revoked} = this.context;
      return s?.endedAt === null && !operation && !frozen && !revoked;
    }

    optionsPage() {
      const {r, lesson} = this.context;
      const select = byId('multi-option');
      const items = [...select.options].filter(option => option.value !== r.activeOption).map(option =>
        choice('collect-' + option.value.toLowerCase(), option.value, '收 ' + option.value + ' 项，' + (r.noCardPolicy === 'abstain' ? '选才举卡，A 朝上' : 'A 朝上选，B 朝上不选'),
          'circle-dot', () => selectOption(select, option), () => this.writable && ready(select) && ready(option)));
      return this.page('ring', '第 ' + lesson.number + ' 题', items, {
        value: '收 ' + r.activeOption, hint: '已收 ' + lesson.received + (lesson.participantCount === undefined ? '/' + lesson.expected : ' 人')
      });
    }

    questionActions() {
      const reveal = byId('reveal');
      return [button('edit', 'edit', '设置', '设置题目与标准答案', 'file-pen-line', this.writable),
        button('reveal', 'reveal', this.context.q?.answer ? '揭晓' : '讲解', reveal.textContent, 'check', this.writable)];
    }

    fieldLinks(fields) {
      return fields.map(field => choice('read-' + field.id, field.label, '查看' + (field.title || field.label), field.icon,
        () => this.enter('read', {field: field.id}), undefined, field.mark ? {mark: field.mark} : {}));
    }

    questionPage() {
      const {q, lesson} = this.context;
      const answer = byId('answer-display');
      const fields = q ? questionFields(q, this.context.images?.[q.imageId], !answer.hidden && answer.textContent) : [];
      const actions = this.questionActions().filter(Boolean);
      const step = this.step;
      if (step.view === 'read' || !actions.length && fields.length <= 1) {
        if (step.followReveal && !answer.hidden) { step.field = 'answer'; step.part = 0; }
        if (!this.context.operation) delete step.followReveal;
        const reveal = actions.find(action => action.id === 'reveal');
        if (reveal) reveal.run = () => { step.followReveal = true; byId('reveal').click(); };
        if (!fields.length) fields.push({id: 'stem', label: '看题', text: byId('question-text').textContent});
        return this.read(fields, [reveal]);
      }
      return this.page('ring', '第 ' + lesson.number + ' 题', [...actions, ...this.fieldLinks(fields)], {
        value: q?.revealed ? (q.answer ? '答案 ' + q.answer : '已讲解') : kinds[q?.type],
        hint: this.context.r?.purpose === 'practice' ? '讲解后练习' : !q?.text ? '题干见课件' : ''
      });
    }

    distributionPage() {
      const {q, r, lesson, summary, renderDistribution} = this.context;
      const chart = this.chartPage(lesson.bars);
      byId('distribution').innerHTML = renderDistribution(q, summary, chart.rows);
      const title = r.purpose === 'practice' ? '练习' : chart.pages > 1 ? '组合' : '分布';
      return this.page('reader', '第 ' + lesson.number + ' 题 · ' + title + chart.suffix, chart.turns,
        {surface: 'chart', key: String(chart.index)});
    }

    chartPage(bars) {
      const pages = Math.max(1, Math.ceil(bars.length / barsPerPage));
      const index = clamp(this.step.part || 0, pages - 1);
      const turn = delta => { this.step.part = index + delta; this.repaint(); };
      return {index, pages, rows: bars.slice(index * barsPerPage, (index + 1) * barsPerPage),
        suffix: pages > 1 ? ' ' + (index + 1) + '/' + pages : '',
        turns: pages > 1 ? this.turnItems(index > 0, index + 1 < pages, turn, ['上页','下页'], ['上一页组合','下一页组合']) : []};
    }

    nextPage() {
      const {s, nextQuestion, images} = this.context;
      const number = (s?.questions.length || 0) + 1;
      const temporary = button('temporary', 'temporary', '临时题', '编辑并添加一道临时题', 'file-pen-line', this.writable);
      if (nextQuestion) {
        const fields = questionFields(nextQuestion, images?.[nextQuestion.imageId], false);
        if (this.step.view === 'read') return this.read(fields);
        return this.page('ring', '题单下一题', [
          button('next', 'add-next', '加题', '使用题单下一题', 'skip-forward', this.writable),
          ...this.fieldLinks(fields), temporary
        ], {value: '第 ' + number + ' 题', hint: kinds[nextQuestion.type]});
      }
      const template = byId('next-template'), next = byId('next');
      const items = [...template.options].map(option => {
        const [kind, count] = option.value.split(':');
        const mark = kind === 'boolean' ? '对错' : 'A-' + letters[Number(count) - 1];
        return choice('add-' + kind + '-' + count, kinds[kind], '添加课件题，' + option.text, 'list-checks', () => {
          selectOption(template, option);
          if (ready(next)) next.click();
        }, () => this.writable && ready(next) && ready(template) && ready(option), {mark, selected: template.value === option.value});
      });
      return this.page('ring', '课件加题', [...items, temporary], {value: '第 ' + number + ' 题'});
    }

    pairPage() {
      const qr = byId('pair-qr'), code = byId('pair-code'), status = byId('pair-status').textContent;
      const confirm = button('confirm-phone', 'confirm-phone', '确认', '确认使用已连接的手机', 'check', this.writable);
      if (qr.hidden || this.step.view === 'pair-info') {
        const message = [!code.hidden && code.textContent, status].filter(Boolean).join('\n');
        return this.read([{id: 'pair-info', label: code.hidden ? '手机扫码' : '手机配对', text: message}], [confirm]);
      }
      const items = [];
      if (!code.hidden) items.push(choice('pair-info', '配对码', '查看配对码和手机登录提示', 'info', () => this.enter('pair-info')));
      items.push(confirm);
      const title = code.hidden ? '请用手机扫码' : byId('confirm-phone').disabled ? '扫码登录' : '手机已连接';
      return this.page('reader', title, items, {surface: 'qr'});
    }

    confirmPage() {
      // The original run() holds its busy flag while this promise waits for the teacher.
      const title = byId('confirm-heading').textContent;
      const end = title.includes('结束');
      return this.read([{id: 'consequence', label: title, text: byId('confirm-description').textContent}], [
        button('confirm-ok', 'confirm', end ? '结课' : '确认', end ? '确认结束本课堂' : title, 'check', !this.context.frozen)
      ]);
    }

    historyList() {
      const {saved, s, operation} = this.context;
      const entries = saved.filter(j => j.session.endedAt != null && (j.syncedSeq < j.session.seq || j.reviewError));
      const lastOpened = entries.findIndex(j => j.session.id === this.historyEntry);
      // While the host is opening a journal it temporarily excludes that session from saved.
      if (lastOpened < 0 && !s && !operation) this.historyEntry = null;
      if (!entries.length) return this.read([{id: 'empty', label: '待同步课堂', text: byId('history-empty').textContent}]);
      const buttons = new Map([...byId('saved-sessions').querySelectorAll('button[data-resume]')].map(node => [node.dataset.resume, node]));
      const size = entries.length > 8 ? 6 : 8, pages = Math.ceil(entries.length / size);
      this.historyPage = lastOpened >= 0 ? Math.floor(lastOpened / size) : clamp(this.historyPage, pages - 1);
      const first = this.historyPage * size;
      const visible = entries.slice(first, first + size);
      const today = new Date().toDateString();
      const showDate = visible.some(({session}) => new Date(session.startedAt).toDateString() !== today);
      let focusId;
      const items = visible.map(({session, reviewError}) => {
        const node = buttons.get(session.id);
        if (!this.journalNumbers.has(session.id)) this.journalNumbers.set(session.id, ++this.journalNumber);
        const id = 'lesson-' + this.journalNumbers.get(session.id);
        if (session.id === this.historyEntry && !operation && ready(node)) focusId = id;
        const start = new Date(session.startedAt), time = clock.format(start), course = subject(session);
        const name = [course, dateTime.format(start), reviewError ? '待核对' : '待同步', '查看课堂汇总'].join('，');
        const mark = showDate ? (start.getMonth() + 1) + '/' + start.getDate() : time;
        return choice(id, showDate ? time : course, name, 'book-open', () => {
          this.historyEntry = session.id;
          node.click();
        }, () => !operation && ready(node), {mark});
      });
      if (pages > 1) items.push(...this.turnItems(this.historyPage > 0, this.historyPage + 1 < pages, delta => {
        this.historyEntry = null;
        this.historyPage += delta; this.repaint();
      }).filter(item => item.allowed()));
      return this.page('ring', '待同步课堂', items, {value: entries.length + ' 堂', hint: pages > 1 ? (this.historyPage + 1) + '/' + pages + ' 页' : '',
        key: String(this.historyPage), focusId});
    }

    summaryPage() {
      const {s, lesson, operation} = this.context;
      const status = byId('sync-status').textContent, count = s?.questions.length || 0;
      if (this.step.view === 'status') {
        const note = byId('feedback');
        const details = [s && subject(s), s && dateTime.format(s.startedAt), status,
          note.matches('.warning,.error') && note.textContent !== status && note.textContent].filter(Boolean);
        return this.read([{id: 'status', label: '本堂记录', text: details.join('\n')}]);
      }
      if (this.step.view === 'record' && count) return this.recordPage();
      const items = [];
      if (count) items.push(choice('records', '逐题', '逐题查看正式作答汇总', 'book-open', () => this.enter('record')));
      items.push(choice('status', '本堂', '查看本堂课时间和完整同步状态', 'info', () => this.enter('status')));
      if (lesson.needsSync) items.push(button('sync', 'sync', '重试', '重试同步并核对本机记录', 'rotate-ccw', !operation));
      items.push(button('return-setup', 'setup', '开课页', '返回开课页', 'monitor', !operation));
      let hint = lesson.needsSync ? '本机已存 · 待同步' : '已同步';
      if (status.startsWith('待核对')) hint = '待核对';
      else if (lesson.needsSync && byId('feedback').classList.contains('error')) hint = '同步失败';
      return this.page('ring', '课堂汇总', items, {value: count + ' 题', hint});
    }

    recordPage(fixedIndex) {
      const {s, lesson, renderDistribution} = this.context;
      const step = this.step, index = fixedIndex ?? clamp(step.index || 0, s.questions.length - 1);
      const q = s.questions[index];
      const page = this.chartPage(lesson.records[index].bars || []);
      // Ended journals are immutable. A sync poll can replace the journal object
      // without changing its official round or the teacher's position in the records.
      const cacheKey = JSON.stringify([s.id, s.seq, q.id, page.index]);
      if (this.recordKey !== cacheKey) {
        const model = window.CardQuizModel, official = model.officialRound(q);
        const counts = official && model.roundSummary(s, official);
        this.record ??= document.createElement('article');
        this.record.className = 'disc-record';
        this.record.setAttribute('aria-label', '第 ' + (index + 1) + ' 题正式作答');
        this.record.replaceChildren();
        const chart = document.createElement('div');
        chart.className = 'distribution';
        chart.classList.toggle('multiple', q.type === 'multiple');
        if (counts) {
          const participation = document.createElement('p');
          participation.className = 'disc-record-count';
          participation.textContent = '已答 ' + counts.received + (counts.participantCount === undefined ? ' / ' + counts.expected : '') + ' 人';
          chart.setAttribute('aria-label', '匿名分布，按 ' + counts.received + ' 位完整作答者统计');
          chart.innerHTML = renderDistribution(q, counts, page.rows);
          this.record.append(participation, chart);
          if (counts.received) {
            const grade = document.createElement('p');
            grade.className = 'disc-record-grade';
            grade.textContent = counts.correct === null ? '未设标准答案' : '已答正确 ' + counts.correct + ' / ' + counts.received + ' 人';
            this.record.append(grade);
          }
        } else {
          const empty = document.createElement('strong');
          empty.className = 'distribution-empty';
          empty.textContent = '无正式收答';
          chart.append(empty);
          this.record.append(chart);
        }
        this.recordKey = cacheKey;
      }
      if (!this.record.isConnected) document.body.append(this.record);
      const turns = fixedIndex != null ? page.turns : this.turnItems(index > 0, index + 1 < s.questions.length, delta => {
        step.index = index + delta; step.part = 0; this.repaint();
      }, ['上一题', '下一题'], ['查看上一题的正式作答', '查看下一题的正式作答']).map((item, direction) =>
        page.turns[direction]?.allowed() ? page.turns[direction] : item);
      return this.page('reader', '第 ' + (index + 1) + ' 题 · ' + kinds[q.type] + page.suffix, turns,
        {surface: 'record', key: index + '/' + page.index});
    }

    turnItems(previous, next, turn, labels = ['上页', '下页'], names = ['上一页', '下一页']) {
      return [choice('previous', labels[0], names[0], 'arrow-left', () => turn(-1), () => previous),
        choice('next', labels[1], names[1], 'arrow-right', () => turn(1), () => next)];
    }

    // Each field starts a fresh page. The browser lays long text into equal-width columns
    // using the real font and viewport, so newlines, mixed scripts and large text survive.
    showField(field) {
      if (!this.reader) {
        this.reader = document.createElement('article');
        this.reader.className = 'disc-reader';
        this.viewport = document.createElement('div');
        this.viewport.className = 'disc-viewport';
        this.columns = document.createElement('div');
        this.columns.className = 'disc-columns';
        this.viewport.append(this.columns);
        this.reader.append(this.viewport);
        this.resize = new ResizeObserver(() => {
          if (this.isCurrent() && document.body.dataset.quizDisc === 'reading' && this.viewport.clientWidth &&
              (this.width !== this.viewport.clientWidth || this.height !== this.viewport.clientHeight)) this.repaint();
        });
        this.resize.observe(this.viewport);
      }
      const parent = this.context.dialog || document.body;
      if (this.reader.parentElement !== parent) parent.append(this.reader);
      document.body.dataset.quizDisc = 'reading';
      const title = field.title || field.label;
      this.reader.setAttribute('aria-label', title);
      const content = field.picture || field.text;
      const width = this.viewport.clientWidth, height = this.viewport.clientHeight;
      const changed = !this.columns.firstChild || this.content !== content || field.alert && field.alert !== this.columns.firstChild;
      if (changed) {
        const node = field.alert || document.createElement(field.picture ? 'img' : 'p');
        if (field.picture) { node.alt = '题目配图'; node.src = field.picture; }
        else if (!field.alert) node.textContent = field.text;
        if (node !== this.columns.firstChild) this.columns.replaceChildren(node);
        this.content = content;
      }
      if (changed || this.width !== width || this.height !== height) {
        this.width = width;
        this.height = height;
        this.parts = width && height ? Math.max(1, Math.ceil(this.columns.scrollWidth / width)) : 1;
      }
      return this.parts;
    }

    read(fields, fixed = []) {
      if (!fields.length) fields = [{id: 'empty', label: '课堂记录', text: '暂无题目'}];
      const step = this.step;
      const i = Math.max(0, fields.findIndex(field => field.id === step.field));
      const field = fields[i], title = field.title || field.label;
      const parts = this.showField(field);
      const part = clamp(step.part ?? 0, parts - 1);
      if (this.width && this.height) { step.part = part; this.viewport.scrollLeft = part * this.width; }
      step.field = field.id;
      const previous = part > 0 || i > 0, next = part < parts - 1 || i < fields.length - 1;
      const turn = delta => {
        const within = part + delta;
        if (within >= 0 && within < parts) step.part = within;
        else { step.field = fields[i + delta].id; step.part = delta < 0 ? Number.MAX_SAFE_INTEGER : 0; }
        this.repaint();
      };
      const actions = fixed.filter(Boolean);
      if (previous || next) {
        if (actions.length) {
          // Leave the other arc in place for reveal or confirmation throughout the text.
          actions.unshift(choice('page', next ? '下页' : '首页', next ? '阅读下一页' : '返回阅读首页', 'arrow-right', () => {
            if (next) turn(1);
            else { step.field = fields[0].id; step.part = 0; this.repaint(); }
          }));
        } else {
          const previousField = fields[i - 1], nextField = fields[i + 1];
          const names = [part ? '上一页' : previousField?.title || previousField?.label || '上一页',
            part + 1 < parts ? '下一页' : nextField?.title || nextField?.label || '下一页'];
          actions.push(...this.turnItems(previous, next, turn, ['上页', '下页'], names));
        }
      }
      const suffix = parts > 1 ? ' ' + (part + 1) + '/' + parts : '';
      return this.page('reader', title + suffix, actions, {surface: 'reading', key: field.id + '/' + part});
    }
  }

  window.CardQuizDisc = CardQuizDisc;
})();

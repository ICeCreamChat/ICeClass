'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const reports = require('../../lib/report-data');
const SESSION_PAGE_SIZE = 10;

Page({
  data: {
    classes: [], classNames: [], classIndex: 0, classId: '',
    subjectNames: reports.SUBJECTS.map(s => s.name), subjectIndex: 0, subjectId: '',
    loading: false, detailLoading: false, exporting: false, loaded: false,
    error: '', sessionExpired: false, notice: '',
    sessionRows: [], sessionPage: 1, hasNextPage: false, sessionTotal: 0, sessionId: '',
    detail: null, question: null, questionNames: [], questionIndex: 0,
    round: null, roundNames: [], roundIndex: 0,
    answerRows: [], answerPage: 1, answerPages: 1, answerTotal: 0,
    studentRows: [], studentPage: 1, studentPages: 1, studentTotal: 0
  },

  onShow() {
    this._visible = true;
    if (!ui.requireLogin()) {
      this.onHide();
      this.clearResults();
      return;
    }
    return this.load(true);
  },
  onHide() {
    this._visible = false;
    reports.nextRead(this);
    this.setData({ loading: false, detailLoading: false, exporting: false });
  },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() {
    try { await this.load(true); }
    finally { wx.stopPullDownRefresh(); }
  },
  relogin() { ui.relogin(); },

  clearDetail() {
    this._detail = null;
    this.setData({ detail: null, question: null, round: null, questionNames: [], roundNames: [],
      answerRows: [], answerTotal: 0, studentRows: [], studentTotal: 0, detailLoading: false });
  },
  clearResults() {
    this._sessionCursors = [null];
    this.clearDetail();
    this.setData({ sessionRows: [], sessionId: '', sessionPage: 1, hasNextPage: false, sessionTotal: 0, loaded: false });
  },
  async load(refreshClasses = false, page = this.data.sessionPage) {
    if (!this._visible || this.data.exporting) return;
    if (!api.getUser()) {
      this.setData({ sessionExpired: true });
      return;
    }
    const selected = this.data.sessionId, previousClass = this.data.classId;
    const cursors = this._sessionCursors || [null];
    const generation = reports.nextRead(this);
    if (refreshClasses) this.clearResults();
    this.setData({ loading: true, error: '', sessionExpired: false, notice: '' });
    try {
      if (refreshClasses) await ui.loadClasses(reports.classReadTarget(this, generation), () => reports.currentRead(this, generation));
      if (!reports.currentRead(this, generation)) return;
      const { classId, subjectId } = this.data;
      if (!classId) return;
      if (classId !== previousClass) page = 1;
      const query = ui.query({ classId, subjectId, limit: SESSION_PAGE_SIZE, ...cursors[page - 1] });
      const payload = await api.request('/api/card-quiz/sessions?' + query, { method: 'GET' });
      if (!reports.currentRead(this, generation)) return;
      const formatted = reports.paperSessions(payload, ui.formatTime);
      if (payload.sessions.some(s => s.classId !== classId || subjectId && s.subjectId !== subjectId))
        throw new Error('课堂班级或学科与当前选择不一致，请重新载入。');
      // The shared formatter sorts tied IDs by locale. Keep the server's ID order across page boundaries.
      const byId = new Map(formatted.map(s => [s.id, s]));
      const sessionRows = payload.sessions.map(s => byId.get(s.id)).reverse();
      this._sessionCursors = cursors.slice(0, page);
      if (payload.nextCursor) this._sessionCursors.push(payload.nextCursor);
      this.setData({ sessionRows, sessionPage: page, sessionId: classId === previousClass ? selected : '', hasNextPage: !!payload.nextCursor,
        sessionTotal: payload.total ?? sessionRows.length, loaded: true, loading: false });
      if (this.data.sessionId) await this.loadSession(this.data.sessionId);
    } catch (error) {
      if (reports.currentRead(this, generation)) {
        if (error.status === 401 || error.status === 403) this.clearResults();
        ui.fail(this, error);
      }
    } finally {
      if (reports.currentRead(this, generation)) this.setData({ loading: false });
    }
  },
  async onClassChange(event) {
    if (this.data.exporting) return;
    reports.nextRead(this);
    this.clearResults();
    ui.chooseClass(this, Number(event.detail.value));
    return this.load();
  },
  onSubjectChange(event) {
    if (this.data.exporting) return;
    const index = Number(event.detail.value), subject = reports.SUBJECTS[index];
    if (!subject) return;
    reports.nextRead(this);
    this.clearResults();
    this.setData({ subjectIndex: index, subjectId: subject.id });
    return this.load();
  },
  reload() { return this.load(true); },
  onSessionPage(event) {
    if (!this.data.loaded || this.data.loading || this.data.exporting || this.data.sessionId) return;
    const page = this.data.sessionPage + Number(event.currentTarget.dataset.step);
    if (page >= 1 && page <= this._sessionCursors.length) return this.load(false, page);
  },
  openSession(event) { return this.loadSession(event.currentTarget.dataset.id); },
  async loadSession(id) {
    if (!this._visible || this.data.loading || this.data.exporting || !id) return;
    if (id !== this.data.sessionId && !this.data.sessionRows.some(s => s.id === id)) return;
    const generation = reports.nextRead(this), { classId, subjectId } = this.data;
    this.clearDetail();
    this.setData({ sessionId: id, loading: false, detailLoading: true, error: '', notice: '' });
    try {
      const payload = await api.request('/api/card-quiz/sessions/' + encodeURIComponent(id), { method: 'GET' });
      if (!reports.currentRead(this, generation)) return;
      const detail = reports.paperDetail(payload, ui.formatTime);
      if (detail.header.classId !== classId || detail.header.id !== id || subjectId && payload.session.subjectId !== subjectId)
        throw new Error('课堂与当前选择不一致，请重新载入。');
      this._detail = detail;
      this.setData({ detail: detail.header, questionNames: detail.questions.map(q => '第 ' + q.number + ' 题 · ' + q.typeName) });
      this.selectQuestion(0);
      this.showStudents(1);
    } catch (error) {
      if (reports.currentRead(this, generation)) ui.fail(this, error);
    } finally {
      if (reports.currentRead(this, generation)) this.setData({ detailLoading: false });
    }
  },
  closeSession() {
    if (this.data.exporting) return;
    reports.nextRead(this);
    this.clearDetail();
    this.setData({ sessionId: '', error: '', notice: '' });
  },
  selectQuestion(index) {
    const question = this._detail && this._detail.questions[index];
    if (!question) return;
    const { rounds, ...header } = question;
    this.setData({ question: header, questionIndex: index, roundNames: rounds.map(r => r.label) });
    if (rounds.length) this.selectRound(rounds.length - 1);
    else this.setData({ round: null, roundIndex: 0, answerRows: [], answerTotal: 0 });
  },
  onQuestionChange(event) { this.selectQuestion(Number(event.detail.value)); },
  selectRound(index) {
    const question = this._detail && this._detail.questions[this.data.questionIndex];
    const round = question && question.rounds[index];
    if (!round) return;
    const { students, ...header } = round;
    this.setData({ round: header, roundIndex: index });
    this.showAnswers(1);
  },
  onRoundChange(event) { this.selectRound(Number(event.detail.value)); },
  showAnswers(requestedPage) {
    const question = this._detail && this._detail.questions[this.data.questionIndex];
    const round = question && question.rounds[this.data.roundIndex];
    const result = reports.paginate(round ? round.students : [], requestedPage);
    this.setData({ answerRows: result.rows, answerPage: result.page, answerPages: result.pages, answerTotal: result.total });
  },
  onAnswerPage(event) { this.showAnswers(this.data.answerPage + Number(event.currentTarget.dataset.step)); },
  showStudents(requestedPage) {
    const result = reports.paginate(this._detail ? this._detail.students : [], requestedPage);
    this.setData({ studentRows: result.rows, studentPage: result.page, studentPages: result.pages, studentTotal: result.total });
  },
  onStudentPage(event) { this.showStudents(this.data.studentPage + Number(event.currentTarget.dataset.step)); },

  connectClassroom(event) {
    if (!this._visible || this.data.exporting || this.data.loading || !this.data.classId || !ui.requireLogin()) return;
    const sessionId = event && event.currentTarget && event.currentTarget.dataset.id || '';
    if (sessionId && !this.data.sessionRows.some(session => session.id === sessionId && session.statusText === '尚未结束')) return;
    wx.navigateTo({ url: '/pages/paper-round/index?' + ui.query({ classId: this.data.classId, sessionId }) });
  },
  openCards() {
    if (!this._visible || this.data.exporting || this.data.loading || !this.data.classId || !ui.requireLogin()) return;
    wx.navigateTo({ url: '/pages/paper-cards/index?' + ui.query({ classId: this.data.classId }) });
  },
  async exportReport() {
    if (!this._visible || this.data.loading || this.data.detailLoading || this.data.exporting || !this.data.classId) return;
    const generation = reports.nextRead(this);
    this.setData({ exporting: true, error: '', notice: '' });
    try {
      const path = '/api/card-quiz/export?' + ui.query({ classId: this.data.classId, subjectId: this.data.subjectId });
      const filePath = await api.download(path);
      if (!reports.currentRead(this, generation)) return;
      const shared = await reports.shareFile(wx, filePath, '纸卡答题明细.csv');
      if (reports.currentRead(this, generation)) this.setData({ notice: shared ? '已完成文件分享。' : '已取消分享。' });
    } catch (error) {
      if (reports.currentRead(this, generation)) ui.fail(this, error);
    } finally {
      if (reports.currentRead(this, generation)) this.setData({ exporting: false });
    }
  }
});

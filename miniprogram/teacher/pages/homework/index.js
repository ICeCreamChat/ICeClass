'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const reports = require('../../lib/report-data');

Page({
  data: {
    classes: [], classNames: [], classIndex: 0, classId: '', allScope: false,
    termNames: ['全部学期'], termIndex: 0, termId: '', terms: [],
    subjectNames: reports.SUBJECTS.map(s => s.name), subjectIndex: 0, subjectId: '',
    groupNames: ['按作业', '按学生'], groupIndex: 0, group: 'assignments',
    start: '', end: '', loading: false, exporting: false, loaded: false,
    error: '', sessionExpired: false, notice: '', report: null,
    page: 1, pages: 1, total: 0
  },

  onShow() {
    this._visible = true;
    if (!ui.requireLogin()) { this.onHide(); this.clearReport(); return; }
    if (!this.data.start) this.setData({ start: ui.dateISO(), end: ui.dateISO() });
    return this.load(true);
  },
  onHide() {
    this._visible = false;
    reports.nextRead(this);
    this.setData({ loading: false, exporting: false });
  },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() {
    try { await this.load(true); }
    finally { wx.stopPullDownRefresh(); }
  },
  relogin() { ui.relogin(); },
  clearReport() { this.setData({ report: null, page: 1, pages: 1, total: 0, loaded: false }); },
  params(page) {
    const data = this.data;
    const params = { classId: data.allScope ? '' : data.classId, termId: data.allScope ? '' : data.termId, subjectId: data.subjectId,
      start: data.start, end: data.end, group: data.group };
    if (page !== undefined) { params.page = page; params.pageSize = 30; }
    return params;
  },
  async load(refreshClasses = false, requestedPage = 1) {
    if (!this._visible || this.data.exporting) return;
    if (!api.getUser()) { this.setData({ sessionExpired: true }); return; }
    const generation = reports.nextRead(this);
    this.clearReport();
    this.setData({ loading: true, error: '', sessionExpired: false, notice: '' });
    try {
      if (refreshClasses) await ui.loadClasses(reports.classReadTarget(this, generation), () => reports.currentRead(this, generation));
      if (!reports.currentRead(this, generation)) return;
      const classId = this.data.classId;
      if (!this.data.classes.length) return;
      if (!this.data.allScope && !classId) return;
      if (!this.data.allScope && (refreshClasses || this._profileClassId !== classId)) {
        const profile = await api.request('/api/homework/classes/' + encodeURIComponent(classId) + '/profile', { method: 'GET' });
        if (!reports.currentRead(this, generation)) return;
        if (profile.classId !== classId || !profile.value || !Array.isArray(profile.value.terms)) {
          throw new Error('班级学期响应不完整，请重新载入。');
        }
        const terms = [{ id: '', label: '全部学期' }].concat(profile.value.terms.map(t => ({ id: t.id, label: t.label })));
        const index = terms.findIndex(t => t.id === this.data.termId);
        const termIndex = index < 0 ? 0 : index;
        this._profileClassId = classId;
        this.setData({ terms, termNames: terms.map(t => t.label), termIndex, termId: terms[termIndex].id });
      }
      const error = reports.dateRangeError(this.data.start, this.data.end, 365);
      if (error) throw new Error(error);
      const payload = await api.request('/api/homework/report?' + ui.query(this.params(requestedPage)), { method: 'GET' });
      if (!reports.currentRead(this, generation)) return;
      const allowedClassIds = new Set(this.data.classes.map(item => item.id));
      if (payload.rows && payload.rows.some(row => this.data.allScope ? !allowedClassIds.has(row.classId) : row.classId !== classId))
        throw new Error('作业班级与当前选择不一致，请重新查询。');
      const report = reports.homeworkReport(payload, ui.formatTime);
      if (report.group !== this.data.group) throw new Error('统计方式与当前选择不一致，请重新查询。');
      this.setData({ report, loaded: true, page: report.page, pages: report.pages, total: report.total });
    } catch (error) {
      if (reports.currentRead(this, generation)) ui.fail(this, error);
    } finally {
      if (reports.currentRead(this, generation)) this.setData({ loading: false });
    }
  },
  onClassChange(event) {
    if (this.data.exporting) return;
    reports.nextRead(this);
    this._profileClassId = '';
    this.clearReport();
    this.setData({ allScope: false, terms: [], termNames: ['全部学期'], termIndex: 0, termId: '' });
    ui.chooseClass(this, Number(event.detail.value));
    return this.load();
  },
  allClasses() {
    if (this.data.exporting || !this.data.classes.length) return;
    this._profileClassId = '';
    this.changed({ allScope: true, terms: [{ id: '', label: '全部学期' }], termNames: ['全部学期'], termIndex: 0, termId: '' });
    return this.load();
  },
  singleClass() {
    if (this.data.exporting || !this.data.classes.length) return;
    this._profileClassId = '';
    this.changed({ allScope: false, terms: [], termNames: ['全部学期'], termIndex: 0, termId: '' });
    return this.load();
  },
  manageHomework() {
    if (this.data.exporting || !ui.requireLogin()) return;
    wx.navigateTo({ url: '/pages/homework-manage/index' + (this.data.allScope || !this.data.classId ? '' : '?classId=' + encodeURIComponent(this.data.classId)) });
  },
  changed(patch) {
    reports.nextRead(this);
    this.clearReport();
    this.setData({ ...patch, loading: false, error: '', notice: '筛选条件已更改，请查询。' });
  },
  onDateChange(event) {
    const field = event.currentTarget.dataset.field;
    if (!this.data.exporting && ['start', 'end'].includes(field)) this.changed({ [field]: event.detail.value });
  },
  onTermChange(event) {
    if (this.data.exporting) return;
    const index = Number(event.detail.value), term = this.data.terms[index];
    if (term) this.changed({ termIndex: index, termId: term.id });
  },
  onSubjectChange(event) {
    if (this.data.exporting) return;
    const index = Number(event.detail.value), subject = reports.SUBJECTS[index];
    if (subject) this.changed({ subjectIndex: index, subjectId: subject.id });
  },
  onGroupChange(event) {
    if (this.data.exporting) return;
    const index = Number(event.detail.value);
    if (index === 0 || index === 1) this.changed({ groupIndex: index, group: index ? 'students' : 'assignments' });
  },
  queryReport() { if (!this.data.loading) return this.load(); },
  previousPage() { if (!this.data.loading && this.data.page > 1) return this.load(false, this.data.page - 1); },
  nextPage() { if (!this.data.loading && this.data.page < this.data.pages) return this.load(false, this.data.page + 1); },

  async exportReport() {
    if (!this._visible || this.data.loading || this.data.exporting || !this.data.report || !this.data.classes.length) return;
    const generation = reports.nextRead(this);
    this.setData({ exporting: true, error: '', notice: '' });
    try {
      const filePath = await api.download('/api/homework/export?' + ui.query(this.params()));
      if (!reports.currentRead(this, generation)) return;
      const shared = await reports.shareFile(wx, filePath, '作业统计-' + this.data.start + '-' + this.data.end + '.csv');
      if (reports.currentRead(this, generation)) this.setData({ notice: shared ? '已完成文件分享。' : '已取消分享。' });
    } catch (error) {
      if (reports.currentRead(this, generation)) ui.fail(this, error);
    } finally {
      if (reports.currentRead(this, generation)) this.setData({ exporting: false });
    }
  }
});

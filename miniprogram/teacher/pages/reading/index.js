'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const reports = require('../../lib/report-data');

Page({
  data: {
    classes: [], classNames: [], classIndex: 0, classId: '', start: '', end: '',
    loading: false, exporting: false, loaded: false, error: '', sessionExpired: false, notice: '',
    report: null, dailyRows: [], dailyPage: 1, dailyPages: 1, dailyTotal: 0, canManageReading: false
  },
  onShow() {
    this._visible = true;
    if (!ui.requireLogin()) { this.onHide(); this.clearReport(); return; }
    const user = api.getUser();
    this.setData({ canManageReading: Boolean(['principal', 'superadmin'].includes(user.role) && user.permissions && user.permissions.schoolAdmin === true) });
    if (!this.data.start) this.setData({ start: ui.dateISO(-6), end: ui.dateISO() });
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
  openSettings() {
    const user = api.getUser();
    if (this._visible && !this.data.exporting && !this.data.sessionExpired && user &&
        ['principal', 'superadmin'].includes(user.role) && user.permissions && user.permissions.schoolAdmin === true) {
      wx.navigateTo({ url: '/pages/reading-settings/index' });
    }
  },
  clearReport() {
    this._daily = [];
    this.setData({ report: null, dailyRows: [], dailyPage: 1, dailyPages: 1, dailyTotal: 0, loaded: false });
  },
  params() { return { classId: this.data.classId, start: this.data.start, end: this.data.end }; },
  async load(refreshClasses = false) {
    if (!this._visible || this.data.exporting) return;
    if (!api.getUser()) { this.setData({ sessionExpired: true }); return; }
    const generation = reports.nextRead(this);
    this.clearReport();
    this.setData({ loading: true, error: '', sessionExpired: false, notice: '' });
    try {
      if (refreshClasses) await ui.loadClasses(reports.classReadTarget(this, generation), () => reports.currentRead(this, generation));
      if (!reports.currentRead(this, generation) || !this.data.classId) return;
      const classId = this.data.classId;
      const error = reports.dateRangeError(this.data.start, this.data.end, 366);
      if (error) throw new Error(error);
      const payload = await api.request('/api/reading/report?' + ui.query(this.params()), { method: 'GET' });
      if (!reports.currentRead(this, generation)) return;
      if (payload.rows && payload.rows.some(row => row.classId !== classId)) throw new Error('早读班级与当前选择不一致，请重新查询。');
      const report = reports.readingReport(payload, ui.formatTime);
      this._daily = report.daily;
      this.setData({ report: report.rows[0] || null, loaded: true });
      this.showDaily(1);
    } catch (error) {
      if (reports.currentRead(this, generation)) ui.fail(this, error);
    } finally {
      if (reports.currentRead(this, generation)) this.setData({ loading: false });
    }
  },
  onClassChange(event) {
    if (this.data.exporting) return;
    reports.nextRead(this);
    this.clearReport();
    ui.chooseClass(this, Number(event.detail.value));
    return this.load();
  },
  onDateChange(event) {
    const field = event.currentTarget.dataset.field;
    if (this.data.exporting || !['start', 'end'].includes(field)) return;
    reports.nextRead(this);
    this.clearReport();
    this.setData({ [field]: event.detail.value, loading: false, error: '', notice: '筛选条件已更改，请查询。' });
  },
  queryReport() { if (!this.data.loading) return this.load(); },
  showDaily(requestedPage) {
    const result = reports.paginate(this._daily || [], requestedPage);
    this.setData({ dailyRows: result.rows, dailyPage: result.page, dailyPages: result.pages, dailyTotal: result.total });
  },
  onDailyPage(event) {
    if (!this.data.exporting) this.showDaily(this.data.dailyPage + Number(event.currentTarget.dataset.step));
  },

  async exportReport() {
    if (!this._visible || this.data.loading || this.data.exporting || !this.data.report || !this.data.classId) return;
    const generation = reports.nextRead(this);
    this.setData({ exporting: true, error: '', notice: '' });
    try {
      const filePath = await api.download('/api/reading/export?' + ui.query({ ...this.params(), format: 'xlsx' }));
      if (!reports.currentRead(this, generation)) return;
      const shared = await reports.shareFile(wx, filePath, '早读统计-' + this.data.start + '-' + this.data.end + '.xlsx');
      if (reports.currentRead(this, generation)) this.setData({ notice: shared ? '已完成文件分享。' : '已取消分享。' });
    } catch (error) {
      if (reports.currentRead(this, generation)) ui.fail(this, error);
    } finally {
      if (reports.currentRead(this, generation)) this.setData({ exporting: false });
    }
  }
});

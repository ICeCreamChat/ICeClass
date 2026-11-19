'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const settings = require('../../lib/settings-data');

Page({
  data: { allowed: false, loading: false, busy: false, error: '', status: '', sessionExpired: false,
    devices: [], rows: [], classes: [], search: '', filterIndex: 0, filters: ['全部设备', '在线设备', '离线设备', '已停用设备'],
    draft: null, editName: '', classChoices: [], classNames: [], classIndex: 0, dirty: false, conflict: false, uncertain: false },
  onShow() {
    this._visible = true;
    if (!ui.requireLogin()) { settings.invalidate(this); return; }
    this.setData({ allowed: settings.manager(api.getUser()), sessionExpired: false });
    settings.dirty(ui, this.data.dirty);
    if (!this.data.allowed || this.data.busy || this.data.draft || this.data.uncertain) return;
    return this.load();
  },
  onHide() { this.leave(); },
  onUnload() { this.leave(); },
  leave() {
    this._visible = false;
    settings.invalidate(this);
    this.setData({ loading: false, ...(this._writeStarted ? { uncertain: true, status: '操作期间离开了页面，请重新载入核对结果。草稿已保留。' } : {}) });
    settings.dirty(ui, false);
  },
  relogin() { ui.relogin(); },
  async onPullDownRefresh() {
    try { if (ui.requireLogin()) await this.refresh(); }
    finally { wx.stopPullDownRefresh(); }
  },
  async load() {
    if (this.data.busy || !settings.manager(api.getUser()) || !this._visible) return;
    const token = settings.begin(this, api);
    this.setData({ loading: true, error: '' });
    try {
      const [devices, classes] = await Promise.all([
        api.request('/api/devices', { method: 'GET' }), api.request('/api/classes', { method: 'GET' })
      ]);
      if (!settings.current(this, token, api)) return;
      const rows = settings.devicesFrom(devices).map(row => ({ ...row, seenLabel: ui.formatTime(row.last_seen_at),
        verifiedLabel: row.verified_at ? `已核实 · ${ui.formatTime(row.verified_at)}` : '待核实',
        addressesLabel: row.local_addresses.join('、') || '尚未上报' }));
      this._original = null;
      this.setData({ devices: rows, classes: settings.classesFrom(classes), draft: null, dirty: false,
        conflict: false, uncertain: false, sessionExpired: false });
      settings.dirty(ui, false);
      this.renderRows();
    } catch (error) {
      if (settings.current(this, token, api, true)) ui.fail(this, error);
    } finally {
      if (settings.current(this, token, api, true)) this.setData({ loading: false });
    }
  },
  async refresh() {
    if (this.data.busy || !settings.manager(api.getUser()) || !this._visible) return;
    const token = settings.begin(this, api);
    this.setData({ busy: true, loading: false });
    let reload = false;
    try {
      reload = !this.data.draft && !this.data.uncertain || await ui.confirm('重新载入设备',
        '将读取最新设备绑定；当前编辑草稿会被放弃。结果不明确的操作不会自动重发。', '重新载入');
      reload = reload && settings.current(this, token, api);
    } finally { this.setData({ busy: false }); }
    if (reload) return this.load();
  },
  renderRows() {
    const search = this.data.search.trim().toLowerCase(), filter = this.data.filterIndex;
    this.setData({ rows: this.data.devices.filter(row =>
      (!filter || filter === 1 && row.enabled && row.online || filter === 2 && row.enabled && !row.online || filter === 3 && !row.enabled) &&
      `${row.class_name} ${row.name} ${row.computer_name} ${row.device_code} ${row.binding_note} ${row.addressesLabel}`.toLowerCase().includes(search)) });
  },
  inputSearch(event) { if (!this.data.busy) { this.setData({ search: event.detail.value }); this.renderRows(); } },
  changeFilter(event) { if (!this.data.busy) { this.setData({ filterIndex: Number(event.detail.value) }); this.renderRows(); } },
  openDevice(event) {
    if (this.data.busy || this.data.loading || this.data.sessionExpired || this.data.uncertain || !settings.manager(api.getUser())) return;
    if (this.data.draft) { ui.toast('请先完成或取消当前设备编辑。'); return; }
    const row = this.data.devices.find(item => item.id === event.currentTarget.dataset.id);
    if (!row) return;
    const choices = this.data.classes.filter(item => item.enabled || item.id === row.class_id);
    this._original = row;
    this._initialDraft = settings.deviceDraft(row);
    this.setData({ draft: settings.copy(this._initialDraft), editName: `${row.class_name} · ${row.name}`, classChoices: choices,
      classNames: choices.map(item => item.name + (item.enabled ? '' : '（已停用）')), classIndex: Math.max(0, choices.findIndex(item => item.id === row.class_id)),
      dirty: false, conflict: false, error: '', status: '' });
  },
  updateDraft(patch) {
    if (this.data.busy || this.data.loading || this.data.sessionExpired || !this.data.draft) return;
    const draft = { ...this.data.draft, ...patch }, dirty = JSON.stringify(draft) !== JSON.stringify(this._initialDraft);
    this.setData({ draft, dirty }); settings.dirty(ui, dirty);
  },
  inputField(event) {
    const field = event.currentTarget.dataset.field;
    if (['name', 'note'].includes(field)) this.updateDraft({ [field]: event.detail.value });
  },
  changeClass(event) {
    if (this.data.busy || this.data.loading || this.data.sessionExpired) return;
    const index = Number(event.detail.value), row = this.data.classChoices[index];
    if (row) { this.setData({ classIndex: index }); this.updateDraft({ classId: row.id, verified: false }); }
  },
  changeFlags(event) {
    const values = event.detail.value;
    this.updateDraft({ enabled: values.includes('enabled'), verified: values.includes('verified') });
  },
  async cancelEdit() {
    if (this.data.busy || !this.data.draft) return;
    const token = settings.begin(this, api);
    this.setData({ busy: true });
    try {
      if (this.data.dirty && !await ui.confirm('放弃设备草稿', `将放弃“${this.data.editName}”尚未提交的更改。`, '放弃草稿')) return;
      if (!settings.current(this, token, api)) return;
      this._original = null;
      this.setData({ draft: null, dirty: false }); settings.dirty(ui, false);
    } finally { this.setData({ busy: false }); }
  },
  async save() {
    if (this.data.busy || this.data.loading || !this.data.dirty || this.data.conflict || this.data.uncertain ||
      this.data.sessionExpired || !this.data.draft || !settings.manager(api.getUser()) || !this._visible) return;
    let payload;
    try { payload = settings.devicePayload(this.data.draft, this._original, this.data.classes); }
    catch (error) { ui.fail(this, error); return; }
    if (!Object.keys(payload).length) { ui.toast('设备信息没有变化。'); return; }
    const targetClass = this.data.classes.find(row => row.id === this.data.draft.classId);
    const token = settings.begin(this, api), original = this._original;
    this.setData({ busy: true, error: '', status: '' });
    let saved = false;
    try {
      if (!await ui.confirm('确认修改教室电脑', settings.deviceSummary(original, payload, targetClass.name), '确认修改') ||
        !settings.current(this, token, api)) return;
      this._writeStarted = true;
      await settings.updateDevice(api.request, original, payload, targetClass.name, () => settings.current(this, token, api));
      if (!settings.current(this, token, api)) return;
      saved = true;
      this.setData({ draft: null, dirty: false, status: `“${original.name}”的设备设置已保存，请核对设备重新连接情况。` });
      settings.dirty(ui, false);
    } catch (error) {
      if (error.code !== 'session_changed' && settings.current(this, token, api, true)) {
        ui.fail(this, error);
        this.setData({ conflict: error.status === 409, uncertain: Boolean(error.ambiguous) });
      }
    } finally {
      this._writeStarted = false;
      this.setData({ busy: false });
    }
    if (saved && settings.current(this, token, api)) return this.load();
  }
});

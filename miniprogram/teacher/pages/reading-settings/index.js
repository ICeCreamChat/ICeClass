'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const settings = require('../../lib/reading-settings');

Page({
  data: {
    loaded: false, loading: false, busy: false, canEdit: false, draft: null, periods: [],
    dirty: false, conflict: false, uncertain: false, error: '', sessionExpired: false, status: '',
    config: null, checkedAt: '-', inPeriod: false
  },
  onLoad() { this._generation = 0; this._visible = false; this._owner = ''; this._entry = null; this._serial = 0; this._reloadOnIdle = false; },
  onShow() {
    this._visible = true;
    if (!ui.requireLogin()) { ++this._generation; this.setData({ loading: false, sessionExpired: true }); return; }
    const user = api.getUser();
    if (this._owner !== user.id) {
      this._entry = null; this._writing = null; this._reloadOnIdle = false;
      this.setData({ loaded: false, busy: false, draft: null, periods: [], dirty: false, conflict: false, uncertain: false, error: '', status: '', config: null });
    }
    this._owner = user.id;
    ui.setDirty(Boolean(this._entry && (this._entry.dirty || this._entry.uncertain)));
    this.setData({ canEdit: settings.canEdit(user), sessionExpired: false });
    if (!this.data.canEdit) { ++this._generation; this.setData({ loading: false, error: '仅校长或超级管理员可以维护全校早读规则。' }); return; }
    if (this.data.busy) { this._reloadOnIdle = true; return; }
    return this.load();
  },
  onHide() { this._visible = false; ++this._generation; this.setData({ loading: false }); ui.setDirty(false); },
  onUnload() { this.onHide(); },
  owns(owner) { const user = api.getUser(); return this._owner === owner && (!user || user.id === owner); },
  active(generation, owner) { return this._visible && generation === this._generation && this.owns(owner); },
  editable() {
    const user = api.getUser();
    return Boolean(this._visible && user && user.id === this._owner && settings.canEdit(user) && this.data.canEdit &&
      this._entry && this.data.loaded && !this.data.busy && !this.data.loading && !this.data.sessionExpired);
  },
  present() {
    const entry = this._entry;
    if (!entry || !this._visible) return;
    this.setData({ loaded: true, draft: entry.draft, periods: settings.periodRows(entry.draft), config: entry.profile.config,
      dirty: entry.dirty, conflict: entry.conflict, uncertain: entry.uncertain, checkedAt: ui.formatTime(entry.profile.serverTime),
      inPeriod: entry.profile.inPeriod, error: entry.error || '', status: entry.notice || '' });
    ui.setDirty(entry.dirty || entry.uncertain);
  },
  accept(response, discard = false) {
    const profile = settings.profileFrom(response);
    let entry = this._entry;
    const confirmed = entry && entry.uncertain && entry.pending && settings.signature(profile.config) === settings.signature(entry.pending);
    if (!entry || (!entry.dirty && !entry.uncertain) || discard) {
      entry = { profile, baseline: profile.config, draft: settings.draftFrom(profile.config), dirty: false, conflict: false,
        uncertain: false, pending: null, error: '', notice: entry && entry.notice || '' };
      this._entry = entry;
    } else if (confirmed) {
      // A user may continue editing after a timeout. Rebase those later edits,
      // rather than replacing them with the configuration that was just confirmed.
      Object.assign(entry, { profile, baseline: profile.config, uncertain: false, pending: null, conflict: false,
        dirty: settings.dirty(entry.draft, profile.config), error: '', notice: '已核对：上次规则已保存。' });
    } else {
      entry.profile = profile;
      entry.conflict = settings.signature(profile.config) !== settings.signature(entry.baseline);
      entry.error = entry.conflict ? '全校早读规则已被其他管理员修改。草稿已保留，请重新载入最新规则后编辑。' :
        entry.uncertain ? '上次保存结果尚未确认，请刷新核对，或重新载入最新规则后编辑。' : '';
    }
    this.present();
    return entry;
  },
  async load(discard = false) {
    if (!this._visible || this.data.busy) return;
    const user = api.getUser();
    if (!user) { this.setData({ sessionExpired: true }); return; }
    if (!settings.canEdit(user) || user.id !== this._owner) { this.setData({ canEdit: false, error: '仅校长或超级管理员可以维护全校早读规则。' }); return; }
    const generation = ++this._generation, owner = this._owner;
    this.setData({ loading: true, error: '', sessionExpired: false });
    try {
      const response = await api.request('/api/reading/settings', { method: 'GET' });
      if (!this.active(generation, owner)) return;
      this.setData({ canEdit: settings.canEdit(api.getUser()) });
      this.accept(response, discard);
    } catch (error) {
      if (this.active(generation, owner)) { if (error.status === 403) this.setData({ canEdit: false }); ui.fail(this, error); }
    } finally { if (this.active(generation, owner)) this.setData({ loading: false }); }
  },
  change(change) {
    if (!this.editable()) return;
    const entry = this._entry, draft = JSON.parse(JSON.stringify(entry.draft));
    change(draft);
    entry.draft = draft; entry.dirty = settings.dirty(draft, entry.baseline); entry.notice = '';
    this.present();
  },
  onOption(event) {
    const field = event.currentTarget.dataset.field;
    if (['enabled', 'reminderEnabled'].includes(field)) this.change(draft => { draft[field] = event.detail.value === true; });
  },
  onThreshold(event) { this.change(draft => { draft.threshold = event.detail.value; }); },
  editPeriod(event, change) {
    const key = event.currentTarget.dataset.key;
    this.change(draft => { const period = draft.periods.find(item => item.key === key); if (period) change(period); });
  },
  onDays(event) { this.editPeriod(event, period => { period.weekdays = Array.isArray(event.detail.value) ? event.detail.value.map(Number) : []; }); },
  onTime(event) {
    const field = event.currentTarget.dataset.field;
    if (['startTime', 'endTime'].includes(field)) this.editPeriod(event, period => { period[field] = event.detail.value; });
  },
  onMidnight(event) { this.editPeriod(event, period => { period.endTime = event.detail.value === true ? '24:00' : '23:59'; }); },
  onAdd() {
    if (!this.editable()) return;
    if (this._entry.draft.periods.length >= 30) { ui.fail(this, Error('早读统计时段最多 30 个。')); return; }
    this.change(draft => { draft.periods.push({ key: `draft-${++this._serial}`, weekdays: [1, 2, 3, 4, 5], startTime: '07:20', endTime: '07:50' }); });
  },
  onDelete(event) { this.change(draft => { draft.periods = draft.periods.filter(item => item.key !== event.currentTarget.dataset.key); }); },
  async onSave() {
    const entry = this._entry;
    if (!this.editable() || !entry.dirty || entry.conflict || entry.uncertain) return;
    let payload;
    try { payload = settings.payload(entry.draft); } catch (error) { ui.fail(this, error); return; }
    const owner = this._owner, generation = ++this._generation, writing = {};
    this._writing = writing; this.setData({ busy: true, error: '', status: '' });
    try {
      if (!await ui.confirm('保存全校早读规则', settings.confirmation(payload), '确认保存') || !this.active(generation, owner)) return;
      // The service has no version token. Compare before writing, without
      // pretending this GET/PUT pair provides an atomic concurrency guarantee.
      const current = settings.profileFrom(await api.request('/api/reading/settings', { method: 'GET' }));
      if (!this.active(generation, owner)) return;
      if (settings.signature(current.config) !== settings.signature(entry.baseline)) {
        this.accept(current); this.setData({ error: '全校早读规则已被其他管理员修改。未提交保存，草稿已保留，请重新载入后编辑。' }); return;
      }
      if (!settings.canEdit(api.getUser())) { this.setData({ canEdit: false }); throw Error('当前账号没有全校早读规则的编辑权限。'); }
      entry.pending = payload;
      const response = await api.request('/api/reading/settings', { method: 'PUT', data: payload });
      let profile;
      try {
        profile = settings.profileFrom(response);
        if (settings.signature(profile.config) !== settings.signature(payload)) throw Error();
      } catch (_) { throw Object.assign(Error('保存已返回，但规则结果无法核对。请先刷新查看，勿重复保存。'), { ambiguous: true }); }
      if (!this.owns(owner) || this._entry !== entry) return;
      Object.assign(entry, { profile, baseline: profile.config, draft: settings.draftFrom(profile.config), dirty: false,
        conflict: false, uncertain: false, pending: null, error: '', notice: '全校早读规则已保存，适用于所有班级。' });
      if (this._visible) { this.present(); ui.toast('早读规则已保存'); }
    } catch (error) {
      if (error.code === 'session_changed' || !this.owns(owner) || this._entry !== entry) return;
      entry.conflict = error.status === 409; entry.uncertain = error.ambiguous === true; entry.error = error.message;
      if (this._visible) { this.present(); if (error.status === 403) this.setData({ canEdit: false }); ui.fail(this, error); }
    } finally {
      if (this._writing === writing) {
        this._writing = null;
        if (this.owns(owner)) {
          this.setData({ busy: false });
          if (this._reloadOnIdle && this._visible && api.getUser()) { this._reloadOnIdle = false; await this.load(); }
        }
      }
    }
  },
  async onDiscard() {
    if (this.data.busy || this.data.loading || this.data.sessionExpired || !this.data.canEdit) return;
    const generation = this._generation, owner = this._owner;
    const confirmed = await ui.confirm('重新载入全校早读规则', '将放弃此页未保存草稿，并载入学校最新早读规则。', '重新载入');
    if (confirmed && this.active(generation, owner)) return this.load(true);
  },
  onRefresh() { return this.load(); },
  async onPullDownRefresh() { try { if (ui.requireLogin()) await this.load(); else this.setData({ sessionExpired: true }); } finally { wx.stopPullDownRefresh(); } },
  relogin() { ui.relogin(); }
});

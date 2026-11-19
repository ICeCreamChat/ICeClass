'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const classroom = require('../../lib/classroom-data');

Page({
  data: {
    periods: [], loaded: false, loading: false, busy: false, canEdit: false,
    dirty: false, conflict: false, uncertain: false, error: '', sessionExpired: false,
    status: '', activeName: '', checkedAt: '-', timezone: 'Asia/Shanghai'
  },
  onLoad() { this._generation = 0; this._visible = false; this._owner = ''; this._periods = []; this._baseline = null; this._serial = 0; },
  onShow() {
    this._visible = true;
    if (!ui.requireLogin()) { ++this._generation; return; }
    const owner = api.getUser().id;
    if (this._owner !== owner) {
      this._periods = []; this._baseline = null; this._writing = null;
      this.setData({ periods: [], loaded: false, dirty: false, busy: false, conflict: false, uncertain: false });
    }
    this._owner = owner;
    this.setData({ canEdit: Boolean(api.getUser().permissions && api.getUser().permissions.schoolAdmin === true) });
    return this.load();
  },
  onHide() { this._visible = false; ++this._generation; ui.setDirty(false); },
  onUnload() { this.onHide(); },
  active(generation, owner) { const user = api.getUser(); return this._visible && generation === this._generation && this._owner === owner && (!user || user.id === owner); },
  editable() { const user = api.getUser(); return this.data.canEdit && user && user.id === this._owner && user.permissions && user.permissions.schoolAdmin === true && !this.data.busy && !this.data.loading && !this.data.sessionExpired && this.data.loaded; },
  present() {
    this.setData({ periods: this._periods.map(period => ({
      ...period, key: period.id,
      daysText: period.weekdays.map(day => classroom.WEEKDAYS[day - 1]).join('、'),
      weekOptions: classroom.WEEKDAYS.map((label, index) => ({ label, value: String(index + 1), checked: period.weekdays.includes(index + 1) })),
      endPickerValue: period.endTime === '24:00' ? '23:59' : period.endTime
    })) });
    ui.setDirty(this.data.dirty);
  },
  accept(response) {
    // Validate the entire response before replacing the baseline or a draft.
    classroom.quietPayload(response.periods);
    this._baseline = classroom.quietSignature(response.periods);
    this._periods = classroom.clone(response.periods);
    this.setData({ loaded: true, dirty: false, conflict: false, uncertain: false, error: '' });
    this.present();
  },
  async load(discard = false) {
    if (this.data.busy) return;
    const generation = ++this._generation, owner = this._owner;
    this.setData({ loading: true, error: '', sessionExpired: false });
    try {
      const response = await api.request('/api/quiet-hours');
      if (!this.active(generation, owner)) return;
      classroom.quietPayload(response.periods);
      if (!this.data.dirty || discard) this.accept(response);
      else {
        const conflict = this._baseline !== classroom.quietSignature(response.periods);
        this.setData({ conflict, uncertain: false, error: conflict ? '学校时间表已被其他管理员修改。草稿已保留，请重新载入最新时间表后编辑。' : '' });
        this.present();
      }
      this.setData({ activeName: response.activePeriod && response.activePeriod.name || '', checkedAt: ui.formatTime(response.serverTime), timezone: response.timezone || 'Asia/Shanghai' });
    } catch (error) { if (this.active(generation, owner)) ui.fail(this, error); }
    finally { if (this.active(generation, owner)) this.setData({ loading: false }); }
  },

  edit(key, change) {
    if (!this.editable()) return;
    const draft = classroom.clone(this._periods), period = draft.find(item => item.id === key);
    if (!period) return;
    change(period); this._periods = draft;
    this.setData({ dirty: classroom.quietSignature(draft) !== this._baseline, status: '' }); this.present();
  },
  onName(event) { this.edit(event.currentTarget.dataset.key, period => { period.name = event.detail.value; }); },
  onDays(event) { this.edit(event.currentTarget.dataset.key, period => { period.weekdays = event.detail.value.map(Number); }); },
  onTime(event) {
    const field = event.currentTarget.dataset.field;
    if (!['startTime', 'endTime'].includes(field)) return;
    this.edit(event.currentTarget.dataset.key, period => { period[field] = event.detail.value; });
  },
  onMidnight(event) { this.edit(event.currentTarget.dataset.key, period => { period.endTime = event.detail.value === true ? '24:00' : '23:59'; }); },
  onAdd() {
    if (!this.editable()) return;
    if (this._periods.length >= 100) { ui.fail(this, Error('全校时间表最多支持 100 个时段。')); return; }
    this._periods.push({ id: `draft-${Date.now()}-${++this._serial}`, name: '', weekdays: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '09:00' });
    this.setData({ dirty: true, status: '' }); this.present();
  },
  onDelete(event) {
    if (!this.editable()) return;
    this._periods = this._periods.filter(item => item.id !== event.currentTarget.dataset.key);
    this.setData({ dirty: classroom.quietSignature(this._periods) !== this._baseline, status: '' }); this.present();
  },

  async onSave() {
    if (!this.editable() || !this.data.dirty || this.data.conflict || this.data.uncertain) return;
    let payload;
    try { payload = classroom.quietPayload(this._periods); } catch (error) { ui.fail(this, error); return; }
    const generation = this._generation, owner = this._owner, writing = {};
    this._writing = writing; this.setData({ busy: true, error: '', status: '' });
    try {
      const confirmed = await ui.confirm('保存全校禁言时间', classroom.quietImpact(payload.periods), '确认保存');
      if (!confirmed || !this.active(generation, owner)) return;
      // The service has no revision field for this resource. Check the last-read
      // schedule before a full replacement; do not invent an optimistic token.
      const current = await api.request('/api/quiet-hours');
      if (!this.active(generation, owner)) return;
      if (classroom.quietSignature(current.periods) !== this._baseline) {
        this.setData({ conflict: true, error: '学校时间表已被其他管理员修改。未提交保存，草稿已保留，请重新载入后编辑。' }); return;
      }
      const user = api.getUser();
      if (!user || !user.permissions || user.permissions.schoolAdmin !== true) {
        this.setData({ canEdit: false }); throw Error('当前账号没有全校禁言时间表的编辑权限。');
      }
      const saved = await api.request('/api/quiet-hours', { method: 'PUT', data: payload });
      if (this._owner !== owner) return;
      try { this.accept(saved); }
      catch (_) { throw Object.assign(Error('保存已返回，但时间表结果无法核对。请刷新查看，勿重复保存。'), { ambiguous: true }); }
      if (this.active(generation, owner)) {
        this.setData({ activeName: saved.activePeriod && saved.activePeriod.name || '', checkedAt: ui.formatTime(saved.serverTime), status: '全校禁言时间表已保存。' });
        ui.toast('全校时间表已保存');
      }
    } catch (error) {
      if (error.code !== 'session_changed' && this._owner === owner && (!api.getUser() || api.getUser().id === owner)) {
        this.setData({ uncertain: error.ambiguous === true, conflict: error.status === 409, ...(error.status === 403 ? { canEdit: false } : {}) });
        ui.fail(this, error);
      }
    } finally {
      if (this._writing === writing) { this._writing = null; if (this._owner === owner) this.setData({ busy: false }); }
    }
  },
  onRefresh() { return this.load(); },
  async onDiscard() {
    if (this.data.busy || this.data.loading) return;
    const generation = this._generation, owner = this._owner;
    const confirmed = await ui.confirm('重新载入全校时间表', '将放弃未保存草稿，并载入学校最新禁言时间表。', '重新载入');
    if (confirmed && this.active(generation, owner)) return this.load(true);
  },
  async onPullDownRefresh() { try { await this.onRefresh(); } finally { wx.stopPullDownRefresh(); } },
  relogin() { ui.relogin(); }
});

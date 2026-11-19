'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const classroom = require('../../lib/classroom-data');

Page({
  data: {
    classes: [], classNames: [], classIndex: 0, classId: '', loadedClassId: '',
    weekdays: classroom.WEEKDAYS, weekdayIndex: 0, rows: [], slots: [], devices: [],
    loaded: false, loading: false, busy: false, canEdit: false, enabled: false,
    revision: 0, updatedText: '-', weekAnchor: '', dirty: false, conflict: false,
    uncertain: false, error: '', sessionExpired: false, status: ''
  },

  onLoad() { this._generation = 0; this._visible = false; this._owner = ''; this._drafts = Object.create(null); },
  onShow() {
    this._visible = true;
    if (!ui.requireLogin()) { ++this._generation; return; }
    const owner = api.getUser().id;
    if (this._owner !== owner) {
      this._drafts = Object.create(null); this._writing = null;
      this.setData({ classes: [], classNames: [], classId: '', loadedClassId: '', loaded: false, rows: [], slots: [], devices: [], dirty: false, busy: false, canEdit: false });
    }
    this._owner = owner;
    return this.load();
  },
  onHide() { this._visible = false; ++this._generation; ui.setDirty(false); },
  onUnload() { this.onHide(); },
  active(generation, owner) { const user = api.getUser(); return this._visible && generation === this._generation && this._owner === owner && (!user || user.id === owner); },
  entry() { return this._drafts[this.data.classId]; },

  present(entry) {
    if (!entry) {
      this.setData({ loaded: false, loadedClassId: '', rows: [], slots: [], devices: [], canEdit: false, dirty: false, conflict: false, uncertain: false, error: '', status: '' });
      ui.setDirty(false); return;
    }
    const profile = entry.profile;
    const syncRevision = entry.deliveryRevision == null ? profile.revision : entry.deliveryRevision;
    this.setData({
      loaded: true, loadedClassId: profile.classId, canEdit: entry.canEdit, enabled: entry.config.enabled,
      revision: profile.revision, updatedText: ui.formatTime(profile.updatedAt), weekAnchor: entry.config.weekAnchor,
      rows: classroom.lessonRows(entry.config, this.data.weekdayIndex + 1),
      slots: [...entry.config.slots].sort((a, b) => a.start - b.start).map(slot => ({ ...slot, timeLabel: `${classroom.clock(slot.start)}-${classroom.clock(slot.end)}` })),
      syncRevision,
      devices: (entry.devices || []).map(device => ({ ...device, syncText: device.revision === syncRevision ? '已同步' : '等待同步', syncedText: ui.formatTime(device.synced_at), revisionText: device.revision == null ? '未回执' : String(device.revision) })),
      dirty: entry.dirty, conflict: entry.conflict, uncertain: entry.uncertain, error: entry.error || '', status: entry.notice || ''
    });
    ui.setDirty(entry.dirty);
  },

  async load(discard = false) {
    if (this.data.busy) return;
    const generation = ++this._generation, owner = this._owner;
    this.setData({ loading: true, error: '', sessionExpired: false });
    try {
      const response = await api.request('/api/classes');
      if (!this.active(generation, owner)) return;
      if (!Array.isArray(response.classes)) throw Error('班级列表格式异常，请重试。');
      const classes = response.classes.filter(item => item.enabled !== 0 && item.enabled !== false);
      const selected = this.data.classId || api.getClassId();
      const index = Math.max(0, classes.findIndex(item => item.id === selected));
      this.setData({ classes, classNames: classes.map(item => item.name) });
      if (!classes.length) { api.selectClass(''); this.setData({ classId: '' }); this.present(null); return; }
      const current = ui.chooseClass(this, index);
      this.present(this._drafts[current.id]);
      await this.readProfile(current.id, generation, owner, discard);
    } catch (error) { if (this.active(generation, owner)) ui.fail(this, error); }
    finally { if (this.active(generation, owner)) this.setData({ loading: false }); }
  },

  async readProfile(classId, generation, owner, discard = false) {
    try {
      const remote = await api.request('/api/island/classes/' + encodeURIComponent(classId));
      if (!this.active(generation, owner) || this.data.classId !== classId) return;
      if (remote.classId !== classId) throw Error('返回班级与当前选择不一致，请重新载入。');
      classroom.configPayload(remote, remote.config);
      let entry = this._drafts[classId];
      if (!entry || !entry.dirty || discard) {
        entry = { profile: classroom.clone(remote), config: classroom.clone(remote.config), canEdit: remote.canEdit === true, dirty: false, conflict: false, uncertain: false, devices: remote.devices || [], error: '' };
        this._drafts[classId] = entry;
      } else {
        entry.canEdit = remote.canEdit === true; entry.devices = remote.devices || []; entry.deliveryRevision = remote.revision;
        entry.conflict = entry.profile.revision !== remote.revision; entry.uncertain = false;
        entry.error = entry.conflict ? '其他老师已更新配置。草稿已保留，请重新载入最新配置后编辑，不能直接覆盖。' : '';
      }
      this.present(entry);
    } catch (error) {
      if (this.active(generation, owner) && this.data.classId === classId) {
        const entry = this._drafts[classId];
        if (entry && error.status === 403) { entry.canEdit = false; this.present(entry); }
        ui.fail(this, error);
      }
    }
  },

  async onClassChange(event) {
    if (this.data.busy || this.data.loading) return;
    const selected = ui.chooseClass(this, event.detail.value);
    if (!selected) return;
    const generation = ++this._generation, owner = this._owner;
    this.present(this._drafts[selected.id]); this.setData({ loading: true, sessionExpired: false });
    try { await this.readProfile(selected.id, generation, owner); }
    finally { if (this.active(generation, owner)) this.setData({ loading: false }); }
  },
  onWeekdayChange(event) {
    if (this.data.busy || this.data.loading) return;
    const index = Number(event.detail.value);
    if (!Number.isInteger(index) || index < 0 || index > 6) return;
    this.setData({ weekdayIndex: index }); this.present(this.entry());
  },
  onLessonInput(event) {
    const entry = this.entry();
    if (!entry || !entry.canEdit || this.data.busy || this.data.loading || this.data.sessionExpired || !api.getUser() || api.getUser().id !== this._owner) return;
    const row = this.data.rows.find(item => item.key === event.currentTarget.dataset.key);
    if (!row) return;
    try {
      entry.config = classroom.patchLesson(entry.config, row, event.currentTarget.dataset.field, event.detail.value);
      entry.dirty = JSON.stringify(entry.config) !== JSON.stringify(entry.profile.config);
      this.present(entry);
    } catch (error) { ui.fail(this, error); }
  },
  onEnabledChange(event) {
    const entry = this.entry();
    if (!entry || !entry.canEdit || this.data.busy || this.data.loading || this.data.sessionExpired || !api.getUser() || api.getUser().id !== this._owner) return;
    entry.config.enabled = event.detail.value === true;
    entry.dirty = JSON.stringify(entry.config) !== JSON.stringify(entry.profile.config);
    this.present(entry);
  },

  async onSave() {
    const entry = this.entry();
    if (!entry || !entry.canEdit || !entry.dirty || entry.conflict || entry.uncertain || this.data.busy || this.data.loading || this.data.sessionExpired || !api.getUser() || api.getUser().id !== this._owner) return;
    let payload;
    try { payload = classroom.configPayload(entry.profile, entry.config); } catch (error) { ui.fail(this, error); return; }
    const classId = this.data.classId, owner = this._owner, generation = this._generation;
    const writing = {}; this._writing = writing;
    this.setData({ busy: true, error: '', status: '' });
    try {
      const saved = await api.request('/api/island/classes/' + encodeURIComponent(classId), { method: 'PUT', data: payload });
      try {
        if (saved.classId !== classId || saved.revision <= payload.revision) throw Error();
        classroom.configPayload(saved, saved.config);
      } catch (_) { throw Object.assign(Error('保存已返回，但配置结果无法核对。请刷新查看，勿重复保存。'), { ambiguous: true }); }
      if (this._owner !== owner || this._drafts[classId] !== entry) return;
      Object.assign(entry, { profile: classroom.clone(saved), config: classroom.clone(saved.config), devices: saved.devices || [], deliveryRevision: saved.revision, canEdit: saved.canEdit === true, dirty: false, conflict: false, uncertain: false, error: '', notice: '已保存。教室联网后同步，请以下方设备回执为准。' });
      if (this._visible && this._owner === owner && this.data.classId === classId && api.getUser() && api.getUser().id === owner) { this.present(entry); ui.toast('浮岛配置已保存'); }
    } catch (error) {
      if (this._owner !== owner || this._drafts[classId] !== entry || error.code === 'session_changed') return;
      entry.conflict = error.status === 409; entry.uncertain = error.ambiguous === true; entry.error = error.message;
      if (error.status === 403) entry.canEdit = false;
      if (this._visible && this._owner === owner && this.data.classId === classId && (!api.getUser() || api.getUser().id === owner)) { this.present(entry); ui.fail(this, error); }
    } finally {
      if (this._writing === writing) { this._writing = null; if (this._owner === owner) this.setData({ busy: false }); }
    }
  },
  onRefresh() { return this.load(); },
  async onDiscard() {
    if (this.data.busy || this.data.loading) return;
    const generation = this._generation, owner = this._owner;
    const confirmed = await ui.confirm('重新载入配置', '将放弃本班未保存草稿，并载入服务器最新配置。', '重新载入');
    if (confirmed && this.active(generation, owner)) return this.load(true);
  },
  async onPullDownRefresh() { try { await this.onRefresh(); } finally { wx.stopPullDownRefresh(); } },
  relogin() { ui.relogin(); }
});

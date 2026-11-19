'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const classroom = require('../../lib/classroom-data');
const settings = require('../../lib/study-settings');

Page({
  data: {
    classes: [], classNames: [], classIndex: 0, classId: '', loadedClassId: '',
    loaded: false, loading: false, busy: false, error: '', sessionExpired: false, status: '',
    config: {}, revision: 0, usage: {}, schedule: [], events: [], pending: 0,
    onlyPending: false, visibleEvents: [], stateText: '', deviceDetail: '', deviceName: '', deviceUpdated: '-',
    inPeriod: false, aiReady: false, photoPath: '', photoId: '', photoLabel: '', sensitivityText: '', reviewBlocked: false,
    draft: null, canEdit: false, dirty: false, conflict: false, uncertain: false, saving: false,
    savedRevision: 0, runtimeNote: '', nextPeriodText: '', flow: [], budgetOpen: false, budgetNote: '', sensitivities: []
  },
  onLoad() {
    this._generation = 0; this._visible = false; this._owner = ''; this._events = []; this._reviewBlocked = new Set();
    this._drafts = Object.create(null); this._reloadOnIdle = false;
  },
  onShow() {
    this._visible = true;
    if (!ui.requireLogin()) { ++this._generation; this.setData({ sessionExpired: true, loading: false }); return; }
    const owner = api.getUser().id;
    if (this._owner !== owner) {
      this._events = []; this._reviewBlocked = new Set(); this._writing = null; this._drafts = Object.create(null); this._reloadOnIdle = false;
      this.setData({ classes: [], classNames: [], classId: '', loaded: false, events: [], visibleEvents: [], busy: false,
        draft: null, dirty: false, canEdit: false, conflict: false, uncertain: false, saving: false, error: '', status: '' });
    }
    this._owner = owner;
    this.markDirty();
    if (this.data.busy) { this._reloadOnIdle = true; return; }
    return this.load();
  },
  onHide() { this._visible = false; ++this._generation; this.onClosePhoto(); this.setData({ loading: false }); ui.setDirty(false); },
  onUnload() { this.onHide(); },
  active(generation, owner) { const user = api.getUser(); return this._visible && generation === this._generation && this._owner === owner && (!user || user.id === owner); },
  clearClass() {
    this._events = []; this.onClosePhoto();
    this.setData({ loaded: false, loadedClassId: '', events: [], visibleEvents: [], pending: 0, config: {}, draft: null,
      canEdit: false, dirty: false, conflict: false, uncertain: false, error: '', status: '', reviewBlocked: false });
    this.markDirty();
  },
  markDirty() { ui.setDirty(this._visible && Object.values(this._drafts).some(entry => entry.dirty || entry.uncertain)); },
  entry() { return this._drafts[this.data.classId]; },
  canWrite() {
    const user = api.getUser(), entry = this.entry();
    return Boolean(this._visible && user && user.id === this._owner && user.role !== 'subject_teacher' && entry && entry.canEdit &&
      this.data.loaded && this.data.loadedClassId === this.data.classId && this.data.canEdit &&
      this.data.classes.some(item => item.id === this.data.classId) && !this.data.busy && !this.data.loading && !this.data.sessionExpired);
  },
  present(entry) {
    if (!entry) return;
    const profile = entry.profile;
    const now = profile.serverTime + Math.max(0, Date.now() - entry.receivedAt);
    const runtime = settings.runtime(profile, now);
    this.setData({
      loaded: true, loadedClassId: profile.classId, config: profile.config, revision: entry.baseline.revision,
      savedRevision: profile.revision, draft: entry.draft, dirty: entry.dirty, conflict: entry.conflict, uncertain: entry.uncertain,
      canEdit: entry.canEdit, usage: profile.usage || {}, inPeriod: profile.inPeriod === true, aiReady: profile.aiReady === true,
      stateText: runtime.stateText, runtimeNote: runtime.runtimeNote, flow: runtime.flow, deviceDetail: runtime.deviceDetail,
      deviceName: profile.status && profile.status.name || '', deviceUpdated: ui.formatTime(profile.status && profile.status.updated_at),
      sensitivityText: { low: '较低', balanced: '标准', high: '较高' }[profile.config.sensitivity],
      nextPeriodText: runtime.nextPeriod ? `${runtime.nextPeriod.startAt <= now ? '本节' : '下一节'}：${ui.formatTime(runtime.nextPeriod.startAt)} - ${ui.formatTime(runtime.nextPeriod.endAt)}` : '近期没有有效的第二节晚自习安排',
      schedule: profile.schedule.map(item => ({ ...item, startText: ui.formatTime(item.startAt), endText: ui.formatTime(item.endAt) })),
      budgetNote: settings.budgetNote(entry.draft), sensitivities: settings.SENSITIVITIES,
      error: entry.error || '', status: entry.notice || ''
    });
    this.markDirty();
  },
  acceptProfile(response, classId, discard = false) {
    const profile = settings.profileFrom(response, classId);
    let entry = this._drafts[classId];
    const confirmed = entry && entry.uncertain && entry.pending && profile.revision > entry.baseline.revision &&
      settings.signature(profile.config) === settings.signature(entry.pending);
    if (!entry || (!entry.dirty && !entry.uncertain) || discard) {
      entry = { profile, baseline: profile, draft: settings.draftFrom(profile.config), dirty: false, conflict: false,
        uncertain: false, canEdit: true, error: '', notice: confirmed ? '已核对：上次设置已保存。' : entry && entry.notice || '', receivedAt: Date.now() };
      this._drafts[classId] = entry;
    } else if (confirmed) {
      Object.assign(entry, { profile, baseline: profile, receivedAt: Date.now(), canEdit: true, uncertain: false, pending: null,
        conflict: false, dirty: settings.dirty(entry.draft, profile.config), error: '', notice: '已核对：上次设置已保存。' });
    } else {
      entry.profile = profile; entry.receivedAt = Date.now(); entry.canEdit = true; entry.uncertain = false; entry.pending = null;
      entry.conflict = profile.revision !== entry.baseline.revision;
      entry.error = entry.conflict ? '本班设置已被其他老师修改。草稿已保留，请重新载入最新设置后编辑，不能直接覆盖。' : '';
    }
    this.present(entry);
    return entry;
  },

  async load(discard = false) {
    if (this.data.busy || !this._visible) return;
    const generation = ++this._generation, owner = this._owner;
    this.setData({ loading: true, error: '', sessionExpired: false });
    try {
      // This endpoint excludes teaching-only assignments on the server.
      const response = await api.request('/api/self-study/classes');
      if (!this.active(generation, owner)) return;
      if (!Array.isArray(response.classes)) throw Error('晚自习班级列表格式异常，请重试。');
      const classes = response.classes;
      const selected = this.data.classId || api.getClassId();
      const index = Math.max(0, classes.findIndex(item => item.id === selected));
      this.setData({ classes, classNames: classes.map(item => item.name) });
      if (!classes.length) { this.setData({ classId: '' }); this.clearClass(); return; }
      const current = ui.chooseClass(this, index);
      if (this.data.loadedClassId !== current.id) this.clearClass();
      await this.readClass(current.id, generation, owner, discard);
    } catch (error) {
      if (this.active(generation, owner)) { if (error.status === 403) this.clearClass(); ui.fail(this, error); }
    } finally { if (this.active(generation, owner)) this.setData({ loading: false }); }
  },

  async readClass(classId, generation, owner, discard = false) {
    const results = await Promise.allSettled([
      api.request('/api/self-study/classes/' + encodeURIComponent(classId)),
      api.request('/api/self-study/events?' + ui.query({ classId, limit: 100 }))
    ]);
    if (!this.active(generation, owner) || classId !== this.data.classId) return;
    // A sibling 401 clears the shared session, making this request session_changed.
    // Surface the actual authentication failure before ignoring stale results.
    const expired = results.find(result => result.status === 'rejected' && result.reason && result.reason.status === 401);
    if (expired) { ui.fail(this, expired.reason); return; }
    const [settings, records] = results;
    if (settings.status === 'rejected') {
      if (settings.reason.status === 403) { const entry = this._drafts[classId]; if (entry) entry.canEdit = false; this.clearClass(); }
      ui.fail(this, settings.reason); return;
    }
    this.acceptProfile(settings.value, classId, discard);
    if (records.status === 'rejected') { if (records.reason.status === 403) this.clearClass(); ui.fail(this, records.reason); return; }
    const response = records.value;
    if (!Array.isArray(response.events) || !Number.isInteger(response.pending) || !Number.isFinite(response.serverTime)) throw Error('晚自习记录格式异常，请重新载入。');
    if (response.events.some(event => event.class_id !== classId)) throw Error('记录班级与当前选择不一致，请重新载入。');
    this._serverTime = response.serverTime; this._receivedAt = Date.now(); this._events = response.events;
    this._reviewBlocked.clear(); this._uncertain = false; this.onClosePhoto();
    this.setData({ pending: response.pending, reviewBlocked: false }); this.renderEvents();
  },

  renderEvents() {
    const serverTime = this._serverTime + Math.max(0, Date.now() - this._receivedAt);
    const events = this._events.map(event => ({ ...classroom.studyEvent(event, serverTime), atText: ui.formatTime(event.reported_at == null ? event.started_at : event.reported_at), handledText: ui.formatTime(event.handled_at), blocked: this._reviewBlocked.has(event.id) || this._uncertain === true }));
    this.setData({ events, visibleEvents: this.data.onlyPending ? events.filter(event => event.needsReview) : events });
  },
  onPendingChange(event) { this.setData({ onlyPending: event.detail.value === true }); this.renderEvents(); },
  async onClassChange(event) {
    if (this.data.loading || this.data.busy) return;
    const current = ui.chooseClass(this, event.detail.value);
    if (!current) return;
    const generation = ++this._generation, owner = this._owner;
    this.clearClass(); this.setData({ loading: true, sessionExpired: false });
    try { await this.readClass(current.id, generation, owner); }
    catch (error) { if (this.active(generation, owner)) ui.fail(this, error); }
    finally { if (this.active(generation, owner)) this.setData({ loading: false }); }
  },

  changeDraft(field, value) {
    if (!this.canWrite()) return;
    const entry = this.entry();
    entry.draft = { ...entry.draft, [field]: value };
    entry.dirty = settings.dirty(entry.draft, entry.baseline.config); entry.notice = '';
    this.present(entry);
  },
  onOption(event) {
    const field = event.currentTarget.dataset.field;
    if (['enabled', 'authorized', 'aiEnabled', 'photoEnabled'].includes(field)) this.changeDraft(field, event.detail.value === true);
  },
  onAuthorized(event) { this.changeDraft('authorized', Array.isArray(event.detail.value) && event.detail.value.includes('authorized')); },
  onRuleInput(event) {
    const field = event.currentTarget.dataset.field;
    if (['voiceTriggerSeconds', 'observationSeconds', 'reminderWaitSeconds', 'confirmationsAfterReminder', 'dailyCalls', 'dailyTokens'].includes(field)) this.changeDraft(field, event.detail.value);
  },
  onSensitivity(event) {
    const value = event.currentTarget.dataset.value;
    if (settings.SENSITIVITIES.some(item => item.value === value)) this.changeDraft('sensitivity', value);
  },
  onBudgetToggle() { if (!this.data.busy) this.setData({ budgetOpen: !this.data.budgetOpen }); },
  openTimetable() {
    if (!this.data.busy && this.data.classId && !this.data.sessionExpired) { api.selectClass(this.data.classId); wx.navigateTo({ url: '/pages/island/index' }); }
  },
  async onDiscard() {
    if (this.data.busy || this.data.loading || this.data.sessionExpired) return;
    const generation = this._generation, owner = this._owner;
    if (await ui.confirm('重新载入晚自习设置', '将放弃当前班级的未保存草稿，并载入最新设置；其他班级草稿保留。', '重新载入') && this.active(generation, owner)) return this.load(true);
  },
  async onSave() {
    const entry = this.entry();
    if (!this.canWrite() || !entry.dirty || entry.conflict || entry.uncertain) return;
    let payload;
    try { payload = settings.payload(entry.baseline, entry.draft); } catch (error) { ui.fail(this, error); return; }
    const owner = this._owner, classId = this.data.classId, generation = ++this._generation, writing = {};
    this._writing = writing; this.setData({ busy: true, saving: true, error: '', status: '' });
    let refresh = false;
    try {
      const name = this.data.classNames[this.data.classIndex];
      if (!await ui.confirm('保存晚自习设置', settings.confirmation(payload.config, name), '确认保存') || !this.active(generation, owner) || !api.getUser()) return;
      if (api.getUser().role === 'subject_teacher') {
        entry.canEdit = false; throw Error('任课权限不包含晚自习设置，请刷新核对带班或管理权限。');
      }
      entry.pending = payload.config;
      const response = await api.request('/api/self-study/classes/' + encodeURIComponent(classId), { method: 'PUT', data: payload });
      let profile;
      try {
        profile = settings.profileFrom(response, classId);
        if (profile.revision <= payload.revision || settings.signature(profile.config) !== settings.signature(payload.config)) throw Error();
      } catch (_) { throw Object.assign(Error('保存已返回，但设置结果无法核对。请先刷新查看，勿重复保存。'), { ambiguous: true }); }
      if (this._owner !== owner || this._drafts[classId] !== entry) return;
      Object.assign(entry, { profile, baseline: profile, draft: settings.draftFrom(profile.config), dirty: false, conflict: false,
        uncertain: false, pending: null, canEdit: true, receivedAt: Date.now(), error: '', notice: '设置已保存。教室联网后同步，今日用量与历史记录保留。' });
      refresh = true;
      if (this._visible && this.data.classId === classId) { this.present(entry); ui.toast('晚自习设置已保存'); }
    } catch (error) {
      if (error.code === 'session_changed' || this._owner !== owner || this._drafts[classId] !== entry) return;
      entry.conflict = error.status === 409; entry.uncertain = error.ambiguous === true; entry.error = error.message;
      if (error.status === 403) entry.canEdit = false;
      if (this._visible && this.data.classId === classId) { this.present(entry); ui.fail(this, error); }
    } finally {
      if (this._writing === writing) {
        this._writing = null;
        if (this._owner === owner) {
          this.setData({ busy: false, saving: false });
          if (this._visible && api.getUser() && api.getUser().id === owner && (refresh || this._reloadOnIdle)) { this._reloadOnIdle = false; await this.load(); }
        }
      }
    }
  },

  async onPhoto(event) {
    if (!this.data.loaded || this.data.busy || this.data.loading || this.data.sessionExpired || !api.getUser() || api.getUser().id !== this._owner) return;
    const id = event.currentTarget.dataset.id;
    const record = this._events.find(item => item.id === id);
    const serverTime = this._serverTime + Math.max(0, Date.now() - this._receivedAt);
    if (!record || !classroom.studyEvent(record, serverTime).canViewPhoto) { this.renderEvents(); ui.fail(this, Error('照片尚不可用或已过期，请刷新记录。')); return; }
    const generation = this._generation, owner = this._owner;
    this.onClosePhoto(); this.setData({ busy: true, error: '' });
    try {
      const localPath = await api.download('/api/self-study/events/' + encodeURIComponent(id) + '/photo');
      if (!this.active(generation, owner)) return;
      const remaining = record.photo_at + classroom.PHOTO_TTL - this._serverTime - Math.max(0, Date.now() - this._receivedAt);
      if (remaining <= 0) throw Error('照片已过期，请刷新记录。');
      this.setData({ photoPath: localPath, photoId: id, photoLabel: '本班晚自习事件现场照片，仅供人工核实' });
      // One expiry timer for an explicitly opened photo; no background polling.
      this._photoTimer = setTimeout(() => { this.onClosePhoto(); this.renderEvents(); }, remaining);
    } catch (error) { if (this.active(generation, owner)) ui.fail(this, error); }
    finally {
      if (this._owner === owner) {
        this.setData({ busy: false });
        if (this._reloadOnIdle && this._visible && api.getUser()) { this._reloadOnIdle = false; await this.load(); }
      }
    }
  },
  onClosePhoto() { if (this._photoTimer) clearTimeout(this._photoTimer); this._photoTimer = null; this.setData({ photoPath: '', photoId: '', photoLabel: '' }); },
  onPhotoError() { this.onClosePhoto(); ui.fail(this, Error('照片无法显示，请关闭后重试或刷新记录。')); },

  async onReview(event) {
    if (!this.data.loaded || this.data.busy || this.data.loading || this.data.sessionExpired || this._uncertain || !api.getUser() || api.getUser().id !== this._owner) return;
    const { id, resolution } = event.currentTarget.dataset;
    const record = this._events.find(item => item.id === id);
    if (!['handled', 'false_alarm'].includes(resolution) || !record || !classroom.studyEvent(record, this._serverTime).needsReview || this._reviewBlocked.has(id)) return;
    const generation = this._generation, owner = this._owner;
    const writing = {}; this._writing = writing; this.setData({ busy: true, error: '', status: '' });
    try {
      const label = resolution === 'false_alarm' ? '确认误报' : '人工处理完成';
      const confirmed = await ui.confirm(label, `将把 ${this.data.classNames[this.data.classIndex]} 的这条记录标记为“${label}”。请先完成人工核实；查看照片不会自动处理记录。`, '确认记录');
      if (!confirmed || !this.active(generation, owner)) return;
      await api.request('/api/self-study/events/' + encodeURIComponent(id) + '/review', { method: 'POST', data: { resolution } });
      if (!this.active(generation, owner)) return;
      this._reviewBlocked.add(id); this.renderEvents();
      this.setData({ status: '人工处理结果已记录。' });
      await this.readClass(this.data.classId, generation, owner);
    } catch (error) {
      if (this.active(generation, owner)) {
        if (error.status === 409 || error.ambiguous) { this._reviewBlocked.add(id); this._uncertain = error.ambiguous === true; this.renderEvents(); }
        ui.fail(this, error);
      }
    } finally {
      if (this._writing === writing) {
        this._writing = null;
        if (this._owner === owner) {
          this.setData({ busy: false });
          if (this._reloadOnIdle && this._visible && api.getUser()) { this._reloadOnIdle = false; await this.load(); }
        }
      }
    }
  },
  onRefresh() { return this.load(); },
  async onPullDownRefresh() { try { if (ui.requireLogin()) await this.onRefresh(); else this.setData({ sessionExpired: true }); } finally { wx.stopPullDownRefresh(); } },
  relogin() { ui.relogin(); }
});

'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const classroom = require('../../lib/classroom-data');

Page({
  data: {
    classes: [], classNames: [], classIndex: 0, classId: '',
    weekdays: classroom.WEEKDAYS, weekdayIndex: 0, weekAnchor: '', rows: [], slots: [], devices: [],
    loaded: false, loading: false, enabled: false, syncRevision: 0, error: '', sessionExpired: false
  },

  onShow() { if (ui.requireLogin()) return this.load(); },
  onHide() { this._generation = (this._generation || 0) + 1; },
  onUnload() { this.onHide(); },
  load() { return this.refresh(true); },

  async refresh(reloadClasses) {
    const owner = api.getUser();
    if (!owner) { ui.relogin(); return; }
    const generation = this._generation = (this._generation || 0) + 1;
    const current = () => {
      const user = api.getUser();
      return generation === this._generation && (!user || user.id === owner.id);
    };
    this._schedule = null;
    this.setData({ loading: true, loaded: false, error: '', sessionExpired: false, rows: [], slots: [], devices: [] });
    try {
      if (reloadClasses) await ui.loadClasses(this, current);
      if (!current() || !this.data.classId) return;
      const classId = this.data.classId;
      const profile = await api.request('/api/island/classes/' + encodeURIComponent(classId));
      if (!current() || this.data.classId !== classId) return;
      if (!profile || profile.classId !== classId || !Number.isInteger(profile.revision) || profile.revision < 0) {
        throw Error('课表响应异常，请重新载入。');
      }
      const config = profile.config;
      const rows = classroom.lessonRows(config, this.data.weekdayIndex + 1);
      this._schedule = { slots: config.slots, lessons: config.lessons, dutyRotations: config.dutyRotations };
      this.setData({
        loaded: true, enabled: config.enabled === true, weekAnchor: config.weekAnchor, rows, syncRevision: profile.revision,
        slots: [...config.slots].sort((a, b) => a.start - b.start).map(slot => ({ ...slot, timeLabel: `${classroom.clock(slot.start)}-${classroom.clock(slot.end)}` })),
        devices: (profile.devices || []).map(device => ({ id: device.id, name: device.name, detail: device.detail,
          syncText: device.revision === profile.revision ? '已同步' : '等待同步', syncedText: ui.formatTime(device.synced_at),
          revisionText: device.revision == null ? '未回执' : String(device.revision) }))
      });
    } catch (error) { if (current()) ui.fail(this, error); }
    finally { if (current()) this.setData({ loading: false }); }
  },

  onClassChange(event) {
    if (this.data.loading || this.data.sessionExpired) return;
    if (ui.chooseClass(this, event.detail.value)) return this.refresh(false);
  },
  onWeekdayChange(event) {
    const index = Number(event.detail.value);
    if (!this._schedule || !Number.isInteger(index) || index < 0 || index > 6) return;
    this.setData({ weekdayIndex: index, rows: classroom.lessonRows(this._schedule, index + 1) });
  },
  async onPullDownRefresh() { try { await this.load(); } finally { wx.stopPullDownRefresh(); } },
  relogin: ui.relogin
});

'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const manage = require('../../lib/manage-data');

Page({
  data: {
    classes: [], classNames: [], classIndex: -1, classId: '', devices: [],
    loading: false, busy: false, error: '', sessionExpired: false, status: '', uncertain: false,
    volumeDraft: '', canSend: false, canOpenReading: false, availability: '', volumeHint: '', readingHint: ''
  },

  onShow() {
    this._visible = true;
    manage.invalidate(this);
    if (!ui.requireLogin()) { this.setData({ sessionExpired: true, loading: false }); return; }
    const actor = api.getUser();
    if (this._actorId && this._actorId !== actor.id) {
      this._volumeDrafts = {};
      this.setData({ classes: [], classNames: [], classIndex: -1, classId: '', devices: [], volumeDraft: '',
        canSend: false, canOpenReading: false, error: '', status: '', uncertain: false });
    }
    this._actorId = actor.id;
    this._volumeDrafts = this._volumeDrafts || {};
    this.setData({ sessionExpired: false });
    return this.load();
  },
  onHide() { this._visible = false; manage.invalidate(this); this.setData({ loading: false, canSend: false, canOpenReading: false }); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() {
    try { if (ui.requireLogin()) await this.load(); else this.setData({ sessionExpired: true }); }
    finally { wx.stopPullDownRefresh(); }
  },
  relogin() { ui.relogin(); },
  refresh() { return this.load(); },

  async load() {
    if (this.data.busy || !this._visible) return;
    const generation = manage.invalidate(this);
    const actor = api.getUser();
    if (!actor) { this.setData({ sessionExpired: true }); return; }
    this.setData({ loading: true, error: '', devices: [], canSend: false, canOpenReading: false, availability: '', volumeHint: '', readingHint: '' });
    try {
      const response = await api.request('/api/classes');
      if (!manage.current(this, generation) || !api.getUser() || api.getUser().id !== actor.id) return;
      const classes = manage.classesFrom(response);
      const savedId = api.getClassId() || this.data.classId;
      let index = classes.findIndex(item => item.id === savedId);
      if (index < 0) index = classes.findIndex(item => item.isEnabled);
      if (index < 0 && classes.length) index = 0;
      this.setData({ classes, classNames: classes.map(item => item.name + (item.isEnabled ? '' : '（已停用）')), classIndex: index });
      if (index < 0) { this.setData({ classId: '', volumeDraft: '', availability: '当前账号暂无获授权班级。' }); return; }
      const selected = ui.chooseClass(this, index);
      if (!selected) return;
      this.restoreVolumeDraft(selected.id);
      await this.readDevices(generation, selected.id, actor.id);
    } catch (error) {
      if (manage.current(this, generation)) ui.fail(this, error);
    } finally {
      if (manage.current(this, generation)) this.setData({ loading: false });
    }
  },

  async chooseClass(event) {
    if (this.data.busy || this.data.sessionExpired) return;
    const index = Number(event.detail.value);
    if (!Number.isInteger(index) || !this.data.classes[index]) return;
    const generation = manage.invalidate(this);
    // Clear the previous class before changing the shared selection.
    this.setData({ devices: [], status: '', error: '', availability: '', volumeHint: '', readingHint: '', canSend: false, canOpenReading: false, loading: true });
    const selected = ui.chooseClass(this, index);
    this.restoreVolumeDraft(selected.id);
    const actor = api.getUser();
    if (!actor) { this.setData({ sessionExpired: true, loading: false }); return; }
    try { await this.readDevices(generation, selected.id, actor.id); }
    catch (error) { if (manage.current(this, generation)) ui.fail(this, error); }
    finally { if (manage.current(this, generation)) this.setData({ loading: false }); }
  },

  restoreVolumeDraft(classId) {
    this.setData({ volumeDraft: Object.prototype.hasOwnProperty.call(this._volumeDrafts || {}, classId) ? this._volumeDrafts[classId] : '' });
  },

  async readDevices(generation, classId, actorId) {
    const response = await api.request('/api/classroom-controls');
    if (!manage.current(this, generation) || this.data.classId !== classId || !api.getUser() || api.getUser().id !== actorId) return;
    const devices = manage.devicesFrom(response).filter(item => item.class_id === classId).map(item => ({
      ...item, lastSeenLabel: ui.formatTime(item.last_seen_at), reportedLabel: ui.formatTime(item.reported_at),
      verifiedLabel: item.verified_at ? '已核实' : '待核实', addressesLabel: Array.isArray(item.local_addresses) ? item.local_addresses.join('、') : ''
    }));
    const selected = this.data.classes.find(item => item.id === classId);
    const active = devices.filter(item => item.isEnabled);
    const canControl = manage.permission(api.getUser(), 'controlClassrooms');
    const canSend = Boolean(canControl && selected && selected.isEnabled && active.length);
    const hasReading = active.some(item => item.hasReading);
    const availability = !canControl ? '当前账号没有教室控制权限。' : !selected || !selected.isEnabled ? '班级已停用，无法发送教室指令。' :
      !active.length ? '本班没有启用的已绑定教室设备。' : '';
    const patch = {
      devices, canSend, canOpenReading: canSend && hasReading, availability, sessionExpired: false, uncertain: false,
      volumeHint: canSend && !active.some(item => item.hasVolume) ? '设备尚未上报音量控制能力。可以保存目标音量，是否应用以教室端回报为准。' : '',
      readingHint: canSend && !hasReading ? '设备尚未上报早读能力，请刷新或核对教室端版本。' : ''
    };
    if (!Object.prototype.hasOwnProperty.call(this._volumeDrafts || {}, classId)) {
      const control = active.find(item => Number.isInteger(item.desired_volume) && item.desired_volume >= 0 && item.desired_volume <= 100);
      patch.volumeDraft = control ? String(control.desired_volume) : '';
    }
    this.setData(patch);
  },

  inputVolume(event) {
    if (this.data.busy || !this.data.classId) return;
    this._volumeDrafts = this._volumeDrafts || {};
    this._volumeDrafts[this.data.classId] = event.detail.value;
    this.setData({ volumeDraft: event.detail.value });
  },
  setVolume() {
    if (this.data.busy || this.data.loading || this.data.uncertain || this.data.sessionExpired || !this.data.canSend) return;
    let payload;
    try { payload = manage.volumePayload(this.data.volumeDraft); }
    catch (error) { ui.fail(this, error); return; }
    return this.sendControl(payload);
  },
  openReading() {
    if (this.data.busy || this.data.loading || this.data.uncertain || this.data.sessionExpired || !this.data.canOpenReading) return;
    return this.sendControl({ action: 'open_reading' });
  },

  async sendControl(payload) {
    const actor = api.getUser();
    const target = this.data.classes.find(item => item.id === this.data.classId);
    if (this.data.busy || !this._visible || !target || !target.isEnabled || !manage.permission(actor, 'controlClassrooms') || !this.data.canSend) return;
    const generation = manage.invalidate(this);
    const stillCurrent = () => manage.current(this, generation) && api.getUser() && api.getUser().id === actor.id && this.data.classId === target.id;
    const active = this.data.devices.filter(item => item.isEnabled);
    const online = active.filter(item => item.online).length;
    const title = payload.action === 'set_volume' ? '确认设置播放音量' : '确认打开早读';
    const content = `班级：“${target.name}”\n本班有 ${active.length} 台启用设备，${online} 台在线。\n` +
      (payload.action === 'set_volume' ? `将保存 ${payload.volume}% 播放音量，并向本班所有在线连接广播。离线设备会在上线后应用。` :
        '将向本班所有在线连接广播打开早读指令。离线设备不会补发；是否打开以教室现场为准。');
    this.setData({ busy: true, error: '', status: '' });
    let refresh = false;
    try {
      if (!await ui.confirm(title, content, '确认发送') || !stillCurrent()) return;
      const response = await api.request(`/api/classes/${encodeURIComponent(target.id)}/control`, { method: 'POST', data: payload });
      if (!stillCurrent()) return;
      const status = manage.controlResult(response, target.name, payload);
      if (payload.action === 'set_volume') delete this._volumeDrafts[target.id];
      this.setData({ status });
      refresh = true;
    } catch (error) {
      if (manage.current(this, generation)) {
        ui.fail(this, error);
        if (error.ambiguous) this.setData({ uncertain: true, status: '操作结果尚未确认。请先刷新设备状态核对，避免重复发送。' });
      }
    } finally {
      this.setData({ busy: false });
      if (refresh && this._visible && api.getUser() && api.getUser().id === actor.id) await this.load();
    }
  }
});

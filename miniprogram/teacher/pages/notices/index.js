'use strict';

const api = require('../../lib/api');
const ui = require('../../lib/ui');
const notices = require('../../lib/notice-data');
const audio = require('../../lib/notice-audio');

function selectedIndex(event) {
  const dataset = event.currentTarget && event.currentTarget.dataset;
  const index = dataset && dataset.index;
  return Number(index === null || index === undefined ? event.detail.value : index);
}

Page({
  data: {
    classes: [], classNames: [], classIndex: -1, classId: '',
    loading: false, presenceLoading: false, recentLoading: false, presence: '', recent: [],
    error: '', sessionExpired: false, busy: false, phase: '', fileBusy: false,
    modeNames: ['文字通知', '教师原声'], modeIndex: 0,
    text: '', textCount: 0, audioFile: null, audioState: '', previewing: false, presenceTone: '',
    levelNames: notices.LEVELS.map(item => item.label), levelIndex: 0, levelMode: notices.LEVELS[0].mode,
    durationNames: notices.DURATIONS.map(value => `${value} 秒`), durationIndex: 1,
    speedNames: ['较慢', '正常', '较快', '很快'], speedIndex: 1,
    volumeNames: ['静音（0%）', '25%', '50%', '75%', '100%'], volumeIndex: 4,
    showSettings: false, lastResult: null, uncertain: false, uncertainClassName: '', recordsOpened: false
  },

  onLoad() {
    this._generation = 0;
    this._visibilityGeneration = 0;
    this._sendReadGeneration = 0;
    this._fileGeneration = 0;
    this._visible = false;
  },

  onShow() {
    this._visible = true;
    if (!ui.requireLogin()) return;
    const user = api.getUser();
    if (this._ownerId !== user.id) {
      this._ownerId = user.id;
      this.setData({ classes: [], classNames: [], classIndex: -1, classId: '', recent: [], presence: '', lastResult: null });
    }
    this.markDraft();
    if (!this.data.busy && !this.data.fileBusy) return this.refresh();
  },

  onHide() { this.invalidateReads(); },
  onUnload() { this.invalidateReads(); ui.setDirty(false); },

  invalidateReads() {
    this._visible = false;
    this._generation += 1;
    this._visibilityGeneration += 1;
    this._sendReadGeneration += 1;
    this._fileGeneration += 1;
    if (this._recording) this._recording.cancel();
    this._recording = null;
    this.stopPreview();
    this.setData({ loading: false, presenceLoading: false, recentLoading: false, fileBusy: false, audioState: '' });
  },

  current(generation, classId) {
    return this._visible && generation === this._generation && (!classId || classId === this.data.classId);
  },

  sameUser() {
    const user = api.getUser();
    return Boolean(user && user.id === this._ownerId);
  },

  async refresh() {
    if (this.data.busy || this.data.fileBusy) return;
    if (!api.getUser()) { this.setData({ sessionExpired: true }); return; }
    const generation = ++this._generation;
    this.setData({ loading: true, error: '', sessionExpired: false, presence: '', recent: [], presenceLoading: false, recentLoading: false });
    const target = {
      data: { ...this.data },
      setData: patch => {
        if (this.current(generation) && this.sameUser()) { Object.assign(target.data, patch); this.setData(patch); }
      }
    };
    try {
      await ui.loadClasses(target, () => this.current(generation) && this.sameUser());
      if (!this.current(generation) || !this.sameUser()) return;
      this.setData({ loading: false, lastResult: this.data.lastResult && this.data.lastResult.classId === this.data.classId ? this.data.lastResult : null });
      await this.loadClassData();
    } catch (error) {
      if (this.current(generation)) ui.fail(this, error);
    } finally {
      if (this.current(generation)) this.setData({ loading: false });
    }
  },

  async loadClassData() {
    const generation = ++this._generation, classId = this.data.classId;
    if (!classId) return;
    this.setData({ presenceLoading: true, recentLoading: true });
    await Promise.all([
      (async () => {
        try {
          const result = await api.request(`/api/classes/${encodeURIComponent(classId)}/status`, { method: 'GET' });
          if (this.current(generation, classId) && this.sameUser()) this.setData({
            presence: result.online ? '教室在线' : '教室离线，通知不会补播', presenceTone: result.online ? 'good' : 'warn'
          });
        } catch (error) {
          if (this.current(generation, classId) && error.code !== 'session_changed') { this.setData({ presence: '教室状态未能读取', presenceTone: 'warn' }); ui.fail(this, error); }
        } finally {
          if (this.current(generation, classId)) this.setData({ presenceLoading: false });
        }
      })(),
      (async () => {
        try {
          const result = await api.request(`/api/history?${ui.query({ classId, limit: 5, offset: 0 })}`, { method: 'GET' });
          if (this.current(generation, classId) && this.sameUser()) {
            const recent = result.history.map(item => notices.mapHistoryItem(item, ui.formatTime));
            const lastResult = this.data.lastResult;
            const item = lastResult && recent.find(row => row.id === lastResult.id);
            this.setData(item && item.status !== lastResult.status ? {
              recent, lastResult: { ...lastResult, status: item.status, label: item.statusLabel, detail: item.detail, timeline: item.timeline }
            } : { recent });
          }
        } catch (error) {
          if (this.current(generation, classId)) ui.fail(this, error);
        } finally {
          if (this.current(generation, classId)) this.setData({ recentLoading: false });
        }
      })()
    ]);
  },

  async onPullDownRefresh() {
    try { await this.refresh(); } finally { wx.stopPullDownRefresh(); }
  },

  onClassChange(event) {
    if (this.data.busy || this.data.fileBusy) return;
    const index = Number(event.detail.value);
    if (!Number.isInteger(index) || !this.data.classes[index] || index === this.data.classIndex) return;
    this._generation += 1;
    this.setData({ recent: [], presence: '', lastResult: null, error: '', recentLoading: false, presenceLoading: false });
    ui.chooseClass(this, index);
    return this.loadClassData();
  },

  onTextInput(event) {
    if (this.data.busy) return;
    this.setData({ text: event.detail.value, textCount: Array.from(event.detail.value).length });
    this.markDraft();
  },

  onModeChange(event) {
    if (this.data.busy || this.data.fileBusy) return;
    const modeIndex = selectedIndex(event);
    if (![0, 1].includes(modeIndex)) return;
    this.stopPreview();
    this.setData({ modeIndex, error: '' });
    if (modeIndex === 1 && this.data.levelIndex === 0) this.applyLevel(1);
  },

  onLevelChange(event) {
    if (this.data.busy || this.data.fileBusy) return;
    const index = selectedIndex(event);
    if (this.data.modeIndex === 1 && index === 0) { this.setData({ error: '教师原声请选择“重要”或“紧急”。' }); return; }
    this.applyLevel(index);
  },

  applyLevel(index) {
    const level = notices.LEVELS[index];
    if (!level) return;
    const patch = { levelIndex: index, levelMode: level.mode };
    if (!this._durationEdited) patch.durationIndex = notices.DURATIONS.indexOf(level.duration);
    this.setData(patch);
  },

  onDurationChange(event) {
    if (this.data.busy) return;
    const index = Number(event.detail.value);
    if (notices.DURATIONS[index] === undefined) return;
    this._durationEdited = true;
    this.setData({ durationIndex: index });
  },

  onSpeedChange(event) {
    if (!this.data.busy && notices.SPEEDS[Number(event.detail.value)] !== undefined) this.setData({ speedIndex: Number(event.detail.value) });
  },

  onVolumeChange(event) {
    if (!this.data.busy && notices.VOLUMES[Number(event.detail.value)] !== undefined) this.setData({ volumeIndex: Number(event.detail.value) });
  },

  toggleSettings() { if (!this.data.busy) this.setData({ showSettings: !this.data.showSettings }); },

  markDraft() { ui.setDirty(Boolean(this.data.text || this.data.audioFile)); },

  async startVoice() {
    if (!this._visible || !this.sameUser() || this.data.busy || this.data.fileBusy || this.data.modeIndex !== 1) return;
    const generation = ++this._fileGeneration;
    const current = () => this._visible && this.sameUser() && generation === this._fileGeneration;
    this.stopPreview();
    this.setData({ fileBusy: true, audioState: 'starting', error: '' });
    try {
      await audio.authorizeRecording(wx, current);
      if (!current()) return;
      this._recording = audio.recorder(wx).start({
        start: () => { if (current()) this.setData({ audioState: 'recording' }); },
        finish: async (error, result) => {
          if (!current()) return;
          this._recording = null;
          this.setData({ audioState: 'saving' });
          try {
            if (error) throw error;
            const audioFile = await audio.readWav(wx, result && result.tempFilePath, '现场录音.wav');
            if (current()) { this.setData({ audioFile }); this.markDraft(); }
          } catch (failure) {
            if (current()) this.setData({ error: failure.message || '无法读取录音，请重新录制。' });
          } finally {
            if (current()) this.setData({ fileBusy: false, audioState: '' });
          }
        }
      });
    } catch (error) {
      if (current()) this.setData({ fileBusy: false, audioState: '', error: error.message || '录音未开始，请重试。' });
    }
  },

  stopVoice() {
    if (this.data.audioState !== 'recording' || !this._recording) return;
    this.setData({ audioState: 'saving' });
    this._recording.stop();
  },

  togglePreview() {
    if (this.data.busy || this.data.fileBusy || !this.data.audioFile) return;
    if (this._audioPreview) { this.stopPreview(); return; }
    if (typeof wx.createInnerAudioContext !== 'function') { ui.toast('当前设备不支持试听。'); return; }
    const player = wx.createInnerAudioContext();
    this._audioPreview = player;
    player.onEnded(() => { if (this._audioPreview === player) this.stopPreview(); });
    player.onError(() => {
      if (this._audioPreview === player) { this.stopPreview(); this.setData({ error: '试听失败。请重新录制或选择 WAV 文件。' }); }
    });
    player.src = this.data.audioFile.path;
    this.setData({ previewing: true });
    player.play();
  },

  stopPreview() {
    const player = this._audioPreview;
    this._audioPreview = null;
    if (player) { player.destroy(); this.setData({ previewing: false }); }
  },

  async chooseWav() {
    if (this.data.busy || this.data.fileBusy) return;
    if (typeof wx.chooseMessageFile !== 'function') { this.setData({ error: '当前微信版本不支持选择文件，请升级微信后选择 WAV。' }); return; }
    const generation = ++this._fileGeneration;
    this.stopPreview();
    this.setData({ fileBusy: true, error: '' });
    const current = () => this._visible && generation === this._fileGeneration;
    try {
      const result = await new Promise((resolve, reject) => wx.chooseMessageFile({ count: 1, type: 'file', extension: ['wav'], success: resolve, fail: reject }));
      if (!current()) return;
      const file = result.tempFiles && result.tempFiles[0];
      if (!file || !file.path || !/\.wav$/i.test(file.name || '')) throw new Error('请选择 WAV 文件，其他录音格式不能直接发送。');
      if (file.size > notices.MAX_AUDIO_BYTES) throw new Error('WAV 文件不能超过 4 MB。');
      const audioFile = await audio.readWav(wx, file.path, file.name);
      if (!current()) return;
      this.setData({ audioFile });
      this.markDraft();
    } catch (error) {
      if (current() && !/cancel/i.test(error.errMsg || '')) this.setData({ error: error.message || 'WAV 文件读取失败，请重新选择。' });
    } finally {
      if (current()) this.setData({ fileBusy: false });
    }
  },

  removeWav() {
    if (!this.data.busy && !this.data.fileBusy) { this.stopPreview(); this.setData({ audioFile: null }); this.markDraft(); }
  },

  canContinue(visibility, notice) {
    return this._visible && visibility === this._visibilityGeneration && this.sameUser() && this.data.classId === notice.values.classId;
  },

  postNotice(notice, quietAcknowledged) {
    const values = { ...notice.values, quietAcknowledged };
    if (!notice.audioFile) return api.request('/api/shouts', { method: 'POST', data: values });
    const formData = {};
    Object.keys(values).forEach(key => { formData[key] = String(values[key]); });
    return api.upload('/api/shouts', notice.audioFile.path, formData);
  },

  async sendNotice() {
    if (this.data.busy || this.data.fileBusy || this.data.uncertain || this.data.loading) return;
    if (!api.getUser()) { this.setData({ sessionExpired: true }); return; }
    let notice;
    try { notice = notices.buildNotice(this.data, this.data.classes[this.data.classIndex]); }
    catch (error) { this.setData({ error: error.message }); return; }
    const visibility = this._visibilityGeneration;
    const generation = ++this._sendReadGeneration;
    let attempted = false, completed = false;
    this.stopPreview();
    this.setData({ busy: true, phase: '正在核对禁言时间…', error: '', sessionExpired: false });
    try {
      const schedule = await api.request('/api/quiet-hours', { method: 'GET' });
      if (generation !== this._sendReadGeneration || !this.canContinue(visibility, notice)) return;
      const quietPeriod = schedule.activePeriod;
      this.setData({ phase: '请确认通知' });
      if (!await ui.confirm(quietPeriod ? '禁言时间发送确认' : '确认发送通知', notices.confirmationText(notice, quietPeriod), quietPeriod ? '仍然发送' : '确认发送')) return;
      if (!this.canContinue(visibility, notice)) return;
      this.setData({ phase: '正在发送' });
      let result;
      try {
        attempted = true;
        result = await this.postNotice(notice, Boolean(quietPeriod));
      } catch (error) {
        const code = error.code || (error.data && error.data.code);
        if (error.status !== 409 || code !== 'quiet_confirmation_required' || !this.canContinue(visibility, notice)) throw error;
        ui.fail(this, error);
        this.setData({ phase: '请确认禁言时间发送' });
        const period = (error.data && error.data.quietPeriod) || {};
        if (!await ui.confirm('当前处于禁言时间', `${error.message}\n${notices.confirmationText(notice, period)}`, '仍然发送')) return;
        if (!this.canContinue(visibility, notice)) return;
        this.setData({ phase: '正在发送', error: '' });
        result = await this.postNotice(notice, true);
      }
      if (!this.sameUser()) return;
      if (!result || !result.id || !['sent', 'offline'].includes(result.status)) {
        const error = new Error('服务器未返回明确的发送结果。'); error.ambiguous = true; throw error;
      }
      const offline = result.status === 'offline';
      const patch = {
        error: '', lastResult: { id: result.id, status: result.status, classId: notice.values.classId, className: notice.className,
          label: offline ? '教室离线，通知未送达' : '已发往教室，尚未确认送达',
          detail: offline ? `${result.detail || '教室离线。'} 恢复网络后不会补播，草稿已保留。` : '请刷新最近通知或进入通知记录核对收到、展示与知晓状态。' }
      };
      if (!offline && notice.audioFile && this.data.audioFile && this.data.audioFile.path === notice.audioFile.path) patch.audioFile = null;
      if (!offline && !notice.audioFile && this.data.text === notice.originalText) { patch.text = ''; patch.textCount = 0; }
      this.setData(patch);
      this.markDraft();
      completed = true;
    } catch (error) {
      if (error.code === 'session_changed') return;
      if (!attempted && (!this._visible || generation !== this._sendReadGeneration)) return;
      ui.fail(this, error);
      if (attempted && (error.ambiguous || error.code === 'timeout')) {
        this._uncertainNotice = notice;
        this.setData({ uncertain: true, uncertainClassName: notice.className, recordsOpened: false });
      }
    } finally {
      this.setData({ busy: false, phase: '' });
    }
    if (completed && this._visible && this.sameUser()) await this.loadClassData();
  },

  openHistory() {
    if (this.data.busy || this.data.fileBusy) return;
    const classId = this.data.uncertain && this._uncertainNotice ? this._uncertainNotice.values.classId : this.data.classId;
    wx.navigateTo({
      url: `/pages/history/index?${ui.query({ classId })}`,
      success: () => { if (this.data.uncertain) this.setData({ recordsOpened: true }); },
      fail: () => ui.toast('通知记录暂时无法打开。')
    });
  },

  async resolveUncertain() {
    if (this.data.busy || !this.data.uncertain || !this.data.recordsOpened) return;
    this.setData({ busy: true });
    try {
      const accepted = await ui.confirm('解除重复发送保护', `请确认已核对 ${this.data.uncertainClassName} 的通知记录。若记录中已有这条通知，请勿再次发送；收到、展示或知晓尚未更新也不代表未发出。仅在确认未发出时解除保护。`, '确认解锁');
      if (accepted && this._visible) { this._uncertainNotice = null; this.setData({ uncertain: false, recordsOpened: false, error: '' }); }
    } finally { this.setData({ busy: false }); }
  },

  relogin() { ui.relogin(); }
});

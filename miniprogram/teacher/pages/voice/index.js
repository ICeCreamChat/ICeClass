'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
Page({
  data: { classes: [], classNames: [], classIndex: 0, classId: '', messages: [], loading: false, busy: false, playingId: '', error: '', sessionExpired: false },
  onShow() { if (ui.requireLogin()) this.load(); },
  onHide() { this._generation = (this._generation || 0) + 1; this._playGeneration = (this._playGeneration || 0) + 1; if (this._audio) { this._audio.stop(); this._audio.destroy(); this._audio = null; } this.setData({ playingId: '', busy: Boolean(this._deleting), loading: false }); },
  onUnload() { this.onHide(); },
  onPullDownRefresh() { this.load(); },
  async load() {
    if (!ui.requireLogin()) { wx.stopPullDownRefresh(); return; }
    const generation = this._generation = (this._generation || 0) + 1;
    this.setData({ loading: true, error: '', sessionExpired: false });
    try {
      if (!(api.getUser().permissions || {}).receiveClassroomVoice) throw new Error('教室来音仅供本班班主任和上级管理人员接收。');
      await ui.loadClasses(this);
      if (generation !== this._generation) return;
      const classes = this.data.classes.filter(item => item.canReceiveVoice);
      const classIndex = Math.max(0, classes.findIndex(item => item.id === this.data.classId));
      const classId = classes[classIndex] ? classes[classIndex].id : '';
      if (generation !== this._generation) return;
      this.setData({ classes, classNames: classes.map(item => item.name), classIndex, classId });
      if (!classId) { this.setData({ messages: [] }); return; }
      const data = await api.request('/api/classroom-voice?' + ui.query({ classId }));
      if (generation === this._generation) this.setData({ messages: data.messages.map(item => ({ ...item, time: ui.formatTime(item.created_at), duration: Math.round(item.audio_duration_ms / 1000) })) });
    } catch (error) { if (generation === this._generation) ui.fail(this, error); }
    finally { if (generation === this._generation) this.setData({ loading: false }); wx.stopPullDownRefresh(); }
  },
  changeClass(event) { if (this.data.busy) return; this.onHide(); ui.chooseClass(this, event.detail.value); this.setData({ messages: [] }); this.load(); },
  async play(event) {
    if (this.data.busy) return;
    const item = this.data.messages.find(row => row.id === event.currentTarget.dataset.id); if (!item) return;
    if (this.data.playingId === item.id) { this.onHide(); return; }
    if (this._audio) { this._audio.stop(); this._audio.destroy(); }
    const generation = this._playGeneration = (this._playGeneration || 0) + 1;
    this.setData({ busy: true, error: '', playingId: '' });
    try {
      const path = await api.download(item.audio_url);
      if (generation !== this._playGeneration) return;
      const audio = this._audio = wx.createInnerAudioContext();
      audio.onPlay(() => { if (generation === this._playGeneration) this.setData({ playingId: item.id, messages: this.data.messages.map(row => row.id === item.id ? { ...row, played_by_me: true } : row) }); });
      audio.onEnded(() => { if (generation === this._playGeneration) this.setData({ playingId: '' }); });
      audio.onError(() => { if (generation === this._playGeneration) this.setData({ error: '录音播放失败，请重新尝试。', playingId: '' }); });
      audio.src = path; audio.play();
    } catch (error) { if (generation === this._playGeneration) ui.fail(this, error); }
    finally { if (generation === this._playGeneration) this.setData({ busy: false }); }
  },
  async remove(event) {
    if (this.data.busy || this._deleting || !ui.requireLogin()) return;
    const item = this.data.messages.find(row => row.id === event.currentTarget.dataset.id); if (!item) return;
    const generation = this._generation;
    this._deleting = true;
    this.setData({ busy: true, error: '' });
    try {
      if (!await ui.confirm('删除来音', '删除' + item.class_name + '在' + item.time + '发送的来音和原始音频？', '删除来音')) return;
      if (generation !== this._generation) return;
      await api.request('/api/classroom-voice/' + encodeURIComponent(item.id), { method: 'DELETE' });
      if (this.data.playingId === item.id && this._audio) this._audio.stop();
      if (generation === this._generation) await this.load();
    } catch (error) { ui.fail(this, error); } finally { this._deleting = false; this.setData({ busy: false }); }
  },
  relogin: ui.relogin
});

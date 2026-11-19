'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const statuses = { pending: '待评审', adopted: '已采纳', implementing: '实现中', launched: '已上线', declined: '暂不采纳' };
const statusKeys = Object.keys(statuses);
const publicStatuses = ['adopted', 'implementing', 'launched'];
const lists = '/api/ideas/admin';
const pageSize = 20;

function isSuperadmin(user) {
  return Boolean(user && user.role === 'superadmin');
}

function viewItem(item, admin) {
  return {
    ...item, title: admin ? item.title : item.publishedTitle, text: admin ? item.text : item.publishedText,
    statusText: statuses[item.status] || '状态未明', time: ui.formatTime(item.updatedAt),
    media: admin && Array.isArray(item.media) ? item.media.map((media, index) => ({
      id: media.id, kind: media.kind, label: (media.kind === 'audio' ? '播放原始录音' : '查看图片') + (item.media.length > 1 ? ' ' + (index + 1) : '')
    })) : []
  };
}

function draftOf(item) {
  return {
    status: item.status, reply: item.reply || '', published: Boolean(item.published),
    publishedTitle: item.publishedTitle || '', publishedText: item.publishedText || '',
    version: item.version
  };
}

Page({
  data: {
    items: [], page: 1, total: 0, loading: false, error: '', sessionExpired: false, admin: false,
    statusFilters: ['全部状态', ...Object.values(statuses)], statusLabels: Object.values(statuses), filterIndex: 0,
    editId: '', draft: null, editStatusIndex: 0, saving: false, notice: '', conflict: false, mediaBusy: false, playingId: ''
  },
  onShow() {
    this._visible = true;
    if (!ui.requireLogin()) return;
    this.setData({ admin: api.getUser().role === 'superadmin' });
    if (!this.data.draft && !this.data.saving) return this.load();
    this.setData({ sessionExpired: false });
  },
  onHide() {
    this._visible = false;
    this._generation = (this._generation || 0) + 1;
    this.stopMedia();
    this.setData({ loading: false, mediaBusy: false });
  },
  onUnload() { this.onHide(); ui.setDirty(false); },
  onPullDownRefresh() { if (this.data.draft) wx.stopPullDownRefresh(); else this.load(); },
  current(gen, owner) {
    if (!this._visible || this._generation !== gen) return false;
    const user = api.getUser();
    return (user ? user.id : undefined) === owner;
  },
  async load() {
    if (!ui.requireLogin() || this.data.draft || this.data.saving) { wx.stopPullDownRefresh(); return; }
    const generation = this._generation = (this._generation || 0) + 1;
    const owner = api.getUser().id;
    this.setData({ loading: true, error: '', sessionExpired: false });
    try {
      const data = await api.request((this.data.admin ? lists : '/api/ideas/showcase') + '?' + ui.query({
        page: this.data.page, pageSize, status: this.data.admin ? statusKeys[this.data.filterIndex - 1] : ''
      }));
      if (this.current(generation, owner)) this.setData({ items: data.items.map(item => viewItem(item, this.data.admin)), total: data.total });
    } catch (error) { if (this._visible && generation === this._generation) ui.fail(this, error); }
    finally { if (this._visible && generation === this._generation) this.setData({ loading: false }); wx.stopPullDownRefresh(); }
  },
  filter(event) {
    if (this.data.draft || this.data.loading || !this.data.admin) return;
    const index = Number(event.detail.value);
    if (!Number.isInteger(index) || index < 0 || index >= this.data.statusFilters.length) return;
    this.setData({ page: 1, filterIndex: index, items: [] });
    return this.load();
  },
  previous() { return this.movePage(-1); },
  next() { return this.movePage(1); },
  movePage(delta) {
    if (this.data.loading || this.data.draft) return;
    const page = this.data.page + delta;
    if (page <= 0 || (page - 1) * pageSize >= this.data.total) return;
    this.setData({ page, items: [] });
    return this.load();
  },
  edit(event) {
    if (!this.data.admin || !isSuperadmin(api.getUser()) || this.data.draft || this.data.sessionExpired || this.data.loading) return;
    const item = this.data.items.find(row => row.id === event.currentTarget.dataset.id);
    if (!item || !Number.isInteger(item.version)) return;
    this.setData({ editId: item.id, draft: draftOf(item), editStatusIndex: statusKeys.indexOf(item.status), notice: '', error: '', conflict: false });
  },
  draftValue(key, value) {
    if (!this.data.draft || this.data.saving) return;
    this.setData({ draft: { ...this.data.draft, [key]: value } });
    ui.setDirty(true);
  },
  draftInput(event) {
    const key = event.currentTarget.dataset.field;
    if (['reply', 'publishedTitle', 'publishedText'].includes(key)) this.draftValue(key, event.detail.value);
  },
  draftStatus(event) {
    const index = Number(event.detail.value);
    if (!statusKeys[index] || this.data.saving) return;
    this.draftValue('status', statusKeys[index]);
    this.setData({ editStatusIndex: index });
  },
  draftPublished(event) { this.draftValue('published', event.detail.value === true); },
  resetEditor() {
    this.setData({ draft: null, editId: '', conflict: false, error: '' });
    ui.setDirty(false);
  },
  async discard() {
    if (!this.data.draft || this.data.saving) return;
    const item = this.data.items.find(row => row.id === this.data.editId);
    const changed = !item || JSON.stringify(this.data.draft) !== JSON.stringify(draftOf(item));
    if (changed && !await ui.confirm('放弃评审草稿', '当前修改将丢失。', '放弃')) return;
    if (!this._visible || this.data.saving) return;
    const reload = this.data.conflict;
    this.resetEditor();
    if (reload) await this.load();
  },
  async save() {
    const owner = api.getUser();
    if (!this._visible || !isSuperadmin(owner) || this.data.saving || this.data.conflict || this.data.sessionExpired || !this.data.draft) return;
    const original = this.data.items.find(item => item.id === this.data.editId);
    if (!original) return;
    const draft = { ...this.data.draft };
    if (draft.published && (!publicStatuses.includes(draft.status) || !draft.publishedTitle.trim() || !draft.publishedText.trim())) {
      this.setData({ error: '公开前请选择已采纳、实现中或已上线，并填写公开标题和摘要。' });
      return;
    }
    const gen = this._generation;
    this.setData({ saving: true, error: '', notice: '' });
    try {
      if (draft.published || original.published) {
        const message = draft.published ? '“' + draft.publishedTitle.trim() + '”将展示给学生和教师。请先核对，移除个人信息。' : '此创意将从公开展示中撤下。';
        if (!await ui.confirm(draft.published ? '确认公开内容' : '撤下公开内容', message, draft.published ? '确认公开' : '确认撤下')) return;
      }
      if (!this.current(gen, owner.id)) return;
      const result = await api.request(lists + '/' + encodeURIComponent(original.id), { method: 'PUT', data: draft });
      if (!result.item || result.item.id !== original.id || result.item.version <= draft.version) {
        throw Object.assign(new Error('未能确认保存结果，请核对创意记录。'), { ambiguous: true });
      }
      if (!this.current(gen, owner.id)) { this.setData({ conflict: true }); return; }
      const changed = viewItem(result.item, true);
      const filter = statusKeys[this.data.filterIndex - 1];
      // Keep the saved item visible until the user refreshes to avoid moving their focus.
      this.setData({
        items: this.data.items.map(item => item.id === original.id ? changed : item),
        notice: filter && filter !== changed.status ? '评审已保存。刷新后，这条创意将移到对应状态。' : '评审已保存。'
      });
      this.resetEditor();
    } catch (error) {
      if (error.status === 409 || error.ambiguous) this.setData({ conflict: true });
      if (this._visible && gen === this._generation) {
        if (error.status === 404 || error.status === 405) this.setData({ error: '此服务器暂未提供小程序评审接口，请在网页工作台保存。' });
        else ui.fail(this, error);
      }
    } finally { this.setData({ saving: false }); }
  },
  stopMedia() {
    const audio = this._audio;
    this._audio = null;
    if (audio) { audio.destroy(); this.setData({ playingId: '' }); }
  },
  async openMedia(event) {
    if (!this._visible || this.data.mediaBusy || !this.data.admin || !isSuperadmin(api.getUser())) return;
    const { id } = event.currentTarget.dataset;
    const media = this.data.items.flatMap(item => item.media).find(item => item.id === id);
    if (!media) return;
    const wasPlaying = this.data.playingId === id;
    this.stopMedia();
    if (wasPlaying) return;
    const gen = this._generation, owner = api.getUser().id;
    this.setData({ mediaBusy: true, error: '' });
    try {
      const path = await api.download('/api/ideas/media/' + encodeURIComponent(id));
      if (!this.current(gen, owner)) return;
      if (media.kind !== 'audio') wx.previewImage({ urls: [path], fail: () => ui.toast('附件无法打开。') });
      else {
        const player = wx.createInnerAudioContext();
        this._audio = player;
        player.src = path;
        player.onEnded(() => { if (this._audio === player) this.stopMedia(); });
        player.onError(() => { if (this._audio === player) { this.stopMedia(); ui.toast('试听失败。'); } });
        this.setData({ playingId: id });
        player.play();
      }
    } catch (error) { if (this._visible && gen === this._generation) ui.fail(this, error); }
    finally { if (this._visible && gen === this._generation) this.setData({ mediaBusy: false }); }
  },
  relogin: ui.relogin
});

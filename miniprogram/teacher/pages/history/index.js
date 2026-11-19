'use strict';

const api = require('../../lib/api');
const ui = require('../../lib/ui');
const { mapHistoryItem } = require('../../lib/notice-data');
const PAGE_SIZE = 20;

Page({
  data: {
    classes: [], classNames: [], classIndex: -1, classId: '',
    filterNames: ['全部可见班级'], filterIndex: 0, filterClassId: '',
    loading: false, loadingMore: false, items: [], offset: 0, hasMore: false,
    error: '', sessionExpired: false
  },

  onLoad(options) {
    this._generation = 0;
    this._visible = false;
    this.setData({ filterClassId: options && options.classId ? String(options.classId) : '' });
  },

  onShow() {
    this._visible = true;
    if (!ui.requireLogin()) return;
    const user = api.getUser();
    if (this._ownerId !== user.id) {
      this._ownerId = user.id;
      this.setData({ classes: [], classNames: [], classIndex: -1, classId: '', filterNames: ['全部可见班级'], filterIndex: 0 });
    }
    return this.refresh();
  },

  onHide() { this.invalidateReads(); },
  onUnload() { this.invalidateReads(); },

  invalidateReads() {
    this._visible = false;
    this._generation += 1;
    this.setData({ loading: false, loadingMore: false });
  },

  current(generation, classId) {
    return this._visible && generation === this._generation && (classId === undefined || classId === this.data.filterClassId);
  },

  sameUser() {
    const user = api.getUser();
    return Boolean(user && user.id === this._ownerId);
  },

  async refresh() {
    if (!api.getUser()) { this.setData({ sessionExpired: true }); return; }
    const generation = ++this._generation;
    this.setData({ loading: true, loadingMore: false, items: [], offset: 0, hasMore: false, error: '', sessionExpired: false });
    const target = {
      data: { ...this.data },
      setData: patch => {
        if (this.current(generation) && this.sameUser()) { Object.assign(target.data, patch); this.setData(patch); }
      }
    };
    try {
      const classes = await ui.loadClasses(target, () => this.current(generation) && this.sameUser());
      if (!this.current(generation) || !this.sameUser()) return;
      const classId = this.data.filterClassId;
      const index = classes.findIndex(item => item.id === classId);
      this.setData({ filterNames: ['全部可见班级', ...classes.map(item => item.name)], filterIndex: classId ? index + 1 : 0 });
      if (classId && index < 0) { this.setData({ error: '所选班级当前不可用，请重新选择有权限的班级。', filterIndex: 0 }); return; }
      await this.readHistory(generation, false);
    } catch (error) {
      if (this.current(generation)) ui.fail(this, error);
    } finally {
      if (this.current(generation)) this.setData({ loading: false });
    }
  },

  async readHistory(generation, append) {
    const classId = this.data.filterClassId, offset = append ? this.data.offset : 0;
    try {
      const response = await api.request(`/api/history?${ui.query({ classId, limit: PAGE_SIZE, offset })}`, { method: 'GET' });
      if (!this.current(generation, classId) || !this.sameUser()) return;
      const next = response.history.map(item => mapHistoryItem(item, ui.formatTime));
      const seen = new Set();
      const items = (append ? this.data.items.concat(next) : next).filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id); return true;
      });
      this.setData({ items, offset: offset + response.history.length, hasMore: response.hasMore === true });
    } catch (error) {
      if (this.current(generation, classId)) ui.fail(this, error);
    } finally {
      if (this.current(generation, classId)) this.setData({ loading: false, loadingMore: false });
    }
  },

  onClassChange(event) {
    const index = Number(event.detail.value);
    if (!Number.isInteger(index) || index < 0 || index >= this.data.filterNames.length) return;
    const classId = index ? this.data.classes[index - 1].id : '';
    if (classId === this.data.filterClassId && !this.data.error) return;
    const generation = ++this._generation;
    // Clear the previous class before changing the selection or starting a read.
    this.setData({ filterIndex: index, filterClassId: classId, items: [], offset: 0, hasMore: false, error: '', loading: true, loadingMore: false });
    if (index) ui.chooseClass(this, index - 1);
    return this.readHistory(generation, false);
  },

  loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore || this.data.sessionExpired || !api.getUser()) return;
    const generation = ++this._generation;
    this.setData({ loadingMore: true, error: '' });
    return this.readHistory(generation, true);
  },

  onReachBottom() { return this.loadMore(); },

  async onPullDownRefresh() {
    try { await this.refresh(); } finally { wx.stopPullDownRefresh(); }
  },

  relogin() { ui.relogin(); }
});

'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const { manager: canManageDevices, quotaAdmin } = require('../../lib/settings-data');

const quick = [
  { page: 'notices', name: '班级通知', detail: '发送文字或原声', icon: 'notice' },
  { page: 'paper', name: '纸卡答题', detail: '课堂与答题分析', icon: 'paper' }
];
const classroom = [
  { page: 'reading', name: '早读统计', icon: 'reading' },
  { page: 'homework', name: '作业统计', icon: 'homework' },
  { page: 'island', name: '教室浮岛', icon: 'calendar' },
  { page: 'voice', name: '教室来音', icon: 'voice' },
  { page: 'study', name: '晚自习管理', icon: 'study' },
  { page: 'history', name: '通知记录', icon: 'history' },
  { page: 'quiet', name: '禁言时间', icon: 'quiet' },
  { page: 'questions', name: '题库与题单', icon: 'questions' }
];

Page({
  data: { user: null, classes: [], classNames: [], classIndex: 0, classId: '', quick, teaching: classroom, management: [], loading: false, error: '', sessionExpired: false },
  onShow() { if (ui.requireLogin()) this.load(); },
  onHide() { this._generation = (this._generation || 0) + 1; },
  onUnload() { this.onHide(); },
  onPullDownRefresh() { if (ui.requireLogin()) this.load(); else wx.stopPullDownRefresh(); },
  async load() {
    const generation = this._generation = (this._generation || 0) + 1;
    this.setData({ loading: true, error: '', sessionExpired: false });
    try {
      const user = await api.restoreSession();
      if (generation !== this._generation) return;
      if (!user) { ui.relogin(); return; }
      const permissions = user.permissions || {};
      const teaching = classroom.slice();
      if (permissions.controlClassrooms) teaching.splice(4, 0, { page: 'controls', name: '教室控制', icon: 'controls' });
      const management = [];
      if (permissions.manageClasses) management.push({ page: 'classes', name: '班级管理', icon: 'classes' });
      if (permissions.manageUsers) management.push({ page: 'users', name: '用户管理', icon: 'users' });
      if (canManageDevices(user)) management.push({ page: 'device-settings', name: '教室电脑设置', icon: 'controls' });
      if (quotaAdmin(user)) management.push({ page: 'quota-settings', name: '班班次数', icon: 'banban-quota' });
      this.setData({ user, teaching, management });
      await ui.loadClasses(this);
    } catch (error) { if (generation === this._generation) ui.fail(this, error); }
    finally { if (generation === this._generation) this.setData({ loading: false }); wx.stopPullDownRefresh(); }
  },
  changeClass(event) { if (!this.data.loading) ui.chooseClass(this, event.detail.value); },
  open(event) {
    const page = event.currentTarget.dataset.page;
    if ([...quick, ...this.data.teaching, ...this.data.management].some(item => item.page === page) || ['account', 'ideas', 'banban'].includes(page)) {
      wx.navigateTo({ url: `/pages/${page}/index`, fail: () => ui.toast('页面暂时无法打开，请重试。') });
    }
  },
  relogin: ui.relogin
});

'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const roles = { superadmin: '超级管理员', principal: '校长', director: '主任', grade_leader: '年级负责人', teacher: '班主任', subject_teacher: '任课教师' };
Page({
  data: { user: null, roleName: '', currentPassword: '', newPassword: '', repeatPassword: '', busy: false, error: '', sessionExpired: false, warning: '',
    appearanceOptions: ui.appearances || [], appearanceWarning: '' },
  onShow() {
    this._visible = true;
    if (!ui.requireLogin()) return;
    const user = api.getUser();
    this.setData({ user, roleName: roles[user.role] || user.role, warning: api.getPersistenceWarning(),
      ...(this.data.sessionExpired ? { sessionExpired: false, error: '' } : {}) });
    ui.setDirty(Boolean(this.data.currentPassword || this.data.newPassword || this.data.repeatPassword));
  },
  onHide() { this._visible = false; },
  onUnload() { this.onHide(); ui.setDirty(false); },
  input(event) { const key = event.currentTarget.dataset.field; if (['currentPassword', 'newPassword', 'repeatPassword'].includes(key)) { this.setData({ [key]: event.detail.value }); ui.setDirty(true); } },
  changeAppearance(event) {
    const mode = event.currentTarget.dataset.mode;
    if (!this.data.appearanceOptions.some(item => item.id === mode)) return;
    const saved = ui.setAppearance(this, mode);
    this.setData({ appearanceWarning: saved ? '' : '已切换外观。本机未能保存偏好，下次打开时可能需要重新选择。' });
  },
  async password() {
    if (this.data.busy) return;
    const length = Array.from(this.data.newPassword).length;
    if (!this.data.currentPassword || length < 10 || length > 128 || !/[A-Za-z]/.test(this.data.newPassword) || !/[0-9]/.test(this.data.newPassword)) { this.setData({ error: '请输入当前密码；新密码须为 10-128 个字符，并同时包含字母和数字。' }); return; }
    if (this.data.newPassword !== this.data.repeatPassword) { this.setData({ error: '两次输入的新密码不一致。' }); return; }
    const owner = api.getUser(); if (!owner) { ui.relogin(); return; }
    this.setData({ busy: true, error: '' });
    try {
      if (!await ui.confirm('修改密码', '修改成功后，所有设备上的学校账号登录都会失效，需要使用新密码重新登录。', '修改密码')) return;
      if (!this._visible || !api.getUser() || api.getUser().id !== owner.id) return;
      await api.request('/api/auth/password', { method: 'PUT', data: { currentPassword: this.data.currentPassword, newPassword: this.data.newPassword } });
      api.clearSession(); ui.setDirty(false);
      this.setData({ currentPassword: '', newPassword: '', repeatPassword: '' });
      ui.toast('密码已修改，请重新登录'); ui.relogin();
    } catch (error) { ui.fail(this, error); }
    finally { this.setData({ busy: false }); }
  },
  async logout() {
    if (this.data.busy) return;
    const owner = api.getUser(); if (!owner) { ui.relogin(); return; }
    this.setData({ busy: true, error: '' });
    try {
      if (!await ui.confirm('退出登录', '退出后需要重新输入学校账号和密码。', '退出登录')) return;
      if (!this._visible || !api.getUser() || api.getUser().id !== owner.id) return;
      await api.logout(); ui.setDirty(false); wx.reLaunch({ url: '/pages/login/index' });
    }
    catch (error) { ui.fail(this, error); }
    finally { this.setData({ busy: false }); }
  },
  openBanbanSetting(event) {
    const setting = event.currentTarget.dataset.setting;
    if (['connection', 'quota'].includes(setting) && !this.data.busy && ui.requireLogin()) {
      wx.navigateTo({ url: '/pages/' + setting + '-settings/index', fail: () => ui.toast('暂时无法打开设置。') });
    }
  },
  privacy() { wx.navigateTo({ url: '/pages/privacy/index' }); },
  relogin: ui.relogin
});

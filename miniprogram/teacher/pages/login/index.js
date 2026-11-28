'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');

Page({
  data: { username: '', password: '', passwordHidden: true, passwordFocus: false, accepted: false, busy: false, error: '' },
  onShow() { ui.applyAppearance(this); },
  onHide() {
    if (!this._attempt) return;
    this._attempt = null;
    this.setData({ busy: false, password: '', passwordHidden: true, passwordFocus: false });
  },
  onUnload() { this._attempt = null; },
  input(event) { const key = event.currentTarget.dataset.field; if (['username', 'password'].includes(key)) this.setData({ [key]: event.detail.value }); },
  focusPassword() { if (!this.data.busy && !this.data.passwordFocus) this.setData({ passwordFocus: true }); },
  blurPassword() { if (this.data.passwordFocus) this.setData({ passwordFocus: false }); },
  togglePassword() { this.setData({ passwordHidden: !this.data.passwordHidden }); },
  changeConsent(event) {
    if (this.data.busy || this._leaving) return;
    this.setData({ accepted: event.detail.value.includes('agree'), error: '' });
  },
  async submit() {
    if (this.data.busy || this._leaving) return;
    if (!this.data.accepted) { this.setData({ error: '请先阅读协议并勾选同意。不同意可取消登录。' }); return; }
    if (!this.data.username.trim() || !this.data.password) { this.setData({ error: '请输入学校账号和密码。' }); return; }
    const attempt = this._attempt = {};
    const isCurrent = () => this._attempt === attempt;
    this.setData({ busy: true, error: '' });
    try {
      await api.login(this.data.username, this.data.password, isCurrent);
      if (!isCurrent()) return;
      const warning = api.getPersistenceWarning();
      this.leave();
      if (warning) ui.toast(warning);
    } catch (error) {
      if (!isCurrent()) return;
      this._attempt = null;
      this.setData({ busy: false, error: error.message });
    }
  },
  leave() {
    if (this._leaving) return;
    this._leaving = true;
    this._attempt = null;
    this.setData({ username: '', password: '', passwordHidden: true, passwordFocus: false, accepted: false, busy: false, error: '' });
    const home = () => wx.reLaunch({
      url: '/pages/workbench/index',
      fail: () => { this._leaving = false; this.setData({ error: '未能返回首页，请重试。' }); }
    });
    if (getCurrentPages().length > 1) wx.navigateBack({ fail: home });
    else home();
  },
  openAgreement: ui.openAgreement
});

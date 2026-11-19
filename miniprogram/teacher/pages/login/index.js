'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');

Page({
  data: { username: '', password: '', passwordHidden: true, passwordFocus: false, busy: false, error: '', warning: '' },
  onShow() { ui.applyAppearance(this); },
  input(event) { const key = event.currentTarget.dataset.field; if (['username', 'password'].includes(key)) this.setData({ [key]: event.detail.value }); },
  focusPassword() { if (!this.data.busy && !this.data.passwordFocus) this.setData({ passwordFocus: true }); },
  blurPassword() { if (this.data.passwordFocus) this.setData({ passwordFocus: false }); },
  togglePassword() { this.setData({ passwordHidden: !this.data.passwordHidden }); },
  async submit() {
    if (this.data.busy) return;
    if (!this.data.username.trim() || !this.data.password) { this.setData({ error: '请输入学校账号和密码。' }); return; }
    this.setData({ busy: true, error: '' });
    try {
      await api.login(this.data.username, this.data.password);
      this.setData({ password: '', passwordHidden: true, passwordFocus: false, warning: api.getPersistenceWarning() });
      if (this.data.warning) await ui.confirm('登录成功', this.data.warning, '继续');
      const pages = getCurrentPages();
      if (pages.length > 1) wx.navigateBack();
      else wx.reLaunch({ url: '/pages/workbench/index' });
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ busy: false }); }
  },
  privacy() { wx.navigateTo({ url: '/pages/privacy/index' }); }
});

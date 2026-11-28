'use strict';
const ui = require('../../lib/ui');
Page({
  data: { terms: false, error: '' },
  onLoad(options) { if (options.document === 'terms') this.setData({ terms: true }); },
  onShow() {
    ui.applyAppearance(this);
    if (this.data.terms) wx.setNavigationBarTitle({ title: '用户服务协议' });
  },
  openPlatformPrivacy() {
    this.setData({ error: '' });
    const unavailable = () => this.setData({ error: '暂时无法打开微信公示的隐私保护指引，可继续阅读本页。' });
    if (typeof wx.openPrivacyContract === 'function') wx.openPrivacyContract({ fail: unavailable });
    else unavailable();
  }
});

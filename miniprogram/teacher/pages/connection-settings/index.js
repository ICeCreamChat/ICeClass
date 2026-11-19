'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const settings = require('../../lib/settings-data');

Page({
  data: { workspace: 'account', canManageSchool: false, loading: false, busy: false, draft: null,
    configured: false, keyConfigured: false, savedEnabled: false, savedSource: '', schoolLabel: '', dirty: false, conflict: false,
    uncertain: false, error: '', status: '', sessionExpired: false },
  onShow() {
    this._visible = true;
    if (!ui.requireLogin()) { settings.invalidate(this); return; }
    this.setData({ sessionExpired: false });
    this.syncDirty();
    if (this.data.busy || this.data.dirty || this.data.conflict || this.data.uncertain) return;
    return this.load();
  },
  onHide() { this.leave(); },
  onUnload() { this.leave(); },
  leave() {
    this._visible = false; settings.invalidate(this);
    this.setData({ loading: false, ...(this._writeStarted ? { uncertain: true,
      status: '操作期间离开了页面，请重新载入核对结果。连接草稿已保留。' } : {}) });
    this.stash(); settings.dirty(ui, false);
  },
  relogin() { ui.relogin(); },
  async onPullDownRefresh() {
    try { if (ui.requireLogin()) await this.refresh(); }
    finally { wx.stopPullDownRefresh(); }
  },
  stash() {
    if (!this.data.draft) return;
    this._spaces = this._spaces || {};
    this._spaces[this.data.workspace] = { basis: this._basis, draft: settings.copy(this.data.draft),
      dirty: this.data.dirty, conflict: this.data.conflict, uncertain: this.data.uncertain,
      configured: this.data.configured, keyConfigured: this.data.keyConfigured, savedEnabled: this.data.savedEnabled, savedSource: this.data.savedSource, schoolLabel: this.data.schoolLabel };
  },
  syncDirty() {
    this.stash();
    settings.dirty(ui, Object.values(this._spaces || {}).some(space => space && space.dirty));
  },
  showError(error) {
    const secrets = [this.data.draft && this.data.draft.apiKey,
      ...Object.values(this._spaces || {}).map(space => space && space.draft.apiKey)];
    ui.fail(this, settings.safeError(error, secrets));
  },
  install(value, workspace) {
    this._basis = value;
    this.setData({ draft: settings.connectionDraft(value, workspace), dirty: false, conflict: false, uncertain: false,
      configured: value.configured, keyConfigured: workspace === 'school' ? value.configured : value.personal.configured,
      savedEnabled: value.enabled, savedSource: workspace === 'school' ? '学校连接' : value.source === 'school' ? '学校连接' : '自己的连接',
      schoolLabel: workspace === 'school' ? '' : `${value.school.enabled ? '已启用' : '已停用'} · ${value.school.configured ? '已配置密钥' : '未配置密钥'}`,
      sessionExpired: false });
    this.syncDirty();
  },
  async load() {
    if (this.data.busy || !api.getUser() || !this._visible) return;
    const token = settings.begin(this, api), workspace = this.data.workspace;
    this.setData({ loading: true, error: '' });
    try {
      const account = settings.accountConnection(await api.request('/api/banban/connection', { method: 'GET' }));
      if (!settings.current(this, token, api)) return;
      const allowed = settings.schoolAdmin(api.getUser(), account.canManageSchool);
      this.setData({ canManageSchool: allowed });
      if (workspace === 'school' && !allowed) throw Object.assign(new Error('没有执行此操作的权限。'), { status: 403 });
      const value = workspace === 'school' ? settings.publicConfig(await api.request('/api/banban/settings', { method: 'GET' })) : account;
      if (!settings.current(this, token, api)) return;
      this.install(value, workspace);
    } catch (error) {
      if (settings.current(this, token, api, true)) this.showError(error);
    } finally { if (settings.current(this, token, api, true)) this.setData({ loading: false }); }
  },
  async changeWorkspace(event) {
    const workspace = event.currentTarget.dataset.workspace;
    if (this.data.busy || this.data.sessionExpired || !['account', 'school'].includes(workspace) || workspace === this.data.workspace ||
      workspace === 'school' && !settings.schoolAdmin(api.getUser(), this.data.canManageSchool)) return;
    this.stash(); settings.invalidate(this);
    const space = (this._spaces || {})[workspace];
    this._basis = space ? space.basis : null;
    this.setData({ workspace, loading: false, error: '', status: '', draft: space ? space.draft : null,
      dirty: space ? space.dirty : false, conflict: space ? space.conflict : false, uncertain: space ? space.uncertain : false,
      configured: space ? space.configured : false, keyConfigured: space ? space.keyConfigured : false, savedEnabled: space ? space.savedEnabled : false,
      savedSource: space ? space.savedSource : '', schoolLabel: space ? space.schoolLabel : '' });
    this.syncDirty();
    if (!space || !space.dirty && !space.conflict && !space.uncertain) return this.load();
  },
  async refresh() {
    if (this.data.busy || !api.getUser() || !this._visible) return;
    const token = settings.begin(this, api);
    this.setData({ busy: true, loading: false });
    let reload = false;
    try {
      reload = !this.data.dirty && !this.data.conflict && !this.data.uncertain || await ui.confirm('重新载入连接',
        `将放弃${this.data.workspace === 'school' ? '学校连接' : '本账号连接'}的未保存草稿，读取最新设置。不会重发保存或连接测试。`, '重新载入');
      reload = reload && settings.current(this, token, api);
    } finally { this.setData({ busy: false }); }
    if (reload) return this.load();
  },
  updateDraft(patch) {
    if (this.data.busy || this.data.loading || this.data.sessionExpired || !this.data.draft) return;
    const draft = { ...this.data.draft, ...patch };
    this.setData({ draft, dirty: JSON.stringify(draft) !== JSON.stringify(settings.connectionDraft(this._basis, this.data.workspace)) });
    this.syncDirty();
  },
  inputField(event) {
    const field = event.currentTarget.dataset.field;
    if (['baseUrl', 'model', 'apiKey'].includes(field)) this.updateDraft({ [field]: event.detail.value });
  },
  changeSource(event) {
    const source = event.currentTarget.dataset.source;
    if (this.data.workspace === 'account' && ['school', 'personal'].includes(source)) this.updateDraft({ source });
  },
  changeFlags(event) {
    this.updateDraft({ enabled: event.detail.value.includes('enabled'), clearKey: event.detail.value.includes('clearKey') });
  },
  canWrite() {
    return this._visible && api.getUser() && !this.data.busy && !this.data.loading && !this.data.sessionExpired &&
      !this.data.conflict && !this.data.uncertain && this.data.draft &&
      (this.data.workspace !== 'school' || settings.schoolAdmin(api.getUser(), this.data.canManageSchool));
  },
  async fresh(token, workspace, basis) {
    const response = await api.request(workspace === 'school' ? '/api/banban/settings' : '/api/banban/connection', { method: 'GET' });
    if (!settings.current(this, token, api)) throw settings.sessionChanged();
    const value = workspace === 'school' ? settings.publicConfig(response) : settings.accountConnection(response);
    if (JSON.stringify(value) !== JSON.stringify(basis)) throw settings.conflict('连接设置已在其他页面修改，草稿已保留。请重新载入后核对。');
  },
  async save() {
    if (!this.canWrite() || !this.data.dirty) return;
    const workspace = this.data.workspace, basis = this._basis;
    let payload;
    try { payload = settings.connectionPayload(this.data.draft, workspace, basis); }
    catch (error) { this.showError(error); return; }
    const token = settings.begin(this, api);
    this.setData({ busy: true, error: '', status: '' });
    const title = workspace === 'school' ? '确认修改学校连接' : '确认修改本账号连接';
    const content = [workspace === 'school' ? '将修改全校共用的班班 AI 连接，影响所有选择学校连接的账号。' :
      payload.source === 'school' ? '本账号将使用学校连接。个人连接草稿不会写入；已有个人配置会保留。' : '将更新本账号自己的班班 AI 连接。',
      'enabled' in payload ? `保存后${payload.enabled ? '启用' : '停用'}该连接。模型：${payload.model || '未设置'}。` : '',
      payload.clearKey ? '将清除已保存的 API Key，连接会失去密钥，需要重新配置。' : payload.apiKey ? '将更换已保存的密钥。' : '',
      '保存不会自动测试连接。'].filter(Boolean).join('\n');
    try {
      if (!await ui.confirm(title, content, '保存连接') || !settings.current(this, token, api)) return;
      await this.fresh(token, workspace, basis);
      if (!settings.current(this, token, api)) return;
      this._writeStarted = true;
      const response = await api.request(workspace === 'school' ? '/api/banban/settings' : '/api/banban/connection', { method: 'PUT', data: payload });
      if (!settings.current(this, token, api)) return;
      let value;
      try { value = workspace === 'school' ? settings.publicConfig(response) : settings.accountConnection(response); }
      catch (_) { throw Object.assign(new Error('保存结果格式异常，请重新载入核对，避免重复保存。'), { ambiguous: true }); }
      this.install(value, workspace);
      this.setData({ status: workspace === 'school' ? '学校连接已保存。尚未执行连接测试。' : '本账号连接已保存。尚未执行连接测试。' });
    } catch (error) {
      if (error.code !== 'session_changed' && settings.current(this, token, api, true)) {
        this.showError(error);
        this.setData({ conflict: error.status === 409, uncertain: Boolean(error.ambiguous) }); this.syncDirty();
      }
    } finally { this._writeStarted = false; this.setData({ busy: false }); }
  },
  async testConnection() {
    if (!this.canWrite() || this.data.dirty || !this.data.configured || !this.data.savedEnabled) return;
    const token = settings.begin(this, api), workspace = this.data.workspace, basis = this._basis;
    this.setData({ busy: true, error: '', status: '' });
    try {
      if (!await ui.confirm('测试已保存的连接', `将向${workspace === 'school' ? '学校共用' : '本账号当前'}已保存的模型服务发送固定测试文字，可能产生服务商费用，不发送班级数据。`, '开始测试') ||
        !settings.current(this, token, api)) return;
      await this.fresh(token, workspace, basis);
      if (!settings.current(this, token, api)) return;
      this._writeStarted = true;
      const response = await api.request('/api/banban/connection/test' + (workspace === 'school' ? '?target=school' : ''), { method: 'POST', data: {} });
      if (!settings.current(this, token, api)) return;
      if (!response || response.ok !== true) throw Object.assign(new Error('连接测试结果未确认，请先重新载入核对。'), { ambiguous: true });
      this.setData({ status: '已保存的连接测试成功。' });
    } catch (error) {
      if (error.code !== 'session_changed' && settings.current(this, token, api, true)) {
        this.showError(error); this.setData({ conflict: error.status === 409, uncertain: Boolean(error.ambiguous) }); this.syncDirty();
      }
    } finally { this._writeStarted = false; this.setData({ busy: false }); }
  }
});

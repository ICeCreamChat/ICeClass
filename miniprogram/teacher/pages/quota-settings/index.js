'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const settings = require('../../lib/settings-data');

Page({
  data: { canManage: false, usage: null, resetLabel: '', loading: false, busy: false, draft: null,
    workspace: 'device', rows: [], search: '', modeLabels: settings.modeLabels, targetModeLabels: settings.targetModeLabels,
    deviceModeIndex: 0, accountModeIndex: 0, editor: null, dirty: false, conflict: false, uncertain: false,
    error: '', status: '', sessionExpired: false },
  onShow() {
    this._visible = true;
    if (!ui.requireLogin()) { settings.invalidate(this); return; }
    this.setData({ canManage: settings.quotaAdmin(api.getUser()), sessionExpired: false });
    settings.dirty(ui, this.data.dirty || Boolean(this.data.editor));
    if (this.data.busy || this.data.dirty || this.data.editor || this.data.conflict || this.data.uncertain) return;
    return this.load();
  },
  onHide() { this.leave(); },
  onUnload() { this.leave(); },
  leave() {
    this._visible = false; settings.invalidate(this);
    this.setData({ loading: false, ...(this._writeStarted ? { uncertain: true, status: '保存期间离开了页面，请重新载入核对。次数草稿已保留。' } : {}) });
    settings.dirty(ui, false);
  },
  relogin() { ui.relogin(); },
  async onPullDownRefresh() {
    try { if (ui.requireLogin()) await this.refresh(); }
    finally { wx.stopPullDownRefresh(); }
  },
  install(config) {
    this._config = config;
    this._initialDraft = settings.quotaDraft(config);
    this.setData({ draft: settings.copy(this._initialDraft), dirty: false, conflict: false, uncertain: false, editor: null, sessionExpired: false });
    const user = api.getUser(), own = config.targets.find(row => row.kind === 'account' && user && row.id === user.id);
    if (own) this.setData({ usage: settings.usageFrom({ kind: 'account', month: config.month, used: own.used, limit: own.limit,
      remaining: own.limit === null ? null : Math.max(0, own.limit - own.used), resetsAt: config.resetsAt, source: own.source }), resetLabel: ui.formatTime(config.resetsAt) });
    settings.dirty(ui, false); this.renderRows();
  },
  async load() {
    if (this.data.busy || !api.getUser() || !this._visible) return;
    const token = settings.begin(this, api), allowed = settings.quotaAdmin(api.getUser());
    this.setData({ loading: true, error: '', canManage: allowed });
    try {
      const usage = settings.usageFrom(await api.request('/api/banban/quota', { method: 'GET' }));
      if (!settings.current(this, token, api)) return;
      this.setData({ usage, resetLabel: ui.formatTime(usage.resetsAt), sessionExpired: false });
      if (allowed) {
        const config = settings.quotasFrom(await api.request('/api/banban/quotas', { method: 'GET' }));
        if (!settings.current(this, token, api)) return;
        this.install(config);
      }
    } catch (error) { if (settings.current(this, token, api, true)) ui.fail(this, error); }
    finally { if (settings.current(this, token, api, true)) this.setData({ loading: false }); }
  },
  async refresh() {
    if (this.data.busy || !api.getUser() || !this._visible) return;
    const token = settings.begin(this, api);
    this.setData({ busy: true, loading: false });
    let reload = false;
    try {
      reload = !this.data.dirty && !this.data.editor && !this.data.conflict && !this.data.uncertain ||
        await ui.confirm('重新载入班班次数', '将放弃当前未保存的默认规则和单独设置，读取最新版本及当月用量。不会重新发送保存请求。', '重新载入');
      reload = reload && settings.current(this, token, api);
    } finally { this.setData({ busy: false }); }
    if (reload) return this.load();
  },
  renderRows() {
    if (!this._config || !this.data.draft) return;
    this.setData({ rows: settings.quotaRows(this._config, this.data.draft, this.data.workspace, this.data.search),
      deviceModeIndex: settings.modes.indexOf(this.data.draft.deviceMode), accountModeIndex: settings.modes.indexOf(this.data.draft.accountMode) });
  },
  canEdit() { return this._visible && settings.quotaAdmin(api.getUser()) && this.data.draft && !this.data.busy && !this.data.loading && !this.data.sessionExpired; },
  updateDraft(draft) {
    this.setData({ draft, dirty: JSON.stringify(draft) !== JSON.stringify(this._initialDraft) });
    settings.dirty(ui, this.data.dirty || Boolean(this.data.editor)); this.renderRows();
  },
  changeDefaultMode(event) {
    const kind = event.currentTarget.dataset.kind, mode = settings.modes[Number(event.detail.value)];
    if (this.canEdit() && ['device', 'account'].includes(kind) && mode) this.updateDraft({ ...this.data.draft, [`${kind}Mode`]: mode });
  },
  inputDefault(event) {
    const kind = event.currentTarget.dataset.kind;
    if (this.canEdit() && ['device', 'account'].includes(kind)) this.updateDraft({ ...this.data.draft, [`${kind}Value`]: event.detail.value });
  },
  changeWorkspace(event) {
    const workspace = event.currentTarget.dataset.workspace;
    if (!this.canEdit() || !['device', 'account'].includes(workspace) || workspace === this.data.workspace) return;
    if (this.data.editor) { ui.toast('请先暂存或取消当前单独设置。'); return; }
    this.setData({ workspace, search: '', rows: [] }); this.renderRows();
  },
  inputSearch(event) { if (!this.data.busy) { this.setData({ search: event.detail.value }); this.renderRows(); } },
  openTarget(event) {
    if (!this.canEdit()) return;
    if (this.data.editor) { ui.toast('请先暂存或取消当前单独设置。'); return; }
    const target = this._config.targets.find(row => row.key === event.currentTarget.dataset.key);
    if (!target) return;
    const override = this.data.draft.overrides.find(row => settings.keyOf(row) === target.key);
    const mode = override ? settings.modeOf(override.limit) : 'inherit';
    const editor = { key: target.key, name: `${target.name}（${target.detail}）`, kind: target.kind,
      modeIndex: settings.targetModes.indexOf(mode), value: override && override.limit !== null ? String(override.limit) : '' };
    this._initialEditor = settings.copy(editor);
    this.setData({ editor }); settings.dirty(ui, true);
  },
  changeTargetMode(event) {
    if (!this.canEdit() || !this.data.editor) return;
    const modeIndex = Number(event.detail.value);
    if (settings.targetModes[modeIndex]) this.setData({ editor: { ...this.data.editor, modeIndex } });
  },
  inputTarget(event) {
    if (this.canEdit() && this.data.editor) this.setData({ editor: { ...this.data.editor, value: event.detail.value } });
  },
  applyTarget() {
    if (!this.canEdit() || !this.data.editor) return;
    const editor = this.data.editor, target = this._config.targets.find(row => row.key === editor.key);
    if (!target) return;
    try {
      const draft = settings.setOverride(this.data.draft, target, settings.targetModes[editor.modeIndex], editor.value);
      this.setData({ editor: null, error: '', status: `“${target.name}”的单独规则已暂存，请点击“保存次数设置”提交。` });
      this.updateDraft(draft);
    } catch (error) { ui.fail(this, error); }
  },
  async cancelTarget() {
    if (this.data.busy || !this.data.editor) return;
    const token = settings.begin(this, api);
    this.setData({ busy: true });
    try {
      if (JSON.stringify(this.data.editor) !== JSON.stringify(this._initialEditor) &&
        !await ui.confirm('放弃单独设置草稿', `将放弃“${this.data.editor.name}”尚未暂存的规则。`, '放弃草稿')) return;
      if (!settings.current(this, token, api)) return;
      this.setData({ editor: null }); settings.dirty(ui, this.data.dirty);
    } finally { this.setData({ busy: false }); }
  },
  async save() {
    if (!this.canEdit() || !this.data.dirty || this.data.editor || this.data.conflict || this.data.uncertain) return;
    let payload;
    try { payload = settings.quotaPayload(this.data.draft); }
    catch (error) { ui.fail(this, error); return; }
    const before = this._config.overrides, after = payload.overrides;
    const changed = this._config.targets.filter(target => {
      const oldRule = before.find(row => settings.keyOf(row) === target.key), newRule = after.find(row => settings.keyOf(row) === target.key);
      return Boolean(oldRule) !== Boolean(newRule) || oldRule && newRule && oldRule.limit !== newRule.limit;
    });
    const lines = [`教室设备默认：${settings.limitLabel(payload.deviceLimit)}`, `教师账号默认：${settings.limitLabel(payload.accountLimit)}`,
      ...changed.slice(0, 8).map(target => {
        const rule = after.find(row => settings.keyOf(row) === target.key);
        return `${target.kind === 'device' ? '设备' : '账号'}“${target.name}（${target.detail}）”：${rule ? settings.limitLabel(rule.limit) : '沿用默认'}`;
      }), changed.length > 8 ? `共调整 ${changed.length} 个对象，完整暂存规则见页面列表。` : '',
      '规则立即生效，0 次会暂停班班使用；保留当月已用次数，下月恢复可用次数。未调整对象的单独设置会保留。'];
    const token = settings.begin(this, api);
    this.setData({ busy: true, error: '', status: '' });
    try {
      if (!await ui.confirm('确认保存班班次数', lines.filter(Boolean).join('\n'), '保存次数') || !settings.current(this, token, api)) return;
      this._writeStarted = true;
      const response = await api.request('/api/banban/quotas', { method: 'PUT', data: payload });
      if (!settings.current(this, token, api)) return;
      let config;
      try { config = settings.quotasFrom(response); if (config.revision !== payload.revision + 1) throw new Error('revision'); }
      catch (_) { throw Object.assign(new Error('保存结果未完整确认，请重新载入核对，避免重复提交。'), { ambiguous: true }); }
      this.install(config);
      this.setData({ status: '班班次数设置已保存，当月已用次数保持不变。' });
    } catch (error) {
      if (error.code !== 'session_changed' && settings.current(this, token, api, true)) {
        ui.fail(this, error); this.setData({ conflict: error.status === 409, uncertain: Boolean(error.ambiguous) });
      }
    } finally { this._writeStarted = false; this.setData({ busy: false }); }
  }
});

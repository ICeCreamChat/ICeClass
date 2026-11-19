'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const manage = require('../../lib/manage-data');

Page({
  data: {
    users: [], totalUsers: 0, classes: [], roles: [], roleNames: [], roleIndex: -1,
    grades: [], gradeIndex: -1, statusNames: ['启用', '停用'], enabledIndex: 0,
    loading: false, busy: false, error: '', status: '', sessionExpired: false, uncertain: false,
    canManage: false, search: '', editorOpen: false, editId: '', draft: null,
    headChoices: [], teachingChoices: [], resetId: '', resetName: '', resetPassword: ''
  },

  onShow() {
    this._visible = true;
    manage.invalidate(this);
    if (!ui.requireLogin()) { this.setData({ sessionExpired: true, loading: false }); return; }
    const actor = api.getUser();
    if (this._actorId && this._actorId !== actor.id) {
      this._users = [];
      this._editing = null;
      this.setData({ users: [], totalUsers: 0, classes: [], roles: [], editorOpen: false, editId: '', draft: null,
        resetId: '', resetName: '', resetPassword: '', uncertain: false, status: '', error: '', search: '' });
    }
    this._actorId = actor.id;
    this.setData({ canManage: manage.permission(actor, 'manageUsers'), sessionExpired: false });
    return this.load();
  },
  onHide() { this._visible = false; manage.invalidate(this); this.setData({ loading: false }); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() {
    try { if (ui.requireLogin()) await this.load(); else this.setData({ sessionExpired: true }); }
    finally { wx.stopPullDownRefresh(); }
  },
  relogin() { ui.relogin(); },
  refresh() { return this.load(); },

  async load() {
    if (this.data.busy || !this._visible) return;
    const generation = manage.invalidate(this);
    const actor = api.getUser();
    if (!actor) { this.setData({ sessionExpired: true }); return; }
    if (!manage.permission(actor, 'manageUsers')) {
      this._users = [];
      this.setData({ users: [], totalUsers: 0, classes: [], roles: [], roleNames: [], loading: false }); return;
    }
    this._users = [];
    this.setData({ loading: true, error: '', users: [], totalUsers: 0 });
    try {
      const [accounts, classResponse] = await Promise.all([api.request('/api/teachers'), api.request('/api/classes')]);
      if (!manage.current(this, generation) || !api.getUser() || api.getUser().id !== actor.id) return;
      const classes = manage.classesFrom(classResponse);
      this._users = manage.usersFrom(accounts, actor);
      const roles = manage.rolesFrom(accounts.assignableRoles);
      const grades = manage.GRADES.filter(grade => manage.managesGrade(actor, grade));
      this.setData({ classes, roles, roleNames: roles.map(role => manage.ROLE_LABELS[role]), grades,
        totalUsers: this._users.length, uncertain: false, sessionExpired: false });
      this.filterUsers();
      this.updateChoices();
    } catch (error) {
      if (manage.current(this, generation)) ui.fail(this, error);
    } finally {
      if (manage.current(this, generation)) this.setData({ loading: false });
    }
  },

  inputSearch(event) { if (!this.data.busy) { this.setData({ search: event.detail.value }); this.filterUsers(); } },
  filterUsers() {
    const search = this.data.search.trim().toLowerCase();
    this.setData({ users: (this._users || []).filter(item => !search ||
      [item.username, item.display_name, item.roleLabel, item.scopeLabel].some(text => String(text).toLowerCase().includes(search))) });
  },
  updateChoices() {
    const draft = this.data.draft;
    if (!draft) return;
    this.setData({
      roleIndex: this.data.roles.indexOf(draft.role), gradeIndex: this.data.grades.indexOf(draft.grade), enabledIndex: draft.enabled ? 0 : 1,
      headChoices: manage.assignmentChoices(this.data.classes, draft.headClassIds),
      teachingChoices: manage.assignmentChoices(this.data.classes, draft.teachingClassIds)
    });
  },
  newUser() {
    if (this.data.busy || this.data.loading || !this.data.canManage || !this.data.roles.length || this.data.sessionExpired) return;
    if (this.data.editorOpen || this.data.resetId) { ui.toast('请先完成或取消当前编辑。'); return; }
    this._editing = null;
    this.setData({ editorOpen: true, editId: '', draft: manage.userDraft(null, this.data.roles), error: '', status: '' });
    this.updateChoices();
  },
  editUser(event) {
    if (this.data.busy || this.data.loading || this.data.sessionExpired) return;
    if (this.data.editorOpen || this.data.resetId) { ui.toast('请先完成或取消当前编辑。'); return; }
    const target = (this._users || []).find(item => item.id === event.currentTarget.dataset.id);
    if (!target || !target.editable) return;
    this._editing = target;
    this.setData({ editorOpen: true, editId: target.id, draft: manage.userDraft(target, this.data.roles), error: '', status: '' });
    this.updateChoices();
  },
  inputField(event) {
    if (this.data.busy || !this.data.draft) return;
    const field = event.currentTarget.dataset.field;
    if (!['username', 'displayName', 'password'].includes(field) || this.data.editId && field !== 'displayName') return;
    this.setData({ draft: { ...this.data.draft, [field]: event.detail.value } });
  },
  chooseRole(event) {
    if (this.data.busy || !this.data.draft) return;
    const role = this.data.roles[Number(event.detail.value)];
    if (!role) return;
    this.setData({ draft: { ...this.data.draft, role } }); this.updateChoices();
  },
  chooseGrade(event) {
    if (this.data.busy || !this.data.draft) return;
    const grade = this.data.grades[Number(event.detail.value)];
    if (!grade) return;
    this.setData({ draft: { ...this.data.draft, grade } }); this.updateChoices();
  },
  chooseEnabled(event) {
    if (this.data.busy || !this.data.draft || !this.data.editId || !['0', '1'].includes(String(event.detail.value))) return;
    this.setData({ draft: { ...this.data.draft, enabled: Number(event.detail.value) === 0 } }); this.updateChoices();
  },
  chooseAssignments(event) {
    if (this.data.busy || !this.data.draft) return;
    const field = event.currentTarget.dataset.field;
    if (!['headClassIds', 'teachingClassIds'].includes(field) || !Array.isArray(event.detail.value)) return;
    this.setData({ draft: { ...this.data.draft, [field]: event.detail.value.slice() } }); this.updateChoices();
  },
  async cancelEdit() {
    if (this.data.busy || !this.data.editorOpen) return;
    const original = manage.userDraft(this._editing, this.data.roles);
    if (JSON.stringify(this.data.draft) !== JSON.stringify(original) &&
      !await ui.confirm('放弃账号草稿', '尚未保存的账号信息和授权选择会被清除。', '放弃草稿')) return;
    if (!this._visible || this.data.busy) return;
    this._editing = null;
    this.setData({ editorOpen: false, editId: '', draft: null, headChoices: [], teachingChoices: [] });
  },

  async saveUser() {
    if (this.data.busy || this.data.loading || this.data.uncertain || this.data.sessionExpired || !this.data.editorOpen || !this.data.draft) return;
    const actor = api.getUser();
    if (!actor) { this.setData({ sessionExpired: true }); return; }
    const existing = this.data.editId ? (this._users || []).find(item => item.id === this.data.editId) : null;
    if (this.data.editId && (!existing || !existing.editable || !this._editing || manage.userBaseline(existing) !== manage.userBaseline(this._editing))) {
      ui.fail(this, new Error('账号或授权已变化，草稿已保留。请按最新列表重新打开编辑后核对。')); return;
    }
    const draft = this.data.draft;
    let payload;
    try { payload = manage.userPayload(draft, { existing, roles: this.data.roles, classes: this.data.classes, actor }); }
    catch (error) { ui.fail(this, error); return; }
    if (!Object.keys(payload).length) { ui.toast('账号信息没有变化。'); return; }
    const revokes = existing && (payload.enabled === false || ['role', 'grade', 'headClassIds', 'teachingClassIds'].some(key => key in payload));
    const content = `${manage.userSummary(draft, this.data.classes)}${revokes ? '\n停用或授权调整后，该账号的现有登录会失效。' : ''}`;
    return this.write(existing ? '确认修改账号' : '确认创建账号', content, () =>
      // This existing PUT route calls app.update_teacher and accepts its full
      // validated update body, including displayName, role and enabled.
      api.request(existing ? `/api/teachers/${encodeURIComponent(existing.id)}/classes` : '/api/teachers',
        { method: existing ? 'PUT' : 'POST', data: payload }),
      `账号“${draft.username}”已${existing ? '更新' : '创建'}。`, () => {
        this._editing = null;
        this.setData({ editorOpen: false, editId: '', draft: null, headChoices: [], teachingChoices: [] });
      });
  },

  openReset(event) {
    if (this.data.busy || this.data.loading || this.data.sessionExpired) return;
    if (this.data.editorOpen || this.data.resetId) { ui.toast('请先完成或取消当前编辑。'); return; }
    const target = (this._users || []).find(item => item.id === event.currentTarget.dataset.id);
    if (!target || !target.editable) return;
    this.setData({ resetId: target.id, resetName: `${target.display_name}（${target.username}）`, resetPassword: '', error: '', status: '' });
  },
  inputResetPassword(event) { if (!this.data.busy) this.setData({ resetPassword: event.detail.value }); },
  async cancelReset() {
    if (this.data.busy) return;
    if (this.data.resetPassword && !await ui.confirm('放弃密码草稿', '尚未提交的新密码会被清除。', '放弃草稿')) return;
    if (!this._visible || this.data.busy) return;
    this.setData({ resetId: '', resetName: '', resetPassword: '' });
  },
  submitReset() {
    if (this.data.busy || this.data.loading || this.data.uncertain || this.data.sessionExpired || !this.data.resetId) return;
    const target = (this._users || []).find(item => item.id === this.data.resetId);
    if (!target || !target.editable) { ui.fail(this, new Error('该账号已不在可管理列表内，请刷新后核对。')); return; }
    const password = this.data.resetPassword;
    const error = manage.passwordError(password);
    if (error) { ui.fail(this, new Error(error)); return; }
    return this.write('确认重置密码', `将重置“${target.display_name}（${target.username}）”的密码，旧密码和该账号的现有登录会立即失效。`,
      () => api.request(`/api/teachers/${encodeURIComponent(target.id)}/password`, { method: 'PUT', data: { password } }),
      `账号“${target.username}”的密码已重置。`, () => this.setData({ resetId: '', resetName: '', resetPassword: '' }));
  },

  async write(title, content, action, successMessage, onSuccess) {
    const actor = api.getUser();
    if (this.data.busy || !this._visible || !manage.permission(actor, 'manageUsers')) return;
    const generation = manage.invalidate(this);
    const stillCurrent = () => manage.current(this, generation) && api.getUser() && api.getUser().id === actor.id;
    this.setData({ busy: true, loading: false, error: '', status: '' });
    let refresh = false;
    try {
      if (!await ui.confirm(title, content, '确认执行') || !stillCurrent()) return;
      await action();
      refresh = true;
      if (!stillCurrent()) return;
      this.setData({ status: successMessage });
      onSuccess();
    } catch (error) {
      if (manage.current(this, generation)) {
        ui.fail(this, error);
        if (error.ambiguous) this.setData({ uncertain: true, status: '操作结果尚未确认。请先刷新账号列表核对，避免重复创建或调整。' });
      }
    } finally {
      this.setData({ busy: false });
      if (refresh && this._visible && api.getUser() && api.getUser().id === actor.id) await this.load();
    }
  }
});

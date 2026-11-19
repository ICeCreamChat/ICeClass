'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const accounts = require('../../lib/paper-accounts-data');

Page({
  data: {
    appearance: 'glass', classes: [], classNames: [], classIndex: 0, classId: '', className: '',
    loaded: false, loading: false, busy: false, canEdit: false, dirty: false, conflict: false, uncertain: false,
    error: '', status: '', sessionExpired: false, section: 'accounts', rows: [], credentials: [], selectedIds: [],
    revision: 0, rosterRevision: 0, cardRevision: 0, eligibleCount: 0, resettableCount: 0,
    entryYear: '', classCode: '', username: '', linkNames: ['请选择学生'], linkIndex: 0, linkStudentId: ''
  },
  onLoad(options = {}) { this._expectedClassId = options.classId || ''; this._generation = 0; this._secretGeneration = 0; },
  onShow() {
    this._visible = true; this._disposed = false;
    if (!ui.requireLogin()) { this.onHide(); return; }
    const owner = api.getUser().id;
    if (this._ownerId && this._ownerId !== owner) { this.onHide(); return; }
    this._ownerId = owner; this.setData({ sessionExpired: false });
    if (!this.data.busy && !this.data.conflict && !this.data.uncertain && !this.data.dirty) return this.load(true);
  },
  eraseCredentials() { this._secretGeneration = (this._secretGeneration || 0) + 1; this.setData({ credentials: [] }); },
  onHide() {
    this._visible = false; this._generation = (this._generation || 0) + 1;
    this.eraseCredentials(); this.setData({ loading: false });
  },
  onUnload() { this.onHide(); this._disposed = true; this._accounts = null; ui.setDirty(false); },
  owned(allowLoggedOut = false) { const user = api.getUser(); return !this._disposed && (user ? user.id === this._ownerId : allowLoggedOut); },
  active(generation, allowLoggedOut = false) { return this._visible && generation === this._generation && this.owned(allowLoggedOut); },
  editable() {
    return this._visible && this.owned() && this._accounts && this._accounts.classId === this.data.classId &&
      this._accounts.canEdit && this.data.canEdit && !this.data.loading && !this.data.busy && !this.data.sessionExpired;
  },
  markDirty() {
    const baseline = this._defaults || {};
    const dirty = this.data.entryYear !== baseline.entryYear || this.data.classCode !== baseline.classCode ||
      Boolean(this.data.username || this.data.linkStudentId || this.data.selectedIds.length);
    this.setData({ dirty }); ui.setDirty(dirty);
  },
  applyState(state, preserveForms = false) {
    const preserve = preserveForms && this._accounts && this._accounts.classId === state.classId && this.data.dirty;
    this._defaults = { entryYear: ui.dateISO().slice(0, 4), classCode: state.classCode || '' };
    const linkable = state.students.filter(student => !student.accountId);
    const selectedIds = preserve ? this.data.selectedIds.filter(id => state.students.some(student => student.studentId === id && student.accountId && student.activeHere)) : [];
    const linkStudentId = preserve && linkable.some(student => student.studentId === this.data.linkStudentId) ? this.data.linkStudentId : '';
    this._accounts = state;
    this.setData({ loaded: true, className: state.className, canEdit: state.canEdit, revision: state.revision, rosterRevision: state.rosterRevision,
      cardRevision: state.cardRevision, rows: accounts.rows(state, selectedIds), selectedIds,
      eligibleCount: state.students.filter(student => !student.accountId && student.cardNumber !== null).length,
      resettableCount: state.students.filter(student => student.accountId && student.activeHere).length,
      entryYear: preserve ? this.data.entryYear : this._defaults.entryYear, classCode: preserve ? this.data.classCode : this._defaults.classCode,
      username: preserve ? this.data.username : '', linkStudentId, linkIndex: linkStudentId ? linkable.findIndex(student => student.studentId === linkStudentId) + 1 : 0,
      linkNames: ['请选择学生'].concat(linkable.map(student => student.name)), conflict: false, uncertain: false });
    this.markDirty();
  },
  async load(refreshClasses = false, reconcile = false) {
    if (!this._visible || !this.owned() || this.data.busy || !reconcile && (this.data.conflict || this.data.uncertain)) return;
    const generation = this._generation = (this._generation || 0) + 1;
    const requestedClass = this._expectedClassId || this.data.classId;
    this.eraseCredentials(); this.setData({ loading: true, error: '', sessionExpired: false });
    try {
      if (refreshClasses) {
        await ui.loadClasses(this, () => this.active(generation));
        if (!this.active(generation)) return;
        if (requestedClass) {
          const index = this.data.classes.findIndex(room => room.id === requestedClass);
          if (index < 0) { this._accounts = null; this.setData({ rows: [], canEdit: false }); throw new Error('当前账号没有访问所选班级的权限。'); }
          ui.chooseClass(this, index); this._expectedClassId = '';
        }
      }
      if (!this.active(generation)) return;
      const classId = this.data.classId;
      if (!classId) { this._accounts = null; this.setData({ loaded: true, rows: [], canEdit: false }); return; }
      const value = await api.request('/api/card-quiz/classes/' + encodeURIComponent(classId) + '/students', { method: 'GET' });
      if (!this.active(generation) || this.data.classId !== classId) return;
      this.applyState(accounts.readAccounts(value, classId), true);
    } catch (error) {
      if (this.active(generation, true)) {
        ui.fail(this, error);
        if (error.status === 403) this.setData({ canEdit: false });
        if (!api.getUser()) this.setData({ sessionExpired: true });
      }
    } finally { if (this.active(generation, true)) this.setData({ loading: false }); }
  },
  onSectionChange(event) {
    const section = event.currentTarget.dataset.section;
    if (!this.data.busy && ['accounts', 'manage'].includes(section)) this.setData({ section });
  },
  onFieldInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!this.editable() || !['entryYear', 'classCode', 'username'].includes(field)) return;
    this.setData({ [field]: event.detail.value, error: '', status: '' }); this.markDirty();
  },
  onLinkStudent(event) {
    if (!this.editable()) return;
    const linkable = this._accounts.students.filter(student => !student.accountId), index = Number(event.detail.value);
    if (!Number.isInteger(index) || index < 0 || index > linkable.length) return;
    this.setData({ linkIndex: index, linkStudentId: index ? linkable[index - 1].studentId : '', error: '', status: '' }); this.markDirty();
  },
  selectStudents(event) {
    if (!this.editable()) return;
    const ids = event.detail.value;
    if (!Array.isArray(ids) || ids.length > 157 || new Set(ids).size !== ids.length ||
      ids.some(id => !this._accounts.students.some(student => student.studentId === id && student.accountId && student.activeHere))) {
      ui.fail(this, new Error('一次最多选择 157 名当前关联本班的学生，不能重复。')); return;
    }
    this.setData({ selectedIds: ids.slice(), rows: accounts.rows(this._accounts, ids) }); this.markDirty();
  },
  selectAll() {
    if (!this.editable()) return;
    const ids = this._accounts.students.filter(student => student.accountId && student.activeHere).map(student => student.studentId);
    this.selectStudents({ detail: { value: this.data.selectedIds.length === ids.length ? [] : ids } });
  },
  generate() { return this.perform('generate'); },
  reset() { return this.perform('reset'); },
  link() { return this.perform('link'); },
  async perform(kind) {
    if (!this.editable() || this.data.conflict || this.data.uncertain) return;
    let plan;
    try {
      if (this.data.credentials.length) throw new Error('请先清除本次密码，再执行新的账号操作。');
      plan = accounts.action(this._accounts, kind, { entryYear: this.data.entryYear, classCode: this.data.classCode,
        studentIds: this.data.selectedIds, studentId: this.data.linkStudentId, username: this.data.username });
    } catch (error) { ui.fail(this, error); return; }
    const before = this._accounts, generation = this._generation, secrets = this._secretGeneration;
    this.setData({ busy: true, error: '', status: '' });
    try {
      if (!await ui.confirm(plan.title, plan.content, plan.confirmText) || !this.active(generation)) return;
      const value = await api.request('/api/card-quiz/classes/' + encodeURIComponent(before.classId) + '/students' + plan.suffix, { method: 'POST', data: plan.data });
      if (this._disposed || this._accounts !== before) return;
      if (!this.owned()) { this.setData({ uncertain: true, sessionExpired: !api.getUser() }); return; }
      let result;
      try { result = accounts.readResult(value, before, plan); }
      catch (_) { throw Object.assign(new Error('服务已返回，但操作结果无法核对。本次密码未展示，请重新读取账号状态，勿重复提交。'), { ambiguous: true }); }
      const mayShow = this.active(generation) && this._secretGeneration === secrets;
      this.applyState(result.state);
      this.setData({ credentials: mayShow ? result.credentials : [], status: kind === 'link' ? '原账号已关联，密码和历史已保留。' :
        mayShow ? '已' + (kind === 'generate' ? '生成' : '重置') + ' ' + result.credentials.length + ' 个账号密码，仅本页本次显示。' :
          '操作已完成；页面曾隐藏或离开，本次密码已丢弃。请核对账号状态，如需新密码须另行明确重置。' });
    } catch (error) {
      if (this._disposed || !this.owned(true)) return;
      this.setData({ conflict: error.status === 409, uncertain: error.ambiguous === true || error.code === 'session_changed' });
      ui.fail(this, error);
      if (!api.getUser()) this.setData({ sessionExpired: true });
    } finally { if (!this._disposed) this.setData({ busy: false }); }
  },
  clearCredentials() {
    if (this.data.busy) return;
    this.eraseCredentials(); this.setData({ status: '本次密码已从页面清除，无法再次读取；账号与密码本身仍有效。' });
  },
  async reload() {
    if (!this._visible || !this.owned() || this.data.busy || this.data.loading) return;
    const generation = this._generation; this.setData({ busy: true });
    let confirmed = true;
    try {
      if (this.data.dirty || this.data.credentials.length || this.data.conflict || this.data.uncertain)
        confirmed = await ui.confirm('重新读取学生账号', '将读取最新账号、名单和卡号版本，操作输入保留。本次显示的密码会清除，无法再次读取；本操作不会重发生成或重置请求。', '重新读取');
    } finally { if (!this._disposed) this.setData({ busy: false }); }
    if (confirmed && this.active(generation)) return this.load(true, true);
  },
  async changeClass(event) {
    if (!this._visible || !this.owned() || this.data.busy) return;
    const index = Number(event.detail.value), room = this.data.classes[index];
    if (!room || room.id === this.data.classId) return;
    const generation = this._generation; this.setData({ busy: true });
    let confirmed = true;
    try {
      if (this.data.dirty || this.data.credentials.length || this.data.conflict || this.data.uncertain)
        confirmed = await ui.confirm('切换账号管理班级', '将切换到「' + room.name + '」，清除本次密码并放弃当前账号操作输入。已保存的账号和历史保留。', '切换班级');
      if (!confirmed || !this.active(generation)) return;
      this._generation++; this.eraseCredentials(); this._accounts = null; this._expectedClassId = '';
      ui.chooseClass(this, index);
      this.setData({ loaded: false, rows: [], canEdit: false, dirty: false, selectedIds: [], conflict: false, uncertain: false,
        error: '', status: '', entryYear: '', classCode: '', username: '', linkIndex: 0, linkStudentId: '', linkNames: ['请选择学生'] });
      ui.setDirty(false);
    } finally { if (!this._disposed) this.setData({ busy: false }); }
    return this.load();
  },
  async onPullDownRefresh() { try { await this.reload(); } finally { wx.stopPullDownRefresh(); } },
  relogin() { ui.relogin(); }
});

'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const manage = require('../../lib/manage-data');

Page({
  data: {
    classes: [], loading: false, busy: false, error: '', sessionExpired: false, status: '',
    canManage: false, editorOpen: false, editId: '', editOriginalName: '', name: '',
    uncertain: false, scopeLabel: ''
  },

  onShow() {
    this._visible = true;
    manage.invalidate(this);
    if (!ui.requireLogin()) {
      this.setData({ sessionExpired: true, loading: false });
      return;
    }
    const actor = api.getUser();
    if (this._actorId && this._actorId !== actor.id) {
      this.setData({ classes: [], editorOpen: false, editId: '', name: '', uncertain: false, status: '', error: '' });
    }
    this._actorId = actor.id;
    this.setData({
      sessionExpired: false, canManage: manage.permission(actor, 'manageClasses'),
      scopeLabel: actor.role === 'grade_leader' ? `负责年级：${actor.grade || '未分配'}` : actor.role === 'director' ? '管理范围：高一、高二、高三' : ''
    });
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
    this.setData({ loading: true, error: '', classes: [] });
    try {
      const response = await api.request('/api/classes');
      if (!manage.current(this, generation) || !api.getUser() || api.getUser().id !== actor.id) return;
      const classes = manage.classesFrom(response).map(item => ({
        ...item, canManage: manage.permission(actor, 'manageClasses') && manage.managesGrade(actor, item.gradeLabel),
        lastSeenLabel: ui.formatTime(item.last_seen_at),
        teacherCountLabel: typeof item.teacher_count === 'number' ? `${item.teacher_count} 位班主任` : '班主任数量未返回'
      }));
      this.setData({ classes, uncertain: false, sessionExpired: false });
    } catch (error) {
      if (manage.current(this, generation)) ui.fail(this, error);
    } finally {
      if (manage.current(this, generation)) this.setData({ loading: false });
    }
  },

  newClass() {
    if (this.data.busy || !this.data.canManage || this.data.sessionExpired) return;
    if (this.data.editorOpen && (this.data.name || this.data.editId)) { ui.toast('请先保存或取消当前班级编辑。'); return; }
    this.setData({ editorOpen: true, editId: '', editOriginalName: '', name: '', error: '', status: '' });
  },
  editClass(event) {
    if (this.data.busy || this.data.sessionExpired) return;
    const target = this.data.classes.find(item => item.id === event.currentTarget.dataset.id);
    if (!target || !target.canManage) return;
    if (this.data.editorOpen && (this.data.name || this.data.editId)) { ui.toast('请先保存或取消当前班级编辑。'); return; }
    this.setData({ editorOpen: true, editId: target.id, editOriginalName: target.name, name: target.name, error: '', status: '' });
  },
  inputName(event) { if (!this.data.busy) this.setData({ name: event.detail.value }); },
  async cancelEdit() {
    if (this.data.busy) return;
    if (this.data.name !== (this.data.editId ? this.data.editOriginalName : '') &&
      !await ui.confirm('放弃班级草稿', '尚未保存的班级名称会被清除。', '放弃草稿')) return;
    if (!this._visible || this.data.busy) return;
    this.setData({ editorOpen: false, editId: '', editOriginalName: '', name: '' });
  },

  async saveClass() {
    if (this.data.busy || this.data.uncertain || this.data.sessionExpired || !this.data.canManage) return;
    const actor = api.getUser();
    if (!actor) { this.setData({ sessionExpired: true }); return; }
    let payload;
    try { payload = manage.classPayload(this.data.name, actor); }
    catch (error) { ui.fail(this, error); return; }
    const editId = this.data.editId;
    const target = editId ? this.data.classes.find(item => item.id === editId) : null;
    if (editId && (!target || !target.canManage || target.name !== this.data.editOriginalName)) {
      ui.fail(this, new Error('班级已变化或不在管理范围内，请刷新列表后核对草稿。')); return;
    }
    if (target && target.name === payload.name) { ui.toast('班级名称没有变化。'); return; }
    const title = target ? '确认修改班级' : '确认新建班级';
    const content = target ? `将“${target.name}”更名为“${payload.name}”，名称会同步到教室端。\n通过既有确认接口执行，计入 1 次班班操作次数。` :
      `将创建并启用班级“${payload.name}”。`;
    return this.write(title, content, async stillCurrent => {
      if (target) await manage.updateClass((path, options) => api.request(path, options), target, payload, stillCurrent);
      else await api.request('/api/classes', { method: 'POST', data: payload });
    }, `班级“${payload.name}”已${target ? '更名' : '创建'}。`, true);
  },

  toggleClass(event) {
    if (this.data.busy || this.data.uncertain || this.data.sessionExpired) return;
    const target = this.data.classes.find(item => item.id === event.currentTarget.dataset.id);
    if (!target || !target.canManage) return;
    const enabled = !target.isEnabled;
    const effect = enabled ? '恢复该班级的业务入口；设备连接情况以刷新后的状态为准。' : '断开该班级所有教室设备，班级数据和绑定保留。';
    return this.write(`确认${enabled ? '启用' : '停用'}班级`,
      `班级：“${target.name}”\n${effect}\n通过既有确认接口执行，计入 1 次班班操作次数。`,
      stillCurrent => manage.updateClass((path, options) => api.request(path, options), target, { enabled }, stillCurrent),
      `班级“${target.name}”已${enabled ? '启用' : '停用'}。`, false);
  },

  async write(title, content, action, successMessage, closeEditor) {
    const actor = api.getUser();
    if (this.data.busy || !this._visible || !manage.permission(actor, 'manageClasses')) return;
    const generation = manage.invalidate(this);
    const stillCurrent = () => manage.current(this, generation) && api.getUser() && api.getUser().id === actor.id;
    this.setData({ busy: true, loading: false, error: '', status: '' });
    let refresh = false;
    try {
      if (!await ui.confirm(title, content, '确认执行') || !stillCurrent()) return;
      await action(stillCurrent);
      refresh = true;
      if (!stillCurrent()) return;
      this.setData({ status: successMessage, ...(closeEditor ? { editorOpen: false, editId: '', editOriginalName: '', name: '' } : {}) });
    } catch (error) {
      if (manage.current(this, generation)) {
        ui.fail(this, error);
        if (error.ambiguous) this.setData({ uncertain: true, status: '操作结果尚未确认。请先刷新班级列表核对，再决定是否再次提交。' });
      }
    } finally {
      this.setData({ busy: false });
      if (refresh && this._visible && api.getUser() && api.getUser().id === actor.id) await this.load();
    }
  }
});

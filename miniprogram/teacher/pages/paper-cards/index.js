'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const paper = require('../../lib/paper-data');

Page({
  data: { classes: [], classNames: [], classIndex: 0, classId: '', students: [], revision: 0, canEdit: false, loaded: false, loading: false, busy: false, dirty: false, conflict: false, uncertain: false, error: '', status: '', sessionExpired: false, previewNumber: null, previewPath: '' },
  onLoad(options) { this._expectedClassId = options.classId || ''; this._generation = 0; this._visibility = 0; },
  async onShow() {
    this._visible = true;
    if (!ui.requireLogin()) { this.onHide(); return; }
    const owner = api.getUser(); if (this._ownerId && this._ownerId !== owner.id) { this.onHide(); return; } this._ownerId = owner.id;
    if (this._reconcileNeeded) return this.load(false, true);
    if (!this.data.dirty && !this.data.uncertain && !this.data.busy) return this.load(true);
  },
  onHide() {
    this._visible = false; this._visibility++; this._generation++;
    if (this._writeInFlight) { this._reconcileNeeded = true; this.setData({ uncertain: true, status: '保存请求已发出，离页后结果待核对。草稿已保留，返回后先读取服务端卡号，不会重发。' }); }
    this.setData({ loading: false, previewPath: '' });
  },
  onUnload() { this.onHide(); ui.setDirty(false); },
  async onPullDownRefresh() { try { await this.reload(); } finally { wx.stopPullDownRefresh(); } },
  relogin: ui.relogin,
  current() { const user = api.getUser(); return Boolean(this._visible && user && user.id === this._ownerId); },
  errorContext(generation) { return { ownerId: this._ownerId, visibility: this._visibility, generation }; },
  acceptsError(error, context) {
    const user = api.getUser();
    return Boolean(error && error.code !== 'session_changed' && this._visible && context.ownerId === this._ownerId && context.visibility === this._visibility &&
      (context.generation === undefined || context.generation === this._generation) && (user ? user.id === context.ownerId : error.status === 401));
  },
  reportError(error, context) {
    if (!this.acceptsError(error, context)) return false;
    if (error.status === 401) { this._reconcileNeeded = Boolean(this._cardsClassId); this.setData({ canEdit: false, loaded: false }); }
    ui.fail(this, error); return true;
  },
  applyCards(value, preserveDrafts = false) {
    const drafts = new Map(preserveDrafts ? this.data.students.filter(student => String(student.draftNumber).trim() !== (student.cardNumber == null ? '' : String(student.cardNumber))).map(student => [student.id, student.draftNumber]) : []);
    const result = paper.readCards(value, this.data.classId);
    this._cardsClassId = this.data.classId;
    this._cards = result.students.map(student => ({ id: student.id, name: student.name, cardNumber: student.cardNumber }));
    result.students = result.students.map(student => drafts.has(student.id) ? { ...student, draftNumber: drafts.get(student.id) } : student);
    const currentDrafts = Object.create(null); result.students.forEach(student => { currentDrafts[student.id] = student.draftNumber; });
    let dirty = false;
    try { dirty = paper.bindingChanges(this._cards, currentDrafts).length > 0; }
    catch (_) { dirty = true; }
    this._reconcileNeeded = false;
    this.setData({ ...result, loaded: true, dirty, conflict: false, uncertain: false }); ui.setDirty(dirty);
  },
  async load(refreshClasses = false, preserveDrafts = false) {
    if (!this.current() || this.data.busy || !ui.requireLogin()) return;
    // Reconcile against the dispatched class, never the globally selected class.
    if (this._reconcileNeeded) { refreshClasses = false; preserveDrafts = true; }
    const generation = ++this._generation, context = this.errorContext(generation);
    this.setData({ loading: true, loaded: false, canEdit: false, error: '', sessionExpired: false, previewPath: '' });
    try {
      let selection = null;
      if (refreshClasses) {
        // Keep the previous class and its draft together until both reads succeed.
        const page = this, target = { data: { ...this.data }, get _generation() { return page._generation; }, setData(patch) { Object.assign(this.data, patch); } };
        await ui.loadClasses(target, () => this.current() && generation === this._generation);
        if (!this.current() || generation !== this._generation) return;
        if (this._expectedClassId) {
          const index = target.data.classes.findIndex(item => item.id === this._expectedClassId);
          if (index < 0) throw new Error('当前账号没有此班级权限。');
          ui.chooseClass(target, index);
        }
        selection = { classes: target.data.classes, classNames: target.data.classNames, classIndex: target.data.classIndex, classId: target.data.classId };
      }
      const classId = selection ? selection.classId : this.data.classId;
      if (!classId) { this._cards = []; this.setData({ ...(selection || {}), students: [], loaded: true, canEdit: false }); return; }
      const value = await api.request('/api/card-quiz/classes/' + encodeURIComponent(classId) + '/cards');
      if (this.current() && generation === this._generation) {
        paper.readCards(value, classId);
        if (selection) this.setData(selection);
        this._expectedClassId = ''; this.applyCards(value, preserveDrafts);
        if (preserveDrafts) this.setData({ status: this.data.dirty ? '已读取最新卡号，原修改草稿已保留。请核对后再保存。' : '已读取最新卡号并核对原草稿，没有重复提交。' });
      }
    } catch (error) { this.reportError(error, context); }
    finally { if (generation === this._generation) this.setData({ loading: false }); }
  },
  async reload() {
    if (this.data.busy || !this.current()) return;
    if (this._reconcileNeeded || this.data.uncertain) return this.load(false, true);
    const generation = this._generation; this.setData({ busy: true });
    try {
      if ((this.data.dirty || this.data.uncertain) && !await ui.confirm('核对最新纸卡', '将重新读取服务端卡号。成功后替换本页草稿，请核对之前的提交是否已经保存。', '重新读取')) return;
      if (!this.current() || generation !== this._generation) return;
    } finally { this.setData({ busy: false }); }
    return this.load(true);
  },
  async changeClass(event) {
    if (!this.current() || this.data.busy || this.data.uncertain) return;
    this.setData({ busy: true }); const generation = this._generation;
    try {
      if (this.data.dirty && !await ui.confirm('切换班级', '切换后放弃当前尚未保存的卡号修改。', '放弃修改')) return;
      if (!this.current() || generation !== this._generation) return;
      this._generation++; this._cards = [];
      this.setData({ students: [], loaded: false, canEdit: false, dirty: false, conflict: false, previewPath: '', status: '' }); ui.setDirty(false);
      ui.chooseClass(this, event.detail.value);
    } finally { this.setData({ busy: false }); }
    return this.load();
  },
  inputCard(event) {
    if (this.data.busy || this.data.loading || this.data.uncertain || !this.data.canEdit) return;
    const id = event.currentTarget.dataset.id;
    this.setData({ students: this.data.students.map(student => student.id === id ? { ...student, draftNumber: event.detail.value } : student), dirty: true, status: '', previewPath: '' }); ui.setDirty(true);
  },
  async saveBindings() {
    if (!this.data.dirty) return;
    try {
      const drafts = {}; this.data.students.forEach(student => { drafts[student.id] = student.draftNumber; });
      const bindings = paper.bindingChanges(this._cards || [], drafts);
      if (!bindings.length) { this.setData({ dirty: false }); ui.setDirty(false); return; }
      return await this.writeCards({ bindings }, '保存纸卡编号', '将保存 ' + bindings.length + ' 名学生的卡号修改。留空会解除绑定；历史课堂名单保留。', '保存卡号');
    } catch (error) { ui.fail(this, error); }
  },
  initialize() { return this.writeCards({ initialize: true }, '为缺号学生分配', '只为尚无卡号的学生分配从未使用的卡号，不会自动把离班学生的旧号分给他人。名单最多 157 人。', '分配卡号'); },
  async writeCards(change, title, content, confirmText) {
    if (!this.current() || this.data.busy || this.data.loading || this.data.uncertain || this.data.conflict || !this.data.canEdit || !this.data.loaded || this._cardsClassId !== this.data.classId || !ui.requireLogin()) return;
    if (change.initialize && this.data.dirty) { this.setData({ error: '请先保存或重新读取当前卡号草稿。' }); return; }
    const generation = this._generation, classId = this.data.classId, revision = this.data.revision, context = this.errorContext(generation);
    this.setData({ busy: true, error: '' });
    try {
      if (!await ui.confirm(title, content, confirmText)) return;
      if (!this.current() || generation !== this._generation || classId !== this.data.classId) return;
      this._writeInFlight = true;
      const result = await api.request('/api/card-quiz/classes/' + encodeURIComponent(classId) + '/cards', { method: 'PUT', data: { revision, ...change } });
      if (!this.current() || generation !== this._generation) return;
      this.applyCards(result); this.setData({ status: '纸卡编号已保存。已开始课堂的名单快照保留。' });
    } catch (error) {
      if (this.acceptsError(error, context)) {
        if (error.status === 409) this.setData({ conflict: true });
        if (paper.unknownWrite(error)) { this._reconcileNeeded = true; this.setData({ uncertain: true, status: '保存结果未确认，修改已保留。请重新读取服务端卡号后核对，不要重复提交。' }); }
        this.reportError(error, context);
      }
    } finally {
      this._writeInFlight = false; this.setData({ busy: false });
      if (context.visibility !== this._visibility && this.current() && this._reconcileNeeded) await this.load(false, true);
    }
  },
  async previewCard(event) {
    if (!this.current() || this.data.busy || this.data.loading || !this.data.loaded || this.data.dirty || this.data.uncertain) return;
    const number = Number(event.currentTarget.dataset.number);
    if (!this.data.students.some(student => student.cardNumber === number)) return;
    this.setData({ busy: true, error: '', previewNumber: number, previewPath: '' }); const generation = this._generation;
    try {
      const canvas = await new Promise((resolve, reject) => wx.createSelectorQuery().in(this).select('#paper-card-canvas').fields({ node: true, size: true }).exec(results => results && results[0] && results[0].node ? resolve(results[0].node) : reject(new Error('当前微信不支持本页画布，请更新微信后重试。'))));
      if (!this.current() || generation !== this._generation) return;
      canvas.width = 960; canvas.height = 1120; paper.drawCard(canvas.getContext('2d'), number);
      const path = await new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas, fileType: 'png', success: result => resolve(result.tempFilePath), fail: () => reject(new Error('纸卡图片生成失败，请重试。')) }, this));
      if (this.current() && generation === this._generation) this.setData({ previewPath: path, status: '纸卡图样已生成。仅含卡号与作答图案，不含学生登录账号或密码。' });
    } catch (error) { if (this.current()) ui.fail(this, error); }
    finally { this.setData({ busy: false }); }
  },
  openStudentAccounts() {
    if (!this.current() || !this.data.loaded || !this.data.classId || this.data.loading || this.data.busy || this.data.dirty || this.data.uncertain) return;
    wx.navigateTo({ url: '/pages/paper-accounts/index?' + ui.query({ classId: this.data.classId }),
      fail: () => ui.toast('暂时无法打开学生账号。') });
  },
  async shareCard() {
    if (!this.current() || this.data.busy || !this.data.previewPath) return;
    if (typeof wx.shareFileMessage !== 'function') { this.setData({ error: '当前微信不支持文件分享，请更新微信后重试。' }); return; }
    this.setData({ busy: true, error: '' });
    try {
      await new Promise((resolve, reject) => wx.shareFileMessage({ filePath: this.data.previewPath, fileName: 'ICeClass-纸卡-' + this.data.previewNumber + '.png', success: resolve, fail: error => /cancel/i.test(error.errMsg || '') ? resolve() : reject(new Error('纸卡图片分享失败，请重试。')) }));
    } catch (error) { if (this.current()) ui.fail(this, error); }
    finally { this.setData({ busy: false }); }
  }
});

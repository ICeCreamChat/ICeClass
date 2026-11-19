'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const homework = require('../../lib/homework-data');

Page({
  data: {
    classes: [], classNames: [], classIndex: 0, classId: '', profileClassId: '',
    loading: false, busy: false, canEdit: false, dirty: false, revision: null,
    error: '', sessionExpired: false, notice: '', conflict: false, uncertain: false, cachedDraftCount: 0,
    section: 'assignments', students: [], pendingNames: '', pendingTerm: '',
    terms: [], termNames: [], termIndex: 0, activeTermIndex: 0, termLabel: '',
    subjectNames: homework.SUBJECTS.map(subject => subject.name), subjectIndex: 0, items: []
  },
  onLoad(options = {}) { this._initialClassId = options.classId || ''; },
  onShow() {
    this._visible = true; this._disposed = false;
    if (!ui.requireLogin()) { this.onHide(); return; }
    const owner = api.getUser().id;
    if (this._owner && this._owner !== owner) return;
    this._owner = owner; this._drafts = this._drafts || Object.create(null);
    this.setData({ sessionExpired: false });
    return this.load(true);
  },
  onHide() { this._visible = false; this._generation = (this._generation || 0) + 1; this.setData({ loading: false }); },
  onUnload() { this.onHide(); this._disposed = true; ui.setDirty(false); },
  owned(allowLoggedOut = false) {
    const user = api.getUser();
    return !this._disposed && (user ? user.id === this._owner : allowLoggedOut);
  },
  active(generation, allowLoggedOut = false) { return this._visible && this._generation === generation && this.owned(allowLoggedOut); },
  entry() { return this._drafts && this._drafts[this.data.classId]; },
  isDirty(entry) { return Boolean(entry && (JSON.stringify(entry.profile.value) !== JSON.stringify(entry.value) || entry.pendingNames.trim() || entry.pendingTerm.trim())); },
  editable() {
    const entry = this.entry();
    return Boolean(this._visible && this.owned() && entry && entry.profile.canEdit && this.data.profileClassId === this.data.classId &&
      !this.data.loading && !this.data.busy && !this.data.sessionExpired);
  },
  present(entry) {
    const cachedDraftCount = Object.values(this._drafts || {}).filter(item => this.isDirty(item)).length;
    ui.setDirty(cachedDraftCount > 0);
    if (!entry) {
      this.setData({ profileClassId: '', canEdit: false, dirty: false, revision: null, students: [], items: [], terms: [], termNames: [],
        termLabel: '', pendingNames: '', pendingTerm: '', conflict: false, uncertain: false, cachedDraftCount });
      return;
    }
    const terms = entry.value.terms;
    let termIndex = terms.findIndex(term => term.id === entry.termId);
    if (termIndex < 0) termIndex = Math.max(0, terms.findIndex(term => term.id === entry.value.activeTermId));
    const term = terms[termIndex]; entry.termId = term.id;
    const subjectIndex = Math.max(0, homework.SUBJECTS.findIndex(subject => subject.id === entry.subjectId));
    entry.subjectId = homework.SUBJECTS[subjectIndex].id;
    const subject = term.subjects.find(item => item.id === entry.subjectId);
    this.setData({ profileClassId: entry.profile.classId, canEdit: entry.profile.canEdit === true, dirty: this.isDirty(entry), revision: entry.profile.revision,
      students: homework.clone(entry.value.students), terms: terms.map(item => ({ id: item.id, label: item.label })), termNames: terms.map(item => item.label || '未命名学期'),
      termIndex, activeTermIndex: terms.findIndex(item => item.id === entry.value.activeTermId), termLabel: term.label, subjectIndex,
      items: homework.clone(subject.items), pendingNames: entry.pendingNames, pendingTerm: entry.pendingTerm,
      conflict: entry.conflict, uncertain: entry.uncertain, error: entry.error || '', notice: entry.notice || '', cachedDraftCount });
  },
  async load(refreshClasses = false, discard = false) {
    if (!this._visible || !this.owned() || this.data.busy) return;
    const generation = this._generation = (this._generation || 0) + 1;
    this.setData({ loading: true, error: '', sessionExpired: false });
    try {
      if (refreshClasses) await ui.loadClasses(this, () => this.active(generation));
      if (!this.active(generation)) return;
      if (this._initialClassId) {
        const index = this.data.classes.findIndex(item => item.id === this._initialClassId);
        this._initialClassId = '';
        if (index < 0) throw new Error('当前账号没有访问所选班级的权限。');
        ui.chooseClass(this, index);
      }
      const classId = this.data.classId, existing = this.entry();
      if (this.data.profileClassId !== classId) this.present(existing);
      if (!classId) { this.present(null); return; }
      if (existing && !discard && (this.isDirty(existing) || existing.conflict || existing.uncertain)) {
        this.present(existing);
        return;
      }
      const result = await api.request('/api/homework/classes/' + encodeURIComponent(classId) + '/profile', { method: 'GET' });
      if (!this.active(generation) || this.data.classId !== classId) return;
      const profile = homework.readProfile(result, classId);
      const entry = { profile, value: homework.clone(profile.value), pendingNames: '', pendingTerm: '',
        termId: profile.value.activeTermId, subjectId: existing ? existing.subjectId : 'chinese',
        conflict: false, uncertain: false, error: '', notice: '' };
      this._drafts[classId] = entry; this.present(entry);
    } catch (error) {
      if (this.active(generation, true)) {
        ui.fail(this, error);
        if (!api.getUser()) this.setData({ sessionExpired: true });
      }
    } finally {
      if (this.active(generation, true)) this.setData({ loading: false });
    }
  },
  async onClassChange(event) {
    if (!this._visible || !this.owned() || this.data.busy) return;
    const index = Number(event.detail.value);
    if (!this.data.classes[index]) return;
    this._generation = (this._generation || 0) + 1;
    ui.chooseClass(this, index); this.setData({ error: '', notice: '', sessionExpired: false }); this.present(this.entry());
    return this.load();
  },
  onSectionChange(event) {
    const section = event.currentTarget.dataset.section;
    if (!this.data.busy && ['assignments', 'students'].includes(section)) this.setData({ section });
  },
  onTermChange(event) {
    const entry = this.entry(), term = entry && entry.value.terms[Number(event.detail.value)];
    if (!term || this.data.busy || this.data.loading) return;
    entry.termId = term.id; this.present(entry);
  },
  onSubjectChange(event) {
    const entry = this.entry(), subject = homework.SUBJECTS[Number(event.detail.value)];
    if (!entry || !subject || this.data.busy || this.data.loading) return;
    entry.subjectId = subject.id; this.present(entry);
  },
  changed() { const entry = this.entry(); entry.error = ''; entry.notice = ''; this.present(entry); },
  onStudentInput(event) {
    if (!this.editable()) return;
    const student = this.entry().value.students.find(item => item.id === event.currentTarget.dataset.id);
    if (student) { student.name = event.detail.value; this.changed(); }
  },
  removeStudent(event) {
    if (!this.editable()) return;
    const entry = this.entry(); entry.value.students = entry.value.students.filter(item => item.id !== event.currentTarget.dataset.id); this.changed();
  },
  onPendingNames(event) { if (this.editable()) { this.entry().pendingNames = event.detail.value; this.changed(); } },
  onPendingTerm(event) { if (this.editable()) { this.entry().pendingTerm = event.detail.value; this.changed(); } },
  addStudents() {
    if (!this.editable()) return;
    const entry = this.entry();
    try { entry.value = homework.appendStudents(entry.value, entry.pendingNames); entry.pendingNames = ''; this.changed(); }
    catch (error) { ui.fail(this, error); }
  },
  onTermLabelInput(event) {
    if (!this.editable()) return;
    const entry = this.entry(); entry.value.terms.find(term => term.id === entry.termId).label = event.detail.value; this.changed();
  },
  onActiveTermChange(event) {
    if (!this.editable()) return;
    const entry = this.entry(), term = entry.value.terms[Number(event.detail.value)];
    if (term) { entry.value.activeTermId = term.id; this.changed(); }
  },
  addTerm() {
    if (!this.editable()) return;
    const entry = this.entry();
    try {
      entry.value = homework.copyTerm(entry.value, entry.termId, entry.pendingTerm);
      entry.termId = entry.value.terms[entry.value.terms.length - 1].id; entry.pendingTerm = ''; this.changed();
      entry.notice = '新学期已加入草稿。需要在教室使用时，将它设为教室当前学期并保存。'; this.present(entry);
    } catch (error) { ui.fail(this, error); }
  },
  subject() {
    const entry = this.entry();
    return entry && entry.value.terms.find(term => term.id === entry.termId).subjects.find(subject => subject.id === entry.subjectId);
  },
  addItem() {
    if (!this.editable()) return;
    const subject = this.subject();
    if (subject.items.length >= 40) { ui.fail(this, new Error('每个学科最多设置 40 个作业项目。')); return; }
    subject.items.push({ id: homework.createId(), name: '', active: true }); this.changed();
  },
  onItemInput(event) {
    if (!this.editable()) return;
    const item = this.subject().items.find(row => row.id === event.currentTarget.dataset.id);
    if (item) { item.name = event.detail.value; this.changed(); }
  },
  onItemActive(event) {
    if (!this.editable() || typeof event.detail.value !== 'boolean') return;
    const item = this.subject().items.find(row => row.id === event.currentTarget.dataset.id);
    if (item) { item.active = event.detail.value; this.changed(); }
  },
  removeItem(event) {
    if (!this.editable()) return;
    const subject = this.subject(); subject.items = subject.items.filter(item => item.id !== event.currentTarget.dataset.id); this.changed();
  },
  async save() {
    const entry = this.entry();
    if (!this.editable() || !this.isDirty(entry) || entry.conflict || entry.uncertain) return;
    let payload;
    try {
      if (entry.pendingNames.trim() || entry.pendingTerm.trim()) throw new Error('请先将待添加的姓名加入名单，或创建填写中的新学期，再保存。');
      payload = homework.savePayload(entry.profile, entry.value);
    } catch (error) { ui.fail(this, error); return; }
    const classId = this.data.classId, owner = this._owner, generation = this._generation;
    this.setData({ busy: true, error: '', notice: '' });
    try {
      if (!await ui.confirm('保存班级作业设置', homework.summary(entry.profile, payload.value), '确认保存') || !this.active(generation)) return;
      const result = await api.request('/api/homework/classes/' + encodeURIComponent(classId) + '/profile', { method: 'PUT', data: payload });
      let profile;
      try {
        profile = homework.readProfile(result, classId);
        if (profile.revision !== payload.revision + 1) throw new Error('版本不一致');
      } catch (_) { throw Object.assign(new Error('保存已返回，但设置结果无法核对。请重新载入查看，勿重复保存。'), { ambiguous: true }); }
      if (this._disposed || this._owner !== owner || this._drafts[classId] !== entry) return;
      Object.assign(entry, { profile, value: homework.clone(profile.value), pendingNames: '', pendingTerm: '', conflict: false, uncertain: false,
        error: '', notice: '设置已保存。教室端重新打开作业统计后使用新名单和预设。' });
      if (this._visible && this.owned() && this.data.classId === classId) this.present(entry);
    } catch (error) {
      if (this._disposed || this._owner !== owner || this._drafts[classId] !== entry) return;
      entry.conflict = error.status === 409; entry.uncertain = error.ambiguous === true || error.code === 'session_changed';
      entry.error = error.message;
      if (error.status === 403) entry.profile.canEdit = false;
      if (this._visible && this.owned(true) && this.data.classId === classId) {
        this.present(entry); ui.fail(this, error);
        if (!api.getUser()) this.setData({ sessionExpired: true });
      }
    } finally {
      if (!this._disposed && this._owner === owner) this.setData({ busy: false });
    }
  },
  async reload() {
    if (!this._visible || !this.owned() || this.data.busy || this.data.loading) return;
    const generation = this._generation;
    this.setData({ busy: true });
    let confirmed = false;
    try {
      confirmed = await ui.confirm('重新载入作业设置', '将以服务器最新设置替换本班草稿，未保存修改将丢弃。若上次保存结果不确定，请核对最新版本后再编辑。历史登记记录保留。', '重新载入');
    } finally { if (this.owned(true)) this.setData({ busy: false }); }
    if (confirmed && this.active(generation)) return this.load(false, true);
  },
  async onPullDownRefresh() { try { await this.load(true); } finally { wx.stopPullDownRefresh(); } },
  relogin() { ui.relogin(); }
});

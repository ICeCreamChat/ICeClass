'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const model = require('../../lib/question-data');
Page({
  data: { classes: [], classNames: [], classIndex: 0, classId: '', bank: [], decks: [], publications: [], editor: null, deckEditor: null,
    sections: [{ id: 'bank', name: '我的题库' }, { id: 'decks', name: '我的题单' }, { id: 'published', name: '已发布' }], section: 'bank',
    subjectNames: model.subjects.map(item => item[1]), typeNames: model.types.map(item => item[1]), letters: ['A', 'B', 'C', 'D'], countNames: ['2', '3', '4'], error: '', status: '', loading: false, busy: false, dirty: false, conflict: false, uncertain: false, sessionExpired: false },
  onShow() { if (ui.requireLogin() && !this.data.dirty && !this.data.busy) this.load(); },
  onHide() { this._generation = (this._generation || 0) + 1; this.setData({ loading: false }); },
  onUnload() { this.onHide(); ui.setDirty(false); },
  onPullDownRefresh() { this.reload(); },
  async reload() { if (this.data.busy) { wx.stopPullDownRefresh(); return; } if (this.data.dirty && !await ui.confirm('重新载入', '这会放弃当前尚未保存的题目或题单修改。请在列表中核对之前的提交结果。', '放弃并载入')) { wx.stopPullDownRefresh(); return; } this.setData({ editor: null, deckEditor: null, dirty: false, conflict: false, uncertain: false }); ui.setDirty(false); await this.load(); },
  async load() {
    if (!ui.requireLogin()) { wx.stopPullDownRefresh(); return; }
    const generation = this._generation = (this._generation || 0) + 1;
    this.setData({ loading: true, error: '', sessionExpired: false });
    try {
      await ui.loadClasses(this);
      if (generation !== this._generation) return;
      const [bank, decks, publications] = await Promise.all([api.request('/api/card-quiz/questions'), api.request('/api/card-quiz/decks'), this.data.classId ? api.request(`/api/card-quiz/classes/${encodeURIComponent(this.data.classId)}/publications`) : { publications: [] }]);
      if (generation !== this._generation) return;
      this.setData({ bank: bank.questions.map(model.describe), decks: decks.decks, publications: publications.publications });
    } catch (error) { if (generation === this._generation) ui.fail(this, error); }
    finally { if (generation === this._generation) this.setData({ loading: false }); wx.stopPullDownRefresh(); }
  },
  async changeClass(event) { if (this.data.busy) return; ui.chooseClass(this, event.detail.value); this.setData({ publications: [] }); await this.load(); },
  selectSection(event) {
    const id = event.currentTarget.dataset.id;
    if (!this.data.busy && !this.data.editor && !this.data.deckEditor && this.data.sections.some(item => item.id === id)) this.setData({ section: id });
  },
  markDirty() { this.setData({ dirty: true, status: '' }); ui.setDirty(true); },
  failWrite(error) { ui.fail(this, error); if (error.ambiguous) this.setData({ uncertain: true }); },
  async openQuestion(event) {
    if (this.data.busy || this.data.dirty && !await ui.confirm('切换题目', '放弃当前尚未保存的修改？', '放弃修改')) return;
    const question = this.data.bank.find(item => item.id === event.currentTarget.dataset.id);
    this.setData({ editor: model.draft(question), deckEditor: null, dirty: false, conflict: false, error: '', status: '' }); ui.setDirty(false);
  },
  inputQuestion(event) {
    const key = event.currentTarget.dataset.field;
    if (!['text', 'answerText', 'tagsText'].includes(key) || this.data.busy) return;
    this.setData({ [`editor.${key}`]: event.detail.value }); this.markDirty();
  },
  option(event) { if (this.data.busy) return; const options = this.data.editor.options.slice(); options[Number(event.currentTarget.dataset.index)] = event.detail.value; this.setData({ 'editor.options': options }); this.markDirty(); },
  subject(event) { const index = Number(event.detail.value); this.setData({ 'editor.subjectId': model.subjects[index][0], 'editor.subjectIndex': index }); this.markDirty(); },
  type(event) {
    const index = Number(event.detail.value), type = model.types[index][0];
    this.setData({ 'editor.type': type, 'editor.typeIndex': index, 'editor.options': type === 'boolean' ? ['正确', '错误'] : ['', '', '', ''], 'editor.answerText': '' }); this.markDirty();
  },
  count(event) { const length = Number(event.detail.value) + 2; const options = this.data.editor.options.slice(0, length); while (options.length < length) options.push(''); this.setData({ 'editor.options': options, 'editor.answerText': '' }); this.markDirty(); },
  async image() {
    if (this.data.busy || !this.data.editor) return;
    this.setData({ busy: true, error: '' });
    try {
      const file = await new Promise((resolve, reject) => wx.chooseMessageFile({ count: 1, type: 'file', extension: ['png', 'jpg', 'jpeg', 'webp'], success: result => resolve(result.tempFiles[0]), fail: error => reject(new Error(/cancel/i.test(error.errMsg || '') ? '已取消选择图片。' : '无法选择图片，请重试。')) }));
      if (!file || file.size > 2 * 1024 * 1024) throw new Error('题目图片最多 2 MiB。');
      const extension = file.name.split('.').pop().toLowerCase();
      const mime = extension === 'jpg' ? 'jpeg' : extension;
      if (!['png', 'jpeg', 'webp'].includes(mime)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
      const base64 = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath: file.path, encoding: 'base64', success: result => resolve(result.data), fail: () => reject(new Error('图片读取失败。')) }));
      const result = await api.request('/api/card-quiz/images', { method: 'POST', data: { dataUrl: `data:image/${mime};base64,${base64}` }, timeout: 30000 });
      this.setData({ 'editor.imageId': result.id }); this.markDirty();
    } catch (error) { ui.fail(this, error); }
    finally { this.setData({ busy: false }); }
  },
  removeImage() { this.setData({ 'editor.imageId': null }); this.markDirty(); },
  async previewImage() { try { const path = await api.download(`/api/card-quiz/images/${encodeURIComponent(this.data.editor.imageId)}`); wx.previewImage({ urls: [path] }); } catch (error) { ui.fail(this, error); } },
  async saveQuestion() {
    if (this.data.busy || this.data.conflict || this.data.uncertain || !ui.requireLogin()) return;
    this.setData({ busy: true, error: '' });
    try {
      const editor = this.data.editor, value = model.value(editor);
      await api.request('/api/card-quiz/questions' + (editor.id ? `/${encodeURIComponent(editor.id)}` : ''), { method: editor.id ? 'PUT' : 'POST', data: { value, ...(editor.id ? { revision: editor.revision } : {}) } });
      this.setData({ editor: null, dirty: false, status: '题目已保存。' }); ui.setDirty(false); await this.load();
    } catch (error) { this.failWrite(error); if (error.status === 409) this.setData({ conflict: true }); }
    finally { this.setData({ busy: false }); }
  },
  async deleteQuestion(event) {
    if (this.data.busy || this.data.uncertain || !ui.requireLogin()) return;
    const question = this.data.bank.find(item => item.id === event.currentTarget.dataset.id); if (!question) return;
    const generation = this._generation;
    this.setData({ busy: true, error: '' });
    try {
      if (!await ui.confirm('删除题目', `删除“${question.text || '图片或课件题'}”？已发布题单和课堂快照会保留。`, '删除题目')) return;
      if (generation !== this._generation) return;
      await api.request(`/api/card-quiz/questions/${encodeURIComponent(question.id)}`, { method: 'DELETE', data: { revision: question.revision } }); await this.load();
    } catch (error) { this.failWrite(error); } finally { this.setData({ busy: false }); }
  },
  async openDeck(event) {
    if (this.data.busy || this.data.dirty && !await ui.confirm('切换题单', '放弃当前尚未保存的修改？', '放弃修改')) return;
    const existing = this.data.decks.find(item => item.id === event.currentTarget.dataset.id);
    const deckEditor = existing ? { ...existing, questionIds: existing.questionIds.slice() } : { title: '', questionIds: [] };
    this.setData({ deckEditor, editor: null, dirty: false, conflict: false, error: '' }); this.updateDeckOptions(); ui.setDirty(false);
  },
  updateDeckOptions() {
    const selected = this.data.deckEditor.questionIds;
    this.setData({ deckOptions: this.data.bank.map(q => ({ ...q, checked: selected.includes(q.id) })), orderedQuestions: selected.map(id => this.data.bank.find(q => q.id === id) || { id, text: '已删除的题目，请移除' }) });
  },
  deckTitle(event) { this.setData({ 'deckEditor.title': event.detail.value }); this.markDirty(); },
  deckSelect(event) { this.setData({ 'deckEditor.questionIds': model.selectedOrder(this.data.deckEditor.questionIds, event.detail.value) }); this.updateDeckOptions(); this.markDirty(); },
  move(event) {
    const index = Number(event.currentTarget.dataset.index), direction = Number(event.currentTarget.dataset.direction);
    const ids = this.data.deckEditor.questionIds.slice(), next = index + direction;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    this.setData({ 'deckEditor.questionIds': ids }); this.updateDeckOptions(); this.markDirty();
  },
  async saveDeck() {
    if (this.data.busy || this.data.conflict || this.data.uncertain || !ui.requireLogin()) return;
    const editor = this.data.deckEditor;
    if (!editor.title.trim() || Array.from(editor.title).length > 200) { this.setData({ error: '请填写 1-200 字的题单名称。' }); return; }
    this.setData({ busy: true, error: '' });
    try {
      await api.request('/api/card-quiz/decks' + (editor.id ? `/${encodeURIComponent(editor.id)}` : ''), { method: editor.id ? 'PUT' : 'POST', data: { title: editor.title.trim(), questionIds: editor.questionIds, ...(editor.id ? { revision: editor.revision } : {}) } });
      this.setData({ deckEditor: null, dirty: false, status: '题单已保存。' }); ui.setDirty(false); await this.load();
    } catch (error) { this.failWrite(error); if (error.status === 409) this.setData({ conflict: true }); } finally { this.setData({ busy: false }); }
  },
  async publish(event) {
    if (this.data.busy || this.data.uncertain || !this.data.classId || !ui.requireLogin()) return;
    const deck = this.data.decks.find(item => item.id === event.currentTarget.dataset.id); if (!deck) return;
    const classId = this.data.classId, className = this.data.classNames[this.data.classIndex];
    const generation = this._generation;
    this.setData({ busy: true, error: '' });
    try {
      if (!await ui.confirm('发布到班级', `将“${deck.title}”的 ${deck.questionIds.length} 道题发布到${className}，供教室端下载。以后修改题库不会改变本次快照。`, '发布题单')) return;
      if (generation !== this._generation || classId !== this.data.classId) return;
      await api.request(`/api/card-quiz/decks/${encodeURIComponent(deck.id)}/publish`, { method: 'POST', data: { revision: deck.revision, classId } });
      this.setData({ status: '题单已发布，教室端同步后可用。' }); await this.load();
    } catch (error) { this.failWrite(error); } finally { this.setData({ busy: false }); }
  },
  async withdraw(event) {
    if (this.data.busy || this.data.uncertain || !ui.requireLogin()) return;
    const item = this.data.publications.find(row => row.id === event.currentTarget.dataset.id); if (!item) return;
    const generation = this._generation;
    this.setData({ busy: true, error: '' });
    try {
      if (!await ui.confirm('撤回题单', `撤回“${item.title}”？已经开始的课堂快照会保留。`, '撤回题单')) return;
      if (generation !== this._generation) return;
      await api.request(`/api/card-quiz/publications/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); await this.load();
    } catch (error) { this.failWrite(error); } finally { this.setData({ busy: false }); }
  },
  async closeEditor() { if (this.data.busy || this.data.dirty && !await ui.confirm('返回列表', '放弃尚未保存的修改？', '放弃修改')) return; this.setData({ editor: null, deckEditor: null, dirty: false, conflict: false }); ui.setDirty(false); },
  relogin: ui.relogin
});

'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const { opId, operationView, messageView } = require('../../lib/banban-data');
const conversationPath = '/api/banban/conversation';
const threadsPath = '/api/banban/conversations';
const operationPath = '/api/banban/operations';

function currentUserId() {
  const user = api.getUser();
  return user ? user.id : undefined;
}

Page({
  data: {
    classes: [], classNames: [], classIndex: 0, classId: '', input: '', messages: [],
    threadId: '', threadTitle: '', beforeId: null, threads: [], threadCursor: null, showThreads: false,
    operations: [], reviewingId: '', operationBusy: false, operationWarning: '', actionRead: false, uncertainOperationId: '',
    busy: false, loading: false, ready: false, managing: false, stopping: false, error: '',
    quotaText: '', status: '', pending: '', sessionExpired: false
  },
  onShow() {
    this._visible = true;
    if (ui.requireLogin() && !this.data.busy && !this.data.managing && !this.data.operationBusy) return this.load();
  },
  onHide() {
    this._visible = false;
    this._generation = (this._generation || 0) + 1;
    clearTimeout(this._operationTimer);
    clearTimeout(this._textTimer);
    this.setData({ loading: false, reviewingId: '', ...(this._dispatchedOperation && this.unverifiedOperation(this._dispatchedOperation)) });
  },
  onUnload() { this.onHide(); ui.setDirty(false); },
  current(generation, owner) {
    return this._visible && this._generation === generation && currentUserId() === owner;
  },
  async load() {
    if (this.data.busy || this.data.managing || this.data.operationBusy) return;
    const owner = currentUserId();
    if (!owner) return;
    const gen = this._generation = (this._generation || 0) + 1;
    this.setData({ loading: true, ready: false, error: '', sessionExpired: false });
    try {
      await ui.loadClasses(this);
      if (!this.current(gen, owner)) return;
      const conversation = await api.request(conversationPath);
      if (!this.current(gen, owner)) return;
      this.applyConversation(conversation);
      this.setData({ ready: true });
      const context = await api.request('/api/banban/context?' + ui.query({ classId: this.data.classId }));
      if (this.current(gen, owner)) this.showQuota(context.quota);
    } catch (error) {
      if (this._visible && this._generation === gen) ui.fail(this, error);
    } finally { if (this._visible && this._generation === gen) this.setData({ loading: false }); }
  },
  applyConversation(saved) {
    if (!saved || !Array.isArray(saved.messages)) throw new Error('未能读取班班对话，请刷新重试。');
    this._messageKey = 0;
    this.setData({
      threadId: saved.id || '', threadTitle: saved.title || '', beforeId: saved.hasMore ? saved.beforeId : null,
      messages: saved.messages.map(item => messageView(item, ++this._messageKey))
    });
  },
  showQuota(quota) {
    if (quota) this.setData({ quotaText: quota.remaining === null ? '本月不限次数' : '本月剩余 ' + quota.remaining + ' 次' });
  },
  input(event) { this.setData({ input: event.detail.value }); ui.setDirty(Boolean(event.detail.value)); },
  changeClass(event) {
    if (this.data.busy || this.data.managing || this.data.loading || this.data.operationBusy) return;
    ui.chooseClass(this, event.detail.value);
  },
  async send() {
    if (this.data.busy || this.data.loading || this.data.managing || this.data.operationBusy || !this.data.ready || !ui.requireLogin()) return;
    const input = this.data.input.trim();
    if (!input) { this.setData({ error: '请输入想问班班的问题。' }); return; }
    const gen = this._generation, owner = currentUserId();
    const current = () => this.current(gen, owner);
    let complete = null, streamError = '', partial = '';
    this.setData({ busy: true, error: '', status: '班班正在思考…', pending: '', showThreads: false, reviewingId: '' });
    this.queueOperationRead(gen, owner);
    try {
      await api.request('/api/banban/chat/stream', {
        method: 'POST', timeout: 400000,
        data: { message: input, ...(this.data.threadId ? { conversationId: this.data.threadId } : {}), scope: { classId: this.data.classId }, page: 'reading' },
        onEvent: event => {
          if (!current()) return;
          if (event.type === 'meta') this.showQuota(event.quota);
          else if (event.type === 'status' && event.text) this.setData({ status: event.text });
          else if (event.type === 'error') streamError = event.error || '班班未能完成本次回答。';
          else if (event.type === 'done') complete = event;
          else if (event.type === 'operation') this.updateOperation(event.operation);
          else if (event.type === 'answer_reset' || event.type === 'delta') {
            partial = event.type === 'answer_reset' ? '' : partial + String(event.text || '');
            if (!this._textTimer) this._textTimer = setTimeout(() => {
              this._textTimer = null;
              if (current()) this.setData({ pending: partial });
            }, 120);
          }
        }
      });
      if (!current()) return;
      if (!complete || !complete.message) throw Object.assign(new Error(streamError || '班班回复未完成。请先核对历史对话，再决定是否重试。'), { ambiguous: !streamError });
      const firstTurn = !this.data.messages.length;
      this.setData({
        messages: this.data.messages.concat([messageView({ role: 'user', content: input }, ++this._messageKey), messageView(complete.message, ++this._messageKey)]),
        threadId: complete.conversationId || this.data.threadId, threadTitle: firstTurn ? input.slice(0, 40) : this.data.threadTitle,
        input: '', pending: '', status: '班班已回复。'
      });
      ui.setDirty(false);
    } catch (error) {
      if (this._visible && this._generation === gen && error.code !== 'session_changed') {
        ui.fail(this, error);
        this.setData({ pending: partial, status: partial ? '回答未完成，已保留收到的内容。' : '', ready: !error.ambiguous && error.status !== 401 });
        if (error.data && error.data.quota) this.showQuota(error.data.quota);
      }
    } finally {
      clearTimeout(this._operationTimer);
      clearTimeout(this._textTimer);
      this._textTimer = null;
      this.setData({ busy: false, stopping: false });
      if (this._visible && !current() && api.getUser()) this.load();
    }
  },
  queueOperationRead(gen, owner) {
    clearTimeout(this._operationTimer);
    // Some supported clients deliver the entire response in one callback.
    // Read the signed-in teacher's pending operations independently while they wait.
    this._operationTimer = setTimeout(async () => {
      if (!this.current(gen, owner) || !this.data.busy) return;
      if (!this.data.operationBusy) await this.fetchOperations(gen, owner, false);
      if (this.current(gen, owner) && this.data.busy) this.queueOperationRead(gen, owner);
    }, 4500);
  },
  async fetchOperations(gen, owner, reportError) {
    try {
      const result = await api.request(operationPath, { timeout: 8000 });
      if (!this.current(gen, owner) || !Array.isArray(result.operations)) return;
      const tracked = new Set(this.data.operations.map(item => item.id));
      const operations = result.operations.filter(item => tracked.has(item.id) || ['awaiting_confirmation','awaiting_input'].includes(item.status))
        .map(item => operationView(item, ui.formatTime)).filter(Boolean);
      const uncertain = this.data.uncertainOperationId;
      const reconciled = reportError && !this.data.operationBusy && uncertain && operations.some(item => item.id === uncertain);
      this.setData({ operations, ...(reconciled ? { uncertainOperationId: '', operationWarning: '状态已刷新，请核对操作结果。' } : {}) });
    } catch (error) {
      if (this._visible && this._generation === gen && (reportError || error.status === 401)) ui.fail(this, error);
    }
  },
  async refreshOperations() {
    if (this.data.actionRead || this.data.operationBusy || !api.getUser()) return;
    this.setData({ actionRead: true });
    try { await this.fetchOperations(this._generation, api.getUser().id, true); }
    finally { this.setData({ actionRead: false }); }
  },
  updateOperation(raw) {
    const item = operationView(raw, ui.formatTime);
    if (!item) return;
    const items = this.data.operations.slice();
    const index = items.findIndex(value => value.id === item.id);
    if (index < 0) items.unshift(item); else items[index] = item;
    this.setData({ operations: items.slice(0, 40) });
  },
  selectOperation(event) {
    const { id } = event.currentTarget.dataset;
    if (this.data.operationBusy || !this.data.operations.some(item => item.id === id)) return;
    this.setData({ reviewingId: this.data.reviewingId === id ? '' : id,
      ...(this.data.uncertainOperationId ? {} : { operationWarning: '' }) });
  },
  unverifiedOperation(id) {
    return { uncertainOperationId: id, operationWarning: '未能确认请求结果。请刷新操作列表核对状态，避免重复执行。' };
  },
  async commitOperation(event) {
    const { id, decision } = event.currentTarget.dataset;
    const owner = currentUserId(), gen = this._generation;
    if (!owner || !this._visible || !opId.test(id || '') || this.data.operationBusy || this.data.actionRead || this.data.reviewingId !== id || this.data.uncertainOperationId) return;
    if (!['confirm', 'cancel'].includes(decision)) return;
    const initial = this.data.operations.find(item => item.id === id);
    const confirm = decision === 'confirm';
    if (!initial || !(confirm ? initial.confirmable : initial.cancellable)) return;
    const url = operationPath + '/' + encodeURIComponent(id);
    this.setData({ operationBusy: true, operationWarning: '' });
    try {
      const fresh = await api.request(url);
      if (!this.current(gen, owner)) return;
      this.updateOperation(fresh);
      const preview = operationView(fresh, ui.formatTime);
      if (!preview || preview.id !== id || preview.signature !== initial.signature || !(confirm ? preview.confirmable : preview.cancellable)) {
        this.setData({ operationWarning: '操作状态已变化，请重新核对。' }); return;
      }
      const description = preview.title + '\n目标：' + preview.target + (confirm && preview.impact ? '\n' + preview.impact : '');
      if (!await ui.confirm(confirm ? '确认执行' : '取消这项操作', description, confirm ? '执行' : '取消操作') || !this.current(gen, owner)) return;
      this._dispatchedOperation = id;
      const result = await api.request(url + '/' + decision, { method: 'POST', data: confirm ? { confirmed: true } : {} });
      if (this.current(gen, owner)) this.updateOperation(result);
    } catch (error) {
      if (this._visible && this._generation === gen && error.code !== 'session_changed') {
        if (error.ambiguous && this._dispatchedOperation) this.setData(this.unverifiedOperation(id));
        if (error.status === 401) ui.fail(this, error);
        else if (!error.ambiguous) this.setData({ operationWarning: error.message });
      }
    } finally { this._dispatchedOperation = null; this.setData({ operationBusy: false }); }
  },
  async stop() {
    if (!this.data.busy || this.data.stopping || this.data.operationBusy) return;
    this.setData({ stopping: true });
    try { await api.request('/api/banban/chat/cancel', { method: 'POST', data: {} }); }
    catch (error) { ui.fail(this, error); }
    finally { this.setData({ stopping: false }); }
  },
  async toggleThreads() {
    if (this.data.busy || this.data.managing || this.data.operationBusy) return;
    const show = !this.data.showThreads;
    this.setData({ showThreads: show });
    if (show) await this.readThreads(false);
  },
  async readThreads(append) {
    if (this.data.busy || this.data.managing || this.data.operationBusy || !this._visible) return;
    const cursor = append ? this.data.threadCursor : null;
    if (append && !cursor) return;
    const gen = this._generation, owner = currentUserId();
    this.setData({ managing: true, error: '' });
    try {
      const saved = await api.request(threadsPath + (cursor ? '?' + ui.query({ beforeUpdated: cursor.updatedAt, beforeId: cursor.id }) : ''));
      if (!this.current(gen, owner)) return;
      const items = Array.isArray(saved.conversations) ? saved.conversations.map(thread => ({ id: thread.id, title: thread.title, time: ui.formatTime(thread.updatedAt) })) : [];
      this.setData({ threads: (append ? this.data.threads : []).concat(items), threadCursor: saved.nextCursor || null });
    } catch (error) { if (this._visible && this._generation === gen) ui.fail(this, error); }
    finally { this.setData({ managing: false }); }
  },
  moreThreads() { return this.readThreads(true); },
  async olderMessages() {
    if (!this.data.beforeId || !this.data.threadId || this.data.busy || this.data.managing || !this._visible) return;
    const gen = this._generation, owner = currentUserId();
    this.setData({ managing: true, error: '' });
    try {
      const saved = await api.request(conversationPath + '?' + ui.query({ conversationId: this.data.threadId, before: this.data.beforeId }));
      if (this.current(gen, owner)) this.setData({
        messages: saved.messages.map(item => messageView(item, ++this._messageKey)).concat(this.data.messages),
        beforeId: saved.hasMore ? saved.beforeId : null
      });
    } catch (error) { if (this._visible && this._generation === gen) ui.fail(this, error); }
    finally { this.setData({ managing: false }); }
  },
  newThread() { return this.changeThread('', 'new'); },
  openThread(event) { return this.changeThread(event.currentTarget.dataset.id, 'open'); },
  deleteThread(event) { return this.changeThread(event.currentTarget.dataset.id, 'delete'); },
  async changeThread(id, action) {
    if (!this._visible || this.data.busy || this.data.loading || this.data.managing || this.data.operationBusy) return;
    if (action !== 'new' && (!opId.test(id || '') || !this.data.threads.some(item => item.id === id))) return;
    const gen = this._generation, owner = currentUserId();
    const path = id ? threadsPath + '/' + encodeURIComponent(id) : threadsPath;
    this.setData({ managing: true, error: '' });
    try {
      const deleting = action === 'delete';
      const discard = Boolean(this.data.input && (!deleting || id === this.data.threadId));
      const thread = this.data.threads.find(item => item.id === id);
      if (deleting || discard) {
        const text = deleting ? '将删除“' + thread.title + '”。' : '切换后会清除尚未发送的问题。';
        if (!await ui.confirm(deleting ? '删除对话' : '切换对话', text + (deleting && discard ? '\n尚未发送的问题也会清除。' : ''), deleting ? '删除' : '切换')) return;
      }
      if (!this.current(gen, owner)) return;
      const saved = await api.request(path + (action === 'open' ? '/open' : ''), { method: deleting ? 'DELETE' : 'POST', ...(deleting ? {} : { data: {} }) });
      if (!this.current(gen, owner)) return;
      if (deleting) {
        this.setData({ threads: this.data.threads.filter(item => item.id !== id) });
        if (id === this.data.threadId) this.applyConversation(saved.conversation);
      } else this.applyConversation(saved);
      this.setData({ ready: true, pending: '', status: '', showThreads: deleting });
      if (discard) { this.setData({ input: '' }); ui.setDirty(false); }
    } catch (error) {
      if (this._visible && this._generation === gen) {
        ui.fail(this, error);
        if (error.ambiguous) this.setData({ ready: false });
      }
    } finally { this.setData({ managing: false }); }
  },
  relogin: ui.relogin
});

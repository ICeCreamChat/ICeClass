'use strict';
const api = require('../../lib/api');
const ui = require('../../lib/ui');
const paper = require('../../lib/paper-data');
const { CameraScanner } = require('../../lib/paper-scanner');

Page({
  data: {
    classes: [], classNames: [], classIndex: 0, classId: '', className: '', code: '', pairId: '',
    loading: false, busy: false, error: '', status: '', sessionExpired: false, pairUncertain: false,
    state: null, connected: false, canStart: false, canEnd: false, canAdd: false, canEdit: false, collecting: false, paused: false,
    roundText: '', answerNames: [], answerIndex: 0, cardNumber: '', pendingCount: 0, pendingRows: [], unknownCount: 0,
    cameraOn: false, cameraOpening: false, privacyNeeded: false, cameraDenied: false,
    typeNames: paper.TYPES.map(type => type.name), typeIndex: 0, countNames: ['2', '3', '4'], countIndex: 2,
    draft: { type: 'single', text: '', options: ['', '', '', ''], answerText: '', tagsText: '' }, draftDirty: false,
    editNames: ['标准答案', '题干', '知识点'], editFields: ['answer', 'text', 'tags'], editIndex: 0, editValue: '', editDirty: false
  },
  onLoad(options) {
    this._expectedClassId = options.classId || ''; this._expectedSessionId = options.sessionId || '';
    this._pending = new Map(); this._generation = 0; this._visibility = 0; this._cameraIntent = 0; this._failures = 0;
  },
  async onShow() {
    this._visible = true;
    if (!ui.requireLogin()) { this.onHide(); return; }
    const owner = api.getUser();
    if (this._ownerId && this._ownerId !== owner.id) { this.onHide(); return; }
    this._ownerId = owner.id;
    this.setData({ sessionExpired: false });
    if (this._pair) { this._needsRead = true; this._failures = 0; return this.refreshRoom(); }
    return this.prepare();
  },
  onHide() {
    this._visible = false; this._visibility++; this._generation++; this._needsRead = false; clearTimeout(this._timer); this._timer = null;
    this.stopCamera(); this.setData({ loading: false, connected: false, collecting: false, canStart: false, canEnd: false, canAdd: false, canEdit: false });
  },
  onUnload() { this.onHide(); ui.setDirty(false); },
  async onPullDownRefresh() { try { if (this._pair) await this.refreshRoom(); else await this.prepare(); } finally { wx.stopPullDownRefresh(); } },
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
    if (error.status === 401) {
      this.stopCamera(); clearTimeout(this._timer); this._timer = null; this._needsRead = false;
      this.setData({ connected: false, collecting: false, canStart: false, canEnd: false, canAdd: false, canEdit: false });
    }
    ui.fail(this, error); return true;
  },
  async prepare() {
    if (!this.current() || this.data.busy) return;
    const generation = ++this._generation, context = this.errorContext(generation);
    this.setData({ loading: true, error: '', sessionExpired: false });
    try {
      await ui.loadClasses(this);
      if (!this.current() || generation !== this._generation) return;
      if (this._expectedClassId) {
        const index = this.data.classes.findIndex(item => item.id === this._expectedClassId);
        if (index < 0) throw new Error('当前账号不能访问此班级，请返回工作台核对权限。');
        ui.chooseClass(this, index);
      }
      this.setData({ className: this.data.classNames[this.data.classIndex] || '' });
    } catch (error) { this.reportError(error, context); }
    finally { if (generation === this._generation) this.setData({ loading: false }); }
  },
  inputCode(event) { if (!this.data.busy && !this._pair) this.setData({ code: event.detail.value }); },
  async claimPair() {
    if (!this.current() || this.data.busy || this.data.loading || this.data.pairUncertain || this._pair || !this.data.classId || !ui.requireLogin()) return;
    const code = this.data.code.trim().toUpperCase();
    if (!/^[A-F0-9]{12}$/.test(code)) { this.setData({ error: '请输入教室端显示的 12 位配对码。' }); return; }
    const context = this.errorContext();
    this.setData({ busy: true, error: '', sessionExpired: false });
    try {
      const result = await api.request('/api/card-quiz/pair', { method: 'POST', data: { code } });
      const pair = paper.readPair(result, this.data.classId, this._expectedSessionId);
      if (!api.getUser() || api.getUser().id !== this._ownerId) return;
      this._pair = pair;
      this.setData({ pairId: pair.pairId, status: '配对码已领取。请在教室端确认使用本手机，再刷新课堂连接。' });
      if (this.current()) await this.refreshRoom();
    } catch (error) {
      if (!this.acceptsError(error, context)) return;
      if (paper.unknownWrite(error)) this.setData({ pairUncertain: true, status: '配对结果未确认，配对码不会自动重试。请在教室端生成新码后重新接入。' });
      this.reportError(error, context);
    } finally { this.setData({ busy: false }); }
  },
  async newPairCode() {
    if (this.data.busy || this._pair || !this.current()) return;
    this.setData({ busy: true }); const generation = this._generation;
    try {
      if (!await ui.confirm('使用新配对码', '请先在教室端重新生成配对码。旧码的领取结果仍以教室端为准。', '使用新码')) return;
      if (!this.current() || generation !== this._generation) return;
      this.setData({ code: '', pairUncertain: false, error: '', status: '' });
    } finally { this.setData({ busy: false }); }
  },
  applyState(value, connected) {
    const next = paper.readState(value, this._pair.sessionId), old = this.data.state;
    if (old && next.seq < old.seq) return;
    if (old && paper.contextKey(old) !== paper.contextKey(next) || !connected || next.ended) this.stopCamera();
    const flags = paper.flags(next, this._pair.pairId, connected);
    const answerNames = (next.questionType === 'multiple' ? ['A · 选', 'B · 不选'] : paper.LETTERS.slice(0, next.optionCount).split('').map(letter => next.questionType === 'boolean' ? letter + (letter === 'A' ? ' · 正确' : ' · 错误') : letter));
    this.setData({ state: next, connected: Boolean(connected), ...flags, answerNames, answerIndex: Math.min(this.data.answerIndex, Math.max(0, answerNames.length - 1)),
      roundText: next.ended ? '课堂已结束' : !flags.own ? '等待教室端确认手机来源或恢复连接' : next.roundStatus === 'collecting' ? '正在收答' : next.roundStatus === 'paused' ? '已暂停，请在教室端恢复，或封存本轮后重答' : next.roundStatus === 'closed' ? '本轮已封存' : '已连接，尚未开始收答' });
  },
  pendingView() {
    const rows = Array.from(this._pending.values()).map(item => ({ id: item.command.id, label: item.command.action === 'answer' ? item.command.payload.cardNumber + ' 号 · ' + item.command.payload.option : ({ start_round: '开始收答', end_round: '封存本轮', add_question: '添加临时题', edit_question: '修订题目', reveal: '标记讲解', set_multi_option: '切换收答项' }[item.command.action]), phase: item.phase === 'unknown' ? '结果未确认，请核对教室端' : '待教室端保存并确认' }));
    this.setData({ pendingCount: rows.length, pendingRows: rows, unknownCount: Array.from(this._pending.values()).filter(item => item.phase === 'unknown').length });
    ui.setDirty(Boolean(rows.length || this.data.draftDirty || this.data.editDirty || this.data.cardNumber));
  },
  settle(commandId, receipt) {
    const item = this._pending.get(commandId); if (!item) return;
    if (receipt.status === 'confirmed') {
      const result = receipt.result || receipt;
      // A receipt without its saved state is not proof of completion.
      const next = paper.readState(result.state, this._pair.sessionId);
      this._pending.delete(commandId); this.applyState(next, this.data.connected);
      if (item.command.action === 'add_question') { this._draftContext = null; this.setData({ draftDirty: false }); }
      if (item.command.action === 'edit_question') { this._editContext = null; this.setData({ editDirty: false, editValue: '' }); }
      this.setData({ status: '教室端已保存并确认：' + (item.command.action === 'answer' ? item.command.payload.cardNumber + ' 号作答。' : '本次课堂操作。') });
    } else if (receipt.status === 'rejected') {
      this._pending.delete(commandId); this.stopCamera();
      this.setData({ error: receipt.error || '教室端拒绝了此操作，请核对题目与轮次。', status: '本次操作未获教室端确认。草稿已保留。' });
    } else if (receipt.status !== 'pending') throw new Error('命令回执格式无效，结果仍待核对。');
    this.pendingView();
  },
  async refreshRoom() {
    if (!this.current() || !this._pair || this._reading || this._confirming) return;
    if (Date.now() - (this._lastReadAt || 0) < 1100) { this.scheduleRead(); return; }
    const generation = ++this._generation, pair = this._pair, context = this.errorContext(generation);
    this._lastReadAt = Date.now(); this._reading = true;
    this.setData({ loading: true });
    try {
      const query = Array.from(this._pending.keys()).map(id => 'commandId=' + encodeURIComponent(id)).join('&');
      const result = await api.request('/api/card-quiz/pairs/' + encodeURIComponent(pair.pairId) + (query ? '?' + query : ''));
      if (!this.current() || generation !== this._generation || this._pair !== pair) return;
      this.applyState(result.state, result.connected === true); this._failures = 0; this._needsRead = false;
      this.setData({ error: '', sessionExpired: false });
      for (const receipt of result.receipts || []) this.settle(receipt.id, receipt);
      for (const item of this._pending.values()) if (Date.now() - item.createdAt > 60000) item.phase = 'unknown';
      this.pendingView();
      if (this.data.unknownCount) { this.stopCamera(); this.setData({ status: '仍有操作结果未确认。请核对教室端，手机不会自动重发。' }); }
    } catch (error) {
      if (this._pair === pair && this.acceptsError(error, context)) { this._needsRead = false; this._failures++; this.stopCamera(); this.setData({ connected: false, collecting: false, canStart: false, canEnd: false, canAdd: false, canEdit: false }); this.reportError(error, context); }
    } finally {
      this._reading = false;
      if (generation === this._generation) this.setData({ loading: false });
      this.scheduleRead();
    }
  },
  scheduleRead() {
    clearTimeout(this._timer); this._timer = null;
    const waiting = Array.from(this._pending.values()).some(item => Date.now() - item.createdAt < 60000);
    if (this.current() && !this.data.sessionExpired && this._pair && !this._confirming && this._failures < 3 && (this.data.cameraOn || waiting || this._needsRead)) this._timer = setTimeout(() => { this._timer = null; void this.refreshRoom(); }, 1500);
  },
  async sendCommand(action, payload) {
    if (!this.current() || !this._pair || this.data.unknownCount) throw new Error('请先核对未确认操作或重新连接课堂。');
    if (this._pending.size >= 64) throw new Error('待确认操作较多，请等待教室端保存。');
    if (action === 'answer' && Array.from(this._pending.values()).some(item => item.command.action === 'answer' && item.command.payload.cardNumber === payload.cardNumber)) throw new Error('该卡号已有待确认作答，请核对后再修改。');
    const pair = this._pair, context = this.errorContext(), command = paper.command(this.data.state, pair.pairId, this.data.connected, action, payload);
    this._pending.set(command.id, { command, phase: 'sending', createdAt: Date.now() }); this.pendingView();
    this.setData({ status: '操作待教室端保存并确认。', error: '' });
    try {
      const result = await api.request('/api/card-quiz/pairs/' + encodeURIComponent(pair.pairId) + '/commands', { method: 'POST', data: command });
      if (!this.current() || this._pair !== pair) return;
      this.settle(command.id, result);
    } catch (error) {
      if (!this.acceptsError(error, context) || this._pair !== pair) return;
      if (paper.unknownWrite(error)) {
        const item = this._pending.get(command.id); if (item) item.phase = 'unknown';
        this.setData({ status: '提交结果未确认。请刷新核对回执，或在教室端核对；不会自动重发。' });
      } else this._pending.delete(command.id);
      this.stopCamera(); this.reportError(error, context); this.pendingView();
    } finally { this.scheduleRead(); }
  },
  async perform(action, payload, title, content, confirmText = '确定') {
    if (!this.current() || this.data.busy || this.data.loading || this.data.pendingCount || !ui.requireLogin()) return;
    this._confirming = true; this.setData({ busy: true, error: '' });
    const generation = this._generation, key = paper.contextKey(this.data.state);
    this.stopCamera();
    try {
      if (title && !await ui.confirm(title, content, confirmText)) return;
      if (!this.current() || generation !== this._generation || key !== paper.contextKey(this.data.state)) return;
      await this.sendCommand(action, payload);
    } catch (error) { if (this.current()) ui.fail(this, error); }
    finally { this._confirming = false; this.setData({ busy: false }); this.scheduleRead(); }
  },
  startRound() { return this.perform('start_round', {}, '开始新轮次', '将为当前题目开启一个新收答轮次。已经讲解的题目会记为练习。相机需另行主动开启。', '开始收答'); },
  endRound() { return this.perform('end_round', {}, '封存本轮', '封存后不能继续修改本轮作答。是否请求教室端封存？', '封存本轮'); },
  inputCard(event) { if (!this.data.busy && !this.data.pendingCount) { this.setData({ cardNumber: event.detail.value }); ui.setDirty(Boolean(event.detail.value)); } },
  chooseAnswer(event) { if (!this.data.busy && !this.data.pendingCount) this.setData({ answerIndex: Number(event.detail.value) }); },
  manualAnswer() {
    if (!/^\d{1,3}$/.test(this.data.cardNumber.trim())) { this.setData({ error: '请填写 1-157 的纸卡编号。' }); return; }
    return this.perform('answer', { cardNumber: Number(this.data.cardNumber.trim()), option: paper.LETTERS[this.data.answerIndex] });
  },
  multiOption(event) { return this.perform('set_multi_option', { option: event.currentTarget.dataset.option }, '切换收答项', '切换多选项后，请学生重新调整卡面，再主动开启相机。', '切换选项'); },
  inputDraft(event) {
    if (this.data.busy || this.data.pendingCount) return;
    const field = event.currentTarget.dataset.field;
    if (!['text', 'answerText', 'tagsText'].includes(field)) return;
    if (!this.data.draftDirty) this._draftContext = paper.contextKey(this.data.state);
    this.setData({ ['draft.' + field]: event.detail.value, draftDirty: true }); ui.setDirty(true);
  },
  draftOption(event) {
    if (this.data.busy || this.data.pendingCount) return;
    const index = Number(event.currentTarget.dataset.index), options = this.data.draft.options.slice();
    if (!Number.isInteger(index) || index < 0 || index >= options.length) return;
    options[index] = event.detail.value; if (!this.data.draftDirty) this._draftContext = paper.contextKey(this.data.state);
    this.setData({ 'draft.options': options, draftDirty: true }); ui.setDirty(true);
  },
  draftType(event) {
    if (this.data.busy || this.data.pendingCount) return;
    const index = Number(event.detail.value), type = paper.TYPES[index]; if (!type) return;
    if (!this.data.draftDirty) this._draftContext = paper.contextKey(this.data.state);
    this.setData({ typeIndex: index, 'draft.type': type.id, 'draft.options': type.id === 'boolean' ? ['正确', '错误'] : ['', '', '', ''], 'draft.answerText': '', countIndex: 2, draftDirty: true }); ui.setDirty(true);
  },
  draftCount(event) {
    if (this.data.busy || this.data.pendingCount || this.data.draft.type === 'boolean') return;
    const index = Number(event.detail.value); if (![0, 1, 2].includes(index)) return;
    const options = this.data.draft.options.slice(0, index + 2); while (options.length < index + 2) options.push('');
    if (!this.data.draftDirty) this._draftContext = paper.contextKey(this.data.state);
    this.setData({ countIndex: index, 'draft.options': options, 'draft.answerText': '', draftDirty: true }); ui.setDirty(true);
  },
  addQuestion() {
    try {
      if (this.data.draftDirty && this._draftContext !== paper.contextKey(this.data.state)) throw new Error('课堂题目或轮次已变化，草稿已保留。请核对后重新整理临时题。');
      return this.perform('add_question', paper.questionPayload(this.data.draft), '添加临时题', '把下方题目作为本课堂的下一题。此操作不会保存到个人题库。', '添加题目');
    } catch (error) { ui.fail(this, error); }
  },
  chooseEdit(event) { if (!this.data.busy && !this.data.pendingCount && !this.data.editDirty) this.setData({ editIndex: Number(event.detail.value) }); },
  inputEdit(event) {
    if (this.data.busy || this.data.pendingCount) return;
    if (!this.data.editDirty) this._editContext = { key: paper.contextKey(this.data.state), seq: this.data.state && this.data.state.seq };
    this.setData({ editValue: event.detail.value, editDirty: true }); ui.setDirty(true);
  },
  saveEdit() {
    try {
      if (!this.data.editDirty || !this._editContext || this._editContext.key !== paper.contextKey(this.data.state) || this._editContext.seq !== this.data.state.seq) throw new Error('题目或版本已变化，草稿已保留，请核对后重新编辑。');
      return this.perform('edit_question', paper.editPayload(this.data.state, this.data.editFields[this.data.editIndex], this.data.editValue), '修订当前题目', '使用下方内容修订当前题目。留空的标准答案表示不评分。', '提交修订');
    } catch (error) { ui.fail(this, error); }
  },
  reveal() { return this.perform('reveal', { external: true }, '标记已经讲解', '请确认已向学生讲解本题。此后重答会计为练习。', '已经讲解'); },
  async clearDrafts() {
    if (!this.current() || this.data.busy || this.data.pendingCount) return;
    this.setData({ busy: true }); const generation = this._generation;
    try {
      if (!await ui.confirm('清空编辑草稿', '清空临时题与修订草稿？课堂已保存的内容不受影响。', '清空草稿')) return;
      if (!this.current() || generation !== this._generation) return;
      this._draftContext = this._editContext = null;
      this.setData({ draft: { type: 'single', text: '', options: ['', '', '', ''], answerText: '', tagsText: '' }, typeIndex: 0, countIndex: 2, draftDirty: false, editValue: '', editDirty: false }); this.pendingView();
    } finally { this.setData({ busy: false }); }
  },
  stopCamera() {
    this._cameraIntent = (this._cameraIntent || 0) + 1; this._consent = null;
    if (this._scanner) { this._scanner.stop(); this._scanner = null; }
    this.setData({ cameraOn: false, cameraOpening: false, privacyNeeded: false });
  },
  cameraAllowed(consent) { return Boolean(consent && this.current() && this._pair && this._pair.expiresAt > Date.now() && consent.intent === this._cameraIntent && consent.key === paper.contextKey(this.data.state) && this.data.collecting && this.data.connected && !this.data.unknownCount); },
  async startCamera() {
    if (!this.current() || !this.data.collecting || this.data.busy || this.data.pendingCount || this.data.loading || this.data.cameraOn) return;
    this.stopCamera(); this.setData({ cameraOpening: true, error: '' });
    const consent = { intent: this._cameraIntent, key: paper.contextKey(this.data.state) };
    try {
      if (!await ui.confirm('开启纸卡相机', '使用后置相机在本机识别纸卡，不拍照、不录像、不上传画面。仅向配对课堂提交卡号与选项。', '同意开启')) return;
      if (!this.cameraAllowed(consent)) return;
      if (typeof wx.getPrivacySetting !== 'function' || typeof wx.authorize !== 'function') throw new Error('当前微信版本不支持本页隐私授权，请更新微信或使用手工录入。');
      const privacy = await new Promise((resolve, reject) => wx.getPrivacySetting({ success: resolve, fail: () => reject(new Error('未能核对隐私授权，相机未开启。')) }));
      if (!this.cameraAllowed(consent)) return;
      if (privacy.needAuthorization) { this._consent = consent; this.setData({ privacyNeeded: true }); return; }
      await this.authorizeCamera(consent);
    } catch (error) { if (this.current()) ui.fail(this, error); }
    finally { this.setData({ cameraOpening: false }); }
  },
  async agreeCameraPrivacy() {
    if (this.data.cameraOpening) return;
    const consent = this._consent;
    if (!this.cameraAllowed(consent)) { this.stopCamera(); return; }
    this.setData({ cameraOpening: true });
    try { await this.authorizeCamera(consent); } catch (error) { if (this.current()) ui.fail(this, error); }
    finally { this.setData({ cameraOpening: false }); }
  },
  async authorizeCamera(consent) {
    if (!this.cameraAllowed(consent)) return;
    try {
      await new Promise((resolve, reject) => wx.authorize({ scope: 'scope.camera', success: resolve, fail: () => reject(new Error('相机权限未获授权，仍可手工录入。可到微信设置中允许相机后重试。')) }));
      if (this.cameraAllowed(consent)) this.setData({ cameraOn: true, cameraDenied: false, privacyNeeded: false });
    } catch (error) { if (this.cameraAllowed(consent)) this.setData({ cameraDenied: true }); throw error; }
  },
  openCameraSettings() { if (this.current() && typeof wx.openSetting === 'function') wx.openSetting({ fail: () => this.setData({ error: '无法打开微信设置，请手工检查相机权限。' }) }); },
  openPrivacy() { if (!this.current()) return; if (typeof wx.openPrivacyContract === 'function') wx.openPrivacyContract({ fail: () => this.setData({ error: '未能打开隐私保护指引，相机未开启。' }) }); else this.setData({ error: '当前微信不能打开隐私保护指引，请更新微信，相机未开启。' }); },
  cameraReady() {
    if (!this.current() || !this.data.cameraOn || !this.data.collecting || this.data.unknownCount) { this.stopCamera(); return; }
    try {
      const key = paper.contextKey(this.data.state);
      if (this._scanner) this._scanner.stop();
      this._scanner = new CameraScanner({ onRead: (read, captured) => {
        if (!this.current() || captured !== paper.contextKey(this.data.state) || !this.data.collecting || this.data.busy) throw new Error('题目、轮次或采集来源已变化，请核对后重新开启相机。');
        return this.sendCommand('answer', read);
      }, onStatus: message => { if (!this.current()) return; if (this._scanner && !this._scanner.running) this.stopCamera(); this.setData({ error: message }); } });
      this._scanner.start(wx.createCameraContext(), key, this.data.state.questionType === 'multiple' ? 2 : this.data.state.optionCount);
      this.scheduleRead();
    } catch (error) { this.stopCamera(); ui.fail(this, error); }
  },
  cameraError() { const wasOn = this.data.cameraOn; this.stopCamera(); if (this.current() && wasOn) this.setData({ error: '相机不可用或已停止。请核对微信相机权限，或使用手工录入。' }); },
  async disconnect() {
    if (!this.current() || this.data.busy) return;
    this._confirming = true; this.setData({ busy: true }); const generation = this._generation;
    try {
      if (!await ui.confirm('断开本机', '停止本机识别。已发送但未确认的操作仍可能在教室端执行，请先核对；随后请在教室端换回本机来源。', '断开本机')) return;
      if (!this.current() || generation !== this._generation) return;
      this.stopCamera(); clearTimeout(this._timer); this._timer = null; this._generation++;
      this._pair = null; this._pending.clear(); this._lastReadAt = 0;
      this.setData({ pairId: '', code: '', state: null, connected: false, canStart: false, canEnd: false, canAdd: false, canEdit: false, collecting: false, paused: false, status: '本机已断开。请在教室端核对待确认操作，并切换采集来源。' }); this.pendingView();
    } finally { this._confirming = false; this.setData({ busy: false }); }
  }
});

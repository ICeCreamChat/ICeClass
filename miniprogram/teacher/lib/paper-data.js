'use strict';
// Contracts: server/card_quiz_relay.py, card_quiz.py and web_controller/card-quiz/model.js.
const AR = require('./paper-vendor/aruco');
const LETTERS = 'ABCD';
const TYPES = [{ id: 'single', name: '单选题' }, { id: 'boolean', name: '判断题' }, { id: 'multiple', name: '多选题' }];
let serial = 0;
const fail = message => { throw new Error(message); };
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const id = value => typeof value === 'string' && Boolean(value.trim()) && Array.from(value).length <= 128 && !/[\u0000-\u001f]/.test(value) && !value.startsWith('data:') && !Array.from(value).some(char => { const n = char.codePointAt(0); return n >= 0xd800 && n <= 0xdfff; });
const copy = value => JSON.parse(JSON.stringify(value));
function requestId() { return 'mp-' + Date.now().toString(36) + '-' + (++serial).toString(36) + '-' + Math.random().toString(36).slice(2, 12); }
function readPair(value, classId, sessionId) {
  if (!value || !id(value.pairId) || !id(value.classId) || !id(value.sessionId) || !integer(value.expiresAt, 1)) fail('配对响应不完整，请在教室端重新生成配对码。');
  if (classId && value.classId !== classId || sessionId && value.sessionId !== sessionId) fail('配对码属于其他班级或课堂，未接入。请核对教室端并使用新的配对码。');
  return copy(value);
}
function readState(value, sessionId) {
  if (!value || value.sessionId !== sessionId || !id(value.sessionId) || !integer(value.generation, 1) || !integer(value.seq) ||
      !integer(value.expected, 0, 300) || !integer(value.received, 0, value.expected) || !integer(value.questionNumber, 0, 100) ||
      !['board', 'phone'].includes(value.source) || !id(value.sourceId) || typeof value.ended !== 'boolean' ||
      ![null, 'collecting', 'paused', 'closed'].includes(value.roundStatus) || ![null, 'single', 'boolean', 'multiple'].includes(value.questionType) ||
      !(value.questionId === null || id(value.questionId)) || !(value.roundId === null || id(value.roundId)) ||
      !integer(value.optionCount, 0, 4) || value.questionId && value.optionCount < 2 ||
      value.questionType === 'boolean' && value.optionCount !== 2 ||
      value.roundId === null && value.roundStatus !== null) fail('教室课堂状态不完整，请刷新核对。');
  if (value.questionType === 'multiple' && (!integer(value.optionReceived, 0, value.expected) || value.roundId && !LETTERS.slice(0, value.optionCount).includes(value.activeOption))) fail('多选收答项无效，请刷新核对。');
  return copy(value);
}
function contextKey(state) { return state ? [state.sessionId, state.questionId, state.roundId, state.generation, state.sourceId].join('/') : ''; }
function flags(state, pairId, connected) {
  const own = Boolean(state && connected && !state.ended && state.source === 'phone' && state.sourceId === pairId);
  const between = Boolean(state && (state.roundStatus === null || state.roundStatus === 'closed'));
  return { own, between, collecting: Boolean(own && state.roundStatus === 'collecting'), paused: Boolean(state && state.roundStatus === 'paused'),
    canStart: Boolean(own && between && state.questionId), canEnd: Boolean(own && state.roundId && !between), canAdd: own && between,
    canEdit: Boolean(own && between && state.questionId) };
}
function command(state, pairId, connected, action, payload, commandId = requestId()) {
  const f = flags(state, pairId, connected);
  if (!f.own) fail('教室尚未确认本手机来源、连接已断开或课堂已结束。');
  if (!id(commandId)) fail('命令编号无效。');
  payload = copy(payload || {});
  if (action === 'start_round' && !f.canStart || action === 'end_round' && !f.canEnd || ['add_question', 'edit_question', 'reveal'].includes(action) && !f.canAdd) fail('当前轮次不允许此操作，请先核对教室状态。');
  if (!['answer', 'start_round', 'end_round', 'add_question', 'edit_question', 'reveal', 'set_multi_option'].includes(action)) fail('此操作需要在教室端完成。');
  if (action === 'answer') {
    if (!f.collecting || !integer(payload.cardNumber, 1, 157) || typeof payload.option !== 'string' || payload.option.length !== 1 || !(state.questionType === 'multiple' ? 'AB' : LETTERS.slice(0, state.optionCount)).includes(payload.option)) fail('请核对收答轮次、1-157 号纸卡和有效选项。');
    if (state.questionType === 'multiple') payload.targetOption = state.activeOption;
  }
  if (action === 'set_multi_option' && (!f.collecting || state.questionType !== 'multiple' || typeof payload.option !== 'string' || payload.option.length !== 1 || !LETTERS.slice(0, state.optionCount).includes(payload.option))) fail('当前不能切换多选收答项。');
  return { id: commandId, sessionId: state.sessionId, questionId: state.questionId, roundId: state.roundId, generation: state.generation, sourceId: state.sourceId, action, payload };
}
function text(value, limit, label) {
  if (typeof value !== 'string' || Array.from(value).length > limit || Array.from(value).some(char => { const n = char.codePointAt(0); return n >= 0xd800 && n <= 0xdfff; })) fail(label + '格式错误或过长。');
  return value;
}
function answer(value, type, count) {
  const result = String(value || '').trim().toUpperCase();
  if (!result) return null;
  if (!/^[ABCD]+$/.test(result) || new Set(result).size !== result.length || Array.from(result).some(letter => !LETTERS.slice(0, count).includes(letter)) || type !== 'multiple' && result.length !== 1) fail('标准答案不在当前选项内。');
  return Array.from(result).sort().join('');
}
function tags(value) {
  const values = text(value || '', 4100, '知识点').split(/[,，、\n]/).map(item => item.trim()).filter(Boolean);
  if (values.length > 50 || new Set(values).size !== values.length) fail('知识点不能重复，最多 50 个。');
  return values.map(value => text(value, 80, '知识点'));
}
function questionPayload(draft) {
  if (!draft || !TYPES.some(type => type.id === draft.type)) fail('请选择题型。');
  const options = draft.type === 'boolean' ? ['正确', '错误'] : draft.options;
  if (!Array.isArray(options) || !integer(options.length, 2, 4)) fail('选择题需要 2-4 个选项。');
  return { type: draft.type, text: text(draft.text || '', 20000, '题干'), options: options.map(value => text(value, 2000, '选项')), answer: answer(draft.answerText, draft.type, options.length), tags: tags(draft.tagsText) };
}
function editPayload(state, field, value) {
  const payload = { expectedSeq: state.seq };
  if (field === 'answer') payload.answer = answer(value, state.questionType, state.optionCount);
  else if (field === 'tags') payload.tags = tags(value);
  else if (field === 'text') payload.text = text(value, 20000, '题干');
  else fail('请选择修订字段。');
  return payload;
}
function readCards(value, classId) {
  if (!value || value.classId !== classId || !integer(value.revision) || typeof value.canEdit !== 'boolean' || !Array.isArray(value.students)) fail('纸卡名单响应不完整，请刷新核对。');
  const ids = new Set(), numbers = new Set();
  const students = value.students.map(student => {
    if (!id(student.id) || ids.has(student.id) || typeof student.name !== 'string' || !(student.cardNumber == null || integer(student.cardNumber, 1, 157)) || student.cardNumber != null && numbers.has(student.cardNumber)) fail('名单含重复编号或无效纸卡。');
    ids.add(student.id); if (student.cardNumber != null) numbers.add(student.cardNumber);
    return { ...student, cardNumber: student.cardNumber == null ? null : student.cardNumber, draftNumber: student.cardNumber == null ? '' : String(student.cardNumber) };
  });
  return { revision: value.revision, canEdit: value.canEdit, students };
}
function bindingChanges(students, drafts) {
  const numbers = new Set(), changes = [];
  for (const student of students) {
    const draft = Object.prototype.hasOwnProperty.call(drafts, student.id) ? String(drafts[student.id]).trim() : student.cardNumber == null ? '' : String(student.cardNumber);
    if (draft && !/^\d{1,3}$/.test(draft)) fail('纸卡编号须为 1-157 的整数，留空表示解除绑定。');
    const number = draft ? Number(draft) : null;
    if (number !== null && (!integer(number, 1, 157) || numbers.has(number))) fail('纸卡编号重复或超出 1-157，请核对。');
    if (number !== null) numbers.add(number);
    if (number !== student.cardNumber) changes.push({ studentId: student.id, cardNumber: number });
  }
  return changes;
}
function cardMatrix(number) {
  if (!integer(number, 1, 157)) fail('纸卡编号须为 1-157。');
  const bits = AR.DICTIONARIES.QCMCAM_4X4_157h3.codeList[number - 1].toString(2).padStart(16, '0');
  return Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => x === 0 || y === 0 || x === 7 || y === 7 ? 1 : x === 1 || y === 1 || x === 6 || y === 6 ? 0 : Number(bits[(y - 2) * 4 + x - 2])));
}
function drawCard(ctx, number) {
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 960, 1120);
  ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.font = 'bold 36px sans-serif'; ctx.fillText('ICeClass 纸卡 ' + number, 480, 75);
  const cells = cardMatrix(number);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (!cells[y][x]) ctx.fillRect(96 + x * 96, 192 + y * 96, 96, 96);
  ctx.font = 'bold 44px sans-serif';
  for (let index = 0; index < 4; index++) { ctx.save(); ctx.translate(480, 576); ctx.rotate(index * Math.PI / 2); ctx.fillText(LETTERS[index], 0, -325); ctx.restore(); }
  ctx.font = '24px sans-serif'; ctx.fillText('单选：所选字母朝上　多选分项：A 选、B 不选', 480, 1040);
  ctx.fillText('打印请保持正方形与完整白边，不裁剪、不拉伸。', 480, 1080);
}
function unknownWrite(error) { return error && error.code !== 'session_changed' && (error.ambiguous || !error.status || error.status >= 500 || error.status >= 200 && error.status < 300); }
module.exports = { TYPES, LETTERS, requestId, readPair, readState, contextKey, flags, command, questionPayload, editPayload, readCards, bindingChanges, cardMatrix, drawCard, unknownWrite };

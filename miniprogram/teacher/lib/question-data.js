'use strict';
const subjects = [['chinese', '语文'], ['math', '数学'], ['english', '英语'], ['physics', '物理'], ['chemistry', '化学'], ['biology', '生物'], ['politics', '政治'], ['history', '历史'], ['geography', '地理']];
const types = [['single', '单选题'], ['boolean', '判断题'], ['multiple', '多选题']];
function draft(question) {
  const q = question || { subjectId: 'math', type: 'single', text: '', imageId: null, options: ['', '', '', ''], answer: null, tags: [] };
  return { ...q, options: q.options.slice(), tagsText: (q.tags || []).join('，'), answerText: q.answer || '', subjectIndex: Math.max(0, subjects.findIndex(item => item[0] === q.subjectId)), typeIndex: Math.max(0, types.findIndex(item => item[0] === q.type)) };
}
function value(editor) {
  const options = editor.options.map(option => String(option));
  if (options.length < 2 || options.length > 4 || editor.type === 'boolean' && options.length !== 2) throw new Error('请检查题型与选项数量。');
  const answer = editor.answerText.trim().toUpperCase();
  if (answer && (!/^[ABCD]+$/.test(answer) || new Set(answer).size !== answer.length || answer.length > (editor.type === 'multiple' ? options.length : 1) || Array.from(answer).some(char => 'ABCD'.indexOf(char) >= options.length))) throw new Error('标准答案须在当前选项中，单选与判断只能填写一个答案，多选不能重复。');
  const tags = editor.tagsText.split(/[,，、\n]/).map(tag => tag.trim()).filter(Boolean);
  if (new Set(tags).size !== tags.length || tags.length > 50 || tags.some(tag => tag.length > 80)) throw new Error('知识点不能重复，最多 50 个，每个最多 80 字。');
  return { subjectId: editor.subjectId, type: editor.type, text: editor.text, imageId: editor.imageId || null, options, answer: answer ? Array.from(answer).sort().join('') : null, tags };
}
function describe(q) {
  return { ...q, subjectName: (subjects.find(item => item[0] === q.subjectId) || ['', q.subjectId])[1], typeName: (types.find(item => item[0] === q.type) || ['', q.type])[1] };
}
function selectedOrder(previous, chosen) {
  return [...previous.filter(id => chosen.includes(id)), ...chosen.filter(id => !previous.includes(id))];
}
module.exports = { subjects, types, draft, value, describe, selectedOrder };

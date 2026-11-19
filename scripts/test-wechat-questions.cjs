'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const questions = require('../miniprogram/teacher/lib/question-data.js');
test('multiple-choice answers are sorted without changing question revisions or images', () => {
  const original = { id: 'q-1', revision: 3, subjectId: 'math', type: 'multiple', text: '题干', imageId: 'image-1', options: ['一', '二', '三'], answer: 'AC', tags: ['函数'] };
  const editor = questions.draft(original); editor.answerText = 'ca'; editor.options[0] = '新选项';
  const result = questions.value(editor);
  assert.equal(result.answer, 'AC'); assert.equal(result.imageId, 'image-1'); assert.equal(editor.revision, 3);
  assert.equal(original.options[0], '一'); assert.deepEqual(result.tags, ['函数']);
});
test('an absent standard answer remains ungraded, not a fabricated zero score', () => {
  assert.equal(questions.value(questions.draft()).answer, null);
});
test('duplicate and out-of-range answers are rejected', () => {
  const editor = questions.draft();
  for (const text of ['AA', 'AC', 'E']) { editor.answerText = text; assert.throws(() => questions.value(editor)); }
  editor.type = 'multiple'; editor.options = ['一', '二']; editor.answerText = 'C'; assert.throws(() => questions.value(editor));
});
test('changing a deck selection preserves existing ordering', () => {
  assert.deepEqual(questions.selectedOrder(['q2', 'q1'], ['q1', 'q2', 'q3']), ['q2', 'q1', 'q3']);
});

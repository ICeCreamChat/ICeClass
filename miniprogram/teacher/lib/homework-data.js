'use strict';

const SUBJECTS = require('./report-data').SUBJECTS.filter(subject => subject.id);
const clone = value => JSON.parse(JSON.stringify(value));
let sequence = 0;
function createId() { return 'hw-' + Date.now().toString(36) + '-' + (++sequence).toString(36) + '-' + Math.random().toString(36).slice(2, 12); }
function identifier(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error('编号格式不正确，请重新载入核对。'); return value; }
function text(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > maximum ||
    Array.from(value).some(char => char.codePointAt(0) < 32 || char.codePointAt(0) >= 0xd800 && char.codePointAt(0) <= 0xdfff)) {
    throw new Error(label + '不能为空且最多 ' + maximum + ' 字。');
  }
  return value.trim();
}
function termLabel(value) { return value.replace(/(\d{4})\s*[–—－]\s*(\d{4})(?=\s*学年)/g, '$1-$2'); }
function list(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum || value.some(item => !item || typeof item !== 'object' || Array.isArray(item)))
    throw new Error(label + '格式不正确，最多 ' + maximum + ' 项。');
  return value;
}
function unique(value, seen, label) {
  const id = identifier(value);
  if (seen.has(id)) throw new Error(label + '编号重复。');
  seen.add(id);
  return id;
}
// Match server/homework.py; normalize known text while retaining the complete draft.
function validateValue(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('请填写学期设置。');
  const value = clone(source), studentIds = new Set(), termIds = new Set();
  list(value.students, 300, '学生名单').forEach(student => {
    unique(student.id, studentIds, '学生'); student.name = text(student.name, '学生姓名', 40);
  });
  list(value.terms, 30, '学期').forEach(term => {
    unique(term.id, termIds, '学期'); term.label = termLabel(text(term.label, '学期名称', 60));
    const subjectIds = new Set(), itemIds = new Set();
    list(term.subjects, 9, '学科').forEach(subject => {
      const known = SUBJECTS.find(s => s.id === subject.id);
      if (!known || subjectIds.has(subject.id)) throw new Error('学科编号无效或重复。');
      subjectIds.add(subject.id); subject.name = known.name;
      list(subject.items, 40, '作业项目').forEach(item => {
        unique(item.id, itemIds, '作业');
        if (typeof item.active !== 'boolean') throw new Error('作业启用状态无效。');
        item.name = text(item.name, '作业名称', 50);
      });
    });
    if (subjectIds.size !== 9) throw new Error('请保留完整的九个学科。');
  });
  if (!termIds.has(identifier(value.activeTermId))) throw new Error('当前学期不存在。');
  return value;
}
function savePayload(profile, draft) {
  if (!profile || !Number.isInteger(profile.revision) || profile.revision < 0 || profile.revision > 2147483647)
    throw new Error('版本号无效，请重新载入。');
  return { revision: profile.revision, value: validateValue(draft) };
}
function readProfile(source, classId) {
  if (!source || source.classId !== classId || typeof source.canEdit !== 'boolean') throw new Error('班级作业设置响应不完整，请重新载入。');
  savePayload(source, source.value);
  return clone(source);
}
function appendStudents(source, raw, nextId = createId) {
  const names = String(raw).split(/\r?\n/).map(name => name.trim()).filter(Boolean);
  if (!names.length) throw new Error('请先填写要添加的学生姓名。');
  if (source.students.length + names.length > 300) throw new Error('学生名单最多 300 人。');
  const seen = new Set(source.students.map(student => student.name.trim()));
  names.forEach(name => {
    text(name, '学生姓名', 40);
    if (seen.has(name)) throw new Error('添加内容有重复姓名，请核对名单后再添加。');
    seen.add(name);
  });
  const value = clone(source);
  value.students.push(...names.map(name => ({ id: nextId(), name })));
  // Validate new identifiers without rejecting other unfinished editor fields.
  const ids = new Set(); value.students.forEach(student => unique(student.id, ids, '学生'));
  return value;
}
function copyTerm(source, sourceId, rawLabel, nextId = createId) {
  if (source.terms.length >= 30) throw new Error('最多保留 30 个学期。');
  const label = termLabel(text(rawLabel, '学期名称', 60));
  if (source.terms.some(term => termLabel(term.label.trim()) === label)) throw new Error('已有同名学期，请使用不同名称。');
  const from = source.terms.find(term => term.id === sourceId);
  if (!from) throw new Error('请选择要沿用作业预设的学期。');
  const term = clone(from), value = clone(source);
  const usedIds = new Set(source.terms.flatMap(t => [t.id, ...t.subjects.flatMap(s => s.items.map(item => item.id))]));
  function freshId() { const id = identifier(nextId()); if (usedIds.has(id)) throw new Error('新学期编号重复，请重试创建。'); usedIds.add(id); return id; }
  term.id = freshId(); term.label = label;
  term.subjects.forEach(subject => subject.items.forEach(item => { item.id = freshId(); }));
  value.terms.push(term);
  return value;
}
function summary(profile, value) {
  const active = value.terms.find(term => term.id === value.activeTermId);
  const beforeStudents = new Set(profile.value.students.map(student => student.id));
  const afterStudents = new Set(value.students.map(student => student.id));
  const beforeItems = profile.value.terms.flatMap(term => term.subjects.flatMap(subject => subject.items.map(item => ({ ...item, termId: term.id }))));
  const afterItems = value.terms.flatMap(term => term.subjects.flatMap(subject => subject.items.map(item => ({ ...item, termId: term.id }))));
  const afterItemIds = new Set(afterItems.map(item => item.termId + '/' + item.id));
  return '将保存「' + profile.className + '」：名单 ' + value.students.length + ' 人（新增 ' + value.students.filter(s => !beforeStudents.has(s.id)).length +
    ' 人，移除 ' + profile.value.students.filter(s => !afterStudents.has(s.id)).length + ' 人），' + value.terms.length + ' 个学期；教室当前学期为「' +
    active.label + '」。作业项目共 ' + afterItems.length + ' 个，启用 ' + afterItems.filter(item => item.active).length + ' 个，停用 ' +
    afterItems.filter(item => !item.active).length + ' 个，移除 ' + beforeItems.filter(item => !afterItemIds.has(item.termId + '/' + item.id)).length +
    ' 个。历史登记记录保留，教室端重新打开作业统计后使用新名单和预设。';
}

module.exports = { SUBJECTS, clone, createId, validateValue, savePayload, readProfile, appendStudents, copyTerm, summary };

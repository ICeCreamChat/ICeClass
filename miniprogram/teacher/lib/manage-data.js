'use strict';

const ROLE_LABELS = {
  principal: '校长', director: '主任', grade_leader: '年级部',
  teacher: '班主任', subject_teacher: '任课老师'
};
const GRADES = ['高一', '高二', '高三'];
const enabled = value => value === true || value === 1;
const length = value => Array.from(value).length;
const permission = (user, key) => Boolean(user && user.permissions && user.permissions[key] === true);

function gradeOf(name) {
  const match = /^高([一二三123])(?=[^0-9]|$)/.exec(String(name || '').normalize('NFKC').replace(/\s/g, ''));
  return match ? '高' + ({ 1: '一', 2: '二', 3: '三' }[match[1]] || match[1]) : '其他';
}

function managesGrade(user, grade) {
  return permission(user, 'manageClasses') && (permission(user, 'schoolAdmin') ||
    user.role === 'director' && GRADES.includes(grade) || user.role === 'grade_leader' && user.grade === grade);
}

function classPayload(name, user) {
  const normalized = String(name || '').trim().replace(/\s+/g, ' ');
  if (length(normalized) < 2 || length(normalized) > 40) throw new Error('班级名称应为 2 至 40 个字符。');
  if (!managesGrade(user, gradeOf(normalized))) throw new Error('只能管理本人负责年级的班级。');
  return { name: normalized };
}

function classesFrom(response) {
  if (!response || !Array.isArray(response.classes) || response.classes.some(item =>
    !item || typeof item.id !== 'string' || typeof item.name !== 'string' || ![0, 1, true, false].includes(item.enabled))) {
    throw new Error('班级列表格式异常，请刷新后重试。');
  }
  return response.classes.map(item => ({ ...item, isEnabled: enabled(item.enabled), gradeLabel: gradeOf(item.name) }));
}

function rolesFrom(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(role => Object.prototype.hasOwnProperty.call(ROLE_LABELS, role)))];
}

function usersFrom(response, actor) {
  if (!response || !Array.isArray(response.teachers) || !Array.isArray(response.assignableRoles) || response.teachers.some(item =>
    !item || typeof item.id !== 'string' || typeof item.username !== 'string' || typeof item.display_name !== 'string')) {
    throw new Error('账号列表格式异常，请刷新后重试。');
  }
  const roles = rolesFrom(response.assignableRoles);
  return response.teachers.map(item => ({
    ...item,
    isEnabled: enabled(item.enabled), roleLabel: ROLE_LABELS[item.role] || item.role,
    editable: permission(actor, 'manageUsers') && item.canManage === true && item.id !== actor.id && roles.includes(item.role),
    scopeLabel: item.role === 'principal' ? '全校' : item.role === 'director' ? '高一、高二、高三' :
      item.role === 'grade_leader' ? (item.grade || '未分配年级') :
        (item.classes || []).map(row => row.name).join('、') || '未分配班级'
  }));
}

function userDraft(existing, roles) {
  return {
    username: existing ? existing.username : '',
    displayName: existing ? existing.display_name : '',
    role: existing ? existing.role : (roles.includes('teacher') ? 'teacher' : roles[0] || ''),
    grade: existing && existing.grade || '',
    headClassIds: existing ? (existing.headClasses || []).map(item => item.id) : [],
    teachingClassIds: existing ? (existing.teachingClasses || []).map(item => item.id) : [],
    enabled: existing ? enabled(existing.enabled) : true,
    password: ''
  };
}

function passwordError(password) {
  if (typeof password !== 'string' || length(password) < 10) return '密码至少需要 10 个字符。';
  if (length(password) > 128) return '密码不能超过 128 个字符。';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return '密码需同时包含字母和数字。';
  return '';
}

function sameIds(a, b) {
  return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
}

function userPayload(draft, { existing = null, roles, classes, actor }) {
  if (!permission(actor, 'manageUsers') || !rolesFrom(roles).includes(draft.role)) throw new Error('没有授予此身份的权限，请刷新账号列表。');
  if (existing && (existing.canManage !== true || existing.id === actor.id)) throw new Error('不能修改本人或没有管理权限的账号。');
  const displayName = String(draft.displayName || '').trim();
  if (length(displayName) < 1 || length(displayName) > 40) throw new Error('显示名应为 1 至 40 个字符。');
  const payload = {};
  if (!existing) {
    const username = String(draft.username || '').trim();
    if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) throw new Error('用户名需为 3 至 64 位字母、数字或 ._@-。');
    const error = passwordError(draft.password);
    if (error) throw new Error(error);
    Object.assign(payload, { username, password: draft.password, displayName, role: draft.role });
  } else {
    if (displayName !== existing.display_name) payload.displayName = displayName;
    if (draft.role !== existing.role) payload.role = draft.role;
    if (draft.enabled !== enabled(existing.enabled)) payload.enabled = Boolean(draft.enabled);
  }
  const roleChanged = !existing || draft.role !== existing.role;
  if (draft.role === 'grade_leader') {
    if (!GRADES.includes(draft.grade)) throw new Error('请为年级部选择负责年级。');
    if (!managesGrade(actor, draft.grade)) throw new Error('不能授权其他年级。');
    if (roleChanged || draft.grade !== existing.grade) payload.grade = draft.grade;
  } else if (['teacher', 'subject_teacher'].includes(draft.role)) {
    const ids = new Set(classes.map(item => item.id));
    const heads = draft.role === 'teacher' ? draft.headClassIds : [];
    const teaching = draft.teachingClassIds;
    if (![heads, teaching].every(list => Array.isArray(list) && list.length <= 200 && list.every(id => typeof id === 'string' && ids.has(id)))) {
      throw new Error('有班级已不在可授权列表内，请刷新后核对。');
    }
    if (!permission(actor, 'schoolAdmin') && !heads.length && !teaching.length) throw new Error('请至少选择一个本人管理范围内的班级。');
    if (roleChanged || !sameIds(heads, (existing.headClasses || []).map(item => item.id))) payload.headClassIds = [...new Set(heads)];
    if (roleChanged || !sameIds(teaching, (existing.teachingClasses || []).map(item => item.id))) payload.teachingClassIds = [...new Set(teaching)];
  }
  return payload;
}

function assignmentChoices(classes, selected) {
  return classes.map(item => ({ id: item.id, name: item.name, isEnabled: enabled(item.enabled), checked: selected.includes(item.id) }));
}

function userBaseline(user) {
  return JSON.stringify([user.id, user.username, user.display_name, user.role, enabled(user.enabled), user.grade || '',
    (user.headClasses || []).map(item => item.id).sort(), (user.teachingClasses || []).map(item => item.id).sort()]);
}

function userSummary(draft, classes) {
  const names = ids => classes.filter(item => ids.includes(item.id)).map(item => item.name).join('、') || '无';
  const lines = [`${draft.displayName.trim()}（${draft.username.trim()}）`, `身份：${ROLE_LABELS[draft.role] || draft.role}`];
  if (draft.role === 'grade_leader') lines.push(`负责年级：${draft.grade}`);
  if (draft.role === 'teacher') lines.push(`带班班级：${names(draft.headClassIds)}`);
  if (['teacher', 'subject_teacher'].includes(draft.role)) lines.push(`任课班级：${names(draft.teachingClassIds)}`);
  lines.push(`状态：${draft.enabled ? '启用' : '停用'}`);
  return lines.join('\n');
}

const volumeValue = value => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
function volumePayload(value) {
  const text = String(value).trim();
  if (!/^\d{1,3}$/.test(text) || !volumeValue(Number(text))) throw new Error('播放音量需为 0 至 100 的整数。');
  return { action: 'set_volume', volume: Number(text) };
}

function devicesFrom(response) {
  if (!response || !Array.isArray(response.devices) || response.devices.some(item => !item || typeof item.id !== 'string' || typeof item.class_id !== 'string')) {
    throw new Error('教室设备列表格式异常，请刷新后重试。');
  }
  return response.devices.map(item => {
    const hasVolume = Array.isArray(item.capabilities) && item.capabilities.includes('volume');
    const actual = volumeValue(item.actual_volume) ? item.actual_volume : null;
    const desired = volumeValue(item.desired_volume) ? item.desired_volume : null;
    const acknowledged = Boolean(item.desired_command && item.command_id === item.desired_command);
    const state = !enabled(item.enabled) ? '设备已停用' : !hasVolume ? '未上报音量控制能力' :
      acknowledged && item.command_error ? item.command_error : desired === null ? '尚未设置目标音量' :
        !item.online ? '待上线应用' : !acknowledged ? '等待教室确认' : actual === null ? '无法读取当前音量' :
          actual !== desired ? '设备当前音量已变化' : '已应用';
    return {
      ...item, isEnabled: enabled(item.enabled), connectionLabel: !enabled(item.enabled) ? '已停用' : item.online ? '在线' : '离线',
      actualLabel: actual === null ? '未上报' : `${actual}%`, desiredLabel: desired === null ? '尚未设置' : `${desired}%`,
      volumeState: state, hasVolume,
      hasReading: Array.isArray(item.capabilities) && item.capabilities.includes('reading')
    };
  });
}

function controlResult(response, className, payload) {
  if (!response || !Number.isInteger(response.delivered) || response.delivered < 0 || typeof response.commandId !== 'string' ||
    payload.action === 'set_volume' && response.saved !== true) {
    const error = new Error('服务器未完整确认操作结果，请先刷新设备状态核对，避免重复发送。');
    error.ambiguous = true;
    throw error;
  }
  if (payload.action === 'set_volume') return `已为“${className}”保存 ${payload.volume}% 播放音量，广播至 ${response.delivered} 个在线连接。${response.delivered ? '是否应用请刷新查看设备回报。' : '设备上线后将应用；当前尚未送达。'}`;
  return response.delivered ? `“${className}”的早读指令已广播至 ${response.delivered} 个在线连接，请在教室核对是否打开。` :
    `“${className}”的教室端离线，早读指令未送达，也不会在上线后补发。`;
}

// app.py only exposes PATCH for a class update. The existing confirmation
// protocol invokes that exact handler and preserves its authorization and
// baseline check while using POST, which is in the shared mini-program contract.
// This consumes one Banban operation; callers must disclose that before consent.
async function updateClass(request, target, payload, stillCurrent) {
  const operation = await request('/api/banban/operations', {
    method: 'POST', data: { kind: 'platform', args: { operation: 'class.update', classId: target.id, payload } }
  });
  if (!stillCurrent()) {
    const error = new Error('页面或账号已变化，请刷新班级后核对。');
    error.code = 'session_changed';
    throw error;
  }
  if (!operation || operation.kind !== 'platform' || operation.action !== 'class.update' || operation.target !== target.name ||
    operation.status !== 'awaiting_confirmation' || typeof operation.id !== 'string' || !operation.parameters ||
    Object.keys(operation.parameters).length !== Object.keys(payload).length ||
    Object.keys(payload).some(key => operation.parameters[key] !== payload[key])) {
    throw new Error('班级或待确认内容已变化，未执行修改。请刷新列表后核对。');
  }
  const done = await request(`/api/banban/operations/${encodeURIComponent(operation.id)}/confirm`, { method: 'POST', data: { confirmed: true } });
  if (!done || done.id !== operation.id || done.status !== 'succeeded') {
    const error = new Error(done && done.result && done.result.detail || '班级修改结果未确认，请刷新列表核对。');
    error.ambiguous = !done || !['failed', 'expired', 'cancelled'].includes(done.status);
    throw error;
  }
  return done;
}

function current(page, generation) { return page._visible === true && page._generation === generation; }
function invalidate(page) { page._generation = (page._generation || 0) + 1; return page._generation; }

module.exports = {
  ROLE_LABELS, GRADES, enabled, permission, gradeOf, managesGrade, classPayload, classesFrom,
  rolesFrom, usersFrom, userDraft, userPayload, userSummary, userBaseline, passwordError, assignmentChoices,
  volumePayload, devicesFrom, controlResult, updateClass, current, invalidate
};

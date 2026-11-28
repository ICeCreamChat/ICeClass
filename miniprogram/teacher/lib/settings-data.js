'use strict';

const copy = value => JSON.parse(JSON.stringify(value));
const enabled = value => value === true || value === 1;
const text = value => typeof value === 'string' ? value : '';
const count = value => Number.isInteger(value) && value >= 0;
function manager(user) {
  return Boolean(user && user.permissions && user.permissions.manageUsers === true &&
    ['superadmin', 'principal', 'director', 'grade_leader'].includes(user.role));
}
function invalidate(page) { page._generation = (page._generation || 0) + 1; }
function begin(page, api) {
  invalidate(page);
  return { generation: page._generation, owner: api.getUser() && api.getUser().id };
}
function current(page, token, api, allowExpired = false) {
  if (!token || !page._visible || page._generation !== token.generation) return false;
  const user = api.getUser();
  return user ? user.id === token.owner : allowExpired;
}
function conflict(message) { return Object.assign(new Error(message), { status: 409, code: 'settings_conflict' }); }
function sessionChanged() { return Object.assign(new Error('页面或账号已变化，请重新读取。'), { code: 'session_changed' }); }
function dirty(ui, value) { if (ui.setDirty) ui.setDirty(Boolean(value)); }

function devicesFrom(response) {
  if (!response || !Array.isArray(response.devices) || response.devices.some(row => !row ||
    typeof row.id !== 'string' || typeof row.class_id !== 'string' || typeof row.name !== 'string' ||
    ![true, false, 0, 1].includes(row.enabled))) throw new Error('设备列表格式异常，请重新载入。');
  return response.devices.map(row => ({
    id: row.id, class_id: row.class_id, class_name: text(row.class_name), name: row.name,
    enabled: enabled(row.enabled), online: row.online === true, device_code: text(row.device_code),
    computer_name: text(row.computer_name), os_version: text(row.os_version),
    local_addresses: Array.isArray(row.local_addresses) ? row.local_addresses.filter(item => typeof item === 'string') : [],
    binding_note: text(row.binding_note), verified_at: row.verified_at || null,
    last_seen_at: row.last_seen_at || null, identity_seen_at: row.identity_seen_at || null,
    class_device_count: count(row.class_device_count) ? row.class_device_count : 0,
    connectionLabel: !enabled(row.enabled) ? '已停用' : row.online === true ? '在线' : '离线'
  }));
}
function classesFrom(response) {
  if (!response || !Array.isArray(response.classes) || response.classes.some(row => !row ||
    typeof row.id !== 'string' || typeof row.name !== 'string' || ![true, false, 0, 1].includes(row.enabled))) {
    throw new Error('班级列表格式异常，请重新载入。');
  }
  return response.classes.map(row => ({ id: row.id, name: row.name, enabled: enabled(row.enabled) }));
}
function deviceDraft(row) {
  return { name: row.name, classId: row.class_id, note: row.binding_note, enabled: row.enabled, verified: Boolean(row.verified_at) };
}
function deviceBaseline(row) {
  return JSON.stringify([row.id, row.class_id, row.name, enabled(row.enabled), row.binding_note || '', row.verified_at || null]);
}
function devicePayload(draft, original, classes) {
  const name = text(draft.name).trim(), note = text(draft.note).trim();
  if (Array.from(name).length < 1 || Array.from(name).length > 80 || Array.from(note).length > 120) {
    throw new Error('设备名称应为 1 至 80 个字符，位置备注最多 120 个字符。');
  }
  if (typeof draft.enabled !== 'boolean' || typeof draft.verified !== 'boolean') throw new Error('设备状态不正确。');
  const target = classes.find(row => row.id === draft.classId);
  if (!target || target.id !== original.class_id && !target.enabled) throw new Error('请选择管理范围内启用的目标班级。');
  const payload = {};
  if (name !== original.name) payload.name = name;
  if (note !== original.binding_note) payload.note = note;
  if (draft.classId !== original.class_id) payload.classId = draft.classId;
  if (draft.enabled !== original.enabled) payload.enabled = draft.enabled;
  if (draft.verified !== Boolean(original.verified_at) || payload.classId) payload.verified = draft.verified;
  return payload;
}
function deviceSummary(row, payload, className) {
  const lines = [`教室电脑：${row.class_name} · ${row.name}`, `设备标识：${row.device_code || row.id}`];
  if ('name' in payload) lines.push(`名称改为：${payload.name}`);
  if ('note' in payload) lines.push(`位置备注：${payload.note || '清空'}`);
  if ('classId' in payload) lines.push(`改绑至：${className}。将断开当前连接，并清除该设备的早读启动及浏览器会话，需要重新连接。`);
  if ('enabled' in payload) lines.push(payload.enabled ? '重新启用设备，允许其连接。' : '停用设备，立即断开，无法接收新通知。');
  if ('verified' in payload) lines.push(payload.verified ? '将归属标记为已核实。' : '将归属标记为待核实。');
  lines.push('使用现有班班确认接口，准备操作会消耗本账号 1 次班班次数；未执行也不退回。');
  return lines.join('\n');
}
async function updateDevice(request, original, payload, className, isCurrent) {
  const operation = await request('/api/banban/operations', { method: 'POST', data: {
    kind: 'platform', args: { operation: 'device.update', targetId: original.id, payload }
  } });
  if (!isCurrent()) throw sessionChanged();
  let confirmationStarted = false;
  try {
    // The confirmation view translates classId to targetClassName on the server.
    const expected = { ...payload };
    if ('classId' in expected) { delete expected.classId; expected.targetClassName = className; }
    if (!operation || typeof operation.id !== 'string' || !operation.id || operation.kind !== 'platform' ||
      operation.action !== 'device.update' || operation.target !== original.name || operation.status !== 'awaiting_confirmation' ||
      !operation.parameters || Object.keys(operation.parameters).length !== Object.keys(expected).length ||
      Object.keys(expected).some(key => operation.parameters[key] !== expected[key])) {
      throw conflict('设备或待确认内容已变化，未执行修改。请重新载入后核对。');
    }
    // Compare the editor's snapshot after preparation. The operation then checks
    // its own server baseline again immediately before invoking update_device.
    const latest = devicesFrom(await request('/api/devices', { method: 'GET' }));
    if (!isCurrent()) throw sessionChanged();
    const found = latest.find(row => row.id === original.id);
    if (!found || deviceBaseline(found) !== deviceBaseline(original)) {
      throw conflict('设备绑定已在其他页面修改，草稿已保留。请重新载入后核对。');
    }
    confirmationStarted = true;
    const done = await request(`/api/banban/operations/${encodeURIComponent(operation.id)}/confirm`, { method: 'POST', data: { confirmed: true } });
    if (!done || done.id !== operation.id || done.status !== 'succeeded') {
      const error = new Error(done && done.result && done.result.detail || '修改结果未确认，请重新载入设备核对，避免重复执行。');
      error.ambiguous = !done || done.id !== operation.id || !['failed', 'expired', 'cancelled'].includes(done.status);
      if (done && done.status === 'failed' && /目标或设置已被其他操作修改/.test(error.message)) error.status = 409;
      throw error;
    }
    return done;
  } catch (error) {
    // Release a known pending operation after aborting preflight. Never retry a
    // confirmation, and never send cleanup under a different/expired session.
    if (!confirmationStarted && isCurrent() && operation && typeof operation.id === 'string' && operation.id &&
      operation.kind === 'platform' && operation.action === 'device.update' && operation.status === 'awaiting_confirmation') {
      try { await request(`/api/banban/operations/${encodeURIComponent(operation.id)}/cancel`, { method: 'POST', data: {} }); }
      catch (_) { /* The pending operation expires server-side; preserve the original failure. */ }
    }
    throw error;
  }
}

module.exports = { copy, manager, invalidate, begin, current, dirty,
  devicesFrom, classesFrom, deviceDraft, deviceBaseline, devicePayload, deviceSummary, updateDevice };

'use strict';

// Explicit public projections: connection responses must never bring credentials
// into a page's saved snapshot. All authorization is rechecked by the server.
const copy = value => JSON.parse(JSON.stringify(value));
const enabled = value => value === true || value === 1;
const text = value => typeof value === 'string' ? value : '';
const count = value => Number.isInteger(value) && value >= 0;
const validLimit = value => value === null || count(value) && value <= 1000000;
const kinds = ['device', 'account'];
const keyOf = row => `${row.kind}:${row.id}`;
const limitLabel = value => value === null ? '不限次数' : value === 0 ? '暂停使用' : `每月 ${value} 次`;
function manager(user) {
  return Boolean(user && user.permissions && user.permissions.manageUsers === true &&
    ['superadmin', 'principal', 'director', 'grade_leader'].includes(user.role));
}
function quotaAdmin(user) { return Boolean(user && user.role === 'superadmin' && !user.classroom); }
function schoolAdmin(user, allowed) { return Boolean(user && allowed === true && ['superadmin', 'principal'].includes(user.role)); }
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

function publicConfig(value) {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.configured !== 'boolean' ||
    typeof value.baseUrl !== 'string' || typeof value.model !== 'string') throw new Error('连接设置格式异常，请重新载入。');
  return { enabled: value.enabled, configured: value.configured, baseUrl: value.baseUrl, model: value.model };
}
function accountConnection(value) {
  if (!value || !['school', 'personal'].includes(value.source) || typeof value.enabled !== 'boolean' ||
    typeof value.configured !== 'boolean' || !value.school || typeof value.school.enabled !== 'boolean' ||
    typeof value.school.configured !== 'boolean' || typeof value.canManageSchool !== 'boolean') throw new Error('账号连接格式异常，请重新载入。');
  return { source: value.source, enabled: value.enabled, configured: value.configured, personal: publicConfig(value.personal),
    school: { enabled: value.school.enabled, configured: value.school.configured }, canManageSchool: value.canManageSchool };
}
function connectionDraft(value, workspace) {
  const cfg = workspace === 'school' ? value : value.personal;
  return { source: workspace === 'school' ? 'school' : value.source, enabled: cfg.enabled,
    baseUrl: cfg.baseUrl, model: cfg.model, apiKey: '', clearKey: false };
}
function connectionPayload(draft, workspace, original) {
  if (workspace !== 'school' && !['school', 'personal'].includes(draft.source)) throw new Error('请选择学校连接或自己的连接。');
  if (workspace !== 'school' && draft.source === 'school') return { source: 'school' };
  const baseUrl = text(draft.baseUrl).trim(), model = text(draft.model).trim(), apiKey = text(draft.apiKey);
  if (typeof draft.enabled !== 'boolean' || typeof draft.clearKey !== 'boolean') throw new Error('请选择连接状态。');
  if (baseUrl && (baseUrl.length > 1000 || !/^https:\/\/[^/?#@\s\\]+(?:\/[^?#\s\\]*)?$/.test(baseUrl))) {
    throw new Error('请使用公网 HTTPS Base URL，不包含账号、密钥、查询参数或片段。');
  }
  if (model && !/^[A-Za-z0-9][A-Za-z0-9_./:@+\-]{0,199}$/.test(model)) throw new Error('模型名称格式不正确，请填写服务商提供的模型 ID。');
  if (apiKey && !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) throw new Error('API Key 格式不正确，请检查是否完整复制。');
  if (draft.clearKey && apiKey) throw new Error('请分别选择更换密钥或清除密钥。');
  if (draft.enabled && (!baseUrl || !model)) throw new Error('请填写服务地址和模型名称。');
  const previous = workspace === 'school' ? original : original.personal;
  if (workspace !== 'school' && draft.enabled && (draft.clearKey || !apiKey && !previous.configured)) throw new Error('请填写您自己的 API Key，再保存并测试。');
  return { ...(workspace === 'school' ? {} : { source: 'personal' }), enabled: draft.enabled, baseUrl, model,
    ...(apiKey ? { apiKey } : {}), ...(draft.clearKey ? { clearKey: true } : {}) };
}
function safeError(error, secrets = []) {
  let message = error && error.message || '暂时无法完成操作，请稍后重试。';
  for (const secret of secrets) if (secret) message = message.split(secret).join('[已隐藏密钥]');
  message = message.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [已隐藏密钥]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[服务地址已隐藏]');
  return Object.assign(new Error(message), { status: error && error.status, code: error && error.code, ambiguous: Boolean(error && error.ambiguous) });
}

function usageFrom(value) {
  if (!value || !kinds.includes(value.kind) || typeof value.month !== 'string' || !count(value.used) ||
    !validLimit(value.limit) || !validLimit(value.remaining) || !count(value.resetsAt) || !['default', 'custom'].includes(value.source)) {
    throw new Error('次数用量格式异常，请重新载入。');
  }
  return { kind: value.kind, month: value.month, used: value.used, limit: value.limit, remaining: value.remaining,
    resetsAt: value.resetsAt, source: value.source, limitLabel: limitLabel(value.limit), remainingLabel: value.remaining === null ? '不限次数' : `${value.remaining} 次` };
}
function quotasFrom(value) {
  if (!value || !count(value.revision) || !validLimit(value.deviceLimit) || !validLimit(value.accountLimit) ||
    !Array.isArray(value.overrides) || !Array.isArray(value.targets) || typeof value.month !== 'string' || !count(value.resetsAt)) {
    throw new Error('次数设置格式异常，请重新载入。');
  }
  const targets = value.targets.map(row => {
    if (!row || !kinds.includes(row.kind) || typeof row.id !== 'string' || typeof row.name !== 'string' ||
      typeof row.detail !== 'string' || !count(row.used) || !validLimit(row.limit) || ![0, 1, true, false].includes(row.enabled) ||
      !['default', 'custom'].includes(row.source)) throw new Error('次数对象格式异常，请重新载入。');
    return { kind: row.kind, id: row.id, key: keyOf(row), name: row.name, detail: row.detail,
      enabled: enabled(row.enabled), used: row.used, limit: row.limit, source: row.source };
  });
  const keys = new Set(targets.map(keyOf)), seen = new Set();
  if (keys.size !== targets.length) throw new Error('次数对象重复，请重新载入。');
  const overrides = value.overrides.map(row => {
    if (!row || !kinds.includes(row.kind) || typeof row.id !== 'string' || !keys.has(keyOf(row)) ||
      seen.has(keyOf(row)) || !validLimit(row.limit)) throw new Error('单独次数设置格式异常，请重新载入。');
    seen.add(keyOf(row)); return { kind: row.kind, id: row.id, limit: row.limit };
  });
  return { revision: value.revision, deviceLimit: value.deviceLimit, accountLimit: value.accountLimit,
    month: value.month, resetsAt: value.resetsAt, overrides, targets };
}
const modeOf = value => value === null ? 'unlimited' : value === 0 ? 'paused' : 'limit';
const modeLabels = ['设置上限', '不限次数', '暂停使用'];
const modes = ['limit', 'unlimited', 'paused'];
const targetModes = ['inherit', ...modes];
const targetModeLabels = ['沿用默认', ...modeLabels];
function quotaDraft(value) {
  return { revision: value.revision, deviceMode: modeOf(value.deviceLimit), deviceValue: value.deviceLimit === null ? '' : String(value.deviceLimit),
    accountMode: modeOf(value.accountLimit), accountValue: value.accountLimit === null ? '' : String(value.accountLimit), overrides: copy(value.overrides) };
}
function parseLimit(mode, value) {
  if (mode === 'unlimited') return null;
  if (mode === 'paused') return 0;
  if (mode !== 'limit' || !/^\d{1,7}$/.test(String(value)) || !validLimit(Number(value))) throw new Error('月度上限请填写 0-1000000 的整数。');
  return Number(value);
}
function quotaPayload(draft) {
  if (!draft || !count(draft.revision) || !Array.isArray(draft.overrides)) throw new Error('次数版本不正确，请重新载入。');
  const seen = new Set();
  const overrides = draft.overrides.map(row => {
    if (!row || !kinds.includes(row.kind) || typeof row.id !== 'string' || !validLimit(row.limit) || seen.has(keyOf(row))) throw new Error('单独次数设置不正确。');
    seen.add(keyOf(row)); return { kind: row.kind, id: row.id, limit: row.limit };
  });
  return { revision: draft.revision, deviceLimit: parseLimit(draft.deviceMode, draft.deviceValue),
    accountLimit: parseLimit(draft.accountMode, draft.accountValue), overrides };
}
function setOverride(draft, target, mode, value) {
  if (!targetModes.includes(mode)) throw new Error('请选择次数规则。');
  const next = copy(draft);
  next.overrides = next.overrides.filter(row => keyOf(row) !== keyOf(target));
  if (mode !== 'inherit') next.overrides.push({ kind: target.kind, id: target.id, limit: parseLimit(mode, value) });
  return next;
}
function quotaRows(config, draft, kind, query = '') {
  const search = query.trim().toLowerCase();
  return config.targets.filter(row => row.kind === kind && `${row.name} ${row.detail}`.toLowerCase().includes(search)).map(row => {
    const override = draft.overrides.find(item => keyOf(item) === row.key);
    const defaultMode = draft[`${kind}Mode`], defaultValue = draft[`${kind}Value`];
    let label;
    try { label = limitLabel(override ? override.limit : parseLimit(defaultMode, defaultValue)); }
    catch (_) { label = '默认上限待填写'; }
    return { ...row, ruleLabel: `${override ? '单独设置' : '沿用默认'} · ${label}` };
  });
}

module.exports = { copy, manager, quotaAdmin, schoolAdmin, invalidate, begin, current, dirty, conflict, sessionChanged,
  devicesFrom, classesFrom, deviceDraft, deviceBaseline, devicePayload, deviceSummary, updateDevice,
  publicConfig, accountConnection, connectionDraft, connectionPayload, safeError,
  usageFrom, quotasFrom, quotaDraft, quotaPayload, quotaRows, setOverride, keyOf, modeOf, modes, modeLabels, targetModes, targetModeLabels, limitLabel };

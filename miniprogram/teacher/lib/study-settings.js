'use strict';

// These defaults and bounds mirror server/self_study.py, including old saved settings.
const DEFAULTS = {
  enabled: false, authorized: false, aiEnabled: false, photoEnabled: true,
  dailyCalls: 4, dailyTokens: 2400, sensitivity: 'balanced', voiceTriggerMs: 600,
  observationSeconds: 10, reminderWaitSeconds: 90, confirmationsAfterReminder: 1
};
const SENSITIVITIES = [
  { value: 'low', label: '较低' }, { value: 'balanced', label: '标准' }, { value: 'high', label: '较高' }
];
const NUMBERS = {
  dailyCalls: [0, 4, '每日 AI 复核次数'], dailyTokens: [1500, 2400, '每日 token 上限'],
  voiceTriggerMs: [300, 3000, '进入观察前持续毫秒'], observationSeconds: [10, 30, 'AI 复核前积累秒数'],
  reminderWaitSeconds: [90, 300, '提醒后等待秒数'], confirmationsAfterReminder: [1, 3, '提醒后再确认次数']
};
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function configFrom(raw) {
  if (!object(raw)) throw Error('晚自习设置格式异常，请重新载入。');
  const config = {};
  Object.keys(DEFAULTS).forEach(key => { config[key] = raw[key] === undefined ? DEFAULTS[key] : raw[key]; });
  for (const key of ['enabled', 'authorized', 'aiEnabled', 'photoEnabled']) {
    if (typeof config[key] !== 'boolean') throw Error('请选择有效的启用选项。');
  }
  Object.keys(NUMBERS).forEach(key => {
    const [min, max, label] = NUMBERS[key];
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw Error(`${label}需为 ${min}-${max} 的整数。`);
  });
  if (!SENSITIVITIES.some(item => item.value === config.sensitivity)) throw Error('请选择有效的声音灵敏度。');
  if (config.enabled && !config.authorized) throw Error('启用前请确认学校已完成告知与授权。');
  return config;
}

function profileFrom(response, classId) {
  if (!object(response) || response.classId !== classId || !Number.isInteger(response.revision) ||
      response.revision < 0 || response.revision > 2147483647 || !Number.isFinite(response.serverTime) || !Array.isArray(response.schedule)) {
    throw Error('晚自习配置或版本格式异常，请重新载入。');
  }
  if (response.schedule.some(item => !object(item) || typeof item.key !== 'string' || typeof item.title !== 'string' ||
      !Number.isFinite(item.startAt) || !Number.isFinite(item.endAt) || item.startAt >= item.endAt)) throw Error('晚自习安排格式异常，请重新载入。');
  return { ...clone(response), config: configFrom(response.config) };
}

function draftFrom(config) {
  const draft = configFrom(config);
  Object.keys(NUMBERS).filter(key => key !== 'voiceTriggerMs').forEach(key => { draft[key] = String(draft[key]); });
  draft.voiceTriggerSeconds = String(draft.voiceTriggerMs / 1000);
  delete draft.voiceTriggerMs;
  return draft;
}

function draftConfig(draft) {
  if (!object(draft)) throw Error('晚自习草稿无效，请重新载入。');
  const config = { ...draft };
  Object.keys(NUMBERS).filter(key => key !== 'voiceTriggerMs').forEach(key => {
    const value = String(draft[key] == null ? '' : draft[key]).trim();
    if (!/^\d+$/.test(value)) throw Error(`${NUMBERS[key][2]}需填写整数，不能留空。`);
    config[key] = Number(value);
  });
  const seconds = String(draft.voiceTriggerSeconds == null ? '' : draft.voiceTriggerSeconds).trim();
  if (!/^(?:\d+(?:\.\d{1,3})?|\.\d{1,3})$/.test(seconds)) throw Error('进入观察前持续需填写 0.3-3 秒，最多三位小数。');
  config.voiceTriggerMs = Math.round(Number(seconds) * 1000);
  return configFrom(config);
}

function signature(config) { return JSON.stringify(configFrom(config)); }
function dirty(draft, baseline) {
  try { return signature(draftConfig(draft)) !== signature(baseline); } catch (_) { return true; }
}
function payload(profile, draft) {
  if (!profile || !Number.isInteger(profile.revision) || profile.revision < 0 || profile.revision > 2147483647) throw Error('设置版本无效，请重新载入。');
  return { revision: profile.revision, config: draftConfig(draft) };
}

function budgetNote(draft) {
  const calls = Number(draft.dailyCalls), confirmations = Number(draft.confirmationsAfterReminder);
  if (draft.dailyCalls === '' || draft.confirmationsAfterReminder === '' || !Number.isInteger(calls) || !Number.isInteger(confirmations)) return '';
  if (calls < 1 + confirmations) return `完整流程至少需要 ${1 + confirmations} 次 AI 复核；当前每日次数可能不足以完成提醒后的通知。`;
  return 'token 余额不足以预占一次复核时会暂停；保存设置不会重置今日已用额度。';
}

function runtime(profile, now = profile.serverTime) {
  const state = profile.status;
  const fresh = state && Number.isFinite(state.updated_at) && now >= state.updated_at && now - state.updated_at < 90000;
  const key = !profile.config.enabled ? 'disabled' : fresh ? state.state : 'syncing';
  const labels = {
    disabled: '尚未启用', syncing: '等待教室端同步', inactive: '等待晚自习', listening: '正在感知教室声音',
    observing: '正在观察', analyzing: 'AI 复核中', teaching: '学习交流，继续观察', warning: '已提醒安静',
    reported: '已通知班主任核实', budget: 'AI 复核已暂停', ai_paused: 'AI 复核已暂停', error: '需要检查教室端', paused: '本节已暂停'
  };
  const step = { listening: 0, observing: 1, analyzing: 2, teaching: 0, warning: 3, reported: 4 }[key];
  return {
    stateText: labels[key] || `未知状态（${key || '-'}）`,
    runtimeNote: ['budget', 'ai_paused'].includes(key) ? '本地声波继续显示，AI 复核、提醒与上报暂停。' :
      key === 'syncing' ? '设备状态已过时或尚未上报，请刷新核对教室端。' : '',
    deviceDetail: fresh && profile.config.enabled ? state.detail || '' : '',
    flow: ['感知', '观察', 'AI 复核', '提醒', '通知'].map((label, index) => ({ label, active: index === step })),
    nextPeriod: profile.schedule.find(item => item.endAt > now) || null
  };
}

function confirmation(config, name) {
  const sensitivity = SENSITIVITIES.find(item => item.value === config.sensitivity).label;
  return `班级：${name}\n本班监测：${config.enabled ? '启用' : '关闭'}；学校告知授权：${config.authorized ? '已记录' : '未记录'}\n` +
    `AI 复核：${config.aiEnabled ? '启用，仅发送疑似片段短文本' : '关闭'}；通知时附图：${config.photoEnabled ? '启用，照片供人工核实并保留 24 小时' : '关闭'}\n` +
    `灵敏度：${sensitivity}；持续人声 ${config.voiceTriggerMs / 1000} 秒，积累 ${config.observationSeconds} 秒；提醒后等待 ${config.reminderWaitSeconds} 秒，再确认 ${config.confirmationsAfterReminder} 次。\n` +
    `每日最多 ${config.dailyCalls} 次复核、${config.dailyTokens} token。保存后同步至本班设备，结束尚未上报的旧规则序列；今日用量和历史记录保留。`;
}

module.exports = { SENSITIVITIES, configFrom, profileFrom, draftFrom, draftConfig, signature, dirty, payload, budgetNote, runtime, confirmation };

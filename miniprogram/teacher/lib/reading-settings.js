'use strict';

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canEdit = user => Boolean(user && ['principal', 'superadmin'].includes(user.role) && user.permissions && user.permissions.schoolAdmin === true);
const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function minute(value) {
  if (value === '24:00') return 1440;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function configFrom(config) {
  if (!object(config) || typeof config.enabled !== 'boolean' ||
      config.reminderEnabled !== undefined && typeof config.reminderEnabled !== 'boolean') throw Error('早读开关格式异常，请重新载入。');
  if (!Number.isInteger(config.threshold) || config.threshold < 5 || config.threshold > 90) throw Error('声量门槛需为 5-90 的整数。');
  if (!Array.isArray(config.periods) || config.periods.length > 30) throw Error('早读统计时段最多 30 个。');
  const periods = config.periods.map(period => {
    if (!object(period) || !Array.isArray(period.weekdays) || !period.weekdays.length ||
        period.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw Error('每个早读时段至少选择一个有效星期。');
    if (!Number.isInteger(period.start) || !Number.isInteger(period.end) || period.start < 0 || period.start >= period.end || period.end > 1440) throw Error('结束时间必须晚于开始时间；跨天请拆成两个时段。');
    return { weekdays: [...new Set(period.weekdays)].sort((a, b) => a - b), start: period.start, end: period.end };
  });
  if (config.enabled && !periods.length) throw Error('请先添加早读统计时段，再启用统计。');
  // Gameplay parameters are preserved by the real handler, not part of this update body.
  return { enabled: config.enabled, reminderEnabled: config.reminderEnabled === undefined ? true : config.reminderEnabled, threshold: config.threshold, periods };
}

function profileFrom(response) {
  if (!object(response) || !Number.isFinite(response.serverTime) || typeof response.inPeriod !== 'boolean') throw Error('早读规则返回格式异常，请重新载入。');
  return { config: configFrom(response.config), serverTime: response.serverTime, inPeriod: response.inPeriod };
}
function draftFrom(config) {
  const value = configFrom(config);
  return { ...value, threshold: String(value.threshold), periods: value.periods.map((period, index) => ({
    key: `period-${index}`, weekdays: [...period.weekdays], startTime: clock(period.start), endTime: clock(period.end)
  })) };
}
function payload(draft) {
  if (!object(draft) || !Array.isArray(draft.periods)) throw Error('早读规则草稿无效，请重新载入。');
  const threshold = String(draft.threshold == null ? '' : draft.threshold).trim();
  if (!/^\d+$/.test(threshold)) throw Error('声量门槛需填写 5-90 的整数，不能留空。');
  return configFrom({ enabled: draft.enabled, reminderEnabled: draft.reminderEnabled, threshold: Number(threshold),
    periods: draft.periods.map(period => ({ weekdays: period.weekdays, start: minute(period.startTime), end: minute(period.endTime) })) });
}
function signature(config) { return JSON.stringify(configFrom(config)); }
function dirty(draft, baseline) { try { return signature(payload(draft)) !== signature(baseline); } catch (_) { return true; } }
function periodRows(draft) {
  return draft.periods.map(period => ({ ...period,
    weekOptions: WEEKDAYS.map((label, index) => ({ label, value: String(index + 1), checked: period.weekdays.includes(index + 1) })),
    endPickerValue: period.endTime === '24:00' ? '23:59' : period.endTime
  }));
}
function confirmation(config) {
  const periods = config.periods.map(period => `${period.weekdays.map(day => WEEKDAYS[day - 1]).join('、')} ${clock(period.start)}-${clock(period.end)}`).join('\n') || '无统计时段';
  return `影响全校所有班级，将替换早读统计规则。\n统计：${config.enabled ? '启用' : '关闭'}；到点提醒：${config.reminderEnabled ? '启用' : '关闭'}；声量门槛：${config.threshold}\n${periods}\n保存不会打开早读或启动教室采集。`;
}

module.exports = { WEEKDAYS, canEdit, clock, minute, configFrom, profileFrom, draftFrom, payload, signature, dirty, periodRows, confirmation };

'use strict';

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function clock(value) {
  if (!Number.isInteger(value) || value < 0 || value > 1440) return '-';
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

// Rows carry the service's natural lesson keys, never an index into a filtered list.
function lessonRows(config, weekday) {
  if (!object(config) || !Array.isArray(config.slots) || !Array.isArray(config.lessons)) throw Error('课表配置格式异常，请重新载入。');
  const result = [];
  const rotations = config.dutyRotations || {};
  const add = (slot, lesson, kind, cycleWeek) => {
    const week = lesson.week || 'all';
    result.push({
      key: JSON.stringify([slot.id, weekday, kind, kind ? cycleWeek : week]),
      slotId: slot.id, weekday, kind, cycleWeek: cycleWeek || 0, week,
      slotLabel: slot.label, timeLabel: `${clock(slot.start)}-${clock(slot.end)}`,
      weekLabel: kind ? `${kind === 'midday' ? '午间静校' : '晚自习'} · 循环第 ${cycleWeek} 周${rotations[kind].enabled ? '' : '（未启用）'}`
        : { all: '每周', odd: '单周', even: '双周' }[week] || '未知周次',
      subject: lesson.subject || '', teacher: lesson.teacher || '', location: lesson.location || ''
    });
  };
  [...config.slots].sort((a, b) => a.start - b.start).forEach(slot => {
    const owners = ['midday', 'evening'].filter(kind => rotations[kind] && Array.isArray(rotations[kind].slotIds) && rotations[kind].slotIds.includes(slot.id));
    if (!owners.some(kind => rotations[kind].enabled)) {
      const lessons = config.lessons.filter(lesson => lesson.slotId === slot.id && lesson.weekday === weekday);
      if (!lessons.length) add(slot, { week: 'all' }, '');
      else if (lessons.some(lesson => (lesson.week || 'all') === 'all')) lessons.forEach(lesson => add(slot, lesson, ''));
      else ['odd', 'even'].forEach(week => add(slot, lessons.find(lesson => lesson.week === week) || { week }, ''));
    }
    owners.forEach(kind => {
      const duty = rotations[kind];
      if (!duty.enabled && !(duty.lessons || []).length) return;
      for (let cycleWeek = 1; cycleWeek <= duty.cycleWeeks; cycleWeek++) {
        add(slot, (duty.lessons || []).find(lesson => lesson.slotId === slot.id && lesson.weekday === weekday && lesson.cycleWeek === cycleWeek) || {}, kind, cycleWeek);
      }
    });
  });
  return result;
}

function minutes(value) {
  if (value === '24:00') return 1440;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function quietPayload(periods) {
  if (!Array.isArray(periods) || periods.length > 100) throw Error('全校时间表最多支持 100 个时段。');
  return { periods: periods.map(period => {
    if (!object(period)) throw Error('时间表中存在无法识别的时段。');
    const name = typeof period.name === 'string' ? period.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 40) throw Error('每个时段名称应为 1-40 个字符。');
    if (!Array.isArray(period.weekdays) || !period.weekdays.length || period.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw Error(`“${name}”至少选择一个有效星期。`);
    const start = minutes(period.startTime), end = minutes(period.endTime);
    if (start === null || end === null || start >= 1440 || end <= start) throw Error(`“${name}”结束时间必须晚于开始时间；跨天请拆为两个时段。`);
    return { ...clone(period), name, weekdays: [...new Set(period.weekdays)].sort((a, b) => a - b) };
  }) };
}

function quietSignature(periods) {
  if (!Array.isArray(periods)) throw Error('学校禁言时间表格式异常，请重新载入。');
  return JSON.stringify(periods.map(period => ({ id: period.id, name: period.name, weekdays: [...period.weekdays].sort((a, b) => a - b), startTime: period.startTime, endTime: period.endTime })));
}

function quietImpact(periods) {
  const schedule = periods.length ? periods.map(period => `${period.name}：${period.weekdays.map(day => WEEKDAYS[day - 1]).join('、')} ${period.startTime}-${period.endTime}`).join('\n') : '清空全部禁言时段，取消时段内发送通知的额外确认。';
  return `将替换全校禁言时间表，影响所有班级。时段内发送通知需额外确认，不会自动停止已发送的通知。\n\n${schedule}`;
}

module.exports = { WEEKDAYS, clone, clock, lessonRows, quietPayload, quietSignature, quietImpact };

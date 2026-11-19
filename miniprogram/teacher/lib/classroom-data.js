'use strict';

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const PHOTO_TTL = 24 * 3600000;
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

function patchLesson(config, row, field, value) {
  if (!['subject', 'teacher'].includes(field)) throw Error('不支持编辑该课程字段。');
  if (typeof value !== 'string' || !lessonRows(config, row.weekday).some(item => item.key === row.key)) throw Error('课程已变化，请重新选择。');
  const draft = clone(config);
  const lessons = row.kind ? draft.dutyRotations[row.kind].lessons : draft.lessons;
  let lesson = lessons.find(item => item.slotId === row.slotId && item.weekday === row.weekday && (row.kind ? item.cycleWeek === row.cycleWeek : (item.week || 'all') === row.week));
  if (!lesson) {
    lesson = { slotId: row.slotId, weekday: row.weekday, ...(row.kind ? { cycleWeek: row.cycleWeek } : { week: row.week }), subject: '', teacher: '', location: '' };
    lessons.push(lesson);
  }
  lesson[field] = value;
  if (['subject', 'teacher', 'location'].every(key => lesson[key] === undefined || typeof lesson[key] === 'string' && !lesson[key].trim())) {
    lessons.splice(lessons.indexOf(lesson), 1);
  }
  return draft;
}

function configPayload(profile, config) {
  if (!profile || !Number.isInteger(profile.revision) || profile.revision < 0 || profile.revision > 2147483647) throw Error('配置版本无效，请重新载入。');
  if (!object(config) || !Array.isArray(config.lessons)) throw Error('课表配置格式异常，请重新载入。');
  const draft = clone(config);
  const lists = [draft.lessons, ...Object.keys(draft.dutyRotations || {}).map(kind => draft.dutyRotations[kind].lessons || [])];
  lists.forEach(lessons => lessons.forEach(lesson => {
    for (const field of ['subject', 'teacher']) {
      const value = lesson[field] === undefined && field === 'teacher' ? '' : lesson[field];
      const label = field === 'subject' ? '科目' : '教师';
      if (typeof value !== 'string' || value.length > 40 || /[\x00-\x1f]/.test(value) || field === 'subject' && !value.trim()) throw Error(`${label}需填写有效文字，最多 40 字。`);
    }
  }));
  // Do not reconstruct known fields: newer settings and lesson metadata must survive.
  return { revision: profile.revision, config: draft };
}

function studyEvent(event, serverTime) {
  const handled = event.handled_at !== null && event.handled_at !== undefined;
  const needsReview = event.status === 'reported' && !handled;
  const statusText = handled ? event.resolution === 'false_alarm' ? '已确认误报' : event.resolution === 'handled' ? '人工处理完成' : '已人工核验'
    : needsReview ? '待核实' : event.status === 'warning' ? '已提醒' : event.status === 'resolved' ? '已结束' : `未知状态（${event.status || '-'}）`;
  const expired = event.photo_status === 'ready' && (!Number.isFinite(event.photo_at) || !Number.isFinite(serverTime) || serverTime >= event.photo_at + PHOTO_TTL);
  const photoText = expired ? '照片已过期或时效未知' : ({ ready: '附现场照片', pending: '照片待提交', capturing: '照片正在提交', failed: '本次未取得照片', expired: '照片已过期', none: '未附照片' }[event.photo_status] || '无可用照片');
  return { ...event, needsReview, statusText, photoText, canViewPhoto: event.photo_status === 'ready' && !expired };
}

function studyState(state) {
  return { inactive: '未在监测时段', listening: '感知中', observing: '观察中', analyzing: 'AI 复核中', teaching: '学习活动', warning: '轻声提醒中', reported: '已上报待核实', budget: 'AI 额度不足', ai_paused: 'AI 复核已暂停', error: '采集故障', paused: '本节已暂停' }[state] || (state ? `未知状态（${state}）` : '等待设备同步');
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

module.exports = { WEEKDAYS, PHOTO_TTL, clone, clock, lessonRows, patchLesson, configPayload, studyEvent, studyState, quietPayload, quietSignature, quietImpact };

/* Shared, date-only timetable calculations; no browser state or network access. */
((root) => {
  'use strict';
  const dateValue = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? Date.parse(value + 'T12:00:00Z') : NaN;
  const validDate = value => {
    const n = dateValue(value);
    return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value;
  };
  function cycleWeek(duty, on) {
    if (!validDate(on) || !validDate(duty.weekAnchor) || !Number.isInteger(duty.cycleWeeks) || duty.cycleWeeks < 1) return null;
    const weeks = Math.floor((dateValue(on) - dateValue(duty.weekAnchor)) / 604800000);
    return weeks < 0 ? null : weeks % duty.cycleWeeks + 1;
  }
  function forDate(config, on) {
    if (!validDate(on) || !validDate(config.weekAnchor)) return [];
    const date = new Date(dateValue(on)), weekday = date.getUTCDay() || 7;
    const weeks = Math.floor((dateValue(on) - dateValue(config.weekAnchor)) / 604800000);
    const parity = ((weeks % 2) + 2) % 2 === 0 ? 'odd' : 'even';
    const regular = new Map(config.lessons.filter(l => l.weekday === weekday && (l.week === 'all' || l.week === parity)).map(l => [l.slotId, l]));
    for (const [kind, duty] of Object.entries(config.dutyRotations || {})) {
      const week = cycleWeek(duty, on);
      if (!duty.enabled || week === null) continue;
      duty.slotIds.forEach(id => regular.delete(id));
      duty.lessons.filter(l => l.weekday === weekday && l.cycleWeek === week).forEach(l => regular.set(l.slotId, { ...l, dutyKind: kind }));
    }
    const overrides = new Map(config.overrides.filter(o => o.date === on).map(o => [o.slotId, o]));
    return [...config.slots].sort((a, b) => a.start - b.start).flatMap(slot => {
      const override = overrides.get(slot.id), lesson = override || regular.get(slot.id);
      return lesson && !lesson.cancelled ? [{ ...slot, ...lesson, temporary: !!override }] : [];
    });
  }
  function schoolHiddenSlots(config, policy) {
    const slots = [...config.slots].sort((a, b) => a.start - b.start);
    const eveningIds = new Set(config.dutyRotations?.evening?.slotIds || []);
    const middayIds = new Set(config.dutyRotations?.midday?.slotIds || []);
    const evening = slots.filter(s => eveningIds.has(s.id) || s.id.startsWith('evening-study-') || /晚自[习修]/.test(s.label));
    evening.forEach(s => eveningIds.add(s.id));
    return slots.filter(s => policy.hideFirstEvening && s.id === evening[0]?.id ||
      policy.hideDaytimeLessons && s.start < 1080 && !eveningIds.has(s.id) && !middayIds.has(s.id) &&
      (/^period-\d+$/.test(s.id) || /^第\s*[一二三四五六七八九十百0-9]+\s*节/.test(s.label))).map(s => s.id);
  }
  // Presentation only: unassigned study periods must not become courses,
  // quiet intervals or automation/reminder events.
  function ribbonForDate(config, on) {
    const lessons = forDate(config, on);
    if (!lessons.length) return lessons;
    const studyIds = new Set(['midday', 'evening'].flatMap(kind => config.dutyRotations?.[kind]?.slotIds || []));
    const middayIds = new Set(config.dutyRotations?.midday?.slotIds || []);
    const occupied = new Set(lessons.map(l => l.id));
    const cancelled = new Set(config.overrides.filter(o => o.date === on && o.cancelled).map(o => o.slotId));
    const placeholders = config.slots.filter(s => !occupied.has(s.id) && !cancelled.has(s.id) &&
      (studyIds.has(s.id) || /^evening-study-/.test(s.id) || /午间静校|晚自[习修]/.test(s.label)))
      .map(s => ({ ...s, subject: s.label }));
    return [...lessons, ...placeholders].sort((a, b) => a.start - b.start).map(l => ({ ...l,
      ribbonGroup: middayIds.has(l.id) || /午间静校/.test(l.label) ? 'midday'
        : l.id === 'morning-reading' || /晨读|早读/.test(l.label) ? 'morning' : '' }));
  }
  function hiddenDuringLesson(config, on, minute) {
    if (!validDate(on) || !Number.isFinite(minute)) return false;
    if (!config.visibility) return !!config.appearance?.hideDuringLessons &&
      forDate(config, on).some(l => l.start <= minute && minute < l.end);
    const cancelled = new Set(config.overrides.filter(o => o.date === on && o.cancelled).map(o => o.slotId));
    const slots = config.visibility.lessonsOnly && !config.visibility.followSchool ? forDate(config, on) : config.slots;
    return slots.some(s => s.start <= minute && minute < s.end &&
      config.visibility.hiddenSlotIds.includes(s.id) && !cancelled.has(s.id));
  }
  const schedule = { validDate, cycleWeek, forDate, ribbonForDate, schoolHiddenSlots, hiddenDuringLesson };
  if (typeof module !== 'undefined' && module.exports) module.exports = schedule;
  else root.ICeClassIslandSchedule = schedule;
})(typeof window !== 'undefined' ? window : globalThis);

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
  const schedule = { validDate, cycleWeek, forDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = schedule;
  else root.ICeClassIslandSchedule = schedule;
})(typeof window !== 'undefined' ? window : globalThis);

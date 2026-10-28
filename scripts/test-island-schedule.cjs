// Timetable behavior used by the live teacher preview; no DOM or third-party modules.
const assert = require('node:assert/strict');
const { forDate, cycleWeek, validDate } = require('../web_controller/island-schedule.js');
const config = { weekAnchor: '2026-09-07',
  slots: [{ id: 'p1', start: 475, end: 520 }, { id: 'mid', start: 750, end: 810 }, { id: 'e1', start: 1100, end: 1190 }],
  lessons: [{ slotId: 'p1', weekday: 1, week: 'odd', subject: '物理' }, { slotId: 'p1', weekday: 1, week: 'even', subject: '化学' }],
  overrides: [], dutyRotations: {} };
for (const [kind, total, slotId, weekAnchor] of [['midday', 3, 'mid', '2026-09-07'], ['evening', 4, 'e1', '2026-09-14']]) {
  config.dutyRotations[kind] = { enabled: true, cycleWeeks: total, weekAnchor, slotIds: [slotId],
    lessons: Array.from({ length: total }, (_, i) => ({ cycleWeek: i + 1, slotId, weekday: 1, subject: kind, teacher: `${kind}-${i + 1}` })) };
}
for (const [on, teachers] of [['2026-09-07', ['midday-1']], ['2026-09-21', ['midday-3', 'evening-2']],
  ['2026-09-28', ['midday-1', 'evening-3']], ['2026-10-05', ['midday-2', 'evening-4']], ['2026-10-12', ['midday-3', 'evening-1']]]) {
  assert.deepEqual(forDate(config, on).slice(1).map(l => l.teacher), teachers, on);
}
assert.equal(forDate(config, '2026-08-31')[0].subject, '化学');
assert.equal(forDate(config, '2026-08-31').length, 1);
assert.equal(forDate(config, '2026-09-13').length, 0);
config.overrides = [{ date: '2026-09-21', slotId: 'mid', cancelled: true },
  { date: '2026-09-21', slotId: 'e1', subject: '语文', teacher: '代班教师' }];
assert.deepEqual(forDate(config, '2026-09-21').map(l => l.subject), ['物理', '语文']);
assert.equal(forDate(config, '2026-09-21')[1].temporary, true);
assert.equal(forDate(config, '2026-09-28')[1].teacher, 'midday-1');
config.dutyRotations.midday.enabled = false;
assert.equal(forDate(config, '2026-09-28').length, 2);
assert.equal(cycleWeek({ cycleWeeks: 3, weekAnchor: '2026-12-28' }, '2027-01-11'), 3);
assert.equal(cycleWeek({ cycleWeeks: 3, weekAnchor: '2026-12-28' }, '2026-12-27'), null);
assert.equal(cycleWeek({ cycleWeeks: 3, weekAnchor: '2026-12-28' }, '2027-01-18'), 1);
assert.equal(validDate('2026-02-30'), false);
assert.equal(validDate('2028-02-29'), true);
assert.deepEqual(forDate(config, '2026-02-30'), []);
delete config.dutyRotations;
assert.equal(forDate(config, '2026-09-28')[0].subject, '化学');
console.log('PASS teacher-preview rotation, independent anchors, wrap, cancellation, substitution, disabled/old profiles and date boundaries');

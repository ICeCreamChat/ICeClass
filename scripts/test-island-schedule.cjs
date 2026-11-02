// Timetable behavior used by the live teacher preview; no DOM or third-party modules.
const assert = require('node:assert/strict');
const { forDate, cycleWeek, validDate, ribbonForDate } = require('../web_controller/island-schedule.js');
const { schoolHiddenSlots, hiddenDuringLesson } = require('../web_controller/island-schedule.js');
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

const quiet = { weekAnchor: '2026-09-07', slots: [
  { id: 'read', label: '晨读', start: 450, end: 473 },
  { id: 'custom', label: '第 一 节', start: 475, end: 520 },
  { id: 'mid', label: '午间静校', start: 750, end: 815 },
  { id: 'e2', label: '晚自习第二节', start: 1200, end: 1290 },
  { id: 'e1', label: '晚自习第一节', start: 1100, end: 1190 }
], lessons: [{ slotId: 'custom', weekday: 1, week: 'all', subject: '数学' }], overrides: [],
  dutyRotations: { evening: { enabled: false, slotIds: ['e2', 'e1'] } },
  visibility: { followSchool: true, hiddenSlotIds: ['custom', 'e1'] } };
assert.deepEqual(schoolHiddenSlots(quiet, { hideDaytimeLessons: true, hideFirstEvening: true }), ['custom', 'e1']);
assert.deepEqual(schoolHiddenSlots(quiet, { hideDaytimeLessons: false, hideFirstEvening: true }), ['e1']);
for (const [m, hidden] of [[474, false], [475, true], [519.9, true], [520, false]]) {
  assert.equal(hiddenDuringLesson(quiet, '2026-10-26', m), hidden, 'Start/end use the actual timetable boundaries');
}
assert.equal(hiddenDuringLesson(quiet, '2026-10-25', 480), true, 'Selected quiet times do not depend on a filled course for the day');
const noCourses = structuredClone(quiet);
noCourses.lessons = [];
for (const [m, hidden] of [[474, false], [475, true], [519.9, true], [520, false], [1100, true], [1190, false], [1200, false]]) {
  assert.equal(hiddenDuringLesson(noCourses, '2026-11-02', m), hidden, 'School classroom with no course entries still follows quiet times');
}
assert.equal(forDate(noCourses, '2026-11-02').length, 0, 'Quiet slots never invent courses or ordinary reminders');
quiet.overrides = [{ date: '2026-10-26', slotId: 'custom', cancelled: true }];
assert.equal(hiddenDuringLesson(quiet, '2026-10-26', 480), false, 'A cancelled class leaves the island visible');
console.log('PASS school defaults, custom slot names, chronological evening selection, breaks, empty days and cancellations');

const legacy = structuredClone(quiet);
legacy.overrides = [];
legacy.appearance = { hideDuringLessons: true };
legacy.visibility = { followSchool: false, hiddenSlotIds: ['custom', 'e1'], lessonsOnly: true };
assert.equal(hiddenDuringLesson(legacy, '2026-11-02', 480), true, 'Migrated legacy hiding still hides an actual course');
assert.equal(hiddenDuringLesson(legacy, '2026-11-01', 480), false, 'Migrated legacy hiding does not hide an empty day');
assert.equal(hiddenDuringLesson(legacy, '2026-11-02', 1100), false, 'Migrated legacy hiding does not hide an unassigned slot');
legacy.overrides = [{ date: '2026-11-02', slotId: 'custom', cancelled: true }];
assert.equal(hiddenDuringLesson(legacy, '2026-11-02', 480), false, 'Cancellation wins over migrated legacy hiding');
legacy.overrides = [];
legacy.visibility.hiddenSlotIds = [];
assert.equal(hiddenDuringLesson(legacy, '2026-11-02', 480), false, 'An explicit empty selection wins over legacy appearance and migration');
legacy.visibility.followSchool = true;
legacy.visibility.hiddenSlotIds = ['custom'];
assert.equal(hiddenDuringLesson(legacy, '2026-11-01', 480), true, 'Following school rules exits legacy course-only hiding');
legacy.visibility = { followSchool: false, hiddenSlotIds: ['custom', 'e1'] };
assert.equal(hiddenDuringLesson(legacy, '2026-11-01', 480), true, 'Modern explicit selections remain slot based despite legacy appearance');
delete legacy.visibility;
assert.equal(hiddenDuringLesson(legacy, '2026-11-01', 480), false, 'Unmigrated legacy appearance remains course based');
console.log('PASS migrated legacy course hiding, cancellation and explicit modern visibility precedence');

const study = { weekAnchor: '2026-09-07', slots: [
  { id: 'day', label: '第一节', start: 475, end: 520 },
  { id: 'mid', label: '午间静校', start: 750, end: 815 },
  { id: 'eve', label: '晚自习第一节', start: 1100, end: 1190 }
], lessons: [{ slotId: 'day', weekday: 1, week: 'all', subject: '数学' }], overrides: [],
  dutyRotations: { midday: { enabled: false, slotIds: ['mid'] }, evening: { enabled: false, slotIds: ['eve'] } } };
assert.deepEqual(ribbonForDate(study, '2026-10-26').map(l => l.subject), ['数学', '午间静校', '晚自习第一节']);
assert.deepEqual(forDate(study, '2026-10-26').map(l => l.subject), ['数学'], 'Study placeholders never become reminder lessons');
assert.deepEqual(ribbonForDate(study, '2026-10-25'), [], 'An empty day has no invented study periods');
study.lessons.push({ slotId: 'mid', weekday: 1, week: 'all', subject: '物理', teacher: '教师甲' });
assert.deepEqual(ribbonForDate(study, '2026-10-26').map(l => l.subject), ['数学', '物理', '晚自习第一节']);
study.dutyRotations.midday = { enabled: true, cycleWeeks: 2, weekAnchor: '2026-10-26', slotIds: ['mid'], lessons: [
  { slotId: 'mid', weekday: 1, cycleWeek: 1, subject: '化学' },
  { slotId: 'mid', weekday: 1, cycleWeek: 2, subject: '生物' }
] };
assert.equal(ribbonForDate(study, '2026-10-26').find(l => l.id === 'mid').subject, '化学');
assert.equal(ribbonForDate(study, '2026-11-02').find(l => l.id === 'mid').subject, '生物');
study.overrides = [{ date: '2026-10-26', slotId: 'mid', subject: '语文' }];
assert.equal(ribbonForDate(study, '2026-10-26').find(l => l.id === 'mid').subject, '语文');
study.overrides[0].cancelled = true;
assert.equal(ribbonForDate(study, '2026-10-26').some(l => l.id === 'mid'), false, 'Cancellation does not reappear as a placeholder');
study.slots = study.slots.filter(s => s.id !== 'mid');
assert.equal(ribbonForDate(study, '2026-11-02').some(l => l.id === 'mid'), false, 'Missing time slots are not fabricated');
console.log('PASS ribbon study placeholders, configured subjects, cycle weeks, substitutions, cancellation and schedule isolation');

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let now = 0, nextFrame = 0;
const frames = new Map(), visibility = new Map();
const context = {
  window: {}, Intl, Date, performance: { now: () => now },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  ResizeObserver: class { observe() {} },
  document: { hidden: false, createElement: () => ({ getContext: () => ({}) }), addEventListener: (name, fn) => visibility.set(name, fn) },
  requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; },
  cancelAnimationFrame: id => frames.delete(id)
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web_controller/island-ribbon.js'), 'utf8'), context);
const Ribbon = context.window.ICeClassIslandRibbon;
const data = () => ({
  classId: 'class-9', className: '高一（9）班', date: '2026-10-26', minute: 470, epochSeconds: 0, live: false,
  enabled: true, rotationSeconds: 8, appearance: { theme: 'light', width: 560, opacity: 100 },
  reminders: { enabled: false, prepare: true, prepareMinutes: 2 },
  lessons: [{ id: 'one', subject: '物理', start: 480, end: 525 }],
  demoLesson: { subject: '示例课程', start: 480, end: 525 },
  components: [{ id: 'date', title: '日期', text: '2026.10.26 周一' }, { id: 'motto', title: '班级寄语', text: '保持好奇' }]
});
function ribbon() {
  const root = { style: {}, dataset: {}, clientWidth: 560, clientHeight: 48 };
  const stage = { dataset: {}, clientWidth: 1280, clientHeight: 800, querySelectorAll: () => [] };
  const r = new Ribbon(root, stage);
  r.draw = () => {}; // These checks exercise presentation and playback, not DOM layout.
  r.update(data());
  return r;
}
function frame(milliseconds) {
  now += milliseconds;
  const callbacks = [...frames.values()]; frames.clear();
  callbacks.forEach(fn => fn(now));
}

const r = ribbon();
for (const beat of [0, 1, 2, 4, 5, 6]) {
  r.rotationElapsed = beat * 8;
  assert.equal(r.state().key, 'timetable', 'Normal lesson days retain the native three timetable beats');
}
r.rotationElapsed = 24;
assert.equal(r.state().key, 'component:motto');
assert.equal(r.state().text, '保持好奇');
r.data.components = [];
assert.equal(r.state().key, 'timetable', 'No enabled information must not replace the timetable');

r.update({ ...data(), lessons: [] });
r.rotationElapsed = 0;
assert.equal(r.state().key, 'component:date');
r.rotationElapsed = 8;
assert.equal(r.state().key, 'component:motto', 'An empty day still rotates information');
r.data.components = [];
assert.equal(r.state().text, '这一天没有课程');

r.update({ ...data(), minute: 478.25, reminders: { enabled: true, prepare: true, prepareMinutes: 2 } });
assert.equal(r.state().key, 'prepare:message', 'Preparation copy alternates with the countdown every ten seconds');
r.data.minute = 479;
assert.equal(r.state().key, 'prepare:countdown');
assert.match(r.state().text, /60 秒$/);
r.data.minute = 480;
assert.equal(r.state().key, 'timetable', 'The countdown ends when the lesson starts');
r.data.appearance.hideDuringLessons = true;
assert.equal(r.state().key, 'hidden:lesson');
r.data.enabled = false;
assert.equal(r.state().key, 'hidden:disabled');

const demo = ribbon();
demo.data.lessons = [];
demo.setActive(true);
demo.show('prepare');
assert.equal(demo.state().key, 'demo:prepare');
demo.seek(6);
assert.match(demo.state().detail, /示例课程/);
demo.show('start');
assert.equal(demo.state().text, '上课');
demo.show('end');
assert.equal(demo.state().text, '下课');
demo.seek(25.5); frame(600);
assert.equal(demo.scene, 'daily', 'A demo returns to daily rotation when finished');
assert.equal(demo.elapsed, null);
demo.pause();

const playback = ribbon();
playback.setActive(true); frame(500);
assert.equal(playback.rotationElapsed, .5);
playback.pause(); frame(1000);
assert.equal(playback.rotationElapsed, .5, 'Pause freezes the rotation clock');
playback.update({ ...data(), live: true, epochSeconds: 100 });
playback.update({ ...data(), live: true, epochSeconds: 115 });
assert.equal(playback.data.epochSeconds, 100, 'Status polling does not advance a paused live preview');
playback.play(); frame(500);
assert.equal(playback.rotationElapsed, .5);
context.document.hidden = true; visibility.get('visibilitychange')();
assert.equal(playback.playing, false);
context.document.hidden = false; visibility.get('visibilitychange')();
assert.equal(playback.playing, true, 'A playing preview resumes after returning to the tab');
playback.setActive(false);
assert.equal(frames.size, 0, 'Closing preview releases animation frames');
assert.equal(playback.elapsed, null);
assert.equal(playback.scene, 'daily');

console.log('PASS floating preview: native rotation beats, empty days, reminder priority, demo scenes, pause, background resume and cleanup');

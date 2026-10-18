const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const source = readFileSync('web_controller/banban-motion.js', 'utf8');
function setup() {
  let now = 100000, next = 0;
  const timers = new Map(), listeners = new Map(), classes = new Set();
  const root = {dataset: {}, querySelectorAll: () => [], classList: {contains: n => classes.has(n), toggle: (n, v) => v ? classes.add(n) : classes.delete(n)}, style: {setProperty() {}, removeProperty() {}}};
  const document = {hidden: false, addEventListener: (n, f) => listeners.set(n, f), removeEventListener: n => listeners.delete(n)};
  const media = {matches: false, addEventListener() {}, removeEventListener() {}};
  const window = {addEventListener() {}, removeEventListener() {}};
  vm.runInNewContext(source, {window, document, matchMedia: () => media, Date: {now: () => now}, Math,
    setTimeout: (f, ms) => { const id = ++next; timers.set(id, {f, at: now + ms}); return id; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}});
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      const item = [...timers].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!item) break;
      now = item[1].at; timers.delete(item[0]); item[1].f();
    }
    now = target;
  }
  return {reaction: window.ICeClassBanbanReaction, motion: window.ICeClassBanbanMotion(root), root, advance, timers, listeners, document, media};
}
const snapshot = (overrides = {}) => ({scope: {classCount: 2}, reading: {activeSeconds: 100, effectiveSeconds: 60, pendingClasses: 0}, notifications: {total: 3, displayed: 3, failed: 0}, voice: {total: 2, durationMs: 8000}, devices: {total: 2, enabled: 2}, ...overrides});
test('failed/offline or incomplete notifications never get a happy completion', () => {
  const {reaction} = setup();
  for (const n of [{total: 3, displayed: 2, failed: 1}, {total: 3, displayed: 1, failed: 0}]) assert.equal(reaction('核对通知', snapshot({notifications: n})).tone, 'careful');
});
test('a complete display receipt gets a restrained warm reaction', () => assert.equal(setup().reaction('通知送达了吗', snapshot()).tone, 'warm'));
test('pending reading data cannot become a positive performance verdict', () => {
  const value = setup().reaction('比较晨读成绩', snapshot({reading: {activeSeconds: 9999, pendingClasses: 2}}));
  assert.equal(value.tone, 'careful'); assert.match(value.caption, /同步/);
});
test('missing software records do not accuse a class of skipping reading', () => {
  const value = setup().reaction('晨读', snapshot({reading: {activeSeconds: 0, pendingClasses: 0}}));
  assert.equal(value.tone, 'neutral'); assert.match(value.caption, /不代表没有晨读/);
});
test('voice response stays private and neutral regardless of high volume', () => {
  const value = setup().reaction('汇总教室来音', snapshot({voice: {total: 9999}, reading: {pendingClasses: 2}}));
  assert.equal(value.tone, 'neutral'); assert.match(value.caption, /内容保持隐私/);
});
test('empty and unbound scopes never celebrate', () => {
  const {reaction} = setup();
  assert.equal(reaction('通知', snapshot({notifications: {total: 0}})).tone, 'neutral');
  assert.equal(reaction('分析', snapshot({scope: {classCount: 0}})).tone, 'neutral');
  assert.equal(reaction('设备', snapshot({devices: {total: 0, enabled: 0}})).tone, 'neutral');
});
test('disabled devices get attention without claiming they are offline', () => {
  const value = setup().reaction('查看设备', snapshot({devices: {total: 2, enabled: 1}}));
  assert.equal(value.tone, 'careful'); assert.doesNotMatch(value.caption, /离线/);
});
test('reading duration alone is not judged as improvement', () => assert.equal(setup().reaction('晨读进步了没有', snapshot()).tone, 'neutral'));
test('thinking first orients, then raises the hand; slow requests stay waiting', () => {
  const {motion, root, advance} = setup();
  motion.busy(true); assert.equal(root.dataset.bbPose, ''); advance(600); assert.equal(root.dataset.bbPose, 'think');
  advance(7600); assert.equal(root.dataset.bbState, 'waiting');
});
test('cancel and new conversation cannot be overwritten by a late hand timer', () => {
  const {motion, root, advance} = setup();
  motion.busy(true); advance(100); motion.reset(); advance(9000);
  assert.equal(root.dataset.bbPose, ''); assert.equal(root.dataset.bbState, 'idle');
});

test('actual reply chunks replace waiting with answering and clear the raised hand', () => {
  const {motion, root, advance} = setup();
  motion.busy(true); advance(9000); assert.equal(root.dataset.bbState, 'waiting');
  motion.speak(); assert.equal(root.dataset.bbState, 'answering'); assert.equal(root.dataset.bbPose, '');
  motion.speak(); advance(9000); assert.equal(root.dataset.bbState, 'answering');
  motion.busy(true); advance(600); assert.equal(root.dataset.bbState, 'thinking');
  motion.speak(); motion.reply('neutral'); motion.busy(false);
  assert.equal(root.dataset.bbState, 'reply'); advance(5000); assert.equal(root.dataset.bbState, 'idle');
});
test('careful reply survives finally cleanup without returning to busy', () => {
  const {motion, root, advance} = setup();
  motion.busy(true); advance(1000); motion.reply('careful'); motion.busy(false);
  assert.equal(root.dataset.bbState, 'careful'); assert.equal(root.dataset.bbFace, 'thinking'); assert.equal(root.dataset.bbPose, '');
  advance(4300); assert.equal(root.dataset.bbState, 'idle');
});
test('a new question cannot be interrupted by the previous reply transition', () => {
  const {motion, root, advance} = setup();
  motion.reply('neutral'); advance(100); motion.busy(true); advance(600);
  assert.equal(root.dataset.bbPhase, 'settled'); assert.equal(root.dataset.bbPose, 'think');
});
test('dragging during an active request cannot cancel its waiting state', () => {
  const {motion, root, advance} = setup();
  motion.busy(true); advance(1000); motion.drag(12); motion.drag(28); assert.equal(root.dataset.bbState, 'dragging');
  motion.release(); assert.equal(root.dataset.bbState, 'thinking'); advance(8000); assert.equal(root.dataset.bbState, 'waiting');
});
test('turning motion off keeps informative static expressions and cancels blink work', () => {
  const {motion, root, advance} = setup();
  motion.reduce(true); motion.busy(true); advance(9000);
  assert.equal(root.dataset.bbGesture, ''); assert.equal(root.dataset.bbBlink, 'false'); assert.equal(root.dataset.bbFace, 'waiting');
});
test('dispose releases timers and document listeners', () => {
  const {motion, timers, listeners, advance} = setup();
  motion.busy(true); motion.dispose(); advance(30000); assert.equal(timers.size, 0); assert.equal(listeners.size, 0);
});

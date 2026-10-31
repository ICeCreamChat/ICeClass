'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web_controller/auth-mascot.js'), 'utf8');
function element(extra = {}) {
  const listeners = {};
  const classes = new Set();
  return Object.assign({
    dataset: {},
    classList: { add: name => classes.add(name), contains: name => classes.has(name) },
    addEventListener(event, action) { (listeners[event] ||= []).push(action); },
    emit(event) { for (const action of listeners[event] || []) action(); },
    matches(selector) { return selector === 'input[type=password]' && this.type === 'password'; },
  }, extra);
}
const username = element();
const password = element({ type: 'password' });
const bootstrap = element({ type: 'password' });
const toggle = element();
for (const input of [username, password, bootstrap]) {
  Object.defineProperty(input, 'value', { get() { throw new Error('Animation read a credential'); } });
}
const mascot = element({ dataset: { state: 'open' } });
const page = element({ contains: input => [username, password, bootstrap, toggle].includes(input) });
const frames = [];
const canvas = element({ width: 220, height: 240,
  dataset: { sprite: '/assets/banban/login-motion.webp?v=4' },
  getContext: () => ({ clearRect() {}, drawImage(_image, x, y) { frames.push(y / 240 * 8 + x / 220); } }),
});
const document = element({ hidden: false, activeElement: username,
  getElementById: id => ({ authPage: page, authMascot: mascot, authMascotCanvas: canvas,
    loginPassword: password, loginPasswordToggle: toggle })[id],
});
const atlas = element();
const media = element({ matches: false });
const pending = new Map();
let now = 0;
let nextId = 0;
vm.runInNewContext(source, {
  document,
  matchMedia: () => media,
  Image: function () { return atlas; },
  performance: { now: () => now },
  requestAnimationFrame(action) { pending.set(++nextId, action); return nextId; },
  cancelAnimationFrame(id) { pending.delete(id); },
  queueMicrotask: action => action(),
});
atlas.emit('load');
function focus(input) {
  document.activeElement = input;
  page.emit('focusout');
  page.emit('focusin');
}
function tick(ms = 16) {
  now += ms;
  const actions = [...pending.values()];
  pending.clear();
  for (const action of actions) action(now);
}
function finish(ms = 16) {
  for (let i = 0; pending.size && i < 100; i++) tick(ms);
  assert.equal(pending.size, 0, 'Motion must settle without an idle animation loop');
}
const frame = () => frames.at(-1);
assert.equal(mascot.dataset.state, 'open');
assert.equal(frame(), 0);
assert.equal(pending.size, 0);
assert.ok(mascot.classList.contains('is-ready'));
focus(password);
assert.equal(mascot.dataset.state, 'cover');
tick(500);
assert.ok(frame() > 0 && frame() < 50, 'Cover gesture must still be moving after 500 ms');
tick(350);
assert.equal(frame(), 50);
focus(toggle);
assert.equal(mascot.dataset.state, 'cover', 'Focus onto visibility control must keep eyes covered');
password.type = 'text';
toggle.emit('click');
assert.equal(mascot.dataset.state, 'peek');
tick(300);
assert.ok(frame() > 50 && frame() < 79, 'Peeking must retain the slower transition');
tick(200);
assert.equal(frame(), 79);
focus(password);
assert.equal(mascot.dataset.state, 'peek', 'Visible password focus must retain the peeking state');
focus(username);
assert.equal(mascot.dataset.state, 'open');
tick(600);
assert.ok(frame() > 0 && pending.size, 'Lowering hands must not snap to the open pose');
finish();
assert.equal(frame(), 0);
password.type = 'password';
const start = frames.length - 1;
focus(password);
finish(1000 / 60);
const motion = frames.slice(start);
assert.ok(motion.every((value, i) => !i || Math.abs(value - motion[i - 1]) <= 2),
  'At 60 Hz the sequence must advance by at most two cells per draw');
assert.equal(frame(), 50);
focus(username);
finish();
focus(password);
tick(300);
const interrupted = frame();
focus(username);
assert.equal(frame(), interrupted, 'Reversal must start at the visible pose');
tick();
assert.ok(Math.abs(frame() - interrupted) <= 1, 'Reversal must not jump between poses');
finish();
assert.equal(frame(), 0);
focus(bootstrap);
assert.equal(mascot.dataset.state, 'cover', 'Initialization passwords also need the privacy gesture');
finish();
assert.equal(frame(), 50);
focus(null);
assert.equal(mascot.dataset.state, 'open');
finish();
focus(toggle);
for (let i = 0; i < 8; i++) {
  password.type = i % 2 ? 'password' : 'text';
  toggle.emit('click');
  tick(64);
}
assert.equal(mascot.dataset.state, 'cover', 'Rapid toggles must retain the latest requested state');
finish();
assert.equal(frame(), 50);
focus(username);
tick(160);
assert.ok(pending.size);
media.matches = true;
media.emit('change');
assert.equal(frame(), 0, 'Reduced motion must settle immediately');
assert.equal(pending.size, 0);
focus(bootstrap);
assert.equal(frame(), 50, 'Reduced motion must apply to initialization passwords');
assert.equal(pending.size, 0);
focus(username);
media.matches = false;
media.emit('change');
focus(password);
tick(160);
assert.ok(pending.size);
document.hidden = true;
document.emit('visibilitychange');
assert.equal(frame(), 50, 'Hidden tabs must settle rather than animate');
assert.equal(pending.size, 0);
document.hidden = false;
document.emit('visibilitychange');
focus(username);
finish();
assert.equal(mascot.dataset.state, 'open');
assert.equal(frame(), 0);
assert.ok(frames.every(value => Number.isInteger(value) && value >= 0 && value <= 79));
console.log('Login canvas motion checks passed: timing, focus/privacy, reversal, rapid toggles, reduced motion and hidden tabs.');

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
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
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
  dataset: { sprite: '/assets/banban/login-motion.webp?v=6' },
  getContext: () => ({ clearRect() {}, drawImage(_image, x, y) { frames.push(y / 240 * 3 + x / 220); } }),
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
tick(40);
assert.equal(frame(), 0, 'Keep the current drawing briefly before the first key pose');
focus(username);
assert.equal(pending.size, 0, 'A cancelled gesture that has not moved must stop immediately');
focus(password);
tick(80);
assert.equal(frame(), 1, 'Lift the palms to the cheeks first');
tick(150);
assert.equal(frame(), 2, 'Close the eyes before the palms cover them');
tick(150);
assert.equal(frame(), 3);
assert.equal(pending.size, 0);
focus(toggle);
assert.equal(mascot.dataset.state, 'cover', 'Focus onto visibility control must keep eyes covered');
password.type = 'text';
toggle.emit('click');
assert.equal(mascot.dataset.state, 'peek');
finish();
assert.equal(frame(), 4);
focus(password);
assert.equal(mascot.dataset.state, 'peek', 'Visible password focus must retain the peeking state');
focus(username);
assert.equal(mascot.dataset.state, 'open');
tick(80);
assert.equal(frame(), 5, 'Leave peeking by lowering the hands, without covering the eyes again');
tick(120);
assert.equal(frame(), 0);
password.type = 'password';
const start = frames.length - 1;
focus(password);
finish(1000 / 60);
const motion = frames.slice(start);
assert.deepEqual(motion, [0, 1, 2, 3], 'Only the six authored poses may be played; do not synthesize intermediate drawings');
assert.equal(frame(), 3);
focus(username);
finish();
focus(password);
tick(230);
const interrupted = frame();
assert.equal(interrupted, 2);
focus(username);
assert.equal(frame(), interrupted, 'Reversal must start at the visible pose');
tick(80);
assert.equal(frame(), 1, 'Reverse through the adjacent preparation pose');
finish();
assert.equal(frame(), 0);
focus(bootstrap);
assert.equal(mascot.dataset.state, 'cover', 'Initialization passwords also need the privacy gesture');
finish();
assert.equal(frame(), 3);
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
assert.equal(frame(), 3);
focus(username);
tick(160);
assert.ok(pending.size);
media.matches = true;
media.emit('change');
assert.equal(frame(), 0, 'Reduced motion must settle immediately');
assert.equal(pending.size, 0);
focus(bootstrap);
assert.equal(frame(), 3, 'Reduced motion must apply to initialization passwords');
assert.equal(pending.size, 0);
focus(username);
media.matches = false;
media.emit('change');
focus(password);
tick(160);
assert.ok(pending.size);
document.hidden = true;
document.emit('visibilitychange');
assert.equal(frame(), 3, 'Hidden tabs must settle rather than animate');
assert.equal(pending.size, 0);
document.hidden = false;
document.emit('visibilitychange');
focus(username);
finish();
assert.equal(mascot.dataset.state, 'open');
assert.equal(frame(), 0);
assert.ok(frames.every(value => Number.isInteger(value) && value >= 0 && value <= 5));
focus(password);
tick(80);
assert.equal(frame(), 1);
page.classList.add('hidden');
tick();
assert.equal(frame(), 3, 'Hiding the login page mid-gesture must settle at its requested pose');
assert.equal(pending.size, 0, 'A hidden login page must stop requesting animation frames');
page.classList.remove('hidden');
focus(username);
finish();
focus(password);
tick(1000);
assert.equal(frame(), 3, 'A busy browser must settle at the current requested pose');
assert.equal(pending.size, 0);
console.log('Login six-pose checks passed: ordered acting, direct peek exit, interruption, privacy, rapid toggles, reduced motion, hidden tabs and busy frames.');

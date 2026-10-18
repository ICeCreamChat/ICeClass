const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..', 'web_controller', 'reading');

for (const mode of ['classic', 'rocket']) {
  test(`${mode}: statistics polling leaves unsaved target and threshold drafts intact`, () => {
    const html = fs.readFileSync(path.join(root, 'assets', 'v2.2.4', mode + '.txt'), 'utf8');
    const monitor = html.match(/window\.ReadingMonitor = \{ getState\(\) \{[\s\S]*?\n  \} \};/);
    assert.ok(monitor, 'the activity exposes its real statistics adapter');
    const elements = Object.fromEntries(['target-num-display', 'vol-line', 'set-threshold-val', 'set-target-val']
      .map(id => [id, { textContent: '', style: {} }]));
    const context = vm.createContext({
      window: {}, document: { getElementById: id => elements[id] },
      config: { targetCount: 4, threshold: 30 },
      pulledCount: 1, readingLastCount: 1, readingRun: 'test-run',
      isMicrophoneActive: true, isManuallyPaused: false, isGameFinished: false,
      getVolume: () => 45, phase: 'running', settingsOpen: true, smoothVolume: 45
    });
    vm.runInContext(monitor[0], context);
    for (const target of [5, 6, 180, 1, 42]) {
      elements['set-target-val'].textContent = String(target);
      elements['set-threshold-val'].textContent = '48';
      for (let poll = 0; poll < 40; poll++) context.window.ReadingMonitor.getState();
      assert.equal(elements['set-target-val'].textContent, String(target));
      assert.equal(elements['set-threshold-val'].textContent, '48');
      assert.equal(elements['target-num-display'].textContent, 4, 'live target remains committed until save');
    }
    context.config.targetCount = 42;
    context.config.threshold = 48;
    const state = context.window.ReadingMonitor.getState();
    assert.equal(elements['target-num-display'].textContent, 42);
    assert.equal(elements['vol-line'].style.left, '48%');
    assert.equal(state.mode, mode);
    assert.equal(state.volume, 45);
  });
}

const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const pinScript = [...index.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('window.createReadingPanelPins ='));
assert.ok(pinScript);

function pinHarness(values = {}, storageUnavailable = false) {
  const storage = new Map(Object.entries(values));
  const context = vm.createContext({
    window: {}, localStorage: {
      getItem(key) { if (storageUnavailable) throw new Error('unavailable'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageUnavailable) throw new Error('unavailable'); storage.set(key, value); }
    }
  });
  vm.runInContext(pinScript, context);
  return { storage, create: context.window.createReadingPanelPins };
}

const modes = ['classic', 'carving', 'particle', 'rocket'];
test('all four modes stay pinned on first use, after v1 defaults, and if storage is unavailable', () => {
  for (const harness of [pinHarness(), pinHarness({ reading_panel_pins_v1: JSON.stringify(Object.fromEntries(modes.map(mode => [mode, false]))) }),
    pinHarness({ reading_panel_pins_v2: 'invalid JSON' }), pinHarness({}, true)]) {
    const pins = harness.create({ onToggle() {}, onHide() {} });
    for (const mode of modes) assert.equal(pins.isPinned(mode), true);
  }
});

test('explicit hide and unpin choices survive reopening without changing other modes', () => {
  const harness = pinHarness();
  const hidden = [], toggled = [];
  const pins = harness.create({ onHide: mode => hidden.push(mode), onToggle: (mode, pinned) => toggled.push([mode, pinned]) });
  const elements = [];
  const doc = { getElementById: () => true, createElement(tag) {
    const element = { tag, attributes: {}, children: [], handlers: {}, dataset: {}, classList: { add() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { this.handlers[name] = callback; },
      append(...children) { this.children.push(...children); }, blur() {}, remove() {} };
    elements.push(element); return element;
  } };
  const heading = { ownerDocument: doc, append() {} };
  pins.attach('rocket', heading);
  const pinButton = elements.find(element => element.dataset.pinMode === 'rocket');
  assert.equal(pinButton.attributes['aria-pressed'], 'true');
  pinButton.handlers.click();
  assert.equal(pinButton.attributes['aria-pressed'], 'false');
  assert.deepEqual(toggled, [['rocket', false]]);
  pins.hide('classic');
  assert.deepEqual(hidden, ['classic']);
  const reopened = harness.create({ onToggle() {}, onHide() {} });
  assert.equal(reopened.isPinned('classic'), false);
  assert.equal(reopened.isPinned('rocket'), false);
  assert.equal(reopened.isPinned('carving'), true);
  assert.equal(reopened.isPinned('particle'), true);
  pinButton.handlers.click();
  assert.equal(harness.create({ onToggle() {}, onHide() {} }).isPinned('rocket'), true);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const inkPath = require('node:path').join(__dirname, '../web_controller/ideas/ideas-ink.js');
const ink = fs.existsSync(inkPath) ? require(inkPath) : {};

test('handwriting keeps its original strokes through save, resize and restore', () => {
  assert.equal(typeof ink.InkModel, 'function', 'The handwriting model must be available');
  const model = new ink.InkModel();
  model.addStroke([[.1, .2], [.6, .7]]);
  const saved = model.snapshot();
  const restored = new ink.InkModel(structuredClone(saved));
  assert.deepEqual(restored.snapshot(), saved);
  assert.equal(restored.hasContent(), true);
  saved[0][0][0] = .9;
  assert.equal(restored.snapshot()[0][0][0], .1, 'Saved data cannot mutate the restored original');
});

test('eraser removes a touched line, with undo restoring the exact original', () => {
  const model = new ink.InkModel();
  model.addStroke([[.1, .5], [.9, .5]]);
  model.addStroke([[.1, .8], [.9, .8]]);
  const original = model.snapshot();
  assert.equal(model.erase([[.5, .49]], .025), true);
  assert.deepEqual(model.snapshot(), [original[1]]);
  assert.equal(model.undo(), true);
  assert.deepEqual(model.snapshot(), original);
  model.clear(); assert.equal(model.hasContent(), false);
  model.undo(); assert.deepEqual(model.snapshot(), original);
});

test('a tap is retained and invalid stored strokes cannot poison rendering', () => {
  const model = new ink.InkModel([[[.3, .4]], [[NaN, .1]], 'bad', [[2, -.5], [.5, .6]]]);
  assert.deepEqual(model.snapshot(), [[[.3, .4]], [[1, 0], [.5, .6]]]);
  model.clear(); model.addStroke([[.2, .3]]);
  assert.equal(model.hasContent(), true);
});

test('a fast eraser swipe removes crossed strokes between sampled points without erasing a distant line', () => {
  const original = [[[.5, .3], [.5, .7]], [[.1, .1], [.9, .1]], [[.3, .5]]];
  const model = new ink.InkModel(original);
  assert.equal(model.erase([[.1, .5], [.9, .5]]), true);
  assert.deepEqual(model.snapshot(), [original[1]]);
  model.undo(); assert.deepEqual(model.snapshot(), original);
  assert.equal(model.erase([[.1, .9], [.9, .9]]), false);
});

test('touch coordinates follow the visible canvas, while a cancelled stroke is retained', async () => {
  const handlers = new Map(), changed = [];
  const context = { fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {}, save() {}, restore() {} };
  let bounds = { left: 10, top: 20, width: 600, height: 320 };
  const canvas = {
    width: 1600, height: 853, getContext: () => context,
    getBoundingClientRect: () => bounds,
    addEventListener: (type, handler) => handlers.set(type, handler),
    setPointerCapture() {}, releasePointerCapture() {},
    toBlob: callback => callback(new Blob(['original-strokes'], { type: 'image/jpeg' }))
  };
  const editor = ink.create(canvas, { onChange: strokes => changed.push(strokes) });
  const event = (x, y) => ({ clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true, preventDefault() {} });
  handlers.get('pointerdown')(event(70, 84));
  handlers.get('pointermove')(event(370, 244));
  handlers.get('pointercancel')(event(370, 244));
  assert.deepEqual(editor.snapshot()[0], [[.1, .2], [.6, .7]]);
  assert.equal(changed.length, 1);
  bounds = { left: 0, top: 0, width: 300, height: 160 };
  handlers.get('pointerdown')(event(30, 32)); handlers.get('pointerup')(event(30, 32));
  assert.deepEqual(editor.snapshot()[1], [[.1, .2]]);
  editor.setDisabled(true); handlers.get('pointerdown')(event(50, 50)); handlers.get('pointerup')(event(50, 50));
  assert.equal(editor.snapshot().length, 2);
  assert.equal((await editor.toBlob()).type, 'image/jpeg');
});

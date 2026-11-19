'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CameraScanner, Stabilizer, answerFromCorners, rgbaFrame } = require('../miniprogram/teacher/lib/paper-scanner');
const AR = require('../miniprogram/teacher/lib/paper-vendor/aruco');
const { cardMatrix, drawCard } = require('../miniprogram/teacher/lib/paper-data');
const rotate = matrix => matrix[0].map((_, x) => matrix.map(row => row[x]).reverse());
function image(matrix) {
  const cell = 16, width = matrix.length * cell, data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4, value = matrix[Math.floor(y / cell)][Math.floor(x / cell)] ? 255 : 0;
    data[offset] = data[offset + 1] = data[offset + 2] = value; data[offset + 3] = 255;
  }
  return { width, height: width, data };
}
const positions = { A: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], B: [{ x: 0, y: 10 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
const marker = option => ({ id: 0, corners: positions[option], hammingDistance: 0 });

test('native packaged decoder is the existing checked-in decoder, including license notices', () => {
  for (const name of ['aruco.js', 'cv.js']) assert.equal(fs.readFileSync(require.resolve('../miniprogram/teacher/lib/paper-vendor/' + name), 'utf8'), fs.readFileSync(require.resolve('../web_controller/card-quiz/vendor/' + name), 'utf8'));
});
test('all 157 native cards decode with their original number and orientation in four rotations', () => {
  const detector = new AR.Detector({ dictionaryName: 'QCMCAM_4X4_157h3', maxHammingDistance: 2 });
  for (let number = 1; number <= 157; number++) {
    let matrix = cardMatrix(number);
    for (const expected of ['A', 'D', 'C', 'B']) {
      const found = detector.detect(image(matrix)).filter(item => item.id === number - 1);
      assert.ok(found.some(item => answerFromCorners(item.corners) === expected), number + ': ' + expected); matrix = rotate(matrix);
    }
  }
});
test('three independent frames are required; duplicate conflicts cannot accumulate a valid answer', () => {
  const s = new Stabilizer(); for (let i = 0; i < 10; i++) assert.deepEqual(s.feed([marker('A'), marker('B')], i * 180, 4), []);
  assert.deepEqual(s.feed([marker('A')], 2000, 4), []); assert.deepEqual(s.feed([marker('A')], 2180, 4), []);
  assert.deepEqual(s.feed([marker('A')], 2360, 4), [{ cardNumber: 1, option: 'A' }]);
  assert.deepEqual(s.feed([marker('A')], 2540, 4), []);
});
test('native camera frames are decoded in memory; stopping invalidates already queued callbacks', async () => {
  let callback, starts = 0, stops = 0, now = 0; const reads = [];
  const scanner = new CameraScanner({ onRead: read => reads.push(read), now: () => now });
  scanner.start({ onCameraFrame: fn => { callback = fn; return { start() { starts++; }, stop() { stops++; } }; } }, 'round-a', 4);
  const frame = image(cardMatrix(1));
  for (let i = 0; i < 3; i++) { now = i * 180; callback({ ...frame, data: frame.data.buffer }); }
  scanner.stop(); await Promise.resolve(); assert.deepEqual(reads, []); assert.equal(starts, 1); assert.equal(stops, 1);
  now = 1000; callback(frame); assert.deepEqual(reads, []);
});
test('the native adapter submits one stable result, and never repeats it for unchanged cards', async () => {
  let callback, now = 0; const reads = [];
  const scanner = new CameraScanner({ onRead: read => reads.push(read), now: () => now });
  scanner.start({ onCameraFrame: fn => { callback = fn; return { start() {}, stop() {} }; } }, 'round-a', 4);
  const frame = image(cardMatrix(157));
  for (let i = 0; i < 8; i++) { now = i * 180; callback(frame); await Promise.resolve(); }
  assert.deepEqual(reads, [{ cardNumber: 157, option: 'A' }]); scanner.stop();
});
test('bad native frame layout fails closed and oversized frames are bounded before decoding', () => {
  assert.throws(() => rgbaFrame({ width: 100, height: 100, data: new Uint8Array(20) }));
  const reduced = rgbaFrame({ width: 1280, height: 720, data: new Uint8ClampedArray(1280 * 720 * 4) });
  assert.equal(reduced.width, 640); assert.equal(reduced.height, 360);
});
test('the actual native card drawing keeps the marker square, white margins and all orientation labels', () => {
  const rects = [], labels = []; const ctx = { fillRect(...args) { rects.push({ color: this.fillStyle, args }); }, fillText(text) { labels.push(text); }, save() {}, restore() {}, translate() {}, rotate() {} };
  drawCard(ctx, 157); const cells = rects.filter(rect => rect.color === '#000');
  assert.ok(cells.length); assert.ok(cells.every(rect => rect.args[2] === 96 && rect.args[3] === 96));
  assert.ok(cells.every(rect => rect.args[0] >= 192 && rect.args[1] >= 288 && rect.args[0] + 96 <= 768 && rect.args[1] + 96 <= 864));
  for (const letter of ['A', 'B', 'C', 'D']) assert.ok(labels.includes(letter));
});

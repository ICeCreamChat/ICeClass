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
test('the collection page requests large native frames from the rear camera', () => {
  const page = fs.readFileSync(require.resolve('../miniprogram/teacher/pages/paper-round/index.wxml'), 'utf8');
  const camera = page.match(/<camera\b[^>]*>/)?.[0] || '';
  for (const setting of ['device-position="back"', 'resolution="high"', 'frame-size="large"']) {
    assert.ok(camera.includes(setting), setting);
  }
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
test('native capture samples candidates faster and leaves idle time for the camera and touch controls', async () => {
  let at = 0, callback, markers = [], cost = 0;
  const samples = [], reads = [], frame = image(cardMatrix(1));
  const detector = { detect() { samples.push(at); at += cost; return markers; } };
  const scanner = new CameraScanner({ now: () => at, detector, onRead: read => reads.push(read) });
  scanner.start({ onCameraFrame(fn) { callback = fn; return { start() {}, stop() {} }; } }, 'round', 4);
  const feed = (...times) => { for (const time of times) { at = time; callback(frame); } };
  try {
    feed(0, 30, 75);
    markers = [{ ...marker('A'), hammingDistance: 1 }];
    feed(150, 200, 225, 300, 375, 450);
    await Promise.resolve();
    assert.deepEqual(reads, [], 'five weak frames are insufficient');
    feed(525, 600);
    await Promise.resolve();
    assert.deepEqual(samples, [0, 150, 225, 300, 375, 450, 525]);
    assert.deepEqual(reads, [{ cardNumber: 1, option: 'A' }]);
    cost = 170; markers = [marker('B')];
    feed(675, 850, 874, 875, 1050, 1075);
    await Promise.resolve();
    assert.deepEqual(samples.slice(-3), [675, 875, 1075]);
    assert.deepEqual(reads.at(-1), { cardNumber: 1, option: 'B' });
  } finally { scanner.stop(); }
});
test('bad native frame layout fails closed and oversized frames are bounded before decoding', () => {
  assert.throws(() => rgbaFrame({ width: 100, height: 100, data: new Uint8Array(20) }));
  const native = new Uint8ClampedArray(1920 * 1080 * 4);
  for (const [width, height] of [[1920,1080],[1080,1920]]) {
    assert.ok(rgbaFrame({width,height,data:native}).data === native, 'keep native 1080p camera detail');
  }
  for (const [width, height] of [[2560, 1440], [1440, 2560]]) {
    const reduced = rgbaFrame({ width, height, data: new Uint8ClampedArray(width * height * 4) });
    assert.equal(reduced.width, width * 0.75);
    assert.equal(reduced.height, height * 0.75);
  }
  const pixels = new Uint8Array(3840 * 4);
  pixels.set([0, 20, 40, 255, 40, 80, 160, 255]);
  const reduced = rgbaFrame({ width: 3840, height: 1, data: pixels });
  assert.deepEqual([...reduced.data.slice(0, 4)], [20, 50, 100, 255]);
});
test('the actual native card drawing keeps the marker square, white margins and all orientation labels', () => {
  const rects = [], labels = []; const ctx = { fillRect(...args) { rects.push({ color: this.fillStyle, args }); }, fillText(text) { labels.push(text); }, save() {}, restore() {}, translate() {}, rotate() {} };
  drawCard(ctx, 157); const cells = rects.filter(rect => rect.color === '#000');
  assert.ok(cells.length); assert.ok(cells.every(rect => rect.args[2] === 96 && rect.args[3] === 96));
  assert.ok(cells.every(rect => rect.args[0] >= 192 && rect.args[1] >= 288 && rect.args[0] + 96 <= 768 && rect.args[1] + 96 <= 864));
  for (const letter of ['A', 'B', 'C', 'D']) assert.ok(labels.includes(letter));
});

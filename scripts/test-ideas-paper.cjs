'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../web_controller/ideas/ideas-paper.js');
const source = () => {
  assert.ok(fs.existsSync(filename), 'The standalone paper editor must exist.');
  return fs.readFileSync(filename, 'utf8');
};
const math = () => { source(); return require(filename); };
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function png(width = 1200, height = 800) {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width); view.setUint32(20, height);
  bytes[24] = 8; bytes[25] = 2;
  bytes.set([73, 68, 65, 84], 37);
  return bytes;
}

function jpeg(width, height) {
  const bytes = new Uint8Array([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 17, 8, 0, 0, 0, 0, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0]);
  const view = new DataView(bytes.buffer);
  view.setUint16(13, height); view.setUint16(15, width);
  return bytes;
}

function webp(width, height, animated = false) {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from('RIFF')); view.setUint32(4, 40, true); bytes.set(Buffer.from('WEBPVP8X'), 8);
  view.setUint32(16, 10, true); bytes[20] = animated ? 2 : 0;
  for (let i = 0; i < 3; i += 1) { bytes[24 + i] = ((width - 1) >>> (i * 8)) & 255; bytes[27 + i] = ((height - 1) >>> (i * 8)) & 255; }
  bytes.set(Buffer.from('VP8 '), 30); view.setUint32(34, 10, true);
  bytes.set([0, 0, 0, 157, 1, 42], 38);
  view.setUint16(44, width, true); view.setUint16(46, height, true);
  return bytes;
}

// This boundary double runs the actual editor and records its DOM/Canvas calls.
// It does not simulate browser layout, JPEG compression, or native dialog focus.
function harness(options = {}) {
  const created = [], canvases = [], draws = [], encodes = [], readers = [], images = [], revoked = [], observers = [];
  const urls = new Map();
  let document;
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.style = {}; this.dataset = {};
      this.attrs = {}; this.listeners = new Map(); this.hidden = false; this.disabled = false; this.open = false; this._text = '';
      this.className = ''; this.value = ''; this.tabIndex = -1; this.rect = null;
      created.push(this);
    }
    get isConnected() { return this === document?.body || !!this.parentNode?.isConnected; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    append(...nodes) { for (const child of nodes) { child.parentNode = this; this.children.push(child); } }
    replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    removeAttribute(name) { delete this.attrs[name]; if (name === 'src') this.src = ''; }
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); }
    fire(type, fields = {}) {
      const event = { type, target: this, currentTarget: this, button: 0, isPrimary: true, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...fields };
      for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
      return event;
    }
    click() { if (!this.disabled) this.fire('click'); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
    setPointerCapture(id) { this.pointerId = id; }
    hasPointerCapture(id) { return this.pointerId === id; }
    releasePointerCapture() { this.pointerId = null; }
    getBoundingClientRect() {
      if (this.rect) return this.rect;
      const width = parseFloat(this.style.width) || 640, height = parseFloat(this.style.height) || 300;
      return { left: 24, top: 80, width, height, right: 24 + width, bottom: 80 + height };
    }
  }
  class Canvas extends Element {
    constructor() { super('canvas'); this.width = 300; this.height = 150; canvases.push(this); }
    getContext() {
      return { fillRect() {}, set fillStyle(_value) {}, set imageSmoothingEnabled(_value) {}, set imageSmoothingQuality(_value) {},
        drawImage: (...args) => { draws.push({ canvas: this, args }); } };
    }
    toBlob(callback, type, quality) {
      encodes.push({ canvas: this, callback, type, quality, width: this.width, height: this.height });
      if (options.encode) return options.encode(callback, type, quality, encodes.length);
      queueMicrotask(() => callback(new Blob(['final-jpeg'], { type })));
    }
  }
  class Image extends Element {
    constructor() { super('img'); this.naturalWidth = options.width || 1200; this.naturalHeight = options.height || 800; images.push(this); }
    get src() { return this._src || ''; }
    set src(value) {
      this._src = value;
      if (value && !options.manualImages) queueMicrotask(() => { if (this._src === value) this.onload?.(); });
    }
  }
  class Reader {
    constructor() { this.readyState = 0; readers.push(this); }
    readAsArrayBuffer(blob) {
      this.readyState = 1;
      const reading = options.readHeader ? options.readHeader(blob) : blob.arrayBuffer();
      Promise.resolve(reading).then(buffer => {
        if (this.readyState !== 1) return;
        this.readyState = 2; this.result = buffer; this.onload?.();
      }, () => { this.readyState = 2; this.onerror?.(); });
    }
    abort() { this.aborted = true; this.readyState = 2; this.onabort?.(); }
  }
  document = new Element('document'); document.body = new Element('body'); document.hidden = false;
  document.createElement = tag => tag === 'canvas' ? new Canvas() : tag === 'img' ? new Image() : new Element(tag);
  const trigger = new Element('button'); document.body.append(trigger); trigger.focus();
  const window = new Element('window');
  Object.assign(window, {
    document, HTMLCanvasElement: Canvas, Blob, FileReader: Reader,
    URL: { createObjectURL(blob) { const url = `blob:paper/${urls.size + revoked.length + 1}`; urls.set(url, blob); return url; },
      revokeObjectURL(url) { revoked.push(url); urls.delete(url); } },
    ResizeObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe(element) { this.element = element; } disconnect() { this.disconnected = true; } },
    setTimeout(fn, delay) { const timer = setTimeout(fn, delay); timer.unref(); return timer; }, clearTimeout,
    fetch() { assert.fail('The editor must not upload or request data.'); },
    localStorage: new Proxy({}, { get() { assert.fail('The editor must not use storage.'); } }),
    navigator: { sendBeacon() { assert.fail('The editor must not send analytics.'); } },
    console: new Proxy({}, { get() { return () => assert.fail('The editor must not log.'); } })
  });
  const sandbox = { window, document, Blob, Uint8Array, ArrayBuffer, DataView, FileReader: Reader, URL: window.URL, HTMLCanvasElement: Canvas,
    ResizeObserver: window.ResizeObserver, setTimeout: window.setTimeout, clearTimeout, console: window.console, queueMicrotask };
  vm.runInNewContext(source(), sandbox, { filename });
  assert.equal(typeof window.ICeClassIdeasPaper?.open, 'function');
  assert.equal(typeof window.ICeClassIdeasPaper.cancel, 'function');
  const all = () => { const walk = node => [node, ...node.children.flatMap(walk)]; return walk(document.body); };
  const byClass = name => all().find(node => node.className.split(' ').includes(`ideas-paper-${name}`));
  const button = text => { const found = all().find(node => node.tagName === 'BUTTON' && node.textContent === text); assert.ok(found, `Missing button: ${text}`); return found; };
  const ranges = () => all().filter(node => node.tagName === 'INPUT' && node.type === 'range');
  const canvas = (width = 1200, height = 800) => { const result = new Canvas(); result.width = width; result.height = height; return result; };
  return { api: window.ICeClassIdeasPaper, document, window, created, canvases, draws, encodes, readers, images, revoked, urls, observers, trigger, canvas, byClass, button, ranges };
}

test('crop bounds remain finite, ordered and inside the source', () => {
  const { clampCrop, changeEdge, moveCrop } = math();
  assert.deepEqual(clampCrop({ left: -1, top: -.2, right: 3, bottom: 1.2 }), { left: 0, top: 0, right: 1, bottom: 1 });
  assert.throws(() => clampCrop({ left: NaN, top: 0, right: 1, bottom: 1 }));
  assert.deepEqual(changeEdge({ left: .2, top: .2, right: .8, bottom: .8 }, 'left', .99), { left: .79, top: .2, right: .8, bottom: .8 });
  const moved = moveCrop({ left: .2, top: .1, right: .6, bottom: .7 }, 3, -4);
  assert.equal(moved.right, 1); assert.equal(moved.top, 0);
  assert.ok(Math.abs(moved.left - .6) < 1e-10); assert.ok(Math.abs(moved.bottom - .6) < 1e-10);
});

test('landscape and portrait export plans scale the selected source rectangle, without upscaling', () => {
  const { cropPlan } = math();
  assert.deepEqual(cropPlan(4000, 3000, { left: .25, top: .1, right: .75, bottom: .9 }), { sx: 1000, sy: 300, sw: 2000, sh: 2400, width: 1333, height: 1600 });
  assert.deepEqual(cropPlan(3000, 4000, { left: 0, top: .25, right: 1, bottom: .75 }), { sx: 0, sy: 1000, sw: 3000, sh: 2000, width: 1600, height: 1067 });
  assert.deepEqual(cropPlan(400, 300, { left: .25, top: 0, right: .75, bottom: 1 }), { sx: 100, sy: 0, sw: 200, sh: 300, width: 200, height: 300 });
  const tiny = cropPlan(1, 1, { left: .999, top: .999, right: 1, bottom: 1 });
  assert.equal(tiny.sw, 1); assert.equal(tiny.sh, 1); assert.equal(tiny.width, 1); assert.equal(tiny.height, 1);
});

test('image fitting handles portrait and landscape without changing crop coordinates', () => {
  const { fitImage } = math();
  assert.deepEqual(fitImage(4000, 3000, 600, 300), { width: 400, height: 300 });
  assert.deepEqual(fitImage(3000, 4000, 600, 300), { width: 225, height: 300 });
  assert.throws(() => fitImage(0, 1, 600, 300));
});

test('bounded header inspection accepts normal photos and rejects malformed, animated or extreme input before decoding', () => {
  const { inspectImageHeader, validateDimensions } = math();
  assert.deepEqual(inspectImageHeader(png(1200, 800)), { width: 1200, height: 800 });
  assert.deepEqual(inspectImageHeader(jpeg(3000, 4000)), { width: 3000, height: 4000 });
  assert.deepEqual(inspectImageHeader(webp(1200, 800)), { width: 1200, height: 800 });
  for (const bytes of [png(50000, 50000), png(0, 800), jpeg(65535, 65535), webp(10000, 10000), webp(1200, 800, true), new Uint8Array([255, 216, 255]), new TextEncoder().encode('<svg/>')]) {
    assert.throws(() => inspectImageHeader(bytes));
  }
  assert.throws(() => validateDimensions(Infinity, 1));
  assert.throws(() => validateDimensions(8000, 8000));
});

test('nothing reaches the caller until crop, final JPEG preview, and use are explicitly confirmed', async () => {
  const h = harness(); const input = h.canvas();
  const result = h.api.open(input); let settled = false; result.then(() => { settled = true; });
  await flush();
  assert.equal(settled, false); assert.equal(h.encodes.length, 0);
  assert.equal(h.ranges().length, 4);
  for (const range of h.ranges()) assert.ok(range.id, 'Each non-drag edge control needs a label target.');
  const values = [250, 100, 750, 900];
  h.ranges().forEach((range, i) => { range.value = String(values[i]); range.fire('input'); });
  h.button('裁剪并预览').click(); await flush();
  assert.equal(settled, false);
  const encoded = h.encodes[0];
  assert.equal(encoded.type, 'image/jpeg');
  const draw = h.draws.filter(entry => entry.canvas === encoded.canvas).at(-1);
  assert.equal(draw.args.length, 9, 'Export must pass the selected source rectangle to drawImage.');
  assert.notEqual(draw.args[0], input, 'The caller-owned captured canvas must be snapshotted.');
  assert.deepEqual(draw.args.slice(1), [300, 80, 600, 640, 0, 0, 600, 640]);
  assert.equal(h.byClass('preview').hidden, false);
  h.button('使用纸条').click();
  const blob = await result;
  assert.equal(blob.type, 'image/jpeg'); assert.ok(blob.size <= 2 * 1024 * 1024);
  assert.equal(h.document.body.children.length, 1); assert.equal(h.document.activeElement, h.trigger);
  assert.equal(h.urls.size, 0);
  for (const owned of h.canvases.filter(item => item !== input)) { assert.equal(owned.width, 0); assert.equal(owned.height, 0); }
  assert.equal(input.width, 1200); assert.equal(input.height, 800);
  assert.ok(h.images.every(image => image.src === ''));
});

test('the final preview waits for its own image load and supports a fresh crop', async () => {
  const h = harness({ manualImages: true }); const result = h.api.open(h.canvas());
  h.button('裁剪并预览').click(); await flush();
  assert.equal(h.button('使用纸条').disabled, true);
  const preview = h.images.find(image => image.src); assert.ok(preview); preview.onload();
  assert.equal(h.button('使用纸条').disabled, false);
  assert.equal(preview.width, 960); assert.equal(preview.height, 640);
  h.button('重新裁剪').click();
  assert.equal(preview.src, ''); assert.equal(h.urls.size, 0);
  assert.equal(h.byClass('editor').hidden, false);
  assert.equal(h.button('裁剪并预览').disabled, false);
  h.api.cancel(); assert.equal(await result, null);
});

test('an imported portrait photo stays local, and both source and final URLs are cleared after use', async () => {
  const h = harness({ width: 800, height: 1200 });
  const result = h.api.open(new Blob([png(800, 1200)], { type: 'image/png' })); await flush();
  assert.equal(h.urls.size, 1);
  const original = h.images.find(image => image.src); assert.ok(original);
  h.button('裁剪并预览').click(); await flush();
  const encoded = h.encodes[0], draw = h.draws.filter(entry => entry.canvas === encoded.canvas).at(-1);
  assert.equal(draw.args[0], original);
  assert.deepEqual(draw.args.slice(1), [80, 120, 640, 960, 0, 0, 640, 960]);
  assert.equal(h.urls.size, 2);
  h.button('使用纸条').click(); assert.equal((await result).type, 'image/jpeg');
  assert.equal(original.src, ''); assert.equal(h.urls.size, 0); assert.equal(h.revoked.length, 2);
});

test('stale preview decode errors cannot clear a newer crop preview in the same editor', async () => {
  const h = harness({ manualImages: true }); const result = h.api.open(h.canvas());
  h.button('裁剪并预览').click(); await flush();
  const photo = h.images.find(image => image.src), oldError = photo.onerror;
  photo.onload(); h.button('重新裁剪').click();
  h.button('裁剪并预览').click(); await flush(); photo.onload();
  oldError();
  assert.equal(h.button('使用纸条').disabled, false);
  assert.equal(h.byClass('preview').hidden, false);
  h.button('使用纸条').click(); assert.equal((await result).type, 'image/jpeg');
});

test('edge controls are disabled while the crop is being encoded', async () => {
  const h = harness({ encode() {} }); const result = h.api.open(h.canvas());
  h.button('裁剪并预览').click();
  assert.ok(h.ranges().every(range => range.disabled));
  assert.equal(h.byClass('editor').inert, true);
  h.api.cancel(); assert.equal(await result, null);
});

test('pointer handles, selection arrow keys and a viewport resize preserve the selected source area', async () => {
  const h = harness(); const result = h.api.open(h.canvas());
  const selection = h.byClass('selection');
  selection.fire('keydown', { key: 'ArrowRight', shiftKey: false });
  const stage = h.byClass('stage');
  const handle = h.created.find(node => node.dataset.corner === 'nw'); assert.ok(handle);
  const rect = stage.getBoundingClientRect();
  handle.fire('pointerdown', { pointerId: 7, clientX: rect.left + rect.width * .105, clientY: rect.top + rect.height * .1 });
  stage.fire('pointermove', { pointerId: 7, clientX: rect.left + rect.width * .25, clientY: rect.top + rect.height * .2 });
  stage.fire('pointerup', { pointerId: 7 });
  h.byClass('workspace').rect = { left: 0, top: 0, width: 250, height: 320 };
  h.window.fire('resize'); for (const observer of h.observers) observer.callback();
  h.button('裁剪并预览').click(); await flush();
  const draw = h.draws.filter(entry => entry.canvas === h.encodes[0].canvas).at(-1);
  assert.deepEqual(draw.args.slice(1, 5), [300, 160, 786, 560]);
  h.api.cancel(); assert.equal(await result, null);
});

test('cancel immediately aborts pending header reads and releases cancelled input', async () => {
  const reading = deferred(); const h = harness({ readHeader: () => reading.promise });
  const result = h.api.open(new Blob([png()], { type: 'image/png' }));
  assert.equal(h.readers.length, 1); h.api.cancel();
  assert.equal(h.readers[0].aborted, true); assert.equal(h.document.body.children.length, 1);
  assert.equal(await result, null);
  reading.resolve(png().buffer); await flush();
  assert.equal(h.urls.size, 0); assert.equal(h.encodes.length, 0);
  assert.ok(h.images.every(image => image.src === ''));
});

test('replacement aborts decoding, ignores a stale load/close callback, and leaves the new editor usable', async () => {
  const h = harness({ manualImages: true });
  const oldResult = h.api.open(new Blob([png()], { type: 'image/png' })); await flush();
  const oldImage = h.images.find(image => image.src); assert.ok(oldImage);
  const oldLoad = oldImage.onload, oldDialog = h.byClass('dialog');
  const newInput = h.canvas(800, 1200); const newResult = h.api.open(newInput);
  assert.equal(await oldResult, null); assert.equal(oldImage.src, ''); assert.equal(h.urls.size, 0);
  oldLoad(); oldDialog.fire('close');
  assert.equal(h.byClass('dialog').open, true);
  h.button('裁剪并预览').click(); await flush();
  const preview = h.images.find(image => image.src); preview.onload();
  h.button('使用纸条').click(); assert.equal((await newResult).type, 'image/jpeg');
  assert.equal(newInput.width, 800); assert.equal(newInput.height, 1200);
});

test('a stale JPEG encoder cannot create a preview or return a blob after cancellation', async () => {
  const h = harness({ encode() {} }); const input = h.canvas(); const result = h.api.open(input);
  h.button('裁剪并预览').click(); assert.equal(h.encodes.length, 1);
  const late = h.encodes[0].callback; h.api.cancel(); assert.equal(await result, null);
  late(new Blob(['stale'], { type: 'image/jpeg' })); await flush();
  assert.equal(h.urls.size, 0); assert.equal(h.document.body.children.length, 1);
  for (const owned of h.canvases.filter(item => item !== input)) assert.equal(owned.width, 0);
});

test('JPEG encoding lowers quality until the size bound is satisfied', async () => {
  const h = harness({ encode(callback, type, _quality, count) {
    queueMicrotask(() => callback(new Blob([new Uint8Array(count < 3 ? 2 * 1024 * 1024 + 1 : 100)], { type })));
  } });
  const result = h.api.open(h.canvas(4000, 3000)); h.button('裁剪并预览').click(); await flush();
  assert.equal(h.encodes.length, 3); assert.ok(h.encodes[1].quality < h.encodes[0].quality);
  assert.ok(h.encodes.every(entry => Math.max(entry.width, entry.height) <= 1600));
  h.button('使用纸条').click(); assert.equal((await result).size, 100);
});

test('JPEG size retries reduce dimensions while keeping the same source crop rectangle', async () => {
  const oversized = new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/jpeg' });
  const h = harness({ encode(callback, type, _quality, count) {
    queueMicrotask(() => callback(count < 5 ? oversized : new Blob(['small'], { type })));
  } });
  const result = h.api.open(h.canvas(4000, 3000)); h.button('裁剪并预览').click(); await flush();
  assert.equal(h.encodes.length, 5); assert.equal(h.encodes[0].width, 1600); assert.equal(h.encodes[4].width, 1280);
  const crops = h.draws.filter(entry => entry.canvas === h.encodes[0].canvas);
  assert.deepEqual(crops.map(entry => entry.args.slice(1, 5)), [[400, 300, 3200, 2400], [400, 300, 3200, 2400]]);
  h.button('使用纸条').click(); assert.equal((await result).type, 'image/jpeg');
});

test('JPEG output that remains oversized never becomes usable and releases its encoding canvas', async () => {
  const oversized = new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/jpeg' });
  const h = harness({ encode(callback) { queueMicrotask(() => callback(oversized)); } });
  const result = h.api.open(h.canvas()); let settled = false; result.then(() => { settled = true; });
  h.button('裁剪并预览').click(); await flush();
  assert.equal(settled, false); assert.equal(h.button('使用纸条').hidden, true);
  assert.equal(h.byClass('error').hidden, false); assert.equal(h.button('裁剪并预览').disabled, false);
  assert.equal(h.encodes.at(-1).canvas.width, 0); assert.equal(h.urls.size, 0);
  h.api.cancel(); assert.equal(await result, null);
});

test('failed or wrong-type JPEG encoding stays local with recoverable error feedback', async () => {
  for (const value of [null, new Blob(['png'], { type: 'image/png' })]) {
    const h = harness({ encode(callback) { queueMicrotask(() => callback(value)); } });
    const result = h.api.open(h.canvas()); h.button('裁剪并预览').click(); await flush();
    assert.equal(h.button('裁剪并预览').disabled, false);
    assert.equal(h.byClass('error').hidden, false); assert.equal(h.urls.size, 0);
    h.api.cancel(); assert.equal(await result, null);
  }
});

test('malformed and extreme imports report an error without starting browser image decode', async () => {
  for (const input of [new Blob([png(100000, 100000)], { type: 'image/png' }), new Blob(['not an image']), new Blob([new Uint8Array(21 * 1024 * 1024)], { type: 'image/jpeg' })]) {
    const h = harness(); const result = h.api.open(input); await flush();
    assert.equal(h.byClass('error').hidden, false); assert.equal(h.urls.size, 0);
    assert.ok(h.images.every(image => image.src === '')); assert.equal(h.encodes.length, 0);
    h.api.cancel(); assert.equal(await result, null);
  }
});

test('decoding failure and unexpectedly huge decoded dimensions release their object URLs', async () => {
  for (const broken of [true, false]) {
    const h = harness({ manualImages: true }); const result = h.api.open(new Blob([png()])); await flush();
    const image = h.images.find(item => item.src); assert.ok(image);
    if (broken) image.onerror(); else { image.naturalWidth = 100000; image.onload(); }
    assert.equal(image.src, ''); assert.equal(h.urls.size, 0); assert.equal(h.byClass('error').hidden, false);
    h.api.cancel(); assert.equal(await result, null);
  }
});

test('Escape, native close, cancellation and page hide synchronously reset editing and release resources', async () => {
  for (const action of ['escape', 'close', 'button', 'pagehide', 'hidden']) {
    const h = harness(); const input = h.canvas(); const result = h.api.open(input);
    h.button('裁剪并预览').click(); await flush();
    const dialog = h.byClass('dialog');
    if (action === 'escape') assert.equal(dialog.fire('keydown', { key: 'Escape' }).defaultPrevented, true);
    if (action === 'close') dialog.close();
    if (action === 'button') h.button('取消').click();
    if (action === 'pagehide') h.window.fire('pagehide');
    if (action === 'hidden') { h.document.hidden = true; h.document.fire('visibilitychange'); }
    assert.equal(h.document.body.children.length, 1); assert.equal(h.urls.size, 0);
    assert.equal(await result, null); assert.ok(h.observers.every(observer => observer.disconnected));
    assert.ok(h.images.every(image => image.src === ''));
    for (const owned of h.canvases.filter(item => item !== input)) assert.equal(owned.width, 0);
  }
});

'use strict';
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

// With a git revision, run the same camera and measurement code against that revision.
const root = path.resolve(__dirname, '..');
const revision = process.argv[2];
function source(file) {
  const name = 'web_controller/card-quiz/' + file;
  return revision ? execFileSync('git', ['show', revision + ':' + name], {cwd:root, encoding:'utf8'})
    : readFileSync(path.join(root, name), 'utf8');
}

async function measure(readTrack) {
  const width = 1920, height = 1080, frames = [];
  const board = document.createElement('canvas');
  board.width = width;
  board.height = height;
  const pen = board.getContext('2d');
  // Small rear cards, four orientations across the full view. Eight foreground
  // cards have one doubtful payload cell, so their confirmations need more frames.
  for (const offset of [0, 1, -1]) {
    pen.fillStyle = '#ccc';
    pen.fillRect(0, 0, width, height);
    for (let i = 0; i < 60; i++) {
      const row = Math.floor(i / 10), cell = [4, 5, 6, 8, 10, 14][row];
      pen.save();
      pen.translate(64 + (i % 10) * 199 + offset, 48 + row * 191);
      pen.rotate((i % 4) * Math.PI / 2);
      const matrix = CardQuizCards.matrix(i + 1);
      let doubtful = i >= 52;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        pen.fillStyle = matrix[y][x] ? '#eee' : '#111';
        if (doubtful && x >= 2 && x <= 5 && y >= 2 && y <= 5 && matrix[y][x]) {
          pen.fillStyle = '#606060';
          doubtful = false;
        }
        pen.fillRect((x - 4) * cell, (y - 4) * cell, cell, cell);
      }
      pen.restore();
    }
    frames.push(await createImageBitmap(board));
  }

  // Produce timestamps on a different thread; busy detection on the page can
  // drop camera frames but cannot slow the synthetic camera's clock.
  async function produce({data:{output, frames}}) {
    const writer = output.getWriter(), start = performance.now();
    let count = 0, due = start, firstStamp, lastStamp;
    self.onmessage = () => self.postMessage((count - 1) * 1000 / (lastStamp - firstStamp));
    async function next() {
      const elapsed = performance.now() - start;
      const frame = new VideoFrame(frames[count % frames.length], {timestamp:Math.round(elapsed * 1000)});
      try { await writer.write(frame); } finally { frame.close(); }
      if (count === 0) firstStamp = elapsed;
      lastStamp = elapsed;
      count++;
      due = Math.max(due + 1000 / 30, performance.now());
      setTimeout(next, due - performance.now());
    }
    await next();
  }
  const url = URL.createObjectURL(new Blob(['onmessage = ' + produce.toString()], {type:'text/javascript'}));
  const worker = new Worker(url), track = new MediaStreamTrackGenerator({kind:'video'});
  worker.postMessage({output:track.writable, frames}, [track.writable, ...frames]);
  navigator.mediaDevices.getUserMedia = async () => new MediaStream([track]);
  const video = document.createElement('video');
  video.muted = true;
  document.body.append(video);
  const reads = [], scans = [], errors = [];
  const scanner = new CardQuizScanner({video, readTrack, waitForFrames:!readTrack,
    onStatus:status => { if (status.kind === 'error') errors.push(status.message); },
    onRead:({cardNumber, option}) => reads.push({cardNumber, option, frame:scans.length, at:performance.now()})});
  scanner.reset('benchmark');
  const copies = {drawImage:0, getImageData:0};
  for (const name of Object.keys(copies)) {
    const original = CanvasRenderingContext2D.prototype[name];
    CanvasRenderingContext2D.prototype[name] = function(...args) {
      if (this.canvas === scanner.canvas) copies[name]++;
      return original.apply(this, args);
    };
  }
  const scan = scanner.scanImage.bind(scanner);
  scanner.scanImage = image => {
    const at = performance.now(), quality = video.getVideoPlaybackQuality();
    const decoded = quality.totalVideoFrames - quality.droppedVideoFrames;
    const markers = scan(image);
    scans.push({at, decoded, cost:performance.now() - at});
    return markers;
  };
  const started = performance.now();
  try {
    await scanner.start();
    while (scans.length < 11 && !errors.length && performance.now() - started < 8000) {
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    if (errors.length) throw new Error(errors.join(', '));
    if (readTrack && !scanner.reader) throw new Error('Track processor unavailable');
    if (scans.length < 11) throw new Error('Camera only supplied ' + scans.length + ' scan samples');
    const first = scans[0], last = scans.at(-1);
    const elapsed = last.at - first.at;
    const sourceFps = await new Promise(resolve => {
      worker.onmessage = event => resolve(event.data);
      worker.postMessage('source-fps');
    });
    const medianCost = scans.map(s => s.cost).sort((a,b) => a-b)[Math.floor(scans.length / 2)];
    return {reads, samples:scans.length, draws:copies.drawImage, readbacks:copies.getImageData, detectMs:medianCost,
      sourceFps, videoFps:(last.decoded - first.decoded) * 1000 / elapsed,
      scanFps:(scans.length - 1) * 1000 / elapsed, confirmingFps:5000 / (scans[5].at - first.at),
      firstMs:reads[0]?.at - started, allMs:reads.at(-1)?.at - started,
      firstCount:reads.filter(r => r.frame === reads[0]?.frame).length};
  } finally {
    scanner.stop();
    worker.terminate();
    URL.revokeObjectURL(url);
    video.remove();
  }
}

async function main() {
  const browser = await chromium.launch({channel:'msedge', headless:true});
  try {
    console.log('Edge', browser.version(), revision || 'workspace', '1920x1080, 60 synthetic cards, 30 fps source');
    for (const readTrack of [false, true]) {
      const trials = [];
      for (let trial = 0; trial < 3; trial++) {
        const page = await browser.newPage();
        try {
          await page.route('**/*', route => route.fulfill({contentType:'text/html', body:'<!doctype html><body></body>'}));
          await page.goto('http://localhost/scanner');
          for (const file of ['vendor/cv.js','vendor/aruco.js','cards.js','scanner.js']) {
            await page.addScriptTag({content:source(file)});
          }
          const {reads, ...metrics} = await page.evaluate(measure, readTrack);
          const expected = Array.from({length:60}, (_, i) => [i + 1, 'ADCB'[i % 4]]);
          assert.deepEqual(reads.map(r => [r.cardNumber,r.option]).sort((a,b) => a[0] - b[0]), expected);
          for (const read of reads) assert.equal(read.frame, read.cardNumber <= 52 ? 3 : 6);
          trials.push(metrics);
        } finally { await page.close(); }
      }
      const medians = Object.fromEntries(Object.keys(trials[0]).map(key => [
        key, Number(trials.map(trial => trial[key]).sort((a,b) => a-b)[1].toFixed(1))
      ]));
      console.log(readTrack ? 'board' : 'phone', medians);
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

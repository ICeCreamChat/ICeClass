'use strict';
const AR = require('./paper-vendor/aruco');
// Orientation and evidence thresholds match web_controller/card-quiz/scanner.js.
const confirmInterval = 75, searchInterval = 150;
function answerFromCorners(corners) {
  if (!Array.isArray(corners) || corners.length !== 4) return '';
  const dx = corners[0].x - corners[2].x, dy = corners[0].y - corners[2].y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1) return '';
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  if (Math.abs(angle - Math.round(angle / 90) * 90) < 8) return '';
  return angle > 0 ? angle < 90 ? 'C' : 'B' : angle > -90 ? 'D' : 'A';
}
class Stabilizer {
  constructor() { this.reset(); }
  reset() { this.entries = new Map(); this.frame = 0; this.conflicts = []; this.needsEvidence = false; }
  feed(markers, at, optionCount) {
    this.frame++; this.conflicts = []; this.needsEvidence = false;
    const groups = new Map(), results = [];
    for (const merged of markers) for (const marker of merged.observations || [merged]) {
      if (marker.id !== merged.id || !Number.isInteger(marker.id) || marker.id < 0 || marker.id >= 157) continue;
      const number = marker.id + 1, option = answerFromCorners(marker.corners);
      if (!groups.has(number)) groups.set(number, []);
      groups.get(number).push({ option, distance: marker.hammingDistance == null ? 0 : marker.hammingDistance });
    }
    for (const [number, reads] of groups) {
      let entry = this.entries.get(number);
      if (!entry) { entry = { history: [], committed: '', run: '', streak: 0, lastFrame: 0 }; this.entries.set(number, entry); }
      const options = new Set(reads.map(read => read.option).filter(Boolean)), option = options.size === 1 ? Array.from(options)[0] : '';
      if (options.size > 1) this.conflicts.push(number);
      if (options.size !== 1 || reads.some(read => !read.option) || !'ABCD'.slice(0, optionCount).includes(option)) { entry.history = []; entry.run = ''; entry.streak = 0; continue; }
      const distance = Math.min(...reads.map(read => read.distance)); if (distance > 1 || option === entry.committed) continue;
      entry.history = entry.history.filter(read => this.frame - read.frame < 20 && at - read.at <= 3000);
      entry.history.push({ option, weight: distance === 0 ? 2 : 1, frame: this.frame, at });
      entry.streak = entry.run === option && entry.lastFrame === this.frame - 1 ? entry.streak + 1 : 1;
      entry.run = option; entry.lastFrame = this.frame;
      const score = entry.history.filter(read => read.option === option).reduce((sum, read) => sum + read.weight, 0);
      if (score >= 6 && entry.streak >= 3) {
        entry.committed = option; results.push({ cardNumber: number, option }); entry.history = [];
      } else this.needsEvidence = true;
    }
    for (const [number, entry] of this.entries) if (at - (entry.history.length ? entry.history[entry.history.length - 1].at : 0) > 10000 && !entry.committed) this.entries.delete(number);
    return results;
  }
}
function rgbaFrame(frame) {
  if (!frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > 4096 || frame.height > 4096) throw new Error('相机图像尺寸无效。');
  const data = frame.data instanceof ArrayBuffer ? new Uint8ClampedArray(frame.data) : frame.data;
  if (!data || data.length !== frame.width * frame.height * 4) throw new Error('相机未返回 RGBA 帧，请使用手工录入。');
  // Keep enough pixels for the last row of a full class, in either camera orientation.
  const scale = Math.min(1, 1920 / Math.max(frame.width, frame.height), Math.sqrt(1920 * 1080 / (frame.width * frame.height)));
  const width = Math.max(1, Math.round(frame.width * scale)), height = Math.max(1, Math.round(frame.height * scale));
  if (scale === 1) return { width, height, data };
  const resized = new Uint8ClampedArray(width * height * 4);
  // Sample pixel centers with bilinear interpolation. Dropping whole rows or
  // columns can erase an isolated white cell on a distant card.
  const stepX = frame.width / width, stepY = frame.height / height;
  let target = 0;
  for (let y = 0; y < height; y++) {
    const sourceY = (y + 0.5) * stepY - 0.5, top = Math.floor(sourceY);
    const bottom = Math.min(top + 1, frame.height - 1), fy = sourceY - top;
    for (let x = 0; x < width; x++) {
      const sourceX = (x + 0.5) * stepX - 0.5, left = Math.floor(sourceX);
      const right = Math.min(left + 1, frame.width - 1), fx = sourceX - left;
      const topLeft = (top * frame.width + left) * 4, topRight = (top * frame.width + right) * 4;
      const bottomLeft = (bottom * frame.width + left) * 4, bottomRight = (bottom * frame.width + right) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const upper = data[topLeft + channel] + fx * (data[topRight + channel] - data[topLeft + channel]);
        const lower = data[bottomLeft + channel] + fx * (data[bottomRight + channel] - data[bottomLeft + channel]);
        resized[target++] = upper + fy * (lower - upper);
      }
    }
  }
  return { width, height, data: resized };
}
class CameraScanner {
  constructor({ onRead, onStatus = () => {}, now = Date.now, detector } = {}) {
    this.onRead = onRead; this.onStatus = onStatus; this.now = now; this.detector = detector || new AR.Detector({ dictionaryName: 'QCMCAM_4X4_157h3', maxHammingDistance: 2 });
    this.stabilizer = new Stabilizer(); this.running = false; this.revision = 0;
  }
  start(context, key, optionCount) {
    this.stop(); this.key = key; this.optionCount = optionCount; this.nextFrameAt = -Infinity;
    if (!context || typeof context.onCameraFrame !== 'function') throw new Error('当前微信不支持原生相机逐帧识别，请使用手工录入。');
    const revision = this.revision;
    this.listener = context.onCameraFrame(frame => this.feed(frame, revision)); this.running = true;
    try { this.listener.start(); } catch (error) { this.stop(); throw error; }
  }
  feed(frame, revision = this.revision) {
    if (!this.running || revision !== this.revision) return;
    const at = this.now(); if (at < this.nextFrameAt) return;
    try {
      const markers = this.detector.detect(rgbaFrame(frame));
      for (const read of this.stabilizer.feed(markers, at, this.optionCount)) {
        Promise.resolve().then(() => { if (this.running && revision === this.revision) return this.onRead(read, this.key); }).catch(error => {
          if (revision !== this.revision) return; this.stop(); this.onStatus(error.message || '作答尚未确认，识别已停止。');
        });
      }
      // Allow preview and touch events to run even when decoding takes longer than the target interval.
      const interval = this.stabilizer.needsEvidence ? confirmInterval : searchInterval;
      this.nextFrameAt = Math.max(at + interval, this.now() + 30);
      if (this.stabilizer.conflicts.length) this.onStatus('重复卡号方向冲突：' + this.stabilizer.conflicts.join('、'));
    } catch (error) { this.stop(); this.onStatus(error.message || '相机识别失败，请使用手工录入。'); }
  }
  stop() { this.revision++; this.running = false; if (this.listener) { this.listener.stop(); this.listener = null; } this.stabilizer.reset(); }
}
module.exports = { CameraScanner, Stabilizer, answerFromCorners, rgbaFrame };

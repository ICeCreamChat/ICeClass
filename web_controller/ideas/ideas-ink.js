/* Original handwriting is retained as bounded strokes; no handwriting recognition. */
(() => {
  'use strict';
  const MAX_POINTS = 60000;
  const MAX_STROKES = 2000;
  const WIDTH = 1600;
  const HEIGHT = 853;
  const clamp = value => Math.max(0, Math.min(1, value));

  function sanitize(value) {
    if (!Array.isArray(value)) return [];
    const result = [];
    let count = 0;
    for (const stroke of value.slice(0, MAX_STROKES)) {
      if (!Array.isArray(stroke)) continue;
      const points = [];
      for (const point of stroke) {
        if (count >= MAX_POINTS) break;
        if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
        points.push([clamp(point[0]), clamp(point[1])]); count += 1;
      }
      if (points.length) result.push(points);
      if (count >= MAX_POINTS) break;
    }
    return result;
  }

  function distanceToSegment(point, start, end) {
    const ratio = HEIGHT / WIDTH;
    const dx = end[0] - start[0], dy = (end[1] - start[1]) * ratio;
    const length = dx * dx + dy * dy;
    const projection = length ? clamp(((point[0] - start[0]) * dx + (point[1] - start[1]) * ratio * dy) / length) : 0;
    return Math.hypot(point[0] - start[0] - projection * dx, (point[1] - start[1]) * ratio - projection * dy);
  }

  function segmentsNear(a, b, c, d, radius) {
    const verticalRadius = radius * WIDTH / HEIGHT;
    if (Math.max(a[0], b[0]) + radius < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) + radius < Math.min(a[0], b[0])
      || Math.max(a[1], b[1]) + verticalRadius < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) + verticalRadius < Math.min(a[1], b[1])) return false;
    const cross = (start, end, point) => (end[0] - start[0]) * (point[1] - start[1]) - (end[1] - start[1]) * (point[0] - start[0]);
    if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
    return distanceToSegment(a, c, d) <= radius || distanceToSegment(b, c, d) <= radius
      || distanceToSegment(c, a, b) <= radius || distanceToSegment(d, a, b) <= radius;
  }

  class InkModel {
    constructor(strokes) { this.replace(strokes); }
    replace(strokes) { this.strokes = sanitize(strokes); this.history = []; }
    snapshot() { return this.strokes.map(stroke => stroke.map(point => [...point])); }
    hasContent() { return this.strokes.length > 0; }
    remember() { this.history.push(this.strokes); if (this.history.length > 50) this.history.shift(); }
    addStroke(points) {
      const stroke = sanitize([points])[0];
      if (!stroke || this.strokes.length >= MAX_STROKES || this.strokes.reduce((n, path) => n + path.length, 0) + stroke.length > MAX_POINTS) return false;
      this.remember(); this.strokes = [...this.strokes, stroke]; return true;
    }
    erase(points, radius = .025) {
      const path = sanitize([points])[0];
      if (!path) return false;
      const kept = this.strokes.filter(stroke => !path.some((point, index) => stroke.some((start, i) =>
        segmentsNear(point, path[index + 1] || point, start, stroke[i + 1] || start, radius))));
      if (kept.length === this.strokes.length) return false;
      this.remember(); this.strokes = kept; return true;
    }
    clear() { if (!this.hasContent()) return false; this.remember(); this.strokes = []; return true; }
    undo() { if (!this.history.length) return false; this.strokes = this.history.pop(); return true; }
  }

  function create(canvas, options = {}) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('手写画板暂时无法打开，请改用录音或图片。');
    canvas.width = WIDTH; canvas.height = HEIGHT;
    const model = new InkModel();
    let active = null, disabled = false, tool = 'pen';

    function drawStroke(points) {
      if (!points.length) return;
      context.strokeStyle = '#20374e'; context.fillStyle = '#20374e';
      context.lineWidth = 5; context.lineCap = 'round'; context.lineJoin = 'round';
      context.beginPath();
      if (points.length === 1) {
        context.arc(points[0][0] * WIDTH, points[0][1] * HEIGHT, 2.5, 0, Math.PI * 2); context.fill();
      } else {
        context.moveTo(points[0][0] * WIDTH, points[0][1] * HEIGHT);
        for (const point of points.slice(1)) context.lineTo(point[0] * WIDTH, point[1] * HEIGHT);
        context.stroke();
      }
    }

    function render() {
      context.fillStyle = '#fff'; context.fillRect(0, 0, WIDTH, HEIGHT);
      model.strokes.forEach(drawStroke);
    }
    function changed() { options.onChange?.(model.snapshot()); }
    function finish() {
      if (!active) return;
      const stroke = active; active = null;
      try { canvas.releasePointerCapture(stroke.id); } catch { /* Already released by the system. */ }
      const applied = stroke.tool === 'eraser' ? model.erase(stroke.points) : model.addStroke(stroke.points);
      render();
      if (applied) changed();
      else if (stroke.tool === 'pen') options.onError?.('这一页已写满，请先提交，或清空后重新书写。');
    }
    function position(event) {
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return null;
      return [clamp((event.clientX - bounds.left) / bounds.width), clamp((event.clientY - bounds.top) / bounds.height)];
    }
    canvas.addEventListener('pointerdown', event => {
      if (disabled || active || event.isPrimary === false || event.button > 0) return;
      const point = position(event); if (!point) return;
      event.preventDefault();
      active = { id: event.pointerId, points: [point], tool };
      try { canvas.setPointerCapture(event.pointerId); } catch { /* Detached during window suspension. */ }
      if (tool === 'pen') drawStroke([point]);
    });
    canvas.addEventListener('pointermove', event => {
      if (!active || event.pointerId !== active.id || disabled) return;
      event.preventDefault();
      const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
      for (const sample of events.length ? events : [event]) {
        const point = position(sample); if (!point) continue;
        const previous = active.points[active.points.length - 1];
        if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) < .001) continue;
        if (active.points.length >= MAX_POINTS) break;
        active.points.push(point);
        if (active.tool === 'pen') drawStroke([previous, point]);
      }
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => canvas.addEventListener(type, event => {
      if (active?.id === event.pointerId) finish();
    }));
    render();
    return Object.freeze({
      snapshot: () => model.snapshot(),
      hasContent: () => model.hasContent() || Boolean(active?.points.length && active.tool === 'pen'),
      canUndo: () => model.history.length > 0,
      finish,
      replace(strokes) { active = null; model.replace(strokes); render(); },
      setDisabled(value) { if (value && active) finish(); disabled = Boolean(value); },
      setTool(value) { finish(); tool = value === 'eraser' ? 'eraser' : 'pen'; },
      undo() { finish(); if (!disabled && model.undo()) { render(); changed(); } },
      clear() { finish(); if (!disabled && model.clear()) { render(); changed(); } },
      toBlob() {
        finish();
        if (!model.hasContent()) return Promise.resolve(null);
        return new Promise((resolve, reject) => canvas.toBlob(blob => {
          if (!blob || blob.size > 2 * 1024 * 1024) reject(new Error('手写原稿暂时无法保存，请重试。'));
          else resolve(blob);
        }, 'image/jpeg', .92));
      }
    });
  }

  const api = Object.freeze({ InkModel, sanitize, create });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ICeClassIdeasInk = api;
})();

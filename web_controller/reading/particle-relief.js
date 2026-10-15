(() => {
  'use strict';
  // A small moving cloud hands settled points to a cached relief. There are no
  // shaders, full-screen bloom passes, or per-frame geometry/texture uploads.
  const SIZE = 768, SAMPLE = 144, TAU = Math.PI * 2;
  const models = new WeakMap();
  const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
  const canvas = (w, h = w) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  };
  function generator(seed) {
    return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  }
  function sprite(rgb) {
    const c = canvas(24), ctx = c.getContext('2d');
    const glow = ctx.createRadialGradient(12, 12, 0, 12, 12, 12);
    glow.addColorStop(0, `rgba(${rgb},1)`);
    glow.addColorStop(.18, `rgba(${rgb},.98)`);
    glow.addColorStop(.32, `rgba(${rgb},.38)`);
    glow.addColorStop(.65, `rgba(${rgb},.08)`);
    glow.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = glow; ctx.fillRect(0, 0, 24, 24);
    return c;
  }
  function landed(ctx, point, sprites) {
    const x = point.u * SIZE, y = point.v * SIZE, d = point.size;
    if (point.kind !== 2) {
      ctx.globalAlpha = .17;
      ctx.drawImage(sprites[0], x - d / 2 + 1.7, y - d / 2 + point.depth, d, d);
    }
    ctx.globalAlpha = point.light;
    ctx.drawImage(sprites[point.kind], x - d / 2, y - d / 2, d, d);
    // Fine mineral grains are baked only when a point lands, never animated.
    if (point.kind !== 2) {
      ctx.globalAlpha = point.light * .52;
      ctx.fillStyle = point.kind === 0 ? '#4b85b5' : '#b7d5e6';
      ctx.fillRect(x + point.grainX, y + point.grainY, .75, .75);
    }
    ctx.globalAlpha = 1;
  }
  function reliefSurface(image) {
    const result = canvas(SIZE), ctx = result.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, SIZE * .045, SIZE * .045, SIZE * .91, SIZE * .91);
    const data = ctx.getImageData(0, 0, SIZE, SIZE), source = new Uint8ClampedArray(data.data), random = generator(9031);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4, r = source[i], g = source[i + 1], b = source[i + 2];
      if (!source[i + 3]) continue;
      const red = r > 150 && r > g * 1.5 && r > b * 1.4;
      const blue = b > r * 1.45 && b > g * 1.15;
      const above = Math.max(0, i - SIZE * 4 - 4), below = Math.min(source.length - 4, i + SIZE * 4 + 4);
      const edge = clamp((source[above] - source[below]) / 140, -.8, .8);
      const grain = (random() - .5) * .13;
      const sheen = .57 + .22 * Math.sin((x + y * .45) / SIZE * 7) + edge * .25 + grain;
      const rgb = red ? [129, 59, 24] : blue ? [24, 67, 104] : [118, 147, 164];
      for (let c = 0; c < 3; c++) data.data[i + c] = rgb[c] * sheen;
      data.data[i + 3] = Math.round(source[i + 3] * (red ? 0 : blue ? .44 : .58));
    }
    ctx.putImageData(data, 0, 0); return result;
  }
  // A cached particle film keeps the original rising-stardust character.
  // Every visible flame mark is a separate glowing grain; there is no solid fill.
  function flameFilm() {
    const film = canvas(1600, 1440), ctx = film.getContext('2d');
    const colors = ['255,83,35', '255,161,53', '255,219,123', '255,243,194'];
    const grains = colors.map(sprite);
    const random = generator(817), dust = Array.from({ length: 680 }, (_, i) => ({
      seed: random(), x: (random() + random() - 1) * 39,
      height: 126 + random() * 40, twist: random() * TAU,
      size: 1.1 + Math.pow(random(), 2) * 2.3, bright: .65 + random() * .35,
      cycles: i % 7 === 0 ? 2 : 1
    }));
    for (let frame = 0; frame < 60; frame++) {
      ctx.save(); ctx.translate((frame % 10) * 160, Math.floor(frame / 10) * 240);
      // Only a restrained, local aura behind the separated particles.
      const aura = ctx.createRadialGradient(80, 159, 2, 80, 159, 62);
      aura.addColorStop(0, '#ff7d2015'); aura.addColorStop(.5, '#ff5e0c08'); aura.addColorStop(1, '#ff5e0c00');
      ctx.fillStyle = aura; ctx.fillRect(0, 0, 160, 240);
      for (const p of dust) {
        const life = (p.seed + frame / 60 * p.cycles) % 1;
        const taper = 1 - life * .73;
        const x = 80 + p.x * taper + Math.sin(life * 6.4 + p.twist) * (4 + life * 12);
        const y = 195 - life * p.height;
        const size = p.size * (1 - life * .34);
        const kind = life < .29 ? 0 : life < .64 ? 1 : p.seed > .84 ? 3 : 2;
        ctx.globalAlpha = Math.min(1, life * 15) * Math.pow(1 - life, .45) * p.bright;
        ctx.drawImage(grains[kind], x - size * 1.5, y - size * 1.5, size * 3, size * 3);
        ctx.fillStyle = 'rgb(' + colors[kind] + ')';
        ctx.fillRect(x - size * .28, y - size * .28, size * .56, size * .56);
        // A few longer embers describe upward motion without a heavy glow pass.
        if (p.seed > .94 && life > .48) {
          ctx.globalAlpha *= .23;
          ctx.drawImage(grains[kind], x - .55, y, 1.1, size * 2.1);
        }
      }
      ctx.restore();
    }
    for (const grain of grains) grain.width = grain.height = 1;
    return film;
  }
  function buildModel(image) {
    if (models.has(image)) return models.get(image);
    const sample = canvas(SAMPLE), ctx = sample.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE);
    const pixels = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
    const random = generator(6197), points = [];
    const sprites = ['61,137,218', '217,239,255', '255,159,65', '119,174,215'].map(sprite);
    for (let y = 0; y < SAMPLE; y++) for (let x = 0; x < SAMPLE; x++) {
      if (random() > .30) continue;
      const i = (y * SAMPLE + x) * 4;
      if (pixels[i + 3] < 110) continue;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const kind = r > 150 && r > g * 1.5 && r > b * 1.4 ? 2 : b > r * 1.45 && b > g * 1.15 ? 0 : Math.min(r, g, b) > 210 ? 1 : 3;
      const u = .045 + (x + .5) / SAMPLE * .91 + (random() - .5) * .004;
      const v = .045 + (y + .5) / SAMPLE * .91 + (random() - .5) * .004;
      const seed = random(), angle = random() * TAU, radius = Math.sqrt(random());
      const end = kind === 2 ? .96 + random() * .04 : .30 + (1 - v) * .65;
      points.push({ u, v, kind, seed,
        sx: .5 + Math.cos(angle) * radius * .47,
        sy: .47 + Math.sin(angle) * radius * .43,
        bendX: (random() - .5) * .55, bendY: (random() - .5) * .35,
        z: .65 + random() * .95, size: (kind === 1 ? 4.3 : kind === 2 ? 7 : kind === 3 ? 4 : 2.9) + Math.pow(random(), 3) * 7,
        light: .43 + random() * .57, grainX: (random() - .5) * 8, grainY: (random() - .5) * 8,
        depth: kind === 1 ? 4 : 2.2,
        start: kind === 2 ? .79 + seed * .03 : Math.max(0, end - .48), end
      });
    }
    points.sort((a, b) => a.end - b.end);
    const surface = reliefSurface(image), flame = flameFilm();
    const complete = canvas(SIZE), completeCtx = complete.getContext('2d');
    completeCtx.drawImage(surface, 0, 0);
    for (const point of points) landed(completeCtx, point, sprites);
    sample.width = sample.height = 1;
    const model = { points, sprites, complete, surface, flame };
    models.set(image, model); return model;
  }
  function wordLayer(text, sprites) {
    const mask = canvas(256, 112), ctx = mask.getContext('2d', { willReadFrequently: true });
    ctx.font = '700 82px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText(text, 128, 57);
    const pixels = ctx.getImageData(0, 0, 256, 112).data, result = canvas(256, 112), out = result.getContext('2d');
    const random = generator(471);
    for (let y = 2; y < 110; y += 2) for (let x = 2; x < 254; x += 2) {
      if (pixels[(y * 256 + x) * 4 + 3] < 125) continue;
      if (random() < .18) continue;
      const d = 1.8 + random() * 4.5;
      out.globalAlpha = .40 + random() * .55;
      out.drawImage(sprites[random() < .32 ? 0 : 1], x - d / 2 + random(), y - d / 2 + random(), d, d);
    }
    mask.width = mask.height = 1; return result;
  }
  window.createParticleRelief = (host, image, onFailure) => {
    const model = buildModel(image), reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const view = canvas(1), ctx = view.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('画布未能初始化，请重新打开页面。');
    view.setAttribute('aria-hidden', 'true'); host.replaceChildren(view);
    const formed = canvas(SIZE), formedCtx = formed.getContext('2d');
    const background = canvas(1), bg = background.getContext('2d', { alpha: false });
    const words = ['立志', '勤奋', '质朴', '文明'].map(text => wordLayer(text, model.sprites));
    let width = 1, height = 1, size = 1, left = 0, top = 0, footerY = 0;
    let progress = 0, energy = 0, landedCount = 0, completeAt = null;
    let frameId = null, previous = 0, nextPaint = 0, paused = false, disposed = false, dirty = true;
    let quality = 0, slowFrames = 0, paintCount = 0, paintTotal = 0, paintMax = 0;
    const tiers = [{ w: 1360, h: 900, name: 'balanced' }, { w: 1080, h: 720, name: 'light' }, { w: 800, h: 560, name: 'compact' }];
    host.dataset.renderer = 'canvas'; host.dataset.particles = String(model.points.length);
    host.dataset.settlement = 'reading';
    const starRandom = generator(593);
    const stars = Array.from({ length: 68 }, () => ({ x: starRandom(), y: starRandom(), a: .10 + starRandom() * .20, r: .5 + starRandom() }));
    function resize() {
      if (disposed) return;
      const bounds = host.getBoundingClientRect(), tier = tiers[quality];
      const w = Math.max(1, bounds.width || host.clientWidth || 800), h = Math.max(1, bounds.height || host.clientHeight || 600);
      const scale = Math.min(1, tier.w / w, tier.h / h);
      const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
      if (nw === width && nh === height) return;
      width = view.width = background.width = nw; height = view.height = background.height = nh;
      size = Math.min(height * .85, width * .84); left = (width - size) / 2; top = Math.max(height * .025, (height * .86 - size) / 2);
      footerY = Math.min(height * .88, top + size * .98);
      const gradient = bg.createRadialGradient(width * .5, height * .43, 0, width * .5, height * .43, Math.max(width, height) * .61);
      gradient.addColorStop(0, '#101e30'); gradient.addColorStop(.46, '#060e1a'); gradient.addColorStop(1, '#02050b');
      bg.fillStyle = gradient; bg.fillRect(0, 0, width, height);
      for (const star of stars) {
        bg.globalAlpha = star.a; bg.fillStyle = '#91b8eb'; bg.fillRect(star.x * width, star.y * height, star.r, star.r);
      }
      bg.globalAlpha = 1; host.dataset.quality = tier.name;
      paint(performance.now());
    }
    function updateFormed() {
      if (landedCount && model.points[landedCount - 1].end > progress) {
        formedCtx.clearRect(0, 0, SIZE, SIZE); landedCount = 0;
      }
      while (landedCount < model.points.length && model.points[landedCount].end <= progress) {
        landed(formedCtx, model.points[landedCount++], model.sprites);
      }
    }
    function celebration(now) {
      const age = reduced ? 3 : Math.max(0, (now - completeAt) / 1000), fade = clamp(age / 1.2);
      if (!reduced && age < 2.8) {
        ctx.globalAlpha = (1 - age / 2.8) * .38; ctx.strokeStyle = '#a1c9ff'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.ellipse(width / 2, top + size * .51, size * (.51 + age * .09), size * (.51 + age * .09), 0, 0, TAU); ctx.stroke();
      }
      const frame = reduced ? 17 : Math.floor(age * 30) % 60;
      ctx.globalAlpha = fade;
      ctx.drawImage(model.flame, (frame % 10) * 160, Math.floor(frame / 10) * 240, 160, 240, left + size * .394, top - size * .047, size * .212, size * .35);
      const flameX = left + size * .50, flameY = top + size * .155;
      for (let i = 0; i < (reduced ? 0 : 13); i++) {
        const life = (age * (.23 + (i % 4) * .033) + i * .618) % 1;
        const sway = Math.sin(i * 2.39 + age * .8) * size * (.014 + life * .008);
        const d = size * (.002 + (i % 3) * .0015);
        ctx.globalAlpha = Math.sin(life * Math.PI) * fade * .55;
        ctx.drawImage(model.sprites[2], flameX + sway - d / 2, flameY - life * size * .10 - d / 2, d, d);
      }
      const wordWidth = Math.min(size * .235, width * .213), wordHeight = wordWidth * 112 / 256;
      const gap = wordWidth * .08, total = wordWidth * 4 + gap * 3;
      for (let i = 0; i < words.length; i++) {
        const alpha = reduced ? 1 : clamp((age - .45 - i * .24) / 1.05);
        ctx.globalAlpha = alpha;
        ctx.drawImage(words[i], (width - total) / 2 + i * (wordWidth + gap), footerY + (1 - alpha) * 9, wordWidth, wordHeight);
      }
      ctx.globalAlpha = 1;
      if (age >= 2.6) host.dataset.settlement = 'complete';
    }
    function paint(now) {
      if (disposed) return;
      const start = performance.now();
      ctx.globalAlpha = 1; ctx.drawImage(background, 0, 0);
      updateFormed();
      // The metal surface appears only behind rows that have already arrived.
      // Its texture is rasterized once and stays perfectly still in silence.
      const surfaceTop = clamp((.95 - progress) / .65) * SIZE;
      if (surfaceTop < SIZE) ctx.drawImage(model.surface, 0, surfaceTop, SIZE, SIZE - surfaceTop, left, top + surfaceTop / SIZE * size, size, (SIZE - surfaceTop) / SIZE * size);
      ctx.drawImage(formed, left, top, size, size);
      const pointScale = size / SIZE;
      // Positions depend ONLY on earned progress: silence cannot keep gathering.
      for (let i = landedCount; i < model.points.length; i++) {
        const p = model.points[i], t = clamp((progress - p.start) / (p.end - p.start));
        const eased = 1 - (1 - t) * (1 - t), bend = reduced ? 0 : t * (1 - t);
        const tx = left + p.u * size, ty = top + p.v * size;
        const sx = p.sx * width, sy = p.sy * height;
        const x = sx + (tx - sx) * eased + p.bendX * size * bend;
        const y = sy + (ty - sy) * eased + p.bendY * size * bend;
        const d = p.size * pointScale * (p.z + (1 - p.z) * eased);
        ctx.globalAlpha = p.light * (.75 + eased * .25);
        ctx.drawImage(model.sprites[p.kind === 2 && t < .5 ? 0 : p.kind], x - d / 2, y - d / 2, d, d);
      }
      ctx.globalAlpha = 1;
      if (completeAt !== null) celebration(now);
      const duration = performance.now() - start;
      paintCount++; paintTotal += duration; paintMax = Math.max(paintMax, duration);
      if (duration > 24) slowFrames++; else slowFrames = Math.max(0, slowFrames - 1);
      if (slowFrames >= 18 && quality < tiers.length - 1) { quality++; slowFrames = 0; resize(); }
    }
    function schedule() {
      if (!disposed && !paused && !document.hidden && (dirty || (completeAt !== null && !reduced)) && frameId === null) frameId = requestAnimationFrame(frame);
    }
    function frame(now) {
      frameId = null;
      if (disposed || paused || document.hidden) return;
      if (now + .5 >= nextPaint) {
        const interval = 1000 / 30;
        if (previous && now - previous > 75 && energy > 0) slowFrames++;
        previous = now;
        nextPaint = nextPaint ? nextPaint + interval * Math.max(1, Math.floor((now - nextPaint) / interval) + 1) : now + interval;
        dirty = false;
        try { paint(now); } catch (error) { paused = true; onFailure?.(error); return; }
      }
      schedule();
    }
    function visibility() {
      cancelAnimationFrame(frameId); frameId = null; previous = nextPaint = 0; dirty = true;
      schedule();
    }
    const observer = new ResizeObserver(resize); observer.observe(host);
    document.addEventListener('visibilitychange', visibility);
    resize(); schedule();
    return {
      setProgress(value, sound = 0) {
        if (disposed) return;
        const next = clamp(Number.isFinite(value) ? value : 0);
        dirty = dirty || next !== progress; progress = next; energy = clamp(sound);
        if (progress < 1 && completeAt !== null) { completeAt = null; host.dataset.settlement = 'reading'; }
        if (paused) { paint(performance.now()); dirty = false; } else schedule();
      },
      setPaused(value) {
        paused = Boolean(value); cancelAnimationFrame(frameId); frameId = null; previous = nextPaint = 0; dirty = true;
        if (paused) paint(performance.now()); else schedule();
      },
      settle() {
        if (disposed) return;
        progress = 1; energy = 0; completeAt = performance.now(); paused = false; dirty = true;
        host.dataset.settlement = 'celebrating'; nextPaint = 0; schedule();
      },
      get isLost() { return false; },
      get stats() { return { renderer: 'canvas', particles: model.points.length, landed: landedCount, frames: paintCount, meanDrawMs: paintCount ? paintTotal / paintCount : 0, maxDrawMs: paintMax, width, height, quality: tiers[quality].name }; },
      dispose() {
        if (disposed) return;
        disposed = true; cancelAnimationFrame(frameId); frameId = null; observer.disconnect();
        document.removeEventListener('visibilitychange', visibility); view.remove();
        for (const c of [view, formed, background, ...words]) c.width = c.height = 1;
      }
    };
  };
  window.createParticlePreview = (view, image) => {
    const model = buildModel(image), ctx = view.getContext('2d');
    const words = ['立志', '勤奋', '质朴', '文明'].map(text => wordLayer(text, model.sprites));
    const starRandom = generator(593);
    const stars = Array.from({ length: 68 }, () => ({ x: starRandom(), y: starRandom(), a: .10 + starRandom() * .20, r: .5 + starRandom() }));
    let disposed = false;
    function draw() {
      if (disposed) return;
      const bounds = view.getBoundingClientRect();
      const w = bounds.width || 520, h = bounds.height || 470;
      const scale = Math.min(window.devicePixelRatio || 1, 2, 960 / w, 900 / h);
      view.width = Math.max(1, Math.round(w * scale));
      view.height = Math.max(1, Math.round(h * scale));
      ctx.clearRect(0, 0, view.width, view.height);
      for (const star of stars) {
        ctx.globalAlpha = star.a; ctx.fillStyle = '#91b8eb';
        ctx.fillRect(star.x * view.width, star.y * view.height, star.r * scale, star.r * scale);
      }
      ctx.globalAlpha = 1;
      const size = Math.min(view.width * .84, view.height * .84);
      const left = (view.width - size) / 2, top = view.height * .025;
      // Reuse the exact finished relief and particle flame from settlement.
      // No rectangular repainting and no continuous preview animation.
      ctx.drawImage(model.complete, left, top, size, size);
      const frame = 17;
      ctx.drawImage(model.flame, (frame % 10) * 160, Math.floor(frame / 10) * 240, 160, 240, left + size * .394, top - size * .047, size * .212, size * .35);
      const wordWidth = Math.min(size * .235, view.width * .213), wordHeight = wordWidth * 112 / 256;
      const gap = wordWidth * .08, total = wordWidth * 4 + gap * 3;
      const footerY = Math.min(view.height * .88, top + size * .98);
      for (let i = 0; i < words.length; i++) {
        ctx.drawImage(words[i], (view.width - total) / 2 + i * (wordWidth + gap), footerY, wordWidth, wordHeight);
      }
    }
    const observer = new ResizeObserver(draw); observer.observe(view); draw();
    return { dispose() {
      if (disposed) return;
      disposed = true; observer.disconnect(); view.width = view.height = 1;
      for (const word of words) word.width = word.height = 1;
    } };
  };
})();

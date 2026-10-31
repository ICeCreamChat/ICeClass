/* Authored hand/eyelid frames react to focus only; field values are never read. */
(() => {
  'use strict';
  const page = document.getElementById('authPage');
  const mascot = document.getElementById('authMascot');
  const canvas = document.getElementById('authMascotCanvas');
  const password = document.getElementById('loginPassword');
  const toggle = document.getElementById('loginPasswordToggle');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const context = canvas.getContext('2d');
  const atlas = new Image();
  const poses = { open: 0, cover: 50, peek: 79 };
  const columns = 8;
  const width = canvas.width;
  const height = canvas.height;
  let ready = false;
  let position = 0;
  let target = 0;
  let drawn = -1;
  let animation = null;

  function paint() {
    if (!ready) return;
    const frame = Math.round(position);
    if (frame === drawn) return;
    context.clearRect(0, 0, width, height);
    context.drawImage(atlas, frame % columns * width, Math.floor(frame / columns) * height,
      width, height, 0, 0, width, height);
    drawn = frame;
  }

  function stop() {
    if (animation !== null) cancelAnimationFrame(animation);
    animation = null;
  }

  function settle() {
    stop();
    position = target;
    paint();
  }

  function setPose(state) {
    const next = poses[state];
    mascot.dataset.state = state;
    if (next === target) return;
    target = next;
    stop();
    if (!ready || reducedMotion.matches || document.hidden || page.classList.contains('hidden')) {
      settle();
      return;
    }

    // Retarget from the frame already on screen, including mid-gesture reversals.
    const from = position;
    const duration = Math.max(220, Math.abs(target - from) * (target > from ? 16.8 : 14.4));
    const started = performance.now();
    function step(now) {
      const progress = Math.min(1, (now - started) / duration);
      // Brief acceleration/deceleration leaves most drawings at a steady pace.
      // A full smoothstep rushes through the middle of this short drawn sequence.
      const ramp = .15;
      const eased = progress < ramp ? progress * progress / (2 * ramp * (1 - ramp))
        : progress > 1 - ramp ? 1 - (1 - progress) ** 2 / (2 * ramp * (1 - ramp))
        : (progress - ramp / 2) / (1 - ramp);
      position = from + (target - from) * eased;
      paint();
      animation = progress < 1 ? requestAnimationFrame(step) : null;
    }
    animation = requestAnimationFrame(step);
  }

  function sync() {
    const active = document.activeElement;
    const secret = page.contains(active) && active.matches('input[type=password]');
    const loginSecret = active === password || active === toggle;
    setPose(loginSecret ? (password.type === 'password' ? 'cover' : 'peek') : secret ? 'cover' : 'open');
  }
  page.addEventListener('focusin', sync);
  // Focus can move between the password field and its visibility control.
  page.addEventListener('focusout', () => queueMicrotask(sync));
  toggle.addEventListener('click', sync);
  reducedMotion.addEventListener('change', settle);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) settle();
    else sync();
  });

  if (context) {
    atlas.decoding = 'async';
    atlas.addEventListener('load', () => {
      ready = true;
      settle();
      mascot.classList.add('is-ready');
    }, { once: true });
    atlas.src = canvas.dataset.sprite;
  }
  sync();
})();

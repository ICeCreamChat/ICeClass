/* Six authored poses react to focus only; field values are never read. */
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
  const poses = { open: 0, cover: 3, peek: 4 };
  const routes = {
    open: [[], [0], [1, 0], [2, 1, 0], [5, 0], [0]],
    cover: [[1, 2, 3], [2, 3], [3], [], [3], [1, 2, 3]],
    peek: [[1, 2, 3, 4], [2, 3, 4], [3, 4], [4], [], [1, 2, 3, 4]],
  };
  const columns = 3;
  const width = canvas.width;
  const height = canvas.height;
  let ready = false;
  let target = 0;
  let drawn = -1;
  let animation = null;

  function paint(frame) {
    if (!ready) return;
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
    paint(target);
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

    // Retarget from the visible drawing. Leaving a peek lowers the hands directly.
    const route = routes[state][drawn];
    if (!route.length) return;
    const spacing = state === 'open' ? 110 : 145;
    const started = performance.now();
    function step(now) {
      if (document.hidden || page.classList.contains('hidden')) {
        settle();
        return;
      }
      // Short anticipation, then deliberate key poses; no synthesized in-between art.
      const elapsed = now - started - 70;
      if (elapsed < 0) {
        animation = requestAnimationFrame(step);
        return;
      }
      const index = Math.min(route.length - 1, Math.floor(elapsed / spacing));
      paint(route[index]);
      animation = index < route.length - 1 ? requestAnimationFrame(step) : null;
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

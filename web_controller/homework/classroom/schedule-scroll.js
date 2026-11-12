(() => {
  'use strict';
  const viewport = document.querySelector('.schedule-scroll');
  if (!viewport) return;
  const content = viewport.firstElementChild;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, positioned = false, manual = false, targetKey = '', drag = null;

  function followLesson() {
    frame = 0;
    if (!viewport.clientWidth) { manual = false; positioned = false; return; }
    const scrollable = viewport.scrollWidth > viewport.clientWidth + 1;
    viewport.classList.toggle('is-scrollable', scrollable);
    viewport.tabIndex = scrollable ? 0 : -1;
    if (!scrollable) manual = false;
    const lessons = content.querySelectorAll('.day-lesson');
    const target = content.querySelector('[aria-current="true"]') || content.querySelector('[data-next]') || lessons[lessons.length - 1];
    if (!target) { viewport.scrollLeft = 0; positioned = false; targetKey = ''; return; }
    const key = `${target.querySelector('time').dateTime}|${target.textContent}|${target.hasAttribute('aria-current')}|${target.hasAttribute('data-next')}`;
    if (key !== targetKey) { targetKey = key; manual = false; }
    if (drag || manual) return;
    const bounds = viewport.getBoundingClientRect(), lesson = target.getBoundingClientRect();
    const left = viewport.scrollLeft + lesson.left - bounds.left - Math.max(0, (viewport.clientWidth - lesson.width) / 2);
    viewport.scrollTo({ left: Math.max(0, Math.min(left, viewport.scrollWidth - viewport.clientWidth)), behavior: positioned && !reducedMotion.matches ? 'smooth' : 'instant' });
    positioned = true;
  }
  function queueFollow() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(followLesson);
  }
  function stopMotion() {
    viewport.scrollTo({ left: viewport.scrollLeft, behavior: 'instant' });
  }
  viewport.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || !viewport.classList.contains('is-scrollable')) return;
    stopMotion();
    if (event.pointerType !== 'mouse') { manual = true; return; }
    drag = { id: event.pointerId, x: event.clientX, left: viewport.scrollLeft };
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const delta = event.clientX - drag.x;
    if (!manual && Math.abs(delta) < 4) return;
    manual = true;
    viewport.classList.add('is-dragging');
    viewport.scrollLeft = drag.left - delta;
    event.preventDefault();
  });
  function endDrag(event) {
    if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.id)) return;
    const id = drag.id;
    drag = null;
    viewport.classList.remove('is-dragging');
    if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
    queueFollow();
  }
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
  viewport.addEventListener('lostpointercapture', endDrag);
  window.addEventListener('blur', endDrag);
  viewport.addEventListener('dragstart', event => event.preventDefault());
  viewport.addEventListener('wheel', event => {
    if (event.deltaX || (event.shiftKey && event.deltaY)) { manual = true; stopMotion(); }
  }, { passive: true });
  viewport.addEventListener('keydown', event => {
    if (event.target !== viewport || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const step = viewport.clientWidth * .75;
    const left = { ArrowLeft: viewport.scrollLeft - step, ArrowRight: viewport.scrollLeft + step, Home: 0, End: viewport.scrollWidth }[event.key];
    if (left === undefined) return;
    event.preventDefault();
    manual = true;
    viewport.scrollTo({ left, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  });
  const resize = new ResizeObserver(queueFollow);
  resize.observe(viewport);
  resize.observe(content);
  new MutationObserver(queueFollow).observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-current', 'data-next'] });
  document.fonts.ready.then(queueFollow);
})();

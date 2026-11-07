'use strict';
(() => {
  const teacher = document.body.classList.contains('teacher-liquid');
  if (!teacher && !document.querySelector('.ideas-app,.reading-liquid,.glass') && !window.ICeClassVoiceHost?.classroomAccount) return;
  // Shared optics. The lens is a separate, non-interactive background;
  // handwriting, video, text and focus indicators never enter the filter.
  const ns = 'http://www.w3.org/2000/svg';
  const classroomSelectors = [
    '.glass', '[data-classroom-pane]',
    '.ideas-app .ideas-topbar', '.ideas-app .ideas-tabs', '.ideas-app .ideas-form',
    '.ideas-app .ideas-item', '.ideas-app .ideas-list-notice', '.ideas-app dialog',
    '.ideas-app .ideas-detail-panel', '.ideas-app .ideas-camera-panel',
    '.ideas-paper-dialog',
    '.reading-liquid .mode-choice', '.reading-liquid .poem-library',
    '.reading-liquid .poem-preparation', '.reading-liquid .particle-preparation-panel',
    '.reading-liquid .carving-sidebar', '.reading-liquid .particle-sidebar',
    '.reading-liquid .classic-toolbar', '.reading-liquid dialog',
    '.reading-liquid .quiet-button', '.reading-liquid .primary-button',
    '.reading-liquid .choice-action', '.reading-game #big-start-btn',
    '.reading-game .dash-btn', '.reading-liquid #reading-session-status',
    '.reading-liquid #reading-touch-hint', '.reading-liquid #reading-hold-feedback',
    '.reading-liquid .reading-calendar', '.reading-liquid .reading-calendar-panel',
    '.reading-liquid .control-panel', '.reading-liquid .settings-panel',
    '.reading-liquid .modal-content', '.reading-liquid .welcome-card',
    '.reading-liquid .result-panel', '.reading-liquid #dashboard',
    '.bb-native-voice-page .bb-header', '.bb-native-voice-page .bb-compose',
    '.bb-native-voice-page .bb-settings', '.bb-native-voice-page .bb-session-popover',
    '.bb-native-voice-page .bb-confirm-dialog', '.bb-native-voice-page .bb-task-panel'
  ].join(',');
  const teacherSelectors = [
    '.topbar', '.teacher-header-menu', '.auth-card', '.reading-filter', '.metric', '.reading-panel',
    '.reading-settings', '.daily-details', '.control-actions', '.compose', '.plain-section',
    '.classroom-voice-item', '.schedule-item', '.island-main', '.island-day-panel',
    '.island-delivery-panel', '.island-preview-time-panel', '.action-menu-content',
    '.ideas-list-panel', '.ideas-detail', '.hw-scope', '.hw-section',
    '.users-panel', '.user-actions-popover',
    '#acknowledgementsPanel', '#acknowledgementsPreview', 'dialog', '.toast', '.btn',
    '.bb-panel', '.bb-settings', '.bb-options', '.bb-scope-editor',
    '.bb-session-popover', '.bb-task-panel', '.bb-confirm-dialog', '.bb-history',
    '.bb-history-delete-dialog', '.bb-send'
  ].map(selector => `.teacher-liquid ${selector}`).join(',');
  const selectors = teacher ? teacherSelectors : classroomSelectors;
  const entries = new Map();
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true'); svg.classList.add('classroom-filter-definitions');
  const defs = document.createElementNS(ns, 'defs'); svg.append(defs);
  document.body.append(svg);
  let sequence = 0;
  // A teacher workbench keeps many pages in the DOM. Only visible surfaces own
  // displacement maps; leaving the viewport releases them. No animation loop.
  const visibility = teacher ? new IntersectionObserver(changes => {
    for (const change of changes) {
      const entry = entries.get(change.target);
      if (!entry) continue;
      entry.visible = change.isIntersecting;
      if (entry.visible) {
        const rect = change.target.getBoundingClientRect();
        update(change.target, rect.width, rect.height);
      } else release(entry, change.target);
    }
  }, {rootMargin:'80px'}) : null;
  const observer = new ResizeObserver(changes => {
    for (const change of changes) {
      const box = change.borderBoxSize?.[0];
      update(change.target, box?.inlineSize || change.contentRect.width, box?.blockSize || change.contentRect.height);
    }
  });
  function attach(element) {
    if (entries.has(element) || element.closest('.classroom-filter-definitions')) return;
    if (teacher && element.matches('.btn') && element.closest(
      '.period-shortcuts,.ranking-switch,.mode-picker,.hw-tabs,.hw-group,.island-tabs,.island-duty-mode,.action-menu-content,.dialog-head,.island-duty-weeks')) return;
    const existing = element.querySelector(':scope > .glass-lens');
    const lens = teacher ? null : existing || document.createElement('span');
    if (!existing || teacher) {
      element.classList.add('lg-pane');
      if (teacher) element.classList.add('lg-pseudo');
      else { lens.classList.add('lg-lens'); lens.setAttribute('aria-hidden', 'true'); }
      // Retain fixed/absolute/sticky positioning used by dialogs and toolbars.
      if (getComputedStyle(element).position === 'static') element.classList.add('lg-relative');
      if (lens) element.prepend(lens);
    }
    const entry = {map:null, filter:null, lens, width:0, height:0, visible:!teacher};
    entries.set(element, entry); observer.observe(element);
    if (visibility) visibility.observe(element);
  }
  function allocate(entry, element) {
    const filter = document.createElementNS(ns, 'filter');
    const id = `classroom-optics-${++sequence}`; filter.id = id;
    for (const [key, value] of Object.entries({x:'0%',y:'0%',width:'100%',height:'100%','color-interpolation-filters':'sRGB'})) filter.setAttribute(key, value);
    const map = document.createElementNS(ns, 'feImage');
    for (const [key, value] of Object.entries({result:'edgeMap',preserveAspectRatio:'none',x:'0',y:'0',width:'100%',height:'100%'})) map.setAttribute(key, value);
    const blur = document.createElementNS(ns, 'feGaussianBlur');
    blur.setAttribute('in', 'SourceGraphic'); blur.setAttribute('stdDeviation', '1.1'); blur.setAttribute('result', 'softBackdrop');
    const displacement = document.createElementNS(ns, 'feDisplacementMap');
    for (const [key, value] of Object.entries({in:'softBackdrop',in2:'edgeMap',xChannelSelector:'R',yChannelSelector:'G',scale:'24'})) displacement.setAttribute(key, value);
    filter.append(map, blur, displacement); defs.append(filter);
    const effect = `url(#${id}) saturate(1.16)`;
    if (teacher) element.style.setProperty('--lg-filter', effect);
    else {
      entry.lens.style.backdropFilter = effect;
      entry.lens.style.webkitBackdropFilter = effect;
    }
    entry.map = map; entry.filter = filter;
  }
  function release(entry, element) {
    entry.filter?.remove(); entry.filter = entry.map = null;
    entry.width = entry.height = 0;
    element.style.removeProperty('--lg-filter');
  }
  function update(element, width, height) {
    const entry = entries.get(element);
    if (!entry || !entry.visible || width < 1 || height < 1 || (Math.abs(entry.width-width)<1 && Math.abs(entry.height-height)<1)) return;
    if (!entry.filter) allocate(entry, element);
    entry.width = width; entry.height = height;
    const ratio = Math.min(1, 760/width, 560/height);
    const w = Math.max(1, Math.round(width*ratio)), h = Math.max(1, Math.round(height*ratio));
    const radius = Math.min(parseFloat(getComputedStyle(element).borderTopLeftRadius)*ratio || 0, h/2, w/2);
    const band = Math.max(.1, Math.min(17*ratio, h*.4));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const context = canvas.getContext('2d');
    if (!context) return;
    const data = context.createImageData(w,h);
    for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
      const px=x+.5-w/2, py=y+.5-h/2;
      const qx=Math.abs(px)-(w/2-radius), qy=Math.abs(py)-(h/2-radius);
      const ox=Math.max(qx,0), oy=Math.max(qy,0), length=Math.hypot(ox,oy);
      const distance=-(length+Math.min(Math.max(qx,qy),0)-radius);
      const nx=length>0 ? ox/length*Math.sign(px) : qx>qy ? Math.sign(px) : 0;
      const ny=length>0 ? oy/length*Math.sign(py) : qx>qy ? 0 : Math.sign(py);
      const edge=Math.pow(Math.max(0,1-Math.max(0,distance)/band),2), i=(y*w+x)*4;
      data.data[i]=128-nx*edge*112; data.data[i+1]=128-ny*edge*112;
      data.data[i+2]=128; data.data[i+3]=255;
    }
    context.putImageData(data,0,0); entry.map.setAttribute('href',canvas.toDataURL('image/png'));
  }
  function scan(root) {
    if (root instanceof Element && root.matches(selectors)) attach(root);
    root.querySelectorAll?.(selectors).forEach(attach);
  }
  scan(document);
  document.addEventListener('DOMContentLoaded', () => scan(document), {once:true});
  new MutationObserver(changes => {
    for (const change of changes) {
      // Action labels are replaced with textContent during pause, resume and retry.
      // Keep their existing optical layer without allocating another filter.
      const entry = entries.get(change.target);
      if (entry?.lens && change.target.isConnected && entry.lens.parentElement !== change.target) change.target.prepend(entry.lens);
      for (const node of change.addedNodes) if (node instanceof Element) scan(node);
    }
    for (const [element, entry] of entries) if (!element.isConnected) {
      observer.unobserve(element); visibility?.unobserve(element);
      entry.filter?.remove(); entries.delete(element);
    }
  }).observe(document.body, {childList:true, subtree:true});
})();

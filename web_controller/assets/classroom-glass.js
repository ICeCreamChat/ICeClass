'use strict';
(() => {
  const teacher = document.body.classList.contains('teacher-liquid');
  if (!teacher && !document.querySelector('.ideas-app,.reading-liquid,.glass') && !window.ICeClassVoiceHost?.classroomAccount) return;
  // Static material only: no maps, capture, filters or per-pane resize observers.
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
    '.topbar', '.teacher-header-menu', '.auth-card',
    '.island-preview-time-panel', '.action-menu-content', '.user-actions-popover',
    '.toast', '.bb-options', '.bb-session-popover'
  ].map(selector => `.teacher-liquid ${selector}`).join(',');
  const selectors = teacher ? teacherSelectors : classroomSelectors;
  if (!teacher) document.body.classList.add('classroom-light-material');
  function decorate(root) {
    const nodes = [...(root instanceof Element && root.matches(selectors) ? [root] : []),
      ...root.querySelectorAll(selectors)];
    for (const element of nodes) {
      if (element.matches('.glass,.lg-pane')) continue;
      element.classList.add('lg-pane');
      if (teacher) {
        element.classList.add('lg-pseudo');
        if (getComputedStyle(element).position === 'static') element.classList.add('lg-relative');
      }
    }
  }
  decorate(document);
  new MutationObserver(changes => {
    for (const change of changes) for (const node of change.addedNodes)
      if (node instanceof Element && node.isConnected) decorate(node);
  }).observe(document.body, {childList:true, subtree:true});
})();

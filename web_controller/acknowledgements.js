(() => {
  'use strict';
  const ui = window.ICeClassUI, draftLabel = '致谢';
  const byId = id => document.getElementById(id);
  const api = (...args) => window.ICeClass.api(...args);
  const fields = byId('acknowledgementsFields');
  const preview = byId('acknowledgementsPreview');
  const save = byId('acknowledgementsSave');
  let owner = '', generation = 0, saved = null, draft = [], busy = false, conflict = false;
  const allowed = () => window.ICeClass?.state.user?.role === 'superadmin'
    && !window.ICeClass.state.user.classroom && window.ICeClassVoiceHost?.classroomAccount !== true;
  const identity = () => allowed() ? window.ICeClass.state.user.id + ':' + window.ICeClass.state.csrf : '';
  const dirty = () => saved && JSON.stringify(draft) !== JSON.stringify(saved.sections);
  function status(message, error = false) {
    const node = byId('acknowledgementsStatus');
    node.textContent = message; node.setAttribute('role', error ? 'alert' : 'status'); node.classList.toggle('danger-text', error);
  }
  function node(tag, text, className = '') {
    const result = document.createElement(tag); result.textContent = text; result.className = className; return result;
  }
  function controls() {
    byId('acknowledgementsForm').setAttribute('aria-busy', String(busy));
    fields.querySelectorAll('input,textarea,button').forEach(input => { input.disabled = busy || !allowed(); });
    draft.forEach((_, index) => {
      const row = fields.children[index]; if (!row) return;
      row.querySelector('[data-move="-1"]').disabled ||= index === 0;
      row.querySelector('[data-move="1"]').disabled ||= index === draft.length - 1;
      row.querySelector('[data-remove]').disabled ||= draft.length === 1;
    });
    byId('acknowledgementsAdd').disabled = busy || !saved || draft.length >= 8 || !allowed();
    byId('acknowledgementsReload').disabled = busy || !allowed();
    save.disabled = busy || !allowed() || conflict || !dirty(); save.textContent = busy ? '处理中…' : '保存并同步';
  }
  function updatePreview() {
    preview.replaceChildren();
    for (const group of draft) {
      const section = document.createElement('section');
      section.append(node('h4', group.title.trim() || '未填写标题'));
      if (group.body.trim()) section.append(node('p', group.body));
      preview.append(section);
    }
    controls();
  }
  function render() {
    fields.replaceChildren();
    draft.forEach((group, index) => {
      const fieldset = node('fieldset', '', 'thanks-group');
      const title = `第 ${index + 1} 组`;
      const head = node('div', '', 'thanks-group-head');
      const caption = node('span', title, 'thanks-group-number'); caption.setAttribute('aria-hidden', 'true');
      const actions = node('div', '', 'group-tools');
      head.append(caption, actions); fieldset.append(node('legend', title, 'sr-only'), head);
      for (const [key, label, tag, limit] of [['title', '分组标题', 'input', 80], ['body', '正文', 'textarea', 4000]]) {
        const field = node('div', '', 'field'), caption = node('label', label), input = document.createElement(tag);
        input.id = `acknowledgements-${key}-${index}`; caption.htmlFor = input.id;
        input.name = `section-${index}-${key}`; input.maxLength = limit; input.required = true; input.value = group[key];
        input.autocomplete = 'off';
        if (tag === 'textarea') input.rows = 3;
        else input.type = 'text';
        input.addEventListener('input', () => { group[key] = input.value; updatePreview(); status(conflict ? '内容已在其他页面修改，请重新载入后核对。' : '尚未保存。', conflict); });
        field.append(caption, input); fieldset.append(field);
      }
      for (const [text, delta] of [['上移', -1], ['下移', 1]]) {
        const button = node('button', text, 'button quiet'); button.type = 'button'; button.dataset.move = String(delta);
        button.setAttribute('aria-label', `${text}第 ${index + 1} 组`);
        button.addEventListener('click', () => {
          if (busy || !allowed()) return;
          const next = index + delta; if (next < 0 || next >= draft.length) return;
          [draft[index], draft[next]] = [draft[next], draft[index]]; render();
          fields.children[next].querySelector('input').focus(); status('顺序已调整，尚未保存。');
        }); actions.append(button);
      }
      const remove = node('button', '移除分组', 'button quiet remove-group'); remove.type = 'button'; remove.dataset.remove = '';
      remove.setAttribute('aria-label', `移除第 ${index + 1} 组`);
      remove.addEventListener('click', () => {
        if (busy || !allowed() || draft.length <= 1) return;
        draft.splice(index, 1); render(); fields.children[Math.min(index, draft.length - 1)].querySelector('input').focus(); status('分组已移除，尚未保存。');
      }); actions.append(remove); fields.append(fieldset);
    });
    updatePreview();
  }
  function adopt(value) { saved = value; draft = value.sections.map(section => ({...section})); conflict = false; render(); }
  async function load() {
    if (busy || !allowed()) return;
    const current = ++generation, account = identity(); busy = true; controls(); status('正在载入致谢…');
    try {
      const value = await api('/api/about/acknowledgements', { cache: 'no-store' });
      if (current !== generation || identity() !== account) return;
      adopt(value); status('');
    } catch (error) {
      if (current === generation && identity() === account) status(error instanceof TypeError ? '连接失败，请检查网络后重新载入。' : error.message, true);
    } finally { if (current === generation && identity() === account) { busy = false; controls(); } }
  }
  byId('acknowledgementsForm').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !allowed() || !dirty() || conflict) return;
    const current = ++generation, account = identity(); busy = true; controls(); status('正在保存致谢…');
    try {
      const value = await api('/api/about/acknowledgements', { method: 'PUT', body: JSON.stringify({ revision: saved.revision, sections: draft }) });
      if (current !== generation || identity() !== account) return;
      adopt(value); status('已保存。新版客户端下次打开“关于”时更新。');
    } catch (error) {
      if (current !== generation || identity() !== account) return;
      conflict = error.status === 409;
      status(error instanceof TypeError ? '保存失败，编辑内容已保留。请检查网络后重试。' : error.message, true);
    } finally { if (current === generation && identity() === account) { busy = false; controls(); } }
  });
  byId('acknowledgementsAdd').addEventListener('click', () => {
    if (busy || !allowed() || !saved || draft.length >= 8) return;
    draft.push({ title: '', body: '' }); render(); fields.lastElementChild.querySelector('input').focus(); status('新分组尚未保存。');
  });
  byId('acknowledgementsReload').addEventListener('click', async () => {
    if (!await ui.confirmLeave('重新载入致谢', {only:draftLabel})) return;
    void load();
  });
  window.addEventListener('iceclass-settings-section', event => { if (event.detail === 'thanks' && !saved) void load(); });
  function init() {
    const account = identity(); byId('acknowledgementsSection').classList.toggle('hidden', !account);
    if (account !== owner) { generation++; owner = account; saved = null; draft = []; busy = conflict = false; render(); status(''); }
    if (account && window.ICeClassSettings?.visible && window.ICeClassSettings.section === 'thanks' && !saved) void load();
  }
  ui.registerDraft(draftLabel, () => ({dirty:allowed() && dirty(), busy:allowed() && busy}));
  window.addEventListener('iceclass-logout', () => { generation++; owner = ''; saved = null; draft = []; busy = conflict = false; render(); });
  window.addEventListener('iceclass-ready', init); init();
})();

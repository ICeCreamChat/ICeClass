(() => {
  'use strict';
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
      section.append(node('h4', group.title || '分组标题'), node('p', group.body || '致谢正文')); preview.append(section);
    }
    controls();
  }
  function render() {
    fields.replaceChildren();
    draft.forEach((group, index) => {
      const fieldset = node('fieldset', '', 'thanks-group');
      fieldset.append(node('legend', `第 ${index + 1} 组`));
      for (const [key, label, tag, limit] of [['title', '分组标题', 'input', 80], ['body', '正文', 'textarea', 4000]]) {
        const field = node('div', '', 'field'), caption = node('label', label), input = document.createElement(tag);
        input.id = `acknowledgements-${key}-${index}`; caption.htmlFor = input.id;
        input.name = `section-${index}-${key}`; input.maxLength = limit; input.required = true; input.value = group[key];
        input.autocomplete = 'off';
        if (tag === 'textarea') input.rows = 4;
        else input.type = 'text';
        input.addEventListener('input', () => { group[key] = input.value; updatePreview(); status(conflict ? '内容已在其他页面修改，请重新载入后核对。' : '尚未保存。', conflict); });
        field.append(caption, input); fieldset.append(field);
      }
      const actions = node('div', '', 'group-tools');
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
      const remove = node('button', '移除分组', 'button quiet danger'); remove.type = 'button'; remove.dataset.remove = '';
      remove.setAttribute('aria-label', `移除第 ${index + 1} 组`);
      remove.addEventListener('click', () => {
        if (busy || !allowed() || draft.length <= 1) return;
        draft.splice(index, 1); render(); fields.children[Math.min(index, draft.length - 1)].querySelector('input').focus(); status('分组已移除，尚未保存。');
      }); actions.append(remove); fieldset.append(actions); fields.append(fieldset);
    });
    updatePreview();
  }
  function adopt(value) { saved = value; draft = structuredClone(value.sections); conflict = false; render(); }
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
  byId('acknowledgementsReload').addEventListener('click', () => {
    if (dirty() && !window.confirm('重新载入会放弃当前尚未保存的致谢修改，继续吗？')) return;
    void load();
  });
  window.addEventListener('iceclass-settings-section', event => { if (event.detail === 'thanks' && !saved) void load(); });
  function init() {
    const account = identity(); byId('acknowledgementsSection').classList.toggle('hidden', !account);
    if (account !== owner) { generation++; owner = account; saved = null; draft = []; busy = conflict = false; render(); status(''); }
    if (account && window.ICeClassSettings?.visible && window.ICeClassSettings.section === 'thanks' && !saved) void load();
  }
  window.ICeClassAcknowledgements = { discardChanges() {
    if (saved) { draft = structuredClone(saved.sections); render(); }
  }, canLogout() {
    if (!allowed()) return true;
    if (busy) { window.ICeClass.toast('正在载入或保存致谢，请稍候。'); return false; }
    if (dirty() && !window.confirm('致谢修改尚未保存，放弃修改并退出登录吗？')) return false;
    return true;
  } };
  window.addEventListener('beforeunload', event => { if (allowed() && (dirty() || busy)) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('iceclass-ready', init); init();
})();

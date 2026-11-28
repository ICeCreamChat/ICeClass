(() => {
  'use strict';
  const $ = id => document.getElementById(id), params = new URLSearchParams(location.search);
  if (params.has('issued')) {
    document.querySelector('.print-toolbar').remove();
    $('feedback').textContent = '请在教师工作台的本次发放表中打印纸卡。';
    window.printIssuedCards = async batch => {
      $('cards').innerHTML = batch.map(window.CardQuizPrintCard.render).join('');
      await Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode())]);
      if (window.frameElement?.isConnected) window.print();
    };
    window.addEventListener('afterprint', () => window.frameElement?.remove(), {once:true});
    window.addEventListener('pagehide', () => $('cards').replaceChildren());
    return;
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let roster, selected = [], csrf = '', busy = false, prepared = false, lifecycle = 0;
  const classId = params.get('classId');
  const endpoint = '/api/card-quiz/classes/' + encodeURIComponent(classId || '') + '/students';
  function feedback(text, error = false) {
    $('feedback').textContent = text;
    $('feedback').classList.toggle('error', error);
    $('feedback').setAttribute('role', error ? 'alert' : 'status');
  }
  function controls() {
    $('reload').disabled = busy;
    $('prepare').disabled = busy || !roster?.canEdit || !selected.length || prepared;
    $('print').disabled = busy || !roster?.canEdit || !prepared;
    $('clear').hidden = !prepared;
  }
  function clear() { prepared = false; $('cards').replaceChildren(); controls(); }
  async function request(path, method = 'GET', body) {
    const controller = method === 'GET' ? new AbortController() : null;
    const timer = controller && setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, {
        method, credentials:'same-origin', cache:'no-store', signal:controller?.signal,
        headers:method === 'GET' ? {} : {'Content-Type':'application/json','X-CSRF-Token':csrf},
        ...(body ? {body:JSON.stringify(body)} : {})
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.error || `请求失败 (${response.status})`);
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      if (controller) clearTimeout(timer);
    }
  }
  async function load() {
    if (busy) return;
    const current = ++lifecycle;
    clear(); roster = undefined; selected = []; busy = true; controls();
    $('metadata').replaceChildren();
    feedback('正在核对教师权限与学生账号…');
    try {
      if (!classId) throw new Error('请从教师工作台选择班级后打开打印页。');
      const number = params.has('card') ? Number(params.get('card')) : null;
      if (number !== null && (!Number.isInteger(number) || number < 1 || number > 157)) throw new Error('补印卡号必须为 1-157 的整数。');
      const auth = await request('/api/session');
      if (current !== lifecycle) return;
      if (!auth.authenticated) throw new Error('请先在同一浏览器登录教师工作台，再重新载入名单。');
      csrf = auth.user.csrfToken;
      roster = await request(endpoint);
      if (current !== lifecycle) { roster = undefined; return; }
      const rows = roster.students.filter(s => s.cardNumber != null && (number === null || s.cardNumber === number));
      selected = rows.filter(s => s.accountId && s.activeHere);
      $('metadata').innerHTML = `<h2>${esc(roster.className)}</h2><div class="table-wrap" tabindex="0" role="region" aria-label="卡号与账号"><table><thead><tr><th scope="col">卡号</th><th scope="col">编号（学生账号）</th><th scope="col">状态</th></tr></thead><tbody>${rows.map(s => `<tr><td>${s.cardNumber}</td><td>${esc(s.username || (roster.canEdit ? '尚未生成' : '仅管理员可查看'))}</td><td>${!roster.canEdit ? '只读' : s.accountId && s.activeHere ? '待准备' : '请在教师工作台生成或关联账号'}</td></tr>`).join('') || '<tr><td colspan="3">没有已分配卡号的学生</td></tr>'}</tbody></table></div>`;
      feedback(!roster.canEdit ? '当前为只读权限，可查看卡号信息；只有名单管理员可以查看账号、代印或重置密码。' :
        !selected.length ? '没有可代印的已关联账号。请先在教师工作台保存卡号并生成或关联学生账号。' :
        `可准备 ${selected.length} 张纸卡。点击“重置密码并准备打印”后才会更改密码。${rows.length > selected.length ? '未关联账号的卡号不会打印。' : ''}`);
    } catch (error) {
      if (current !== lifecycle) return;
      roster = undefined;
      feedback(error.name === 'AbortError' ? '读取超时，请检查连接后重新载入名单。' : error.message, true);
    } finally { if (current === lifecycle) { busy = false; controls(); } }
  }
  $('prepare').onclick = () => {
    if (busy || !roster?.canEdit || !selected.length || prepared) return;
    $('reset-description').textContent = `将为 ${selected.length} 个学生账号生成新六位密码，旧密码和旧学生会话立即失效。新密码仅在本页本次显示，请及时打印并发放。`;
    $('reset-confirm').showModal();
  };
  document.querySelectorAll('#cancel-reset, [data-close-reset]').forEach(button => {
    button.onclick = () => $('reset-confirm').close();
  });
  $('confirm-reset').onclick = async () => {
    $('reset-confirm').close();
    if (busy || !roster?.canEdit || prepared) return;
    const current = lifecycle;
    busy = true; controls(); feedback('正在重置所选账号密码，请稍候…');
    try {
      const data = await request(endpoint + '/reset', 'POST', {
        revision:roster.revision, rosterRevision:roster.rosterRevision, cardRevision:roster.cardRevision,
        studentIds:selected.map(s => s.studentId)
      });
      if (current !== lifecycle) return;
      const ids = new Set(selected.map(s => s.studentId));
      const credentials = (data.credentials || []).filter(c => ids.has(c.studentId) && c.classId === classId);
      if (credentials.length !== selected.length) throw new Error('返回的纸卡信息不完整，请重新载入名单核对后再准备。');
      $('cards').innerHTML = credentials.map(window.CardQuizPrintCard.render).join('');
      roster = {...data}; delete roster.credentials; prepared = true;
      feedback(`已重置并准备 ${credentials.length} 张纸卡，旧密码已失效。每张纸卡均含新密码，请及时打印。`);
    } catch (error) {
      if (current !== lifecycle) return;
      clear(); roster = undefined;
      feedback(error.status === 409 ? error.message + ' 请重新载入名单核对版本，再明确重置。' :
        error.status === 403 ? error.message + ' 请由名单管理员操作。' : error.message + ' 请重新载入名单核对；不会自动重试重置操作。', true);
      $('feedback').focus();
    } finally { if (current === lifecycle) { busy = false; controls(); } }
  };
  $('print').onclick = () => { if (!busy && prepared && roster?.canEdit) window.print(); };
  $('clear').onclick = () => { clear(); feedback('本次密码已从页面清除。再次代印需要明确重置密码。'); };
  $('reload').onclick = load;
  window.addEventListener('pagehide', () => { lifecycle++; roster = undefined; csrf = ''; selected = []; busy = false; clear(); $('reset-confirm').close(); });
  window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
  void load();
})();

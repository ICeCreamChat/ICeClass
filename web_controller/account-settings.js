(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const root = $('view-settings');
  const panes = {account:'settingsAccountSection', appearance:'teacherAppearance', quota:'banbanQuotaSection',
    devices:'deviceSection', thanks:'acknowledgementsSection', logs:'clientDiagnosticsSection'};
  const api = (...args) => window.ICeClass.api(...args);
  const manager = () => ['superadmin','principal','director','grade_leader'].includes(window.ICeClass?.state.user?.role);
  const administrator = () => window.ICeClass?.state.user?.role === 'superadmin'
    && !window.ICeClass.state.user.classroom && window.ICeClassVoiceHost?.classroomAccount !== true;
  const allowed = section => section === 'devices' ? manager() : ['quota','thanks','logs'].includes(section) ? administrator() : true;
  let selected = 'account', devicePage = 0, devicesBusy = false, deviceReturnFocus = null;
  const devicePageSize = 20;
  function node(tag, text, className = '') {
    const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
  }
  function button(text, callback, className = 'button') {
    const element = node('button', text, className); element.type = 'button'; element.addEventListener('click', callback); return element;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class','icon'); svg.setAttribute('aria-hidden','true');
    const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', '#settings-i-' + name); svg.append(use); return svg;
  }
  function selectSection(section, {updateUrl = false} = {}) {
    selected = Object.hasOwn(panes, section) && allowed(section) ? section : 'account';
    for (const [name, id] of Object.entries(panes)) $(id).hidden = name !== selected || !allowed(name);
    root.querySelectorAll('[data-section]').forEach(link => {
      link.hidden = !allowed(link.dataset.section);
      if (link.dataset.section === selected) link.setAttribute('aria-current','page');
      else link.removeAttribute('aria-current');
    });
    for (const option of $('sectionSelect').options) { option.hidden = option.disabled = !allowed(option.value); }
    $('sectionSelect').value = selected;
    root.querySelector('.nav-divider').hidden = !manager() && !administrator();
    root.querySelectorAll('.device-actions details').forEach(menu => { menu.open = false; });
    if (updateUrl) history.replaceState(null, '', '#settings/' + selected);
    if (!root.classList.contains('hidden')) window.dispatchEvent(new CustomEvent('iceclass-settings-section', {detail:selected}));
  }
  function activate() {
    const section = location.hash.match(/^#settings\/([a-z]+)$/)?.[1];
    selectSection(section || selected, {updateUrl:true});
  }
  root.querySelector('.section-nav').addEventListener('click', event => {
    const link = event.target.closest('[data-section]'); if (!link) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault(); selectSection(link.dataset.section, {updateUrl:true});
  });
  $('sectionSelect').addEventListener('change', event => selectSection(event.target.value, {updateUrl:true}));
  window.addEventListener('hashchange', () => {
    if (!location.hash.startsWith('#settings/')) return;
    if (root.classList.contains('hidden')) document.querySelector('#mainNav [data-view=settings]').click();
    else activate();
  });
  root.querySelectorAll('[data-eye]').forEach(toggle => toggle.addEventListener('click', () => {
    const input = $(toggle.dataset.eye), visible = input.type === 'password';
    input.type = visible ? 'text' : 'password'; toggle.setAttribute('aria-pressed', String(visible));
    toggle.setAttribute('aria-label', `${visible ? '隐藏' : '显示'}${input.labels[0].textContent}`);
  }));
  $('ownPasswordForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, submit = form.querySelector('button[type=submit]');
    if (submit.disabled) return;
    $('ownPasswordError').textContent = ''; $('passwordStatus').textContent = '';
    form.querySelectorAll('[aria-invalid]').forEach(field => field.removeAttribute('aria-invalid'));
    const invalid = (id, message) => {
      const input = $(id); input.setAttribute('aria-invalid','true'); input.setAttribute('aria-errormessage','ownPasswordError');
      $('ownPasswordError').textContent = message; input.focus();
    };
    if (!$('currentPassword').value) return invalid('currentPassword','请输入当前密码。');
    const password = $('ownNewPassword').value;
    if (password.length < 10 || password.length > 128 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password))
      return invalid('ownNewPassword','新密码需为 10-128 位，同时包含字母和数字。');
    if (password !== $('ownNewPasswordConfirm').value) return invalid('ownNewPasswordConfirm','两次输入的新密码不一致，请重新核对。');
    if (window.ICeClassBanbanQuota?.canLogout() === false || window.ICeClassAcknowledgements?.canLogout() === false) return;
    submit.disabled = true; submit.textContent = '正在更新…'; form.setAttribute('aria-busy','true');
    try {
      await api('/api/auth/password', {method:'PUT',body:JSON.stringify({currentPassword:$('currentPassword').value,newPassword:password})});
      window.ICeClassAcknowledgements?.discardChanges(); window.ICeClassBanbanQuota?.discardChanges();
      location.reload();
    } catch (error) { $('ownPasswordError').textContent = error instanceof TypeError ? '更新失败，请检查连接后重试。' : error.message; }
    finally { submit.disabled = false; submit.textContent = '更新密码'; form.removeAttribute('aria-busy'); }
  });
  $('ownPasswordForm').addEventListener('input', event => { event.target.removeAttribute('aria-invalid'); });

  const confirmDialog = document.createElement('dialog');
  confirmDialog.id = 'settingsDeviceConfirm'; confirmDialog.setAttribute('aria-labelledby','settingsDeviceConfirmTitle');
  confirmDialog.innerHTML = '<form><div class="dialog-head"><h2 id="settingsDeviceConfirmTitle">停用设备</h2><button class="btn icon" type="button" data-close aria-label="关闭">×</button></div><div class="dialog-body"><p id="settingsDeviceConfirmText"></p><p class="form-error" role="alert"></p></div><div class="dialog-actions"><button class="btn" type="button" data-close>取消</button><button class="btn danger" type="submit">停用设备</button></div></form>';
  document.body.append(confirmDialog);
  let disablingDevice = null;
  const pager = node('div','','pagination'); pager.id = 'devicePager';
  const pageLabel = node('span',''), previous = button('上一页', () => { devicePage--; renderDevices(); }), next = button('下一页', () => { devicePage++; renderDevices(); });
  pager.append(pageLabel, previous, next); $('devicesContainer').after(pager);
  function deviceStatus(message, error = false) {
    $('deviceStatus').textContent = message; $('deviceStatus').setAttribute('role', error ? 'alert' : 'status');
  }
  function setDevicesBusy(busy) {
    devicesBusy = busy; $('refreshDevices').disabled = busy;
    if (busy) $('deviceSection').setAttribute('aria-busy','true');
    else $('deviceSection').removeAttribute('aria-busy');
    $('devicesContainer').querySelectorAll('button').forEach(control => { control.disabled = busy; });
    $('devicesContainer').querySelectorAll('summary').forEach(control => { control.setAttribute('aria-disabled',String(busy)); });
  }
  function rememberDevice(id, action) { deviceReturnFocus = {id, action}; }
  function returnDeviceFocus(value = deviceReturnFocus) {
    if (!value || $('deviceSection').hidden) return;
    const row = [...$('devicesContainer').children].find(item => item.dataset.deviceId === value.id);
    (row?.querySelector(`[data-device-action="${value.action}"]`) || $('deviceSearch')).focus({preventScroll:true});
  }
  for (const id of ['deviceBindingDialog','deleteEntityDialog']) $(id)?.addEventListener('close', () => {
    returnDeviceFocus(); deviceReturnFocus = null;
  });
  confirmDialog.addEventListener('close', () => { returnDeviceFocus(); deviceReturnFocus = null; disablingDevice = null; });
  async function setDeviceEnabled(device, enabled) {
    if (devicesBusy || !manager()) return;
    setDevicesBusy(true);
    const submit = confirmDialog.querySelector('button[type=submit]'); submit.disabled = true;
    confirmDialog.setAttribute('aria-busy','true');
    confirmDialog.querySelectorAll('[data-close]').forEach(control => { control.disabled = true; });
    try {
      await api('/api/devices/' + encodeURIComponent(device.id), {method:'PATCH', body:JSON.stringify({enabled})});
      if (confirmDialog.open) confirmDialog.close();
      device.enabled = enabled ? 1 : 0; if (!enabled) device.online = false; renderDevices();
      const message = enabled ? '设备已重新启用。' : '设备已停用并断开。';
      try { await window.ICeClass.loadDevices(); deviceStatus(message); }
      catch (error) { deviceStatus(message + '列表刷新失败，请点击刷新重新读取。',true); }
    } catch (error) {
      const message = error instanceof TypeError ? '操作失败，请检查连接后重试。' : error.message;
      if (confirmDialog.open) confirmDialog.querySelector('[role=alert]').textContent = message;
      else deviceStatus(message,true);
    } finally {
      setDevicesBusy(false); submit.disabled = false;
      confirmDialog.removeAttribute('aria-busy'); confirmDialog.querySelectorAll('[data-close]').forEach(control => { control.disabled = false; });
    }
  }
  confirmDialog.addEventListener('cancel', event => { if (devicesBusy) event.preventDefault(); });
  confirmDialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault(); if (disablingDevice) void setDeviceEnabled(disablingDevice,false);
  });
  function renderDevices(devices = window.ICeClass?.state.devices || []) {
    if (!manager()) return;
    const container = $('devicesContainer'), active = document.activeElement;
    const activeRow = active?.closest('[data-device-id]');
    const focus = activeRow && {id:activeRow.dataset.deviceId, action:active.dataset.deviceAction};
    const query = $('deviceSearch').value.trim().toLocaleLowerCase(), filter = $('deviceFilter').value;
    const filtered = devices.filter(device => {
      const connection = Number(device.enabled) !== 1 ? 'disabled' : device.online ? 'online' : 'offline';
      return (filter === 'all' || filter === connection) && `${device.name} ${device.class_name} ${device.computer_name || ''} ${device.device_code || ''} ${device.binding_note || ''} ${(device.local_addresses || []).join(' ')}`.toLocaleLowerCase().includes(query);
    });
    devicePage = Math.max(0, Math.min(devicePage, Math.ceil(filtered.length / devicePageSize) - 1));
    $('deviceCount').textContent = `${filtered.length} 台设备`;
    root.querySelector('.device-table-head').hidden = !filtered.length;
    const fragment = document.createDocumentFragment();
    for (const device of filtered.slice(devicePage * devicePageSize, (devicePage + 1) * devicePageSize)) {
      const row = node('li','','device-overview'); row.dataset.deviceId = device.id;
      const identity = node('div','','device-copy'); identity.append(node('strong',device.class_name));
      identity.append(node('span',device.verified_at ? '已核实' : '待核实', 'badge ' + (device.verified_at ? 'success' : 'warning')));
      if (device.class_device_count > 1) identity.append(node('span',`同班 ${device.class_device_count} 台，请核对`,'badge warning'));
      identity.append(node('p',[device.name,device.computer_name || '等待电脑名称'].join(' · ')),node('p',[device.device_code,device.binding_note].filter(Boolean).join(' · ')));
      identity.append(node('p',(device.local_addresses || []).join('、') || '尚未上报局域网地址','device-lan'));
      const status = node('div','','device-status');
      const enabled = Number(device.enabled) === 1;
      status.append(node('span',!enabled ? '已停用' : device.online ? '在线' : '离线', 'badge ' + (!enabled ? 'danger' : device.online ? 'success' : 'neutral')));
      const footer = node('div','','device-row-footer'), seen = node('div',device.last_seen_at ? new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(device.last_seen_at)).replaceAll('/','-') : '从未连接','device-seen');
      const actions = node('div','','device-actions');
      const bind = button('核实 / 改绑', () => { rememberDevice(device.id,'bind'); window.ICeClassAdmin.openDevice(device); },'button quiet small-button');
      bind.dataset.deviceAction = 'bind'; bind.setAttribute('aria-label',`核实或改绑${device.name}`);
      const details = node('details','','action-menu');
      const summary = node('summary','更多','button quiet small-button'); summary.dataset.deviceAction = 'more';
      summary.addEventListener('click', event => { if (devicesBusy) event.preventDefault(); });
      summary.setAttribute('aria-label',`${device.name}的更多操作`); summary.append(icon('down'));
      const menu = node('div','','more-menu action-menu-content');
      menu.append(button(enabled ? '停用设备' : '重新启用', () => {
        rememberDevice(device.id,'more');
        if (devicesBusy) return;
        if (!enabled) { void setDeviceEnabled(device,true); return; }
        disablingDevice = device; $('settingsDeviceConfirmText').textContent = `停用“${device.name}”后，设备会立即断开，无法接收新通知。`;
        confirmDialog.querySelector('[role=alert]').textContent = ''; confirmDialog.showModal();
      },'button quiet'));
      menu.append(button('删除设备', () => { rememberDevice(device.id,'more'); window.ICeClassAdmin.openDelete('device',device.id,device.name); },'button quiet danger'));
      details.append(summary,menu); actions.append(bind,details); footer.append(seen,actions); row.append(identity,status,footer); fragment.append(row);
    }
    if (!filtered.length) fragment.append(node('li',devices.length ? '没有匹配的设备，请调整搜索或筛选。' : '尚未绑定教室电脑。','empty-state'));
    container.replaceChildren(fragment);
    setDevicesBusy(devicesBusy);
    pager.hidden = filtered.length <= devicePageSize;
    previous.disabled = devicePage === 0; next.disabled = (devicePage + 1) * devicePageSize >= filtered.length;
    pageLabel.textContent = `${devicePage * devicePageSize + 1}-${Math.min(filtered.length,(devicePage + 1) * devicePageSize)} / ${filtered.length}`;
    if (focus) returnDeviceFocus(focus);
  }
  for (const id of ['deviceSearch','deviceFilter']) $(id).addEventListener(id === 'deviceSearch' ? 'input' : 'change', () => { devicePage = 0; renderDevices(); });
  $('refreshDevices').addEventListener('click', async () => {
    if (devicesBusy || !manager()) return;
    setDevicesBusy(true); deviceStatus('正在刷新…');
    try { await window.ICeClass.loadDevices(); deviceStatus('设备列表已更新。'); }
    catch (error) { deviceStatus('刷新失败，已保留上次列表。' + error.message,true); }
    finally { setDevicesBusy(false); }
  });
  function init() {
    const user = window.ICeClass?.state.user; if (!user) return;
    $('settingsAccount').textContent = user.displayName; $('settingsUsername').textContent = user.username;
    $('settingsRole').textContent = $('userRole').textContent; $('settingsAvatar').textContent = $('userAvatar').textContent;
    selectSection(selected);
    if (location.hash.startsWith('#settings/')) document.querySelector('#mainNav [data-view=settings]').click();
  }
  window.ICeClassSettings = {activate, select:section => selectSection(section,{updateUrl:true}), renderDevices,
    get section() { return selected; }, get visible() { return !root.classList.contains('hidden'); }};
  window.addEventListener('iceclass-ready', init); init();
  window.dispatchEvent(new Event('iceclass-settings-ready'));
})();

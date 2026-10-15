(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = (...args) => window.ICeClass.api(...args);
  const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const format = value => new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
  let target = null;
  const host = document.createElement('div');
  host.innerHTML = `
    <dialog id="deleteEntityDialog" aria-labelledby="deleteEntityTitle"><form id="deleteEntityForm">
      <div class="dialog-head"><h2 id="deleteEntityTitle">确认删除</h2><button class="btn icon" type="button" data-close aria-label="关闭">×</button></div>
      <div class="dialog-body"><div class="confirm-summary"><strong id="deleteEntityName"></strong><p id="deleteEntityDescription"></p></div>
        <div class="field"><label for="deleteEntityConfirm">输入完整名称以确认</label><input id="deleteEntityConfirm" required autocomplete="off"></div><p id="deleteEntityError" class="form-error" role="alert"></p></div>
      <div class="dialog-actions"><button class="btn" type="button" data-close>取消</button><button class="btn danger" type="submit">确认删除</button></div>
    </form></dialog>
    <dialog id="cleanupDialog" aria-labelledby="cleanupTitle"><form id="cleanupForm">
      <div class="dialog-head"><h2 id="cleanupTitle">清理班级记录</h2><button class="btn icon" type="button" data-close aria-label="关闭">×</button></div>
      <div class="dialog-body"><p id="cleanupClassName"></p><div class="field"><label for="cleanupKind">需要清理的内容</label><select id="cleanupKind"><option value="reading">早读统计与完成量</option><option value="history">通知历史与关联语音</option><option value="voice">学生语音留言</option></select></div>
        <div class="options-row"><div class="field"><label for="cleanupStart">开始日期</label><input id="cleanupStart" type="date" required></div><div class="field"><label for="cleanupEnd">结束日期</label><input id="cleanupEnd" type="date" required></div></div>
        <label class="check-item"><input id="cleanupAllDates" type="checkbox">清理全部日期的所选记录</label><p class="reading-note">清理后无法撤回。班级、用户和设备绑定会保留；之后产生的活动会继续记录。</p>
        <div class="field"><label for="cleanupConfirm">输入完整班级名称以确认</label><input id="cleanupConfirm" required autocomplete="off"></div><p id="cleanupError" class="form-error" role="alert"></p></div>
      <div class="dialog-actions"><button class="btn" type="button" data-close>取消</button><button class="btn danger" type="submit">确认清理</button></div>
    </form></dialog>
    <dialog id="schoolEnrollmentDialog" aria-labelledby="schoolEnrollmentTitle"><form id="schoolEnrollmentForm">
      <div class="dialog-head"><h2 id="schoolEnrollmentTitle">全校快捷绑定</h2><button class="btn icon" type="button" data-close aria-label="关闭">×</button></div>
      <div class="dialog-body"><p class="reading-note">一个绑定码供各教室使用。在新版教室端输入绑定码，选择自己的班级即可，无需逐班生成。</p><p id="schoolEnrollmentStatus" class="reading-rule-status" role="status">正在读取…</p>
        <div class="field"><label for="schoolEnrollmentCode">设置全校绑定码</label><input id="schoolEnrollmentCode" autocomplete="off" minlength="5" maxlength="40" placeholder="填写自定义码，留空则随机生成"><p class="hint">5 至 40 位英文字母或数字，不区分大小写。保存后原全校码失效，已绑定设备不受影响。</p></div>
        <div class="field"><label for="schoolEnrollmentDays">开放绑定的有效期</label><select id="schoolEnrollmentDays"><option value="1">1 天</option><option value="7">7 天</option><option value="30" selected>30 天</option><option value="90">90 天</option></select></div>
        <div id="schoolEnrollmentResult" class="hidden"><div id="schoolEnrollmentShownCode" class="code-box"></div><p class="hint">请记下并仅提供给需要绑定的教室。关闭后无法再查看完整绑定码。</p></div><p id="schoolEnrollmentError" class="form-error" role="alert"></p></div>
      <div class="dialog-actions"><button id="schoolEnrollmentClose" class="btn danger" type="button">关闭快捷绑定</button><button class="btn primary" type="submit">保存并开放绑定</button></div>
    </form></dialog>
    <dialog id="deviceBindingDialog" aria-labelledby="deviceBindingTitle"><form id="deviceBindingForm">
      <div class="dialog-head"><h2 id="deviceBindingTitle">核实电脑与班级归属</h2><button class="btn icon" type="button" data-close aria-label="关闭">×</button></div>
      <div class="dialog-body"><div id="deviceIdentity" class="confirm-summary device-detail"></div>
        <p class="reading-note">将编号和电脑名称与教室端首页或教室设置中的信息核对。两台电脑可以同属一个班；选错班级的电脑可以在这里修正。</p>
        <div class="field"><label for="deviceBindingName">设备备注名称</label><input id="deviceBindingName" required maxlength="80" placeholder="例如：A 栋 201 教室白板"></div>
        <div class="field"><label for="deviceBindingClass">这台电脑所属班级</label><select id="deviceBindingClass" required></select></div>
        <div class="field"><label for="deviceBindingNote">实际位置 / 管理备注</label><input id="deviceBindingNote" maxlength="120" placeholder="例如：A 栋二楼东侧，固定白板"></div>
        <label class="check-item"><input id="deviceBindingVerified" type="checkbox">我已核实这台电脑与所选班级的对应关系</label>
        <p class="hint">改绑后，新的通知和早读归到新班级；之前的成绩与通知记录仍保留在原班级。在线教室端会自动重连，离线设备下次上线同步。</p>
        <p id="deviceBindingError" class="form-error" role="alert"></p></div>
      <div class="dialog-actions"><button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit">保存归属</button></div>
    </form></dialog>
    <dialog id="classRolloverDialog" class="wide-dialog" aria-labelledby="classRolloverTitle"><form id="classRolloverForm">
      <div class="dialog-head"><h2 id="classRolloverTitle">年度升班</h2><button class="btn icon" type="button" data-close aria-label="关闭">×</button></div>
      <div class="dialog-body"><p class="reading-note">勾选要更新的班级，检查新的名称后一起保存。班级编号、设备绑定、教师授权和历史记录会保留。多个年级可以同时更新。</p>
        <div class="options-row"><div class="field"><label for="graduatingYear">毕业届别年份</label><input id="graduatingYear" type="number" min="2000" max="2100" required></div><button id="classRolloverPreset" class="btn" type="button">预填高中升班</button></div>
        <p class="hint">预填会将高一升高二、高二升高三、高三更名为所填年份的毕业班。毕业班仍保留绑定；换教室时请在设备管理中改绑。</p>
        <div id="classRolloverRows" class="rollover-rows"></div><p id="classRolloverError" class="form-error" role="alert"></p></div>
      <div class="dialog-actions"><button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit">保存选中班级的新名称</button></div>
    </form></dialog>`;
  document.body.append(host);
  function openDelete(kind, id, name) {
    target = {kind, id, name};
    const titles = {class:'删除班级',user:'删除用户账号',device:'删除教室设备'};
    const descriptions = {class:'该班的设备绑定、班级授权、早读成绩、通知历史和学生留言将一并删除，无法撤回。',user:'该账号将退出所有登录并失去权限。历史通知的发送人和操作记录会保留；删除后可以重新创建同名账号。',device:'设备将立即断开且不能重新连接。班级早读成绩和通知历史保留；再次使用需要重新绑定。'};
    $('deleteEntityTitle').textContent = titles[kind]; $('deleteEntityName').textContent = name; $('deleteEntityDescription').textContent = descriptions[kind];
    $('deleteEntityConfirm').value = ''; $('deleteEntityError').textContent = ''; $('deleteEntityDialog').showModal();
  }
  function openCleanup(item) {
    target = {id:item.id,name:item.name}; $('cleanupClassName').textContent = item.name;
    $('cleanupForm').reset(); $('cleanupStart').disabled = $('cleanupEnd').disabled = false; $('cleanupStart').value = $('cleanupEnd').value = today(); $('cleanupError').textContent = ''; $('cleanupDialog').showModal();
  }
  $('deleteEntityForm').onsubmit = async event => {
    event.preventDefault(); if ($('deleteEntityConfirm').value !== target.name) return $('deleteEntityError').textContent = '名称不一致，请输入上方完整名称。';
    const button = event.submitter; button.disabled = true;
    try {
      const paths = {class:'classes',user:'teachers',device:'devices'};
      await api(`/api/${paths[target.kind]}/${encodeURIComponent(target.id)}`, {method:'DELETE',body:JSON.stringify({confirmName:target.name})});
      $('deleteEntityDialog').close(); window.ICeClass.toast('已删除'); await window.ICeClass.refreshManagement();
    } catch (e) { $('deleteEntityError').textContent = e.message; } finally {button.disabled = false;}
  };
  $('cleanupAllDates').onchange = () => {
    $('cleanupStart').disabled = $('cleanupEnd').disabled = $('cleanupAllDates').checked;
  };
  $('cleanupForm').onsubmit = async event => {
    event.preventDefault(); if ($('cleanupConfirm').value !== target.name) return $('cleanupError').textContent = '班级名称不一致，请准确输入。';
    const button = event.submitter; button.disabled = true;
    try {
      await api(`/api/classes/${encodeURIComponent(target.id)}/records`, {method:'DELETE',body:JSON.stringify({confirmName:target.name,kind:$('cleanupKind').value,start:$('cleanupStart').value,end:$('cleanupEnd').value,allDates:$('cleanupAllDates').checked})});
      $('cleanupDialog').close(); window.ICeClass.toast('所选记录已清理'); await window.ICeClass.refreshManagement();
    } catch (e) { $('cleanupError').textContent = e.message; } finally {button.disabled = false;}
  };
  function schoolStatus(data) {
    $('schoolEnrollmentStatus').textContent = data.enabled ? `快捷绑定已开放 · 有效至 ${format(data.expiresAt)}（北京时间）` : '快捷绑定已关闭或已过期';
    $('schoolEnrollmentStatus').dataset.enabled = String(data.enabled); $('schoolEnrollmentClose').disabled = !data.enabled;
  }
  $('schoolEnrollmentButton').onclick = async () => {
    $('schoolEnrollmentForm').reset(); $('schoolEnrollmentError').textContent = ''; $('schoolEnrollmentResult').classList.add('hidden');
    $('schoolEnrollmentDialog').showModal();
    try {schoolStatus(await api('/api/enrollment/school-code'));} catch(e) {$('schoolEnrollmentError').textContent = e.message;}
  };
  $('schoolEnrollmentForm').onsubmit = async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; $('schoolEnrollmentError').textContent = '';
    try {
      const data = await api('/api/enrollment/school-code', {method:'POST',body:JSON.stringify({code:$('schoolEnrollmentCode').value,validDays:Number($('schoolEnrollmentDays').value)})});
      schoolStatus(data); $('schoolEnrollmentShownCode').textContent = data.code; $('schoolEnrollmentResult').classList.remove('hidden'); $('schoolEnrollmentCode').value = ''; window.ICeClass.toast('全校快捷绑定已开放');
    } catch(e) {$('schoolEnrollmentError').textContent = e.message;} finally {button.disabled = false;}
  };
  $('schoolEnrollmentClose').onclick = async () => {
    try {await api('/api/enrollment/school-code',{method:'DELETE'}); schoolStatus({enabled:false}); $('schoolEnrollmentResult').classList.add('hidden'); window.ICeClass.toast('快捷绑定已关闭，已绑定设备继续使用');}
    catch(e) {$('schoolEnrollmentError').textContent = e.message;}
  };
  let deviceTarget = null;
  function openDevice(device) {
    deviceTarget = device; $('deviceBindingForm').reset(); $('deviceBindingError').textContent = '';
    const identity = $('deviceIdentity'); identity.replaceChildren();
    for (const [tag,text] of [['strong',device.device_code],['span','电脑名称：'+(device.computer_name || '尚未上报')],['span','局域网：'+((device.local_addresses || []).join('、') || '尚未上报')],['span',device.os_version || '等待新版教室端上报系统信息'],['span','完整设备编号：'+device.id]]) {
      const item=document.createElement(tag);item.textContent=text;identity.append(item);
    }
    $('deviceBindingName').value=device.name; $('deviceBindingNote').value=device.binding_note || ''; $('deviceBindingVerified').checked=!!device.verified_at;
    $('deviceBindingClass').replaceChildren();
    window.ICeClass.state.classes.filter(c=>Number(c.enabled)===1 || c.id===device.class_id).forEach(c=>$('deviceBindingClass').append(new Option(c.name+(Number(c.enabled)!==1?'（已停用）':''),c.id)));
    $('deviceBindingClass').value=device.class_id; $('deviceBindingDialog').showModal();
  }
  $('deviceBindingClass').onchange=()=>{$('deviceBindingVerified').checked=false;};
  $('deviceBindingForm').onsubmit=async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;$('deviceBindingError').textContent='';
    try {
      await api('/api/devices/'+encodeURIComponent(deviceTarget.id),{method:'PATCH',body:JSON.stringify({name:$('deviceBindingName').value,classId:$('deviceBindingClass').value,note:$('deviceBindingNote').value,verified:$('deviceBindingVerified').checked})});
      $('deviceBindingDialog').close();await window.ICeClass.refreshManagement();window.ICeClass.toast('电脑归属已保存，教室端上线后自动同步');
    } catch(e) {$('deviceBindingError').textContent=e.message;} finally {button.disabled=false;}
  };
  $('classRolloverButton').onclick=()=>{
    $('classRolloverError').textContent='';$('graduatingYear').value=new Date().getFullYear();
    const table=document.createElement('table'),head=table.createTHead().insertRow();
    ['更新','当前名称','新的班级名称'].forEach(text=>{const th=document.createElement('th');th.textContent=text;head.append(th);});
    const body=table.createTBody();
    window.ICeClass.state.classes.forEach(c=>{
      const row=body.insertRow();row.dataset.classId=c.id;row.dataset.name=c.name;
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.setAttribute('aria-label','更新'+c.name);row.insertCell().append(checkbox);
      row.insertCell().textContent=c.name;
      const input=document.createElement('input');input.value=c.name;input.maxLength=40;input.setAttribute('aria-label',c.name+'的新名称');input.oninput=()=>{checkbox.checked=input.value.trim()!==c.name;};row.insertCell().append(input);
    });
    $('classRolloverRows').replaceChildren(table);$('classRolloverDialog').showModal();
  };
  $('classRolloverPreset').onclick=()=>{
    const year=Number($('graduatingYear').value);if(!Number.isInteger(year)||year<2000||year>2100)return $('classRolloverError').textContent='请填写有效的毕业届别年份。';
    $('classRolloverError').textContent='';
    $('classRolloverRows').querySelectorAll('tbody tr').forEach(row=>{
      const match=row.dataset.name.match(/^高([一二三])（(\d+)）班$/);if(!match)return;
      row.querySelector('input[type=checkbox]').checked=true;
      row.querySelector('input:not([type=checkbox])').value=match[1]==='三'?`${year}届毕业（${match[2]}）班`:`高${match[1]==='一'?'二':'三'}（${match[2]}）班`;
    });
  };
  $('classRolloverForm').onsubmit=async event=>{
    event.preventDefault();const button=event.submitter;button.disabled=true;$('classRolloverError').textContent='';
    const changes=[...$('classRolloverRows').querySelectorAll('tbody tr')].filter(row=>row.querySelector('input[type=checkbox]').checked).map(row=>({id:row.dataset.classId,name:row.querySelector('input:not([type=checkbox])').value.trim()}));
    try {
      if(!changes.length)throw new Error('请先选择需要更新的班级。');
      const data=await api('/api/classes/rename-batch',{method:'POST',body:JSON.stringify({changes})});
      $('classRolloverDialog').close();await window.ICeClass.refreshManagement();window.ICeClass.toast(`已更新 ${data.updated} 个班级，原绑定和记录已保留`);
    } catch(e) {$('classRolloverError').textContent=e.message;} finally {button.disabled=false;}
  };
  window.ICeClassAdmin = {openDelete, openCleanup, openDevice};
})();

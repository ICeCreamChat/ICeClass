import { readJson, reportPhoneStep, inWeChat, browserOpenHint } from '/assets/shared.js';
const $ = id => document.getElementById(id);
let working = false;
let phoneUrl = null;
async function connect() {
  if (working) return;
  working = true; $('retryConnect').hidden = true;
  $('openCamera').hidden = true;
  phoneUrl = null;
  reportPhoneStep('entry');
  $('connectTitle').textContent = '正在连接展台…';
  $('connectMessage').textContent = '连接成功后，出现摄像头提示请点“允许”。';
  try {
    const info = await readJson('/api/connect-info' + location.search);
    phoneUrl = info.phoneUrl;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(info.verifyUrl, { method: 'POST', signal: controller.signal, cache: 'no-store' });
      if (!response.ok || !(await response.json()).ready) throw new Error('连接尚未完成');
    } finally { clearTimeout(timeout); }
    location.replace(info.phoneUrl);
  } catch {
    reportPhoneStep('connect-error');
    $('connectTitle').textContent = phoneUrl ? '已连到展台，请打开摄像头' : '电脑连接暂时不可用';
    $('connectMessage').textContent = phoneUrl ? '请点下方“打开摄像头”，出现权限提示时点“允许”。如果仍不能打开，请查看电脑上的连接提示。' + (inWeChat() ? browserOpenHint() : '')
      : '请确认电脑展台仍在运行，手机保持连接展台 Wi-Fi，再扫描电脑当前显示的第 2 张码。';
    $('openCamera').hidden = !phoneUrl;
    $('retryConnect').hidden = false;
  } finally { working = false; }
}
$('retryConnect').onclick = connect;
$('openCamera').onclick = () => { if (phoneUrl) location.assign(phoneUrl); };
connect();

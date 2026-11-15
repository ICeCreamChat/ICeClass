const params = new URLSearchParams(location.search);
const android = document.getElementById('androidSteps');
const apple = document.getElementById('appleSteps');
function tab(isApple) {
  android.hidden = isApple; apple.hidden = !isApple;
  document.getElementById('androidTab').classList.toggle('selected', !isApple);
  document.getElementById('appleTab').classList.toggle('selected', isApple);
}
document.getElementById('androidTab').onclick = () => tab(false);
document.getElementById('appleTab').onclick = () => tab(true);
tab(/iPhone|iPad|iPod/.test(navigator.userAgent));
fetch('/api/setup?' + params.toString()).then(async response => {
  if (!response.ok) throw new Error('二维码已失效，请重新扫描电脑程序中的二维码。');
  return response.json();
}).then(async info => {
  const button = document.getElementById('openPhone');
  button.href = info.phoneUrl; button.setAttribute('aria-disabled', 'false');
  document.getElementById('setupStatus').textContent = '正在连接摄像头…';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(new URL('/api/browser-ready', info.phoneUrl), { signal: controller.signal });
    if (response.ok && (await response.json()).ready) { location.replace(info.phoneUrl); return; }
  } catch (_) { /* Untrusted HTTPS stays on the one-time setup instructions. */ }
  finally { clearTimeout(timeout); }
  document.getElementById('certificateSetup').hidden = false;
  document.getElementById('setupHeading').textContent = '首次使用，请管理员准备';
  document.getElementById('setupStatus').textContent = '证书名称：' + info.certificateName + '。设置好后，再扫码会自动打开摄像头。';
}).catch(error => { document.getElementById('setupHeading').textContent = '暂时无法连接'; document.getElementById('setupStatus').textContent = error.message; });

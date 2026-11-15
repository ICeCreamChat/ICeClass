import { readJson, cameraError, stopTracks, requireCamera, Signal, MediaPeer, reportPhoneStep, inWeChat, browserOpenHint } from './shared.js';
import { maintainPhoneCertificate } from './preparation-client.js';
import { VideoOrientation, renderOrientationControls } from './orientation.js';

const $ = id => document.getElementById(id);
const video = $('phoneVideo');
const query = new URLSearchParams(location.search);
const phoneApi = 'api/phone?room=' + encodeURIComponent(query.get('room') || '') + '&join=' + encodeURIComponent(query.get('join') || '');
let config, signal, media, stream = null, facing = 'environment';
let wanted = false, viewer = false, ready = false, busy = false, negotiating = false, offerAgain = false;
let epoch = 0, wakeLock = null, fatal = false, offerRetry = null;
const orientation = new VideoOrientation(video, (state, changed) => {
  renderOrientationControls(state, !!stream && !busy && !fatal);
  if (changed) reportOrientation();
}, true);
function reportOrientation() { signal?.send('orientation', { state: orientation.state }); }

function status(message, error) { $('phoneStatus').textContent = message; $('phoneStatus').classList.toggle('error', !!error); }
function connection(message) { $('phoneConnection').textContent = message; }
function render() {
  $('phoneEmpty').hidden = !!stream;
  video.parentElement.classList.toggle('has-video', !!stream);
  orientation.mirror = facing === 'user'; orientation.refresh();
  $('startPhone').disabled = !config || fatal || busy || !!stream;
  $('startPhone').hidden = wanted || fatal || busy || !!stream;
  $('facingControls').hidden = !stream;
  $('phoneEmptyTitle').textContent = fatal ? '暂时无法连接' : !wanted ? '摄像头尚未打开' : ready ? '正在打开摄像头' : '等待电脑连接';
  $('phoneEmptyMessage').textContent = fatal ? '请查看下方提示。' : !wanted ? '点击下方“开始展示”重新连接。' : ready ? '出现摄像头权限提示时，点“允许”。' : '请保持此页面打开。';
  $('startPhone').textContent = busy ? '正在打开摄像头…' : stream ? '正在展示' : wanted && !ready ? '等待电脑连接…' : '开始展示';
  $('stopPhone').disabled = !wanted && !stream;
  for (const name of ['backCamera', 'frontCamera']) {
    const selected = (name === 'backCamera') === (facing === 'environment');
    $(name).classList.toggle('selected', selected); $(name).setAttribute('aria-pressed', String(selected));
    $(name).disabled = busy || fatal;
  }
}
async function keepAwake() {
  if (!stream || document.hidden || !navigator.wakeLock || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
  catch (_) { /* Older browsers and low-power mode can reject a screen wake lock. */ }
}
function release() {
  ++epoch;
  clearTimeout(offerRetry);
  if (media) media.close();
  stopTracks(stream); stream = null; video.srcObject = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  render();
}
function report(message) { if (signal) signal.send('state', { streaming: !!stream, message }); }
function allowed() { return wanted && viewer && ready && !document.hidden && !fatal; }
async function offer() {
  if (!allowed() || !stream) return;
  if (negotiating) { offerAgain = true; return; }
  negotiating = true;
  try { await media.offer(stream); clearTimeout(offerRetry); }
  catch (error) { if (allowed()) {
    status('画面连接失败，正在重试。' + error.message, true);
    clearTimeout(offerRetry); offerRetry = setTimeout(() => offer(), 1500);
  } }
  finally { negotiating = false; if (offerAgain) { offerAgain = false; offer(); } }
}
async function capture(mode) {
  requireCamera();
  return navigator.mediaDevices.getUserMedia({ audio: false, video: {
    facingMode: { ideal: mode }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 }
  } });
}
async function resume(rollbackFacing) {
  if (!allowed() || busy) { render(); return; }
  if (stream) { await offer(); return; }
  const current = ++epoch;
  reportPhoneStep('camera-requested');
  busy = true; status('正在打开摄像头，请允许浏览器访问…'); render();
  try {
    let next;
    try { next = await capture(facing); }
    catch (error) {
      if (!rollbackFacing || current !== epoch || !allowed()) throw error;
      facing = rollbackFacing;
      next = await capture(facing);
      status('切换未成功，已恢复原摄像头。');
    }
    if (current !== epoch || !allowed()) { stopTracks(next); return; }
    stream = next; video.srcObject = stream;
    reportPhoneStep('camera-ready');
    try { await video.play(); }
    catch (error) { stopTracks(next); stream = null; video.srcObject = null; throw error; }
    if (current !== epoch || !allowed()) { stopTracks(next); return; }
    const settings = stream.getVideoTracks()[0].getSettings();
    if (settings.facingMode) facing = settings.facingMode;
    stream.getVideoTracks()[0].onended = () => {
      if (stream !== next) return;
      release(); status('摄像头已中断。回到此页面后点击“开始展示”恢复。', true);
      wanted = false; render(); report('手机摄像头已中断，请在手机上重新开始。');
    };
    render(); await keepAwake();
    report('正在连接手机画面…'); await offer();
  } catch (error) {
    if (current === epoch) { wanted = false; release(); reportPhoneStep('camera-error', error); status(cameraError(error), true); report(cameraError(error)); }
  } finally {
    busy = false; render();
    // A pause/reconnect may arrive while the permission prompt is still open.
    if (current !== epoch && allowed() && !stream) resume();
  }
}
function pause(resumeLater, message) {
  if (!resumeLater) wanted = false;
  ready = false; release(); status(message); render();
}
async function connect() {
  reportPhoneStep('phone-opened');
  $('browserHelp').hidden = !inWeChat();
  $('browserHelp').textContent = '微信没有出画面时：' + browserOpenHint();
  try {
    config = await readJson(phoneApi);
    requireCamera();
    if (!window.RTCPeerConnection) throw Object.assign(new Error('当前浏览器不支持实时视频连接。' + browserOpenHint()), { name: 'WebRtcUnavailableError' });
    signal = new Signal(config, 'sender', {
      open() { connection('等待电脑就绪'); reportOrientation(); },
      async message(message) {
        if (message.type === 'peer') {
          viewer = !!message.present;
          if (!viewer) { connection('等待电脑连接'); pause(true, '电脑已断开，恢复连接后会继续展示。'); }
          else { connection('电脑已连接'); if (!wanted) status('点击“开始展示”，并允许浏览器访问摄像头。'); }
        } else if (message.type === 'ready') {
          viewer = true; ready = true; connection('电脑已连接');
          reportOrientation();
          if (wanted) await resume(); else { status('点击“开始展示”，并允许浏览器访问摄像头。'); report('手机已连接，在手机上点击“开始展示”。'); }
          render();
        } else if (message.type === 'pause') {
          const resumeLater = !!(message.payload && message.payload.resume);
          pause(resumeLater, resumeLater ? '电脑正在使用其他摄像头。切回手机后可继续展示。' : '电脑已停止展示，点击“开始展示”可重新连接。');
        } else if (message.type === 'orientation') {
          if (message.payload?.action === 'lock') orientation.toggle();
          else if (message.payload?.action === 'rotate') orientation.rotate();
        } else if (message.type === 'answer') await media.acceptAnswer(message.payload);
        else if (message.type === 'candidate') await media.candidate(message.payload);
        else if (message.type === 'media-stats' && message.payload?.request === true) {
          try {
            const stats = await media.diagnostics();
            signal.send('media-stats', { at: Date.now(), video: stats?.video.filter(s => ['outbound-rtp', 'remote-inbound-rtp', 'media-source', 'codec'].includes(s.type)) });
          } catch (_) { /* Optional measurement must not interrupt a stopped camera. */ }
        }
      },
      lost() { viewer = false; connection('正在重新连接'); pause(true, config.online ? '连接中断，正在自动重连。请保持手机和电脑可以上网。' : '连接中断，正在自动重连。请检查 Wi-Fi 或热点。'); },
      validate() { return readJson(phoneApi); },
      error(error) {
        if (/配对已经失效/.test(error.message)) { fatal = true; wanted = false; release(); connection('配对已失效'); }
        status(error.message, true);
      },
      replaced() { fatal = true; wanted = false; viewer = false; release(); connection('已被其他手机接管'); status('另一台手机已连接此展台。如需重新使用本机，请重新扫描电脑二维码。', true); }
    });
    media = new MediaPeer(config, signal, {
      state(state) {
        if (state === 'connected') { reportPhoneStep('live'); connection('正在展示'); status('画面正在传送到电脑。保持此页面在前台。'); }
        else if (state === 'failed' || state === 'disconnected') { reportPhoneStep('transport-error'); connection('正在恢复画面'); status('视频传输中断，正在恢复…'); }
      },
      retry() { offer(); }
    });
    render();
  } catch (error) { reportPhoneStep(/UnavailableError|InsecureContextError/.test(error.name) ? 'unsupported' : 'connect-error', error); fatal = true; connection('暂时无法连接'); status(error.message, true); render(); }
}
$('startPhone').onclick = async () => {
  wanted = true; render();
  if (!viewer) { status('等待电脑连接。请保持手机与电脑处于可互通的网络。'); return; }
  // Explicitly starting after a desktop stop reselects the phone source.
  if (!ready) signal.send('state', { streaming: false, requestStart: true, message: '手机请求开始展示。' });
  else await resume();
};
$('stopPhone').onclick = () => { wanted = false; release(); reportPhoneStep('stopped'); status('画面已停止，摄像头已释放。'); report('手机已停止展示，点击手机上的“开始展示”可重新连接。'); };
async function switchFacing(next) {
  if (next === facing || busy) return;
  const previous = facing; facing = next;
  if (stream) { release(); report('正在切换手机摄像头…'); await resume(previous); } else render();
}
$('backCamera').onclick = () => switchFacing('environment');
$('frontCamera').onclick = () => switchFacing('user');
$('lockOrientation').onclick = () => orientation.toggle();
$('rotateVideo').onclick = () => orientation.rotate();
document.addEventListener('visibilitychange', () => {
  if (document.hidden && stream) { release(); reportPhoneStep('background'); status('回到此页面后继续展示。'); report('手机页面已切到后台，回到手机页面后会恢复。'); }
  else if (!document.hidden && wanted && ready) resume();
});
const certificateTimer = setInterval(async () => {
  if (fatal || document.hidden || config?.online) return;
  const next = await maintainPhoneCertificate(query);
  if (next && new URL(next).origin !== location.origin) { release(); location.replace(next); }
}, 60000);
window.addEventListener('pagehide', () => { clearInterval(certificateTimer); orientation.dispose(); wanted = false; release(); report('手机页面已关闭。'); if (signal) signal.stop(); });
window.phoneBooth = { diagnostics() { return { wanted, viewer, ready, busy, fatal, live: !!stream, facing, width: video.videoWidth, height: video.videoHeight, orientation: { ...orientation.state }, display: orientation.dimensions() }; } };
connect();

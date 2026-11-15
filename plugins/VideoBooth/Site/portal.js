import { gunzipSync, gzipSync, strToU8, strFromU8 } from '/assets/fflate.js';
import { cameraError, requireCamera, stopTracks, inWeChat, browserOpenHint, tuneVideoSender } from '/assets/shared.js';
import { gatherIce } from '/assets/public-peer.js';
import { VideoOrientation, renderOrientationControls } from '/assets/orientation.js';

const $ = id => document.getElementById(id), video = $('phoneVideo');
let config, endpoint, peer, control, sender, stream = null, facing = 'environment';
let wanted = false, allowed = true, paired = false, busy = false, fatal = false, epoch = 0, wakeLock = null, connectTimer;
const orientation = new VideoOrientation(video, (state, changed) => {
  renderOrientationControls(state, !!stream && !busy && !fatal);
  if (changed) reportOrientation();
}, true);
function reportOrientation() { if (control?.readyState === 'open') control.send(JSON.stringify({ type: 'orientation', payload: { state: orientation.state } })); }
function status(message, error = false) { $('phoneStatus').textContent = message; $('phoneStatus').classList.toggle('error', error); }
function connection(message) { $('phoneConnection').textContent = message; }
function render() {
  $('phoneEmpty').hidden = !!stream; video.parentElement.classList.toggle('has-video', !!stream);
  orientation.mirror = facing === 'user'; orientation.refresh();
  $('facingControls').hidden = !stream;
  $('startPhone').hidden = fatal || busy || !!stream || wanted && !allowed;
  $('startPhone').disabled = busy || fatal;
  $('stopPhone').disabled = !stream && !wanted;
  $('phoneEmptyTitle').textContent = fatal ? '暂时无法连接' : !allowed ? '电脑正在使用其他摄像头' : '摄像头已停止';
  $('phoneEmptyMessage').textContent = fatal ? '请查看下方提示。' : !allowed ? '电脑切回手机后会继续展示。' : '点击“开始展示”继续。';
  for (const name of ['backCamera', 'frontCamera']) {
    const selected = (name === 'backCamera') === (facing === 'environment');
    $(name).classList.toggle('selected', selected); $(name).setAttribute('aria-pressed', String(selected)); $(name).disabled = busy;
  }
}
function sendState(stage, message) {
  if (control?.readyState === 'open') control.send(JSON.stringify({ type: 'state', payload: { stage, streaming: !!stream, message,
    report: { stage, secureContext: isSecureContext, cameraApi: !!navigator.mediaDevices?.getUserMedia, webRtc: !!window.RTCPeerConnection } } }));
}
async function keepAwake() {
  if (!stream || document.hidden || !navigator.wakeLock || wakeLock) return;
  const current = epoch;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (current !== epoch || !stream || document.hidden || fatal) { await lock.release(); return; }
    wakeLock = lock; lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
  } catch (_) { }
}
async function release() {
  ++epoch;
  const previous = stream, previousSender = sender, previousLock = wakeLock;
  stream = null; wakeLock = null; video.srcObject = null;
  stopTracks(previous);
  if (previousLock) previousLock.release().catch(() => {});
  render();
  if (previousSender) try { await previousSender.replaceTrack(null); } catch (_) { }
}
function disposePair() {
  clearTimeout(connectTimer);
  const previousPeer = peer, previousControl = control;
  peer = null; control = null; sender = null; paired = false;
  $('connectComputer').disabled = true; $('connectComputer').hidden = true;
  endpoint?.searchParams.delete('payload'); endpoint?.searchParams.delete('signature');
  if (previousControl) {
    previousControl.onopen = previousControl.onmessage = previousControl.onclose = previousControl.onerror = null;
    previousControl.close();
  }
  if (previousPeer) { previousPeer.ondatachannel = previousPeer.onconnectionstatechange = null; previousPeer.close(); }
}
function terminate() {
  if (fatal) return;
  fatal = true; wanted = false; allowed = false; busy = false;
  // Invalidate pending capture/wake-lock work and release devices before closing transport.
  void release(); disposePair();
  connection('连接已中断'); status('请在电脑上点“停止”，再点“连接手机”并重新扫码。', true);
}
async function capture(mode) {
  requireCamera();
  return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: mode }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } } });
}
async function resume(rollbackFacing) {
  if (busy || stream || fatal || !wanted || !allowed || document.hidden) { render(); return; }
  const current = ++epoch; busy = true; status('正在打开摄像头，请点“允许”…'); render();
  try {
    let next;
    try { next = await capture(facing); }
    catch (error) { if (!rollbackFacing || current !== epoch) throw error; facing = rollbackFacing; next = await capture(facing); }
    if (current !== epoch || !wanted || !allowed || document.hidden) { stopTracks(next); return; }
    stream = next; video.srcObject = next;
    try { await video.play(); } catch (error) { await release(); throw error; }
    if (current !== epoch) return;
    const track = next.getVideoTracks()[0];
    facing = track.getSettings().facingMode || facing;
    track.onended = async () => { if (stream !== next) return; wanted = false; await release(); if (fatal) return; status('摄像头已中断，请点“开始展示”恢复。', true); sendState('stopped', '手机摄像头已中断。'); };
    if (sender) { const currentSender = sender; await currentSender.replaceTrack(track); if (current !== epoch) return; await tuneVideoSender(currentSender); }
    else await preparePair(next, current);
    if (current !== epoch) return;
    render(); await keepAwake();
    if (current !== epoch) return;
    status(paired ? '画面正在传送到电脑。请保持此页面在前台。' : '摄像头已打开，请点“连接电脑”。');
    sendState(paired ? 'live' : 'camera-ready', '手机摄像头已打开。');
  } catch (error) {
    if (current === epoch) { wanted = false; if (!paired) disposePair(); await release(); if (fatal) return; status(cameraError(error), true); sendState('camera-error', cameraError(error)); }
  } finally { busy = false; render(); if (current !== epoch && wanted && allowed && !stream && !document.hidden) resume(); }
}
async function preparePair(next, current) {
  if (!window.RTCPeerConnection) throw new Error('此浏览器暂不支持实时视频。' + browserOpenHint());
  const preparing = peer = new RTCPeerConnection({ iceServers: [] });
  const ownsPeer = () => peer === preparing && !fatal;
  const currentPair = () => {
    if (current === epoch && ownsPeer()) return true;
    if (peer === preparing) disposePair();
    return false;
  };
  $('connectComputer').hidden = false; $('connectComputer').disabled = true;
  preparing.ondatachannel = event => {
    if (!ownsPeer()) { event.channel.close(); return; }
    const channel = control = event.channel;
    const ownsControl = () => ownsPeer() && control === channel;
    channel.onopen = () => { if (!ownsControl()) return; paired = true; clearTimeout(connectTimer); $('connectComputer').hidden = true; connection('电脑已连接'); reportOrientation(); sendState(stream ? 'live' : 'stopped', stream ? '手机正在展示。' : '手机尚未开始展示。'); };
    channel.onclose = channel.onerror = () => { if (ownsControl()) terminate(); };
    channel.onmessage = async event => {
      if (!ownsControl()) return;
      if (typeof event.data !== 'string' || event.data.length > 4096) return;
      let message; try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.type === 'orientation') {
        if (message.payload?.action === 'lock') orientation.toggle();
        else if (message.payload?.action === 'rotate') orientation.rotate();
      }
      else if (message.type === 'ready') { allowed = true; reportOrientation(); if (wanted) await resume(); else { status('电脑已就绪，点击“开始展示”。'); render(); } }
      else if (message.type === 'pause') {
        allowed = false; if (!message.payload?.resume) wanted = false;
        await release();
        if (!ownsControl()) return;
        status(message.payload?.resume ? '电脑正在使用其他摄像头，切回手机后会恢复。' : '电脑已停止展示，点击“开始展示”可继续。');
        sendState('stopped', '手机摄像头已释放。');
      }
    };
  };
  preparing.onconnectionstatechange = () => {
    if (!ownsPeer()) return;
    if (preparing.connectionState === 'connected') { connection('正在展示'); status('电脑已连接。手机仍可上网，展示时请保持此页面在前台。'); }
    else if (['failed', 'disconnected', 'closed'].includes(preparing.connectionState)) terminate();
  };
  await preparing.setRemoteDescription(config.offer);
  if (!currentPair()) return;
  sender = preparing.addTrack(next.getVideoTracks()[0], next);
  await preparing.setLocalDescription(await preparing.createAnswer()); await gatherIce(preparing);
  if (!currentPair()) return;
  await tuneVideoSender(sender);
  if (!currentPair()) return;
  const payload = encode(gzipSync(strToU8(JSON.stringify({ nonce: config.nonce, answer: preparing.localDescription }))));
  const key = await crypto.subtle.importKey('raw', decode(config.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, strToU8(payload))));
  if (!currentPair()) return;
  endpoint.searchParams.set('payload', payload); endpoint.searchParams.set('signature', signature);
  $('connectComputer').disabled = false; $('connectComputer').textContent = '连接电脑';
}
function decode(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
function encode(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function validateEndpoint(value) {
  const url = new URL(value), parts = url.hostname.split('.').map(Number);
  const local = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
  if (!local || url.protocol !== 'http:' || url.pathname !== '/pair-phone' || url.username || url.password || url.search || url.hash)
    throw new Error('二维码中的电脑地址无效，请重新扫描展台上的第 2 张码。');
  return url;
}
$('connectComputer').onclick = () => {
  if (fatal || $('connectComputer').disabled) return;
  const popup = window.open(endpoint.href, 'videobooth-pair');
  if (!popup) { status('未能打开连接窗口。' + browserOpenHint(), true); return; }
  connection('正在连接电脑'); status('正在连接，完成后会返回摄像头页面。');
  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => { if (!paired) status('请保持展台 Wi-Fi。若打开了新页面，请返回本摄像头页面；仍无画面时用系统相机重新扫码。', true); }, 12000);
};
$('startPhone').onclick = async () => {
  if (fatal) return;
  wanted = true;
  if (paired && !allowed) { control.send(JSON.stringify({ type: 'state', payload: { requestStart: true, streaming: false } })); status('等待电脑切回手机画面…'); }
  else { allowed = true; await resume(); }
};
$('stopPhone').onclick = async () => { wanted = false; await release(); if (fatal) return; status('已停止展示，摄像头已释放。'); sendState('stopped', '手机已停止展示。'); };
async function switchFacing(next) { if (next === facing || busy || fatal) return; const old = facing; facing = next; await release(); if (fatal) return; sendState('switching', '正在切换手机摄像头…'); await resume(old); }
$('backCamera').onclick = () => switchFacing('environment'); $('frontCamera').onclick = () => switchFacing('user');
$('lockOrientation').onclick = () => orientation.toggle(); $('rotateVideo').onclick = () => orientation.rotate();
document.addEventListener('visibilitychange', async () => {
  if (document.hidden && stream) { await release(); if (fatal) return; status('回到此页面后继续展示。'); sendState('background', '手机页面已切到后台，回到手机页面后恢复。'); }
  else if (!document.hidden && wanted && allowed) await resume();
});
window.addEventListener('pagehide', () => { orientation.dispose(); sendState('stopped', '手机页面已关闭。'); terminate(); });
window.phoneBooth = { diagnostics() { return { wanted, viewer: paired, ready: allowed, busy, fatal, live: !!stream, facing, width: video.videoWidth, height: video.videoHeight, secureContext: isSecureContext, orientation: { ...orientation.state }, display: orientation.dimensions() }; } };
try {
  const packed = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (!packed || packed.length > 2300) throw new Error('请用手机扫描电脑展台中的第 2 张码。');
  config = JSON.parse(strFromU8(gunzipSync(decode(packed))));
  if (config.v !== 1 || typeof config.nonce !== 'string' || config.nonce.length !== 48 || typeof config.key !== 'string' || decode(config.key).length !== 32)
    throw new Error('二维码不完整，请重新扫描。');
  endpoint = validateEndpoint(config.endpoint);
  // Keep the fragment for “open in browser” in WeChat; it is never sent in HTTP requests.
  $('browserHelp').hidden = !inWeChat(); $('browserHelp').textContent = '微信没有出画面时：' + browserOpenHint();
  requireCamera(); render(); status('点击“开始展示”，并允许访问摄像头。');
} catch (error) { fatal = true; wanted = false; await release(); connection('暂时无法连接'); status(cameraError(error), true); $('connectComputer').hidden = true; }

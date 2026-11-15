import { readJson, cameraError, stopTracks, requireCamera, Signal, MediaPeer } from '/assets/shared.js';
import { PublicReceiver } from '/assets/public-peer.js';
import { VideoOrientation, orientationState } from '/assets/orientation.js';
import { captureFrame, ManagedReview } from '/assets/managed-review.js';

const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search), managed = query.get('managed') === '1';
const api = path => path + (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(query.get('key') || '');
const video = $('video');
let config, selected = 'local', stream = null, signal = null, remote = null, operation = 0, connecting = false;
let lastFrameAt = -Infinity, frameCallback = null, framesReady = false, previousFrames = 0, pausedFrame = null;
let phoneArmed = false, phonePreparing = false, configPending = false, transportKey = '', transportEpoch = 0, publicStreaming = false;
let phonePreparationError = '';
let reviewView = { active: false, frame: null, title: '', message: '', knowledgePoints: [] };
let lastAspect = 0, disposed = false;

function send(type, payload = {}) { window.chrome?.webview?.postMessage({ type, payload }); }
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function hasVideo() { return !!(stream && framesReady && performance.now() - lastFrameAt <= 2000 && video.videoWidth && stream.getVideoTracks().some(track => track.readyState === 'live')); }
function renderReview(view) {
  const wasActive = reviewView.active;
  reviewView = view;
  $('reviewPanel').hidden = !view.active;
  $('reviewTitle').textContent = view.title;
  $('reviewMessage').textContent = view.message;
  $('reviewKnowledge').replaceChildren(...view.knowledgePoints.map(point => { const item = document.createElement('li'); item.textContent = point; return item; }));
  $('reviewQuestion').disabled = !view.frame || view.busy;
  $('reviewQuestion').hidden = !view.frame || view.busy;
  if (view.active) status(view.frame ? '画面已固定' : '正在准备点评…');
  else if (wasActive && hasVideo()) status('正在展示');
  render();
}
const review = new ManagedReview((type, payload) => { if (managed) send(type, payload); }, renderReview, Date.now());
const orientation = new VideoOrientation(video, () => {
  const size = orientation.dimensions(), aspect = size.height ? size.width / size.height : 0;
  if (aspect > 0 && aspect !== lastAspect) { lastAspect = aspect; send('video_aspect', { aspect }); }
});
function render() {
  const live = hasVideo(), frozen = reviewView.frame || pausedFrame;
  $('stage').classList.toggle('has-video', live);
  $('stage').classList.toggle('is-frozen', !!frozen);
  $('frozenFrame').hidden = !frozen;
  if (frozen) { if ($('frozenFrame').getAttribute('src') !== frozen.dataUrl) $('frozenFrame').src = frozen.dataUrl; }
  else $('frozenFrame').removeAttribute('src');
  $('empty').hidden = live || !!frozen;
  $('requestReview').hidden = reviewView.active;
  $('requestReview').disabled = !live;
  $('resumeReview').hidden = !reviewView.active;
  $('pauseVideo').disabled = !live || reviewView.active;
  $('pauseVideo').setAttribute('aria-label', pausedFrame ? '取消定格' : '定格画面');
  $('pauseVideo').title = pausedFrame ? '取消定格' : '定格画面';
  $('pauseVideo').querySelector('use').setAttribute('href', pausedFrame ? '#i-play' : '#i-pause');
  for (const id of ['rotateVideo', 'mirrorVideo']) $(id).disabled = !live;
  $('stopVideo').disabled = !stream && !connecting && selected !== 'phone' && !reviewView.active;
  $('startCamera').disabled = connecting;
  $('connectCamera').disabled = connecting;
  $('frameLabel').textContent = frozen ? '画面已固定' : live ? '正在展示' : connecting ? '正在打开…' : '准备就绪';
}
function invalidate(reason) { pausedFrame = null; review.invalidate(reason); }
function watchFrames(next) {
  if (frameCallback !== null) video.cancelVideoFrameCallback?.(frameCallback);
  frameCallback = null; framesReady = false; lastFrameAt = -Infinity;
  previousFrames = video.getVideoPlaybackQuality?.().totalVideoFrames || 0;
  if (video.requestVideoFrameCallback) {
    const received = () => {
      if (stream !== next) return;
      const wasReady = framesReady;
      lastFrameAt = performance.now(); framesReady = true;
      if (!wasReady) { status('正在展示'); render(); orientation.refresh(); }
      frameCallback = video.requestVideoFrameCallback(received);
    };
    frameCallback = video.requestVideoFrameCallback(received);
  }
}
function clearStream() {
  if (frameCallback !== null) video.cancelVideoFrameCallback?.(frameCallback);
  frameCallback = null; framesReady = false; lastFrameAt = -Infinity;
  const previous = stream; stream = null; video.srcObject = null;
  // A remote replaceTrack reuses its receiving track; stopping it would prevent recovery.
  if (selected === 'local') stopTracks(previous);
  render();
}
function disconnectPhone() {
  ++transportEpoch;
  signal?.send('pause', { resume: false });
  signal?.stop?.(); remote?.dispose?.(); remote?.close?.();
  signal = remote = null; transportKey = ''; publicStreaming = false;
}
async function attach(next, epoch) {
  if (epoch !== operation || disposed) { stopTracks(next); return; }
  if (stream === next) return;
  if (stream) { invalidate('采集画面已改变'); clearStream(); }
  stream = next; video.srcObject = next; watchFrames(next);
  next.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
    if (stream !== next) return;
    invalidate('摄像头已断开'); clearStream(); status('摄像头已断开，请重新连接。', true);
  }, { once: true }));
  try { await video.play(); }
  catch (error) { if (stream === next) { invalidate('画面播放失败'); clearStream(); } throw error; }
  if (epoch !== operation || stream !== next) { stopTracks(next); return; }
  orientation.refresh(); render();
}
async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
    const current = $('cameraSelect').value;
    $('cameraSelect').replaceChildren(new Option('默认摄像头', ''), ...devices.map((device, index) => new Option(device.label || `摄像头 ${index + 1}`, device.deviceId)));
    if ([...$('cameraSelect').options].some(option => option.value === current)) $('cameraSelect').value = current;
  } catch (error) { status('无法读取摄像头列表，请检查设备权限。', true); }
}
function selectLocal() {
  if (selected !== 'local') {
    ++operation; invalidate('切换画面来源'); disconnectPhone(); clearStream(); selected = 'local'; connecting = false;
    orientation.set({ locked: false, rotation: 0, baseAngle: 0, sourceAngle: 0 }); orientation.mirror = false;
    $('mirrorVideo').setAttribute('aria-pressed', 'false');
    $('sourceName').textContent = '电脑 / USB'; $('emptyTitle').textContent = '打开电脑摄像头'; status('请选择摄像头并开始展示。');
  }
  $('localPanel').hidden = false; $('phonePanel').hidden = true;
  $('localSource').setAttribute('aria-pressed', 'true'); $('phoneSource').setAttribute('aria-pressed', 'false');
  render(); listDevices();
}
async function startCamera() {
  if (connecting) return;
  selectLocal(); ++operation; const epoch = operation;
  invalidate('重新打开摄像头'); clearStream(); connecting = true; status('正在打开摄像头…'); render();
  try {
    requireCamera();
    const id = $('cameraSelect').value;
    const next = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...(id ? { deviceId: { exact: id } } : {}), width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 24, max: 30 } } });
    if (epoch !== operation) { stopTracks(next); return; }
    $('sourceName').textContent = next.getVideoTracks()[0]?.label || '电脑 / USB';
    await attach(next, epoch); await listDevices(); closePanel('source');
  } catch (error) { if (epoch === operation) { status(cameraError(error), true); $('emptyTitle').textContent = '摄像头未能打开'; } }
  finally { if (epoch === operation) { connecting = false; render(); } }
}
function selectPhone() {
  if (selected !== 'phone') {
    ++operation; invalidate('切换手机画面'); clearStream(); connecting = false; selected = 'phone';
    orientation.set({ locked: false, rotation: 0, baseAngle: 0, sourceAngle: 0 }); orientation.mirror = false;
    $('mirrorVideo').setAttribute('aria-pressed', 'false');
    phoneArmed = !!(config?.equipment?.certificateReady || config?.equipment?.phonePreparation || config?.publicPhone?.enabled || config?.relayUrl);
  }
  $('sourceName').textContent = '手机'; $('emptyTitle').textContent = '连接手机摄像头';
  $('localPanel').hidden = true; $('phonePanel').hidden = false;
  $('localSource').setAttribute('aria-pressed', 'false'); $('phoneSource').setAttribute('aria-pressed', 'true');
  status(phoneArmed ? '等待手机扫码连接。' : '请先准备手机连接。');
  if (config) applyConfig(config); refreshConfig(); render();
}
function phoneLost(message) {
  if (selected !== 'phone') return;
  invalidate('手机画面已中断'); clearStream(); status(message, true);
}
function receiveOrientation(payload) {
  const state = orientationState(payload?.state);
  if (!state || selected !== 'phone') return;
  if (JSON.stringify(state) !== JSON.stringify(orientation.state)) { invalidate('手机画面方向改变'); orientation.set(state); }
}
function connectPhone(next) {
  disconnectPhone(); const token = transportEpoch, epoch = operation;
  const current = () => token === transportEpoch && selected === 'phone' && !disposed;
  const receive = nextStream => { if (!current()) { stopTracks(nextStream); return; } attach(nextStream, epoch).then(() => closePanel('source')).catch(error => status(error.message, true)); };
  const onState = state => { if (current() && ['failed', 'disconnected', 'closed'].includes(state)) phoneLost('手机连接中断，请保持手机页面打开。'); };
  if (next.publicPhone?.enabled) {
    remote = new PublicReceiver(next, api, {
      prepared(value) { if (current()) { config = value; renderPhoneConfig(value); } },
      open() { if (current()) { signal.send('ready'); status('手机已连接，等待画面…'); } },
      stream(value) { if (current() && publicStreaming) receive(value); },
      message(message) {
        if (!current()) return;
        if (message.type === 'orientation') return receiveOrientation(message.payload);
        if (message.type !== 'state' || !message.payload) return;
        const value = message.payload;
        if (value.requestStart) { signal.send('ready'); return; }
        publicStreaming = !!value.streaming;
        if (!publicStreaming) phoneLost(value.message || '手机已停止展示。');
        else if (remote.stream) receive(remote.stream);
        if (value.message) status(value.message);
        if (value.report) fetch(api('/api/public-phone/state?generation=' + encodeURIComponent(next.publicPhone.generation)), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value.report) }).catch(() => {});
      }, state: onState, error(error) { if (current()) { phoneLost(error.message); $('phoneStatus').textContent = error.message; } }
    });
    signal = { send(type, payload) { return remote?.send(type, payload); }, stop() {} };
  } else {
    signal = new Signal(next, 'viewer', {
      open() { if (current()) status('等待手机扫码连接。'); },
      async message(message) {
        if (!current()) return;
        if (message.type === 'peer') { if (message.present) signal.send('ready'); else { remote.close(); phoneLost('等待手机重新连接。'); } }
        else if (message.type === 'offer') await remote.acceptOffer(message.payload);
        else if (message.type === 'candidate') await remote.candidate(message.payload);
        else if (message.type === 'orientation') receiveOrientation(message.payload);
        else if (message.type === 'state' && message.payload) {
          if (message.payload.requestStart) signal.send('ready');
          else if (message.payload.streaming === false) { remote.close(); phoneLost(message.payload.message || '手机已停止展示。'); }
          else if (message.payload.message) status(message.payload.message);
        }
      },
      lost() { if (current()) { remote.close(); phoneLost('手机连接中断，正在重连…'); } },
      replaced() { if (current()) phoneLost('连接已被另一工作台接管，请重新打开展台。'); },
      error(error) { if (current()) phoneLost(error.message); }
    });
    remote = new MediaPeer(next, signal, { stream: receive, state: onState, retry() { if (current()) signal.send('ready'); } });
  }
}
function configIdentity(value) { return JSON.stringify([value.room, value.key, value.signalUrl, value.iceServers, value.iceRefreshUrl, value.publicPhone?.enabled, value.publicPhone?.generation]); }
function applyConfig(next) {
  config = next;
  if (selected !== 'phone') return;
  const identity = configIdentity(next);
  if (phoneArmed && identity !== transportKey) {
    if (transportKey) { invalidate('手机配对已更新'); clearStream(); }
    connectPhone(next); transportKey = identity;
  }
  renderPhoneConfig(next);
}
function qr(id, figure, url, revision, visible) {
  $(figure).hidden = !visible;
  if (!visible) { $(id).removeAttribute('src'); return; }
  const next = new URL(url, location.href); next.searchParams.set('revision', revision);
  if ($(id).getAttribute('src') !== next.href) $(id).src = next.href;
}
function renderPhoneConfig(next) {
  const connection = next.connection || {}, preparation = next.equipment?.preparation;
  const error = phonePreparationError || next.publicPhone?.error || connection.error || (preparation?.status === 'failed' ? preparation.message : '');
  const available = phoneArmed && !phonePreparing && !!next.networkAvailable && !next.connectionAssessment?.switching && !error;
  const cameraReady = available && (!next.publicPhone?.enabled || !!next.publicPhone.ready);
  const revision = next.joinUrl + '|' + (next.publicPhone?.generation || '') + '|' + (next.equipment?.cameraHost || '');
  qr('phoneQr', 'cameraFigure', next.qrUrl, revision, cameraReady && !!next.qrUrl);
  qr('wifiQr', 'wifiFigure', next.wifiQrUrl, revision, available && !!connection.ssid && !!connection.ready && !!next.wifiQrUrl);
  $('phoneStatus').textContent = error || (phonePreparing ? '正在准备手机连接…' : cameraReady ? (connection.ssid ? `连接 ${connection.ssid} 后扫码打开摄像头。` : '手机与电脑连接同一网络后扫码。') : preparation?.message || '准备手机连接后扫码。');
  $('phoneStatus').classList.toggle('error', !!error);
  $('preparePhone').disabled = phonePreparing;
  $('preparePhone').textContent = phonePreparing ? '正在准备…' : phoneArmed ? '重新准备连接' : '准备手机连接';
}
async function refreshConfig() {
  if (configPending || disposed) return;
  configPending = true;
  try {
    applyConfig(await readJson(api('/api/desktop'), { cache: 'no-store', signal: AbortSignal.timeout(5000) }));
    window.booth.ready = true;
  } catch (error) {
    if (!config || selected === 'phone') status(error.message, true);
    if (selected === 'phone') { $('cameraFigure').hidden = true; $('wifiFigure').hidden = true; $('phoneStatus').textContent = '连接信息未能更新，请重试。'; }
  } finally { configPending = false; }
}
function freezeFrame(payload) {
  if (!managed) throw new Error('请从创意工坊启动 AI 点评。');
  review.requireCurrent(payload);
  if (review.frame) return review.frame;
  if (!hasVideo()) throw new Error('当前没有新鲜画面，请等待摄像头恢复后重试。');
  if (pausedFrame && Date.now() - pausedFrame.capturedAt > 2000) throw new Error('定格画面已过期，请继续展示后重新点评。');
  return review.freeze(pausedFrame || captureFrame(video, { rotation: orientation.angle, mirrored: orientation.mirror, lastFrameAt }), payload);
}
function resume() { pausedFrame = null; if (reviewView.active) review.resume(); render(); status(hasVideo() ? '正在展示' : '等待新画面。'); }
function stop() {
  ++operation; connecting = false; invalidate('停止展示'); disconnectPhone(); clearStream();
  selected = 'local'; phoneArmed = false; phonePreparing = false;
  $('sourceName').textContent = '选择来源'; $('emptyTitle').textContent = '选择画面来源';
  $('cameraFigure').hidden = $('wifiFigure').hidden = true;
  closePanel('source'); closePanel('more'); status('展示已停止，摄像头已释放。'); render(); return {};
}
function openPanel(name) {
  closePanel(name === 'source' ? 'more' : 'source');
  $(name + 'Panel').hidden = false; $(name + 'Button').setAttribute('aria-expanded', 'true');
  $(name + 'Panel').querySelector('button:not(:disabled), select')?.focus();
}
function closePanel(name, focus = false) { $(name + 'Panel').hidden = true; $(name + 'Button').setAttribute('aria-expanded', 'false'); if (focus) $(name + 'Button').focus(); }
$('sourceButton').onclick = () => { if ($('sourcePanel').hidden) { selected === 'phone' ? selectPhone() : selectLocal(); openPanel('source'); } else closePanel('source', true); };
$('closeSource').onclick = () => closePanel('source', true);
$('localSource').onclick = selectLocal;
$('phoneSource').onclick = selectPhone;
$('choosePhone').onclick = () => { selectPhone(); openPanel('source'); };
$('startCamera').onclick = $('connectCamera').onclick = startCamera;
$('refreshDevices').onclick = listDevices;
$('preparePhone').onclick = () => {
  if (phonePreparing) return;
  if (!window.chrome?.webview) { $('phoneStatus').textContent = '请从视频展台窗口准备手机连接。'; return; }
  phoneArmed = true; phonePreparing = true; phonePreparationError = ''; renderPhoneConfig(config || {}); send('prepare_phone');
};
for (const id of ['phoneQr', 'wifiQr']) $(id).onerror = () => { $(id).parentElement.hidden = true; $('phoneStatus').textContent = '二维码未能加载，请重新准备连接。'; };
$('moreButton').onclick = () => $('morePanel').hidden ? openPanel('more') : closePanel('more', true);
$('pauseVideo').onclick = () => {
  try { if (pausedFrame) resume(); else { pausedFrame = captureFrame(video, { rotation: orientation.angle, mirrored: orientation.mirror, lastFrameAt }); render(); status('画面已定格'); } }
  catch (error) { status(error.message, true); }
};
$('rotateVideo').onclick = () => { invalidate('画面方向改变'); orientation.rotate(); closePanel('more', true); };
$('mirrorVideo').onclick = () => { invalidate('画面镜像改变'); orientation.mirror = !orientation.mirror; orientation.refresh(); $('mirrorVideo').setAttribute('aria-pressed', String(orientation.mirror)); closePanel('more', true); };
$('requestReview').onclick = () => {
  if (!managed) { status('请从创意工坊启动 AI 点评。'); return; }
  if (!hasVideo()) { status('等待摄像头恢复后再点评。', true); return; }
  review.request();
};
$('resumeReview').onclick = resume;
$('reviewQuestion').onclick = () => review.question();
$('stopVideo').onclick = stop;
$('openWorkshop').onclick = () => { send('open_workshop'); closePanel('more', true); };
for (const [id, action] of [['floatWindow', 'float'], ['restoreWindow', 'restore'], ['minimizeWindow', 'minimize'], ['closeWindow', 'close']]) $(id).onclick = () => send('window', { action });
$('dragHandle').onpointerdown = event => { if (event.button === 0) send('window', { action: 'drag' }); };
document.addEventListener('keydown', event => { if (event.key === 'Escape') { if (!$('sourcePanel').hidden) closePanel('source', true); else if (!$('morePanel').hidden) closePanel('more', true); } });
document.addEventListener('pointerdown', event => { for (const name of ['source', 'more']) if (!$(name + 'Panel').contains(event.target) && !$(name + 'Button').contains(event.target)) closePanel(name); });
const frameTimer = setInterval(() => {
  if (!stream) return;
  if (!video.requestVideoFrameCallback) {
    const count = video.getVideoPlaybackQuality?.().totalVideoFrames || 0;
    if (count > previousFrames) { lastFrameAt = performance.now(); if (!framesReady) { framesReady = true; status('正在展示'); render(); } }
    previousFrames = count;
  }
  if (framesReady && performance.now() - lastFrameAt > 2000) { framesReady = false; invalidate('超过两秒未收到新画面'); render(); status('画面已中断，等待摄像头恢复。', true); }
}, 300);
const configTimer = setInterval(() => { if (selected === 'phone') refreshConfig(); }, 2000);
window.booth = {
  ready: false, freezeFrame,
  resumeReview(payload) { review.hostResume(payload); pausedFrame = null; render(); return {}; },
  setReviewState(payload) { review.update(payload); return {}; }, stop,
  setFloating(value) {
    if (typeof value !== 'boolean') throw new Error('窗口状态无效。');
    document.body.classList.toggle('floating', value); $('floatWindow').hidden = value; $('restoreWindow').hidden = !value;
    closePanel('source'); closePanel('more'); orientation.refresh(); $(value ? 'restoreWindow' : 'floatWindow').focus(); return {};
  },
  setNativeStatus(message) {
    if (typeof message !== 'string') throw new Error('窗口状态文字无效。');
    status(message, /失败|错误|无法/.test(message));
    phonePreparing = /正在准备/.test(message);
    phonePreparationError = /失败|错误|无法/.test(message) ? message : '';
    if (selected === 'phone') renderPhoneConfig(config || {});
    if (!phonePreparing && selected === 'phone') { $('preparePhone').disabled = false; refreshConfig(); }
    return {};
  }
};
window.addEventListener('pagehide', () => { disposed = true; stop(); clearInterval(frameTimer); clearInterval(configTimer); orientation.dispose(); });
navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
refreshConfig();

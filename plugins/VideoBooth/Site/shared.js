export async function readJson(url, options) {
  const response = await fetch(url, options);
  let result = {};
  try { result = await response.json(); } catch (_) { }
  if (!response.ok) throw new Error(result.error || (response.status === 401 ? '配对已经失效，请重新扫描电脑中的二维码。' : '连接服务没有响应，请检查网络后重试。'));
  return result;
}
export function cameraError(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return '摄像头权限未获允许。请在浏览器或系统设置中允许此页面使用摄像头。';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到摄像头。请接入设备后刷新列表。';
  if (name === 'NotReadableError' || name === 'TrackStartError') return '无法打开摄像头，它可能被其他程序占用。关闭对应程序后重试。';
  if (name === 'OverconstrainedError') return '此摄像头不支持当前要求，请尝试其他摄像头或重新连接。';
  return error && error.message || '摄像头连接失败，请重新连接。';
}
export function stopTracks(stream) { if (stream) stream.getTracks().forEach(track => track.stop()); }
export function inWeChat() { return /MicroMessenger/i.test(navigator.userAgent); }
export function browserOpenHint() {
  return inWeChat() ? '请点微信右上角“…”选择用浏览器打开；也可以退出微信，用手机系统相机重新扫描电脑上的摄像头码。'
    : '请用较新的 Safari、Chrome、Edge 或系统浏览器重新扫描电脑上的摄像头码。';
}
export function reportPhoneStep(stage, error) {
  const query = new URLSearchParams(location.search);
  if (!query.get('room') || !query.get('join')) return;
  fetch('api/phone-status?' + query, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    stage, secureContext: !!window.isSecureContext, cameraApi: !!navigator.mediaDevices?.getUserMedia,
    webRtc: !!window.RTCPeerConnection, errorName: error?.name || null
  }) }).catch(() => {});
}
export function requireCamera() {
  if (!window.isSecureContext) throw Object.assign(new Error('尚未打开安全的摄像头页面，请重新扫描电脑上的第 2 张码。'), { name: 'InsecureContextError' });
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
    throw Object.assign(new Error((inWeChat() ? '当前微信不能调用实时摄像头。' : '当前浏览器不能调用实时摄像头。') + browserOpenHint()), { name: 'CameraUnavailableError' });
}
export async function tuneVideoSender(sender, maxBitrate = 1500000) {
  if (sender.track?.kind !== 'video') return;
  try { sender.track.contentHint = 'motion'; } catch (_) { }
  // Keep moving objects responsive without allowing a 720p keyframe burst to
  // overwhelm a small Wi-Fi hotspot. Congestion control can still go lower.
  for (const includePreference of [true, false]) {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) return;
      for (const encoding of parameters.encodings) {
        encoding.maxBitrate = maxBitrate;
        if (includePreference) encoding.maxFramerate = 24;
      }
      if (includePreference) parameters.degradationPreference = 'maintain-framerate';
      await sender.setParameters(parameters);
      return;
    } catch (_) { /* Older phone browsers may only support the bitrate limit. */ }
  }
}
export function tuneVideoReceiver(receiver) {
  if (receiver.track?.kind !== 'video') return;
  // A teaching display should show the current frame rather than accumulating
  // latency after a loss burst. These hints preserve the browser's loss recovery.
  try { if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 60; } catch (_) { }
  try { if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0.06; } catch (_) { }
}
export class Signal {
  constructor(config, role, callbacks) {
    this.config = config; this.role = role; this.callbacks = callbacks; this.socket = null;
    this.closed = false; this.attempt = 0; this.timer = null;
    this.connect();
    this.ping = setInterval(() => this.send('ping'), 15000);
  }
  connect() {
    if (this.closed) return;
    const url = new URL(this.config.signalUrl);
    url.searchParams.set('room', this.config.room); url.searchParams.set('role', this.role); url.searchParams.set('key', this.config.key);
    const socket = new WebSocket(url.toString());
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      if (this.callbacks.open) this.callbacks.open();
    };
    socket.onmessage = event => {
      if (this.socket !== socket || this.closed) return;
      let message; try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.type === 'pong') return;
      Promise.resolve(this.callbacks.message(message)).catch(error => { if (this.callbacks.error) this.callbacks.error(error); });
    };
    socket.onclose = async event => {
      if (this.socket !== socket || this.closed) return;
      if (event.code === 4001) {
        this.stop();
        if (this.callbacks.replaced) this.callbacks.replaced();
        return;
      }
      if (this.callbacks.lost) this.callbacks.lost();
      if (this.callbacks.validate) {
        try { await this.callbacks.validate(); }
        catch (error) {
          // A stale QR is permanent; a temporarily unavailable server is retried.
          if (/配对已经失效/.test(error.message)) { this.stop(); if (this.callbacks.error) this.callbacks.error(error); return; }
        }
      }
      if (!this.closed) this.timer = setTimeout(() => this.connect(), Math.min(5000, 350 * Math.pow(1.6, this.attempt++)));
    };
    socket.onerror = () => {};
  }
  send(type, payload) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type, payload })); return true;
    }
    return false;
  }
  stop() { this.closed = true; clearTimeout(this.timer); clearInterval(this.ping); if (this.socket) this.socket.close(); }
}

export class MediaPeer {
  constructor(config, signal, handlers) {
    this.config = config; this.signal = signal; this.handlers = handlers;
    this.peer = null; this.id = null; this.pending = new Map(); this.retry = null; this.sequence = 0; this.operation = 0;
  }
  make(id) {
    if (this.peer) this.peer.close();
    clearTimeout(this.retry);
    this.id = id;
    const peer = new RTCPeerConnection({ iceServers: this.config.iceServers || [], iceTransportPolicy: this.config.iceTransportPolicy || 'all' });
    this.peer = peer;
    // A failed TURN allocation can leave connectionState at "new" indefinitely.
    // Retry negotiation when gathering finishes without starting a connection.
    peer.onicegatheringstatechange = () => {
      if (this.peer === peer && peer.iceGatheringState === 'complete' && peer.connectionState === 'new') {
        clearTimeout(this.retry);
        this.retry = setTimeout(() => { if (this.peer === peer && peer.connectionState === 'new' && this.handlers.retry) this.handlers.retry(); }, 5000);
      }
    };
    peer.onicecandidate = event => { if (event.candidate && this.peer === peer) this.signal.send('candidate', { id, candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate }); };
    peer.ontrack = event => {
      tuneVideoReceiver(event.receiver);
      if (this.peer === peer && this.handlers.stream) this.handlers.stream(event.streams[0] || new MediaStream([event.track]));
    };
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) return;
      const state = peer.connectionState;
      if (this.handlers.state) this.handlers.state(state);
      clearTimeout(this.retry);
      if (state === 'failed' || state === 'disconnected') this.retry = setTimeout(() => { if (this.peer === peer && this.handlers.retry) this.handlers.retry(); }, state === 'failed' ? 800 : 3500);
    };
    return peer;
  }
  async offer(stream) {
    const operation = ++this.operation;
    await this.refreshIce();
    if (operation !== this.operation || !stream.getVideoTracks().some(track => track.readyState === 'live')) return;
    const id = Date.now().toString(36) + '-' + (++this.sequence);
    const peer = this.make(id);
    stream.getTracks().forEach(track => peer.addTrack(track, stream));
    const offer = await peer.createOffer();
    if (this.peer !== peer) return;
    await peer.setLocalDescription(offer);
    await Promise.all(peer.getSenders().map(sender => tuneVideoSender(sender, this.config.online ? 900000 : 1500000)));
    if (this.peer === peer) this.signal.send('offer', { id, description: peer.localDescription });
  }
  async acceptOffer(payload) {
    const operation = ++this.operation;
    await this.refreshIce();
    if (operation !== this.operation) return;
    const peer = this.make(payload.id);
    await peer.setRemoteDescription(payload.description);
    if (this.peer !== peer) return;
    await this.flush(peer, payload.id);
    const answer = await peer.createAnswer();
    if (this.peer !== peer) return;
    await peer.setLocalDescription(answer);
    if (this.peer === peer) this.signal.send('answer', { id: payload.id, description: peer.localDescription });
  }
  async acceptAnswer(payload) {
    if (!this.peer || this.id !== payload.id) return;
    const peer = this.peer;
    await peer.setRemoteDescription(payload.description);
    if (this.peer === peer) await this.flush(peer, payload.id);
  }
  async refreshIce() {
    if (!this.config.iceRefreshUrl || Date.now() - (this.iceRefreshedAt || 0) < 60000) return;
    const cancellation = new AbortController();
    const timeout = setTimeout(() => cancellation.abort(), 5000);
    try {
      const response = await readJson(this.config.iceRefreshUrl, { signal: cancellation.signal });
      if (Array.isArray(response.iceServers)) this.config.iceServers = response.iceServers;
      this.iceRefreshedAt = Date.now();
    } finally { clearTimeout(timeout); }
  }
  async candidate(payload) {
    if (!payload || !payload.candidate) return;
    if (this.peer && this.id === payload.id && this.peer.remoteDescription) await this.peer.addIceCandidate(payload.candidate);
    else {
      if (!this.pending.has(payload.id)) this.pending.set(payload.id, []);
      const list = this.pending.get(payload.id);
      if (list.length < 100) list.push(payload.candidate);
      if (this.pending.size > 4) this.pending.delete(this.pending.keys().next().value);
    }
  }
  async flush(peer, id) {
    const pending = this.pending.get(id) || []; this.pending.clear();
    for (const candidate of pending) { if (this.peer !== peer) return; await peer.addIceCandidate(candidate); }
  }
  async diagnostics() {
    const peer = this.peer;
    if (!peer) return null;
    const stats = await peer.getStats();
    return { state: peer.connectionState, ice: peer.iceConnectionState, gathering: peer.iceGatheringState, signaling: peer.signalingState,
      candidates: [...stats.values()].filter(s => ['local-candidate', 'remote-candidate', 'candidate-pair'].includes(s.type)),
      video: [...stats.values()].filter(s => ['inbound-rtp', 'outbound-rtp', 'remote-inbound-rtp', 'media-source', 'codec', 'transport'].includes(s.type)),
      tracks: peer.getTransceivers().map(t => ({ direction: t.direction, current: t.currentDirection, state: t.receiver.track?.readyState, muted: t.receiver.track?.muted })) };
  }
  close() { ++this.operation; clearTimeout(this.retry); if (this.peer) this.peer.close(); this.peer = null; this.id = null; this.pending.clear(); }
}

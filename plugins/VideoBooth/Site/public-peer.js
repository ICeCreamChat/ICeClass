import { tuneVideoReceiver } from '/assets/shared.js';

export function gatherIce(peer) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { peer.removeEventListener('icegatheringstatechange', changed); reject(new Error('连接准备超时，请重试。')); }, 12000);
    function changed() {
      if (peer.iceGatheringState !== 'complete') return;
      clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); resolve();
    }
    peer.addEventListener('icegatheringstatechange', changed);
  });
}

export class PublicReceiver {
  constructor(config, api, callbacks) {
    this.config = config; this.api = api; this.callbacks = callbacks;
    this.disposed = false; this.accepted = false; this.stream = null;
    this.peer = new RTCPeerConnection({ iceServers: [] });
    this.control = this.peer.createDataChannel('videobooth-control');
    this.control.onopen = () => callbacks.open();
    this.control.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 4096) return;
      try { callbacks.message(JSON.parse(event.data)); } catch (_) { }
    };
    this.peer.ontrack = event => {
      tuneVideoReceiver(event.receiver);
      this.stream = event.streams[0] || new MediaStream([event.track]);
      callbacks.stream(this.stream);
      event.track.onunmute = () => { if (!this.disposed) callbacks.stream(this.stream); };
    };
    this.peer.onconnectionstatechange = () => { if (!this.disposed) callbacks.state(this.peer.connectionState); };
    this.prepare().catch(error => { if (!this.disposed) callbacks.error(error); });
  }
  async prepare() {
    const transceiver = this.peer.addTransceiver('video', { direction: 'recvonly' });
    const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs || [];
    const vp8 = codecs.find(codec => codec.mimeType.toLowerCase() === 'video/vp8');
    const h264 = codecs.find(codec => codec.mimeType.toLowerCase() === 'video/h264' && /packetization-mode=1/.test(codec.sdpFmtpLine || ''));
    const rtx = codecs.find(codec => codec.mimeType.toLowerCase() === 'video/rtx');
    if (transceiver.setCodecPreferences && (vp8 || h264)) transceiver.setCodecPreferences([vp8, h264, rtx].filter(Boolean));
    await this.peer.setLocalDescription(await this.peer.createOffer());
    await gatherIce(this.peer);
    if (this.disposed) return;
    const response = await fetch(this.api('/api/public-phone/offer'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generation: this.config.publicPhone.generation, offer: this.peer.localDescription }) });
    const config = await response.json();
    if (!response.ok) throw new Error(config.error || '二维码准备失败，请点“更换配对”重试。');
    if (this.disposed) return;
    this.callbacks.prepared(config);
    this.timer = setInterval(() => this.poll(), 450);
  }
  async poll() {
    if (this.disposed || this.polling || this.accepted) return;
    this.polling = true;
    try {
      const response = await fetch(this.api('/api/public-phone/answer?generation=' + encodeURIComponent(this.config.publicPhone.generation)));
      if (response.status !== 200 || this.disposed) return;
      await this.peer.setRemoteDescription(await response.json());
      this.accepted = true; clearInterval(this.timer);
    } catch (error) { if (!this.disposed) this.callbacks.error(error); }
    finally { this.polling = false; }
  }
  send(type, payload) {
    if (this.control.readyState !== 'open') return false;
    this.control.send(JSON.stringify({ type, payload })); return true;
  }
  close() { /* Camera pause uses the data channel, leaving this reusable pairing open. */ }
  dispose() {
    this.disposed = true; clearInterval(this.timer); this.peer.close(); this.stream = null;
  }
}

/* Legacy JPEG previews reuse the scanner frame and its detected corners. */
(() => {
  'use strict';
  const size = 288;
  const prefix = 'data:image/jpeg;base64,';
  function frameSampler() {
    let canvas, ctx, next = 0;
    return (source, markers, wide = false) => {
      const now = performance.now();
      if (now < next || !source?.width || !source.height) return null;
      next = now + 150;
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.width = size;
        ctx = canvas.getContext('2d', {alpha:false});
      }
      const height = wide ? size * 9 / 16 : size;
      if (canvas.height !== height) canvas.height = height;
      // Older boards expect a square centre crop. A wide board shows the entire scanning area.
      const scale = wide ? Math.min(size/source.width, height/source.height) : size/Math.min(source.width, source.height);
      const w = source.width * scale, h = source.height * scale;
      const x = (size - w) / 2, y = (height - h) / 2;
      ctx.fillStyle = '#24394a';
      ctx.fillRect(0, 0, size, height);
      ctx.drawImage(source, x, y, w, h);
      // Mark only corners actually detected in this frame. No names or answers on the image.
      ctx.strokeStyle = '#bce9ff';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (const {corners} of markers) {
        if (corners?.length !== 4) continue;
        for (let i = 0; i < 4; i++) {
          const p = corners[i], before = corners[(i+3)%4], after = corners[(i+1)%4];
          const px = x + p.x*scale, py = y + p.y*scale, arm = .24*scale;
          ctx.moveTo(px+(before.x-p.x)*arm, py+(before.y-p.y)*arm);
          ctx.lineTo(px, py);
          ctx.lineTo(px+(after.x-p.x)*arm, py+(after.y-p.y)*arm);
        }
      }
      ctx.stroke();
      const frame = canvas.toDataURL('image/jpeg', .62);
      return validFrame(frame) ? frame : null;
    };
  }
  const validFrame = value => typeof value === 'string' && value.length < 65536 && value.startsWith(prefix);

  // The data channel carries visibility, corners, or legacy JPEGs. Video uses the same ICE configuration.
  class Peer {
    constructor(id, {onOpen, onMessage, onClose, onTrack, gatherAll=false}, iceServers = []) {
      this.id = id;
      this.pc = new RTCPeerConnection({iceServers,bundlePolicy:'max-bundle'});
      this.gatherAll = gatherAll;
      this.videoSender = null;
      if (onTrack) this.pc.ontrack = ({track}) => {
        if (!this.closed && track.kind === 'video') onTrack(track);
      };
      this.gatherTimeout = iceServers.length ? 8000 : 3000;
      this.onClose = onClose;
      const attach = channel => {
        if (this.closed || this.channel || channel.label !== 'banban-preview') { channel.close(); return; }
        this.channel = channel;
        channel.onopen = () => { clearTimeout(this.deadline); onOpen(); };
        channel.onmessage = event => { if (!this.closed) onMessage(event.data); };
        channel.onclose = channel.onerror = () => this.close();
      };
      this.pc.ondatachannel = event => attach(event.channel);
      this.pc.onconnectionstatechange = () => {
        if (['failed','disconnected','closed'].includes(this.pc.connectionState)) this.close();
      };
      this.createChannel = () => attach(this.pc.createDataChannel('banban-preview'));
    }
    async describe(type, remoteOffer, video) {
      let transceiver;
      if (type === 'offer') {
        this.createChannel();
        if (video === true) this.pc.addTransceiver?.('video', {direction:'recvonly'});
      } else {
        await this.pc.setRemoteDescription({type:'offer', sdp:remoteOffer});
        transceiver = this.pc.getTransceivers?.().find(t => t.receiver.track.kind === 'video');
        if (transceiver) {
          transceiver.direction = video?.kind === 'video' && video.readyState === 'live' ? 'sendonly' : 'inactive';
        }
      }
      const description = type === 'offer' ? await this.pc.createOffer() : await this.pc.createAnswer();
      await this.pc.setLocalDescription(description);
      // Negotiate once. The phone attaches its scanner track when the board sends "show".
      if (transceiver?.currentDirection === 'sendonly') this.videoSender = transceiver.sender;
      // Video and controls share one transport. Once a relay is available, give
      // alternate routes a short chance to arrive. A failed connection retries with the full set.
      if (!this.closed && this.pc.iceGatheringState !== 'complete') await new Promise(resolve => {
        let relayGrace;
        const done = () => {
          clearTimeout(timer); clearTimeout(relayGrace);
          this.pc.removeEventListener('icecandidate', checkRelay);
          this.pc.removeEventListener('icegatheringstatechange', checkComplete);
          this.finishGathering = null; resolve();
        };
        const checkComplete = () => { if (this.pc.iceGatheringState === 'complete') done(); };
        const checkRelay = () => {
          if (!this.gatherAll && !relayGrace && /^a=candidate:.* typ relay(?:\s|$)/m.test(this.pc.localDescription.sdp))
            relayGrace = setTimeout(done,250);
        };
        const timer = setTimeout(done, this.gatherTimeout);
        this.finishGathering = done;
        this.pc.addEventListener('icegatheringstatechange', checkComplete);
        this.pc.addEventListener('icecandidate', checkRelay);
        checkRelay(); checkComplete();
      });
      if (this.closed) throw new Error('取景连接已结束。');
      if (type === 'answer') this.waitForChannel();
      return this.pc.localDescription.sdp;
    }
    waitForChannel() {
      if (this.channel?.readyState !== 'open' && !this.closed) {
        clearTimeout(this.deadline);
        this.deadline = setTimeout(() => this.close(), 12000);
      }
    }
    send(value) {
      if (this.channel?.readyState !== 'open' || this.closed) return;
      try { this.channel.send(value); } catch { this.close(); }
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.deadline);
      this.finishGathering?.();
      this.channel?.close();
      this.pc.close();
      this.onClose();
    }
  }
  window.CardQuizPreview = {frameSampler, validFrame, Peer};
})();

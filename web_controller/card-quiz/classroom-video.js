/* Deliver the current camera track to the native lens independently of marker detection. */
(() => {
  'use strict';
  const prefix = 'data:image/jpeg;base64,';
  class ClassroomVideo {
    constructor(bridge) {
      this.bridge = bridge;
      bridge?.addEventListener('sharedbufferreceived', event => {
        const buffer = event.getBuffer(), data = event.additionalData, run = this.run;
        if (!run || data?.type !== 'preview-buffer' || data.id !== run.id ||
            buffer.byteLength !== 640 * 360 * 4 || run.buffer) {
          bridge.releaseBuffer(buffer);
          return;
        }
        run.buffer = buffer;
        run.pixels = new Uint8Array(buffer);
      });
    }
    set(key, track) {
      if (this.run && this.run.key === key && this.run.track === track) return;
      this.stop();
      if (!key || !track || track.readyState === 'ended') return;
      const shared = typeof this.bridge?.releaseBuffer === 'function';
      const run = this.run = {key, track, id:crypto.randomUUID(), shared, lastTime:-Infinity};
      run.canvas = document.createElement('canvas');
      run.ctx = run.canvas.getContext('2d',{alpha:false,willReadFrequently:true});
      if (shared) this.bridge.postMessage({type:'preview-buffer',key,id:run.id});
      if (typeof MediaStreamTrackProcessor === 'function') {
        try {
          run.reader = new MediaStreamTrackProcessor({track,maxBufferSize:1}).readable.getReader();
          void this.read(run);
          return;
        } catch { /* Some runtimes expose the processor only for a subset of tracks. */ }
      }
      this.play(run);
    }
    async read(run) {
      try {
        while (this.run === run) {
          const {value:frame,done} = await run.reader.read();
          if (done) break;
          try {
            if (this.run === run) this.draw(run,frame,frame.displayWidth,frame.displayHeight,frame.timestamp/1000);
          } finally { frame.close(); }
        }
      } catch {
        if (this.run === run) this.play(run);
      } finally { run.reader.releaseLock(); }
    }
    play(run) {
      const video = run.video = document.createElement('video');
      video.muted = video.playsInline = true;
      video.srcObject = new MediaStream([run.track]);
      // The native wheel can shrink its web document to one pixel. A timer still
      // sees decoded frames when the compositor suspends presentation callbacks.
      video.play().then(() => {
        if (this.run !== run) return;
        run.timer = setInterval(() => {
          if (video.readyState >= 2) this.draw(run,video,video.videoWidth,video.videoHeight,video.currentTime*1000);
        },32);
      }).catch(() => {});
    }
    acknowledge(message) {
      const run = this.run;
      if (!run || run.id !== message.id) return;
      if (message.type === 'preview-buffer-unavailable') {
        run.shared = false;
        if (run.buffer) this.bridge.releaseBuffer(run.buffer);
        run.buffer = run.pixels = null;
      }
      run.busy = false;
    }
    markers(corners) {
      if (!this.run || !Array.isArray(corners) || corners.length > 157) return;
      this.run.corners = corners.filter(card => Array.isArray(card) && card.length === 4 &&
        card.every(p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v) && v >= 0 && v <= 1)));
      this.run.markedAt = performance.now();
    }
    draw(run,source,width,height,time) {
      if (!width || !height || run.busy || (run.shared && !run.pixels) || time-run.lastTime < 28) return;
      run.lastTime = time;
      const canvas = run.canvas, ctx = run.ctx;
      const w = run.shared ? 640 : 288, h = w*9/16;
      if (canvas.width !== w || canvas.height !== h) { canvas.width=w; canvas.height=h; }
      const scale = Math.min(w/width,h/height), dw = width*scale, dh = height*scale;
      const left = (w-dw)/2, top = (h-dh)/2;
      ctx.fillStyle='#24394a'; ctx.fillRect(0,0,w,h);
      ctx.drawImage(source,left,top,dw,dh);
      if (run.corners?.length && performance.now()-run.markedAt < 400) {
        ctx.beginPath(); ctx.strokeStyle='#bce9ff'; ctx.lineWidth=w/180;
        for (const card of run.corners) for (let i=0;i<4;i++) {
          const [x,y]=card[i], [ax,ay]=card[(i+3)%4], [bx,by]=card[(i+1)%4];
          ctx.moveTo(left+(x+.24*(ax-x))*dw,top+(y+.24*(ay-y))*dh);
          ctx.lineTo(left+x*dw,top+y*dh);
          ctx.lineTo(left+(x+.24*(bx-x))*dw,top+(y+.24*(by-y))*dh);
        }
        ctx.stroke();
      }
      if (run.shared) {
        run.pixels.set(ctx.getImageData(0,0,w,h).data);
        run.busy=true; // Never overwrite pixels the native surface is still reading.
        this.bridge.postMessage({type:'preview-pixels',key:run.key,id:run.id});
      } else {
        const frame=canvas.toDataURL('image/jpeg',.65);
        if (frame.startsWith(prefix) && frame.length < 65536)
          this.bridge.postMessage({type:'preview-frame',key:run.key,frame});
      }
    }
    stop() {
      const run=this.run;
      if (!run) return;
      this.run=null;
      clearInterval(run.timer);
      if (run.reader) { try { run.reader.cancel().catch(()=>{}); } catch {} }
      if (run.video) { run.video.pause(); run.video.srcObject=null; }
      if (run.buffer) this.bridge.releaseBuffer(run.buffer);
    }
  }
  window.CardQuizClassroomVideo = ClassroomVideo;
})();

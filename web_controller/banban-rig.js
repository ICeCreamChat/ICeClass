/* Banban's painted 2D rig. No remote runtime, tracking, microphone or model downloads. */
(() => {
  'use strict';
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const angle = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
  const point = (x, y) => ({x, y});
  function rotate(p, origin, a, target = origin) {
    const c = Math.cos(a), s = Math.sin(a), x = p.x - origin.x, y = p.y - origin.y;
    return point(target.x + x*c - y*s, target.y + x*s + y*c);
  }
  // The elbow and wrist retain both bone lengths, including unreachable targets.
  function solveArm(shoulder, wrist, upper, lower, bend = -1) {
    const dx = wrist.x - shoulder.x, dy = wrist.y - shoulder.y;
    const raw = Math.hypot(dx, dy), d = clamp(raw, Math.abs(upper-lower) + .01, upper+lower - .01);
    const nx = raw > 1e-6 ? dx/raw : 0, ny = raw > 1e-6 ? dy/raw : 1;
    const along = (upper*upper - lower*lower + d*d) / (2*d);
    const height = Math.sqrt(Math.max(0, upper*upper - along*along)) * bend;
    return {shoulder, elbow: point(shoulder.x + nx*along - ny*height, shoulder.y + ny*along + nx*height),
      wrist: point(shoulder.x + nx*d, shoulder.y + ny*d)};
  }
  const REST = {
    left: {shoulder: point(139, 430), elbow: point(72, 408), wrist: point(39, 365)},
    right: {shoulder: point(555, 426), elbow: point(589, 484), wrist: point(607, 548)}
  };
  function thinkPath(amount) {
    const rest=REST.right, length=distance(rest.shoulder,rest.elbow)+distance(rest.elbow,rest.wrist);
    const reach=point(rest.shoulder.x+length-.0001,rest.shoulder.y), h=clamp(amount);
    const bezier=(a,b,c,d,t)=>{
      const u=1-t;return point(u*u*u*a.x+3*u*u*t*b.x+3*u*t*t*c.x+t*t*t*d.x,
        u*u*u*a.y+3*u*u*t*b.y+3*u*t*t*c.y+t*t*t*d.y);
    };
    // Take the wrist around the cover before bringing it to the cheek. Keep
    // the elbow's bend direction, so the mitten never flips inside out.
    return h<.5 ? {wrist:bezier(rest.wrist,point(665,537),point(reach.x,470),reach,smooth(0,1,h*2)),bend:-1}
      : {wrist:bezier(reach,point(reach.x,382),point(574,286),point(530,315),smooth(0,1,(h-.5)*2)),bend:-1};
  }
  function skin(p, rest, posed) {
    const abx = rest.wrist.x-rest.shoulder.x, aby = rest.wrist.y-rest.shoulder.y;
    const t = ((p.x-rest.shoulder.x)*abx+(p.y-rest.shoulder.y)*aby) / (abx*abx+aby*aby);
    const w = smooth(.28, .76, t);
    const a=angle(posed.shoulder,posed.elbow)-angle(rest.shoulder,rest.elbow);
    const b=angle(posed.elbow,posed.wrist)-angle(rest.elbow,rest.wrist);
    const delta=Math.atan2(Math.sin(b-a),Math.cos(b-a));
    // Both bones share this joint. Blend their rotations at the joint instead
    // of collapsing the painted elbow by linearly blending opposite points.
    return rotate(p,rest.elbow,a+delta*w,posed.elbow);
  }
  function spring(channel, target, dt, frequency = 15, damping = .88) {
    // Bounded substeps keep the same motion on slow whiteboards and fast displays.
    const steps = Math.max(1, Math.ceil(dt*120)), h = dt/steps;
    for (let i = 0; i < steps; i++) {
      channel.v += ((target-channel.x)*frequency*frequency - 2*damping*frequency*channel.v)*h;
      channel.x += channel.v*h;
    }
    return channel.x;
  }
  function createModel() {
    let intent = {state: 'idle', mood: 'neutral', gesture: '', phase: '', pose: '', attention: '', blink: false, reduced: false};
    let time = 0, stateTime = 0, gestureTime = 0, look = point(0, 0), drag = 0, petIndex = 0, spoken = 10;
    const values = {gazeX: 0, gazeY: 0, lean: 0, lift: 0, nod: 0, turn: 0, think: 0, smile: .25, concern: 0,
      closeLeft: 0, closeRight: 0, mouthOpen: 0, leftX: 39, leftY: 365, rightX: 607, rightY: 548, ribbon: 0};
    const channels = Object.fromEntries(Object.entries(values).map(([k, x]) => [k, {x, v: 0}]));
    function update(next) {
      if (next.state !== undefined && next.state !== intent.state) stateTime = 0;
      if (next.gesture !== undefined && next.gesture !== intent.gesture) gestureTime = 0;
      intent = {...intent, ...next};
    }
    function step(delta) {
      const dt = clamp(delta, 0, .08), still = intent.reduced;
      if (!still) { time += dt; stateTime += dt; gestureTime += dt; spoken += dt; }
      const t = gestureTime, work = ['thinking', 'waiting'].includes(intent.state);
      const listen = intent.attention === 'input' || intent.attention === 'typing';
      const thinking = work && intent.phase !== 'orient';
      let gx = work ? -.42 : listen ? -.12 : look.x;
      let gy = work ? (intent.state === 'waiting' ? -.12 : -.40) : listen ? .60 : look.y;
      let lean = work ? -.035 : intent.state === 'careful' ? -.02 : listen ? .012 : gx*.016;
      let lift = thinking ? -3 : listen ? 1 : 0, nod = 0;
      let smile = intent.mood === 'smile' ? .85 : intent.state === 'connection-error' ? .1 : .3;
      let leftX = 39, leftY = 365, rightX = 607, rightY = 548;
      let closeLeft = intent.blink ? 1 : 0, closeRight = closeLeft;
      const think = intent.pose === 'think' ? 1 : 0;
      // A curved wrist path raises the same painted arm; no pose-image swap.
      const raised = still ? think : channels.think.x;
      rightX = mix(rightX, 512, raised) + Math.sin(raised*Math.PI)*64;
      rightY = mix(rightY, 343, raised);
      if (!still) {
        const waveIn = smooth(.08, .42, t) * (1-smooth(1.95, 2.55, t));
        if (intent.gesture === 'wave') {
          const wrist = Math.sin((t-.35)*14) * smooth(.32, .6, t) * (1-smooth(1.6, 1.95, t));
          leftX += waveIn*(26+wrist*13); leftY -= waveIn*(39+wrist*8);
          lift += Math.sin(clamp(t/2.5)*Math.PI)*-4; lean += waveIn*.022;
          smile = mix(smile, .85, waveIn); closeLeft = Math.max(closeLeft, .16*waveIn);
          closeRight = Math.max(closeRight, .16*waveIn);
        } else if (intent.gesture === 'pet') {
          const envelope = smooth(0, .18, t)*(1-smooth(1.35, 2.1, t));
          smile = mix(smile, 1, envelope); lean += envelope*(petIndex%2 ? .045 : -.04);
          lift += envelope*3;
          const wink = smooth(.12,.26,t)*(1-smooth(.65,.92,t));
          closeLeft = Math.max(closeLeft, wink); closeRight = Math.max(closeRight, petIndex%2 ? wink*.18 : wink);
          leftY -= envelope*9;
        } else if (['answer', 'nod', 'consider'].includes(intent.gesture)) {
          const envelope = Math.sin(clamp(t/2.2)*Math.PI);
          nod = Math.sin(clamp(t/1.8)*Math.PI*2)*.018*(1-smooth(1.4,1.9,t));
          if (intent.gesture === 'answer') { rightX += envelope*24; rightY -= envelope*24; }
          lean += envelope*(intent.gesture === 'consider' ? -.025 : .012);
        } else if (intent.gesture === 'tilt') {
          lean -= .045 * Math.sin(clamp(t/2.6)*Math.PI);
          gx -= .25*Math.sin(clamp(t/2.6)*Math.PI);
        } else if (intent.gesture === 'peek') {
          gx = t < 1.4 ? -.5 : .35; gy = -.15;
        } else if (intent.gesture === 'notice') {
          lift -= 4*Math.sin(clamp(t/1.5)*Math.PI); smile += .2;
        }
        if (intent.state === 'dragging') { lean += drag; lift -= 6; leftY -= 12; rightX += 12; }
      }
      const concern = ['thinking', 'waiting'].includes(intent.mood) ? .6 : 0;
      const breath = still ? 0 : Math.sin(time*1.2)*1.5;
      const targets = {gazeX: gx, gazeY: gy, lean, lift: lift+breath, nod,
        turn: gx*.035, think, smile, concern, closeLeft, closeRight, leftX, leftY, rightX, rightY,
        // A short response to arriving text, never an endless fake lip-sync loop.
        mouthOpen: !still && intent.state === 'answering' && spoken < .28 ? Math.sin(spoken/.28*Math.PI)*.48 : 0,
        ribbon: lean*1.9 + (still ? 0 : Math.sin(time*1.1)*.012)};
      for (const k of Object.keys(values)) {
        if (still) { channels[k].x = targets[k]; channels[k].v = 0; }
        else spring(channels[k], targets[k], dt, k === 'closeLeft' ? 58 : k === 'closeRight' ? 51 : k.startsWith('gaze') ? 23 : k === 'ribbon' ? 8 : 14, k === 'ribbon' ? .58 : .9);
        values[k] = channels[k].x;
      }
      if(values.think>.001){const path=thinkPath(values.think);values.rightX=path.wrist.x;values.rightY=path.wrist.y;}
      return {...values, reduced: still};
    }
    return {update, step, look(x, y) { look = point(clamp(x,-1,1), clamp(y,-1,1)); },
      drag(value) { drag = clamp(value,-.12,.12); }, pet() { petIndex++; gestureTime = 0; },
      text() { if (spoken > .19) spoken = 0; }, snapshot: () => ({...values})};
  }
  function deformBody(p, pose) {
    const influence = smooth(645, 90, p.y);
    const result = rotate(p, point(343, 642), pose.lean*influence);
    result.x += pose.turn*105*influence;
    result.y += (pose.lift + pose.nod*(p.x-340))*influence;
    return result;
  }
  const core = {clamp, smooth, mix, solveArm, spring, skin, REST, thinkPath, createModel, deformBody};
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (typeof window === 'undefined') return;
  window.ICeClassBanbanRigCore = core;

  let texturePromise;
  const textureNames = ['body', 'arm-left', 'arm-right', 'bookmark', 'mas', 'mouth', 'mouth-happy',
    'rig/forearm-right', 'rig/socket-left', 'rig/socket-right', 'rig/iris-left', 'rig/iris-right',
    'rig/lash-left', 'rig/lash-right', 'rig/smile-left', 'rig/smile-right'];
  function textures() {
    return texturePromise ||= Promise.all(textureNames.map(name => new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve([name, image]); image.onerror = () => reject(new Error('Banban texture: '+name));
      image.src = `/assets/banban/${name}.webp?v=1`;
    }))).then(Object.fromEntries).catch(error => { texturePromise = null; throw error; });
  }
  function triangle(ctx, image, source, dest) {
    const [s0,s1,s2] = source, [d0,d1,d2] = dest;
    const u1=s1.x-s0.x, v1=s1.y-s0.y, u2=s2.x-s0.x, v2=s2.y-s0.y, det=u1*v2-u2*v1;
    if (Math.abs(det)<1e-6) return;
    const x1=d1.x-d0.x, y1=d1.y-d0.y, x2=d2.x-d0.x, y2=d2.y-d0.y;
    const a=(x1*v2-x2*v1)/det, c=(x2*u1-x1*u2)/det, b=(y1*v2-y2*v1)/det, d=(y2*u1-y1*u2)/det;
    const cx=(d0.x+d1.x+d2.x)/3, cy=(d0.y+d1.y+d2.y)/3;
    ctx.save(); ctx.beginPath();
    // Tiny overlap removes subpixel cracks between adjacent painted triangles.
    dest.forEach((p,i) => { const dx=p.x-cx,dy=p.y-cy,l=Math.hypot(dx,dy)||1; ctx[i?'lineTo':'moveTo'](p.x+dx/l*.55,p.y+dy/l*.55); });
    ctx.closePath(); ctx.clip(); ctx.transform(a,b,c,d,d0.x-a*s0.x-c*s0.y,d0.y-b*s0.x-d*s0.y);
    ctx.drawImage(image,0,0); ctx.restore();
  }
  function mesh(ctx, image, rect, map, columns=5, rows=7) {
    const [x,y,w,h]=rect, src=[],dst=[];
    for(let j=0;j<=rows;j++) for(let i=0;i<=columns;i++) {
      src.push(point(image.width*i/columns,image.height*j/rows));
      dst.push(map(point(x+w*i/columns,y+h*j/rows)));
    }
    for(let j=0;j<rows;j++) for(let i=0;i<columns;i++) {
      const a=j*(columns+1)+i,b=a+1,c=a+columns+1,d=c+1;
      for(const ids of [[a,b,d],[a,d,c]]) triangle(ctx,image,ids.map(k=>src[k]),ids.map(k=>dst[k]));
    }
  }
  function stamp(ctx,image,rect,body,rotation=0) {
    const [x,y,w,h]=rect, origin=point(x+w/2,y+h/2), center=deformBody(origin,body);
    ctx.save(); ctx.translate(center.x,center.y); ctx.rotate(body.lean*smooth(645,90,origin.y)+rotation);
    ctx.drawImage(image,-w/2,-h/2,w,h); ctx.restore();
  }
  function createPainter(canvas, images) {
    const ctx=canvas.getContext('2d');
    if(!ctx) throw new Error('Canvas 2D unavailable');
    const eyes={};
    for(const side of ['left','right']) {
      const eye=document.createElement('canvas'), image=images['rig/socket-'+side];
      eye.width=image.width; eye.height=image.height; eyes[side]=eye;
    }
    const mouth=document.createElement('canvas');mouth.width=82;mouth.height=42;
    mouth.getContext('2d').drawImage(images['mouth-happy'],291,311,82,42,0,0,82,42);
    function paint(p) {
      ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);
      const scale=canvas.width/796;ctx.scale(scale,scale);ctx.translate(68,64);
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
      const detailed=canvas.width>320;
      const body=q=>deformBody(q,p);
      const arms={};
      for(const side of ['left','right']) {
        const rest=REST[side], shoulder=body(rest.shoulder);
        const wrist=body(point(p[side+'X'],p[side+'Y']));
        const bend=side==='right'&&p.think>.001?thinkPath(p.think).bend:-1;
        const posed=solveArm(shoulder,wrist,distance(rest.shoulder,rest.elbow),distance(rest.elbow,rest.wrist),bend);
        arms[side]=q=>skin(q,rest,posed);
        mesh(ctx,images['arm-'+side],side==='left'?[0,327,150,140]:[540,410,114,170],arms[side],detailed?4:3,6);
      }
      mesh(ctx,images.body,[100,60,500,629],body,detailed?6:4,detailed?10:7);
      // The bookmark bends at its attachment and follows the cover with a delay.
      mesh(ctx,images.bookmark,[423,54,108,110],q=>{
        const f=smooth(55,160,q.y),r=rotate(q,point(500,62),p.ribbon*f);return body(r);
      },detailed?3:2,detailed?5:4);
      stamp(ctx,images.mas,[246,386,146,146],p);
      for(const side of ['left','right']) {
        const rect=side==='left'?[187,217,106,91]:[378,225,106,91];
        const eye=eyes[side], ec=eye.getContext('2d'), closed=clamp(p[side==='left'?'closeLeft':'closeRight']);
        const openness=(1-closed)*(1-p.concern*.12);
        const eyeCenter=eye.height*.6;
        ec.clearRect(0,0,eye.width,eye.height);
        ec.save();ec.translate(0,eyeCenter*(1-openness));ec.scale(1,Math.max(.015,openness));
        ec.drawImage(images['rig/socket-'+side],0,0);ec.restore();
        // The lids occlude a round iris. The iris itself is never squashed shut.
        ec.globalCompositeOperation='source-atop';ec.drawImage(images['rig/iris-'+side],p.gazeX*7,p.gazeY*4);ec.globalCompositeOperation='source-over';
        ec.save();ec.translate(0,eyeCenter*(1-openness));ec.scale(1,Math.max(.015,openness));
        ec.drawImage(images['rig/lash-'+side],0,0);ec.restore();
        ctx.globalAlpha=1-smooth(.78,.98,closed);
        mesh(ctx,eye,rect,q=>{
          const nx=(q.x-rect[0])/rect[2];
          const y=q.y + p.concern*(side==='left'?nx:1-nx)*4;
          return body(point(q.x+p.turn*26,y));
        },detailed?4:3,detailed?4:2);
        ctx.globalAlpha=smooth(.60,.96,closed);
        if(ctx.globalAlpha>.001) {
          const box=side==='left'?[175,205,135,115]:[365,205,135,120];
          stamp(ctx,images['rig/smile-'+side],box,p,side==='left'?-p.concern*.025:p.concern*.025);
        }
        ctx.globalAlpha=1;
      }
      const open=clamp(p.mouthOpen);
      ctx.globalAlpha=1-smooth(.12,.38,open);
      mesh(ctx,images.mouth,[291,320,82,24],q=>{
        const x=(q.x-291)/82, arch=4*x*(1-x);
        return body(point(q.x+p.turn*16,q.y-p.concern*29*arch+(p.smile-.3)*5*arch));
      },detailed?6:4,detailed?2:1);
      ctx.globalAlpha=smooth(.12,.38,open);
      if(ctx.globalAlpha>.001) stamp(ctx,mouth,[307,324,47,27],p);
      ctx.globalAlpha=1;
      mesh(ctx,images['rig/forearm-right'],[540,410,114,170],arms.right,detailed?4:3,6);
    }
    return paint;
  }
  window.ICeClassBanbanRig = root => {
    const slots=[...root.querySelectorAll('.bb-mascot')], model=createModel();
    const canvas=document.createElement('canvas');canvas.className='bb-canvas';canvas.setAttribute('aria-hidden','true');
    let disposed=false, ready=false, failed=false, paused=false, reduced=false, current=null, paint=null, raf=0, last=0, lastDraw=0;
    let resizeObserver=null, mutationObserver=null, rect=null, drawn=0;
    const visible=slot=>slot.isConnected && !slot.closest('[hidden]') && slot.getBoundingClientRect().width>0;
    function size() {
      if(!current)return;
      rect=current.getBoundingClientRect();
      // One small shared surface, capped at 2x; no full-window canvas or GPU requirement.
      const width=Math.max(96,Math.min(640,Math.ceil(rect.width*796/660*Math.min(devicePixelRatio||1,2))));
      if(canvas.width!==width){canvas.width=width;canvas.height=Math.round(width*848/796);}
    }
    function stop(){if(raf)cancelAnimationFrame(raf);raf=0;last=0;lastDraw=0;}
    function drawStatic(){if(ready&&current&&paint){paint(model.step(0));canvas.dataset.frame=String(++drawn);}}
    function tick(now){
      raf=0;if(disposed||paused||reduced||!current||document.hidden)return;
      if(!last)last=now;
      const dt=(now-last)/1000;
      if(!lastDraw||now-lastDraw>=32){const p=model.step(dt);last=now;lastDraw=now;paint(p);canvas.dataset.frame=String(++drawn);}
      raf=requestAnimationFrame(tick);
    }
    function resume(){if(!disposed&&ready&&!paused&&!reduced&&current&&!document.hidden&&!raf)raf=requestAnimationFrame(tick);}
    function refresh(){
      if(disposed)return;
      const next=slots.find(visible)||null;
      if(next!==current){
        stop();current?.classList.remove('bb-rig-mounted');resizeObserver?.disconnect();current=next;
        if(current&&ready){current.append(canvas);current.classList.add('bb-rig-mounted');resizeObserver?.observe(current);size();drawStatic();}
      }
      if(!current||document.hidden||paused||reduced)stop();else resume();
    }
    function update(state){
      if(disposed)return;
      const wasReduced=reduced;reduced=!!state.reduced;paused=!!state.paused;
      model.update(state);refresh();
      if(reduced&&!wasReduced){stop();drawStatic();}else if(reduced)drawStatic();
      else if(!paused)resume();
    }
    textures().then(images=>{
      if(disposed)return;
      try{
        paint=createPainter(canvas,images);ready=true;
        resizeObserver=new ResizeObserver(()=>{size();drawStatic();});
        mutationObserver=new MutationObserver(refresh);
        mutationObserver.observe(root,{subtree:true,attributes:true,attributeFilter:['hidden']});
        root.dataset.bbRenderer='art-mesh';const slot=current;current=null;slot?.classList.remove('bb-rig-mounted');refresh();
      }catch(error){failed=true;root.dataset.bbRenderer='portrait';console.warn('Banban kept the painted portrait:',error.message);}
    }).catch(()=>{failed=true;root.dataset.bbRenderer='portrait';});
    document.addEventListener('visibilitychange',refresh);
    return {
      update, refresh, look(x,y){model.look(x,y);}, drag(value){model.drag(value);}, pet(){model.pet();}, text(){model.text();},
      dispose(){disposed=true;stop();resizeObserver?.disconnect();mutationObserver?.disconnect();document.removeEventListener('visibilitychange',refresh);current?.classList.remove('bb-rig-mounted');canvas.remove();},
      // Read-only inspection aids local acceptance; never includes conversation data.
      status:()=>({ready,failed,frames:drawn,animating:!!raf,slot:current?.parentElement?.id||'',pose:model.snapshot()})
    };
  };
})();

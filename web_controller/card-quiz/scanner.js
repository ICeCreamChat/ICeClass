(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./vendor/aruco.js'));else root.CardQuizScanner=factory(root.ICeCardAR);})(globalThis,function(AR){
  'use strict';
  const frameSignalMaxAge=1000;
  const confirmInterval=75, searchInterval=150;
  function answerFromCorners(corners){
    if(!Array.isArray(corners)||corners.length!==4)return'';
    const dx=corners[0].x-corners[2].x,dy=corners[0].y-corners[2].y;
    if(!Number.isFinite(dx)||!Number.isFinite(dy)||Math.hypot(dx,dy)<1)return'';
    const angle=Math.atan2(dy,dx)*180/Math.PI;
    if(Math.abs(angle-Math.round(angle/90)*90)<8)return'';
    return angle>0?(angle<90?'C':'B'):(angle> -90?'D':'A');
  }
  function samePixels(previous,current){
    if(!previous || previous.length!==current.length)return false;
    for(let i=0;i<current.length;i++)if(previous[i]!==current[i])return false;
    return true;
  }
  class Stabilizer{
    constructor(){this.entries=new Map();this.visible=new Map();this.held=new Map();this.reset();}
    reset(){this.entries.clear();this.visible.clear();this.held.clear();this.frame=0;this.conflicts=[];this.needsEvidence=false;}
    cardsInView(){
      const cards=this.cardsOnHold();
      for(const [number,card] of this.visible) if(this.frame-card.frame<3) cards.set(number,card.option);
      return cards;
    }
    cardsOnHold(){return new Map([...this.held].map(([number,card])=>[number,card.option]));}
    waitForNewPresentation(cards){
      for(const [number,option] of cards || []) this.held.set(number,{option,absent:0});
    }
    forget(number){this.entries.delete(number);}
    discardCandidates(){
      this.needsEvidence=false;
      for(const entry of this.entries.values()){
        entry.history=[];entry.streak=0;
      }
    }
    feed(markers,at,optionCount=4){
      this.frame++;this.conflicts=[];this.needsEvidence=false;const groups=new Map(),results=[];
      for(const merged of markers)for(const marker of merged.observations||[merged]){
        if(marker.id!==merged.id)continue;
        if(!Number.isInteger(marker.id)||marker.id<0||marker.id>=157)continue;
        const number=marker.id+1,option=answerFromCorners(marker.corners);
        if(!groups.has(number))groups.set(number,[]);
        groups.get(number).push({option,distance:marker.hammingDistance??0});
      }
      // During a change of item, an unchanged card must leave three fresh frames
      // or turn to a different stable orientation before it can answer again.
      for(const [number,card] of this.held){
        if(groups.has(number)) card.absent=0;
        else if(++card.absent>=3) this.held.delete(number);
      }
      for(const [number,reads]of groups){
        let entry=this.entries.get(number);if(!entry){entry={history:[],committed:'',run:'',streak:0,lastFrame:0};this.entries.set(number,entry);}
        const options=new Set(reads.map(x=>x.option).filter(Boolean));
        const option=options.size===1?[...options][0]:'';
        this.visible.set(number,{option,frame:this.frame});
        if(options.size>1)this.conflicts.push(number);
        if(options.size!==1||reads.some(x=>!x.option)||!'ABCD'.slice(0,optionCount).includes(option)){
          entry.history=[];entry.run='';entry.streak=0;continue;
        }
        const held=this.held.get(number);
        if(held&&(!held.option||held.option===option)){entry.history=[];entry.run='';entry.streak=0;continue;}
        const distance=Math.min(...reads.map(x=>x.distance));if(distance>1||option===entry.committed)continue;
        entry.history=entry.history.filter(x=>this.frame-x.frame<20&&at-x.at<=3000);
        entry.history.push({option,weight:distance===0?2:1,frame:this.frame,at});
        entry.streak=entry.run===option&&entry.lastFrame===this.frame-1?entry.streak+1:1;
        entry.run=option;entry.lastFrame=this.frame;
        const score=entry.history.filter(x=>x.option===option).reduce((sum,x)=>sum+x.weight,0);
        if(score>=6&&entry.streak>=3){
          this.held.delete(number);entry.committed=option;entry.history=[];
          entry.submission={cardNumber:number,option};results.push(entry.submission);
        }else this.needsEvidence=true;
      }
      for(const [number,e]of this.entries)if(at-(e.history.at(-1)?.at??0)>10000&&!e.committed)this.entries.delete(number);
      return results;
    }
  }
  class CardQuizScanner{
    constructor({video,onRead,onPreview,onStatus=()=>{},readTrack=false,waitForFrames=false}){
      this.video=video;this.onRead=onRead;this.onPreview=onPreview;this.onStatus=onStatus;
      this.readTrack=readTrack;this.waitForFrames=waitForFrames;
      this.stabilizer=new Stabilizer();this.optionCount=4;this.running=false;this.opening=0;
      this.contextKey='';this.contextRevision=0;this.starting=null;
    }
    reset(key,optionCount=4,presentationKey=key){
      if(this.contextKey===key&&this.optionCount===optionCount)return;
      if(this.presentationKey!==presentationKey)this.heldCards=null;
      else if(this.running)this.heldCards=this.stabilizer.cardsOnHold();
      this.presentationKey=presentationKey;this.contextKey=key;this.optionCount=optionCount;this.contextRevision++;
      this.stabilizer.reset();this.stabilizer.waitForNewPresentation(this.heldCards);
    }
    cardsInView(){return this.running?this.stabilizer.cardsInView():this.heldCards;}
    waitForNewPresentation(cards){
      this.heldCards=cards;
      if(this.running)this.stabilizer.waitForNewPresentation(cards);
    }
    async start(){
      if(this.running)return;
      if(this.starting)return this.starting;
      if(!globalThis.isSecureContext)throw new Error('摄像头需要 HTTPS 或本机安全页面，请检查访问网址。');
      if(!navigator.mediaDevices?.getUserMedia)throw new DOMException('当前环境无法访问摄像头。','NotSupportedError');
      const opening=++this.opening,operation=this.open(opening);this.starting=operation;
      try{await operation;}finally{if(this.starting===operation)this.starting=null;}
    }
    async open(opening){
      let stream;
      try{stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}}});}
      catch(error){if(opening!==this.opening)return;throw error;}
      let released=false;
      const ended=()=>{if(opening===this.opening)this.cameraError('相机连接已结束，请重新开启相机。');};
      const release=()=>{
        if(released)return;released=true;
        for(const track of stream.getTracks()){track.removeEventListener('ended',ended);if(track.readyState!=='ended')track.stop();}
        if(this.video.srcObject===stream)this.video.srcObject=null;
        if(this.stream===stream){this.stream=null;this.releaseStream=null;}
      };
      if(opening!==this.opening){release();return;}
      this.releaseStream=release;
      this.stream=stream;this.video.srcObject=stream;
      const tracks=stream.getVideoTracks();
      for(const track of tracks)track.addEventListener('ended',ended,{once:true});
      if(!tracks.length||tracks.some(track=>track.readyState==='ended')){ended();return;}
      this.onStatus({kind:'starting',message:'正在打开相机预览…'});
      let previewTimer;
      try{
        const playback=Promise.resolve(this.video.play());
        if(this.waitForFrames){
          // A live camera can deliver its first frame after play() has been pending for several seconds.
          playback.catch(()=>{
            if(opening===this.opening)this.cameraError('相机预览未能打开，请重新开启相机。');
          });
        }else{
          await Promise.race([playback,new Promise((_,reject)=>{
            previewTimer=setTimeout(()=>reject(new Error('preview timeout')),8000);
          })]);
        }
      }catch(error){
        if(opening!==this.opening){release();return;}
        this.stop();throw new Error('相机预览未能打开，请重新开启相机。');
      }finally{clearTimeout(previewTimer);}
      if(opening!==this.opening){release();return;}
      try{
        this.canvas=document.createElement('canvas');this.ctx=this.canvas.getContext('2d',{willReadFrequently:true});
        this.detector=new AR.Detector({dictionaryName:'QCMCAM_4X4_157h3',maxHammingDistance:2});
        if(this.readTrack && typeof MediaStreamTrackProcessor === 'function')
          this.reader=new MediaStreamTrackProcessor({track:tracks[0],maxBufferSize:1}).readable.getReader();
      }catch(error){this.stop();throw error;}
      this.running=true;this.lastFrame=null;this.lastFrameSource=null;this.sawFrameCounter=false;this.frameCounts={};
      this.waitingForFrames=this.waitForFrames;
      this.previewStartedAt=this.lastFrameAt=performance.now();this.stabilizer.reset();
      this.stabilizer.waitForNewPresentation(this.heldCards);
      this.onStatus(this.waitingForFrames?{kind:'starting',message:'等待相机画面…'}:{kind:'ready',message:'相机已开启'});
      this.tick();
    }
    cameraError(message){
      this.stop();this.onStatus({kind:'error',message});
    }
    recentFrameCount(kind,value,now){
      if(!Number.isFinite(value)||value<=0)return null;
      let sample=this.frameCounts[kind];
      if(sample?.value!==value){
        sample={kind,value,changedAt:now};
        this.frameCounts[kind]=sample;
      }
      return now-sample.changedAt<frameSignalMaxAge?sample:null;
    }
    previewFrame(video,now){
      const hasCallback=typeof video.requestVideoFrameCallback==='function';
      if(hasCallback){
        if(this.frameCallback==null){
          const opening=this.opening;
          this.frameCallback=video.requestVideoFrameCallback((_,metadata)=>{
            if(opening!==this.opening)return;
            this.frameCallback=null;
            const count=metadata?.presentedFrames??(this.presentedFrame??0)+1;
            if(count===this.presentedFrame)return;
            this.presentedFrame=count;
            this.presentedAt=performance.now();
            if(this.waitingForFrames){
              clearTimeout(this.timer);
              this.timer=setTimeout(()=>this.tick(),0);
            }
          });
        }
        if(this.presentedFrame!=null && now-this.presentedAt<frameSignalMaxAge)
          return {kind:'presented',value:this.presentedFrame};
      }
      const quality=video.getVideoPlaybackQuality?.();
      const decoded=quality?.totalVideoFrames-(quality?.droppedVideoFrames||0);
      // Either counter can freeze at a positive value on a live camera.
      const standard=this.recentFrameCount('decoded',decoded,now);
      const webkit=this.recentFrameCount('webkit',video.webkitDecodedFrameCount,now);
      if(standard||webkit)return standard||webkit;
      if(hasCallback && this.presentedFrame==null && now-this.previewStartedAt<frameSignalMaxAge)
        return {kind:'presented',value:this.presentedFrame};
      // Without frame metadata, only a changed image can confirm a card.
      return {kind:'pixels',value:video.currentTime};
    }
    captureImage(source,width,height){
      // Keep the entire camera view and its rear-row cells, independently of preview size.
      const scale=Math.min(1,1920/Math.max(width,height),Math.sqrt(1920*1080/(width*height)));
      const w=Math.max(1,Math.round(width*scale)),h=Math.max(1,Math.round(height*scale));
      if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
      this.ctx.drawImage(source,0,0,w,h);
      return this.ctx.getImageData(0,0,w,h);
    }
    async tick(){
      if(!this.running)return;const started=performance.now();
      const reader=this.reader,revision=this.contextRevision;
      let captured,timeout;
      try{
        const v=this.video;
        const tracks=this.stream.getVideoTracks();
        if(!tracks.length||tracks.some(track=>track.readyState==='ended')){this.cameraError('相机连接已结束，请重新开启相机。');return;}
        const muted=this.waitForFrames && tracks.some(track=>track.muted);
        let source=v,width=v.videoWidth,height=v.videoHeight,frame,frameSource='track';
        if(reader){
          // A small or covered pet can stop presenting preview frames while its camera is still live.
          timeout=setTimeout(()=>{if(this.reader===reader)this.cameraError('相机画面已停止更新，请重新开启相机。');},3000);
          const result=await reader.read(); captured=result.value;
          if(this.reader!==reader)return;
          if(result.done){this.cameraError('相机连接已结束，请重新开启相机。');return;}
          source=captured;width=captured.displayWidth;height=captured.displayHeight;frame=captured.timestamp;
        }else{
          const sample=this.previewFrame(v,started);
          frame=sample.value;frameSource=sample.kind;
        }
        const byPixels=frameSource==='pixels';
        const changedSource=this.lastFrameSource!=null && frameSource!==this.lastFrameSource;
        const advanced=Number.isFinite(frame) && (frame!==this.lastFrame || changedSource);
        if(!muted&&(captured||v.readyState>=2)&&width&&height&&(byPixels||advanced)){
          // A new counter may describe the frame already scanned. Only the pixel
          // fallback needs a readback on handover, to establish its reference.
          let image,fresh=true;
          if(byPixels || (!changedSource && revision===this.contextRevision)){
            image=this.captureImage(source,width,height);
            if(!reader){
              const pixels=new Uint32Array(image.data.buffer,image.data.byteOffset,image.data.byteLength/4);
              if(byPixels)fresh=!samePixels(this.lastPixels,pixels);
              this.lastPixels=pixels;
            }
          }
          this.lastFrame=frame;this.lastFrameSource=frameSource;
          if(!byPixels)this.sawFrameCounter=true;
          if(fresh || (!this.waitForFrames && !this.sawFrameCounter && advanced))this.lastFrameAt=started;
          if(fresh && this.waitingForFrames){
            this.waitingForFrames=false;
            this.onStatus({kind:'ready',message:'相机已开启'});
          }
          if(image && fresh && !changedSource && revision===this.contextRevision){
            const markers=this.scanImage(image);
            try { this.onPreview?.(this.canvas,markers); } catch { /* Preview cannot interrupt recognition. */ }
          }
        }
        if(muted||started-this.lastFrameAt>=3000){
          if(!this.waitForFrames){this.cameraError('相机画面已停止更新，请重新开启相机。');return;}
          if(!this.waitingForFrames){
            this.waitingForFrames=true;
            this.stabilizer.discardCandidates();
            this.onStatus({kind:'warning',message:'等待相机画面…'});
          }
        }
      }catch(error){
        if(reader && this.reader!==reader)return;
        if(reader){this.cameraError('相机画面无法读取，请重新开启相机。');return;}
        this.onStatus({kind:'error',message:'识别未完成，请检查相机或重新开启。'});
      }finally{clearTimeout(timeout);captured?.close();}
      let interval=this.stabilizer.needsEvidence?confirmInterval:searchInterval;
      if(this.waitingForFrames)interval=started-this.previewStartedAt<frameSignalMaxAge?confirmInterval:500;
      if(this.running)this.timer=setTimeout(()=>this.tick(),Math.max(30,interval-(performance.now()-started)));
    }
    scanImage(image){
      const markers=this.detector.detect(image);
      const opening=this.opening,context=this.contextRevision,current=()=>this.running&&opening===this.opening&&context===this.contextRevision;
      for(const read of this.stabilizer.feed(markers,Date.now(),this.optionCount))Promise.resolve().then(()=>{if(current())return this.onRead(read);}).catch(error=>{
        if(!current()||this.stabilizer.entries.get(read.cardNumber)?.submission!==read)return;
        this.stabilizer.forget(read.cardNumber);this.onStatus({kind:'error',message:error?.message||'作答提交未完成，请重试。'});
      });
      if(this.stabilizer.conflicts.length)this.onStatus({kind:'warning',message:`重复卡号方向冲突：${this.stabilizer.conflicts.join('、')}`});
      return markers;
    }
    stop(){
      if(this.running)this.heldCards=this.stabilizer.cardsOnHold();
      ++this.opening;this.starting=null;this.running=false;clearTimeout(this.timer);
      if(this.frameCallback!=null)this.video.cancelVideoFrameCallback?.(this.frameCallback);
      this.frameCallback=null;this.presentedFrame=null;this.lastPixels=null;
      const reader=this.reader;this.reader=null;
      if(reader)reader.cancel().catch(()=>{}).finally(()=>reader.releaseLock());
      this.releaseStream?.();this.stream=null;this.video.srcObject=null;this.stabilizer.reset();
    }
  }
  CardQuizScanner.Stabilizer=Stabilizer;CardQuizScanner.answerFromCorners=answerFromCorners;
  return CardQuizScanner;
});

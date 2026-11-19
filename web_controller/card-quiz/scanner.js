(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./vendor/aruco.js'));else root.CardQuizScanner=factory(root.ICeCardAR);})(globalThis,function(AR){
  'use strict';
  function answerFromCorners(corners){
    if(!Array.isArray(corners)||corners.length!==4)return'';
    const dx=corners[0].x-corners[2].x,dy=corners[0].y-corners[2].y;
    if(!Number.isFinite(dx)||!Number.isFinite(dy)||Math.hypot(dx,dy)<1)return'';
    const angle=Math.atan2(dy,dx)*180/Math.PI;
    if(Math.abs(angle-Math.round(angle/90)*90)<8)return'';
    return angle>0?(angle<90?'C':'B'):(angle> -90?'D':'A');
  }
  class Stabilizer{
    constructor(){this.entries=new Map();this.frame=0;this.conflicts=[];}
    reset(){this.entries.clear();this.frame=0;this.conflicts=[];}
    forget(number){this.entries.delete(number);}
    feed(markers,at,optionCount=4){
      this.frame++;this.conflicts=[];const groups=new Map(),results=[];
      for(const merged of markers)for(const marker of merged.observations||[merged]){
        if(marker.id!==merged.id)continue;
        if(!Number.isInteger(marker.id)||marker.id<0||marker.id>=157)continue;
        const number=marker.id+1,option=answerFromCorners(marker.corners);
        if(!groups.has(number))groups.set(number,[]);
        groups.get(number).push({option,distance:marker.hammingDistance??0});
      }
      for(const [number,reads]of groups){
        let entry=this.entries.get(number);if(!entry){entry={history:[],committed:'',run:'',streak:0,lastFrame:0};this.entries.set(number,entry);}
        const options=new Set(reads.map(x=>x.option).filter(Boolean));
        const option=options.size===1?[...options][0]:'';
        if(options.size>1)this.conflicts.push(number);
        if(options.size!==1||reads.some(x=>!x.option)||!'ABCD'.slice(0,optionCount).includes(option)){
          entry.history=[];entry.run='';entry.streak=0;continue;
        }
        const distance=Math.min(...reads.map(x=>x.distance));if(distance>1)continue;
        entry.history=entry.history.filter(x=>this.frame-x.frame<20&&at-x.at<=3000);
        entry.history.push({option,weight:distance===0?2:1,frame:this.frame,at});
        entry.streak=entry.run===option&&entry.lastFrame===this.frame-1?entry.streak+1:1;
        entry.run=option;entry.lastFrame=this.frame;
        const score=entry.history.filter(x=>x.option===option).reduce((sum,x)=>sum+x.weight,0);
        if(score>=6&&entry.streak>=3&&option!==entry.committed){entry.committed=option;results.push({cardNumber:number,option});entry.history=entry.history.filter(x=>x.option===option);}
      }
      for(const [number,e]of this.entries)if(at-(e.history.at(-1)?.at??0)>10000&&!e.committed)this.entries.delete(number);
      return results;
    }
  }
  class CardQuizScanner{
    constructor({video,onRead,onStatus=()=>{}}){this.video=video;this.onRead=onRead;this.onStatus=onStatus;this.stabilizer=new Stabilizer();this.optionCount=4;this.running=false;this.opening=0;this.contextKey='';this.contextRevision=0;this.starting=null;}
    reset(key,optionCount=4){if(this.contextKey!==key||this.optionCount!==optionCount){this.contextKey=key;this.optionCount=optionCount;this.contextRevision++;this.stabilizer.reset();}}
    async start(){
      if(this.running)return;
      if(this.starting)return this.starting;
      if(!globalThis.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error('摄像头需要 HTTPS 或本机安全页面，请检查访问网址。');
      const opening=++this.opening,operation=this.open(opening);this.starting=operation;
      try{await operation;}finally{if(this.starting===operation)this.starting=null;}
    }
    async open(opening){
      let stream;
      try{stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});}
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
      try{await this.video.play();}catch(error){if(opening!==this.opening){release();return;}this.stop();throw new Error('相机预览未能打开，请重试。');}
      if(opening!==this.opening){release();return;}
      try{
        this.canvas=document.createElement('canvas');this.ctx=this.canvas.getContext('2d',{willReadFrequently:true});
        this.detector=new AR.Detector({dictionaryName:'QCMCAM_4X4_157h3',maxHammingDistance:2});
      }catch(error){this.stop();throw error;}
      this.running=true;this.lastFrame=null;this.lastFrameAt=performance.now();this.stabilizer.reset();
      this.onStatus({kind:'ready',message:'相机已开启'});this.tick();
    }
    cameraError(message){
      this.stop();this.onStatus({kind:'error',message});
    }
    tick(){
      if(!this.running)return;const started=performance.now();
      try{
        const v=this.video;
        if(this.stream.getVideoTracks().some(track=>track.readyState==='ended')){this.cameraError('相机连接已结束，请重新开启相机。');return;}
        const quality=v.getVideoPlaybackQuality?.(),frame=Number.isFinite(quality?.totalVideoFrames)?quality.totalVideoFrames-(quality.droppedVideoFrames||0):v.currentTime;
        if(v.readyState>=2&&v.videoWidth&&v.videoHeight&&Number.isFinite(frame)&&frame!==this.lastFrame){
          this.lastFrame=frame;this.lastFrameAt=started;
          const scale=Math.min(1,960/v.videoWidth),w=Math.round(v.videoWidth*scale),h=Math.round(v.videoHeight*scale);
          if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
          this.ctx.drawImage(v,0,0,w,h);const markers=this.detector.detect(this.ctx.getImageData(0,0,w,h));
          const opening=this.opening,context=this.contextRevision,current=()=>this.running&&opening===this.opening&&context===this.contextRevision;
          for(const read of this.stabilizer.feed(markers,Date.now(),this.optionCount))Promise.resolve().then(()=>{if(current())return this.onRead(read);}).catch(error=>{
            if(!current()||this.stabilizer.entries.get(read.cardNumber)?.committed!==read.option)return;
            this.stabilizer.forget(read.cardNumber);this.onStatus({kind:'error',message:error?.message||'作答提交未完成，请重试。'});
          });
          if(this.stabilizer.conflicts.length)this.onStatus({kind:'warning',message:`重复卡号方向冲突：${this.stabilizer.conflicts.join('、')}`});
        }else if(started-this.lastFrameAt>=3000){this.cameraError('相机画面已停止更新，请重新开启相机。');return;}
      }catch(error){this.onStatus({kind:'error',message:'识别未完成，请检查相机或重新开启。'});}
      if(this.running)this.timer=setTimeout(()=>this.tick(),Math.max(30,180-(performance.now()-started)));
    }
    stop(){++this.opening;this.starting=null;this.running=false;clearTimeout(this.timer);this.releaseStream?.();this.stream=null;this.video.srcObject=null;this.stabilizer.reset();}
  }
  CardQuizScanner.Stabilizer=Stabilizer;CardQuizScanner.answerFromCorners=answerFromCorners;
  return CardQuizScanner;
});

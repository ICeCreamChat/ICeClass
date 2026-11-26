'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const code=name=>readFileSync(path.join(__dirname,'../web_controller/card-quiz',name),'utf8');

function videoBridge(delay,{lost=0,late=0,duplicate=false,bufferAvailable=true}={}){
  let now=0,pixel=0,serial=0,renderer;
  const listeners={},tasks=[],visible=[],buffersByRun=new Map(),releases=new Set();
  const bridge={
    addEventListener:(type,fn)=>{listeners[type]=fn;},
    releaseBuffer:buffer=>{assert.ok(!releases.has(buffer));releases.add(buffer);},
    postMessage(message){
      if(message.type==='preview-buffer'){
        const buffers=Array.from({length:3},()=>new ArrayBuffer(640*360*4));
        buffersByRun.set(message.id,buffers);
        if(bufferAvailable)buffers.forEach((buffer,slot)=>listeners.sharedbufferreceived({
          getBuffer:()=>buffer,additionalData:{...message,slot}
        }));
      }else if(message.type==='preview-pixels'){
        const buffer=buffersByRun.get(message.id)[message.slot??0];
        const at=now,expected=pixel,consumed={...message,type:'preview-consumed'};
        tasks.push({at:at+delay,run:()=>{
          // The UI reads at the end of the delay. Each posted slot must stay immutable until then.
          assert.equal(new Uint8Array(buffer)[0],expected,'native must read the announced frame');
          visible.push({id:message.id,at:now,expected});
          if(lost>0){lost--;if(late)tasks.push({at:now+late,run:()=>renderer.acknowledge(consumed)});}
          else {
            renderer.acknowledge(consumed);
            if(duplicate){duplicate=false;tasks.push({at:now+44,run:()=>renderer.acknowledge(consumed)});}
          }
        }});
      }else if(message.type==='preview-frame')visible.push({at:now});
    }
  };
  const canvas={getContext:()=>({fillRect(){},drawImage(){},getImageData:()=>({data:[++pixel]})}),
    toDataURL:()=> 'data:image/jpeg;base64,x'};
  const window={};
  vm.runInNewContext(code('classroom-video.js'),{window,performance:{now:()=>now},
    document:{createElement:type=>type==='canvas'?canvas:{play:()=>new Promise(()=>{}),pause(){}}},
    MediaStream:class{},crypto:{randomUUID:()=>String(++serial)},clearInterval});
  renderer=new window.CardQuizClassroomVideo(bridge);
  const set=key=>renderer.set(key,{readyState:'live'});
  const step=at=>{
    now=at;
    const queued=tasks.splice(0);
    for(const task of queued)if(task.at<=now)task.run();else tasks.push(task);
    renderer.draw(renderer.run,{},1280,720,now);
  };
  return {renderer,set,step,visible,releases,buffersByRun};
}

test('23 帧每秒的取景不再因 45 或 80 毫秒的原生确认而隔帧丢失',()=>{
  for(const delay of [45,80]){
    const video=videoBridge(delay,{duplicate:true});
    video.set('phone');
    for(let at=0;at<2000;at+=44)video.step(at);
    assert.ok(video.visible.length>=43,`${delay} ms: ${video.visible.length} frames in 2 seconds`);
    assert.equal(video.buffersByRun.size,1);
  }
});

test('丢失全部在途确认可恢复，迟到确认不能释放新取景正在使用的帧',()=>{
  const video=videoBridge(80,{lost:3,late:1300});
  video.set('phone');
  for(let at=0;at<=2000;at+=40)video.step(at);
  assert.ok(video.buffersByRun.size>=2);
  assert.ok(video.visible.length>=22);
  const after=video.visible.length;
  video.set('board');
  const board=video.renderer.run.id;
  for(let at=2040;at<=2600;at+=40)video.step(at);
  assert.ok(video.visible.slice(after).filter(frame=>frame.id===board).length>=12);
  assert.equal(video.releases.size,6);
});

test('缺少共享缓冲时超时改用 JPEG，收起后释放当前取景',()=>{
  const video=videoBridge(0,{bufferAvailable:false});
  video.set('board');
  for(let at=0;at<=2000;at+=40)video.step(at);
  assert.ok(video.visible.length>=5);
  video.renderer.stop();
  assert.equal(video.renderer.run,null);
});

test('WebRTC 短暂 disconnected 恢复原连接，持续断开或 failed 则关闭',()=>{
  let time=0,serial=0,closed=0;
  const timers=new Map(),window={};
  class PeerConnection{
    state(value){this.connectionState=value;this.onconnectionstatechange();}
    close(){this.state('closed');}
  }
  vm.runInNewContext(code('camera-preview.js'),{window,RTCPeerConnection:PeerConnection,
    setTimeout:(fn,delay)=>{timers.set(++serial,{at:time+delay,fn});return serial;},clearTimeout:id=>timers.delete(id)});
  const peer=()=>new window.CardQuizPreview.Peer('test',{onClose:()=>closed++});
  const step=delta=>{time+=delta;for(const [id,timer] of timers)if(timer.at<=time){timers.delete(id);timer.fn();}};
  const recovering=peer();
  recovering.pc.state('disconnected');step(7000);
  assert.equal(closed,0);
  recovering.pc.state('connected');step(10000);
  assert.equal(closed,0);
  recovering.pc.state('disconnected');step(10000);
  assert.equal(closed,1);
  peer().pc.state('failed');
  assert.equal(closed,2);
});

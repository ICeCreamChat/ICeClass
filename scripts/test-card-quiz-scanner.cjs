const {test}=require('node:test');
const assert=require('node:assert/strict');
const Cards=require('../web_controller/card-quiz/cards.js');
const Scanner=require('../web_controller/card-quiz/scanner.js');
const AR=require('../web_controller/card-quiz/vendor/aruco.js');
const positions={A:[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}],D:[{x:10,y:0},{x:10,y:10},{x:0,y:10},{x:0,y:0}],C:[{x:10,y:10},{x:0,y:10},{x:0,y:0},{x:10,y:0}],B:[{x:0,y:10},{x:0,y:0},{x:10,y:0},{x:10,y:10}]};
const marker=(option='A',id=0,hammingDistance=0)=>({id,corners:positions[option],hammingDistance});
function image(matrix){const scale=20,size=matrix.length*scale,data=new Uint8ClampedArray(size*size*4);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=(y*size+x)*4;data[i]=data[i+1]=data[i+2]=matrix[Math.floor(y/scale)][Math.floor(x/scale)]?255:0;data[i+3]=255;}return{width:size,height:size,data};}
const rotate=m=>m[0].map((_,x)=>m.map(row=>row[x]).reverse());

test('全套 157 张打印图案各方向可还原同一卡号和字母',()=>{
  assert.equal(Cards.capacity,157);const detector=new AR.Detector({dictionaryName:'QCMCAM_4X4_157h3',maxHammingDistance:2});
  for(let number=1;number<=157;number++){let matrix=Cards.matrix(number);for(const option of ['A','D','C','B']){const matches=detector.detect(image(matrix)).filter(m=>m.id===number-1);assert.ok(matches.length,`卡 ${number} 朝向 ${option}`);assert.equal(Scanner.answerFromCorners(matches[0].corners),option);matrix=rotate(matrix);}}
  assert.match(Cards.svg(1),/<svg/);assert.throws(()=>Cards.svg(158));
});

test('实际 SVG 黑色方块占 180 mm 纸卡图的 140-150 mm，157 张含方向字母的打印图四向识别不变',async()=>{
  const {chromium}=require('playwright'),browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage();
    for(const file of ['vendor/cv.js','vendor/aruco.js','cards.js','scanner.js'])await page.addScriptTag({path:require.resolve('../web_controller/card-quiz/'+file)});
    const result=await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=480;const ctx=canvas.getContext('2d',{willReadFrequently:true});
      const detector=new ICeCardAR.Detector({dictionaryName:'QCMCAM_4X4_157h3',maxHammingDistance:2}),failures=[];
      let blackMm,checks=0;
      for(let number=1;number<=157;number++){
        const svg=CardQuizCards.svg(number),image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);await image.decode();
        if(number===1){const holder=document.createElement('div');holder.innerHTML=svg;document.body.append(holder);const el=holder.querySelector('svg');blackMm=el.querySelector('g[shape-rendering="crispEdges"]').getBBox().width/el.viewBox.baseVal.width*180;}
        for(let turn=0;turn<4;turn++){
          ctx.fillStyle='#fff';ctx.fillRect(0,0,480,480);ctx.save();ctx.translate(240,240);ctx.rotate(turn*Math.PI/2);ctx.drawImage(image,-240,-240,480,480);ctx.restore();
          const matches=detector.detect(ctx.getImageData(0,0,480,480)).filter(m=>m.id===number-1),option=['A','D','C','B'][turn];
          if(!matches.some(m=>CardQuizScanner.answerFromCorners(m.corners)===option))failures.push({number,option});checks++;
        }
      }
      return{blackMm,checks,failures};
    });
    assert.equal(result.checks,628);assert.deepEqual(result.failures,[]);assert.ok(result.blackMm>=140&&result.blackMm<=150,'actual black detection square: '+result.blackMm+' mm');
  }finally{await browser.close();}
});
test('初次三次精确读数确认，改答需连续读数，相同答案不重复触发',()=>{
  const stable=new Scanner.Stabilizer();const feed=(m,at)=>stable.feed(m,at,4);
  assert.deepEqual(feed([marker()],0),[]);assert.deepEqual(feed([marker()],150),[]);assert.deepEqual(feed([marker()],300),[{cardNumber:1,option:'A'}]);
  assert.deepEqual(feed([marker()],450),[]);assert.deepEqual(feed([],600),[]);
  assert.deepEqual(feed([marker('B')],750),[]);assert.deepEqual(feed([marker('B')],900),[]);
  assert.deepEqual(feed([marker('B')],1050),[{cardNumber:1,option:'B'}]);
});
test('同号不同方向在去重之前拒绝，不能累积冲突帧的选项',()=>{
  const stable=new Scanner.Stabilizer();
  for(let i=0;i<12;i++)assert.deepEqual(stable.feed([marker('A'),marker('B')],i*150,4),[]);
  assert.deepEqual(stable.feed([marker('A')],2000,4),[]);
  assert.deepEqual(stable.feed([marker('A')],2150,4),[]);
  assert.deepEqual(stable.feed([marker('A')],2300,4),[{cardNumber:1,option:'A'}]);
});
test('候选会过期，判断题不采 C/D，歧义角度不进入稳定记录',()=>{
  const stable=new Scanner.Stabilizer();stable.feed([marker('A')],0,2);stable.feed([marker('A')],150,2);
  assert.deepEqual(stable.feed([marker('A')],10000,2),[]);
  for(let i=0;i<10;i++)assert.deepEqual(stable.feed([marker('C')],11000+i*150,2),[]);
  assert.equal(Scanner.answerFromCorners([{x:10,y:0},{x:10,y:2},{x:0,y:0},{x:0,y:2}]),'');
});

test('检测器两次检测合并保留方向冲突，含更低纠错距离及后续同向重复',t=>{
  for(const distances of [[0,0],[1,0],[0,1]]){
    const detector=new AR.Detector({dictionaryName:'QCMCAM_4X4_157h3',maxHammingDistance:2}),stable=new Scanner.Stabilizer();
    let pass=0;
    t.mock.method(detector,'findMarkers',()=>++pass%2?[marker('A',0,distances[0])]:[marker('B',0,distances[1]),marker('A',0,0)]);
    for(let i=0;i<9;i++){
      const merged=detector.detect(image(Cards.matrix(1)));
      assert.deepEqual(stable.feed(merged,i*180),[]);assert.deepEqual(stable.conflicts,[1]);
    }
    for(let i=0;i<3;i++)assert.deepEqual(stable.feed(detector.mergeMarkers([marker('A'),marker('A',0,1)]),2000+i*180),i===2?[{cardNumber:1,option:'A'}]:[]);
  }
});
test('同方向几何重复只计一帧，合并保留较低纠错距离',()=>{
  const detector=new AR.Detector({dictionaryName:'QCMCAM_4X4_157h3',maxHammingDistance:2}),stable=new Scanner.Stabilizer();
  const merged=detector.mergeMarkers([marker('A',0,1),marker('A',0,0)]);
  assert.equal(merged.length,1);assert.equal(merged[0].hammingDistance,0);
  assert.deepEqual(stable.feed(merged,0),[]);assert.deepEqual(stable.feed(merged,180),[]);
  assert.deepEqual(stable.feed(merged,360),[{cardNumber:1,option:'A'}]);
});

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function settled(){for(let i=0;i<8;i++)await Promise.resolve();}
function camera(t,{getUserMedia,play,onRead}={}){
  let now=0,mediaCalls=0,timerId=0;const timers=new Map(),statuses=[],reads=[],streams=[];
  function stream(){
    const track=new EventTarget();Object.assign(track,{kind:'video',readyState:'live',stops:0,stop(){this.stops++;this.readyState='ended';},end(){this.readyState='ended';this.dispatchEvent(new Event('ended'));}});
    const value={getTracks:()=>[track],getVideoTracks:()=>[track],track};streams.push(value);return value;
  }
  const video={srcObject:null,readyState:0,videoWidth:160,videoHeight:160,currentTime:0,play:play||(()=>Promise.resolve())};
  const ctx={drawImage(){},getImageData:()=>image(Cards.matrix(1))},canvas={width:0,height:0,getContext:()=>ctx};
  const globals={isSecureContext:true,navigator:{mediaDevices:{getUserMedia:()=>{mediaCalls++;return getUserMedia?getUserMedia():Promise.resolve(stream());}}},document:{createElement:()=>canvas}};
  const descriptors=Object.fromEntries(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{value,configurable:true});
  t.mock.method(performance,'now',()=>now);
  t.mock.method(globalThis,'setTimeout',fn=>{timers.set(++timerId,fn);return timerId;});
  t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
  const scanner=new Scanner({video,onRead:onRead||(read=>{reads.push(read);}),onStatus:status=>statuses.push(status)});
  scanner.reset('round-1');
  t.after(()=>{scanner.stop();for(const [key,descriptor]of Object.entries(descriptors)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  async function frame({option='A',advance=true,elapsed=180}={}){
    now+=elapsed;video.readyState=2;if(advance)video.currentTime+=0.18;
    scanner.detector.detect=()=>[marker(option)];clearTimeout(scanner.timer);scanner.tick();await settled();
  }
  return{scanner,video,stream,streams,statuses,reads,frame,get mediaCalls(){return mediaCalls;}};
}

test('重叠开启共用一次相机申请，停止时唯一视频轨释放',async t=>{
  const opening=deferred(),h=camera(t,{getUserMedia:()=>opening.promise});
  const a=h.scanner.start(),b=h.scanner.start();assert.equal(h.mediaCalls,1);
  const stream=h.stream();opening.resolve(stream);await Promise.all([a,b]);
  assert.equal(h.scanner.running,true);assert.equal(h.video.srcObject,stream);
  h.scanner.stop();assert.equal(stream.track.stops,1);assert.equal(h.video.srcObject,null);
});
test('停止后才取得的旧相机流只释放自身，不影响已开启的新相机',async t=>{
  const opening=deferred();let h,calls=0;h=camera(t,{getUserMedia:()=>++calls===1?opening.promise:Promise.resolve(h.stream())});
  const a=h.scanner.start();h.scanner.stop();await h.scanner.start();const current=h.video.srcObject,old=h.stream();
  opening.resolve(old);await a;assert.equal(old.track.stops,1);assert.equal(current.track.stops,0);
  assert.equal(h.scanner.running,true);assert.equal(h.video.srcObject,current);
});
for(const outcome of ['resolve','reject'])test('旧预览异步'+outcome+'不会停止新相机或泄漏轨道',async t=>{
  const preview=deferred();let plays=0;const h=camera(t,{play:()=>++plays===1?preview.promise:Promise.resolve()});
  const a=h.scanner.start();await settled();const old=h.video.srcObject;assert.ok(old);
  h.scanner.stop();await h.scanner.start();const current=h.video.srcObject;
  preview[outcome](new Error('旧预览失败'));await a;
  assert.equal(h.scanner.running,true);assert.equal(h.video.srcObject,current);assert.equal(old.track.stops,1);assert.equal(current.track.stops,0);
  assert.equal(h.statuses.filter(s=>s.kind==='error').length,0);
  h.scanner.stop();assert.equal(current.track.stops,1);
});
test('过期相机申请被拒绝不回传旧错误，当前采集继续',async t=>{
  const opening=deferred();let h,calls=0;h=camera(t,{getUserMedia:()=>++calls===1?opening.promise:Promise.resolve(h.stream())});
  const a=h.scanner.start();h.scanner.stop();await h.scanner.start();const current=h.video.srcObject;
  opening.reject(new Error('旧申请被拒绝'));await a;
  assert.equal(h.scanner.running,true);assert.equal(h.video.srcObject,current);assert.equal(current.track.stops,0);
});
test('当前预览失败释放视频轨，之后可以重新申请',async t=>{
  let plays=0;const h=camera(t,{play:()=>++plays===1?Promise.reject(new Error('播放失败')):Promise.resolve()});
  await assert.rejects(h.scanner.start(),/预览/);assert.equal(h.streams[0].track.stops,1);assert.equal(h.video.srcObject,null);
  await h.scanner.start();assert.equal(h.scanner.running,true);assert.equal(h.mediaCalls,2);
});
for(const failure of ['sync','async'])test('提交'+failure+'失败后同一方向可重新稳定并成功确认',async t=>{
  let attempts=0;const accepted=[],h=camera(t,{onRead:read=>{if(++attempts===1){if(failure==='sync')throw new Error('提交暂不可用');return Promise.reject(new Error('提交暂不可用'));}accepted.push(read);}});
  await h.scanner.start();for(let i=0;i<6;i++)await h.frame();
  assert.equal(attempts,2);assert.deepEqual(accepted,[{cardNumber:1,option:'A'}]);
  assert.ok(h.statuses.some(s=>s.kind==='error'&&s.message.includes('提交暂不可用')));
});
for(const change of ['reset','restart'])test('旧提交失败不会清除'+change+'后新上下文的确认状态或报告旧错误',async t=>{
  const old=deferred(),accepted=[];let attempts=0;const h=camera(t,{onRead:read=>++attempts===1?old.promise:accepted.push(read)});
  await h.scanner.start();for(let i=0;i<3;i++)await h.frame();
  if(change==='reset'){h.scanner.reset('round-2');h.scanner.reset('round-1');}else{h.scanner.stop();await h.scanner.start();}
  for(let i=0;i<3;i++)await h.frame({option:'B'});
  old.reject(new Error('旧上下文失败'));await settled();
  for(let i=0;i<3;i++)await h.frame({option:'B'});
  assert.deepEqual(accepted,[{cardNumber:1,option:'B'}]);assert.equal(h.statuses.filter(s=>s.kind==='error').length,0);
});
test('同一上下文中旧选项提交失败不会清除较新选项',async t=>{
  const old=deferred(),accepted=[];let attempts=0;const h=camera(t,{onRead:read=>++attempts===1?old.promise:accepted.push(read)});
  await h.scanner.start();for(let i=0;i<3;i++)await h.frame();for(let i=0;i<3;i++)await h.frame({option:'B'});
  old.reject(new Error('旧选项失败'));await settled();for(let i=0;i<3;i++)await h.frame({option:'B'});
  assert.deepEqual(accepted,[{cardNumber:1,option:'B'}]);
});
test('保留的视频画面不能反复累计成多帧确认',async t=>{
  const h=camera(t);await h.scanner.start();await h.frame();
  for(let i=0;i<8;i++)await h.frame({advance:false});
  assert.deepEqual(h.reads,[]);
});
test('存在解码帧计数时播放时间推进也不能重复使用同一画面',async t=>{
  const h=camera(t);h.video.getVideoPlaybackQuality=()=>({totalVideoFrames:1});
  await h.scanner.start();for(let i=0;i<6;i++)await h.frame();assert.deepEqual(h.reads,[]);
});
test('画面持续冻结后停止采集、释放轨道并清除未确认候选',async t=>{
  const h=camera(t);await h.scanner.start();await h.frame();const stream=h.video.srcObject;
  await h.frame({advance:false,elapsed:4000});
  assert.equal(h.scanner.running,false);assert.equal(h.video.srcObject,null);assert.equal(stream.track.stops,1);
  assert.equal(h.scanner.stabilizer.entries.size,0);assert.deepEqual(h.reads,[]);
  assert.ok(h.statuses.some(s=>s.kind==='error'&&/相机|画面/.test(s.message)));
});
for(const signal of ['event','state'])test('视频轨结束由'+signal+'发现后停止并清空候选',async t=>{
  const h=camera(t);await h.scanner.start();await h.frame();const stream=h.video.srcObject;
  if(signal==='event')stream.track.end();else{stream.track.readyState='ended';await h.frame();}
  assert.equal(h.scanner.running,false);assert.equal(h.video.srcObject,null);assert.equal(h.scanner.stabilizer.entries.size,0);
  assert.deepEqual(h.reads,[]);assert.ok(h.statuses.some(s=>s.kind==='error'&&/相机|画面/.test(s.message)));
});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const Cards=require('../web_controller/card-quiz/cards.js');
const Scanner=require('../web_controller/card-quiz/scanner.js');
const AR=require('../web_controller/card-quiz/vendor/aruco.js');
const CV=require('../web_controller/card-quiz/vendor/cv.js');
const positions={A:[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}],D:[{x:10,y:0},{x:10,y:10},{x:0,y:10},{x:0,y:0}],C:[{x:10,y:10},{x:0,y:10},{x:0,y:0},{x:10,y:0}],B:[{x:0,y:10},{x:0,y:0},{x:10,y:0},{x:10,y:10}]};
const marker=(option='A',id=0,hammingDistance=0)=>({id,corners:positions[option],hammingDistance});
function image(matrix){const scale=20,size=matrix.length*scale,data=new Uint8ClampedArray(size*size*4);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=(y*size+x)*4;data[i]=data[i+1]=data[i+2]=matrix[Math.floor(y/scale)][Math.floor(x/scale)]?255:0;data[i+3]=255;}return{width:size,height:size,data};}
const rotate=m=>m[0].map((_,x)=>m.map(row=>row[x]).reverse());

test('全幅与半幅阈值逐像素等同原盒式滤波，含边沿、奇数尺寸和复用缓冲', () => {
  let seed=9629;
  const mask=new CV.Image();
  for(const [w,h] of [[3,2],[4,7],[5,5],[11,9],[7,13],[1921,21],[47,61]]){
    for(const radius of [2,3])for(const threshold of [0,7,17]){
      const data=Uint8Array.from({length:w*h},(_,i)=>{
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;
        return i%3===0?seed>>>24:(32+(i%23));
      });
      const src=new CV.Image(w,h,data), blur=new CV.Image(w,h,new Uint8Array(w*h));
      CV.stackBoxBlur(src,blur,radius);
      const expected=blur.data.map((average,i)=>average-data[i]>=threshold?255:0);
      mask.data=new Uint8Array(w*h);
      CV.adaptiveThreshold(src,mask,radius,threshold);
      assert.deepEqual(mask.data,expected,`${w}x${h}, radius ${radius}, threshold ${threshold}`);
    }
  }
});

test('全部 65536 个载荷的精确匹配、单格纠错位置和拒识与汉明距离一致', () => {
  const dictionary=new AR.Detector({maxHammingDistance:2}).dictionary;
  const codes=AR.DICTIONARIES.QCMCAM_4X4_157h3.codeList;
  for(let word=0;word<65536;word++){
    const bits=word.toString(2).padStart(16,'0').match(/.{4}/g).map(row=>Array.from(row,Number));
    const exact=codes.indexOf(word);
    let expected;
    if(exact>=0)expected={id:exact,distance:0};
    else for(let id=0;id<codes.length;id++){
      const diff=codes[id]^word;
      if((diff&(diff-1))===0){expected={id,distance:1,cell:Math.clz32(diff)-16};break;}
    }
    assert.deepEqual(dictionary.find(bits),expected,word.toString(16));
  }
});

test('密集候选按角点去重，与原顺序两两比较相同，等周长不会换胜者', () => {
  const detector=new AR.Detector(), candidates=[];
  for(let i=0;i<60;i++){
    const x=36*(i%10)-3, y=28*Math.floor(i/10), side=12+i%4;
    for(const [shift,extra] of [[2,0],[0,0],[-1,i%3]]){
      candidates.push([{x:x+shift,y},{x:x+shift+side+extra,y},{x:x+shift+side+extra,y:y+side},{x:x+shift,y:y+side}]);
    }
  }
  for(const minDist of [5,10]){
    const rejected=new Set();
    for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++){
      const a=candidates[i],b=candidates[j];
      const sum=a.reduce((n,p,k)=>n+(p.x-b[k].x)**2+(p.y-b[k].y)**2,0);
      if(sum<4*minDist**2)rejected.add(CV.perimeter(a)<CV.perimeter(b)?i:j);
    }
    const found=detector.notTooNear(candidates.map(square=>square.slice()),minDist);
    assert.deepEqual(found,candidates.filter((_,i)=>!rejected.has(i)));
  }
});

test('320×180 全幅四角保留 12-18 像素的卡，六像素黑框不冒充其他卡',()=>{
  const width=320,height=180, data=new Uint8ClampedArray(width*height*4).fill(255);
  const pixels=new Uint32Array(data.buffer);
  for(const [number,turn,left,top,cell] of [[1,0,1,1,3],[35,1,300,1,2],[124,2,1,160,2],
    [157,3,292,153,3],[85,1,150,80,1]]){
    let cells=Cards.matrix(number);
    for(let i=0;i<turn;i++)cells=rotate(cells);
    cells.forEach((row,y)=>row.forEach((bit,x)=>{
      if(bit)return;
      for(let dy=0;dy<cell;dy++){
        const start=(top+y*cell+dy)*width+left+x*cell;
        pixels.fill(0xff111111,start,start+cell);
      }
    }));
  }
  const detector=new AR.Detector({maxHammingDistance:2}),stable=new Scanner.Stabilizer(),reads=[];
  for(let frame=0;frame<8;frame++){
    data[0]=frame;
    reads.push(...stable.feed(detector.detect({width,height,data}),frame*75));
  }
  assert.deepEqual(reads.sort((a,b)=>a.cardNumber-b.cardNumber),[
    {cardNumber:1,option:'A'},{cardNumber:35,option:'D'},{cardNumber:124,option:'C'},{cardNumber:157,option:'B'}]);
});

test('换项后留在原位的卡不能沿用，转向和重新举起分别重新计稳',()=>{
  const stable=new Scanner.Stabilizer();
  let time=0;
  const frame=markers=>stable.feed(markers,time+=180,2);
  const first=[marker('A',0),marker('B',1)];
  frame(first);frame(first);assert.equal(frame(first).length,2);
  const previous=stable.cardsInView();
  stable.reset();stable.waitForNewPresentation(previous);
  for(let i=0;i<12;i++)assert.deepEqual(frame(first),[]);
  const turn=[marker('A',0),marker('A',1)];
  frame(turn);frame(turn);assert.deepEqual(frame(turn),[{cardNumber:2,option:'A'}]);
  frame([]);frame([]);frame([]);
  frame(turn);frame(turn);assert.deepEqual(frame(turn),[{cardNumber:1,option:'A'}]);
});

test('全套 157 张打印图案各方向可还原同一卡号和字母',()=>{
  assert.equal(Cards.capacity,157);const detector=new AR.Detector({dictionaryName:'QCMCAM_4X4_157h3',maxHammingDistance:2});
  for(let number=1;number<=157;number++){let matrix=Cards.matrix(number);for(const option of ['A','D','C','B']){const matches=detector.detect(image(matrix)).filter(m=>m.id===number-1);assert.ok(matches.length,`卡 ${number} 朝向 ${option}`);assert.equal(Scanner.answerFromCorners(matches[0].corners),option);matrix=rotate(matrix);}}
  assert.match(Cards.svg(1),/<svg/);assert.throws(()=>Cards.svg(158));
});

test('个人卡印刷的 B 不得作为第二张卡计入，旁边真实的小号图案仍可识别', () => {
  const detector = new AR.Detector({dictionaryName:'QCMCAM_4X4_157h3', maxHammingDistance:2});
  // Coordinates from the rendered A4. Depending on scale, the letter decodes as card 85
  // even at zero Hamming distance. Also place a genuine 85 of the same size nearby.
  const outline = [[94,265],[501,265],[501,672],[94,672]];
  const letter = [[541,462],[541,473],[521,476],[521,462]];
  for (let turn = 0; turn < 4; turn++) {
    const rotate = ([x,y]) => [ {x,y}, {x:-y,y:x}, {x:-x,y:-y}, {x:y,y:-x} ][turn];
    const card = {id:0, hammingDistance:0, corners:outline.map(rotate)};
    const glyph = {id:84, hammingDistance:0, corners:letter.map(rotate)};
    const neighbor = {id:84, hammingDistance:1, corners:letter.map(([x,y]) => rotate([x+55,y]))};
    assert.deepEqual(detector.mergeMarkers([glyph,neighbor,card]), [neighbor,card]);
    assert.deepEqual(detector.mergeMarkers([neighbor]), [neighbor]);
  }
});

test('网站二维码的混色边框不能给纠错载荷作证，真正的单格纠错仍可用', () => {
  const detector = new AR.Detector({dictionaryName:'QCMCAM_4X4_157h3', maxHammingDistance:2});
  const width = 49, data = new Uint8Array(width * width);
  const cells = Cards.matrix(1).slice(1, 7).map(row => row.slice(1, 7));
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) data[y * width + x] = 255 * cells[Math.floor(y / 8)][Math.floor(x / 8)];
  }
  function setCenter(row, col, whitePixels) {
    for (let i = 0; i < 16; i++) {
      const y = row * 8 + 2 + Math.floor(i / 4), x = col * 8 + 2 + i % 4;
      data[y * width + x] = i < whitePixels ? 255 : 0;
    }
  }
  const decode = () => detector.getMarker({width, height:width, data}, positions.A, 127);
  setCenter(1, 1, 7);
  assert.equal(decode()?.hammingDistance, 1);
  setCenter(0, 2, 8);
  assert.equal(decode(), null);
  setCenter(1, 1, 16);
  setCenter(0, 2, 9);
  assert.equal(decode()?.hammingDistance, 0, '精确载荷仍容许单格边框受损');
});

async function renderScannerScene(render, input) {
  const {chromium} = require('playwright');
  const browser = await chromium.launch({channel:'msedge', headless:true});
  try {
    const page = await browser.newPage();
    for (const file of ['vendor/cv.js','vendor/aruco.js','cards.js','scanner.js']) {
      await page.addScriptTag({path:require.resolve('../web_controller/card-quiz/' + file)});
    }
    return await page.evaluate(render, input);
  } finally {
    await browser.close();
  }
}

test('远处斜拍的纸卡可确认四向，遮挡不收且能区分 35 号与真正的 124 号', async () => {
  // 32 px crops from paper-card projections at different tilts, subpixel offsets and focus.
  // Two views of card 35 used to decode as 124. On card 8 one white cell blends into the border.
  const png = require('node:fs').readFileSync(require.resolve('../tests/fixtures/paper-distant.png'));
  const result = await renderScannerScene(async encoded => {
    const source = new Image();
    source.src = 'data:image/png;base64,' + encoded;
    await source.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d', {willReadFrequently:true});
    const detector = new ICeCardAR.Detector({maxHammingDistance:2}), readings = [];
    for (let crop = 0; crop < 8; crop++) for (let turn = 0; turn < 4; turn++) {
      const stable = new CardQuizScanner.Stabilizer(), reads = [];
      for (let frame = 0; frame < 8; frame++) {
        ctx.fillStyle = '#c1c1c1';
        ctx.fillRect(0, 0, 64, 64);
        ctx.save();
        ctx.translate(32 + frame % 2, 32);
        ctx.rotate(turn * Math.PI / 2);
        ctx.drawImage(source, crop % 2 * 32, Math.floor(crop / 2) * 32, 32, 32, -16, -16, 32, 32);
        if (frame < 3) ctx.fillRect(-6, -3, 12, 6);
        ctx.restore();
        const markers = detector.detect(ctx.getImageData(0, 0, 64, 64));
        for (const item of stable.feed(markers, frame * 180)) reads.push({...item, frame});
      }
      readings.push(reads);
    }
    return readings;
  }, png.toString('base64'));
  for (const [i, reads] of result.entries()) {
    const expected = {cardNumber:[1,1,48,60,35,35,8,124][Math.floor(i / 4)], option:'ADCB'[i % 4]};
    assert.deepEqual(reads.map(({cardNumber, option}) => ({cardNumber, option})), [expected]);
    assert.ok(reads[0].frame >= 5, 'three fresh unobscured frames are required');
  }
});

test('大卡被挡住时单独露出的 B 不能冒充 85 号，旁边斜视的真卡仍可读', async () => {
  const failures = await renderScannerScene(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 200; canvas.height = 120;
    const ctx = canvas.getContext('2d', {willReadFrequently:true});
    const detector = new ICeCardAR.Detector({maxHammingDistance:2}), failures = [];
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 200, 120);
    ctx.fillStyle = 'black';
    CardQuizCards.matrix(85).forEach((row, y) => row.forEach((bit, x) => {
      if (!bit) ctx.fillRect(125 + x*4, 39 + y*6, 4, 6);
    }));
    for (const size of [23,28,38,56]) for (let turn = 0; turn < 4; turn++) {
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, 105, 120);
      ctx.save();
      ctx.translate(52, 54); ctx.rotate(turn * Math.PI / 2);
      ctx.font = 'bold ' + size + 'px "Microsoft YaHei UI"';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'black';
      ctx.fillText('B', 0, 0); ctx.restore();
      const markers = detector.detect(ctx.getImageData(0, 0, 200, 120));
      if (markers.length !== 1 || markers[0].id !== 84 || markers[0].corners[0].x < 105 ||
          CardQuizScanner.answerFromCorners(markers[0].corners) !== 'A') failures.push({size, turn});
    }
    return failures;
  });
  assert.deepEqual(failures, []);
});

test('200 mm 印刷图内的黑框边长为 170 mm，157 张卡的四向卡号和字母全部匹配',async()=>{
  const result=await renderScannerScene(async()=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=480;const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const detector=new ICeCardAR.Detector({dictionaryName:'QCMCAM_4X4_157h3',maxHammingDistance:2}),failures=[];
    let blackMm,checks=0;
    for(let number=1;number<=157;number++){
      const svg=CardQuizCards.svg(number),image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);await image.decode();
      if(number===1){const holder=document.createElement('div');holder.innerHTML=svg;document.body.append(holder);const el=holder.querySelector('svg');blackMm=el.querySelector('g[shape-rendering="crispEdges"]').getBBox().width/el.viewBox.baseVal.width*200;}
      for(let turn=0;turn<4;turn++){
        ctx.fillStyle='#fff';ctx.fillRect(0,0,480,480);ctx.save();ctx.translate(240,240);ctx.rotate(turn*Math.PI/2);ctx.drawImage(image,-240,-240,480,480);ctx.restore();
        const matches=detector.detect(ctx.getImageData(0,0,480,480)),option=['A','D','C','B'][turn];
        if(matches.length!==1||matches[0].id!==number-1||CardQuizScanner.answerFromCorners(matches[0].corners)!==option)failures.push({number,option});checks++;
      }
    }
    return{blackMm,checks,failures};
  });
  assert.equal(result.checks,628);assert.deepEqual(result.failures,[]);assert.equal(result.blackMm,170);
});

test('后排小纸卡轻度失焦时，60 人的卡号和四向均能确认，空位和遮挡不计入', async () => {
  const {all, remaining} = await renderScannerScene(() => {
    const board = document.createElement('canvas');
    board.width = 960;
    board.height = 540;
    const camera = board.cloneNode();
    const pen = board.getContext('2d'), frame = camera.getContext('2d', {willReadFrequently:true});
    const detector = new ICeCardAR.Detector({maxHammingDistance:2});
    function collect(lowerSome) {
      const stable = new CardQuizScanner.Stabilizer(), reads = [];
      pen.fillStyle = '#ececec';
      pen.fillRect(0, 0, board.width, board.height);
      for (let i = 0; i < 60; i++) {
        const row = Math.floor(i / 10), size = [40,37,34,31,27,24][row];
        if (lowerSome && i % 3 === 0) continue;
        pen.save();
        pen.translate(48 + 96 * (i % 10), 45 + 90 * row);
        pen.rotate(i % 4 * Math.PI / 2);
        // Draw at the camera's resolution with the same black border and four data rows as the printout.
        const cells = CardQuizCards.matrix(i + 1), unit = size / 6;
        pen.fillStyle = 'white';
        pen.fillRect(-4*unit, -4*unit, 8*unit, 8*unit);
        const edge = index => Math.round((index - 4) * unit);
        pen.fillStyle = 'black';
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          if (cells[y][x]) continue;
          pen.fillRect(edge(x), edge(y), edge(x+1)-edge(x), edge(y+1)-edge(y));
        }
        if (lowerSome && i % 3 === 1) {
          pen.fillStyle = '#aaa';
          pen.fillRect(-unit, -4*unit, 2*unit, 8*unit);
        }
        pen.restore();
      }
      frame.filter = 'blur(2px)';
      for (let f = 0; f < 8; f++) {
        frame.drawImage(board, [0,1,-1][f % 3], 0);
        const markers = detector.detect(frame.getImageData(0, 0, camera.width, camera.height));
        reads.push(...stable.feed(markers, f * 180));
      }
      return reads.sort((a,b) => a.cardNumber - b.cardNumber);
    }
    return {all:collect(false), remaining:collect(true)};
  });
  const expected = Array.from({length:60}, (_,i) => ({cardNumber:i+1, option:'ADCB'[i%4]}));
  assert.deepEqual(all, expected);
  assert.deepEqual(remaining, expected.filter((_,i) => i % 3 === 2));
});

test('初次三次精确读数确认，改答需连续读数，相同答案不重复触发',()=>{
  const stable=new Scanner.Stabilizer();const feed=(m,at)=>stable.feed(m,at,4);
  assert.deepEqual(feed([marker()],0),[]);assert.deepEqual(feed([marker()],150),[]);assert.deepEqual(feed([marker()],300),[{cardNumber:1,option:'A'}]);
  assert.deepEqual(feed([marker()],450),[]);assert.deepEqual(feed([],600),[]);
  assert.deepEqual(feed([marker('B')],750),[]);assert.deepEqual(feed([marker('B')],900),[]);
  assert.deepEqual(feed([marker('B')],1050),[{cardNumber:1,option:'B'}]);
});
test('持续的单格纠错要六个新帧，精确与纠错混合仍需满分且连续',()=>{
  const stable=new Scanner.Stabilizer();
  const frame=(option,distance,at)=>stable.feed([marker(option,0,distance)],at);
  for(let i=0;i<5;i++)assert.deepEqual(frame('A',1,i*75),[]);
  assert.deepEqual(frame('A',1,375),[{cardNumber:1,option:'A'}]);
  assert.deepEqual(frame('B',1,450),[]);
  assert.deepEqual(frame('B',0,525),[]);
  assert.deepEqual(frame('B',1,600),[]);
  assert.deepEqual(frame('B',0,675),[{cardNumber:1,option:'B'}]);
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
function camera(t,{getUserMedia,play,onRead,trackProcessor,waitForFrames=false}={}){
  let now=0,mediaCalls=0,timerId=0,constraints;const timers=new Map(),statuses=[],reads=[],streams=[];
  function stream(){
    const track=new EventTarget();Object.assign(track,{kind:'video',readyState:'live',stops:0,stop(){this.stops++;this.readyState='ended';},end(){this.readyState='ended';this.dispatchEvent(new Event('ended'));}});
    const value={getTracks:()=>[track],getVideoTracks:()=>[track],track};streams.push(value);return value;
  }
  const video={srcObject:null,readyState:0,videoWidth:160,videoHeight:160,currentTime:0,play:play||(()=>Promise.resolve())};
  let frameNumber=0;
  const ctx={drawImage(){},getImageData(){const sample=image(Cards.matrix(1));sample.data[0]=frameNumber%256;return sample;}};
  const canvas={width:0,height:0,getContext:()=>ctx};
  const globals={isSecureContext:true,navigator:{mediaDevices:{getUserMedia:request=>{mediaCalls++;constraints=request;return getUserMedia?getUserMedia():Promise.resolve(stream());}}},document:{createElement:()=>canvas}};
  if(trackProcessor)globals.MediaStreamTrackProcessor=trackProcessor;
  const descriptors=Object.fromEntries(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{value,configurable:true});
  t.mock.method(performance,'now',()=>now);
  t.mock.method(globalThis,'setTimeout',fn=>{timers.set(++timerId,fn);return timerId;});
  t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
  const scanner=new Scanner({video,readTrack:Boolean(trackProcessor),waitForFrames,onRead:onRead||(read=>{reads.push(read);}),onStatus:status=>statuses.push(status)});
  scanner.reset('round-1');
  t.after(()=>{scanner.stop();for(const [key,descriptor]of Object.entries(descriptors)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  async function frame({option='A',advance=true,changePixels=advance,elapsed=180}={}){
    now+=elapsed;video.readyState=2;
    if(advance)video.currentTime+=0.18;
    if(changePixels)frameNumber++;
    scanner.detector.detect=()=>[marker(option)];clearTimeout(scanner.timer);scanner.tick();await settled();
  }
  return{scanner,video,stream,streams,statuses,reads,frame,get mediaCalls(){return mediaCalls;},get constraints(){return constraints;}};
}

test('手机与白板扫码保留摄像头交付的高清细节，按实际帧限制扫描像素', async t => {
  const h=camera(t);
  await h.scanner.start();
  assert.equal(h.constraints.video.width.ideal,1920);
  assert.equal(h.constraints.video.height.ideal,1080);
  assert.deepEqual(h.constraints.video.frameRate,{ideal:30});
  for (const [w,hgt,outW,outH] of [[1920,1080,1920,1080],[1080,1920,1080,1920],
    [3840,2160,1920,1080],[640,360,640,360]]) {
    h.video.videoWidth=w;h.video.videoHeight=hgt;
    await h.frame();
    assert.deepEqual([h.scanner.canvas.width,h.scanner.canvas.height],[outW,outH]);
  }
});

test('班班切项关闭摄像头，迟到的视频帧释放且不写入下一项',async t=>{
  const pending=deferred();let closed=0,cancelled=0,released=0;
  const reader={read:()=>pending.promise,async cancel(){cancelled++;},releaseLock(){released++;}};
  class Processor { constructor(){this.readable={getReader:()=>reader};} }
  const h=camera(t,{trackProcessor:Processor});
  await h.scanner.start();h.scanner.stop();h.scanner.reset('round-2',2);
  pending.resolve({value:{timestamp:1,displayWidth:160,displayHeight:160,close(){closed++;}}});await settled();
  assert.equal(cancelled,1);assert.equal(released,1);assert.equal(closed,1);assert.deepEqual(h.reads,[]);
  assert.equal(h.scanner.running,false);assert.equal(h.streams[0].track.stops,1);
});

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
test('A 转 B 再转 A，首次 A 的迟到失败不会重交已确认的新 A',async t=>{
  const first=deferred(),attempts=[];
  const h=camera(t,{onRead:read=>{attempts.push(read.option);if(attempts.length===1)return first.promise;}});
  await h.scanner.start();
  for(const option of ['A','B','A'])for(let i=0;i<3;i++)await h.frame({option,elapsed:75});
  first.reject(new Error('旧 A 失败'));await settled();
  for(let i=0;i<6;i++)await h.frame({elapsed:75});
  assert.deepEqual(attempts,['A','B','A']);
  assert.ok(!h.statuses.some(s=>s.kind==='error'));
});

test('同一呈现帧回调不再绘制、读回或推取景，跳号只算一帧',async t=>{
  const h=camera(t,{waitForFrames:true});
  let notify,previews=0;
  h.video.requestVideoFrameCallback=callback=>{notify=callback;return 1;};
  h.scanner.onPreview=()=>previews++;
  await h.scanner.start();
  const draw=t.mock.method(h.scanner.ctx,'drawImage'), pixels=t.mock.method(h.scanner.ctx,'getImageData');
  for(const count of [1,1,1,8,8,22]){
    notify(0,{presentedFrames:count});await h.frame({elapsed:40});
    if(count!==22)assert.deepEqual(h.reads,[]);
  }
  assert.deepEqual(h.reads,[{cardNumber:1,option:'A'}]);
  assert.deepEqual([draw.mock.callCount(),pixels.mock.callCount(),previews],[3,3,3]);
});

test('从像素后备切回解码计数的过渡帧免绘制免读回，随后继续稳定',async t=>{
  const h=camera(t);
  let count=0;
  h.video.getVideoPlaybackQuality=()=>({totalVideoFrames:count});
  await h.scanner.start();
  const draw=t.mock.method(h.scanner.ctx,'drawImage'), pixels=t.mock.method(h.scanner.ctx,'getImageData');
  await h.frame();
  count=1;await h.frame();
  assert.deepEqual([draw.mock.callCount(),pixels.mock.callCount(),h.scanner.stabilizer.frame],[1,1,1]);
  count=2;await h.frame();count=3;await h.frame();
  assert.deepEqual(h.reads,[{cardNumber:1,option:'A'}]);
});

test('无帧计数时同像素只确认一次画面，重复轮询不会再次推送取景',async t=>{
  const h=camera(t,{waitForFrames:true});
  let previews=0;
  h.scanner.onPreview=()=>previews++;
  await h.scanner.start();await h.frame();
  for(let i=0;i<5;i++)await h.frame({elapsed:75,changePixels:false});
  assert.equal(h.scanner.stabilizer.frame,1);assert.equal(previews,1);assert.deepEqual(h.reads,[]);
  await h.frame();await h.frame();
  assert.equal(previews,3);assert.deepEqual(h.reads,[{cardNumber:1,option:'A'}]);
});
test('保留的视频画面不能反复累计成多帧确认',async t=>{
  const h=camera(t);await h.scanner.start();await h.frame();
  for(let i=0;i<8;i++)await h.frame({advance:false});
  assert.deepEqual(h.reads,[]);
});
test('存在解码帧计数时播放时间推进也不能重复使用同一画面',async t=>{
  const h=camera(t);h.video.getVideoPlaybackQuality=()=>({totalVideoFrames:1});
  await h.scanner.start();
  for(let i=0;i<24;i++)await h.frame({changePixels:false});
  assert.deepEqual(h.reads,[]);
  assert.equal(h.scanner.running,false);
});

for(const counter of ['standard','webkit'])test(counter+' 解码计数停在正数，画面更新时仍可收卡',async t=>{
  const h=camera(t);
  if(counter==='standard')h.video.getVideoPlaybackQuality=()=>({totalVideoFrames:1});
  else h.video.webkitDecodedFrameCount=1;
  await h.scanner.start();
  for(let i=0;i<30;i++)await h.frame();
  assert.equal(h.scanner.running,true);
  assert.deepEqual(h.reads,[{cardNumber:1,option:'A'}]);
  await h.frame({changePixels:false,elapsed:4000});
  assert.equal(h.scanner.running,false);
  assert.equal(h.streams[0].track.stops,1);
});

test('标准计数停在正数时，WebKit 持续解码的静止纸卡仍可确认',async t=>{
  const h=camera(t);
  h.video.getVideoPlaybackQuality=()=>({totalVideoFrames:1});
  h.video.webkitDecodedFrameCount=0;
  await h.scanner.start();
  for(let i=0;i<30;i++){
    h.video.webkitDecodedFrameCount++;
    await h.frame({changePixels:false});
  }
  assert.equal(h.scanner.running,true);
  assert.deepEqual(h.reads,[{cardNumber:1,option:'A'}]);
});

test('没有呈现回调且解码计数为零时，活动预览可连续收卡，静止画面不累计作答',async t=>{
  const h=camera(t);
  h.video.getVideoPlaybackQuality=()=>({totalVideoFrames:0,droppedVideoFrames:0});
  await h.scanner.start();
  const pixels=image(Cards.matrix(1));
  h.scanner.ctx.getImageData=()=>({...pixels,data:pixels.data.slice()});
  for(let i=0;i<24;i++)await h.frame();
  assert.equal(h.scanner.running,true);
  assert.deepEqual(h.reads,[]);
  for(let i=1;i<=3;i++){
    pixels.data[0]=i;
    await h.frame();
  }
  assert.deepEqual(h.reads,[{cardNumber:1,option:'A'}]);
  await h.frame({advance:false,elapsed:4000});
  assert.equal(h.scanner.running,false);
});

test('浏览器声明呈现回调但没有通知，递增的解码帧仍可收卡',async t=>{
  const h=camera(t);
  let decoded=0;
  h.video.requestVideoFrameCallback=()=>42;
  h.video.getVideoPlaybackQuality=()=>({totalVideoFrames:decoded,droppedVideoFrames:0});
  await h.scanner.start();
  for(let i=0;i<24;i++){decoded++;await h.frame();}
  assert.equal(h.scanner.running,true);
  assert.deepEqual(h.reads,[{cardNumber:1,option:'A'}]);
  await h.frame({advance:false,elapsed:4000});
  assert.equal(h.scanner.running,false);
});

test('解码计数一直为零时按实际呈现的新帧收卡；冻结和上次开启的回调不计帧',async t=>{
  const h=camera(t);
  let notified, cancelled=0;
  h.video.getVideoPlaybackQuality=()=>({totalVideoFrames:0});
  h.video.requestVideoFrameCallback=callback=>{notified=callback;return 42;};
  h.video.cancelVideoFrameCallback=id=>{assert.equal(id,42);cancelled++;};
  await h.scanner.start();
  for(let i=0;i<3;i++){
    assert.equal(typeof notified,'function');
    notified(i*180,{presentedFrames:i+1});
    await h.frame();
  }
  assert.deepEqual(h.reads,[{cardNumber:1,option:'A'}]);
  const late=notified;
  await h.frame({option:'B',advance:false,elapsed:3100});
  assert.equal(h.scanner.running,false);
  assert.equal(cancelled,1);
  await h.scanner.start();
  for(let i=0;i<4;i++){late(i*180,{presentedFrames:i+4});await h.frame({option:'B'});}
  assert.deepEqual(h.reads,[{cardNumber:1,option:'A'}]);
});

test('呈现回调中途沉默且计数为零，后续真实变化的画面仍能继续收卡',async t=>{
  const h=camera(t);
  let notify;
  h.video.getVideoPlaybackQuality=()=>({totalVideoFrames:0});
  h.video.requestVideoFrameCallback=callback=>{notify=callback;return 1;};
  await h.scanner.start();
  for(let i=0;i<3;i++){notify();await h.frame();}
  for(let i=0;i<25;i++)await h.frame({option:'B'});
  assert.deepEqual(h.reads,[{cardNumber:1,option:'A'},{cardNumber:1,option:'B'}]);
  assert.equal(h.scanner.running,true);
  await h.frame({advance:false,elapsed:3100});
  assert.equal(h.scanner.running,false);
});
test('画面持续冻结后停止采集、释放轨道并清除未确认候选',async t=>{
  const h=camera(t);await h.scanner.start();await h.frame();const stream=h.video.srcObject;
  await h.frame({advance:false,elapsed:4000});
  assert.equal(h.scanner.running,false);assert.equal(h.video.srcObject,null);assert.equal(stream.track.stops,1);
  assert.equal(h.scanner.stabilizer.entries.size,0);assert.deepEqual(h.reads,[]);
  assert.ok(h.statuses.some(s=>s.kind==='error'&&/相机|画面/.test(s.message)));
});

test('手机取景中断时保留镜头，恢复后只用新画面确认且不重发已收卡',async t=>{
  const h=camera(t,{waitForFrames:true});
  await h.scanner.start();
  await h.frame();await h.frame();
  const track=h.streams[0].track;
  for(let i=0;i<3;i++)await h.frame({changePixels:false,elapsed:4000});
  assert.equal(h.scanner.running,true);
  assert.equal(track.stops,0);
  assert.equal(h.statuses.filter(s=>s.kind==='warning').length,1);
  await h.frame();await h.frame();
  assert.deepEqual(h.reads,[]);
  await h.frame();
  assert.deepEqual(h.reads,[{cardNumber:1,option:'A'}]);
  assert.equal(h.statuses.at(-1).kind,'ready');
  track.muted=true;
  for(let i=0;i<4;i++)await h.frame({option:'B'});
  assert.equal(h.reads.length,1);
  assert.equal(h.statuses.at(-1).kind,'warning');
  track.muted=false;
  for(let i=0;i<4;i++)await h.frame();
  assert.equal(h.reads.length,1);
  assert.equal(h.mediaCalls,1);
  track.end();
  assert.equal(h.scanner.running,false);
  assert.equal(h.video.srcObject,null);
  assert.equal(h.statuses.at(-1).kind,'error');
});

test('手机等待首帧时可关闭，上一轮迟到的播放失败不会关闭新镜头',async t=>{
  const first=deferred(),second=deferred();let calls=0;
  const h=camera(t,{waitForFrames:true,play:()=>++calls===1?first.promise:second.promise});
  const started=h.scanner.start();
  await settled();
  assert.equal(h.scanner.running,true);
  h.scanner.stop();await started;
  await h.scanner.start();
  first.reject(new Error('旧播放失败'));await settled();
  assert.equal(h.scanner.running,true);
  assert.equal(h.streams[1].track.stops,0);
  second.reject(new Error('当前播放失败'));await settled();
  assert.equal(h.scanner.running,false);
  assert.equal(h.streams[1].track.stops,1);
  assert.match(h.statuses.at(-1).message,/预览/);
});
for(const signal of ['event','state'])test('视频轨结束由'+signal+'发现后停止并清空候选',async t=>{
  const h=camera(t);await h.scanner.start();await h.frame();const stream=h.video.srcObject;
  if(signal==='event')stream.track.end();else{stream.track.readyState='ended';await h.frame();}
  assert.equal(h.scanner.running,false);assert.equal(h.video.srcObject,null);assert.equal(h.scanner.stabilizer.entries.size,0);
  assert.deepEqual(h.reads,[]);assert.ok(h.statuses.some(s=>s.kind==='error'&&/相机|画面/.test(s.message)));
});

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {createModel, solveArm, REST, skin, deformBody} = require('../web_controller/banban-rig.js');
const dist = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
function advance(model, seconds, rate=60) { let result; for(let i=0;i<seconds*rate;i++) result=model.step(1/rate); return result; }
test('both articulated arms preserve bone lengths for close, far and coincident wrists',()=>{
  for(const rest of Object.values(REST)) for(const wrist of [{x:0,y:0},rest.shoulder,rest.wrist,{x:512,y:343}]) {
    const upper=dist(rest.shoulder,rest.elbow),lower=dist(rest.elbow,rest.wrist);
    const pose=solveArm(rest.shoulder,wrist,upper,lower);
    assert.ok(Math.abs(dist(pose.shoulder,pose.elbow)-upper)<1e-5);
    assert.ok(Math.abs(dist(pose.elbow,pose.wrist)-lower)<1e-5);
  }
});
test('skin keeps the shoulder attached and the elbow continuous across both bones',()=>{
  for(const rest of Object.values(REST)) {
    const pose=solveArm(rest.shoulder,{x:512,y:343},dist(rest.shoulder,rest.elbow),dist(rest.elbow,rest.wrist));
    assert.ok(dist(skin(rest.shoulder,rest,pose),pose.shoulder)<1e-5);
    assert.ok(dist(skin(rest.elbow,rest,pose),pose.elbow)<1e-5);
    assert.ok(dist(skin(rest.wrist,rest,pose),pose.wrist)<1e-5);
  }
});
test('all neutral painted arm points retain their original position',()=>{
  for(const rest of Object.values(REST)) {
    const pose=solveArm(rest.shoulder,rest.wrist,dist(rest.shoulder,rest.elbow),dist(rest.elbow,rest.wrist));
    for(const p of [rest.shoulder,rest.elbow,rest.wrist,{x:585,y:510}]) assert.ok(dist(skin(p,rest,pose),p)<1e-5);
  }
});
test('a sharply bent elbow does not collapse the painted texture toward its joint',()=>{
  const rest=REST.right;
  const pose=solveArm(rest.shoulder,{x:530,y:315},dist(rest.shoulder,rest.elbow),dist(rest.elbow,rest.wrist));
  for(const p of [{x:rest.elbow.x+12,y:rest.elbow.y},{x:rest.elbow.x,y:rest.elbow.y+12}])
    assert.ok(Math.abs(dist(skin(p,rest,pose),pose.elbow)-12)<1e-5);
});
test('switching between thinking and responding does not jump an arm to another image',()=>{
  const m=createModel();m.update({state:'thinking',pose:'think',mood:'thinking'});
  const raised=advance(m,2);assert.ok(raised.rightY<360);assert.ok(raised.rightX<540);
  m.update({state:'answering',pose:'',mood:'neutral'});
  const first=m.step(1/60);assert.ok(Math.abs(first.rightY-raised.rightY)<5);
  const lowered=advance(m,2);assert.ok(lowered.rightY>540);
});
test('blinks close through intermediate eyelid positions and reopen smoothly',()=>{
  const m=createModel();m.update({blink:true});const samples=[];
  for(let i=0;i<8;i++)samples.push(m.step(1/120).closeLeft);
  assert.ok(samples.some(x=>x>.15&&x<.85));assert.ok(samples.at(-1)>.9);
  m.update({blink:false});assert.ok(m.step(1/120).closeLeft>.5);assert.ok(advance(m,.3).closeLeft<.01);
});
test('looking moves the iris before the slower head turn and stays bounded',()=>{
  const m=createModel();m.look(100,-100);const p=advance(m,.15);
  assert.ok(p.gazeX>.5);assert.ok(p.gazeY<-.5);assert.ok(p.turn<.035*p.gazeX);
  const settled=advance(m,3);assert.ok(Math.abs(settled.gazeX)<=1.001);assert.ok(Math.abs(settled.gazeY)<=1.001);
});
test('cover deformation anchors feet and leaves the face attached to its cover',()=>{
  const p={lean:.05,turn:.03,lift:-4,nod:.015};
  const foot={x:300,y:680};assert.deepEqual(deformBody(foot,p),foot);
  assert.ok(dist(deformBody({x:200,y:230},p),{x:200,y:230})>5);
});
test('reduced motion presents a settled informative pose without idle or lip movement',()=>{
  const m=createModel();m.update({state:'thinking',pose:'think',mood:'thinking',reduced:true});
  const a=m.step(0),b=m.step(.016);assert.deepEqual(a,b);assert.equal(a.rightY,315);
  m.text();m.update({state:'answering',pose:''});assert.equal(m.step(0).mouthOpen,0);
});
test('mouth response ends when text stops arriving',()=>{
  const m=createModel();m.update({state:'answering'});m.text();assert.ok(advance(m,.15).mouthOpen>.1);
  assert.ok(advance(m,1).mouthOpen<.001);
});
test('slow and fast rendering rates converge to the same articulated pose',()=>{
  const models=[createModel(),createModel()];
  for(const m of models)m.update({state:'thinking',pose:'think',mood:'thinking'});
  const a=advance(models[0],3,20),b=advance(models[1],3,120);
  for(const key of ['rightX','rightY','think','gazeX','concern'])assert.ok(Math.abs(a[key]-b[key])<.1,key);
});
test('a delayed frame cannot make the rig diverge or fling the arm',()=>{
  const m=createModel();m.update({state:'dragging'});m.drag(.12);m.step(15);
  m.update({state:'idle'});const p=advance(m,4);assert.ok(Math.abs(p.lean)<.01);
  for(const [k,v] of Object.entries(p))if(typeof v==='number')assert.ok(Number.isFinite(v),k);
});

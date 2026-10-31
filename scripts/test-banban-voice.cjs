'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const voiceSource = fs.readFileSync(path.join(__dirname, '../web_controller/banban-voice.js'), 'utf8');
const operationsSource = fs.readFileSync(path.join(__dirname, '../web_controller/banban-operations.js'), 'utf8');
const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); };
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

function hub() {
  const handlers = new Map();
  return {
    addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
    removeEventListener(name, fn) { handlers.get(name)?.delete(fn); },
    dispatchEvent(event) { for (const fn of [...handlers.get(event.type) || []]) fn(event); },
    count(name) { return handlers.get(name)?.size || 0; }
  };
}
function setup({native = true, ask, interrupt, confirm, cancel, browserStarts = true, setBinding = () => true} = {}) {
  let now = 100000, controller, conversation = 0;
  const posts = [], asks = [], spoken = [], timers = new Map(); let nextTimer = 0;
  const element = () => ({...hub(), dataset:{}, attributes:{}, setAttribute(k,v) { this.attributes[k] = v; }, remove() { this.removed = true; }});
  const micParent = {}, caption = element(), input = {value:'',placeholder:'问问班班…',before(n) { micParent.mic = n; }};
  const root = {querySelector(selector) { return selector === '#bbInput' ? input : caption; }};
  const bridge = {...hub(), postMessage(data) { posts.push(data); }};
  const window = {...hub(), ICeClassVoiceHost:native ? {version:1} : undefined, chrome:native ? {webview:bridge} : undefined};
  const document = {...hub(), hidden:false, createElement:element, getElementById:() => null};
  class Recognition { start() { Recognition.current = this; if (browserStarts) this.onstart?.(); } abort() { this.aborted = true; this.onend?.(); } }
  const speechSynthesis = {getVoices:() => [], cancel() {}, speak(value) { spoken.push(value); }};
  window.SpeechRecognition = Recognition; window.speechSynthesis = speechSynthesis;
  window.ICeClassBanbanOperations = {
    confirmVoice:confirm || (async operation => ({...operation, status:'running'})),
    cancelVoice:cancel || (async ids => ids.map(id => ({id,status:'cancelled'})))
  };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({window, document, navigator:{onLine:true}, Date:Clock, speechSynthesis,
    SpeechSynthesisUtterance:class {constructor(text) {this.text=text;}}, queueMicrotask,
    setTimeout(fn,delay) { timers.set(++nextTimer, {fn,delay}); return nextTimer; }, clearTimeout:id => timers.delete(id),
    setInterval(fn) { timers.set(++nextTimer, fn); return nextTimer; }, clearInterval:id => timers.delete(id),
    CustomEvent:class {constructor(type,options) {this.type=type; this.detail=options.detail;}}
  });
  vm.runInContext(voiceSource, context);
  controller = window.ICeClassBanbanVoice.mount({root, open() {}, setBinding,
    ask:async (text, valid) => { if (!valid()) return; asks.push(text); controller.begin('voice'); await ask?.(text, valid); },
    interrupt:interrupt || (async () => {})});
  const emit = data => {
    if (data.kind === 'wake') conversation++;
    bridge.dispatchEvent({type:'message',data:{type:'banban-voice',conversation,...data}});
  };
  const hear = text => native ? emit({kind:'transcript',text}) : Recognition.current.onresult({resultIndex:0,results:[Object.assign([{transcript:text}], {isFinal:true})]});
  return {controller,context,window,document,bridge,posts,asks,spoken,caption,input,
    get mic() {return micParent.mic;}, enable() {native ? emit({kind:'state',state:'standby',enabled:true}) : micParent.mic.dispatchEvent({type:'click'});},
    wake() {emit({kind:'wake'});}, emit,hear,advance(ms) {now += ms;}, Recognition,
    tick() { for (const timer of timers.values()) if (typeof timer === 'function') timer(); },
    expireTimeout(delay) { for (const [id,timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } },
    speech() {return posts.filter(p => p.kind === 'speak').map(p=>p.text).concat(spoken.map(v=>v.text));}
  };
}
const operation = (id='current', overrides={}) => ({id,status:'awaiting_confirmation',title:'输入验收文字',target:'本教室',impact:'将替换文字框内容。',parameters:{text:'课程已准备'},expiresAt:400000,...overrides});

test('explicit departure immediately dismisses without asking the model or waiting for cancellation', async () => {
  for (const phrase of ['退下吧', '班班，你先离开吧', '斑斑，请先退下吧', '你先休息吧', '再见班班', '结束对话']) {
    const gate = defer(), e = setup({interrupt:() => gate.promise}); e.enable(); e.wake();
    e.hear(phrase);
    assert.equal(e.posts.filter(p => p.kind === 'leave').length, 1, phrase);
    assert.equal(e.mic.dataset.state, 'standby', phrase);
    assert.equal(e.asks.length, 0, phrase);
    e.hear('打开课件'); await flush(); assert.equal(e.asks.length, 0, 'departed session stays asleep');
    gate.resolve(); await flush(); e.controller.dispose();
  }
});

test('discussing or negating departure remains an ordinary question', async () => {
  for (const phrase of ['不要退下吧', '退下吧是什么意思', '如果我说退下吧会怎样', '班班不要离开']) {
    const e = setup(); e.enable(); e.wake(); e.hear(phrase); await flush();
    assert.deepEqual(e.asks, [phrase]); assert.equal(e.posts.some(p => p.kind === 'leave'), false);
    e.controller.dispose();
  }
});

test('departure during browser playback stops the voice session and still accepts a fresh wake', async () => {
  const e = setup({native:false}); e.enable(); e.hear('你好班班');
  e.hear('退下吧'); await flush();
  assert.equal(e.mic.dataset.state, 'standby'); assert.equal(e.asks.length, 0);
  e.advance(1500); e.hear('你好班班，继续讲'); await flush();
  assert.deepEqual(e.asks, ['继续讲']); e.controller.dispose();
});

test('a wake during pending departure cancellation survives its late completion', async () => {
  const gate = defer(), e = setup({interrupt:() => gate.promise}); e.enable(); e.wake();
  e.hear('退下吧'); e.wake(); e.hear('继续讲解'); await flush();
  assert.equal(e.asks.length, 0, 'new task waits until the old interrupt has finished');
  gate.resolve(); await flush();
  assert.deepEqual(e.asks, ['继续讲解']);
  assert.notEqual(e.mic.dataset.state, 'standby');
  assert.equal(e.posts.filter(p => p.kind === 'leave').length, 1);
  e.emit({kind:'leave'}); await flush();
  assert.equal(e.posts.filter(p => p.kind === 'leave').length, 1, 'native leave does not echo a bridge command');
  e.controller.dispose();
});

test('a delayed native leave from the previous conversation cannot dismiss a fresh wake', async () => {
  const e = setup(); e.enable(); e.wake(); e.hear('退下吧'); await flush();
  e.wake(); e.emit({kind:'leave',conversation:1}); e.hear('继续讲解'); await flush();
  assert.deepEqual(e.asks, ['继续讲解']);
  assert.notEqual(e.mic.dataset.state, 'standby');
  assert.equal(e.posts.find(p => p.kind === 'leave').conversation, 1, 'bridge dismissal identifies the conversation it belongs to');
  e.controller.dispose();
});

test('native pet receives only changed terminal results from the active voice turn', async () => {
  const e=setup();e.enable();e.wake();e.hear('打开验收文件');await flush();
  e.controller.event({type:'operation',operation:operation('done',{status:'running'})});
  const done=operation('done',{status:'succeeded'});
  e.controller.event({type:'operation',operation:done});
  e.window.dispatchEvent({type:'banban-operation-updated',detail:done});
  e.controller.event({type:'operation',operation:operation('failed',{status:'failed'})});
  assert.deepEqual(e.posts.filter(p=>p.kind==='task-result').map(p=>p.text),['succeeded','failed']);
  e.controller.begin('text');
  e.window.dispatchEvent({type:'banban-operation-updated',detail:operation('done',{status:'cancelled'})});
  assert.equal(e.posts.filter(p=>p.kind==='task-result').length,2);e.controller.dispose();
});

test('native authorization recovers when the class list finishes after chat mounts', async () => {
  let loaded = false;
  const e = setup({setBinding: value => loaded && value.classId === 'classroom'});
  await flush();
  e.emit({kind:'binding',classId:'classroom',deviceId:'device'});
  assert.equal(e.posts.filter(p => p.kind === 'authorized').at(-1).value, false);
  loaded = true; e.window.dispatchEvent({type:'iceclass-ready'});
  assert.equal(e.posts.filter(p => p.kind === 'authorized').at(-1).value, true);
  assert.equal(e.controller.context().classId, 'classroom');
  e.controller.dispose();
});

test('scope refresh revokes native authorization and disposal cannot restore it', async () => {
  let allowed = true;
  const e = setup({setBinding: () => allowed});
  await flush(); e.emit({kind:'binding',classId:'classroom',deviceId:'device'});
  assert.equal(e.posts.filter(p => p.kind === 'authorized').at(-1).value, true);
  allowed = false; e.window.dispatchEvent({type:'iceclass-classes-changed'});
  assert.equal(e.posts.filter(p => p.kind === 'authorized').at(-1).value, false);
  e.controller.dispose(); const count = e.posts.length;
  allowed = true; e.window.dispatchEvent({type:'iceclass-ready'}); e.window.dispatchEvent({type:'iceclass-classes-changed'});
  assert.equal(e.posts.length, count);
  assert.equal(e.window.count('iceclass-ready'), 0); assert.equal(e.window.count('iceclass-classes-changed'), 0);
});

test('browser waits for wake, then accepts a task and follow-up without repeating wake', async () => {
  const e = setup({native:false}); e.enable();
  e.hear('请翻到下一页'); await flush(); assert.equal(e.asks.length,0);
  e.hear('你好，班班，打开课件'); await flush(); assert.deepEqual(e.asks,['打开课件']);
  e.hear('再打开数学课件'); await flush(); assert.equal(e.asks.at(-1),'再打开数学课件');
  e.controller.dispose();
});

test('browser keeps each follow-up open for three minutes and renews the idle wait after speech', async () => {
  const e = setup({native:false}); e.enable();
  e.hear('你好班班，打开课件'); await flush();
  e.advance(100000); e.tick(); await flush();
  assert.equal(e.mic.dataset.state, 'listening');
  e.hear('再打开数学课件'); await flush();
  assert.deepEqual(e.asks, ['打开课件', '再打开数学课件']);
  e.advance(179999); e.tick(); await flush();
  assert.equal(e.mic.dataset.state, 'listening');
  e.advance(2); e.tick(); await flush();
  assert.equal(e.mic.dataset.state, 'standby');
  e.hear('打开英语课件'); await flush();
  assert.equal(e.asks.length, 2);
  e.controller.dispose();
});

test('browser does not claim to listen until recognition starts and stops after a startup timeout', async () => {
  const e=setup({native:false,browserStarts:false});e.enable();
  assert.equal(e.mic.dataset.state,'connecting');assert.doesNotMatch(e.caption.textContent,/等候/);
  e.expireTimeout(12000);await flush();assert.equal(e.mic.dataset.state,'error');
  assert.equal(e.mic.attributes['aria-pressed'],'false');assert.equal(e.Recognition.current.aborted,true);
  assert.match(e.caption.textContent,/本机/);e.Recognition.current.onstart();
  assert.equal(e.mic.dataset.state,'error');e.controller.dispose();
});

test('browser voice network failure stops capture and offers the native assistant without blind retries', async () => {
  const e=setup({native:false});e.enable();const failed=e.Recognition.current;
  failed.onerror({error:'network'});await flush();
  assert.equal(e.mic.dataset.state,'error');assert.equal(e.mic.dataset.error,'network');assert.equal(failed.aborted,true);
  assert.equal(e.mic.attributes['aria-pressed'],'false');assert.match(e.caption.textContent,/语音识别服务.*本机/);
  e.hear('你好班班打开课件');await flush();assert.equal(e.asks.length,0);
  e.enable();assert.notEqual(e.Recognition.current,failed);assert.equal(e.mic.dataset.state,'standby');
  failed.onend();e.hear('你好班班打开课件');await flush();assert.deepEqual(e.asks,['打开课件']);e.controller.dispose();
});

test('native audio feedback reflects microphone input and clears when voice is disabled', () => {
  const e=setup();e.enable();e.emit({kind:'audio-level',level:55});assert.equal(e.mic.dataset.level,'3');
  e.emit({kind:'audio-level',level:0});assert.equal(e.mic.dataset.level,'0');
  e.emit({kind:'state',state:'off',enabled:false});assert.equal(e.mic.dataset.level,undefined);e.controller.dispose();
});

test('a browser recognition startup failure does not interrupt an existing typed task', async () => {
  let stops=0;const e=setup({native:false,browserStarts:false,interrupt:async()=>{stops++;}});
  e.controller.begin('text');e.enable();e.Recognition.current.onerror({error:'network'});await flush();
  assert.equal(stops,0);assert.equal(e.mic.dataset.state,'error');
  e.controller.settled();e.controller.dispose();
});
test('only completed answers are spoken; deltas and reset text stay silent', async () => {
  const e=setup(); e.enable(); e.wake(); e.hear('查看今天晨读'); await flush();
  e.controller.event({type:'delta',text:'我想先去查询'}); e.controller.event({type:'answer_reset'});
  assert.equal(e.speech().length,0);
  e.controller.event({type:'done',message:{content:'今天有效发声九分三十秒。'}});
  assert.deepEqual(e.speech(),['今天有效发声九分三十秒。']); e.controller.dispose();
});

test('native partial transcripts preview without submitting or overwriting typed input', async () => {
  const e=setup();e.enable();e.emit({kind:'partial',text:'待机不应显示'});
  assert.equal(e.input.placeholder,'问问班班…');e.wake();
  e.input.value='我正在输入';e.emit({kind:'partial',text:'打开数学课件'});await flush();
  assert.equal(e.input.value,'我正在输入');assert.equal(e.input.placeholder,'打开数学课件');assert.equal(e.asks.length,0);
  e.emit({kind:'partial',text:''});assert.equal(e.input.placeholder,'问问班班…');
  e.emit({kind:'state',state:'speaking',enabled:true});e.emit({kind:'partial',text:'不能接收自己的播报'});
  assert.equal(e.input.placeholder,'问问班班…');
  e.emit({kind:'state',state:'listening',enabled:true});e.emit({kind:'partial',text:'下一页'});
  e.emit({kind:'state',state:'standby',enabled:true});assert.equal(e.input.placeholder,'问问班班…');
  e.emit({kind:'partial',text:'过期回调'});assert.equal(e.input.placeholder,'问问班班…');e.controller.dispose();
});

test('unknown words never submit a task, confirm or cancel the pending operation', async () => {
  let confirmations=0, cancellations=0;
  const e=setup({confirm:async o=>{confirmations++;return {...o,status:'running'};},cancel:async()=>{cancellations++;return [];}});
  e.enable();e.wake();e.hear('把验收文字改成 Hello class');await flush();
  e.controller.event({type:'operation',operation:operation()});
  for(const text of ['打开<unk>','确认<UNK>执行','取消[unk]操作','班班< unknown >停一下','打开\uFFFD']) {
    e.hear(text);await flush();
    assert.deepEqual(e.asks,['把验收文字改成 Hello class']);
    assert.equal(confirmations,0);assert.equal(cancellations,0);assert.match(e.speech().at(-1),/没听清.*还未执行/);
  }
  e.hear('确认执行');await flush();assert.equal(confirmations,1);e.controller.dispose();
});

test('unknown partials stay out of the input and native repeat feedback is not spoken twice', async () => {
  const e=setup();e.enable();e.wake();e.input.value='保留我的草稿';
  e.emit({kind:'partial',text:'打开<unk>'});assert.equal(e.input.placeholder,'问问班班…');
  e.emit({kind:'unrecognized'});await flush();assert.equal(e.speech().length,0);assert.equal(e.input.value,'保留我的草稿');
  e.emit({kind:'partial',text:'Open Excel'});assert.equal(e.input.placeholder,'Open Excel');e.controller.dispose();
});

test('browser recognition rejects an unknown wake remainder then accepts English and code switching', async () => {
  const e=setup({native:false});e.enable();e.hear('你好班班，打开<unk>');await flush();
  assert.equal(e.asks.length,0);assert.match(e.speech().at(-1),/没听清/);
  e.spoken.at(-1).onend();e.advance(1000);e.hear('Please open PowerPoint');await flush();
  assert.deepEqual(e.asks,['Please open PowerPoint']);
  e.hear('打开 Word 文档');await flush();assert.equal(e.asks.at(-1),'打开 Word 文档');e.controller.dispose();
});

test('unknown recognition does not supersede a valid request already in progress', async () => {
  const gate=defer();let valid,stops=0;
  const e=setup({ask:async(_,check)=>{valid=check;await gate.promise;},interrupt:async()=>{stops++;}});
  e.enable();e.wake();e.hear('Open Word');await flush();e.hear('<unk>');await flush();
  assert.equal(stops,0);assert.equal(valid(),true);assert.deepEqual(e.asks,['Open Word']);
  gate.resolve();await flush();e.controller.dispose();
});
test('consent is exact and bound to a single operation from this voice turn', async () => {
  const confirmed=[]; const e=setup({confirm:async o => {confirmed.push(o.id); return {...o,status:'running'};}});
  e.enable(); e.wake(); e.hear('确认执行'); await flush(); assert.equal(confirmed.length,0);
  e.hear('填写验收文字'); await flush(); e.controller.event({type:'operation',operation:operation()});
  e.hear('确认这项操作'); await flush(); assert.deepEqual(confirmed,['current']);
  e.hear('确认执行'); await flush(); assert.equal(confirmed.length,1); e.controller.dispose();
});
test('ordinary assent preserves the pending plan without confirming or starting a new task', async () => {
  let count=0; const cancelled=[]; const e=setup({confirm:async()=>{count++;},cancel:async ids=>{cancelled.push(...ids); return [];} });
  e.enable();e.wake();e.hear('改验收文字');await flush();e.controller.event({type:'operation',operation:operation()});
  e.hear('好的');await flush();assert.equal(count,0);assert.deepEqual(cancelled,[]);assert.deepEqual(e.asks,['改验收文字']);
  assert.match(e.speech().at(-1),/确认执行/);
  e.hear('确认执行');await flush();assert.equal(count,1);e.controller.dispose();
});
test('a brief acknowledgement cannot supersede a request that is still being processed', async () => {
  const gate=defer();let valid,stops=0;
  const e=setup({ask:async(_,check)=>{valid=check;await gate.promise;},interrupt:async()=>{stops++;}});
  e.enable();e.wake();e.hear('查看今天课表');await flush();
  const speechBefore=e.speech().length;
  for(const word of ['嗯','知道了','好的','谢谢班班','您好']) { e.hear(word);await flush(); }
  assert.equal(stops,0);assert.equal(valid(),true);assert.equal(e.speech().length,speechBefore);
  assert.deepEqual(e.asks,['查看今天课表']);gate.resolve();await flush();e.controller.dispose();
});
test('a new instruction still replaces the previous pending plan', async () => {
  const cancelled=[];const e=setup({cancel:async ids=>{cancelled.push(...ids);return [];}});
  e.enable();e.wake();e.hear('改验收文字');await flush();e.controller.event({type:'operation',operation:operation()});
  e.hear('改成打开数学课件');await flush();
  assert.deepEqual(cancelled,['current']);assert.equal(e.asks.at(-1),'改成打开数学课件');e.controller.dispose();
});
test('confirmation avoids repeated target labels and retains consequential changes', async () => {
  const e=setup();e.enable();e.wake();e.hear('修改班级');await flush();
  e.controller.event({type:'operation',operation:operation('compact',{title:'本教室的填写操作',impact:''})});
  assert.equal((e.speech().at(-1).match(/本教室/g)||[]).length,1);
  assert.ok(e.speech().at(-1).length<50);assert.match(e.speech().at(-1),/确认执行/);
  e.controller.event({type:'operation',operation:operation('danger',{title:'删除班级',target:'高一（2）班',impact:'班级及关联记录会永久删除，无法撤销。'})});
  assert.match(e.speech().at(-1),/高一（2）班/);assert.match(e.speech().at(-1),/无法撤销/);e.controller.dispose();
});
test('short conversational stop phrases silence speech without cancelling the task', async () => {
  for(const phrase of ['等一下','班班等一下','先停一下','暂停播报','别念了']) {
    let stops=0;const e=setup({interrupt:async()=>{stops++;}});
    e.enable();e.wake();e.hear('查看今天课表');await flush();
    e.controller.event({type:'done',message:{content:'今天第一节是数学。'}});
    e.hear(phrase);await flush();
    const count=e.speech().length;
    e.controller.failed('旧错误');assert.equal(e.speech().length,count,phrase);
    assert.equal(stops,0,phrase);assert.deepEqual(e.asks,['查看今天课表']);e.controller.dispose();
  }
});
test('cancellation reports a racing completed operation honestly and briefly', async () => {
  const e=setup({cancel:async ids=>ids.map(id=>({id,status:'succeeded'}))});
  e.enable();e.wake();e.hear('改验收文字');await flush();e.controller.event({type:'operation',operation:operation()});
  e.hear('取消操作');await flush();
  assert.match(e.speech().at(-1),/已完成|已经完成/);assert.doesNotMatch(e.speech().at(-1),/已取消/);
  assert.ok(e.speech().at(-1).length<35);e.controller.dispose();
});
test('ambiguous operations, passwords, and elapsed consent cannot silently execute', async () => {
  let count=0;const e=setup({confirm:async()=>{count++;}});e.enable();e.wake();e.hear('做准备');await flush();
  e.controller.event({type:'operation',operation:operation('one')});e.controller.event({type:'operation',operation:operation('two')});
  e.hear('确认执行');await flush();assert.equal(count,0);
  e.hear('设置新密码');await flush();e.controller.event({type:'operation',operation:operation('password',{needsPassword:true})});
  e.hear('确认执行');await flush();assert.equal(count,0);assert.match(e.speech().at(-1),/手动确认/);
  e.hear('改验收文字');await flush();e.controller.event({type:'operation',operation:operation()});
  e.advance(46000);e.hear('确认执行');await flush();assert.equal(count,0);assert.match(e.speech().at(-1),/再次说/);
  e.hear('确认执行');await flush();assert.equal(count,1);e.controller.dispose();
});
test('interrupt only stops speech; cancel reaches the task and operation engine', async () => {
  let stops=0;const cancelled=[];const e=setup({interrupt:async()=>{stops++;},cancel:async ids=>{cancelled.push(...ids);return ids.map(id=>({id,status:'stopping'}));}});
  e.enable();e.wake();e.hear('填写验收文字');await flush();e.controller.event({type:'operation',operation:operation()});
  e.hear('班班停一下');await flush();assert.equal(stops,0);
  e.hear('取消操作');await flush();assert.equal(stops,1);assert.deepEqual(cancelled,['current']);assert.match(e.speech().at(-1),/需要设备确认/);e.controller.dispose();
});

test('interrupt keeps late answers and failures silent until the next voice request', async () => {
  for (const native of [true,false]) {
    const gate=defer();let stops=0;
    const e=setup({native,ask:()=>gate.promise,interrupt:async()=>{stops++;}});
    e.enable();if(native)e.wake();
    e.hear(native?'查看今天晨读':'你好班班查看今天晨读');await flush();
    e.hear('班班停一下');await flush();
    e.controller.event({type:'done',message:{content:'稍晚到达的晨读结果。'}});
    e.controller.failed('稍晚到达的连接错误。');
    assert.equal(e.speech().length,0,native?'native':'browser');assert.equal(stops,0);
    gate.resolve();await flush();
    e.hear('查看明天课表');await flush();
    e.controller.event({type:'done',message:{content:'明天第一节是数学。'}});
    assert.deepEqual(e.speech(),['明天第一节是数学。']);e.controller.dispose();
  }
});

test('native interrupt silences later prompts while preserving explicit confirmation', async () => {
  const gate=defer();let writes=0;
  const e=setup({ask:()=>gate.promise,confirm:async o=>{writes++;return {...o,status:'running'};}});
  e.enable();e.wake();e.hear('填写验收文字');await flush();
  e.emit({kind:'interrupt'});
  e.controller.event({type:'operation',operation:operation()});
  assert.equal(e.speech().length,0);assert.equal(writes,0);
  gate.resolve();await flush();
  e.hear('确认执行');await flush();
  assert.equal(writes,1);assert.match(e.speech().at(-1),/已确认/);e.controller.dispose();
});

test('interrupt during cancellation suppresses its delayed spoken receipt', async () => {
  const gate=defer();const e=setup({cancel:()=>gate.promise});
  e.enable();e.wake();e.hear('填写验收文字');await flush();
  e.controller.event({type:'operation',operation:operation()});
  e.hear('取消操作');await flush();const before=e.speech().length;
  e.emit({kind:'interrupt'});gate.resolve([{id:'current',status:'cancelled'}]);await flush();
  assert.equal(e.speech().length,before);e.controller.dispose();
});

test('a fresh native wake restores speech after an interrupted turn', async () => {
  const e=setup();e.enable();e.wake();e.hear('查询晨读');await flush();
  e.emit({kind:'interrupt'});e.controller.failed('旧错误');
  assert.equal(e.speech().length,0);
  e.wake();e.hear('查看课表');await flush();
  e.controller.event({type:'done',message:{content:'今天课程已经结束。'}});
  assert.deepEqual(e.speech(),['今天课程已经结束。']);e.controller.dispose();
});

const voiceSentence = (sequence, text, end=false, turnId='a'.repeat(32)) => ({type:'speech',turnId,sequence,text,end});
test('committed native speech is queued in order and the final answer is not read twice', async () => {
  const e=setup();e.enable();e.wake();e.hear('看看课表');await flush();
  e.controller.event({type:'delta',text:'可撤回草稿'});
  e.controller.event(voiceSentence(0,'第一节是数学。'));
  e.controller.event(voiceSentence(0,'重复句。'));
  e.controller.event(voiceSentence(1,'第二节是语文。'));
  e.controller.event(voiceSentence(2,'',true));
  e.controller.event({type:'done',message:{content:'第一节是数学。第二节是语文。'}});
  const parts=e.posts.filter(p=>p.kind==='speech-segment');
  assert.deepEqual(parts.map(p=>p.text),['第一节是数学。','第二节是语文。','']);
  assert.deepEqual(parts.map(p=>p.sequence),[0,1,2]);assert.equal(parts.at(-1).end,true);
  assert.equal(e.speech().length,0);e.controller.dispose();
});

test('browser speech waits for each sentence and interruption discards queued and late audio', async () => {
  const e=setup({native:false});e.enable();e.hear('你好班班查看课表');await flush();
  e.controller.event(voiceSentence(0,'第一句。'));e.controller.event(voiceSentence(1,'第二句。'));
  assert.deepEqual(e.speech(),['第一句。']);
  e.spoken[0].onend();assert.deepEqual(e.speech(),['第一句。','第二句。']);
  e.controller.event(voiceSentence(2,'第三句。'));
  e.hear('班班停一下');await flush();e.spoken[1].onend();
  e.controller.event(voiceSentence(3,'晚到第四句。'));e.controller.event(voiceSentence(4,'',true));
  e.controller.event({type:'done',message:{content:'全量内容。'}});
  assert.deepEqual(e.speech(),['第一句。','第二句。']);e.controller.dispose();
});

test('a native barge-in stops audio but a task is replaced only after a completed new transcript', async () => {
  const gate=defer();let stops=0;const e=setup({ask:()=>gate.promise,interrupt:async()=>{stops++;}});
  e.enable();e.wake();e.hear('查看课表');await flush();e.controller.event(voiceSentence(0,'正在说的结果。'));
  const beforeStop=e.posts.filter(p=>p.kind==='stop-speech').length;
  e.emit({kind:'barge-in'});await flush();assert.equal(stops,0);
  assert.equal(e.posts.filter(p=>p.kind==='stop-speech').length,beforeStop,'native promotion must retain its recognizer context');
  e.controller.event(voiceSentence(1,'旧结果继续。'));assert.equal(e.posts.filter(p=>p.kind==='speech-segment').length,1);
  e.emit({kind:'partial',text:'改成查看晨读'});await flush();assert.equal(e.asks.length,1);
  e.hear('改成查看晨读');await flush();assert.equal(stops,1);assert.equal(e.asks.at(-1),'改成查看晨读');
  gate.resolve();await flush();e.controller.dispose();
});

test('missing or out-of-order speech segments stop playback instead of leaving it stuck', async () => {
  for (const gap of [true,false]) {
    const e=setup();e.enable();e.wake();e.hear('查看课表');await flush();
    e.controller.event(voiceSentence(0,'第一句。'));
    const before=e.posts.filter(p=>p.kind==='stop-speech').length;
    if (gap) e.controller.event(voiceSentence(2,'缺少前一句。'));
    else e.controller.settled();
    assert.ok(e.posts.filter(p=>p.kind==='stop-speech').length>before);
    e.controller.event(voiceSentence(1,'晚到的语音。'));
    assert.equal(e.posts.filter(p=>p.kind==='speech-segment').length,1);
    e.controller.dispose();
  }
});

test('old browser speech errors do not replace the status of a fresh utterance', async () => {
  const e=setup({native:false});e.enable();e.hear('你好班班查看课表');await flush();
  e.controller.event({type:'done',message:{content:'旧回复。'}});const old=e.spoken[0];
  e.hear('班班停一下');await flush();e.advance(1500);e.hear('查看晨读');await flush();
  e.controller.event({type:'done',message:{content:'新回复。'}});
  old.onerror({error:'synthesis-failed'});assert.notEqual(e.mic.dataset.state,'error');e.controller.dispose();
});

test('audio device changes end the current voice session without replaying an old command', async () => {
  const gate=defer();let stops=0;const e=setup({ask:()=>gate.promise,interrupt:async()=>{stops++;}});
  e.enable();e.wake();e.hear('查看课表');await flush();
  e.emit({kind:'audio-device-changed'});await flush();assert.equal(stops,1);
  gate.resolve();e.controller.event({type:'done',message:{content:'过期回复。'}});await flush();
  e.hear('打开课件');await flush();assert.deepEqual(e.asks,['查看课表']);assert.equal(e.speech().length,0);e.controller.dispose();
});

test('wake alone does not revive an interrupted turn before a fresh instruction', async () => {
  const e=setup();e.enable();e.wake();e.hear('查看课表');await flush();
  e.emit({kind:'interrupt'});e.wake();
  e.controller.event(voiceSentence(0,'旧结果。'));e.controller.failed('旧错误。');
  assert.equal(e.speech().length,0);assert.equal(e.posts.filter(p=>p.kind==='speech-segment').length,0);e.controller.dispose();
});
test('racing transcripts behind cancellation only start the newest request', async () => {
  const gate=defer();let stopCount=0;const e=setup({interrupt:()=>{stopCount++;return gate.promise;}});
  e.enable();e.wake();e.hear('查询晨读');await flush();e.controller.begin('voice');
  e.hear('打开数学课件');e.hear('打开语文课件');await flush();assert.equal(stopCount,1);
  gate.resolve();await flush();assert.deepEqual(e.asks,['查询晨读','打开语文课件']);e.controller.dispose();
});
test('cancel during consent invalidates the confirmation before a write can start', async () => {
  const gate=defer();let writes=0;const e=setup({confirm:async(o,valid)=>{await gate.promise;if(valid())writes++;return {...o,status:'cancelled'};}});
  e.enable();e.wake();e.hear('填写验收文字');await flush();e.controller.event({type:'operation',operation:operation()});
  e.hear('确认执行');await flush();e.hear('取消操作');await flush();gate.resolve();await flush();assert.equal(writes,0);e.controller.dispose();
});
test('browser hidden-page pauses listening; native hidden window keeps listening', async () => {
  for(const native of [false,true]) {
    const e=setup({native});e.enable();if(native)e.wake();e.document.hidden=true;e.document.dispatchEvent({type:'visibilitychange'});
    e.hear(native?'查看晨读':'你好班班查看晨读');await flush();assert.equal(e.asks.length,native?1:0);e.controller.dispose();
  }
});
test('logout/dispose removes listeners and invalidates delayed inputs', async () => {
  const gate=defer();const e=setup({interrupt:()=>gate.promise});e.enable();e.wake();e.hear('查询');await flush();e.controller.begin('voice');e.hear('打开课件');
  e.controller.dispose();gate.resolve();await flush();e.hear('改文字');await flush();
  assert.deepEqual(e.asks,['查询']);assert.equal(e.bridge.count('message'),0);assert.equal(e.window.count('banban-operation-updated'),0);assert.equal(e.mic.removed,true);
});

test('real operation adapter re-reads data and rejects changes, expiry, password, and late consent', async () => {
  for(const variant of ['changed','expired','password','late','allowed']) {
    const e=setup();const original=operation();let writes=0;const fresh={...original};
    if(variant==='changed')fresh.parameters={text:'different'};
    if(variant==='expired')fresh.expiresAt=1;
    if(variant==='password')fresh.needsPassword=true;
    e.window.ICeClass={api:async(url,options)=>{if(options?.method==='POST'){writes++;return {...fresh,status:'running'};}return fresh;},refreshManagement:async()=>{}};
    vm.runInContext(operationsSource,e.context);
    const result=e.window.ICeClassBanbanOperations.confirmVoice(original,()=>variant!=='late');
    if(variant==='allowed')await result;else await assert.rejects(result);
    assert.equal(writes,variant==='allowed'?1:0,variant);e.controller.dispose();
  }
});

'use strict';

const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {open, navigate} = require('./test-teacher-ui.cjs');

let browser;
before(async () => { browser = await chromium.launch({channel:'msedge', headless:true}); });
after(async () => { await browser?.close(); });

const single = {type:'single', text:'哪一项符合题意？', options:['甲','乙'], answer:'A', tags:[],
  bounds:[0,0,1000,500], reviewNote:''};
const multiple = {type:'multiple', text:'选出图中成立的结论', options:['甲','乙','丙','丁'], answer:'AC',
  tags:['几何'], bounds:[250,500,500,500], reviewNote:'请核对 <角 ABC> 的标注。'};
const judgment = {type:'boolean', text:'两直线平行。', options:['正确','错误'], answer:null, tags:[],
  bounds:[0,500,1000,500], reviewNote:''};
const action = (page, name) => page.locator('[data-cq-action="' + name + '"]');
const recognize = page => action(page, 'recognize').click();
const save = page => action(page, 'save-question').click();
const ready = page => page.locator('[data-cq-action="recognize"]:enabled').waitFor();
const heading = (page, position) => page.getByRole('heading', {name:'审阅第 ' + position + ' 题'}).waitFor();
const feedback = (page, text) => page.locator('.cq-feedback').filter({hasText:text}).waitFor();

async function setup(t, width = 1280) {
  const state = {recognitions:[], images:[], posts:[], bank:[], reads:0,
    recognize:() => ({json:{drafts:[multiple,single,judgment]}})};
  const result = await open(browser, {width, handle:async ({url, request}) => {
    const method = request.method(), path = url.pathname;
    if (path === '/api/card-quiz/questions/recognize' && method === 'POST') {
      const body = request.postDataJSON();
      state.recognitions.push(body);
      return state.recognize(body);
    }
    if (path === '/api/card-quiz/images' && method === 'POST') {
      state.images.push(request.postDataJSON().dataUrl);
      return await state.upload?.() || {json:{id:'image-' + state.images.length}};
    }
    if (path === '/api/card-quiz/questions' && method === 'GET') {
      state.reads++;
      return {json:{questions:state.bank}};
    }
    if (path === '/api/card-quiz/questions' && method === 'POST') {
      const {value} = request.postDataJSON();
      state.posts.push(value);
      const failure = await state.write?.();
      if (failure) return failure;
      const saved = {...value, id:'question-' + (state.bank.length + 1), revision:1};
      state.bank.push(saved);
      return {json:saved};
    }
  }});
  const {page} = result;
  t.after(async () => { await result.context.close(); assert.deepEqual(result.errors, []); });
  await navigate(page, 'card-quiz');
  await page.locator('[data-cq-tab="bank"]:enabled').click();
  await action(page, 'open-import').focus();
  await page.keyboard.press('Enter');
  await action(page, 'choose-screenshot').waitFor();
  return {page, state};
}

async function screenshot(page, mimeType = 'image/png') {
  const dataUrl = await page.evaluate(type => {
    const canvas = document.createElement('canvas');
    canvas.width = 80; canvas.height = 60;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f00'; ctx.fillRect(0,0,80,30);
    ctx.fillStyle = '#00f'; ctx.fillRect(0,30,80,30);
    ctx.fillStyle = '#0f0'; ctx.fillRect(20,30,1,1);
    ctx.fillStyle = '#ff0'; ctx.fillRect(59,59,1,1);
    return canvas.toDataURL(type);
  }, mimeType);
  return {dataUrl, file:{name:'试题.' + mimeType.split('/')[1], mimeType, buffer:Buffer.from(dataUrl.split(',')[1],'base64')}};
}

async function choose(page, file) {
  await page.locator('#cq-import-file').setInputFiles(file);
  await ready(page);
}

async function paste(page, {dataUrl, file}) {
  return page.evaluate(({dataUrl, mimeType}) => {
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), c => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], '粘贴截图', {type:mimeType}));
    const event = new ClipboardEvent('paste', {clipboardData:data, bubbles:true, cancelable:true});
    document.activeElement.dispatchEvent(event);
    return event.defaultPrevented;
  }, {dataUrl, mimeType:file.mimeType});
}

// Check pixels as well as the crop's dimensions; these distinguish xywh from two corners.
async function pixels(page, url) {
  return page.evaluate(async src => {
    const image = new Image();
    image.src = src; await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const color = (x,y) => [...ctx.getImageData(x,y,1,1).data];
    return [canvas.width, canvas.height, color(0,0), color(canvas.width-1,canvas.height-1)];
  }, url);
}

test('桌面从题库选图，多题逐题核对编辑、裁图保存、跳过及移除配图', async t => {
  const {page,state} = await setup(t);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.cqAction), 'choose-screenshot');
  await page.getByLabel('识别学科').selectOption('physics');
  const source = await screenshot(page);
  const choosing = page.waitForEvent('filechooser');
  await action(page, 'choose-screenshot').press('Enter');
  await (await choosing).setFiles(source.file);
  await ready(page);
  assert.equal(state.recognitions.length, 0);
  const reads = state.reads;
  await recognize(page);
  await heading(page, '1 / 3');
  const [request] = state.recognitions;
  assert.deepEqual(Object.keys(request).sort(), ['dataUrl','requestKey','subjectId']);
  assert.equal(request.subjectId,'physics'); assert.equal(request.dataUrl,source.dataUrl); assert.ok(request.requestKey);
  assert.equal(await page.getByRole('img',{name:'本题截图'}).getAttribute('viewBox'), '20 30 40 30');
  assert.match(await page.locator('.cq-import-note').innerText(), /<角 ABC>/);
  const sourceLink = await page.getByRole('link',{name:/查看完整原图/}).getAttribute('href');
  assert.deepEqual((await pixels(page,sourceLink)).slice(0,2), [80,60]);
  const form = page.locator('#cq-question-form');
  assert.ok((await form.boundingBox()).x > (await page.locator('.cq-import-preview').boundingBox()).x);
  assert.equal(await form.getByLabel('题型').locator('option').count(), 3);
  assert.deepEqual(await form.locator('[name=answer]:checked').evaluateAll(nodes=>nodes.map(n=>n.value)), ['A','C']);
  await form.getByLabel('题干').fill('根据图中标注选择');
  await form.getByLabel('选项 B').fill('两角相等\n见图中标注');
  await form.getByLabel('B',{exact:true}).check(); await form.getByLabel('C',{exact:true}).uncheck();
  await form.getByLabel(/知识点/).fill('几何，角');
  await page.evaluate(() => window.dispatchEvent(new Event('iceclass-classes-changed')));
  assert.equal(state.images.length + state.posts.length, 0);
  await save(page);
  await heading(page, '2 / 3');
  assert.deepEqual(await pixels(page,state.images[0]), [40,30,[0,255,0,255],[255,255,0,255]]);
  assert.deepEqual(state.bank[0], {type:'multiple',text:'根据图中标注选择',subjectId:'physics',options:['甲','两角相等\n见图中标注','丙','丁'],
    answer:'AB',tags:['几何','角'],imageId:'image-1',id:'question-1',revision:1});
  assert.equal(await page.evaluate(() => document.activeElement.id),'cq-import-heading');
  await action(page,'skip-import').press('Enter');
  await heading(page,'3 / 3');
  assert.equal(await form.getByLabel(/标准答案/).inputValue(),'');
  await form.getByLabel(/标准答案/).selectOption('B');
  await page.getByLabel('保留本题截图作配图').uncheck();
  await save(page);
  await feedback(page,'已入库 2 道，跳过 1 道');
  assert.equal(await action(page,'edit-question').count(),2);
  assert.equal(state.bank[1].imageId,null); assert.equal(state.bank[1].answer,'B');
  assert.equal(state.images.length,1); assert.equal(state.recognitions.length,1); assert.equal(state.reads,reads);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.cqAction),'open-import');
});

test('窄屏粘贴和键盘录题，模型及数据错误保留原图供手动保存', async t => {
  const {page,state} = await setup(t,360);
  const source = await screenshot(page,'image/webp');
  assert.equal(await paste(page,source),true); await ready(page);
  const failures = [
    [{status:503,json:{error:'模型暂时不可用'}}, '模型暂时不可用'],
    [{status:504,json:{code:'recognition_timeout',error:'模型识别超时'}}, '模型识别超时'],
    [{json:{drafts:[]}}, '未得到'],
    [{json:{drafts:Array(9).fill(single)}}, '未得到'],
    [{json:{drafts:[{...single,type:'essay'}]}}, '格式有误'],
    [{json:{drafts:[{...multiple,answer:'AZ'}]}}, '格式有误'],
    [{json:{drafts:[{...single,bounds:[950,20,100,200]}]}}, '范围无效']
  ];
  for (const [reply, message] of failures) {
    state.recognize = () => reply;
    await action(page,'recognize').press('Enter');
    await feedback(page,message);
    await page.getByRole('img',{name:'待识别的截图'}).waitFor();
  }
  const keys = state.recognitions.map(r=>r.requestKey);
  assert.equal(keys[0], keys[1], 'A lost or ambiguous response can be retrieved with the same request key');
  assert.equal(new Set(keys.slice(1)).size,keys.length-1,'Each explicit retry after a definitive model result starts a new attempt');
  await action(page,'manual-import').press('Enter');
  await heading(page,'1 / 1');
  assert.equal(await page.evaluate(() => document.activeElement.name),'text');
  assert.equal(await page.getByRole('img',{name:'本题截图'}).getAttribute('viewBox'),'0 0 80 60');
  assert.ok((await page.locator('#cq-question-form').boundingBox()).y > (await page.locator('.cq-import-preview').boundingBox()).y);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const form = page.locator('#cq-question-form');
  await form.getByLabel('题干').fill('手动补录表格题');
  await form.getByLabel('题型').selectOption('boolean');
  await form.getByLabel(/标准答案/).selectOption('A');
  await form.getByLabel(/知识点/).fill('统计');
  await action(page,'save-question').press('Enter');
  await feedback(page,'已入库 1 道');
  assert.deepEqual(state.images,[source.dataUrl]); assert.equal(state.bank[0].type,'boolean');
  assert.deepEqual(state.bank[0].options,['正确','错误']); assert.equal(state.bank[0].text,'手动补录表格题');
  assert.equal(state.recognitions.length,failures.length);
  assert.equal(await paste(page,source),false);
});

test('文件类型、实际内容和 2 MiB 边界均在发请求前校验', async t => {
  const {page,state} = await setup(t);
  const input = page.locator('#cq-import-file');
  const png = (await screenshot(page)).file;
  await input.setInputFiles({...png,mimeType:'image/gif'}); await feedback(page,'单张最多 2 MiB');
  await input.setInputFiles({...png,buffer:Buffer.alloc(2*1024*1024+1)}); await feedback(page,'单张最多 2 MiB');
  await input.setInputFiles({...png,buffer:Buffer.from('GIF89a')}); await feedback(page,'文件格式不符');
  assert.ok(await action(page,'recognize').isDisabled());
  const exact = Buffer.alloc(2*1024*1024);
  png.buffer.copy(exact);
  await choose(page,{...png,buffer:exact});
  const oldUrl = await page.getByRole('img',{name:'待识别的截图'}).getAttribute('src');
  await input.setInputFiles({...png,buffer:Buffer.from('not a png')}); await feedback(page,'文件格式不符');
  assert.equal(await page.getByRole('img',{name:'待识别的截图'}).getAttribute('src'),oldUrl);
  assert.equal(state.recognitions.length,0);
  state.recognize = () => ({json:{drafts:Array.from({length:8},(_,i)=>({...single,bounds:[0,i*125,1000,125]}))}});
  await recognize(page); await heading(page,'1 / 8');
  assert.equal(Buffer.from(state.recognitions[0].dataUrl.split(',')[1],'base64').length,exact.length);
  for (let i=0; i<8; i++) await action(page,'skip-import').click();
  await feedback(page,'已入库 0 道，跳过 8 道');
  assert.equal(state.posts.length+state.images.length,0);
});

test('配图与题目保存各自可重试，复用裁图和已上传编号并锁住保存操作', async t => {
  const {page,state} = await setup(t);
  const saveKeys = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/card-quiz\/(images|questions)$/.test(request.url()))
      saveKeys.push(request.postDataJSON().requestKey);
  });
  const source = await screenshot(page);
  await choose(page,source.file); await recognize(page); await heading(page,'1 / 3');
  await page.evaluate(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    window.encodings = 0;
    HTMLCanvasElement.prototype.toBlob = function(...args) { window.encodings++; return toBlob.apply(this,args); };
  });
  state.upload = () => ({status:503,json:{error:'配图上传失败'}});
  await save(page); await feedback(page,'配图上传失败');
  assert.equal(state.posts.length,0);
  state.upload = null;
  state.write = () => ({status:503,json:{error:'题目保存失败'}});
  await save(page); await feedback(page,'题目保存失败');
  assert.deepEqual(state.images,[state.images[0],state.images[0]]);
  await page.getByRole('textbox',{name:'题干',exact:true}).fill('重试时保留修订');
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  state.write = async () => { started.resolve(); await finish.promise; };
  await save(page); await started.promise;
  try {
    assert.ok(await action(page,'save-question').isDisabled()); assert.ok(await action(page,'skip-import').isDisabled());
    assert.ok(await page.locator('#cq-import-attach').isDisabled());
    assert.ok(await page.getByRole('textbox',{name:'题干',exact:true}).isDisabled());
  } finally { finish.resolve(); }
  await heading(page,'2 / 3');
  assert.equal(state.bank[0].text,'重试时保留修订'); assert.equal(state.bank[0].imageId,'image-2');
  assert.equal(state.images.length,2); assert.equal(state.recognitions.length,1);
  assert.equal(saveKeys.length,4); assert.ok(saveKeys[0]); assert.equal(new Set(saveKeys).size,1);
  assert.equal(await page.evaluate(() => window.encodings),1);
});

test('高细节 JPEG 裁图超过 PNG 上限时保留题框和原像素尺寸', async t => {
  const {page,state} = await setup(t);
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200; canvas.height = 1000;
    const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(canvas.width,canvas.height);
    let seed = 7;
    for (let i=0; i<pixels.data.length; i+=4) {
      seed = (Math.imul(seed,1664525) + 1013904223) >>> 0;
      pixels.data[i] = seed >>> 24;
      pixels.data[i+1] = seed >>> 16 & 255;
      pixels.data[i+2] = seed >>> 8 & 255;
      pixels.data[i+3] = 255;
    }
    ctx.putImageData(pixels,0,0);
    return canvas.toDataURL('image/jpeg',0.85);
  });
  const file = {name:'细节图.jpeg',mimeType:'image/jpeg',buffer:Buffer.from(dataUrl.split(',')[1],'base64')};
  state.recognize = () => ({json:{drafts:[{...single,bounds:[50,0,950,1000]}]}});
  await choose(page,file); await recognize(page); await heading(page,'1 / 1');
  await save(page); await feedback(page,'已入库 1 道');
  const [crop] = state.images;
  assert.match(crop,/^data:image\/webp;base64,/);
  assert.ok(Buffer.from(crop.split(',')[1],'base64').length <= 2*1024*1024);
  assert.deepEqual((await pixels(page,crop)).slice(0,2),[1140,1000]);
});

// Deliver late responses even after the UI cancels, as can happen with an already completed model job.
async function deliverAfterAbort(page) {
  await page.evaluate(() => {
    const api = window.ICeClass.api;
    window.recognitionCalls = [];
    window.ICeClass.api = async (path, options) => {
      if (!path.endsWith('/questions/recognize')) return api(path, options);
      const {signal, ...rest} = options, call = {signal, done:false};
      window.recognitionCalls.push(call);
      try { return await api(path, rest); } finally { call.done = true; }
    };
  });
}

test('识别中换图、换学科，迟到的成功和失败均不能替换当前审阅', async t => {
  const {page,state} = await setup(t);
  await deliverAfterAbort(page);
  const first = await screenshot(page), second = await screenshot(page,'image/jpeg');
  const oldFile = Promise.withResolvers(), oldSubject = Promise.withResolvers();
  state.recognize = body => {
    if (body.dataUrl === first.dataUrl) return oldFile.promise;
    if (body.subjectId === 'math') return oldSubject.promise;
    return {json:{drafts:[{...single,text:'当前截图的物理题'}]}};
  };
  await choose(page,first.file); await recognize(page);
  await page.waitForFunction(() => window.recognitionCalls.length === 1);
  assert.ok(await action(page,'recognize').isDisabled());
  assert.equal(await paste(page,second),true); await ready(page);
  await recognize(page);
  await page.waitForFunction(() => window.recognitionCalls.length === 2);
  await page.getByLabel('识别学科').selectOption('physics');
  await ready(page); await recognize(page); await heading(page,'1 / 1');
  oldSubject.resolve({status:503,json:{error:'旧学科错误'}});
  oldFile.resolve({json:{drafts:[{...single,text:'已替换的截图'}]}});
  await page.waitForFunction(() => window.recognitionCalls.every(c=>c.done));
  assert.deepEqual(await page.evaluate(() => window.recognitionCalls.map(c=>c.signal.aborted)), [true,true,false]);
  assert.equal(await page.getByRole('textbox',{name:'题干',exact:true}).inputValue(),'当前截图的物理题');
  assert.equal(await page.locator('#cq-question-form [name=subjectId]').inputValue(),'physics');
  assert.equal(await page.locator('.cq-feedback.cq-error').count(),0);
  assert.equal(new Set(state.recognitions.map(r=>r.requestKey)).size,3);
  assert.equal(state.images.length+state.posts.length,0);
});

test('换图期间较慢的图片解码不会恢复旧图', async t => {
  const {page,state} = await setup(t);
  const first = await screenshot(page), second = await screenshot(page,'image/jpeg');
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function() {
      HTMLImageElement.prototype.decode = decode;
      await decode.call(this);
      await new Promise(resolve => { window.finishOldDecode = resolve; });
    };
  });
  await page.locator('#cq-import-file').setInputFiles(first.file);
  await page.waitForFunction(() => !!window.finishOldDecode);
  assert.equal(await paste(page,second),true); await ready(page);
  await page.evaluate(() => window.finishOldDecode());
  await recognize(page); await heading(page,'1 / 3');
  assert.deepEqual(state.recognitions.map(r=>r.dataUrl),[second.dataUrl]);
});

test('离开、注销和页面隐藏释放截图，迟到的识别响应不能进入新页面', async t => {
  const {page,state} = await setup(t);
  const source = await screenshot(page);
  await deliverAfterAbort(page);
  for (const [index,leave] of ['tab','view','logout','pagehide'].entries()) {
    const late = Promise.withResolvers();
    state.recognize = () => late.promise;
    await choose(page,source.file); await recognize(page);
    await page.waitForFunction(n => window.recognitionCalls.length === n,index+1);
    if (leave === 'tab' || leave === 'view') {
      const destination = leave === 'tab' ? page.locator('[data-cq-tab=decks]') : page.locator('#mainNav [data-view=history]');
      await destination.click(); await page.locator('#workbenchConfirmCancel').click();
      assert.ok(await action(page,'recognize').isDisabled());
      await destination.click(); await page.locator('#workbenchConfirmAccept').click();
      if (leave === 'tab') await action(page,'new-deck').waitFor();
      else await page.locator('#view-history:not(.hidden)').waitFor();
    } else if (leave === 'logout') {
      await page.evaluate(async () => {
        window.dispatchEvent(new Event('iceclass-logout'));
        window.ICeClass.state.user = {...window.ICeClass.state.user,id:'another-teacher'};
        await window.ICeClassCardQuiz.load();
      });
    } else {
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    }
    late.resolve({json:{drafts:[single]}});
    await page.waitForFunction(n => window.recognitionCalls[n].done,index);
    assert.ok(await page.evaluate(n => window.recognitionCalls[n].signal.aborted,index));
    assert.equal(await page.locator('.cq-import, #cq-question-form').count(),0);
    if (leave === 'view') await navigate(page,'card-quiz');
    if (leave !== 'pagehide') {
      await page.locator('[data-cq-tab=bank]:enabled').click();
      await action(page,'open-import').click();
      assert.ok(await action(page,'recognize').isDisabled());
    }
  }
  assert.equal(state.images.length+state.posts.length,0);
});

test('保存截图配图时换账号，旧上传不能继续新建题目', async t => {
  const {page,state} = await setup(t);
  const uploading = Promise.withResolvers(), late = Promise.withResolvers();
  state.upload = () => { uploading.resolve(); return late.promise; };
  await choose(page,(await screenshot(page)).file); await recognize(page); await heading(page,'1 / 3');
  await save(page); await uploading.promise;
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('iceclass-logout'));
    window.ICeClass.state.user = {...window.ICeClass.state.user,id:'other-owner'};
    await window.ICeClassCardQuiz.load();
  });
  const delivered = page.waitForResponse(r=>r.url().endsWith('/api/card-quiz/images'));
  late.resolve({json:{id:'old-image'}});
  await (await delivered).finished();
  await page.locator('[data-cq-tab=bank]:enabled').click(); await action(page,'open-import').waitFor();
  assert.deepEqual(state.posts,[]); assert.equal(await action(page,'edit-question').count(),0);
});

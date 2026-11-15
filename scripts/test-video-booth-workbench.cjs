'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../plugins/VideoBooth/Site');
const shots = path.resolve(__dirname, '../output/playwright/video-booth-workbench');
let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); fs.mkdirSync(shots, { recursive: true }); });
after(async () => { await browser?.close(); });
function initialConfig() {
  return { room: 'synthetic-room', key: 'synthetic-key', signalUrl: 'ws://127.0.0.1/signal', iceServers: [], joinUrl: 'http://127.0.0.1/phone?room=synthetic-room&join=synthetic-join', qrUrl: '/api/qr', wifiQrUrl: '/api/wifi-qr', networkAvailable: true, localOnly: true, equipment: { certificateReady: false }, publicPhone: { enabled: false, generation: 'first', ready: false }, connection: { ready: true } };
}
async function environment(t, { width = 1200, height = 780, managed = true, forcedColors = 'none' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', forcedColors });
  t.after(() => context.close());
  let config = initialConfig(), configError = false, publicOffer = null, publicAnswer = null;
  const requests = [], sockets = new Map(), errors = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.hostname, '127.0.0.1', 'test must not contact external services');
    requests.push(url.pathname);
    if (url.pathname === '/api/desktop') return route.fulfill({ status: configError ? 503 : 200, json: configError ? { error: '连接配置暂不可用' } : config });
    if (url.pathname === '/api/phone') return route.fulfill({ json: config });
    if (url.pathname === '/api/public-phone/offer') { publicOffer = route.request().postDataJSON().offer; config.publicPhone.ready = true; return route.fulfill({ json: config }); }
    if (url.pathname === '/api/public-phone/answer') return publicAnswer ? route.fulfill({ json: publicAnswer }) : route.fulfill({ status: 204 });
    if (url.pathname === '/api/desktop-ice') return route.fulfill({ json: { iceServers: [] } });
    if (url.pathname === '/api/setup') return route.fulfill({ json: { phoneUrl: 'http://127.0.0.1/phone', certificateName: '视频展台' } });
    if (url.pathname === '/api/browser-ready') return route.fulfill({ json: { ready: false } });
    if (url.pathname === '/api/connect-info') return route.fulfill({ json: { ready: false, message: '合成测试：等待连接', phoneUrl: '/phone' } });
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname.endsWith('qr')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="152" height="152"><rect width="152" height="152" fill="white"/><text x="12" y="78">合成二维码</text></svg>' });
      return route.fulfill({ json: {} });
    }
    let filename = url.pathname === '/desktop' ? 'desktop.html' : url.pathname === '/phone' ? 'phone.html' : url.pathname.startsWith('/assets/') ? url.pathname.slice(8) : url.pathname.slice(1);
    const file = path.resolve(root, filename);
    assert.ok(file.startsWith(root + path.sep));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
    let body = fs.readFileSync(file);
    if (filename === 'preparation-phone.html') body = body.toString().replace('__RELAY_JSON__', '{}');
    return route.fulfill({ contentType: filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.png') ? 'image/png' : 'text/html', body });
  });
  await context.routeWebSocket('**/signal?**', socket => {
    const role = new URL(socket.url()).searchParams.get('role');
    sockets.set(role, socket);
    const other = () => sockets.get(role === 'viewer' ? 'sender' : 'viewer');
    socket.onMessage(message => {
      const payload = JSON.parse(message);
      if (payload.type === 'ping') return socket.send(JSON.stringify({ type: 'pong' }));
      other()?.send(message);
    });
    if (other()) { socket.send(JSON.stringify({ type: 'peer', present: true })); other().send(JSON.stringify({ type: 'peer', present: true })); }
    socket.onClose(() => { if (sockets.get(role) === socket) { sockets.delete(role); other()?.send(JSON.stringify({ type: 'peer', present: false })); } });
  });
  await context.addInitScript(() => {
    window.__messages = []; window.__captures = []; window.__cameraCalls = 0; window.__synthRunning = true; window.__cameraError = null; window.__delayCamera = false;
    window.chrome ||= {};
    window.chrome.webview = { postMessage(message) { window.__messages.push(message); } };
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => [{ kind: 'videoinput', deviceId: 'synthetic-camera', label: '合成摄像头' }] });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      ++window.__cameraCalls;
      if (window.__cameraError) throw new DOMException('合成摄像头错误', window.__cameraError);
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d'); let counter = 0;
      const draw = () => { if (!window.__synthRunning) return; ctx.fillStyle = '#fffefa'; ctx.fillRect(0, 0, 640, 480); ctx.fillStyle = '#be2736'; ctx.fillRect(0, 0, 200, 130); ctx.fillStyle = '#194f91'; ctx.font = '30px sans-serif'; ctx.fillText('合成视频 · 非真实学生作答', 40, 200); ctx.fillText('x² - 5x + 6 = 0', 90, 285); ctx.fillText('x = 2 或 x = 3', 90, 345); ctx.fillText(String(counter++), 520, 440); };
      draw(); const timer = setInterval(draw, 40), stream = canvas.captureStream(24);
      const track = stream.getVideoTracks()[0], stop = track.stop.bind(track);
      Object.defineProperty(track, 'label', { value: '合成摄像头' });
      track.stop = () => { clearInterval(timer); stop(); };
      window.__captures.push(stream);
      if (window.__delayCamera) await new Promise(resolve => { window.__resolveCamera = resolve; });
      return stream;
    } });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'uncaught browser errors'));
  await page.goto(`http://127.0.0.1/desktop?key=test${managed ? '&managed=1' : ''}`);
  await page.waitForFunction(() => window.booth?.ready, null, { timeout: 5000 }).catch(async error => { throw new Error(`Page readiness: ${errors.join('; ')}; ${await page.locator('#status').textContent()}; ${error.message}`); });
  return { context, page, requests, sockets, setConfig(value) { config = value; }, getConfig() { return config; }, failConfig(value) { configError = value; }, getOffer() { return publicOffer; }, setAnswer(value) { publicAnswer = value; } };
}
async function start(page) { await page.locator('#startCamera').click(); await page.waitForFunction(() => !document.getElementById('requestReview').disabled); }
async function request(page) {
  await page.locator('#requestReview').click();
  return page.evaluate(() => window.__messages.findLast(message => message.type === 'review_requested').payload.generation);
}
async function freeze(page, generation) { return page.evaluate(generation => window.booth.freezeFrame({ generation }), generation); }
async function rejectOld(page, generation) {
  assert.deepEqual(await page.evaluate(generation => ['freezeFrame', 'resumeReview', 'setReviewState'].map(name => {
    try { window.booth[name]({ generation, state: 'complete', verdict: 'correct', strength: '旧结论', knowledgePoints: ['因式分解'] }); return false; }
    catch (error) { return /失效/.test(error.message); }
  }), generation), [true, true, true]);
}
test('opt-in capture, synchronous bridge, frozen image, manual continuation and stale generations', async t => {
  const { page, requests } = await environment(t);
  assert.equal(await page.evaluate(() => window.__cameraCalls), 0);
  assert.equal(requests.filter(url => url.includes('preparation')).length, 0);
  assert.equal(await page.locator('video').count(), 1);
  await start(page); const generation = await request(page), frame = await freeze(page, generation);
  assert.equal(frame.width, 640); assert.equal(frame.height, 480); assert.equal(frame.generation, generation);
  assert.ok(Number.isSafeInteger(frame.capturedAt)); assert.ok(Buffer.from(frame.dataUrl.split(',')[1], 'base64').length <= 2 * 1024 * 1024);
  assert.equal(await page.locator('#frozenFrame').getAttribute('src'), frame.dataUrl);
  await page.evaluate(generation => window.booth.setReviewState({ generation, state: 'complete', verdict: 'correct', strength: '因式分解正确。', nextStep: '继续保持清晰的步骤。', knowledgePoints: ['因式分解'] }), generation);
  assert.equal(await page.locator('#reviewTitle').textContent(), '作答正确');
  assert.equal(await page.locator('#frozenFrame').getAttribute('src'), frame.dataUrl);
  assert.equal(await page.locator('#resumeReview').isVisible(), true);
  await page.locator('#resumeReview').click(); await rejectOld(page, generation);
  assert.equal(await page.locator('#reviewPanel').isVisible(), false);
  await page.evaluate(() => window.booth.stop());
  assert.equal(await page.evaluate(() => window.__captures[0].getVideoTracks()[0].readyState), 'ended');
});
test('pause and review use identical transformed pixels, no transformed frozen image twice', async t => {
  const { page } = await environment(t); await start(page);
  await page.locator('#moreButton').click(); await page.locator('#rotateVideo').click();
  await page.locator('#moreButton').click(); await page.locator('#mirrorVideo').click();
  await page.locator('#pauseVideo').click(); const paused = await page.locator('#frozenFrame').getAttribute('src');
  const generation = await request(page), frame = await freeze(page, generation);
  assert.equal(frame.dataUrl, paused); assert.equal(frame.width, 480); assert.equal(frame.height, 640); assert.equal(frame.rotation, 90); assert.equal(frame.mirrored, true);
  assert.equal(await page.locator('#frozenFrame').evaluate(node => getComputedStyle(node).transform), 'none');
  await page.locator('#moreButton').click(); await page.locator('#rotateVideo').click(); await rejectOld(page, generation);
});
test('two seconds without decoded frames invalidates once and rejects old completion', async t => {
  const { page } = await environment(t); await start(page); const generation = await request(page); await freeze(page, generation);
  await page.evaluate(() => { window.__synthRunning = false; });
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('画面已中断'));
  const count = await page.evaluate(() => window.__messages.filter(message => message.type === 'review_invalidated').length);
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => window.__messages.filter(message => message.type === 'review_invalidated').length), count);
  await rejectOld(page, generation);
  await page.evaluate(() => { window.__synthRunning = true; });
  await page.waitForFunction(() => !document.getElementById('requestReview').disabled);
  assert.equal(await page.locator('#reviewPanel').isVisible(), false);
});
test('permissions, no devices, track end and canceled pending camera remain recoverable', async t => {
  const { page } = await environment(t);
  for (const [name, text] of [['NotAllowedError', '权限未获允许'], ['NotFoundError', '没有找到摄像头']]) {
    await page.evaluate(name => { window.__cameraError = name; }, name);
    await page.locator('#startCamera').click(); await page.waitForFunction(text => document.getElementById('status').textContent.includes(text), text);
    assert.equal(await page.locator('#startCamera').isEnabled(), true);
  }
  await page.evaluate(() => { window.__cameraError = null; window.__delayCamera = true; });
  await page.locator('#startCamera').click(); await page.waitForFunction(() => !!window.__resolveCamera);
  await page.evaluate(() => { window.booth.stop(); window.__resolveCamera(); });
  await page.waitForFunction(() => window.__captures.at(-1).getVideoTracks()[0].readyState === 'ended');
  await page.evaluate(() => { window.__delayCamera = false; }); await start(page);
  const generation = await request(page); await freeze(page, generation);
  await page.evaluate(() => window.__captures.at(-1).getVideoTracks()[0].dispatchEvent(new Event('ended')));
  await rejectOld(page, generation); assert.match(await page.locator('#status').textContent(), /已断开/);
});
test('phone selection releases local camera, preparation and polling replace QR without fake success', async t => {
  const env = await environment(t), { page } = env; await start(page);
  const generation = await request(page); await freeze(page, generation);
  await page.locator('#sourceButton').click(); await page.locator('#phoneSource').click();
  assert.equal(await page.evaluate(() => window.__captures[0].getVideoTracks()[0].readyState), 'ended'); await rejectOld(page, generation);
  await page.locator('#preparePhone').click(); assert.equal(await page.locator('#preparePhone').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__messages.filter(message => message.type === 'prepare_phone').length), 1);
  await page.evaluate(() => window.booth.setNativeStatus('手机连接准备失败：合成网络错误'));
  assert.equal(await page.locator('#preparePhone').isEnabled(), true); assert.match(await page.locator('#status').textContent(), /准备失败/);
  assert.equal(await page.locator('#cameraFigure').isVisible(), false);
  env.setConfig({ ...env.getConfig(), equipment: { certificateReady: true }, joinUrl: 'http://127.0.0.1/phone?room=second', room: 'second' });
  await page.evaluate(() => window.booth.setNativeStatus('手机连接已准备，请扫码。'));
  await page.waitForFunction(() => document.getElementById('phoneQr').src.includes('second'));
  env.failConfig(true); await page.waitForFunction(() => document.getElementById('phoneStatus').textContent.includes('未能更新'));
  assert.equal(await page.locator('#cameraFigure').isVisible(), false);
});
test('actual WebRTC phone stream, front/back switch invalidation and phone manual start', async t => {
  const env = await environment(t), { page, context } = env;
  env.setConfig({ ...env.getConfig(), equipment: { certificateReady: true } });
  await page.locator('#choosePhone').click();
  await page.evaluate(() => window.booth.setNativeStatus('手机连接已准备，请扫码。'));
  await page.waitForTimeout(100);
  // An explicit preparation arms a first-time connection even when configuration arrived later.
  if (await page.locator('#preparePhone').isEnabled()) { await page.locator('#preparePhone').click(); await page.evaluate(() => window.booth.setNativeStatus('手机连接已准备，请扫码。')); }
  const phone = await context.newPage(); await phone.goto('http://127.0.0.1/phone?room=synthetic-room&join=synthetic-join');
  await phone.waitForFunction(() => window.phoneBooth?.diagnostics().ready);
  assert.equal(await phone.evaluate(() => window.__cameraCalls), 0);
  await phone.locator('#startPhone').click();
  await page.waitForFunction(() => !document.getElementById('requestReview').disabled);
  const generation = await request(page); await freeze(page, generation);
  await phone.locator('#frontCamera').click(); await page.waitForFunction(() => document.getElementById('reviewPanel').hidden);
  await rejectOld(page, generation);
  await page.waitForFunction(() => !document.getElementById('requestReview').disabled);
  await page.locator('#stopVideo').click(); await phone.waitForFunction(() => !window.phoneBooth.diagnostics().live);
});
test('independent preview explains managed AI rather than fabricating results', async t => {
  const { page } = await environment(t, { managed: false }); await start(page); await page.locator('#requestReview').click();
  assert.match(await page.locator('#status').textContent(), /创意工坊/); assert.equal(await page.locator('#reviewPanel').isVisible(), false);
  assert.equal(await page.evaluate(() => window.__messages.some(message => message.type === 'review_requested')), false);
});
test('public receiver keeps same stream across replaceTrack and invalidates frozen review', async t => {
  const env = await environment(t), { page } = env;
  env.setConfig({ ...env.getConfig(), publicPhone: { enabled: true, generation: 'public-first', ready: false } });
  await page.locator('#choosePhone').click(); await page.locator('#preparePhone').click();
  await page.evaluate(() => window.booth.setNativeStatus('手机连接已准备，请扫码。'));
  for (let attempt = 0; !env.getOffer() && attempt < 100; attempt++) await page.waitForTimeout(50);
  assert.ok(env.getOffer(), 'public receiver created an actual WebRTC offer');
  const answer = await page.evaluate(async offer => {
    const peer = window.__publicSender = new RTCPeerConnection({ iceServers: [] });
    peer.ondatachannel = event => { window.__publicControl = event.channel; event.channel.onopen = () => event.channel.send(JSON.stringify({ type: 'state', payload: { streaming: true } })); };
    await peer.setRemoteDescription(offer);
    const media = await navigator.mediaDevices.getUserMedia({ video: true });
    window.__publicVideoSender = peer.addTrack(media.getVideoTracks()[0], media);
    await peer.setLocalDescription(await peer.createAnswer());
    if (peer.iceGatheringState !== 'complete') await new Promise(resolve => peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') resolve(); }));
    return peer.localDescription.toJSON();
  }, env.getOffer());
  env.setAnswer(answer);
  await page.waitForFunction(() => !document.getElementById('requestReview').disabled);
  const streamId = await page.locator('#video').evaluate(video => video.srcObject.id);
  const generation = await request(page); await freeze(page, generation);
  await page.evaluate(async () => {
    window.__publicControl.send(JSON.stringify({ type: 'state', payload: { streaming: false, message: '正在切换手机摄像头…' } }));
    const next = await navigator.mediaDevices.getUserMedia({ video: true });
    await window.__publicVideoSender.replaceTrack(next.getVideoTracks()[0]);
    window.__publicControl.send(JSON.stringify({ type: 'state', payload: { streaming: true } }));
  });
  await page.waitForFunction(() => document.getElementById('reviewPanel').hidden);
  await rejectOld(page, generation);
  await page.waitForFunction(() => !document.getElementById('requestReview').disabled);
  assert.equal(await page.locator('#video').evaluate(video => video.srcObject.id), streamId);
  await page.evaluate(() => { window.__publicSender.close(); window.__captures.forEach(stream => stream.getTracks().forEach(track => track.stop())); });
});
async function openPortalForStartup(t) {
  const { page } = await environment(t, { width: 390, height: 844 });
  const offer = await page.evaluate(async () => {
    const { gatherIce } = await import('/assets/public-peer.js');
    const receiver = new RTCPeerConnection({ iceServers: [] });
    receiver.addTransceiver('video', { direction: 'recvonly' });
    await receiver.setLocalDescription(await receiver.createOffer()); await gatherIce(receiver);
    const offer = receiver.localDescription.toJSON(); receiver.close(); return offer;
  });
  const pair = require('node:zlib').gzipSync(JSON.stringify({ v: 1, nonce: 'a'.repeat(48), key: Buffer.alloc(32, 1).toString('base64url'), endpoint: 'http://192.168.1.2/pair-phone', offer })).toString('base64url');
  await page.goto('http://127.0.0.1/portal.html#pair=' + pair);
  await page.waitForFunction(() => window.phoneBooth && !window.phoneBooth.diagnostics().fatal);
  assert.equal(await page.evaluate(() => window.__cameraCalls), 0);
  return page;
}
test('public portal startup can stop during delayed getUserMedia and releases late stream', async t => {
  const page = await openPortalForStartup(t);
  await page.evaluate(() => { window.__delayCamera = true; });
  await page.locator('#startPhone').click(); await page.waitForFunction(() => !!window.__resolveCamera);
  assert.equal(await page.locator('#startPhone').isVisible(), false);
  assert.equal(await page.locator('#stopPhone').isEnabled(), true);
  await page.locator('#stopPhone').click();
  assert.equal(await page.evaluate(() => window.phoneBooth.diagnostics().wanted), false);
  await page.evaluate(() => window.__resolveCamera());
  await page.waitForFunction(() => !window.phoneBooth.diagnostics().busy);
  assert.equal(await page.evaluate(() => window.__captures[0].getVideoTracks()[0].readyState), 'ended');
  assert.equal(await page.evaluate(() => window.phoneBooth.diagnostics().live), false);
  assert.equal(await page.locator('#stopPhone').isDisabled(), true);
  assert.equal(await page.locator('#startPhone').isEnabled(), true);
  assert.match(await page.locator('#phoneStatus').textContent(), /已停止展示/);
});
test('public portal startup can stop during delayed transport preparation without late success', async t => {
  const page = await openPortalForStartup(t);
  await page.evaluate(() => {
    const original = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = async function(description) {
      RTCPeerConnection.prototype.setRemoteDescription = original;
      await new Promise(resolve => { window.__resolveTransport = resolve; });
      return original.call(this, description);
    };
  });
  await page.locator('#startPhone').click();
  await page.waitForFunction(() => !!window.__resolveTransport && window.phoneBooth.diagnostics().live);
  assert.equal(await page.locator('#startPhone').isVisible(), false);
  assert.equal(await page.locator('#stopPhone').isEnabled(), true);
  assert.equal(await page.evaluate(() => window.__captures[0].getVideoTracks()[0].readyState), 'live');
  await page.locator('#stopPhone').click();
  assert.equal(await page.evaluate(() => window.__captures[0].getVideoTracks()[0].readyState), 'ended');
  assert.equal(await page.evaluate(() => window.phoneBooth.diagnostics().live), false);
  await page.evaluate(() => window.__resolveTransport());
  await page.waitForFunction(() => !window.phoneBooth.diagnostics().busy);
  assert.equal(await page.evaluate(() => window.phoneBooth.diagnostics().wanted), false);
  assert.equal(await page.locator('#connectComputer').isDisabled(), true);
  assert.equal(await page.locator('#startPhone').isEnabled(), true);
  assert.match(await page.locator('#phoneStatus').textContent(), /已停止展示/);
  await page.locator('#startPhone').click();
  await page.waitForFunction(() => !document.getElementById('connectComputer').disabled);
  assert.equal(await page.evaluate(() => window.__cameraCalls), 2);
  assert.equal(await page.evaluate(() => window.phoneBooth.diagnostics().live), true);
  await page.locator('#stopPhone').click();
  assert.equal(await page.evaluate(() => window.__captures.every(stream => stream.getVideoTracks()[0].readyState === 'ended')), true);
});
async function portalWithFailureEvents(t, { delayWake = false, delayTransport = false } = {}) {
  const page = await openPortalForStartup(t);
  await page.evaluate(({ delayWake, delayTransport }) => {
    window.__wakeRequests = 0; window.__wakeReleases = 0; window.__trackStops = 0;
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { async request() {
      ++window.__wakeRequests;
      if (delayWake) await new Promise(resolve => { window.__resolveWake = resolve; });
      const lock = new EventTarget();
      lock.release = async () => { ++window.__wakeReleases; lock.dispatchEvent(new Event('release')); };
      return lock;
    } } });
    const NativePeer = RTCPeerConnection;
    window.RTCPeerConnection = function(config) {
      const peer = new NativePeer(config); window.__portalPeer = peer;
      if (delayTransport) {
        const original = peer.setRemoteDescription.bind(peer);
        peer.setRemoteDescription = async description => {
          await new Promise(resolve => { window.__resolveTransport = resolve; });
          return original(description);
        };
      }
      return peer;
    };
    window.__installControl = () => {
      // Real WebRTC prepares the offer/answer; terminal transport events and this
      // data-channel boundary are synthetic, without a real phone/network failure.
      const channel = { readyState: 'open', send() {}, close() { this.readyState = 'closed'; ++this.closeCalls; this.onclose?.(); }, closeCalls: 0 };
      window.__portalPeer.ondatachannel({ channel }); window.__portalControl = channel;
      channel.onopen?.();
      window.__lateControlOpen = channel.onopen; window.__lateControlMessage = channel.onmessage;
      window.__lateControlClose = channel.onclose; window.__lateControlError = channel.onerror;
    };
    window.__failPeer = state => {
      Object.defineProperty(window.__portalPeer, 'connectionState', { configurable: true, value: state });
      window.__portalPeer.dispatchEvent(new Event('connectionstatechange'));
    };
  }, { delayWake, delayTransport });
  await page.locator('#startPhone').click();
  await page.waitForFunction(() => window.__portalPeer && window.phoneBooth.diagnostics().live);
  await page.evaluate(() => {
    const track = window.__captures[0].getVideoTracks()[0], stop = track.stop.bind(track);
    track.stop = () => { ++window.__trackStops; stop(); };
  });
  if (delayTransport) await page.waitForFunction(() => !!window.__resolveTransport);
  else if (delayWake) await page.waitForFunction(() => !!window.__resolveWake);
  else await page.waitForFunction(() => !window.phoneBooth.diagnostics().busy);
  return page;
}
async function assertPortalTerminated(page) {
  assert.deepEqual(await page.evaluate(() => {
    const state = window.phoneBooth.diagnostics();
    return { live: state.live, wanted: state.wanted, paired: state.viewer, allowed: state.ready, fatal: state.fatal };
  }), { live: false, wanted: false, paired: false, allowed: false, fatal: true });
  assert.equal(await page.evaluate(() => window.__captures.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
  assert.equal(await page.locator('#phoneVideo').evaluate(video => video.srcObject), null);
  assert.equal(await page.locator('#connectComputer').isDisabled(), true);
  assert.equal(await page.locator('#stopPhone').isDisabled(), true);
  assert.equal(await page.locator('#startPhone').isVisible(), false);
  assert.equal(await page.locator('#phoneStatus').textContent(), '请在电脑上点“停止”，再点“连接手机”并重新扫码。');
  assert.doesNotMatch(await page.locator('#phoneStatus').textContent(), /更换配对/);
}
for (const state of ['failed', 'disconnected', 'closed']) {
  test(`public portal terminal peer ${state} releases capture and wake lock idempotently`, async t => {
    const page = await portalWithFailureEvents(t);
    await page.evaluate(() => { window.__installControl(); window.__latePeerState = window.__portalPeer.onconnectionstatechange; window.__failPeer('connected'); });
    assert.equal(await page.evaluate(() => window.phoneBooth.diagnostics().viewer), true);
    await page.evaluate(state => window.__failPeer(state), state);
    await assertPortalTerminated(page);
    await page.evaluate(async () => {
      window.__latePeerState(); window.__lateControlClose?.(); window.__lateControlError?.(); window.__lateControlOpen();
      await window.__lateControlMessage({ data: JSON.stringify({ type: 'ready' }) });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await assertPortalTerminated(page);
    assert.deepEqual(await page.evaluate(() => [window.__trackStops, window.__wakeReleases, window.__cameraCalls, window.__portalControl.closeCalls, window.__portalPeer.signalingState]), [1, 1, 1, 1, 'closed']);
  });
}
for (const event of ['close', 'error']) {
  test(`public portal terminal control ${event} releases capture without pause delivery`, async t => {
    const page = await portalWithFailureEvents(t);
    await page.evaluate(event => { window.__installControl(); window.__portalControl['on' + event]?.(); }, event);
    await assertPortalTerminated(page);
    assert.deepEqual(await page.evaluate(() => [window.__trackStops, window.__wakeReleases, window.__portalPeer.signalingState]), [1, 1, 'closed']);
  });
}
test('public portal terminal failure releases late wake lock and ignores late completion', async t => {
  const page = await portalWithFailureEvents(t, { delayWake: true });
  await page.evaluate(() => window.__failPeer('failed'));
  await assertPortalTerminated(page);
  await page.evaluate(() => window.__resolveWake());
  await page.waitForFunction(() => !window.phoneBooth.diagnostics().busy);
  await assertPortalTerminated(page);
  assert.deepEqual(await page.evaluate(() => [window.__trackStops, window.__wakeReleases, window.__cameraCalls]), [1, 1, 1]);
});
test('public portal terminal control loss rejects late getUserMedia and stale ready callbacks', async t => {
  const page = await portalWithFailureEvents(t);
  await page.evaluate(() => window.__installControl());
  await page.locator('#stopPhone').click();
  await page.evaluate(() => { window.__delayCamera = true; });
  await page.locator('#startPhone').click(); await page.waitForFunction(() => !!window.__resolveCamera);
  await page.evaluate(() => window.__lateControlError?.());
  // The pending permission result is not owned by the page until it resolves.
  assert.equal(await page.evaluate(() => window.phoneBooth.diagnostics().wanted), false);
  await page.evaluate(async () => { window.__resolveCamera(); window.__lateControlOpen(); await window.__lateControlMessage({ data: JSON.stringify({ type: 'ready' }) }); });
  await page.waitForFunction(() => !window.phoneBooth.diagnostics().busy);
  await assertPortalTerminated(page);
  assert.equal(await page.evaluate(() => window.__cameraCalls), 2);
});
test('public portal terminal failure during transport preparation rejects late answer', async t => {
  const page = await portalWithFailureEvents(t, { delayTransport: true });
  await page.evaluate(() => window.__failPeer('failed'));
  await assertPortalTerminated(page);
  await page.evaluate(() => window.__resolveTransport());
  await page.waitForFunction(() => !window.phoneBooth.diagnostics().busy);
  await assertPortalTerminated(page);
  assert.equal(await page.evaluate(() => window.__cameraCalls), 1);
});
test('review question label names the existing read-only question action', async t => {
  const { page } = await environment(t); await start(page);
  const generation = await request(page); await freeze(page, generation);
  await page.evaluate(generation => window.booth.setReviewState({ generation, state: 'complete', verdict: 'correct', strength: '正确', knowledgePoints: ['因式分解'] }), generation);
  assert.equal(await page.locator('#reviewQuestion').textContent(), '本次题目');
  await page.locator('#reviewQuestion').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.__messages.filter(message => message.type === 'question_requested').length), 1);
  assert.equal(await page.evaluate(() => window.__messages.filter(message => message.type === 'review_requested').length), 1);
});

test('capture algorithm rejects stale frames and PNG over 2 MiB; longest edge is 1920', async t => {
  const { page } = await environment(t); await start(page);
  const results = await page.evaluate(async () => {
    const { captureFrame } = await import('/assets/managed-review.js'); const now = performance.now(), source = document.getElementById('video');
    let stale = '', large = '';
    try { captureFrame(source, { lastFrameAt: now - 2001, now }); } catch (error) { stale = error.message; }
    const fake = () => ({ width: 0, height: 0, getContext: () => ({ translate() {}, rotate() {}, scale() {}, drawImage() {} }), toDataURL: () => 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024) });
    try { captureFrame(source, { lastFrameAt: now, now, createCanvas: fake }); } catch (error) { large = error.message; }
    const minimal = () => ({ ...fake(), toDataURL: () => 'data:image/png;base64,AA==' });
    const scaled = captureFrame({ videoWidth: 4000, videoHeight: 3000 }, { lastFrameAt: now, now, createCanvas: minimal });
    return { stale, large, width: scaled.width, height: scaled.height };
  });
  assert.match(results.stale, /新鲜画面/); assert.match(results.large, /2 MiB/); assert.equal(results.width, 1920); assert.equal(results.height, 1440);
});
for (const [width, height, floating] of [[1200,780,false],[900,620,false],[580,440,true],[360,280,true]]) test(`layout, keyboard and visible actions ${width}x${height}`, async t => {
  const { page } = await environment(t, { width, height }); if (floating) await page.evaluate(() => window.booth.setFloating(true));
  const visible = async id => page.locator('#' + id).evaluate(node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height >= 32 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; });
  assert.ok(await visible(floating ? 'restoreWindow' : 'floatWindow'));
  if (process.env.BOOTH_SCREENSHOTS === '1' && width === 1200) await page.screenshot({ path: path.join(shots, 'workbench-empty-1200.png') });
  await start(page); assert.ok(await visible('requestReview')); assert.ok(await visible('stopVideo'));
  const generation = await request(page); await freeze(page, generation);
  assert.ok(await visible('resumeReview')); assert.ok(await visible('stopVideo'));
  if (process.env.BOOTH_SCREENSHOTS === '1' && width === 360) await page.screenshot({ path: path.join(shots, 'workbench-review-360.png') });
  await page.locator('#resumeReview').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#reviewPanel').isVisible(), false);
  await page.locator('#moreButton').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#moreButton').evaluate(node => node === document.activeElement), true);
  const ring = await page.locator('#moreButton').evaluate(node => getComputedStyle(node).outlineWidth); assert.notEqual(ring, '0px');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight));
  if (process.env.BOOTH_SCREENSHOTS === '1') await page.screenshot({ path: path.join(shots, `workbench-${width}x${height}.png`) });
});
test('high contrast, untrusted review text and error are readable', async t => {
  const { page } = await environment(t, { forcedColors: 'active' }); await start(page); const generation = await request(page); await freeze(page, generation);
  await page.evaluate(generation => window.booth.setReviewState({ generation, state: 'error', message: '<img src=x onerror=alert(1)> 无法看清作答，请调整镜头。' }), generation);
  assert.equal(await page.locator('#reviewMessage img').count(), 0); assert.match(await page.locator('#reviewMessage').textContent(), /无法看清/);
  assert.equal(await page.locator('#reviewTitle').textContent(), ''); assert.equal(await page.locator('#resumeReview').isEnabled(), true);
});
test('phone entry pages and module graph load locally with new brand and no camera on open', async t => {
  const { context } = await environment(t, { width: 390, height: 844 });
  for (const route of ['phone', 'portal.html', 'setup.html', 'connect.html', 'preparation-phone.html', 'phone-preparation-return.html']) {
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1/' + route); await page.waitForTimeout(200);
    assert.match(await page.title(), /视频展台/); assert.doesNotMatch(await page.locator('body').textContent(), /善忠/);
    assert.equal(await page.evaluate(() => window.__cameraCalls), 0); assert.deepEqual(errors, [], route);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), route);
    if (process.env.BOOTH_SCREENSHOTS === '1' && route === 'phone') await page.screenshot({ path: path.join(shots, 'phone-390.png') });
    await page.close();
  }
  for (const file of fs.readdirSync(root).filter(file => file.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](?:\.\/|\/assets\/)([^'"]+)['"]/g)) assert.ok(fs.existsSync(path.join(root, match[1])), `${file}: ${match[1]}`);
  }
});

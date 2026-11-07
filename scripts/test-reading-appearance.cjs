'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', 'web_controller');
const origin = 'http://127.0.0.1';
let browser;
before(async () => {
  const edge = process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  browser = await chromium.launch(edge && fs.existsSync(edge)
    ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
});
after(async () => { await browser?.close(); });

async function open(t, { delayGameGlass = false, width = 1440, offline = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  let releaseGlass;
  const glassReady = new Promise(resolve => { releaseGlass = resolve; });
  if (!delayGameGlass) releaseGlass();
  t.after(async () => { releaseGlass(); await context.close(); });
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'No activity script errors'));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin, 'Activities use only bundled assets in this test');
    if (url.pathname === '/api/session') return route.fulfill({ json: { authenticated: true, user: { role: 'teacher' } } });
    assert.ok(!url.pathname.startsWith('/api/'), 'Preview must never write reading records');
    if (url.pathname === '/assets/classroom-glass.js' && request.frame().parentFrame()) await glassReady;
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname) + (url.pathname.endsWith('/') ? 'index.html' : ''));
    assert.ok(file.startsWith(root + path.sep), 'Only production static assets are served');
    return route.fulfill({ path: file });
  });
  await context.addInitScript(({ offline }) => {
    if (offline && window === window.top) {
      // Isolated in-memory native bridge: never touches bindings, records or the network.
      const replies = [];
      window.ICeClassDesktop = { offline: true, fullscreen: false, send() {} };
      window.chrome ||= {};
      window.chrome.webview = {
        addEventListener(type, listener) { if (type === 'message') replies.push(listener); },
        postMessage(message) {
          if (message.type !== 'reading-local') return;
          queueMicrotask(() => replies.forEach(listener => listener({ data: {
            type: 'reading-local-reply', requestId: message.requestId,
            data: { className: '测试班级', hasRules: true, online: true, pendingCount: 0 }
          } })));
        }
      };
    }
    // Synthetic local audio exercises the real capture and activity loops without a microphone.
    window.__testVolume = 0;
    window.__testStreams = [];
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {} });
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator(), gain = context.createGain();
      gain.gain.value = 0;
      oscillator.connect(gain); gain.connect(destination); oscillator.start();
      window.__testStreams.push(destination.stream);
      return destination.stream;
    };
    AnalyserNode.prototype.getByteFrequencyData = function (values) {
      values.fill(Math.round(window.__testVolume * .8));
    };
    AnalyserNode.prototype.getFloatTimeDomainData = function (values) {
      for (let i = 0; i < values.length; ++i) values[i] = Math.sin(i / 8) * window.__testVolume / 200;
    };
    // Fullscreen itself belongs to the native host, not this headless appearance check.
    Element.prototype.requestFullscreen = async () => {};
  }, { offline });
  await page.goto(origin + '/reading/?preview=1');
  await page.locator('body:not(.reading-loading)').waitFor();
  return { page, releaseGlass };
}

async function startMode(page, mode) {
  await page.locator('#open-' + mode).click();
  if (['classic', 'rocket'].includes(mode)) {
    await page.frameLocator('#classic-frame-holder iframe').locator('#big-start-btn').click();
  } else await page.locator('#start-' + mode).click();
  await page.waitForFunction(() => ReadingMonitor.getState().active);
}

for (const mode of ['classic', 'carving', 'particle', 'rocket']) {
  test(`${mode}: transparent edge triggers collapse when controls are shown and remain usable`, async t => {
    const { page } = await open(t);
    await startMode(page, mode);
    // Exercise fullscreen layout and its notification without using a desktop window.
    await page.evaluate(() => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.documentElement });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    await page.mouse.move(950, 600);
    await page.waitForFunction(() => document.getElementById('classic-view').dataset.toolbarVisible === 'false');
    const top = page.locator('#classic-reveal');
    assert.equal(await top.evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'Top trigger must not paint over the activity');
    await page.mouse.move(800, 2);
    await page.waitForFunction(() => document.getElementById('classic-view').dataset.toolbarVisible === 'true');
    assert.equal((await top.boundingBox()).height, 0, 'Shown toolbar has no overlay above its text');
    assert.equal(await page.locator('.classic-toolbar .brand strong').evaluate(element => getComputedStyle(element).color), 'rgb(25, 60, 89)', 'Activity title keeps the shared readable ink color');

    const embedded = ['classic', 'rocket'].includes(mode);
    const scope = embedded ? page.frameLocator('#classic-frame-holder iframe') : page;
    await scope.getByRole('button', { name: '隐藏操作面板', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('classic-view').dataset.panelVisible === 'false');
    const edge = scope.locator(embedded ? '#reading-panel-reveal' : '#' + mode + '-reveal');
    assert.equal(await edge.evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'Side trigger must not leave a painted strip');
    assert.ok((await edge.boundingBox()).width >= 24, 'The touch target stays available');
    await edge.dispatchEvent('pointerdown', { pointerType: 'touch' });
    await page.waitForFunction(() => document.getElementById('classic-view').dataset.panelVisible === 'true');
    await scope.getByRole('button', { name: '暂停', exact: true }).waitFor();
  });
}

test('carving: pinned meter continues following input after the top toolbar hides', async t => {
  const { page } = await open(t);
  await startMode(page, 'carving');
  await page.waitForFunction(() => document.getElementById('classic-view').dataset.toolbarVisible === 'false');
  assert.equal(await page.locator('#classic-view').getAttribute('data-panel-visible'), 'true');
  await page.evaluate(() => { __testVolume = 65; });
  await page.waitForFunction(() => Number(document.querySelector('#reading-speed-editor [data-carving-volume-value]').textContent) >= 60, undefined, { timeout: 2000 });
  await page.evaluate(() => { __testVolume = 10; });
  await page.waitForFunction(() => Number(document.querySelector('#reading-speed-editor [data-carving-volume-value]').textContent) <= 15, undefined, { timeout: 2000 });
});

test('glass resources follow hidden pages and are restored on reopening', async t => {
  const { page } = await open(t);
  const retained = () => page.evaluate(() => [...document.querySelectorAll('.lg-pane')].filter(element => {
    const box = element.getBoundingClientRect();
    return (!box.width || !box.height) && element.querySelector(':scope > .lg-lens')?.style.backdropFilter.includes('url(');
  }).length);
  for (let round = 0; round < 2; ++round) {
    await startMode(page, 'carving');
    await page.waitForFunction(() => document.querySelector('.carving-sidebar > .lg-lens')?.style.backdropFilter.includes('url('));
    await page.mouse.move(800, 2);
    await page.locator('#choose-mode').click();
    await page.locator('#home-view').waitFor();
    await page.waitForTimeout(150);
    assert.equal(await retained(), 0, 'Hidden page surfaces release their optical textures and filters');
  }
});

for (const offline of [false, true]) {
  test(`${offline ? 'native offline' : 'web preview'}: unchanged statistics do not rewrite the DOM`, async t => {
    const { page } = await open(t, { offline });
    await page.waitForTimeout(300);
    const count = await page.evaluate(async () => {
      let count = 0;
      const observer = new MutationObserver(changes => { count += changes.length; });
      observer.observe(document.getElementById('reading-session-status'), { childList: true, subtree: true });
      await new Promise(resolve => setTimeout(resolve, 1400));
      observer.disconnect();
      return count;
    });
    assert.equal(count, 0, 'Unchanged status and timer should not cause layout or wake DOM observers');
    if (offline) {
      await page.evaluate(() => {
        ReadingIntegration.settings.enabled = true;
        ReadingIntegration.settings.periods = [{ weekdays: [1, 2, 3, 4, 5, 6, 7], start: 0, end: 1440 }];
      });
      await startMode(page, 'carving');
      await page.evaluate(() => { __testVolume = 65; });
      await page.waitForFunction(() => /正在记录/.test(document.querySelector('#reading-session-status [role="status"]').textContent)
        && /[1-9]\d* 秒/.test(document.querySelector('#reading-session-status [aria-live="off"]').textContent));
      await page.locator('#pause-carving').click();
      await page.waitForFunction(() => /早读就绪/.test(document.querySelector('#reading-session-status [role="status"]').textContent));
    }
  });
}

for (const teacher of [false, true]) {
  test(`${teacher ? 'teacher' : 'classroom'} shared glass: hide, restore and label replacement keep one valid lens`, async t => {
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    await page.setContent(`<html class="${teacher ? '' : 'bb-native-voice-page'}"><body class="${teacher ? 'teacher-liquid' : ''}"><div id="surface" class="${teacher ? 'metric' : 'bb-header'}" style="width:320px;height:140px;border-radius:20px">操作内容</div></body></html>`);
    if (!teacher) await page.evaluate(() => { window.ICeClassVoiceHost = { classroomAccount: true }; });
    await page.addStyleTag({ path: path.join(root, 'assets', 'classroom-glass.css') });
    await page.addScriptTag({ path: path.join(root, 'assets', 'classroom-glass.js') });
    const filters = () => page.locator('.classroom-filter-definitions filter').count();
    await page.waitForFunction(() => document.querySelectorAll('.classroom-filter-definitions filter').length === 1);
    await page.locator('#surface').evaluate(element => { element.style.display = 'none'; });
    await page.waitForFunction(() => document.querySelectorAll('.classroom-filter-definitions filter').length === 0);
    await page.locator('#surface').evaluate(element => { element.style.display = ''; });
    await page.waitForFunction(() => document.querySelectorAll('.classroom-filter-definitions filter').length === 1);
    await page.locator('#surface').evaluate(element => { element.textContent = '操作已更新'; });
    if (!teacher) {
      await page.locator('#surface > .lg-lens').waitFor({ state: 'attached' });
      assert.equal(await page.locator('#surface > .lg-lens').count(), 1);
    }
    assert.equal(await filters(), 1);
  });
}

async function palette(scope, selectors) {
  return scope.evaluate(selectors => selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
    const style = getComputedStyle(element);
    return { selector, background: style.backgroundColor, image: style.backgroundImage, color: style.color };
  })), selectors);
}

function noOldGreen(rows, state) {
  for (const row of rows) {
    for (const [property, value] of Object.entries(row)) {
      if (!['background', 'image', 'color'].includes(property)) continue;
      for (const color of value.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/g)) {
        const [, red, green, blue, alpha] = color.map(Number);
        if (alpha === 0) continue;
        assert.ok(!(green > red + 2 && green > blue + 3), `${state}: ${row.selector} ${property} still shows old green: ${value}`);
      }
    }
  }
}

const gameSurfaces = ['html', 'body', '#start-overlay', '.welcome-card', '#big-start-btn', '#dashboard', '#status-label', '#vol-bar',
  '#audio-btn', '#audio-btn > .lg-lens', '#pause-btn', '#settings-btn', '#settings-modal', '.modal-content', '.save-btn', '.radio-options label'];

for (const mode of ['classic', 'rocket']) {
  test(`${mode}: no green first paint while the optional glass script is delayed`, async t => {
    const { page, releaseGlass } = await open(t, { delayGameGlass: true });
    await page.locator('#open-' + mode).click();
    const frame = page.frameLocator('#classic-frame-holder iframe');
    await frame.locator('#big-start-btn').waitFor();
    assert.equal(await frame.locator('#big-start-btn.lg-pane').count(), 0, 'The plain CSS state is actually exercised');
    noOldGreen(await palette(page.frames().find(frame => frame.parentFrame()), gameSurfaces), mode + ' first paint');
    releaseGlass();
    await frame.locator('#big-start-btn.lg-pane').waitFor();
    noOldGreen(await palette(page.frames().find(frame => frame.parentFrame()), gameSurfaces), mode + ' glass ready');
  });

  test(`${mode}: running, pause, audio and settings keep the shared palette`, async t => {
    const { page } = await open(t);
    await page.locator('#open-' + mode).click();
    const frame = page.frameLocator('#classic-frame-holder iframe');
    await frame.locator('#big-start-btn.lg-pane').waitFor();
    await frame.locator('#big-start-btn').click();
    await frame.locator('#dashboard').waitFor();
    await page.evaluate(() => { window.__testVolume = 75; });
    const activity = page.frames().find(frame => frame.parentFrame());
    await activity.evaluate(() => { window.__testVolume = 75; });
    await page.waitForFunction(() => ReadingMonitor.getState().active && ReadingMonitor.getState().volume > 30);
    noOldGreen(await palette(activity, gameSurfaces), mode + ' running');
    await frame.locator('#audio-btn').click();
    await frame.locator('#audio-btn.on').waitFor();
    noOldGreen(await palette(activity, gameSurfaces), mode + ' audio on');
    await frame.locator('#pause-btn').click();
    await page.waitForFunction(() => !ReadingMonitor.getState().active);
    await frame.locator('#pause-btn').click();
    await page.waitForFunction(() => ReadingMonitor.getState().active);
    await frame.locator('#settings-btn').click();
    await frame.locator('#settings-modal.visible').waitFor();
    await frame.locator('#save-settings-btn').hover();
    noOldGreen(await palette(activity, gameSurfaces), mode + ' settings hover');
    await frame.locator('#save-settings-btn').click();
    await frame.locator('#settings-modal.visible').waitFor({ state: 'hidden' });
    await page.locator('#choose-mode').click();
    await page.locator('#home-view').waitFor();
    assert.equal(await page.locator('#classic-frame-holder iframe').count(), 0);
    assert.ok(await page.evaluate(() => __testStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), 'Leaving releases capture');
  });
}

for (const mode of ['carving', 'particle']) {
  test(`${mode}: setup and running controls share the palette and preserve pause/resume`, async t => {
    const { page } = await open(t);
    await page.locator('#open-' + mode).click();
    const setup = mode === 'carving' ? '#carving-setup' : '#particle-setup';
    await page.locator(setup).waitFor();
    await page.locator(setup + ' .speed-settings-toggle').click();
    const surfaces = ['.carving-speed-settings', '.carving-speed-stepper button', '.carving-speed-editor',
      '.carving-sidebar', '.reading-status', '.panel-pin[aria-pressed="true"]', '.primary-button', '.quiet-button'];
    noOldGreen(await palette(page, surfaces), mode + ' setup');
    await page.locator('#start-' + mode).click();
    await page.waitForFunction(() => ReadingMonitor.getState().active);
    await page.evaluate(() => { window.__testVolume = 75; });
    await page.waitForFunction(() => ReadingMonitor.getState().volume > 30);
    noOldGreen(await palette(page, surfaces), mode + ' running');
    await page.locator('#pause-' + mode).click();
    await page.waitForFunction(() => !ReadingMonitor.getState().active);
    await page.locator('#pause-' + mode).click();
    await page.waitForFunction(() => ReadingMonitor.getState().active);
    await page.locator('#finish-' + mode).click();
    await page.waitForFunction(() => !ReadingMonitor.getState().active);
    noOldGreen(await palette(page, surfaces), mode + ' finished');
    await page.locator('#choose-mode').click();
    await page.locator('#home-view').waitFor();
    assert.ok(await page.evaluate(() => __testStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), 'Leaving releases capture');
  });
}

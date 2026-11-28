'use strict';

// Isolated production-page checks. Every API request is answered by fixtures;
// no school service, account, physical microphone, notification or AI is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..', 'web_controller');
const origin = 'http://127.0.0.1';

function historyItem(classId = 'c1', id = 'notice-1') {
  return {id, class_id:classId, class_name:classId === 'c1' ? '高一（1）班' : '高二（1）班', sender_name:'测试教师',
    created_at:1794000000000, alert_level:'info', content_type:'text', text:id, status:'received'};
}
function fixture(url, role = 'superadmin') {
  const classes = [{id:'c1',name:'高一（1）班',enabled:1,canReceiveVoice:true,canManage:true}, {id:'c2',name:'高二（1）班',enabled:1,canReceiveVoice:true,canManage:true}];
  const user = {id:'review-teacher',username:'review',displayName:'测试教师',role,csrfToken:'fixture',
    permissions:{receiveClassroomVoice:role !== 'subject_teacher',assignableRoles:['principal','director','grade_leader','teacher','subject_teacher']}};
  switch (url.pathname) {
    case '/api/session': return {authenticated:true,user};
    case '/api/bootstrap': return {required:false};
    case '/api/classes': return {classes};
    case '/api/history': return {history:[historyItem(url.searchParams.get('classId') || 'c1')],hasMore:true};
    case '/api/teachers': return {teachers:[{id:'staff-1',username:'teacher1',display_name:'林老师',role:'teacher',enabled:1,canManage:true,classes,headClasses:[classes[0]],teachingClasses:[classes[1]]}]};
    case '/api/devices': return {devices:[]};
    case '/api/classroom-controls': return {devices:[]};
    case '/api/classroom-voice': return {messages:[]};
    case '/api/card-quiz/questions': return {questions:[]};
    case '/api/card-quiz/decks': return {decks:[]};
    case '/api/card-quiz/classes/c1/publications': return {publications:[]};
    case '/api/card-quiz/classes/c1/cards': return {classId:'c1',revision:1,canEdit:true,students:[{id:'s1',name:'测试学生',cardNumber:1}]};
    case '/api/card-quiz/classes/c1/students': return {classId:'c1',className:classes[0].name,revision:1,rosterRevision:1,cardRevision:1,classCode:'101',canEdit:false,students:[]};
    case '/api/quiet-hours': return {periods:[{id:'p1',name:'上课时间',startTime:'08:00',endTime:'08:40',weekdays:[1,2,3,4,5]}],activePeriod:null};
    case '/api/reading/settings': return {config:{enabled:true,threshold:30,reminderEnabled:true,periods:[{weekdays:[1,2,3,4,5],start:440,end:470}]}};
    case '/api/reading/report': return {start:url.searchParams.get('start'),end:url.searchParams.get('end'),grades:[],rows:[],daily:[]};
    case '/api/homework/report': return {rows:[],group:'assignments',total:0,totals:{assignments:0,expected:0,submitted:0,missing:0,noHomework:0}};
    case '/api/ideas/admin': return {items:[],total:0};
    case '/api/ideas/admin/summary': return {pending:0,total:0,published:0,digest:{enabled:false}};
    case '/api/enrollment/school-code': return {enabled:false};
    case '/api/island/visibility': return {revision:0,config:{hideDaytimeLessons:true,hideFirstEvening:true}};
    default:
      if (/^\/api\/classes\/[^/]+\/status$/.test(url.pathname)) return {online:false};
      if (/^\/api\/homework\/classes\/[^/]+\/profile$/.test(url.pathname)) return {classId:'c1',revision:1,canEdit:true,value:{activeTermId:'term',students:[{id:'s1',name:'张三'}],terms:[{id:'term',label:'第一学期',subjects:[{id:'chinese',name:'语文',items:[{id:'book',name:'练习册',active:true}]}]}]}};
      if (/^\/api\/island\/classes\//.test(url.pathname)) return {classId:'c1',revision:1,devices:[],schoolVisibility:fixture(new URL('/api/island/visibility',origin)),config:{schemaVersion:1,enabled:true,weekAnchor:'2026-09-07',slots:[{id:'p1',label:'第一节',start:475,end:520}],lessons:[{slotId:'p1',weekday:1,week:'all',subject:'数学',teacher:'测试教师',location:''}],overrides:[],visibility:{followSchool:true,hiddenSlotIds:[]},dutyRotations:{midday:{enabled:false,cycleWeeks:1,weekAnchor:'2026-09-07',slotIds:[],lessons:[]},evening:{enabled:false,cycleWeeks:1,weekAnchor:'2026-09-07',slotIds:[],lessons:[]}},reminders:{enabled:false,prepare:false,start:false,end:false,prepareMinutes:2,volume:65,displaySeconds:8},appearance:{position:'top-center',width:560,opacity:100,theme:'light',offsetX:0,offsetY:0},components:[],rotationSeconds:8,automation:[]}};
      return undefined;
  }
}

async function open(browser, {role = 'superadmin', width = 1280, height = 850, authenticated = true, handle} = {}) {
  const context = await browser.newContext({viewport:{width,height},reducedMotion:'reduce'});
  const page = await context.newPage(), requests = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin, 'Only isolated local resources are used');
    if (url.pathname.startsWith('/api/')) {
      requests.push({path:url.pathname,query:url.search,method:request.method()});
      const answer = handle && await handle({route,url,request});
      if (answer !== undefined) return route.fulfill(answer);
      assert.ok(['GET','HEAD'].includes(request.method()), 'No real business writes');
      const value = url.pathname === '/api/session' && !authenticated ? {authenticated:false} : fixture(url,role);
      return route.fulfill(value === undefined ? {status:503,json:{error:'隔离检查：此接口暂时不可用。'}} : {json:value,headers:{'X-ICeClass-Preview':'1'}});
    }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    assert.ok(file.startsWith(root + path.sep));
    return fs.existsSync(file) && fs.statSync(file).isFile() ? route.fulfill({path:file}) : route.fulfill({status:404,body:'Not found'});
  });
  await page.goto(origin + '/');
  if (!authenticated) { await page.locator('#loginForm:not(.hidden)').waitFor(); return {page,context,requests,errors}; }
  await page.locator('#appShell:not(.hidden)').waitFor();
  await page.waitForFunction(() => !!window.ICeClass?.state.user);
  await page.locator('#readingRanking[aria-busy="false"]').waitFor();
  return {page,context,requests,errors};
}
async function navigate(page, view) {
  if (await page.locator('#menuToggle').isVisible()) await page.locator('#menuToggle').click();
  await page.locator(`#mainNav [data-view="${view}"]`).click();
  await page.locator(`#view-${view}:not(.hidden)`).waitFor();
}
async function settingsSection(page, section) {
  if (!await page.locator('#view-settings').isVisible()) await navigate(page, 'settings');
  const link = page.locator(`#view-settings [data-section="${section}"]`);
  if (await link.isVisible()) await link.click();
  else await page.locator('#sectionSelect').selectOption(section);
}
async function moveBanbanAside(page) {
  // Keep the floating assistant active; drag it away from the settings controls.
  const box = await page.locator('#bbLauncher').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(12 + box.width / 2, box.y + box.height / 2, {steps:8});
  await page.mouse.up();
}
function launchWorkbenchBrowser(options = {}) {
  const executablePath = process.env.ICECLASS_WHITEBOARD_CHROMIUM;
  return chromium.launch({...options, ...(executablePath ? {executablePath} : {channel:'msedge'})});
}
module.exports = {open,navigate,settingsSection,moveBanbanAside,fixture,historyItem,launchWorkbenchBrowser};

if (require.main === module) {
  let browser;
  before(async () => {
    browser = await launchWorkbenchBrowser({args:['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']});
  });
  after(async () => { await browser?.close(); });
  async function setup(t,options) {
    const result = await open(browser,options);
    t.after(async () => { await result.context.close(); assert.deepEqual(result.errors,[], 'No browser script errors'); });
    return result;
  }
  test('Startup reuses the session response for the local preview notice', async t => {
    const {page,requests} = await setup(t);
    await page.locator('#previewNotice').waitFor();
    assert.equal(requests.filter(r => r.path === '/api/session').length,1);
  });
  test('纸卡管理首次打开时载入，失败可原地重试，重复进入复用模块', async t => {
    const {page} = await setup(t);
    const paper = page.locator('#mainNav [data-view="card-quiz"]');
    const loaded = () => page.evaluate(() => Boolean(window.ICeClassCardQuiz));
    assert.equal(await loaded(), false);
    let downloads = 0;
    await page.route('**/card-quiz-admin.js*', route => ++downloads === 1 ? route.abort() : route.fallback());
    await paper.click();
    await page.locator('#toastRegion').getByText(/重试/).waitFor();
    assert.equal(await page.locator('#view-card-quiz').isVisible(), false);
    await navigate(page, 'card-quiz');
    await page.locator('[data-cq-action=initialize]').waitFor();
    await navigate(page, 'history');
    await navigate(page, 'card-quiz');
    assert.equal(downloads, 2);
  });
  test('教师首页按入口加载账号管理和设置资源', async t => {
    const {page} = await setup(t);
    const modules = () => page.evaluate(() => performance.getEntriesByType('resource')
      .map(r => new URL(r.name).pathname).filter(p => ['/users.js','/client-diagnostics.js'].includes(p)).sort());
    assert.deepEqual(await modules(), []);
    await navigate(page, 'teachers');
    assert.deepEqual(await modules(), ['/users.js']);
    await navigate(page, 'settings');
    assert.deepEqual(await modules(), ['/client-diagnostics.js','/users.js']);
  });
  test('Login shows a recoverable error and password visibility keeps an accessible name',async t=>{
    const {page}=await setup(t,{authenticated:false,handle:({url,request})=>url.pathname==='/api/auth/login'&&request.method()==='POST'?{status:401,json:{error:'账号或密码不正确，请重试。'}}:undefined});
    await page.locator('#loginUsername').fill('review');await page.locator('#loginPassword').fill('fixture-password');
    await page.locator('#loginPasswordToggle').click();assert.equal(await page.locator('#loginPassword').getAttribute('type'),'text');
    assert.equal(await page.locator('#loginPasswordToggle').getAttribute('aria-label'),'隐藏密码');
    await page.locator('#loginSubmit').click();await page.locator('#loginError').filter({hasText:'账号或密码不正确'}).waitFor();
    assert.equal(await page.locator('#loginSubmit').isEnabled(),true);
    assert.equal(await page.locator('#loginPassword').inputValue(),'fixture-password');
  });
  async function signIn(page) {
    await page.locator('#loginUsername').fill('review');
    await page.locator('#loginPassword').fill('fixture-password');
    await page.locator('#loginPassword').press('Enter');
  }
  test('登录资源中断仍可提交，重试工作台重新核对账号且不重复登录', async t => {
    let user = null;
    const {page,requests} = await setup(t, {authenticated:false, handle:({url}) => {
      if (url.pathname === '/api/session') return {json:{authenticated:!!user,user}};
      if (url.pathname === '/api/auth/login') {
        user = fixture(new URL('/api/session', origin), 'teacher').user;
        return {json:{user}};
      }
    }});
    await page.route('**/assets/page-assets.js*', route => route.abort());
    await page.reload();
    await page.locator('#loginForm').waitFor({timeout:5000});
    await signIn(page);
    const retry = page.getByRole('button', {name:'重新载入工作台'});
    await retry.waitFor({timeout:5000});
    assert.equal(await page.locator('#appShell').isVisible(), false);
    assert.match(await page.getByRole('alert').innerText(), /工作台.*载入/);
    assert.equal(await retry.evaluate(button => button === document.activeElement), true);
    user = {...user, id:'second', displayName:'另一位教师'};
    await page.unroute('**/assets/page-assets.js*');
    await retry.press('Enter');
    await page.getByRole('button', {name:'另一位教师，账号菜单'}).waitFor();
    assert.equal(requests.filter(call => call.path === '/api/auth/login').length, 1);
  });
  test('班班动画慢加载时教师可打开纸卡，班班失败后可单独重试', async t => {
    const user = fixture(new URL('/api/session', origin), 'teacher').user;
    const {page,requests} = await setup(t, {authenticated:false, handle:({url}) => {
      if (url.pathname === '/api/auth/login') return {json:{user}};
    }});
    let motion, attempts = 0, rigs = 0, mounts = 0;
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path === '/banban-rig.js') rigs++;
      if (path === '/banban.js') mounts++;
    });
    await page.route('**/banban-motion.js*', route => { attempts++; motion = route; });
    await signIn(page);
    await page.locator('#appShell').waitFor({timeout:5000});
    await navigate(page, 'card-quiz');
    await page.locator('[data-cq-action=initialize]').waitFor();
    assert.equal(attempts, 1);
    assert.equal(await page.locator('#bbLauncher').count(), 0);
    await motion.abort();
    const retry = page.getByRole('button', {name:'重新载入班班'});
    await retry.waitFor();
    await retry.press('Enter');
    await retry.press('Enter');
    assert.equal(attempts, 2);
    await motion.fallback();
    await page.getByRole('button', {name:'打开班班'}).click();
    assert.equal(await page.locator('#bbPanel').isVisible(), true);
    assert.equal(await page.locator('#view-card-quiz').isVisible(), true);
    assert.equal(await retry.isVisible(), false);
    assert.equal(rigs, 1);
    assert.equal(mounts, 1);
    assert.equal(requests.filter(call => call.path === '/api/auth/login').length, 1);
  });
  test('账号过期后返回的班班脚本不会启动旧账号的助手', async t => {
    const user = fixture(new URL('/api/session', origin), 'teacher').user;
    let expired = false, pending;
    const {page,requests} = await setup(t, {authenticated:false, handle:({url}) => {
      if (url.pathname === '/api/auth/login') return {json:{user}};
      if (expired && url.pathname === '/api/history') return {status:401,json:{}};
    }});
    await page.route('**/banban.js?*', route => { pending = route; });
    await signIn(page);
    await page.locator('#appShell').waitFor({timeout:5000});
    await navigate(page, 'history');
    await page.locator('#historyContainer tbody').waitFor();
    expired = true;
    await page.locator('#refreshHistory').press('Enter');
    await page.locator('#sessionExpired').waitFor();
    const loaded = page.evaluate(() => new Promise(resolve => {
      document.querySelector('script[src*="/banban.js?"]').addEventListener('load', () => setTimeout(resolve, 0), {once:true});
    }));
    await pending.fallback();
    await loaded;
    assert.equal(await page.locator('#bbLauncher').count(), 0);
    assert.equal(requests.some(call => call.path.startsWith('/api/banban/')), false);
  });
  for (const [width,height] of [[1280,850],[390,740],[320,560]]) {
    test(`Login role switching holds the form in place at ${width} × ${height}`, async t => {
      const {page} = await setup(t,{width,height,authenticated:false,handle:({url,request}) =>
        url.pathname==='/api/student/login' && request.method()==='POST'
          ? {status:401,json:{error:'学生编号或密码错误。',code:'invalid_credentials'}}
          : undefined
      });
      const role = page.locator('#loginRoles label');
      const teacher = page.getByRole('radio',{name:'教师'});
      const student = page.getByRole('radio',{name:'学生'});
      const position = selector => page.locator(selector).evaluateAll(elements => elements.map(element =>
        Math.round((element.getBoundingClientRect().top + window.scrollY) * 2) / 2
      ));
      const controls = '.auth-card, #loginHeading, #loginRoles, #loginUsername, #loginPassword, #loginSubmit';
      const initial = await position(controls);
      const cardHeight = (await page.locator('.auth-card').boundingBox()).height;
      await role.nth(1).click();
      assert.ok(await student.isChecked());
      assert.deepEqual(await position(controls), initial, 'Mouse switch keeps controls in place');
      assert.equal((await page.locator('.auth-card').boundingBox()).height, cardHeight);
      await student.press('ArrowLeft');
      assert.ok(await teacher.isChecked());
      assert.deepEqual(await position(controls), initial, 'Keyboard switch keeps controls in place');

      await page.goto(origin + '/?login=student&notice=signed-out');
      await page.locator('#loginNotice').filter({hasText:'已退出学生账号'}).waitFor();
      assert.ok(await student.isChecked());
      assert.deepEqual(await position(controls), initial, 'A logout notice keeps controls in place');
      await page.locator('#loginUsername').fill('2610901');
      await page.locator('#loginPassword').fill('123456');
      await page.locator('#loginSubmit').click();
      await page.locator('#loginError').filter({hasText:'学生编号或密码错误'}).waitFor();
      assert.deepEqual(await position(controls), initial, 'An error keeps controls in place');
      await role.nth(0).click();
      assert.ok(await teacher.isChecked());
      assert.equal(await page.locator('#loginError').isVisible(), false);
      assert.deepEqual(await position(controls), initial, 'Clearing an error keeps controls in place');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    });
  }
  test('A secondary startup failure keeps the authenticated workbench and account settings usable', async t => {
    const {page} = await setup(t,{handle:({url}) => url.pathname === '/api/devices' ? {status:503,json:{error:'设备读取失败，请重试。'}} : undefined});
    await page.waitForFunction(() => document.querySelector('#authPage:not(.hidden)') || document.querySelector('.toast')?.textContent.includes('设备读取失败'));
    assert.equal(await page.locator('#authPage').isVisible(),false);
    assert.match(await page.locator('#settingsAccount').textContent(),/测试教师/);
    assert.equal(await page.evaluate(() => !!window.ICeClass.state.presenceTimer && !!window.ICeClass.state.classroomVoiceTimer),true);
  });
  test('A class-loading failure reports the problem without showing a second login form', async t => {
    const {page} = await setup(t,{handle:({url}) => url.pathname === '/api/classes' ? {status:503,json:{error:'班级服务暂时不可用'}} : undefined});
    await page.locator('.toast').filter({hasText:'班级载入失败'}).waitFor();
    assert.equal(await page.locator('#authPage').isVisible(),false);
    await page.waitForFunction(() => !!window.ICeClass.state.quietTimer);
    assert.match(await page.locator('#settingsAccount').textContent(),/测试教师/);
  });
  test('Hold-to-record keeps the playable recording after a failed or offline send', async t => {
    let sendAttempts = 0;
    const {page,context} = await setup(t,{handle:({url,request}) => {
      if (url.pathname !== '/api/shouts' || request.method() !== 'POST') return;
      sendAttempts++;
      if (sendAttempts === 1) return {status:503,json:{error:'发送暂时失败，请重试。'}};
      if (sendAttempts === 2) return {json:{id:'voice-offline',status:'offline',detail:'演示教室离线'}};
      return {json:{id:'voice-sent',status:'sent'}};
    }});
    await page.evaluate(() => {
      // Older browser protocols omit file parts from inspected multipart requests.
      const fetch = window.fetch.bind(window);
      window.sentRecordings = [];
      window.fetch = async (input, options) => {
        const audio = options?.body instanceof FormData && options.body.get('audio');
        if (audio instanceof File) {
          const header = new Uint8Array(await audio.slice(0, 44).arrayBuffer());
          window.sentRecordings.push({name:audio.name, header:[...header], size:audio.size});
        }
        return fetch(input, options);
      };
    });
    await context.grantPermissions(['microphone'],{origin});
    await navigate(page,'console');
    await page.getByRole('tab',{name:'语音通知'}).click();
    const record = page.locator('#recordButton');
    await record.scrollIntoViewIfNeeded();
    await record.hover();
    await page.mouse.down();
    try {
      await page.locator('#recordButton[aria-pressed="true"]').waitFor();
      await page.getByText('00:01',{exact:true}).waitFor();
    } finally { await page.mouse.up(); }
    const preview = page.locator('#voicePreview');
    await preview.waitFor();
    assert.equal(await record.isVisible(),false);
    assert.equal(await preview.evaluate(audio=>audio===document.activeElement),true);
    assert.ok(await preview.evaluate(async audio=>{ await audio.play(); return audio.duration; }) >= 0.5);
    const audioUrl = await preview.getAttribute('src');
    await page.getByRole('button',{name:'发送语音通知'}).click();
    const confirm = page.locator('#confirmSend');
    await confirm.click();
    await page.getByRole('alert').filter({hasText:'发送暂时失败，请重试。'}).waitFor();
    assert.equal(await preview.getAttribute('src'),audioUrl);
    assert.equal(await confirm.isEnabled(),true);
    await confirm.click();
    await page.locator('#confirmDialog').waitFor({state:'hidden'});
    await page.locator('#deliveryState').filter({hasText:'未送达'}).waitFor();
    assert.equal(await preview.getAttribute('src'),audioUrl);
    await page.getByRole('button',{name:'发送语音通知'}).click();
    await confirm.click();
    await record.waitFor();
    assert.equal(await preview.getAttribute('src'),null);
    assert.equal(sendAttempts,3);
    const recordings = await page.evaluate(() => window.sentRecordings);
    assert.equal(recordings.length,3);
    const first = recordings[0];
    assert.equal(first.name,'voice.wav');
    assert.equal(Buffer.from(first.header).toString('ascii',0,4),'RIFF');
    assert.ok(first.size > 44);
    for (const audio of recordings.slice(1)) assert.deepEqual(audio,first);
  });
  test('A stale quiet-hours check cannot open a confirmation after leaving the composer', async t => {
    let holdCheck=false, release;
    const gate=new Promise(resolve => {release=resolve;});
    const {page,requests} = await setup(t,{handle:async ({url}) => {
      if (holdCheck && url.pathname==='/api/quiet-hours') { await gate; return {json:{periods:[],activePeriod:null}}; }
    }});
    t.after(() => release());
    await navigate(page,'console');
    await page.locator('#quietScheduleList .schedule-item').waitFor({state:'attached'});
    await page.locator('#shoutText').fill('下节课请带练习册。');
    const send=page.locator('#sendButton');
    const readsBefore=requests.filter(request=>request.path==='/api/quiet-hours').length;
    holdCheck=true;
    await send.press('Enter');
    await send.press('Enter');
    await page.locator('#sendButton[aria-disabled="true"]').waitFor();
    assert.equal(requests.filter(request=>request.path==='/api/quiet-hours').length,readsBefore+1);
    await navigate(page,'history');
    await navigate(page,'console');
    const read=page.waitForResponse(response=>response.url().endsWith('/api/quiet-hours'));
    holdCheck=false; release(); await (await read).finished();
    assert.equal(await page.locator('#confirmDialog').isVisible(),false);
    assert.equal(await page.locator('#shoutText').inputValue(),'下节课请带练习册。');
    assert.equal(requests.filter(request=>request.path==='/api/shouts').length,0);
    await send.press('Enter');
    await page.locator('#confirmDialog').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await send.evaluate(el=>el===document.activeElement),true);
  });
  test('The confirmed text and settings survive a quiet-hours recheck and receive the classroom receipt', async t => {
    let release; const gate=new Promise(resolve=>{release=resolve;});
    const attempts=[], period={name:'上课时间',startTime:'08:00',endTime:'08:40'};
    const notice='下节课带数学课本。\n'+ 'A'.repeat(470);
    const {page} = await setup(t,{width:390,handle:async ({url,request}) => {
      if (url.pathname==='/api/shouts' && request.method()==='POST') {
        attempts.push(request.postDataJSON());
        if (attempts.length===1) {
          await gate;
          return {status:409,json:{code:'quiet_confirmation_required',quietPeriod:period}};
        }
        return {json:{id:'confirmed-notice',status:'sent'}};
      }
      if (url.pathname==='/api/history' && url.searchParams.get('limit')==='20')
        return {json:{history:[{...historyItem('c2','confirmed-notice'),text:notice,status:'displayed',acknowledged_at:1794000001000}]}};
    }});
    t.after(()=>release());
    await navigate(page,'console');
    await page.locator('#targetClass').selectOption('c2');
    await page.locator('#shoutText').fill(notice);
    await page.locator('input[name="alertLevel"][value="info"]').press('ArrowRight');
    await page.locator('#advancedSettings summary').press('Enter');
    await page.locator('#displayDuration').selectOption('15');
    await page.locator('#ttsSpeed').selectOption('2');
    await page.locator('#sendButton').press('Enter');
    const dialog=page.getByRole('dialog',{name:'确认发送通知'});
    await dialog.waitFor();
    assert.equal(await dialog.locator('#confirmTarget').textContent(),'高二（1）班');
    assert.equal(await dialog.locator('#confirmMode').textContent(),'语音播报，15 秒');
    assert.equal(await dialog.locator('#confirmText').textContent(),notice);
    assert.equal(await dialog.locator('#confirmText').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    assert.equal(await page.locator('#cancelNoticeSend').evaluate(e=>e===document.activeElement),true);
    const confirm=page.locator('#confirmSend');
    const post=page.waitForRequest(request=>request.url().endsWith('/api/shouts'));
    await confirm.press('Enter'); await post;
    await confirm.press('Enter');
    assert.equal(await confirm.isDisabled(),true);
    assert.equal(attempts.length,1);
    release();
    await page.getByRole('dialog',{name:'当前处于禁言时间'}).waitFor();
    assert.match(await page.locator('#quietWarningTitle').textContent(),/08:00-08:40/);
    assert.equal(await page.locator('#confirmText').textContent(),notice);
    assert.equal(await page.locator('#cancelNoticeSend').evaluate(e=>e===document.activeElement),true);
    await page.getByRole('button',{name:'仍然发送'}).press('Enter');
    await page.locator('#deliveryState').filter({hasText:'教室已知晓'}).waitFor();
    await page.locator('#recentList').getByText('教室已知晓').waitFor();
    assert.equal(await page.locator('#shoutText').inputValue(),'');
    assert.deepEqual(attempts,[false,true].map(quietAcknowledged=>({classId:'c2',alertLevel:'warning',displayDurationSec:15,ttsSpeed:2,ttsVolume:1,quietAcknowledged,text:notice})));
  });
  test('Recent records and classroom status stay with the selected class across a failed read and retry', async t => {
    let releaseStatus, releaseRetry, reads=0;
    const statusGate=new Promise(resolve=>{releaseStatus=resolve;});
    const retryGate=new Promise(resolve=>{releaseRetry=resolve;});
    const {page} = await setup(t,{handle:async ({url}) => {
      if (url.pathname==='/api/classes/c1/status') {await statusGate; return {json:{online:false}};}
      if (url.pathname==='/api/classes/c2/status') return {json:{online:true}};
      if (url.pathname==='/api/history' && url.searchParams.get('limit')==='5' && url.searchParams.get('classId')==='c2') {
        if (++reads===1) return {status:503,json:{error:'最近记录暂不可用。'}};
        await retryGate;
        return {json:{history:[historyItem('c2','高二最新通知')]}};
      }
    }});
    t.after(()=>{releaseStatus(); releaseRetry();});
    await navigate(page,'console');
    await page.locator('#presence[data-state="checking"]').waitFor();
    await page.locator('#recentList').getByText('高一（1）班').waitFor();
    await page.locator('#targetClass').selectOption('c2');
    await page.locator('#presence[data-state="online"]').waitFor();
    const oldStatus=page.waitForResponse(response=>response.url().endsWith('/api/classes/c1/status'));
    releaseStatus(); await (await oldStatus).finished();
    assert.equal(await page.locator('#presenceLabel').textContent(),'教室在线');
    const retry=page.getByRole('button',{name:'重试',exact:true});
    await retry.waitFor();
    assert.match(await page.locator('#recentStatus').textContent(),/暂不可用/);
    assert.doesNotMatch(await page.locator('#recentList').innerText(),/高一/);
    const retryRead=page.waitForRequest(request=>request.url().includes('classId=c2&limit=5'));
    await retry.press('Enter'); await retryRead; await retry.press('Enter');
    assert.equal(await retry.isDisabled(),true);
    assert.equal(reads,2);
    releaseRetry();
    await page.locator('#recentList').getByText('高二最新通知').waitFor();
    await retry.waitFor({state:'hidden'});
    assert.equal(await page.locator('#recentList').evaluate(el=>el===document.activeElement),true);
    await page.getByRole('button',{name:'查看记录'}).click();
    await page.locator('#historyContainer').getByText('高二（1）班').waitFor();
    assert.equal(await page.locator('#historyClass').inputValue(),'c2');
    assert.equal(await page.locator('#historyClass').evaluate(el=>el===document.activeElement),true);
  });
  test('Microphone rejection is recoverable and a late grant never starts a released recording', async t => {
    const {page} = await setup(t,{width:390});
    await navigate(page,'console');
    await page.getByRole('tab',{name:'语音通知'}).click();
    await page.evaluate(()=>{
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Denied','NotAllowedError'));
    });
    const record = page.locator('#recordButton');
    await record.focus();
    await page.keyboard.down('Space');
    await page.locator('#recordStatus.is-error').filter({hasText:'请允许访问麦克风后重试'}).waitFor();
    await page.keyboard.up('Space');
    assert.equal(await record.getAttribute('aria-pressed'),'false');
    assert.equal(await record.evaluate(el=>el===document.activeElement),true);
    await page.evaluate(()=>{
      navigator.mediaDevices.getUserMedia = () => new Promise(resolve=>{
        window.releaseMicrophone = () => resolve({getTracks:()=>[{stop(){window.microphoneStopped = true;}}]});
      });
    });
    await page.keyboard.down('Space');
    await page.locator('#recordStatus').filter({hasText:'正在连接麦克风'}).waitFor();
    await page.keyboard.up('Space');
    await page.evaluate(()=>window.releaseMicrophone());
    await page.waitForFunction(()=>window.microphoneStopped===true);
    assert.equal(await record.getAttribute('aria-pressed'),'false');
    assert.equal(await page.locator('#voiceReview').isVisible(),false);
  });
  test('History ignores a slow response from the previously selected class', async t => {
    let release, started;
    const gate = new Promise(resolve => { release=resolve; });
    const entered = new Promise(resolve => { started=resolve; });
    let delayed=false;
    const {page} = await setup(t,{handle:async ({url}) => {
      if (delayed && url.pathname === '/api/history' && url.searchParams.get('limit') === '100' && url.searchParams.get('classId') === 'c1') {
        started(); await gate; return {json:{history:[historyItem('c1','slow-old-class')],hasMore:false}};
      }
    }});
    t.after(() => release());
    await navigate(page,'history');
    delayed=true; await page.locator('#historyClass').selectOption('c1'); await entered;
    await page.locator('#historyClass').selectOption('c2');
    await page.locator('#historyContainer').getByRole('cell',{name:'高二（1）班',exact:true}).waitFor();
    release(); await page.waitForTimeout(100);
    assert.match(await page.locator('#historyContainer').innerText(),/高二/);
    assert.doesNotMatch(await page.locator('#historyContainer').innerText(),/slow-old-class/);
  });
  test('History load more submits one request and appends one page while busy', async t => {
    let release; const gate=new Promise(resolve => {release=resolve;});
    const {page,requests} = await setup(t,{handle:async ({url}) => {
      if (url.pathname === '/api/history' && url.searchParams.get('offset') === '1') { await gate;return {json:{history:[historyItem('c1','second-page')],hasMore:false}}; }
    }});
    t.after(() => release());
    await navigate(page,'history'); await page.locator('#historyContainer .load-more').waitFor();
    const more=page.locator('#historyContainer .load-more');
    await more.focus();
    await more.press('Enter');
    await more.press('Enter');
    await page.waitForTimeout(50);
    assert.equal(requests.filter(r => r.path === '/api/history' && r.query.includes('offset=1')).length,1);
    assert.equal(await page.locator('#historyContainer .load-more').isDisabled(),true);
    release(); await page.getByText('second-page',{exact:true}).waitFor();
    assert.equal(await page.locator('#historyContainer tbody tr').count(),2);
    assert.equal(await more.count(),0);
    assert.equal(await page.getByRole('region',{name:'通知记录，可左右滚动'}).evaluate(e=>e===document.activeElement),true);
  });
  test('History refresh failure retains records with an explicit status and allows retry', async t => {
    let fail=false;
    const {page} = await setup(t,{handle:({url}) => fail && url.pathname==='/api/history' && url.searchParams.get('limit')==='100' ? {status:503,json:{error:'历史记录服务暂时不可用'}} : undefined});
    await navigate(page,'history');await page.locator('#historyContainer tbody').waitFor();
    fail=true;await page.locator('#refreshHistory').click();
    await page.locator('#historyFeedback:not([hidden])').waitFor();
    assert.match(await page.locator('#historyFeedback').textContent(),/上次读取/);
    assert.equal(await page.locator('#historyContainer tbody tr').count(),1);
    assert.equal(await page.locator('#refreshHistory').isEnabled(),true);
    fail=false;await page.locator('#refreshHistory').click();
    await page.locator('#historyContainer[aria-busy="false"]').waitFor();
    assert.equal(await page.locator('#historyFeedback').isVisible(),false);
  });
  test('A failed history class switch cannot append records to the previous class', async t => {
    let fail=false;
    const {page} = await setup(t,{handle:({url}) => fail && url.pathname==='/api/history' && url.searchParams.get('classId')==='c2' ? {status:503,json:{error:'该班级记录暂时不可用'}} : undefined});
    await navigate(page,'history');await page.locator('#historyClass').selectOption('c1');
    await page.locator('#historyContainer[aria-busy="false"]').waitFor();
    fail=true;await page.locator('#historyClass').selectOption('c2');
    await page.locator('#historyFeedback').filter({hasText:'该班级记录暂时不可用'}).waitFor();
    assert.doesNotMatch(await page.locator('#historyContainer').innerText(),/高一/);
    assert.equal(await page.locator('#historyContainer .load-more').count(),0);
    assert.equal(await page.locator('#refreshHistory').textContent(),'重试');
    fail=false;await page.locator('#refreshHistory').click();
    await page.locator('#historyContainer[aria-busy="false"]').waitFor();
    assert.match(await page.locator('#historyContainer').innerText(),/高二/);
    assert.doesNotMatch(await page.locator('#historyContainer').innerText(),/高一/);
    assert.equal(await page.locator('#historyContainer .load-more').isEnabled(),true);
  });
  test('User actions support arrow keys and dismiss on Escape or an outside click', async t => {
    const {page} = await setup(t); await navigate(page,'teachers');
    const menu = page.locator('#userActionsPopover');
    const trigger=page.getByRole('button',{name:'林老师的更多操作'}); await trigger.click();
    assert.equal(await trigger.getAttribute('aria-expanded'),'true');
    await menu.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.textContent),'重置密码');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.textContent),'停用账号');
    await page.keyboard.press('Escape');
    await menu.waitFor({state:'hidden'});
    assert.equal(await trigger.evaluate(e => e === document.activeElement),true);
    assert.equal(await trigger.getAttribute('aria-expanded'),'false');
    await trigger.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.textContent),'删除账号');
    await page.locator('#userSearch').click();
    await menu.waitFor({state:'hidden'});
    assert.equal(await trigger.getAttribute('aria-expanded'),'false');
    assert.equal(await page.getByRole('region',{name:'用户列表，可左右滚动'}).getAttribute('tabindex'),'0');
  });
  test('Refreshing classroom voice releases audio URLs and late downloads stay detached', async t => {
    let version=1,release; const gate=new Promise(resolve => {release=resolve;});
    const message=() => ({id:'voice-'+version,class_name:'高一（1）班',audio_duration_ms:2000,created_at:1794000000000,audio_url:'/api/review-audio'});
    const {page} = await setup(t,{handle:async ({url}) => {
      if(url.pathname==='/api/classroom-voice')return {json:{messages:[message()]}};
      if(url.pathname==='/api/review-audio'){if(version===3)await gate;return {body:'fixture-audio',contentType:'audio/wav'};}
    }});
    t.after(() => release());
    await page.evaluate(() => {
      window.__audioCreated=[];window.__audioRevoked=[];
      const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
      URL.createObjectURL=blob => {const url=create(blob);window.__audioCreated.push(url);return url;};
      URL.revokeObjectURL=url => {window.__audioRevoked.push(url);return revoke(url);};
      HTMLMediaElement.prototype.play=async function(){};
      HTMLMediaElement.prototype.pause=function(){};
    });
    await navigate(page,'classroom-voice');
    await page.getByRole('button',{name:'播放语音',exact:true}).click();
    await page.getByRole('button',{name:'重新播放',exact:true}).waitFor();
    version=2;await page.locator('#refreshClassroomVoice').click();
    await page.getByRole('button',{name:'播放语音',exact:true}).waitFor();
    assert.equal(await page.evaluate(() => window.__audioCreated.every(url => window.__audioRevoked.includes(url))),true);
    version=3;await page.getByRole('button',{name:'播放语音',exact:true}).click();
    version=4;await page.locator('#refreshClassroomVoice').click();
    await page.getByRole('button',{name:'播放语音',exact:true}).waitFor();
    release();await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => window.__audioCreated.length),1,'Detached results never allocate another URL');
  });
  for (const width of [1280,880,390]) test(`All teacher pages fit at ${width}px and mobile navigation returns focus`, async t => {
    const {page} = await setup(t,{width});
    for (const view of ['reading','homework','ideas','island','console','controls','history','classroom-voice','quiet','classes','teachers','settings']) {
      await navigate(page,view);
      if (view === 'homework') await page.locator('[data-hw-action="query"]:enabled').waitFor();
      if (view === 'island') {
        await page.locator('#islandTabContent .table-wrap').first().waitFor({timeout:5000});
        assert.equal(await page.locator('#islandError').textContent(),'');
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),view);
      if (width === 390) assert.equal(await page.locator('#mainContent').evaluate(e => e === document.activeElement),true,view);
    }
  });
  for(const role of ['teacher','subject_teacher','grade_leader','principal'])test(`Teacher navigation preserves the ${role} role boundary`,async t=>{
    const {page,requests}=await setup(t,{role});
    assert.equal(await page.locator('[data-view="ideas"]').isVisible(),false);
    assert.equal(await page.locator('[data-view="classroom-voice"]').isVisible(),role!=='subject_teacher');
    assert.equal(await page.locator('[data-view="teachers"]').isVisible(),['grade_leader','principal'].includes(role));
    if(['teacher','subject_teacher'].includes(role))assert.equal(requests.filter(r=>r.path==='/api/teachers'||r.path==='/api/devices').length,0);
  });
  test('Homework navigation protects edited student names until the teacher chooses to leave',async t=>{
    const {page}=await setup(t);await navigate(page,'homework');await page.locator('[data-hw-action="query"]:enabled').waitFor();
    await page.locator('[data-hw-tab="settings"]').click();await page.locator('[data-hw-student]').fill('张三三');
    await page.locator('#mainNav [data-view="history"]').click();
    await page.locator('#workbenchConfirm[open]').waitFor();await page.locator('#workbenchConfirmCancel').click();
    assert.equal(await page.locator('[data-hw-student]').inputValue(),'张三三');
    assert.equal(await page.locator('#view-homework').isVisible(),true);
  });
}

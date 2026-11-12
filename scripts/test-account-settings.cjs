'use strict';
const assert = require('node:assert/strict');
const {test,before,after} = require('node:test');
const {chromium} = require('playwright');
const {open,navigate,settingsSection,moveBanbanAside} = require('./test-teacher-ui.cjs');

function createSettingsFixture(extra) {
  const writes = [];
  let devices = [
    {id:'d1',class_id:'c1',class_name:'高一（1）班',name:'南楼 201 白板',computer_name:'CLASSROOM-201',device_code:'201-ABCD',local_addresses:['192.0.2.10'],enabled:1,online:true,verified_at:1,class_device_count:1,last_seen_at:1794373200000,binding_note:'南楼二层'},
    {id:'d2',class_id:'c2',class_name:'高二（1）班',name:'北楼 301 电脑',computer_name:'CLASSROOM-301',device_code:'301-EFGH',local_addresses:[],enabled:0,online:false,verified_at:0,class_device_count:1,last_seen_at:0,binding_note:''}
  ];
  let thanks = {revision:3,sections:[{title:'产品共创',body:'示例教师团队\n示例学生代表'},{title:'技术支持',body:'示例开发团队'}]};
  let quota = {revision:2,month:'2026-11',deviceLimit:300,accountLimit:120,overrides:[{kind:'device',id:'d3',limit:500}],targets:[
    ...Array.from({length:8},(_,i)=>({kind:'device',id:'d'+(i+1),name:'教室白板 '+(i+1),detail:`高一（${i+1}）班`,enabled:1,used:[86,300,128,0,41,268,74,26][i],limit:i===2?500:300,source:i===2?'custom':'default'})),
    ...Array.from({length:6},(_,i)=>({kind:'account',id:'a'+(i+1),name:['林老师','陈老师','王老师','李老师','张老师','赵老师'][i],detail:'teacher'+(i+1),enabled:1,used:14+i*11,limit:120,source:'default'}))
  ]};
  const logs = Array.from({length:25},(_,i)=>({id:'log-'+i,edition:i%2?'teacher':'classroom',actor:i%2?'林老师':'高一（1）班',deviceName:i%2?'TEACHER-01':'CLASSROOM-201',version:'2.5.14',kind:i%3?'error':'manual',receivedAt:1794373200000-i*60000,report:'Isolated diagnostic log '+i+'\nNo real user information.'}));
  const handle = async context => {
    const {url,request} = context;
    if (!['GET','HEAD'].includes(request.method())) writes.push({path:url.pathname,method:request.method(),body:request.postDataJSON()});
    const answer = extra && await extra(context); if (answer !== undefined) return answer;
    if (url.pathname === '/api/devices') return {json:{devices}};
    if (/^\/api\/devices\//.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/').at(-1)), body = request.postDataJSON();
      if (request.method() === 'DELETE') devices = devices.filter(device => device.id !== id);
      else devices = devices.map(device => device.id !== id ? device : {...device,
        ...(body.enabled === undefined ? {} : {enabled:body.enabled?1:0,online:false}),
        ...(body.classId ? {class_id:body.classId,class_name:body.classId==='c1'?'高一（1）班':'高二（1）班'} : {}),
        ...(body.name ? {name:body.name} : {}),...(body.bindingNote !== undefined ? {binding_note:body.bindingNote} : {}),verified_at:body.verified?1:device.verified_at});
      return {json:{success:true}};
    }
    if (url.pathname === '/api/about/acknowledgements') {
      if (request.method() === 'PUT') thanks = {...request.postDataJSON(),revision:thanks.revision+1};
      return {json:thanks};
    }
    if (url.pathname === '/api/banban/quotas') {
      if (request.method() === 'PUT') {
        quota = {...quota,...request.postDataJSON(),revision:quota.revision+1};
        quota.targets = quota.targets.map(target => {
          const override = quota.overrides.find(row => row.kind===target.kind&&row.id===target.id);
          return {...target,limit:override?override.limit:quota[target.kind+'Limit'],source:override?'custom':'default'};
        });
      }
      return {json:quota};
    }
    if (url.pathname === '/api/client-diagnostics') {
      const query = url.searchParams, offset = Number(query.get('offset')||0);
      const items = logs.filter(log => (!query.get('edition')||log.edition===query.get('edition'))&&(!query.get('kind')||log.kind===query.get('kind'))&&(!query.get('q')||`${log.actor} ${log.deviceName}`.includes(query.get('q'))));
      return {json:{total:items.length,items:items.slice(offset,offset+20)}};
    }
    if (url.pathname.startsWith('/api/client-diagnostics/')) return {json:logs.find(log=>log.id===url.pathname.split('/').at(-1))};
    return undefined;
  };
  return {handle,writes};
}
module.exports = {createSettingsFixture};

if (require.main === module) {
  let browser;
  before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
  after(async()=>{await browser?.close();});
  async function setup(t,options={}) {
    const fixture = createSettingsFixture(options.handle);
    const result = await open(browser,{...options,handle:fixture.handle});
    result.page.setDefaultTimeout(5000);
    t.after(async()=>{await result.context.close();assert.deepEqual(result.errors,[],'No browser script errors');});
    return {...result,writes:fixture.writes};
  }
  async function stageDrafts(page) {
    await settingsSection(page,'thanks');
    const title=page.locator('#acknowledgementsFields input').first(); await title.waitFor(); await title.fill('未保存的致谢');
    await settingsSection(page,'quota'); await page.locator('#quotaWorkspace:enabled').waitFor();
    await page.locator('#editDefault').click(); await page.locator('#defaultEditor input[type=number]').fill('450');
  }
  test('six sections keep drafts, expose only one work area, and defer administration requests',async t=>{
    const {page,requests}=await setup(t); await navigate(page,'settings');
    assert.equal(await page.locator('#view-settings .section-nav a:not([hidden])').count(),6);
    assert.equal(requests.filter(r=>['/api/banban/quotas','/api/about/acknowledgements','/api/client-diagnostics'].includes(r.path)).length,0);
    await page.locator('#currentPassword').fill('unsaved-password');
    for(const section of ['appearance','devices','quota','thanks','logs','account']) {
      await settingsSection(page,section);
      assert.equal(await page.locator('#settingsContent > section:not([hidden])').count(),1);
    }
    assert.equal(await page.locator('#currentPassword').inputValue(),'unsaved-password');
    assert.equal(requests.filter(r=>r.path==='/api/banban/quotas').length,1);
    await settingsSection(page,'quota'); assert.equal(requests.filter(r=>r.path==='/api/banban/quotas').length,1);
  });
  test('leaving settings clears its route and the account-menu shortcut opens and focuses password fields',async t=>{
    const {page}=await setup(t); await settingsSection(page,'logs');
    assert.match(page.url(),/#settings\/logs$/); await navigate(page,'console'); assert.equal(new URL(page.url()).hash,'');
    await navigate(page,'settings'); assert.equal(await page.locator('#clientDiagnosticsSection').isVisible(),true);
    await page.locator('#headerAccount').click(); await page.locator('[data-header-account=password]').click();
    assert.equal(await page.locator('#settingsAccountSection').isVisible(),true);
    assert.equal(await page.locator('#currentPassword').evaluate(e=>e===document.activeElement),true);
    assert.match(page.url(),/#settings\/account$/);
  });
  for(const width of [320,390,1024]) test(`settings retains the original floating Banban and close focus at ${width}px`,async t=>{
    const {page}=await setup(t,{width,handle:({url})=>{
      if(url.pathname==='/api/banban/conversation')return {json:{id:null,messages:[],scope:{}}};
      if(url.pathname==='/api/banban/context')return {json:{snapshot:{},classes:[],schoolAnalysis:false,connection:{configured:false,enabled:false}}};
    }});
    await settingsSection(page,'account');
    const launcher=page.locator('#bbLauncher');assert.equal(await launcher.isVisible(),true);
    await launcher.click();await page.locator('#bbPanel:not([hidden])').waitFor();
    assert.equal(await launcher.getAttribute('aria-expanded'),'true');
    await page.locator('#bbClose').click();assert.equal(await launcher.evaluate(e=>e===document.activeElement),true);
    const before=await launcher.boundingBox();await moveBanbanAside(page);
    assert.ok((await launcher.boundingBox()).x<before.x,'The original floating launcher can be dragged aside');
    for(const section of ['account','quota','devices','logs']){
      await settingsSection(page,section);
      assert.equal(await launcher.isVisible(),true,section+' keeps the floating launcher');
      if(width===320&&['devices','logs'].includes(section)){
        const refresh=page.locator(section==='devices'?'#refreshDevices':'#diagnosticRefresh');
        assert.equal(await refresh.evaluate(e=>{
          const text=[...e.childNodes].find(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.includes('刷新'));
          const range=document.createRange(),start=text.textContent.indexOf('刷新');range.setStart(text,start);range.setEnd(text,start+2);
          return range.getClientRects().length;
        }),1,'Refresh text stays on one line');
      }
    }
    await navigate(page,'console');assert.equal(await page.locator('#bbLauncher').isVisible(),true);
  });
  for(const role of ['teacher','subject_teacher','principal','director','grade_leader']) test(`${role} sees only permitted settings`,async t=>{
    const {page,requests}=await setup(t,{role}); await navigate(page,'settings');
    assert.equal(await page.locator('#view-settings .section-nav a:not([hidden])').count(),['teacher','subject_teacher'].includes(role)?2:3);
    for(const section of ['quota','thanks','logs']) {
      await page.evaluate(section=>window.ICeClassSettings.select(section),section);
      assert.equal(await page.locator('#settingsAccountSection').isVisible(),true);
    }
    assert.equal(requests.filter(r=>['/api/banban/quotas','/api/about/acknowledgements','/api/client-diagnostics'].includes(r.path)).length,0);
  });
  test('password validation and visibility precede writes; failed updates preserve inputs',async t=>{
    const {page,writes}=await setup(t,{handle:({url})=>url.pathname==='/api/auth/password'?{status:403,json:{error:'当前密码不正确。'}}:undefined});
    await settingsSection(page,'account'); const submit=page.locator('#ownPasswordForm button[type=submit]');
    await submit.click(); assert.match(await page.locator('#ownPasswordError').textContent(),/当前密码/);
    await page.locator('#currentPassword').fill('wrong-current-password'); await page.locator('#ownNewPassword').fill('short');
    await submit.click(); assert.match(await page.locator('#ownPasswordError').textContent(),/10-128/);
    await page.locator('#ownNewPassword').fill('NewPassword123'); await page.locator('#ownNewPasswordConfirm').fill('different');
    await submit.click(); assert.equal(writes.length,0);
    await page.locator('[data-eye=ownNewPassword]').click(); assert.equal(await page.locator('#ownNewPassword').getAttribute('type'),'text');
    assert.equal(await page.locator('[data-eye=ownNewPassword]').getAttribute('aria-pressed'),'true');
    await page.locator('#ownNewPasswordConfirm').fill('NewPassword123'); await submit.click();
    await page.locator('#ownPasswordError').filter({hasText:'当前密码不正确'}).waitFor();
    assert.deepEqual(writes[0].body,{currentPassword:'wrong-current-password',newPassword:'NewPassword123'});
    assert.equal(await page.locator('#ownNewPassword').inputValue(),'NewPassword123'); assert.equal(await submit.isEnabled(),true);
  });
  test('successful password update reloads into the real sign-in flow',async t=>{
    let changed=false;
    const {page,writes}=await setup(t,{handle:({url})=>{
      if(url.pathname==='/api/auth/password'){changed=true;return {json:{success:true}};}
      if(url.pathname==='/api/session'&&changed)return {json:{authenticated:false}};
    }});
    await stageDrafts(page);
    const dialogs=[]; page.on('dialog',async dialog=>{dialogs.push(dialog.type());await dialog.accept();});
    await settingsSection(page,'account'); await page.locator('#currentPassword').fill('OldPassword123');
    await page.locator('#ownNewPassword').fill('NewPassword123'); await page.locator('#ownNewPasswordConfirm').fill('NewPassword123');
    await page.locator('#ownPasswordForm button[type=submit]').click(); await page.locator('#loginForm:not(.hidden)').waitFor();
    assert.equal(writes.filter(write=>write.path==='/api/auth/password').length,1);
    assert.deepEqual(dialogs,['confirm','confirm'],'Already-approved draft disposal never opens a second before-unload prompt');
  });
  test('cancelling the second logout confirmation preserves both drafts; a later logout needs no extra unload prompt',async t=>{
    let loggedOut=false;
    const {page,writes}=await setup(t,{handle:({url})=>{
      if(url.pathname==='/api/auth/logout'){loggedOut=true;return {json:{success:true}};}
      if(url.pathname==='/api/session'&&loggedOut)return {json:{authenticated:false}};
    }});
    await stageDrafts(page);
    const dialogs=[]; let acceptAll=false;
    page.on('dialog',async dialog=>{
      dialogs.push(dialog.type());
      if(!acceptAll&&dialogs.length===2)await dialog.dismiss();else await dialog.accept();
    });
    await page.locator('#logoutButton').evaluate(e=>e.click());
    await page.waitForFunction(()=>document.querySelector('#defaultEditor input[type=number]').value==='450');
    assert.equal(writes.length,0);
    await settingsSection(page,'thanks'); assert.equal(await page.locator('#acknowledgementsFields input').first().inputValue(),'未保存的致谢');
    acceptAll=true;await page.locator('#logoutButton').evaluate(e=>e.click());await page.locator('#loginForm:not(.hidden)').waitFor();
    assert.equal(writes.filter(write=>write.path==='/api/auth/logout').length,1);
    assert.deepEqual(dialogs,['confirm','confirm','confirm','confirm']);
  });
  test('acknowledgements preview, ordering and drafts persist across sections; save sends the revision',async t=>{
    const {page,writes}=await setup(t); await settingsSection(page,'thanks'); await page.locator('#acknowledgementsFields input').first().waitFor();
    await page.locator('#acknowledgementsFields input').first().fill('新的共创标题');
    assert.match(await page.locator('#acknowledgementsPreview').textContent(),/新的共创标题/);
    await settingsSection(page,'account'); await settingsSection(page,'thanks');
    assert.equal(await page.locator('#acknowledgementsFields input').first().inputValue(),'新的共创标题');
    await page.getByRole('button',{name:'下移第 1 组',exact:true}).click();
    await page.locator('#acknowledgementsSave').click(); await page.locator('#acknowledgementsStatus').filter({hasText:'已保存'}).waitFor();
    assert.equal(writes[0].body.revision,3);assert.equal(writes[0].body.sections[1].title,'新的共创标题');
    assert.equal(await page.locator('#acknowledgementsSave').isDisabled(),true);
  });
  test('acknowledgement conflicts keep the draft and require deliberate reloading',async t=>{
    const {page}=await setup(t,{handle:({url,request})=>url.pathname==='/api/about/acknowledgements'&&request.method()==='PUT'?{status:409,json:{error:'致谢已在其他页面修改，请重新载入。'}}:undefined});
    await settingsSection(page,'thanks'); const input=page.locator('#acknowledgementsFields input').first();await input.waitFor();await input.fill('尚未保存的草稿');
    await page.locator('#acknowledgementsSave').click();await page.locator('#acknowledgementsStatus[role=alert]').waitFor();
    assert.equal(await input.inputValue(),'尚未保存的草稿');assert.equal(await page.locator('#acknowledgementsSave').isDisabled(),true);
    page.once('dialog',dialog=>dialog.accept());await page.locator('#acknowledgementsReload').click();
    await page.waitForFunction(()=>document.querySelector('#acknowledgementsFields input').value==='产品共创');
  });
  test('device search and connection filters retain complete identity and addresses',async t=>{
    const {page}=await setup(t);await settingsSection(page,'devices');await page.locator('[data-device-id=d1]').waitFor();
    assert.match(await page.locator('#devicesContainer').textContent(),/192\.0\.2\.10/);
    assert.match(await page.locator('[data-device-id=d1] .device-seen').textContent(),/11-11/);
    await page.locator('#deviceFilter').selectOption('disabled');assert.equal(await page.locator('[data-device-id]').count(),1);
    assert.match(await page.locator('#devicesContainer').textContent(),/CLASSROOM-301/);
    await page.locator('#deviceSearch').fill('不存在的电脑');assert.match(await page.locator('#devicesContainer').textContent(),/没有匹配/);
  });
  test('device binding uses the existing verified binding action and returns keyboard focus',async t=>{
    const {page,writes}=await setup(t);await settingsSection(page,'devices');
    const bind=page.getByRole('button',{name:'核实或改绑南楼 201 白板'});await bind.click();
    await page.locator('#deviceBindingClass').selectOption('c2');await page.locator('#deviceBindingNote').fill('北楼三层');await page.locator('#deviceBindingVerified').check();
    await page.locator('#deviceBindingForm button[type=submit]').click();await page.locator('#deviceBindingDialog').waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.querySelector('[data-device-id=d1]').textContent.includes('高二（1）班'));
    assert.equal(writes[0].body.classId,'c2');assert.equal(writes[0].body.verified,true);
    assert.equal(await page.getByRole('button',{name:'核实或改绑南楼 201 白板'}).evaluate(e=>e===document.activeElement),true);
  });
  test('device disable is confirmed once and returns focus to its named More control',async t=>{
    const {page,writes}=await setup(t);await settingsSection(page,'devices');
    const more=page.locator('[data-device-id=d1] summary');await more.click();await page.locator('[data-device-id=d1]').getByRole('button',{name:'停用设备',exact:true}).click();
    await page.locator('#settingsDeviceConfirm').getByRole('button',{name:'停用设备',exact:true}).click();
    await page.locator('#settingsDeviceConfirm').waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.querySelector('[data-device-id=d1] .device-status').textContent==='已停用');
    assert.deepEqual(writes[0].body,{enabled:false});assert.equal(writes.filter(write=>write.path==='/api/devices/d1').length,1);
    assert.equal(await page.locator('[data-device-id=d1] summary').evaluate(e=>e===document.activeElement),true);
  });
  test('device status stays saved when the follow-up read fails and re-rendered actions stay disabled during that read',async t=>{
    let changed=false,release,started;
    const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
    const {page,writes}=await setup(t,{handle:async({url,request})=>{
      if(url.pathname==='/api/devices/d1'&&request.method()==='PATCH')changed=true;
      if(url.pathname==='/api/devices'&&changed){started();await gate;return {status:503,json:{error:'设备列表暂不可用'}};}
    }});t.after(()=>release());
    await settingsSection(page,'devices');await page.locator('[data-device-id=d1] summary').click();
    await page.locator('[data-device-id=d1]').getByRole('button',{name:'停用设备',exact:true}).click();
    await page.locator('#settingsDeviceConfirm button[type=submit]').click();await entered;
    assert.equal(await page.locator('[data-device-id=d1] .device-status').textContent(),'已停用');
    assert.equal(await page.getByRole('button',{name:'核实或改绑南楼 201 白板'}).isDisabled(),true);
    assert.equal(await page.locator('[data-device-id=d1] summary').getAttribute('aria-disabled'),'true');
    release();await page.locator('#deviceStatus[role=alert]').filter({hasText:'设备已停用并断开。列表刷新失败'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'核实或改绑南楼 201 白板'}).isEnabled(),true);
    assert.equal(writes.filter(write=>write.path==='/api/devices/d1').length,1);
  });
  test('device deletion retains name confirmation and focuses search after removal',async t=>{
    const {page,writes}=await setup(t);await settingsSection(page,'devices');await page.locator('[data-device-id=d1] summary').click();
    await page.locator('[data-device-id=d1]').getByRole('button',{name:'删除设备',exact:true}).click();
    await page.locator('#deleteEntityConfirm').fill('错误名称');await page.locator('#deleteEntityForm button[type=submit]').click();assert.equal(writes.length,0);
    await page.locator('#deleteEntityConfirm').fill('南楼 201 白板');await page.locator('#deleteEntityForm button[type=submit]').click();
    await page.locator('[data-device-id=d1]').waitFor({state:'detached'});assert.equal(writes[0].method,'DELETE');
    assert.equal(await page.locator('#deviceSearch').evaluate(e=>e===document.activeElement),true);
  });
  test('logs use server pagination and filters, details close back to their trigger, invalid dates never request',async t=>{
    const {page,requests}=await setup(t);await settingsSection(page,'logs');await page.locator('#clientDiagnosticRows > li').first().waitFor();
    await moveBanbanAside(page);
    assert.equal(await page.locator('#clientDiagnosticRows > li').count(),20);await page.locator('#diagnosticNext').click();
    assert.match(await page.locator('#clientDiagnosticRows .log-time').first().textContent(),/2026-11-11/);
    await page.locator('#diagnosticPage').filter({hasText:'21-25'}).waitFor();assert.equal(await page.locator('#clientDiagnosticRows > li').count(),5);
    const detail=page.locator('#clientDiagnosticRows button').first();await detail.click();await page.locator('#diagnosticReport').filter({hasText:'Isolated diagnostic'}).waitFor();
    await page.locator('#closeLog').click();assert.equal(await detail.evaluate(e=>e===document.activeElement),true);
    await page.locator('.advanced-filters summary').click();await page.locator('#diagnosticSince').fill('2026-11-12');await page.locator('#diagnosticUntil').fill('2026-11-10');
    const count=requests.filter(r=>r.path==='/api/client-diagnostics').length;
    await page.locator('#clientDiagnosticFilters button[type=submit]').click();await page.locator('#clientDiagnosticStatus[role=alert]').waitFor();
    assert.equal(requests.filter(r=>r.path==='/api/client-diagnostics').length,count);
    await page.locator('#diagnosticReset').click();await page.locator('#diagnosticQuery').fill('林老师');await page.locator('#diagnosticEdition').selectOption('teacher');
    await page.locator('#clientDiagnosticFilters button[type=submit]').click();await page.locator('#clientDiagnosticStatus').filter({hasText:'共 12 条'}).waitFor();
    const query=new URLSearchParams(requests.filter(r=>r.path==='/api/client-diagnostics').at(-1).query);assert.equal(query.get('q'),'林老师');assert.equal(query.get('edition'),'teacher');
  });
  test('failed reads expose retry while keeping unavailable settings disabled',async t=>{
    let fail=true;
    const {page}=await setup(t,{handle:({url})=>fail&&url.pathname==='/api/banban/quotas'?{status:503,json:{error:'服务暂时不可用，请重试。'}}:undefined});
    await settingsSection(page,'quota');await page.locator('#quotaStatus[role=alert]').waitFor();assert.equal(await page.locator('#editDefault').isDisabled(),true);
    fail=false;await page.locator('#quotaReload').click();await page.locator('#quotaWorkspace:enabled').waitFor();assert.equal(await page.locator('#defaultValue').textContent(),'300');
  });
}

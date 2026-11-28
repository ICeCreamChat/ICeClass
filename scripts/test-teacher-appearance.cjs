'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {test,before,after}=require('node:test');
const {chromium}=require('playwright');
const {open,navigate,settingsSection,fixture}=require('./test-teacher-ui.cjs');
const {selfStudyFixture}=require('./measure-teacher-ui.cjs');
let browser;
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();});
async function setup(t,{width=1280,initial,blockStorage=false,native=false,hasTouch=false,withoutPopover=false,handle=selfStudyFixture}={}){
  const prepared={async newContext(options){
    const context=await browser.newContext({...options,hasTouch});
    if (withoutPopover) await context.addInitScript(() => {
      for (const key of ['popover', 'showPopover', 'hidePopover', 'togglePopover']) delete HTMLElement.prototype[key];
      const matches = Element.prototype.matches;
      Element.prototype.matches = function(selector) {
        if (selector.includes(':popover-open')) throw new DOMException('Unsupported :popover-open', 'SyntaxError');
        return matches.call(this, selector);
      };
    });
    if(native)await context.addInitScript(()=>{
      window.ICeClassTeacherHost={workbenchHeader:true,setWorkbenchHeader(visible){window.__nativeHeaderVisible=visible;},async execute(){return {success:true};}};
    });
    if(initial)await context.addInitScript(value=>localStorage.setItem('iceclass.teacher.appearance',JSON.stringify(value)),initial);
    if(blockStorage)await context.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('Storage unavailable','SecurityError');};});
    await context.addInitScript(()=>{
      window.__appearanceAtBody=null;window.__mapCount=0;
      const observer=new MutationObserver(()=>{
        if(!document.body)return;
        window.__appearanceAtBody=document.documentElement.dataset.teacherMaterial;observer.disconnect();
      });observer.observe(document,{subtree:true,childList:true});
      const original=HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL=function(...args){window.__mapCount++;return original.apply(this,args);};
    });
    return context;
  }};
  const result=await open(prepared,{width,handle});
  t.after(async()=>{await result.context.close();assert.deepEqual(result.errors,[]);});
  return result;
}
const filters=page=>page.locator('.classroom-filter-definitions filter').count();
async function waitForFilterCount(page,count){await page.waitForFunction(n=>document.querySelectorAll('.classroom-filter-definitions filter').length===n,count);}
async function assertStaticMaterial(page){
  assert.equal(await filters(page),0,'No SVG displacement filters');
  assert.equal(await page.evaluate(()=>window.__mapCount),0,'No canvas material maps');
  const active=await page.evaluate(()=>[...document.querySelectorAll('*')].flatMap(element=>{
    if(!element.getClientRects().length)return [];
    return [null,'::before','::after',...(element.matches('dialog[open]')?['::backdrop']:[])].flatMap(pseudo=>{
      const style=getComputedStyle(element,pseudo);
      if(pseudo&&style.content==='none'&&pseudo!=='::backdrop')return [];
      return style.display!=='none'&&style.backdropFilter!=='none'?[element.tagName+'.'+element.className+':'+pseudo+'='+style.backdropFilter]:[];
    });
  }));
  assert.deepEqual(active,[],'Visible surfaces and pseudo layers have no backdrop processing');
}

for(const material of ['glass','white'])test(`Rendered role groups and connection times stay aligned in ${material}`,async t=>{
  const handle=({url})=>{
    if(url.pathname==='/api/teachers'){
      const teacher=fixture(url).teachers[0];
      return {json:{teachers:[teacher,{...teacher,id:'staff-2',role:'principal',display_name:'王校长',teachingClasses:[]}]}};
    }
    if(url.pathname==='/api/devices')return {json:{devices:[0,1794226200000].map((last_seen_at,i)=>({
      id:'device-'+i,class_id:'c1',class_name:'高一（1）班',name:'教室白板',computer_name:'CLASSROOM-'+i,
      device_code:'MOCK-'+i,local_addresses:['192.0.2.10'],enabled:1,online:!!i,verified_at:0,class_device_count:2,last_seen_at
    }))}};
    return selfStudyFixture({url});
  };
  const {page,requests}=await setup(t,{native:true,initial:{version:1,material,reduceTransparency:false},handle});
  for(const width of [1707,1280,1024,880,390]){
    await page.setViewportSize({width,height:850});
    await navigate(page,'teachers');await page.locator('.user-role-badge').first().waitFor();
    const roles=await page.locator('.users-table').evaluate(table=>{
      const center=e=>{const b=e.getBoundingClientRect();return (b.left+b.right)/2;};
      const range=document.createRange();range.selectNodeContents(table.tHead.rows[0].cells[1]);
      const header=range.getBoundingClientRect();
      return [...table.tBodies[0].rows].map(row=>{
        const cell=row.cells[1],box=cell.getBoundingClientRect();
        const badges=[...cell.querySelectorAll('.user-role-badge')].map(e=>e.getBoundingClientRect());
        const left=Math.min(...badges.map(b=>b.left)),right=Math.max(...badges.map(b=>b.right));
        const actionCell=row.cells[4].getBoundingClientRect();
        const actions=[...row.cells[4].querySelectorAll('button')].map(e=>e.getBoundingClientRect());
        return {count:badges.length,headerOffset:Math.abs((header.left+header.right)/2-center(cell)),
          contentOffset:Math.abs((left+right)/2-center(cell)),fits:left>=box.left&&right<=box.right,
          actionsFit:actions.every(b=>b.left>=actionCell.left&&b.right<=actionCell.right)};
      });
    });
    assert.deepEqual(roles.map(r=>r.count).sort(),[1,2],'Both single and multiple role groups are rendered');
    assert.ok(roles.every(r=>r.headerOffset<=1.5&&r.contentOffset<=1.5&&r.fits),`${width}px: actual role badges share the header center`);
    assert.ok(roles.every(r=>r.actionsFit),`${width}px: user action buttons remain inside their cells`);
    await settingsSection(page,'devices');await page.locator('.device-seen').first().waitFor();
    const connections=await page.locator('#devicesContainer .device-seen').evaluateAll(cells=>cells.map(cell=>{
      const value=cell.querySelector('.device-seen-value');
      const range=document.createRange();range.selectNodeContents(value);
      const text=range.getBoundingClientRect(),box=cell.getBoundingClientRect();
      return {text:value.textContent,lines:range.getClientRects().length,fits:text.left>=box.left-1&&text.right<=box.right+1};
    }));
    assert.equal(connections[0].text,'从未连接');assert.match(connections[1].text,/\d{2}:\d{2}/);
    assert.ok(connections.every(c=>c.lines===1&&c.fits),`${width}px: connection labels remain on one line inside their cells`);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Only the table region may scroll horizontally');
  }
  assert.equal(requests.every(r=>['GET','HEAD'].includes(r.method)),true);
});

test('Static glass preserves translucent surfaces and aligned controls without optical processing',async t=>{
  const {page}=await setup(t);await assertStaticMaterial(page);
  assert.equal(await page.locator('.reading-filter,.reading-panel,.metric,.btn').evaluateAll(nodes=>nodes.some(e=>e.classList.contains('lg-pane'))),false);
  const materials=await page.locator('.reading-filter,.reading-panel,.metric').evaluateAll(nodes=>nodes.map(e=>{
    const s=getComputedStyle(e);return {color:s.backgroundColor,image:s.backgroundImage,filter:s.backdropFilter};
  }));
  for(const material of materials){
    const alpha=Number(material.color.match(/, ([\d.]+)\)$/)?.[1]);
    assert.ok(alpha>=.25&&alpha<=.65,'Wallpaper remains visible through the content surface');
    assert.notEqual(material.image,'none','Subtle surface highlight');
    assert.equal(material.filter,'none','Static tint needs no backdrop blur');
  }
  const nested=await page.locator('.reading-panel .table-wrap').first().evaluate(e=>({color:getComputedStyle(e).backgroundColor,filter:getComputedStyle(e).backdropFilter}));
  assert.deepEqual(nested,{color:'rgba(0, 0, 0, 0)',filter:'none'},'A nested table never adds a second glass plane');
  const input=await page.locator('#readingStart').evaluate(e=>getComputedStyle(e).backgroundColor);
  assert.ok(Number(input.match(/, ([\d.]+)\)$/)?.[1])>=.8,'Fields have a denser reading surface');
  const bottoms=await page.locator('#readingStart,#readingEnd,#readingClass,.period-shortcuts,#readingRefresh').evaluateAll(nodes=>nodes.map(e=>e.getBoundingClientRect().bottom));
  assert.ok(Math.max(...bottoms)-Math.min(...bottoms)<=1,'Filter inputs, shortcut group and query align');
  await navigate(page,'self-study');
  await page.locator('.ss-runtime').waitFor();
  assert.match(await page.locator('.ss-runtime').evaluate(e=>getComputedStyle(e).backgroundColor),/^rgba\(/);
  assert.equal(await page.locator('.ss-runtime').evaluate(e=>getComputedStyle(e).padding),'24px');
  await assertStaticMaterial(page);
});

test('White appearance is keyboard operable and persists with zero optical work before first body paint',async t=>{
  const {page}=await setup(t);await settingsSection(page,'appearance');
  await page.getByRole('radio',{name:'液态玻璃',exact:true}).focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('radio',{name:'原版白色',exact:true}).isChecked(),true);
  await waitForFilterCount(page,0);
  assert.equal(await page.locator('#teacherReduceTransparency').isDisabled(),true);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('iceclass.teacher.appearance'))),{version:1,material:'white',reduceTransparency:false});
  await page.reload();await page.locator('#appShell:not(.hidden)').waitFor();
  assert.equal(await page.evaluate(()=>window.__appearanceAtBody),'white');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.__mapCount),0);
  assert.equal(await filters(page),0);
  assert.equal(await page.locator('body').evaluate(e=>getComputedStyle(e).backgroundImage),'none');
  assert.equal(await page.locator('.topbar').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
  for(const selector of ['.reading-filter','.reading-panel','.metric']){
    const surface=await page.locator(selector).first().evaluate(e=>({color:getComputedStyle(e).backgroundColor,filter:getComputedStyle(e).backdropFilter}));
    assert.deepEqual(surface,{color:'rgb(255, 255, 255)',filter:'none'},'White appearance stays opaque without blur');
  }
});

test('Transparency and accessibility preferences remain usable without allocating optical resources',async t=>{
  const {page,context}=await setup(t);await assertStaticMaterial(page);
  await settingsSection(page,'appearance');await page.locator('#teacherReduceTransparency').check();await waitForFilterCount(page,0);
  assert.equal(await page.locator('#settingsContent').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(237, 245, 252)');
  assert.equal(await page.locator('#teacherAppearance').evaluate(e=>getComputedStyle(e).backdropFilter),'none');
  await page.locator('#teacherReduceTransparency').uncheck();await assertStaticMaterial(page);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  await waitForFilterCount(page,0);
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await assertStaticMaterial(page);
  const cdp=await context.newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});await waitForFilterCount(page,0);
  assert.equal(await page.locator('#settingsContent').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(237, 245, 252)');
  assert.equal(await page.locator('#teacherAppearance').evaluate(e=>getComputedStyle(e).backdropFilter),'none');
  await cdp.send('Emulation.setEmulatedMedia',{features:[]});await assertStaticMaterial(page);
  await page.emulateMedia({forcedColors:'active'});await waitForFilterCount(page,0);
  await page.emulateMedia({forcedColors:'none'});await assertStaticMaterial(page);
});

test('A storage failure keeps the chosen appearance and gives an honest local feedback',async t=>{
  const {page}=await setup(t,{blockStorage:true});await settingsSection(page,'appearance');
  await page.getByRole('radio',{name:'原版白色',exact:true}).check();await waitForFilterCount(page,0);
  assert.match(await page.locator('#teacherAppearanceStatus').textContent(),/暂时无法保存/);
  assert.equal(await page.getByRole('radio',{name:'原版白色',exact:true}).isChecked(),true);
});

test('Appearance changes synchronize between open teacher tabs',async t=>{
  const {page,context}=await setup(t);const second=await context.newPage();await second.goto('http://127.0.0.1/');await second.locator('#appShell:not(.hidden)').waitFor();
  await settingsSection(page,'appearance');await page.getByRole('radio',{name:'原版白色',exact:true}).check();
  await second.waitForFunction(()=>document.documentElement.dataset.teacherMaterial==='white');await waitForFilterCount(second,0);
});

async function assertHeaderMenus(page, openId) {
  for (const [triggerId, menuId] of [['headerAccount', 'headerAccountMenu'], ['headerToolsToggle', 'headerToolsMenu']]) {
    const trigger = page.locator('#' + triggerId), menu = page.locator('#' + menuId);
    const open = menuId === openId;
    assert.equal(await trigger.getAttribute('aria-controls'), menuId);
    assert.equal(await trigger.getAttribute('aria-expanded'), String(open));
    assert.equal(await menu.isVisible(), open, menuId + ' visibility');
    assert.equal(await menu.evaluate(element => element.hidden), !open, menuId + ' HTML hidden state');
  }
}
const focused = locator => locator.evaluate(element => element === document.activeElement);

test('Website header menus on the paper-card page support keyboard dismissal and navigation', async t => {
  const {page} = await setup(t);
  await navigate(page, 'card-quiz');
  const account = page.locator('#headerAccount'), tools = page.locator('#headerToolsToggle');
  const settings = page.getByRole('menuitem', {name:'账号设置'}), password = page.getByRole('menuitem', {name:'修改密码'});
  const logout = page.locator('#logoutButton');
  await assertHeaderMenus(page);
  await account.press('ArrowUp');
  assert.ok(await focused(logout));
  await page.keyboard.press('Home');
  assert.ok(await focused(settings));
  await page.keyboard.press('ArrowDown');
  assert.ok(await focused(password));
  await page.keyboard.press('End');
  assert.ok(await focused(logout));
  await page.keyboard.press('Escape');
  assert.ok(await focused(account));
  await assertHeaderMenus(page);

  await account.press('Enter');
  assert.ok(await focused(settings));
  await page.keyboard.press('Shift+Tab');
  assert.ok(await focused(tools));
  await tools.press('Space');
  assert.ok(await focused(page.getByRole('menuitem', {name:'刷新页面'})));
  await page.keyboard.press('Tab');
  assert.ok(await focused(account));
  await assertHeaderMenus(page);

  await account.press('ArrowDown');
  await account.press('Escape');
  await assertHeaderMenus(page);
  await account.click();
  const paperCards = page.locator('#mainNav [data-view="card-quiz"]');
  await paperCards.focus();
  await assertHeaderMenus(page);
  assert.ok(await focused(paperCards));
  await account.click();
  await assertHeaderMenus(page, 'headerAccountMenu');
  const anchor = await account.boundingBox(), menu = await page.locator('#headerAccountMenu').boundingBox();
  assert.ok(Math.abs(anchor.x + anchor.width - menu.x - menu.width) <= 1, 'Menu aligns with the account button beside the scrollbar');
  await page.evaluate(() => window.ICeClass.selectView(document.querySelector('#mainNav [data-view="reading"]')));
  await page.locator('#view-reading').waitFor();
  await assertHeaderMenus(page);
});

for (const withoutPopover of [false, true]) test(`Website header touch menus switch and navigate ${withoutPopover ? 'without' : 'with'} the Popover API`, async t => {
  const {page} = await setup(t, {width:320, hasTouch:true, withoutPopover});
  await navigate(page, 'card-quiz');
  const account = page.locator('#headerAccount'), tools = page.locator('#headerToolsToggle');
  await assertHeaderMenus(page);
  await account.tap();
  await assertHeaderMenus(page, 'headerAccountMenu');
  await account.tap();
  await assertHeaderMenus(page);
  await account.tap();
  await tools.tap();
  await assertHeaderMenus(page, 'headerToolsMenu');
  const box = await page.locator('#headerToolsMenu').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 320, 'All tool menu items fit inside the viewport');
  await account.tap();
  await assertHeaderMenus(page, 'headerAccountMenu');
  await page.locator('.header-brand strong').tap();
  await assertHeaderMenus(page);
  await account.tap();
  await page.locator('#menuToggle').tap();
  await assertHeaderMenus(page);
  await page.locator('#sidebarClose').tap();
  await account.tap();
  await page.getByRole('menuitem', {name:'修改密码'}).tap();
  await page.locator('#settingsAccountSection').waitFor();
  await assertHeaderMenus(page);
  assert.ok(await focused(page.locator('#currentPassword')));
  await tools.tap();
  await page.setViewportSize({width:1440, height:850});
  await page.locator('#headerToolsMenu').waitFor({state:'hidden'});
  await assertHeaderMenus(page);
  assert.ok(await focused(page.locator('#teacherRefresh')));
});

for(const width of [1440,1361,1360,1024,881,880,390,320])test(`Native workbench header fits and its menu returns focus at ${width}px`,async t=>{
  const {page}=await setup(t,{width,native:true,handle:({url,request})=>{
    if(url.pathname==='/api/session')return {json:{authenticated:true,user:{...fixture(url).user,displayName:'很长的测试教师账号'.repeat(10)}}};
    return selfStudyFixture({url,request});
  }});
  assert.equal(await page.evaluate(()=>window.__nativeHeaderVisible),true);
  const boxes=await page.locator('.header-brand,.header-location,.header-actions').evaluateAll(nodes=>nodes.map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};}));
  assert.ok(boxes.every(r=>r.left>=0&&r.right<=width), 'Native controls remain in the viewport');
  if(width>880)assert.ok(boxes[0].right<=boxes[1].left&&boxes[1].right<=boxes[2].left,'Desktop header columns never overlap');
  else assert.ok(boxes[1].top>=Math.max(boxes[0].bottom,boxes[2].bottom),'The location has its own row at narrow widths');
  const header=await page.locator('.topbar').boundingBox();
  assert.ok(Math.abs((boxes[1].left+boxes[1].right)/2-(header.x+header.width/2))<=1,'The location is centered within the header, including with a long account name');
  const toggle=page.locator('#headerToolsToggle');await toggle.click();
  await page.locator('#headerToolsMenu:popover-open').waitFor();
  await assertStaticMaterial(page);
  assert.equal(await page.getByRole('menuitem',{name:'关于班伴',exact:true}).isVisible(),true);
  await page.keyboard.press('Escape');assert.equal(await toggle.evaluate(e=>e===document.activeElement),true);
});

for(const width of [1440,881,880,390])for(const material of ['glass','white'])test(`All teacher views keep aligned titles and fit at ${width}px in ${material}`,async t=>{
  const {page}=await setup(t,{width,initial:{version:1,material,reduceTransparency:false}});
  const lefts=[];
  for(const view of ['reading','homework','card-quiz','ideas','island','console','controls','self-study','history','classroom-voice','quiet','classes','teachers','settings']){
    await navigate(page,view);
    const heading=page.locator(`#view-${view} h1`).first();await heading.waitFor();
    const metrics=await heading.evaluate(e=>({left:e.getBoundingClientRect().left,size:getComputedStyle(e).fontSize}));
    lefts.push(metrics.left);
    assert.equal(metrics.size,width<=760?'26px':'28px',view+' heading scale');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),view+' fits');
    await assertStaticMaterial(page);
    if(view==='card-quiz'){
      await page.locator('.cq-panel').first().waitFor();
      const panel=await page.locator('.cq-panel').first().evaluate(e=>{const s=getComputedStyle(e);return {padding:s.padding,border:s.borderTopStyle};});
      assert.ok(parseFloat(panel.padding)>0&&panel.border==='solid','Paper-card panels use the shared workbench surfaces');
    }
    if(view==='settings'){
      const descriptions=['账号与安全','工作台外观','班班次数','教室电脑','应用致谢','客户端日志'];
      for(const [i,section] of ['account','appearance','quota','devices','thanks','logs'].entries()){
        await settingsSection(page,section);
        await page.getByRole('heading',{name:descriptions[i],exact:true}).filter({visible:true}).waitFor();
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Settings '+section+' fits');
      }
    }
    if(view==='teachers'&&width===390){
      assert.deepEqual(await page.locator('#userGradeFilter,#userStatusFilter').evaluateAll(nodes=>nodes.map(e=>Math.round(e.getBoundingClientRect().height))),[44,44],'Narrow filter labels never add a second line');
    }
    if(view==='classes'&&width===390){
      const region=page.getByRole('region',{name:'班级列表，可左右滚动'});
      await region.focus();assert.equal(await region.evaluate(e=>e===document.activeElement&&e.scrollWidth>e.clientWidth),true);
    }
    if(process.env.ICECLASS_REVIEW_DIR){
      fs.mkdirSync(process.env.ICECLASS_REVIEW_DIR,{recursive:true});
      await page.evaluate(()=>{window.scrollTo(0,0);document.activeElement?.blur();});
      await page.screenshot({path:path.join(process.env.ICECLASS_REVIEW_DIR,`teacher-${view}-${width}-${material}.png`)});
    }
  }
  assert.ok(Math.max(...lefts)-Math.min(...lefts)<=1,'Every page shares the same title baseline: '+lefts.join(','));
});

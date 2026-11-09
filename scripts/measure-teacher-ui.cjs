'use strict';

// Repeatable local rendering measurements, with the same isolated API fixtures
// as the UI checks. These are lab measurements, not field Core Web Vitals.
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const {open,navigate} = require('./test-teacher-ui.cjs');

function selfStudyFixture({url}) {
  if(url.pathname==='/api/self-study/classes')return {json:{classes:[{id:'c1',name:'高一（1）班'}]}};
  if(/^\/api\/self-study\/classes\//.test(url.pathname))return {json:{revision:1,config:{enabled:false,authorized:false,aiEnabled:false,photoEnabled:false,dailyCalls:4,dailyTokens:2400,sensitivity:'balanced',voiceTriggerMs:600,observationSeconds:10,reminderWaitSeconds:90,confirmationsAfterReminder:1},schedule:[],usage:{calls:0,tokens:0},aiReady:true,status:null,serverTime:1794226200000}};
  if(url.pathname==='/api/self-study/events')return {json:{events:[],pending:0,serverTime:1794226200000}};
}
module.exports={selfStudyFixture};

async function measure() {
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const sessions=new WeakMap(), runs=[];
  const instrumented={async newContext(options){
    const context=await browser.newContext(options);
    await context.addInitScript(()=>{
      window.__renderLab={maps:0,mapMs:0,pixels:0,longTasks:[],shifts:0};
      const original=HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL=function(...args){
        const start=performance.now(),result=original.apply(this,args);
        window.__renderLab.maps++;window.__renderLab.mapMs+=performance.now()-start;
        window.__renderLab.pixels+=this.width*this.height;return result;
      };
      new PerformanceObserver(list=>{for(const e of list.getEntries())window.__renderLab.longTasks.push(e.duration);}).observe({type:'longtask',buffered:true});
      new PerformanceObserver(list=>{for(const e of list.getEntries())if(!e.hadRecentInput)window.__renderLab.shifts+=e.value;}).observe({type:'layout-shift',buffered:true});
    });
    const create=context.newPage.bind(context);
    context.newPage=async()=>{const page=await create(),cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');sessions.set(page,cdp);return page;};
    return context;
  }};
  try {
    for(let run=0;run<3;run++){
      const started=performance.now();
      const {page,context,errors}=await open(instrumented,{handle:selfStudyFixture});
      async function sample(view,elapsed){
        await page.waitForTimeout(250);
        const metrics=Object.fromEntries((await sessions.get(page).send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));
        const dom=await page.evaluate(()=>({
          ...window.__renderLab,filters:document.querySelectorAll('.classroom-filter-definitions filter').length,
          hosts:document.querySelectorAll('.lg-pane').length,nodes:document.querySelectorAll('*').length,
          paints:performance.getEntriesByType('paint').map(x=>({name:x.name,ms:x.startTime})),
          resources:performance.getEntriesByType('resource').length,
          opticalBytes:[...document.querySelectorAll('.classroom-filter-definitions feImage')].reduce((n,e)=>n+(e.getAttribute('href')?.length||0),0)
        }));
        runs.push({run:run+1,view,elapsedMs:Math.round(elapsed),taskMs:metrics.TaskDuration*1000,scriptMs:metrics.ScriptDuration*1000,layoutMs:metrics.LayoutDuration*1000,styleMs:metrics.RecalcStyleDuration*1000,heapBytes:metrics.JSHeapUsedSize,...dom});
      }
      await sample('startup-reading',performance.now()-started);
      for(const view of ['island','self-study','teachers','settings']){
        const before=performance.now();await navigate(page,view);
        if(view==='self-study')await page.locator('#ss-class').waitFor();
        await sample(view,performance.now()-before);
      }
      if(errors.length)throw new Error(errors.join('\n'));
      await context.close();
    }
    const result={at:new Date().toISOString(),browser:await browser.version(),viewport:{width:1280,height:850},isolation:'fixture APIs; no live service; default CPU; reduced motion',runs};
    const output=path.resolve(process.argv[2]||'.tools/teacher-ui-review/performance.json');
    fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2));
    console.log(JSON.stringify({output,runs:runs.map(({run,view,taskMs,filters,maps,pixels,opticalBytes})=>({run,view,taskMs:Math.round(taskMs),filters,maps,pixels,opticalBytes}))},null,2));
  } finally {await browser.close();}
}
if(require.main===module)measure().catch(error=>{console.error(error);process.exitCode=1;});

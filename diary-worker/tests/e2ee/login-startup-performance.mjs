// Optional local comparison: synthetic passkey, real local Security/Diary APIs,
// Pixel 7 emulation, CPU x4, fixed 80 ms response delay; no production traffic.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {chromium,devices} from 'playwright';
import {loginStartupFixture} from './login-startup-fixture.mjs';

const root=resolve(import.meta.dirname,'../../..'),at=process.argv.indexOf('--baseline'),baseline=process.argv[at+1];
if(at<0||!/^[a-f0-9]{7,40}$/.test(baseline||''))throw new Error('Usage: --baseline <commit SHA>');
const changed=execFileSync('git',['diff','--name-only',baseline,'--','diary-worker/public'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
const previous=new Map(changed.map(path=>[path.slice('diary-worker/public/'.length),execFileSync('git',['show',`${baseline}:${path}`],{cwd:root})]));
const browser=await chromium.launch({headless:true});
try {
  for(const account of ['main-user','main-admin'])for(const fast of [false,true]) {
    const f=await loginStartupFixture({account,latency:80,sources:fast?new Map():previous}),cold=[],warm=[];
    try {
      for(let i=0;i<3;i++) {
        const context=await browser.newContext(devices['Pixel 7']);await f.configure(context);
        const page=await context.newPage(),cdp=await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
        try {
          await page.goto(f.origin+'/diary/');await page.click('#passkey-login');
          for(const [kind,samples] of [['cold',cold],['warm',warm]]) {
            if(kind==='warm'){
              await page.click('#logout-button');await page.locator('#passkey-login').waitFor({state:'visible'});
              await page.evaluate(()=>{window.loginMetrics={vaultDecrypts:0,requests:[]};});
              await page.click('#passkey-login');
            }
            await page.waitForFunction(()=>window.loginMetrics.firstEntry>window.loginMetrics.handoff);
            const result=await page.evaluate(()=>({milliseconds:Math.round(window.loginMetrics.firstEntry-window.loginMetrics.handoff),vaultDecrypts:window.loginMetrics.vaultDecrypts,sessionChecks:window.loginMetrics.requests.slice(window.loginMetrics.requests.indexOf('/diary/api/passkey/handoff')+1).filter(path=>path==='/diary/api/session').length}));
            assert.equal(result.vaultDecrypts,fast?1:2);assert.equal(result.sessionChecks,4);samples.push(result.milliseconds);
          }
        }finally{await context.close();}
      }
      const median=values=>[...values].sort((a,b)=>a-b)[1];
      console.log(JSON.stringify({account,fast,samples:3,cpuThrottle:4,responseDelayMs:80,coldMedianMs:median(cold),reloginMedianMs:median(warm),vaultDecrypts:fast?1:2,sessionChecks:4,excluded:'real WebAuthn/user interaction, physical Android, production network'}));
    }finally{await f.close();}
  }
}finally{await browser.close();}

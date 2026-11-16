import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {systemFixture} from './system-fixture.mjs';

const f=await systemFixture({phase:'legacy'}),user=f.users['main-user'];
f.central.sqlite.exec('DELETE FROM security_diary_key_grants; DELETE FROM security_diary_key_vaults; DELETE FROM security_diary_key_config;');
const root=resolve(fileURLToPath(new URL('../../public/',import.meta.url))),wire=[],errors=[];
let origin,lose=true;
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/diary/api/')) {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=Buffer.concat(chunks);wire.push({path:url.pathname,method:req.method,body:body.toString()});
      const response=await f.worker.fetch(new Request(url,{method:req.method,headers:req.headers,...(body.length?{body}:{} )}),f.env,f.ctx);
      if(req.method==='POST'&&url.pathname==='/diary/api/encryption/prepare'&&lose){lose=false;res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"SyntheticResponseLoss"}');return;}
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    if(['/security/passkey-client.js','/assets/pwa-auto-update.js'].includes(url.pathname)){res.setHeader('Content-Type','text/javascript');res.end('/* Isolated synthetic authentication and no production updates. */');return;}
    const file=resolve(root,url.pathname==='/diary/'?'index.html':url.pathname.slice('/diary/'.length));
    if(!url.pathname.startsWith('/diary/')||!file.startsWith(root.replace(/\/$/,'')+sep)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',['.js','.mjs'].includes(extname(file))?'text/javascript':extname(file)==='.html'?'text/html':extname(file)==='.css'?'text/css':'application/octet-stream');res.end(await readFile(file));
  }catch{res.writeHead(500);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;f.env.DIARY_ENCRYPTION_ORIGIN=origin;
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(({prf,credentialId})=>{window.TRoomPasskeys={authenticate:async()=>{window.lastPRF=new Uint8Array(prf);return {credentialId,prfOutput:window.lastPRF,link:{accountId:'main-user'},handoff:{handoffToken:'main-user'}};}};},{prf:[...user.prf],credentialId:user.credentialId});
  await page.goto(origin+'/diary/');await page.locator('#passkey-login').waitFor({state:'visible'});await page.click('#passkey-login');
  await page.locator('#app-view').waitFor({state:'visible'});await page.waitForFunction(()=>window.lastPRF.every(value=>value===0));
  const vault=f.central.sqlite.prepare('SELECT vault_json FROM security_diary_key_vaults WHERE recipient_id=?').get(user.recipientId).vault_json;
  await page.click('#logout-button');await page.locator('#passkey-login').waitFor({state:'visible'});await page.click('#passkey-login');
  await page.locator('#app-view').waitFor({state:'visible'});await page.waitForFunction(()=>window.lastPRF.every(value=>value===0));
  assert.equal(f.central.sqlite.prepare('SELECT vault_json FROM security_diary_key_vaults WHERE recipient_id=?').get(user.recipientId).vault_json,vault);
  assert.equal(wire.filter(row=>row.path.endsWith('/encryption/prepare')&&row.method==='POST').length,1);
  assert.equal(f.central.sqlite.prepare('SELECT COUNT(*) count FROM security_diary_key_grants').get().count,0);
  assert.equal(wire.some(row=>row.path.startsWith('/security/')),false);assert.equal(JSON.stringify(wire).includes(Buffer.from(user.prf).toString('base64url')),false);
  f.db.sqlite.exec("UPDATE diary_e2ee_control SET phase='encrypted',ever_encrypted=1,generation=1");
  await page.reload();await page.locator('#passkey-login').waitFor({state:'visible'});
  assert.equal(await page.locator('input[type="file"]').filter({visible:true}).count(),0);
  assert.deepEqual(errors,[]);
  console.log('Diary normal login: automatic own-vault preparation, response-loss retry, PRF clearing and no Security Center navigation passed (synthetic authentication).');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await f.close();}

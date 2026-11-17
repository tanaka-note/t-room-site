import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {systemFixture} from './system-fixture.mjs';
import {publicTrustPackage} from '../../e2ee/setup.mjs';
import {EncryptedDiaryClient} from '../../e2ee/client.mjs';
import {readSnapshotPages} from '../../e2ee/snapshot.mjs';
import {prepareDiaryKeys} from '../../public/diary-key-preparation.js';
import {entry} from './fixture.mjs';

// Local synthetic Identity/Security/Diary APIs and real public app modules.
// Optional delay models one response latency, not a real mobile connection.
export async function loginStartupFixture({account='main-user',latency=0,sources=new Map()}={}) {
  const f=await systemFixture(),user=f.users[account],trust=await publicTrustPackage(f.configuration);
  const root=resolve(import.meta.dirname,'../../public'),wire=[];let origin;
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,origin);
      if(latency)await new Promise(resolve=>setTimeout(resolve,latency));
      if(url.pathname.startsWith('/diary/api/')) {
        const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
        wire.push({path:url.pathname,method:req.method});
        const response=await f.worker.fetch(new Request(url,{method:req.method,headers:req.headers,...(body.length?{body}:{})}),f.env,f.ctx);
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
      }
      if(['/security/passkey-client.js','/assets/pwa-auto-update.js'].includes(url.pathname)){res.setHeader('Content-Type','text/javascript');res.end('/* Local fixture; no production calls. */');return;}
      const path=url.pathname==='/diary/'?'index.html':url.pathname.slice('/diary/'.length),file=resolve(root,path);
      if(!url.pathname.startsWith('/diary/')||!file.startsWith(root+sep)){res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type',['.js','.mjs'].includes(extname(file))?'text/javascript':extname(file)==='.html'?'text/html':extname(file)==='.css'?'text/css':'application/octet-stream');
      res.end(sources.get(path)??await readFile(file));
    }catch{res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;f.env.DIARY_ENCRYPTION_ORIGIN=origin;
  const api=async(path,options={})=>{
    const method=options.method||'GET';
    const response=await f.worker.fetch(new Request(origin+'/diary/api'+path,{method,headers:{Cookie:f.cookie(account),...(method==='POST'?{Origin:origin,'Content-Type':'application/json','X-Diary-Request':'1'}:{})},...(options.body?{body:JSON.stringify(options.body)}:{})}),f.env,f.ctx);
    const value=await response.json();assert.equal(response.status,200,`Synthetic ${path}`);return value;
  };
  // Model a configured account consistently across cold browser contexts.
  const authentication={credentialId:user.credentialId,prfOutput:new Uint8Array(user.prf),handoff:{diaryTrust:trust}};
  await prepareDiaryKeys(api,await api('/session'),authentication);
  authentication.prfOutput.fill(0);authentication.diaryPreparedKeys=null;authentication.diaryPrivateKeys=null;
  const initial=await api('/encryption/profile');
  const writer=new EncryptedDiaryClient({profile:initial.profile,anchor:trust.anchor,documentFormat:2,transport:{valid:async()=>true,snapshot:(h,since)=>readSnapshotPages(options=>api('/encryption/snapshot?'+new URLSearchParams(Object.entries(options).filter(([,v])=>v!==null))),h,since),mutation:(proposal,operation)=>api('/encryption/mutation',{method:'POST',body:{proposal,operation}})}});
  await writer.unlock(new Uint8Array(user.prf));await writer.commit(entry({entryDate:new Date().toISOString().slice(0,10),title:'LOGIN_PIPELINE_FIRST',content:'Synthetic login body',photos:[]}),{id:'1'},{refresh:false});writer.lock();
  return {origin,user,wire,
    async configure(context) {
      await context.addInitScript(({prf,credentialId,trust,account,iv})=>{
        window.loginMetrics={vaultDecrypts:0,requests:[]};
        window.TRoomPasskeys={authenticate:async()=>{
          const auth={credentialId,prfOutput:new Uint8Array(prf),verified:{diaryTrust:trust},link:{accountId:account},handoff:{handoffToken:account,diaryTrust:trust}};
          window.loginAuthentication=auth;return auth;
        }};
        const native=fetch.bind(window);window.fetch=async(...args)=>{
          const path=new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href).pathname;
          window.loginMetrics.requests.push(path);
          const response=await native(...args);
          if(path==='/diary/api/passkey/handoff')window.loginMetrics.handoff=performance.now();
          return response;
        };
        const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);
        crypto.subtle.decrypt=async(algorithm,...args)=>{
          if(algorithm.iv&&btoa(String.fromCharCode(...new Uint8Array(algorithm.iv))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')===iv)window.loginMetrics.vaultDecrypts++;
          return decrypt(algorithm,...args);
        };
        const observer=new MutationObserver(()=>{
          if(window.loginMetrics.firstEntry||!document.querySelector('#entry-list .diary-entry-card'))return;
          window.loginMetrics.firstEntry=performance.now();
        });observer.observe(document,{childList:true,subtree:true});
      },{prf:[...user.prf],credentialId:user.credentialId,trust,account,iv:user.vault.privateEnvelope.iv});
    },
    async close(){await new Promise(resolve=>server.close(resolve));await f.close();}
  };
}

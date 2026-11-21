import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright';
import {systemFixture} from './system-fixture.mjs';
import {publicTrustPackage} from '../../e2ee/setup.mjs';
import {EncryptedDiaryClient} from '../../e2ee/client.mjs';
import {createStore} from '../../e2ee/store.mjs';
import {readSnapshotPages} from '../../e2ee/snapshot.mjs';
import {encryptPhotoParts,PHOTO_PREFIX} from '../../e2ee/photo-crypto.mjs';

const kinds=['original','display','thumbnail'];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const root=resolve(import.meta.dirname,'../../public');

export async function startDiaryPhotoFixture({indexed=false,background=false,responseDelay=false}={}) {
  const f=await systemFixture(),user=f.users['main-admin'];
  const trust=await publicTrustPackage(f.configuration),errors=[],mediaRequests=[],db=f.db.sqlite;
  let origin,browser;
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,origin);
      if(url.pathname.startsWith('/diary/api/')) {
        const chunks=[]; for await(const chunk of req)chunks.push(chunk);
        const body=Buffer.concat(chunks),media=url.pathname.startsWith('/diary/api/photos/');
        const response=await f.worker.fetch(new Request(url,{method:req.method,headers:req.headers,...(body.length?{body}:{})}),f.env,f.ctx);
        if(media) {
          mediaRequests.push({path:url.pathname,status:response.status});
          // Fixed simulated delay for authenticated requests and a body transfer.
          if(responseDelay)await pause(response.status===200?65:35);
        }
        if(res.destroyed)return;
        const headers=Object.fromEntries(response.headers);
        if(response.headers.getSetCookie().length)headers['set-cookie']=response.headers.getSetCookie();
        res.writeHead(response.status,headers);res.end(Buffer.from(await response.arrayBuffer()));return;
      }
      if(url.pathname.startsWith('/security/')||url.pathname==='/assets/pwa-auto-update.js') {
        res.setHeader('Content-Type','text/javascript');res.end('');return;
      }
      const path=resolve(root,url.pathname==='/diary/'?'index.html':url.pathname.slice('/diary/'.length));
      if(!path.startsWith(root+sep)){res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type',['.mjs','.js'].includes(extname(path))?'text/javascript':extname(path)==='.html'?'text/html':extname(path)==='.css'?'text/css':'application/octet-stream');
      res.end(await readFile(path));
    }catch(error){errors.push(error.message);if(!res.headersSent)res.writeHead(500);res.end();}
  });
  const close=async()=>{await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));await f.close();};
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    origin=`http://127.0.0.1:${server.address().port}`;
    f.env.DIARY_ENCRYPTION_ORIGIN=origin;
    if(indexed) {
      db.exec(await readFile(new URL('../../e2ee/photo-reference-index.sql',import.meta.url),'utf8'));
      f.env.DIARY_PHOTO_ENCRYPTED_READS_ONLY='true';
    }
    const call=async path=>{
      const response=await f.worker.fetch(new Request(origin+'/diary/api/encryption'+path,{headers:{Cookie:f.cookie()}}),f.env,f.ctx);
      assert.equal(response.status,200);return response.json();
    };
    const {profile}=await call('/profile');
    const writer=new EncryptedDiaryClient({profile,anchor:trust.anchor,transport:{valid:async()=>true,timestamp:async()=>new Date().toISOString(),
      snapshot:(h,s)=>readSnapshotPages(o=>call('/snapshot?'+new URLSearchParams(Object.entries(o).filter(([,v])=>v!=null))),h,s)}});
    await writer.unlock(new Uint8Array(user.prf));await writer.sync();
    const photos=[],registry={};
    const media=db.prepare('INSERT INTO diary_e2ee_media VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const blob=new Blob([png],{type:'image/png'});
    for(let i=0;i<48;i++) {
      const id=`11111111-1111-4111-8111-${String(i).padStart(12,'0')}`;
      const urls=Object.fromEntries(kinds.map(kind=>[`${kind}Url`,`/diary/api/photos/${id}/${kind}`]));
      const encrypted=await encryptPhotoParts(Object.fromEntries(kinds.map(kind=>[kind,blob])),writer.household,id);
      const prefix=`${PHOTO_PREFIX}${writer.household}/fixture/${id}`;
      const keys=kinds.map(kind=>`${prefix}/${kind}`);
      for(const [i,kind] of kinds.entries())f.r2.set(keys[i],{bytes:new Uint8Array(await encrypted.parts[kind].arrayBuffer())});
      media.run(id,writer.household,'main-admin','fixture','attached',...keys,'{}',1,'fixture',Date.now()+86400000,null);
      registry[id]={household:writer.household,accountId:'main-admin',encrypted:true};
      photos.push({id,fileName:`fixture-photo-${i}.png`,contentType:'image/png',originalSize:png.length,width:640,height:480,...urls,crypto:encrypted.descriptor});
    }
    const store=createStore(f.db,{households:writer.directory.households,epochs:writer.directory.epochs,directory:writer.directory,photos:registry});
    writer.transport.mutation=(proposal,operation)=>store.mutation(writer.actor,proposal,operation);
    for(let start=0;start<photos.length;start+=8) {
      const group=photos.slice(start,start+8);
      await writer.commitAction('seed',{entryDate:'2026-11-18',title:`Synthetic entry ${start/8}`,tags:[],
        content:group.map(photo=>`[[写真:${photo.id}]]`).join('\n'),photos:group},{state:'published'});
    }
    if(background) {
      // Background records belong to the inactive household. Photo access still
      // runs against the same approximate total number of references as production.
      const insert=db.prepare(`INSERT INTO diary_e2ee_records(id,household,scope,state,author,revision,epoch,source_id,source_revision,
        retained_for,envelope,summary,photo_ids,request_id,mutation_id,key_box,attestation)
        VALUES(?,'chiharu-household','fixture','published','fixture',1,1,NULL,NULL,'[]','{}','{}',?,?,?,'{}','{}')`);
      db.exec('BEGIN');
      for(let i=0;i<1466;i++) {
        const id=`background-${i}`;
        const ids=Array.from({length:15},(_,j)=>`22222222-2222-4222-8222-${String(i*15+j).padStart(12,'0')}`);
        insert.run(id,JSON.stringify(ids),id,id);
      }
      db.exec('COMMIT');
    }
    writer.lock();
    browser=await chromium.launch({headless:true});
    const login=async options=>{
      const context=await browser.newContext(options),page=await context.newPage();
      await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
      await context.addInitScript(({prf,credentialId,trust})=>{
        window.TRoomPasskeys={authenticate:async()=>({credentialId,prfOutput:new Uint8Array(prf),verified:{diaryTrust:trust},
          link:{accountId:'main-admin'},handoff:{handoffToken:'main-admin',diaryTrust:trust}})};
      },{prf:[...user.prf],credentialId:user.credentialId,trust});
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(origin+'/diary/');
      await page.click('#passkey-login');
      await page.locator('#app-view').waitFor({state:'visible'});
      return {context,page};
    };
    return {login,close,mediaRequests,errors};
  }catch(error){await close();throw error;}
}

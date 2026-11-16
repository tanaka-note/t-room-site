// Client-only scale fixture. All keys, ciphertext and API responses are
// synthetic. Actual isolated restore and server cutover are covered by the
// recovery browser/system tests; no production requests are made here.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {systemFixture} from './system-fixture.mjs';
const f=await systemFixture({phase:'legacy',recoveryExtractable:true}),owner=f.users['main-admin'];
const root=fileURLToPath(new URL('../../public/',import.meta.url));
const server=createServer(async(req,res)=>{
  try {
    const path=new URL(req.url,'http://fixture.invalid').pathname;
    if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Synthetic client verification scale</title>');return;}
    const file=resolve(root,path.slice('/diary/'.length));
    if(!path.startsWith('/diary/')||!file.startsWith(root.replace(/\/$/,'')+sep)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',['.js','.mjs'].includes(extname(file))?'text/javascript':'application/octet-stream');res.end(await readFile(file));
  }catch{res.writeHead(500);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
let raw;
try {
  const page=await browser.newPage();let productionRequests=0;
  await page.route('**/*',route=>{if(new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();productionRequests++;return route.abort();});
  await page.goto('http://127.0.0.1:'+server.address().port+'/');
  const session=await page.context().newCDPSession(page);await session.send('Emulation.setCPUThrottlingRate',{rate:4});
  raw=new Uint8Array(await crypto.subtle.exportKey('pkcs8',f.recovery.privateKey));
  const result=await page.evaluate(async input=>{
    const {seal,open,unlockVault,unb64,b64,verifySigned}=await import('/diary/crypto/e2ee/crypto.mjs');
    const {openRecoveryEnvelope}=await import('/diary/crypto/e2ee/recovery.mjs');
    const {rotationDigest,mediaBinding}=await import('/diary/crypto/e2ee/rotation.mjs');
    const {finishDiaryMaintenance}=await import('/diary/crypto/e2ee/maintenance.mjs');
    const privateBytes=new Uint8Array(input.recovery),prf=new Uint8Array(input.prf);
    const recoveryPrivateKey=await crypto.subtle.importKey('pkcs8',privateBytes,{name:'RSA-OAEP',hash:'SHA-256'},false,['decrypt']);privateBytes.fill(0);
    const own=await unlockVault(prf,input.recipientId,input.vault);prf.fill(0);
    const kit=await openRecoveryEnvelope({packet:input.configuration.recoveryEnvelope,recoveryPrivateKey,anchor:input.configuration.anchor,minimumGeneration:1});
    const count=22000,media=[];
    for(let start=0;start<count;start+=16)await Promise.all(Array.from({length:Math.min(16,count-start)},async(_,offset)=>{
      const id=String(start+offset).padStart(8,'0'),row={id,household:'tanaka-household',account_id:'main-admin',session_id:id,status:'attached',original_key:'synthetic/'+id+'/original',display_key:'synthetic/'+id+'/display',thumbnail_key:'synthetic/'+id+'/thumbnail',metadata:'',epoch:1,request_hash:'',expires_at:0,retired_at:null};
      row.metadata=JSON.stringify(await seal(kit.scopeKeys.get(mediaBinding(row).scope),{fileName:'Synthetic photo.jpg',description:'Synthetic fixture only.'.repeat(24)},mediaBinding(row)));
      row.request_hash=await rotationDigest({id,metadata:row.metadata});media[start+offset]=row;
    }));
    kit.scopeKeys.clear();kit.authority=null;
    let active=media,pending,proof=null,controls=0,pages=0,lastProgress=0;
    const plan=rows=>({kind:'migration',directoryGeneration:1,rolloutGeneration:1,records:[],media:rows});
    const report=rows=>({protocol:'T-lain diary isolated restore',version:1,archiveSha256:'a'.repeat(64),directoryGeneration:1,sequence:0,records:[],media:rows});
    const plans={get:async()=>structuredClone(pending),getProof:async()=>structuredClone(proof),putProof:async value=>{proof=structuredClone(value);},clear:async()=>{pending=null;proof=null;}};
    const api=async(path,body)=>{
      if(path==='/admin')return {config:input.configuration,rollout:{phase:'migrating',generation:1}};
      if(path.startsWith('/maintenance/inventory?')) {
        pages++;const query=new URLSearchParams(path.split('?')[1]),rows=query.get('kind')==='media'?active:[],after=query.get('after')||'';
        const first=after?Number(after)+1:0,page=rows.slice(first,first+20);
        return {controlGeneration:1,sequence:0,total:rows.length,rows:structuredClone(page),nextCursor:first+20<rows.length?page.at(-1).id:null};
      }
      if(path==='/control') {
        const member=input.configuration.directory.value.members.find(member=>member.credentialId===input.recipientId);
        const value=await verifySigned(body.evidence,member.signPublicKey);
        if(value.records!==0||value.directoryGeneration!==1)throw new Error('InvalidFixtureEvidence');controls++;return {phase:'encrypted'};
      }
      throw new Error('UnexpectedFixtureRoute');
    };
    const options={api,recoveryPrivateKey,signingKey:own.sign,trust:{anchor:input.configuration.anchor,minimumGeneration:1},plans,readerBuild:'diary-0123456789ab',writerBuild:'diary-0123456789ab',onProgress:progress=>{if(progress.phase==='decrypting'&&progress.kind==='media')lastProgress=progress.completed;}};
    pending=plan(media);const began=performance.now();await finishDiaryMaintenance({...options,report:report(media)});const milliseconds=Math.round(performance.now()-began);
    if(controls!==1||pages!==1101||lastProgress!==count)throw new Error('IncompleteScaleVerification');
    // All three inventories agree on the corrupted ciphertext. Only actual
    // AES-GCM authentication can reject it, and it must prevent cutover.
    const envelope=JSON.parse(media[0].metadata),cipher=unb64(envelope.ciphertext);cipher[0]^=1;envelope.ciphertext=b64(cipher);
    const corrupted={...media[0],metadata:JSON.stringify(envelope)};corrupted.request_hash=await rotationDigest({id:corrupted.id,metadata:corrupted.metadata});
    active=[corrupted,...media.slice(1)];pending=plan(active);controls=0;proof=null;let rejected='';
    try{await finishDiaryMaintenance({...options,report:report(active)});}catch(error){rejected=error.name;}
    if(rejected!=='OperationError'||controls!==0||proof!==null)throw new Error('CorruptedMediaWasNotRejected');
    return {media:count,milliseconds,cpuThrottle:4,completeInventory:true,authenticatedDecryption:true,tamperedMediaRejected:true};
  },{configuration:f.configuration,recipientId:owner.recipientId,vault:owner.vault,prf:[...owner.prf],recovery:[...raw]});
  assert.equal(result.media,22000);assert.equal(result.tamperedMediaRejected,true);assert.equal(productionRequests,0);console.log(JSON.stringify({...result,productionRequests}));
}finally{raw?.fill(0);await browser.close();await new Promise(resolve=>server.close(resolve));await f.close();}

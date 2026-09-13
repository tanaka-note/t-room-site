import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
globalThis.window = globalThis;
await import('../public/crypto-vault.js');
await import('../public/media-range.js');
const source = readFileSync(new URL('../public/media-worker.js', import.meta.url), 'utf8');
const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
const chunkSize = 1024;
const envelopes = await Promise.all(Array.from({length:24},(_,i)=>TRoomCrypto.encryptFileChunk(key,new Uint8Array(chunkSize).fill(i),i)));
const events={}, stored=new Map(), requests=[], held=new Map();
let hold=false, session='A';
const context=vm.createContext({console,crypto,CryptoKey,Uint8Array,AbortController,DOMException,Headers,Response,ReadableStream,URL,
  TRoomCrypto,TCloudRange,setTimeout,setInterval(){},importScripts(){},
  fetch:async(url,options={})=>{
    if(url==='/cloud/api/session')return Response.json({authenticated:session===options.headers['X-TCloud-Session']},{status:session===options.headers['X-TCloud-Session']?200:419});
    const index=Number(options.headers.Range.match(/\d+/)[0])/(chunkSize+32);
    requests.push(index);
    if(hold)await new Promise((resolve,reject)=>{
      held.set(index,resolve);
      options.signal.addEventListener('abort',()=>{held.delete(index);reject(new DOMException('aborted','AbortError'));},{once:true});
    });
    return new Response(envelopes[index],{status:206});
  }
});
context.self=context;
context.addEventListener=(name,fn)=>events[name]=fn;
context.clients={get:async()=>({postMessage(){}}),matchAll:async()=>[]};
context.TCloudOffline={supported:()=>true,getCacheLimitBytes:()=>8*(chunkSize+32),setCacheLimitBytes(){},
  getChunk:async(id,i)=>stored.get(`${id}:${i}`),putChunk:async(id,i,bytes)=>stored.set(`${id}:${i}`,bytes)};
vm.runInContext(source+'\nglobalThis.test={registrations,fetchAndDecryptChunk,servePlainFile,constrainOpenEndedMp4Range};',context);
const token='a'.repeat(24), descriptor={endpoint:'/cloud/api/items/1/data',expectedSession:'A',sizeBytes:24*chunkSize,chunkSizeBytes:chunkSize,chunkCount:24,storageId:'A:1',mimeType:'application/octet-stream'};
const send=(type,extra={},owner='owner')=>events.message({data:{type,token,...extra},source:{id:owner,postMessage(){}},waitUntil(p){p.catch(()=>{});}});
const until=async(fn)=>{const end=Date.now()+3000;while(!fn()){assert.ok(Date.now()<end,'timed out');await new Promise(r=>setTimeout(r,5));}};
hold=true;
send('REGISTER_MEDIA',{descriptor,fileKey:key});
await until(()=>held.has(0));
held.get(0)();held.delete(0);
await until(()=>held.has(1)&&held.has(2));
assert.deepEqual(requests.slice(0,3),[0,1,2],'no 30 second delay; two parallel ciphertext prefetches');
const entry=context.test.registrations.get(token);
const demand=context.test.fetchAndDecryptChunk(entry,12);
await until(()=>held.has(12));
assert.ok(!held.has(1)&&!held.has(2),'seek preempts speculative requests');
assert.equal(held.size,1,'only the requested range remains active');
hold=false;held.get(12)();held.delete(12);
assert.equal((await demand)[0],12,'actual AES-GCM decryption after seek');
await until(()=>stored.has('A:1:19'));
assert.ok([13,14,15,16].every(i=>stored.has(`A:1:${i}`)),'next four cached');
assert.ok(!stored.has('A:1:20'),'prefetch respects cache window');
assert.ok(entry.decryptedChunks.size<=2,'bulk prefetch does not decrypt video into RAM');
assert.notDeepEqual([...stored.get('A:1:13')],[...new Uint8Array(chunkSize).fill(13)]);
entry.descriptor.mimeType='video/mp4';
const requested={start:0,end:32*1024*1024,partial:true};
assert.equal(context.test.constrainOpenEndedMp4Range(entry,'bytes=0-',requested).end+1,2*1024*1024);
send('MEDIA_PLAYING',{},'other');assert.equal(entry.playing,undefined);
send('MEDIA_PLAYING');
assert.equal(context.test.constrainOpenEndedMp4Range(entry,'bytes=0-',requested).end+1,8*1024*1024);
assert.equal((await context.test.servePlainFile(token,new Request('https://local/cloud/local-media/'+token),'other')).status,403);
session='B';
await assert.rejects(context.test.fetchAndDecryptChunk(entry,12));
assert.equal(entry.fileKey,null);assert.equal(entry.decryptedChunks.size,0);
assert.equal(context.test.registrations.size,0,'changed session cannot use even cached plaintext');

// Closing during two in-flight transfers aborts both and prevents further I/O.
session='A';hold=true;requests.length=0;stored.clear();
send('REGISTER_MEDIA',{descriptor:{...descriptor,mimeType:'application/octet-stream'},fileKey:key});
await until(()=>held.has(0));held.get(0)();held.delete(0);
await until(()=>held.has(1)&&held.has(2));
send('RELEASE_MEDIA');const count=requests.length;
await new Promise(r=>setTimeout(r,80));
assert.equal(requests.length,count);assert.equal(held.size,0);
assert.equal(context.test.registrations.size,0);
console.log('PASS immediate/parallel bounded encrypted prefetch, seek priority, RAM, playing Range, owner/session isolation and release');


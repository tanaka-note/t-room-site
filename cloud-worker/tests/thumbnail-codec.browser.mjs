import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {engines,startUIFixture,preparePage} from './ui-fixture.mjs';
const data=Object.fromEntries(['wmv','mp4'].map(ext=>[ext,readFileSync(new URL(`./fixtures/thumbnail-codec.${ext}`,import.meta.url))]));
data.h264=readFileSync(new URL('./fixtures/thumbnail-codec-h264.mp4',import.meta.url));
const padding=Buffer.alloc(4*1024*1024);padding.writeUInt32BE(padding.length);padding.write('free',4);
data.locality=Buffer.concat([data.h264,padding]);
const serverSource=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const serveAsset=new Function(serverSource.slice(serverSource.indexOf('async function serveAsset('),serverSource.indexOf('\nasync function requireReadyFile('))+'; return serveAsset;')();
let requests=[],deny=false;
const fixture=await startUIFixture(undefined,{handleRequest:async(req,res)=>{
 if(req.url.startsWith('/cloud/thumbnail-codec.js')||req.url.startsWith('/cloud/vendor/libav/')){
  const url=new URL(req.url,'http://localhost');
  const result=await serveAsset(new Request(url),{ASSETS:{fetch:async request=>{
   const path=new URL(request.url).pathname;let bytes=readFileSync(new URL('../public'+path,import.meta.url));
   if(path==='/thumbnail-codec.js')bytes=Buffer.from(bytes.toString()
    .replace('if(par.codec_id===27)return await recoverAvc(', 'if(par.codec_id===27&&file.name==="broken-index.mp4")demux.av_seek_frame=async()=>{throw new Error("Fixture seek read budget exhausted");}; if(par.codec_id===27)return await recoverAvc(')
    .replace('await demux.mkblockreaderdev("input",size);check();', 'await demux.mkblockreaderdev("input",size);check(); if(file.name==="read-locality.mp4")for(let i=0;i<40;i++)await demux.onblockread("input",i%2?2*1024*1024:0,1024); if(file.name==="truncated-tail.mp4"){const read=demux.ff_read_frame_multi.bind(demux);let once=false;demux.ff_read_frame_multi=(c,p,o)=>{if(once)throw new Error("Fixture damaged tail");once=true;return read(c,p,{...o,limit:1});};}'));
   if(path==='/thumbnail-codec.js'&&process.argv.includes('--single-block-baseline'))bytes=Buffer.from(bytes.toString().replace('while(blocks.size>4)','while(blocks.size>1)'));
   return new Response(bytes,{headers:{'Content-Type':path.endsWith('.wasm')?'application/wasm':'text/javascript'}});
  }}},url,url.pathname.slice('/cloud'.length));
  res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));return true;
 }
 const match=/^\/cloud\/local-media\/fixture\.(wmv|mp4|h264|locality)$/.exec(req.url);
 if(!match)return false;
 assert.equal(req.method,'GET');const range=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');assert.ok(range);
 const bytes=data[match[1]],start=Number(range[1]),end=Math.min(Number(range[2]),bytes.length-1);requests.push({start,end});
 if(deny){res.writeHead(403).end();return true;}
 res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Type':'application/octet-stream'});res.end(bytes.subarray(start,end+1));return true;
}});
for(const path of ['/vendor/libav/private.txt','/vendor/libav/libav-6.7.7.1.1-decoder-h264.mjs','/vendor/libav/sources/private.key']){
 const url=new URL('http://localhost/cloud'+path);
 assert.equal((await serveAsset(new Request(url),{ASSETS:{fetch:()=>{throw new Error('unlisted asset forwarded');}}},url,path)).status,404);
}
try{for(const [name,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});
 try{
  const page=await browser.newPage();await preparePage(page,fixture.origin,0);
  let workers=0;page.on('worker',()=>workers++);
  assert.equal(await page.evaluate(async()=>{
   const original=TCloudUI;globalThis.TCloudUI={...original,recoverVideoThumbnail:async()=>__thumb.blob};
   try{return !!(await __test.captureVideoThumbnail('/cloud/local-media/native',{name:'native.mp4',sizeBytes:100}));}finally{globalThis.TCloudUI=original;}
  }),true);assert.equal(workers,0,'native success never starts the fallback');
  for(const ext of ['wmv','mp4','h264']){
   requests=[];
   const result=await page.evaluate(async({ext,size})=>{
    const file={name:`fixture.${ext==='h264'?'mp4':ext}`,sizeBytes:size};let duration=null;
    const blob=await TCloudThumbnailCodec.recover(`/cloud/local-media/fixture.${ext}`,file,null,value=>duration=value);
    if(!blob)return {present:false,codec:file.thumbnailCodec,error:globalThis.__codecError};
    const decoded=await TCloudUI.decodeThumbnail(blob);try{return {present:true,codec:file.thumbnailCodec,trace:file.thumbnailTrace,duration,accepted:TCloudUI.videoFrameQuality(decoded.image).accepted,width:decoded.image.naturalWidth};}finally{URL.revokeObjectURL(decoded.url);}
   },{ext,size:data[ext].length});
   if(ext==='h264'&&!await page.evaluate(async()=>typeof VideoDecoder!=='undefined'&&(await VideoDecoder.isConfigSupported({codec:'avc1.64000c'})).supported)){
    assert.equal(result.present,false);assert.equal(result.error,undefined);
    console.log('UNAVAILABLE native H264 WebCodecs; graceful no-thumbnail result verified',name);continue;
   }
   assert.equal(result.present,true,JSON.stringify(result));assert.equal(result.accepted,true);assert.equal(result.width,320);assert.equal(result.duration,3);
   assert.ok(requests.length<=3);console.log('PASS software decoder uses bounded local Range, produces real content frame',name,ext,{...result,requests:requests.length});
   if(ext==='h264'){
    assert.ok(result.trace.frames>0);assert.equal(result.trace.seeks||0,0,'valid opening packets avoid expensive container seeking');
    assert.equal(await page.evaluate(size=>TCloudThumbnailCodec.recover('/cloud/local-media/fixture.h264',{name:'broken-index.mp4',sizeBytes:size}).then(Boolean),data.h264.length),true,'readable opening frames survive a container whose seeks fail');
    assert.equal(await page.evaluate(size=>TCloudThumbnailCodec.recover('/cloud/local-media/fixture.h264',{name:'truncated-tail.mp4',sizeBytes:size}).then(Boolean),data.h264.length),true,'a valid keyframe is flushed even when the following packet cannot be read');
    const locality=await page.evaluate(async size=>{const file={name:'read-locality.mp4',sizeBytes:size};const blob=await TCloudThumbnailCodec.recover('/cloud/local-media/fixture.locality',file);return {present:!!blob,trace:file.thumbnailTrace};},data.locality.length);
    assert.equal(locality.present,true,JSON.stringify(locality));assert.ok(locality.trace.cacheHits>=38);assert.ok(locality.trace.readBytes<=3*1024*1024);console.log('PASS alternating distant video/audio block reads remain bounded',locality.trace);
   }
  }
  assert.ok(workers>=4,'demux and decode run off the main thread');
  const before=requests.length;
  assert.equal(await page.evaluate(()=>TCloudThumbnailCodec.recover('https://example.com/video.mp4',{name:'fixture.mp4',sizeBytes:100})),null);
  assert.equal(await page.evaluate(()=>TCloudThumbnailCodec.recover('/cloud/api/files/1/view',{name:'fixture.mp4',sizeBytes:100})),null);
  assert.equal(requests.length,before);console.log('PASS remote/direct API plaintext paths rejected',name);
  deny=true;requests=[];assert.equal(await page.evaluate(size=>TCloudThumbnailCodec.recover('/cloud/local-media/fixture.wmv',{name:'fixture.wmv',sizeBytes:size}),data.wmv.length),null);assert.equal(requests.length,1);deny=false;
  const local=await page.evaluate(async bytes=>{
   const file=new File([new Uint8Array(bytes)],'fixture.wmv');return !!(await TCloudThumbnailCodec.recover('blob:local-file',file));
  },[...data.wmv]);assert.equal(local,true);assert.equal(requests.length,1,'local uploads never send video bytes');
  const cancelled=await page.evaluate(async size=>{const c=new AbortController();const p=TCloudThumbnailCodec.recover('/cloud/local-media/fixture.wmv',{name:'fixture.wmv',sizeBytes:size},c.signal);c.abort();return await p;},data.wmv.length);assert.equal(cancelled,null);
  console.log('PASS permission rejection, local File input without upload, cancellation',name);
 }finally{await browser.close();}
}}finally{await fixture.close();}

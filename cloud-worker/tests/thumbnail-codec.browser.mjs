import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {engines,startUIFixture,preparePage} from './ui-fixture.mjs';
const data=Object.fromEntries(['wmv','mp4'].map(ext=>[ext,readFileSync(new URL(`./fixtures/thumbnail-codec.${ext}`,import.meta.url))]));
let requests=[],deny=false;
const fixture=await startUIFixture(undefined,{handleRequest:(req,res)=>{
 if(req.url.startsWith('/cloud/thumbnail-codec.js')){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(new URL('../public/thumbnail-codec.js',import.meta.url),'utf8').replace('catch {return null;}','catch(error){globalThis.__codecError=String(error.stack);return null;}'));return true;}
 const match=/^\/cloud\/local-media\/fixture\.(wmv|mp4)$/.exec(req.url);
 if(!match)return false;
 assert.equal(req.method,'GET');const range=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');assert.ok(range);
 const bytes=data[match[1]],start=Number(range[1]),end=Math.min(Number(range[2]),bytes.length-1);requests.push({start,end});
 if(deny){res.writeHead(403).end();return true;}
 res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Type':'application/octet-stream'});res.end(bytes.subarray(start,end+1));return true;
}});
try{for(const [name,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});
 try{
  const page=await browser.newPage();await preparePage(page,fixture.origin,0);
  let workers=0;page.on('worker',()=>workers++);
  assert.equal(await page.evaluate(async()=>{
   const original=TCloudUI;globalThis.TCloudUI={...original,recoverVideoThumbnail:async()=>__thumb.blob};
   try{return !!(await __test.captureVideoThumbnail('/cloud/local-media/native',{name:'native.mp4',sizeBytes:100}));}finally{globalThis.TCloudUI=original;}
  }),true);assert.equal(workers,0,'native success never starts the fallback');
  for(const ext of ['wmv','mp4']){
   requests=[];
   const result=await page.evaluate(async({ext,size})=>{
    const file={name:`fixture.${ext}`,sizeBytes:size};let duration=null;
    const blob=await TCloudThumbnailCodec.recover(`/cloud/local-media/fixture.${ext}`,file,null,value=>duration=value);
    if(!blob)return {present:false,codec:file.thumbnailCodec,error:globalThis.__codecError};
    const decoded=await TCloudUI.decodeThumbnail(blob);try{return {present:true,codec:file.thumbnailCodec,duration,accepted:TCloudUI.videoFrameQuality(decoded.image).accepted,width:decoded.image.naturalWidth};}finally{URL.revokeObjectURL(decoded.url);}
   },{ext,size:data[ext].length});
   assert.equal(result.present,true,JSON.stringify(result));assert.equal(result.accepted,true);assert.equal(result.width,320);assert.equal(result.duration,3);
   assert.ok(requests.length<=3);console.log('PASS software decoder uses bounded local Range, produces real content frame',name,ext,{...result,requests:requests.length});
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

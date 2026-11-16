import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {systemFixture} from './system-fixture.mjs';

const f=await systemFixture({phase:'legacy'}),id=crypto.randomUUID();
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
f.db.sqlite.exec("INSERT INTO diary_entries(id,entry_date,title,content,author_id,author_name,household_id,status) VALUES(900,'2026-11-16','Synthetic','Synthetic','main-admin','Synthetic owner','tanaka-household','published')");
f.db.sqlite.prepare("INSERT INTO diary_photos(id,entry_id,file_name,content_type,original_size,original_key,display_key,thumbnail_key,created_by_id,created_by_name,created_at) VALUES(?,900,'synthetic.png','image/png',68,'original','display','thumbnail','main-admin','Synthetic owner','2026-11-16')").run(id);
let reads=0;
f.env.MEDIA.get=async()=>{reads++;return {body:new Blob([png]).stream(),httpEtag:'"synthetic"',writeHttpMetadata:headers=>headers.set('Content-Type','image/png')};};
let origin;
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/diary/api/')) {
      const response=await f.worker.fetch(new Request(url,{headers:req.headers}),f.env,f.ctx);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><div role="dialog">'+Array.from({length:14},(_,index)=>`<img src="/diary/api/photos/${id}/${['thumbnail','display','original'][index%3]}" alt="synthetic-${index}.png">`).join('')+'</div>');
  }catch{res.writeHead(500);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});
try {
  for(const dedicated of [false,true]) {
    f.env.DIARY_ENCRYPTION_ORIGIN=dedicated?origin:'https://diary.tanaka-note.com';
    const context=await browser.newContext(),page=await context.newPage();
    await context.addCookies([{name:'troom_diary_session',value:f.cookie('main-admin').slice('troom_diary_session='.length),domain:'127.0.0.1',path:'/diary'}]);
    await page.goto(origin+'/diary/');
    await page.waitForFunction(()=>[...document.images].every(image=>image.complete));
    assert.deepEqual(await page.locator('img').evaluateAll(images=>images.map(image=>image.naturalWidth)),Array(14).fill(1));
    await context.close();
  }
  assert.ok(reads>=6);assert.equal(f.r2.size,0);
  console.log('Legacy photo rollout browser: 14 previews decode on the original and dedicated origins while key preparation is enabled; no production requests or photo mutations.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await f.close();}

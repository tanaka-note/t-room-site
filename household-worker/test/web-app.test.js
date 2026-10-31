import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './fixture.js';

test('online web app has a stable scope, selected wallet icons and public install assets without exposing other paths',async()=>{
 const manifest=JSON.parse(readFileSync(new URL('../public/manifest.webmanifest',import.meta.url)));
 assert.equal(manifest.id,'/household/');assert.equal(manifest.start_url,'/household/');assert.equal(manifest.scope,'/household/');assert.equal(manifest.display,'standalone');assert.equal(manifest.name,'家計簿');
 assert.deepEqual(manifest.icons.map(i=>i.sizes),['192x192','512x512']);
 const f=fixture();
 try{
  const served=[];f.env.ASSETS.fetch=async request=>{served.push(new URL(request.url).pathname);return new Response('public asset');};
  for(const size of [32,180,192,512]){
   const path=`/icons/icon-${size}.png`,png=readFileSync(new URL(`../public${path}`,import.meta.url));
   assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size);
   const response=await f.request(path);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  }
  assert.equal((await f.request('/manifest.webmanifest')).status,200);assert.ok(served.includes('/manifest.webmanifest'));
  assert.equal((await f.request('/icons/unknown.png')).status,404);assert.equal((await f.request('/sw.js')).status,404);assert.equal((await f.request('/manifest.webmanifest',{})).status,405);
  assert.equal((await f.request('/api/data')).status,401);
 }finally{f.close();}
});

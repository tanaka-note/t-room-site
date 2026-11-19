import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {b64} from '../../e2ee/crypto.mjs';
import {encryptPhotoParts} from '../../e2ee/photo-crypto.mjs';

const require=createRequire(realpathSync(new URL('../../node_modules/wrangler/package.json',import.meta.url)));
const {Miniflare}=require('miniflare'),{build}=require('esbuild');

test('streamed migration PUT stores exactly one object in isolated workerd R2 and verifies its SHA-256', {timeout:45_000},async()=>{
  let runtime;
  try {
    const bundled=await build({stdin:{resolveDir:fileURLToPath(new URL('../../',import.meta.url)),contents:`
      import {putReservedPhotoPart} from './e2ee/photo-migration-store.mjs';
      export default {async fetch(request,env){try {
        const part={bytes:Number(request.headers.get('X-Test-Size')),sha256:request.headers.get('X-Test-Hash')};
        const stored=await putReservedPhotoPart(env.BUCKET,'synthetic-object',request,part);
        const head=await env.BUCKET.head('synthetic-object');
        return Response.json({created:Boolean(stored),size:head.size,sha256:[...new Uint8Array(head.checksums.sha256)]});
      }catch(error){return Response.json({error:error.message},{status:error.status||400});}}};`},bundle:true,format:'esm',platform:'browser',write:false});
    runtime=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-08-04',r2Buckets:{BUCKET:'synthetic-photo-bucket'}});
    const image=new Blob([new Uint8Array(3*1048576+17).fill(25)],{type:'image/jpeg'});
    const {parts}=await encryptPhotoParts({original:image,display:image,thumbnail:image},'synthetic',crypto.randomUUID());
    const encrypted=new Uint8Array(await parts.original.arrayBuffer()),sha=await crypto.subtle.digest('SHA-256',encrypted);
    const send=body=>runtime.dispatchFetch('http://fixture/',{method:'PUT',headers:{'Content-Type':'application/octet-stream','Content-Length':String(body.length),
      'X-Test-Size':String(encrypted.length),'X-Test-Hash':b64(sha)},body});
    const first=await send(encrypted);assert.equal(first.status,200,await first.clone().text());assert.deepEqual(await first.json(),{created:true,size:encrypted.length,sha256:[...new Uint8Array(sha)]});
    const second=await send(encrypted);assert.equal(second.status,200,await second.clone().text());assert.equal((await second.json()).created,false);
  }finally {await runtime?.dispose();}
});

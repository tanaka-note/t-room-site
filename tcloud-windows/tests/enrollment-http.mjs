import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Validate actual .NET outbound packets against the existing server guard.
// No requests, cookies, passkeys or database writes are sent to production.
const source=readFileSync(new URL('../../security-worker/src/index.js',import.meta.url),'utf8');
const guardSource=source.match(/function requireMutation\(request, url\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(guardSource,'current Security mutation guard');
class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
const guard=vm.runInNewContext(guardSource+'\nrequireMutation',{HttpError});
const packets=JSON.parse(readFileSync(0,'utf8'));
assert.equal(packets.length,8);
for(const packet of packets) {
  const url=new URL(packet.url);assert.equal(url.origin,'https://tanaka-note.com');
  const request=new Request(url,{method:packet.method,headers:packet.headers,body:'{}'});
  assert.doesNotThrow(()=>guard(request,url));
  for(const origin of [null,'https://untrusted.example']) {
    const headers=new Headers(packet.headers);headers.delete('Origin');if(origin)headers.set('Origin',origin);
    assert.throws(()=>guard(new Request(url,{method:'POST',headers,body:'{}'}),url),error=>error.status===403);
  }
  const headers=new Headers(packet.headers);headers.set('Content-Type','text/plain');
  assert.throws(()=>guard(new Request(url,{method:'POST',headers,body:'{}'}),url),error=>error.status===403);
}
console.log('PASS initial login, enrollment and logout packets preserve the current same-origin JSON guard');

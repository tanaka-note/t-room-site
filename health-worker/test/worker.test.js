import test from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { handleRequest, signSession } from '../src/worker.js';
import { fixture } from './fixture.js';
import { encryptRecord, recordId } from '../public/health-crypto.mjs';
const origin='https://tanaka-note.com';
async function login(f,person='owner') {const r=await handleRequest(new Request(`${origin}/health/api/passkey/handoff`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({handoffToken:f.issue(person)})}),f.env);const v=await r.json();return {Cookie:r.headers.get('Set-Cookie').split(';')[0],'X-Health-Session':v.sessionId};}
function req(path,headers,method='GET',body){return new Request(`${origin}/health/api${path}`,{method,headers:{Origin:origin,'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});}
test('actual handler shares encrypted records and implements last save wins without history',async()=>{
  const f=await fixture();try{const a=await login(f);const b=await login(f,'subject');const id=await recordId(f.master,'2026-01-01');
  assert.equal(f.auditEvents.length,2); for(const event of f.auditEvents){assert.match(event.eventId,/^[a-f0-9-]{36}$/);assert.ok(Number.isFinite(Date.parse(event.occurredAt)));assert.equal(event.service,'health');assert.equal(event.eventType,'passkey_login_success');assert.equal(event.sessionId,undefined);assert.ok(event.sessionIdHash);}
  const first=await encryptRecord(f.master,id,{note:'first'});const last=await encryptRecord(f.master,id,{note:'last'});
  await handleRequest(req(`/records/${id}`,a,'PUT',first),f.env);await handleRequest(req(`/records/${id}`,b,'PUT',last),f.env);
  const result=await(await handleRequest(req('/records',a),f.env)).json();assert.equal(result.records.length,1);assert.equal(result.records[0].ciphertext,last.ciphertext);assert.equal(result.records[0].revision,2);
  await assert.rejects(handleRequest(req(`/records/${id}`,a,'PUT',{...last,note:'plaintext'}),f.env),e=>e.status===400);
  await assert.rejects(handleRequest(req('/records',{}),f.env),e=>e.status===401);
  await assert.rejects(handleRequest(req('/records',{Cookie:a.Cookie}),f.env),e=>e.status===409);
  await assert.rejects(handleRequest(req('/records',a),{...f.env,SESSION_SECRET:randomBytes(32).toString('hex')}),e=>e.status===401);
  await assert.rejects(handleRequest(new Request(`${origin}/health/api/records/${id}`,{method:'PUT',headers:{...a,Origin:'https://attacker.invalid','Content-Type':'application/json'},body:JSON.stringify(last)}),f.env),e=>e.status===403);
  await handleRequest(req(`/records/${id}`,b,'DELETE',{}),f.env);assert.equal((await(await handleRequest(req('/records',a),f.env)).json()).records.length,0);
  await handleRequest(req('/logout',b,'POST',{}),f.env);assert.equal(f.auditEvents.at(-1).eventType,'logout');assert.equal(f.auditEvents.at(-1).sessionIdHash,f.auditEvents[1].sessionIdHash);assert.doesNotMatch(JSON.stringify(f.auditEvents),/plaintext|symptoms|"note"|2026-01-01/);
  f.revoke();await assert.rejects(handleRequest(req('/records',a),f.env),e=>e.status===401);
  }finally{f.db.close();}
});
test('JSON mutations reject oversized streams and non-object inputs',async()=>{
  const f=await fixture();try{const headers=await login(f);const id=await recordId(f.master,'2026-01-01');
    await assert.rejects(handleRequest(req(`/records/${id}`,headers,'PUT',[]),f.env),e=>e.status===400);
    const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('x'.repeat(200001)));controller.close();}});
    await assert.rejects(handleRequest(new Request(`${origin}/health/api/records/${id}`,{method:'PUT',headers:{...headers,Origin:origin,'Content-Type':'application/json'},body:stream,duplex:'half'}),f.env),e=>e.status===413);
  }finally{f.db.close();}
});
test('third party and expired sessions cannot read; handoffs are consumed once',async()=>{
  const f=await fixture();try{const token=f.issue('owner');const request=()=>req('/passkey/handoff',{},'POST',{handoffToken:token});await handleRequest(request(),f.env);await assert.rejects(handleRequest(request(),f.env),e=>e.status===401);
  for(const s of [{identityId:'third-party',credentialId:'x',serviceLinkId:'x',expiresAt:Math.floor(Date.now()/1000)+100},{identityId:'primary-admin',credentialId:'fixture-owner',serviceLinkId:'link-owner',expiresAt:1}]){const session={...s,serviceAccountId:'nobumi',sessionVersion:'1',authMethod:'passkey',sessionId:'id',passkeySessionEpoch:1};const cookie=await signSession(session,f.env);await assert.rejects(handleRequest(req('/records',{Cookie:`troom_health_session=${cookie}`,'X-Health-Session':'id'}),f.env),e=>e.status===401);}
  f.env.PASSKEY_ENABLED='false';await assert.rejects(handleRequest(req('/passkey/handoff',{},'POST',{handoffToken:f.issue('owner')}),f.env),e=>e.status===503);
  }finally{f.db.close();}
});

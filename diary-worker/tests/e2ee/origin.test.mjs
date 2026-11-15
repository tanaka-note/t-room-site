import assert from 'node:assert/strict';import {test} from 'node:test';
import {proxyDiaryAuthentication} from '../../e2ee/origin.mjs';
import {diaryAuthenticationOrigins} from '../../../security-worker/src/diary-keys.js';
test('dedicated-origin authentication cannot proxy another service or Security administration',async()=>{
  const calls=[],origin='https://diary.tanaka-note.com',env={DIARY_ENCRYPTION_ENABLED:'true',DIARY_ENCRYPTION_ORIGIN:origin,SECURITY:{fetch:async request=>{calls.push(request);return Response.json({ok:true});}}};
  const request=(service,route='options',extra={})=>new Request(origin+'/security/api/auth/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...extra},body:JSON.stringify({service})});
  assert.equal((await proxyDiaryAuthentication(request('diary'),env)).status,200);assert.equal(calls.length,1);assert.equal((await calls[0].json()).service,'diary');
  for(const service of ['cloud','security','household',undefined])assert.equal((await proxyDiaryAuthentication(request(service),env)).status,403);
  assert.equal((await proxyDiaryAuthentication(request('diary','verify',{Origin:'https://tanaka-note.com'}),env)).status,403);
  assert.equal((await proxyDiaryAuthentication(request('diary','../diary/config'),env)).status,404);
  assert.equal((await proxyDiaryAuthentication(new Request(origin+'/security/api/auth/options',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({service:'diary',padding:'x'.repeat(100001)})}),env)).status,413);
  assert.deepEqual(diaryAuthenticationOrigins(env,'diary'),[origin]);
  for(const service of ['security','cloud','household',undefined])assert.deepEqual(diaryAuthenticationOrigins(env,service),[]);
  assert.deepEqual(diaryAuthenticationOrigins({...env,DIARY_ENCRYPTION_ENABLED:'false'},'diary'),[]);
});

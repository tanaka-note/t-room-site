import {PASSKEY_SESSION_TTL_SECONDS} from './session-policy.mjs';
import {rollingSessionInput,foregroundSessionActivity,ROLLING_SESSION_VERSION} from './passkey-rolling.mjs';
export {ROLLING_SESSION_VERSION};
export function passkeyTtlSecondsForService(service){return service==='calendar'?30*86400:PASSKEY_SESSION_TTL_SECONDS;}

// Calendar uses the existing claims, ledger, signing and activity rules. Its
// approved idle lifetime is isolated so no other service's cookie or bundle changes.
export async function serviceRollingSession(env,service,session,action){
  if(service!=='calendar'||session?.authMethod!=='passkey'||session.rollingSessionVersion!==ROLLING_SESSION_VERSION||!session.sessionId)return{valid:false};
  try{const input=await rollingSessionInput(env,service,session,action);input.ttlSeconds=passkeyTtlSecondsForService(service);return await env.SECURITY.passkeyRollingSession(input);}catch{return{valid:false};}
}
export async function renewServiceSession(request,response,env,service,path,session,cookie){
  if(!foregroundSessionActivity(request,response,path))return response;
  const renewed=await serviceRollingSession(env,service,session,'touch');
  if(!renewed.valid)return new Response(JSON.stringify({error:'パスキーでログインし直してください。'}),{status:401,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  const headers=new Headers(response.headers);headers.set('Set-Cookie',await cookie(renewed.expiresAt));headers.set('X-Troom-Session-Expires',String(renewed.expiresAt));
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

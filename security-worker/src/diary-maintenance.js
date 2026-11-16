import {b64,unb64,encode} from '../../diary-worker/e2ee/crypto.mjs';
import {isValidSessionSecret} from '../../assets/session-secret.mjs';
const fail=()=>{throw Object.assign(new Error('DiaryMaintenanceAuthorizationInvalid'),{status:403});};
const fields=['identityId','credentialId','serviceLinkId','serviceAccountId','sessionId','startedAt','passkeySessionEpoch','accountVersion'];
const binding=input=>Object.fromEntries(fields.map(key=>[key,input[key]??null]));
async function key(env) {
  if(!isValidSessionSecret(env.SESSION_SECRET))throw Object.assign(new Error('DiaryMaintenanceUnavailable'),{status:503});
  return crypto.subtle.importKey('raw',new TextEncoder().encode(env.SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
// This is a bounded continuation of a migration started by a fresh owner
// login, not a new login or general admin credential. It contains no keys.
export async function issueDiaryMaintenance(env,input,directoryGeneration,rollout) {
  if(!input.sessionId||rollout.phase!=='migrating'||rollout.everEncrypted)fail();
  const payload={protocol:'T-lain diary migration authorization',session:binding(input),directoryGeneration,rolloutGeneration:rollout.generation,expiresAt:Date.now()+3600000};
  const bytes=encode(payload),signature=await crypto.subtle.sign('HMAC',await key(env),bytes);
  return {authorization:b64(bytes)+'.'+b64(signature)};
}
export async function verifyDiaryMaintenance(env,input,directoryGeneration,rollout) {
  try {
    if(typeof input.maintenanceAuthorization!=='string'||input.maintenanceAuthorization.length>5000)fail();
    const [data,signature,...extra]=input.maintenanceAuthorization.split('.');if(extra.length)fail();
    const bytes=unb64(data,4000);
    if(!await crypto.subtle.verify('HMAC',await key(env),unb64(signature,64),bytes))fail();
    const payload=JSON.parse(new TextDecoder().decode(bytes));
    if(payload.protocol!=='T-lain diary migration authorization'||b64(encode(payload.session))!==b64(encode(binding(input)))||payload.directoryGeneration!==directoryGeneration||payload.rolloutGeneration!==rollout.generation||rollout.phase!=='migrating'||rollout.everEncrypted||!Number.isSafeInteger(payload.expiresAt)||payload.expiresAt<=Date.now()||payload.expiresAt>Date.now()+3600000)fail();
    return payload.expiresAt;
  }catch{fail();}
}

import {encode,b64} from './crypto.mjs';

// Like T-Cloud, persist only non-extractable CryptoKeys for the SAME live
// service session. Raw PRF/scope keys/documents never enter this database.
const name='tlain-diary-device-v1';
let changes=Promise.resolve(),storageGeneration=0;
const serialize=operation=>{const result=changes.then(operation);changes=result.catch(()=>{});return result;};
export const validDeviceKeys=keys=>keys?.rsa instanceof CryptoKey&&keys.sign instanceof CryptoKey&&
  !keys.rsa.extractable&&!keys.sign.extractable&&keys.rsa.type==='private'&&keys.sign.type==='private'&&
  keys.rsa.algorithm.name==='RSA-OAEP'&&keys.rsa.algorithm.modulusLength===3072&&keys.rsa.algorithm.hash.name==='SHA-256'&&keys.rsa.usages.join(',')==='decrypt'&&
  keys.sign.algorithm.name==='ECDSA'&&keys.sign.algorithm.namedCurve==='P-256'&&keys.sign.usages.join(',')==='sign';
function binding(session,profile) {
  if(!session?.authenticated||session.authMethod!=='passkey'||!session.keySession?.id||session.encryption?.accountId!==profile.actor.accountId||session.encryption?.webAuthnCredentialId!==profile.webAuthnCredentialId)return null;
  return b64(encode({session:session.keySession,account:profile.actor.accountId,recipient:profile.actor.credentialId,publicKey:profile.vault.publicKey,signPublicKey:profile.vault.signPublicKey,generation:profile.directory.value.generation}));
}
async function operation(mode,callback) {
  const request=indexedDB.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore('keys');
  const db=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('DeviceStorageUnavailable'));});
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction('keys',mode),result=callback(tx.objectStore('keys'));tx.oncomplete=()=>resolve(result.result);tx.onerror=tx.onabort=()=>reject(new Error('DeviceStorageUnavailable'));});}
  finally{db.close();}
}
export async function saveDevice(session,profile,privateKeys,trust) {
  const bound=binding(session,profile);
  if(!bound||!validDeviceKeys(privateKeys)||!(session.expiresAt*1000>Date.now()))return;
  const generation=storageGeneration;
  await serialize(()=>generation!==storageGeneration?undefined:operation('readwrite',store=>store.put({binding:bound,privateKeys,trust,expiresAt:session.expiresAt},session.keySession.id)));
}
export async function loadDevice(session,profile) {
  const bound=binding(session,profile);if(!bound)return null;
  await changes;
  const saved=await operation('readonly',store=>store.get(session.keySession.id));
  if(!saved||saved.binding!==bound||!(saved.expiresAt*1000>Date.now())||!validDeviceKeys(saved.privateKeys))return null;
  return saved;
}
export async function clearDevice(session,{all=false}={}) {
  if(!session?.keySession?.id)return;
  storageGeneration++;
  // An older tab receiving a session-change broadcast must not delete the
  // newly authenticated tab's key. Explicit logout retires every saved key.
  await serialize(()=>operation('readwrite',store=>all?store.clear():store.delete(session.keySession.id)));
}

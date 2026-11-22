import {encode,b64} from './crypto.mjs';

// Like T-Cloud, persist only non-extractable CryptoKeys for the SAME live
// service session. Raw PRF/scope keys/documents never enter this database.
const name='tlain-diary-device-v1';
const DEVICE_CACHE_TIMEOUT_MS = 2500;
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
async function operation(mode, callback, timeoutMs = 0) {
  const request = indexedDB.open(name, 1);
  let timer, db, transaction, abandoned = false;
  try {
    return await new Promise((resolve, reject) => {
      const unavailable = () => reject(new Error('DeviceStorageUnavailable'));
      const abandon = () => {
        abandoned = true;
        try { transaction?.abort(); } catch { /* The transaction already finished. */ }
        unavailable();
      };
      if (timeoutMs) timer = setTimeout(abandon, timeoutMs);
      request.onerror = unavailable;
      if (timeoutMs) request.onblocked = abandon;
      request.onupgradeneeded = () => {
        if (abandoned) request.transaction.abort();
        else request.result.createObjectStore('keys');
      };
      request.onsuccess = () => {
        if (abandoned) {
          request.result.close();
          return;
        }
        db = request.result;
        try {
          transaction = db.transaction('keys', mode);
          transaction.onabort = unavailable;
          const result = callback(transaction.objectStore('keys'));
          transaction.oncomplete = () => resolve(result.result);
        } catch (error) {
          reject(error);
        }
      };
    });
  } finally {
    clearTimeout(timer);
    db?.close();
  }
}
export async function saveDevice(session,profile,privateKeys,trust) {
  const bound=binding(session,profile);
  if(!bound||!validDeviceKeys(privateKeys)||!(session.expiresAt*1000>Date.now()))return;
  const generation=storageGeneration;
  await serialize(()=>generation!==storageGeneration?undefined:operation('readwrite',store=>store.put({binding:bound,privateKeys,trust,expiresAt:session.expiresAt},session.keySession.id),DEVICE_CACHE_TIMEOUT_MS));
}
export async function loadDevice(session,profile) {
  const bound=binding(session,profile);if(!bound)return null;
  await changes;
  const saved=await operation('readonly',store=>store.get(session.keySession.id),DEVICE_CACHE_TIMEOUT_MS);
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

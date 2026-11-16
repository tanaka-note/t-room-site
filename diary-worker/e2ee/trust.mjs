import {encode,fingerprint,open,seal,validatePublicTrust,validateEnvelope} from './crypto.mjs';

export const TRUST_PIN='tlain-diary-authority-public-v1';
const label='T-lain diary passkey trust v1';
const binding=(recipientId,generation)=>({household:'credential',scope:'trust',id:recipientId,revision:generation,epoch:1,kind:'public-trust'});
async function key(prf,recipientId) {
  if(!(prf instanceof Uint8Array)||prf.length!==32)throw new Error('PRFRequired');
  const material=await crypto.subtle.importKey('raw',prf,'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encode(label),info:encode(recipientId)},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export function validateSealedTrust(packet,maxBytes=12000) {
  if(!packet||Object.keys(packet).sort().join(',')!=='envelope,generation'||!Number.isSafeInteger(packet.generation)||packet.generation<1||encode(packet).length>maxBytes)throw new Error('InvalidPasskeyTrust');
  validateEnvelope(packet.envelope);return packet;
}
export async function sealTrust(prf,recipientId,trust) {
  await validatePublicTrust(trust);
  return {generation:trust.minimumGeneration,envelope:await seal(await key(prf,recipientId),trust,binding(recipientId,trust.minimumGeneration))};
}
export async function openTrust(prf,recipientId,packet) {
  validateSealedTrust(packet);
  const trust=await validatePublicTrust(await open(await key(prf,recipientId),packet.envelope,binding(recipientId,packet.generation)));
  if(trust.minimumGeneration!==packet.generation)throw new Error('InvalidPasskeyTrust');
  return trust;
}
export async function sealPendingConfiguration(prf,recipientId,configuration) {
  const generation=configuration.expectedGeneration+1;
  return {generation,envelope:await seal(await key(prf,recipientId),configuration,{...binding(recipientId,generation),scope:'configuration',kind:'pending-configuration'})};
}
export async function openPendingConfiguration(prf,recipientId,packet) {
  validateSealedTrust(packet,2_100_000);
  const value=await open(await key(prf,recipientId),packet.envelope,{...binding(recipientId,packet.generation),scope:'configuration',kind:'pending-configuration'});
  if(value.expectedGeneration+1!==packet.generation)throw new Error('InvalidPasskeyTrust');return value;
}
const FLOOR=TRUST_PIN+'-floor';
export async function checkTrustFloor(trust,storage) {
  await validatePublicTrust(trust);
  const floor=JSON.parse(storage?.getItem(FLOOR)||'null');
  if(floor&&(!Number.isSafeInteger(floor.minimumGeneration)||floor.minimumGeneration<1||floor.fingerprint!==trust.fingerprint||floor.minimumGeneration>trust.minimumGeneration))throw new Error('DiaryTrustRollback');
  return trust;
}
export async function rememberTrustFloor(trust,storage) {
  await checkTrustFloor(trust,storage);
  // This guard needs a digest and numeric floor only. Cross-device trust and
  // configuration retries are kept in PRF-authenticated envelopes.
  storage?.setItem(FLOOR,JSON.stringify({fingerprint:await fingerprint(trust.anchor),minimumGeneration:trust.minimumGeneration}));
  return trust;
}
export async function sameTrust(a,b) {
  await validatePublicTrust(a);await validatePublicTrust(b);
  if(await fingerprint(a.anchor)!==await fingerprint(b.anchor))throw new Error('DiaryTrustChanged');
  if(b.minimumGeneration<a.minimumGeneration)throw new Error('DiaryTrustRollback');
  return b;
}

// First establishment comes from the authenticated Security Center handoff,
// never the Diary profile/directory. Later logins must open the PRF-sealed pin;
// damaged envelopes and older generations never fall back to initial trust.
export async function resolveTrust({prf,recipientId,sealed,bootstrap,pinned}) {
  let trust=sealed?await openTrust(prf,recipientId,sealed):pinned;
  if(pinned&&trust&&await fingerprint(pinned.anchor)!==await fingerprint(trust.anchor))throw new Error('DiaryTrustChanged');
  if(bootstrap)trust=trust?await sameTrust(trust,bootstrap):await validatePublicTrust(bootstrap);
  if(!trust)throw new Error('日記の鍵設定を確認できません。パスキーでログインし直してください。');
  if(pinned)await sameTrust(pinned,trust);
  return trust;
}

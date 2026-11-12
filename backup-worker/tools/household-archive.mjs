// Offline only: recipient public keys seal copies; private keys never leave
// the recovery process. This module has no network or deletion capability.
import {timingSafeEqual} from 'node:crypto';
import {restoreIsolated} from './restore-isolated.mjs';
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const FORMAT='troom-household-backup-archive',ALGORITHM='RSA-OAEP-3072-SHA256+A256GCM';
const MAX_BYTES=8*1024*1024,MAX_OBJECTS=1000;
const buckets=new Set(['t-room-service-backups','t-room-diary-backups']);
const sourcePattern=/^d1\/household\/(?:(?:v[23]\/)?(?:daily|monthly)\/\d{4}-\d{2}(?:-\d{2})?\.json\.gz|v3\/data\/[A-Za-z0-9-]+\/\d{6}\.json\.gz)$/;
const fail=()=>{throw new Error('HouseholdArchiveInvalid');};
const b64=value=>Buffer.from(value).toString('base64url');
function bytes(value,max=MAX_BYTES*2){if(typeof value!=='string'||!value.length||value.length>max*2||!/^[A-Za-z0-9_-]+$/.test(value))fail();const result=Buffer.from(value,'base64url');if(b64(result)!==value||result.length>max)fail();return result;}
const sha=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',value)).toString('hex');
export function archivePublicKey(value){
 if(value?.kty!=='RSA'||value.e!=='AQAB'||typeof value.n!=='string'||bytes(value.n,384).length!==384||['d','p','q','dp','dq','qi','oth'].some(k=>k in value))fail();
 return {kty:'RSA',n:value.n,e:'AQAB',alg:'RSA-OAEP-256',key_ops:['encrypt'],ext:true};
}
export const archiveRecipientFingerprint=async key=>sha(encoder.encode(JSON.stringify(archivePublicKey(key))));
function header(value){
 if(value?.format!==FORMAT||value.version!==1||value.algorithm!==ALGORITHM||!/^[a-f0-9-]{36}$/.test(value.id)||!Number.isFinite(Date.parse(value.createdAt))||!/^[a-f0-9]{64}$/.test(value.recipientFingerprint))fail();
 return {format:FORMAT,version:1,id:value.id,createdAt:value.createdAt,algorithm:ALGORITHM,recipientFingerprint:value.recipientFingerprint};
}
const aad=value=>encoder.encode(JSON.stringify(header(value)));
const label=value=>encoder.encode(`${FORMAT}|1|${value.id}|${value.recipientFingerprint}`);
async function validateObjects(objects){
 if(!Array.isArray(objects)||!objects.length||objects.length>MAX_OBJECTS)fail();
 const seen=new Set();let total=0;
 for(const object of objects){
  const identity=`${object.bucket}:${object.key}`;
  if(!buckets.has(object.bucket)||!sourcePattern.test(object.key)||seen.has(identity)||!(object.bytes instanceof Uint8Array)||!object.bytes.length||object.bytes.length>MAX_BYTES||!object.metadata||!Number.isFinite(Date.parse(object.uploadedAt)))fail();
  seen.add(identity);total+=object.bytes.length;if(total>MAX_BYTES)fail();
  if(!/^[a-f0-9]{64}$/.test(object.metadata.sha256)||await sha(object.bytes)!==object.metadata.sha256)fail();
 }
 return {objectCount:objects.length,sourceBytes:total};
}
function encodeObjects(objects){return objects.map(o=>({bucket:o.bucket,key:o.key,uploadedAt:o.uploadedAt,metadata:o.metadata,etag:o.etag,body:b64(o.bytes)}));}
async function decodeObjects(plain){
 const payload=JSON.parse(decoder.decode(plain));
 if(payload?.format!=='household-original-objects-v1'||!Array.isArray(payload.objects))fail();
 const objects=payload.objects.map(o=>({...o,bytes:bytes(o.body,MAX_BYTES)}));await validateObjects(objects);return objects;
}
export async function sealHouseholdArchive(objects,recipient){
 const summary=await validateObjects(objects),publicKey=archivePublicKey(recipient);
 const raw=crypto.getRandomValues(new Uint8Array(32)),iv=crypto.getRandomValues(new Uint8Array(12));let plain,roundTrip;
 try{
  const key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);
  const value={format:FORMAT,version:1,id:crypto.randomUUID(),createdAt:new Date().toISOString(),algorithm:ALGORITHM,recipientFingerprint:await archiveRecipientFingerprint(publicKey)};
  plain=encoder.encode(JSON.stringify({format:'household-original-objects-v1',objects:encodeObjects(objects)}));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(value)},key,plain);
  roundTrip=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(value)},key,ciphertext));
  if(plain.length!==roundTrip.length||!timingSafeEqual(plain,roundTrip))fail();
  await decodeObjects(roundTrip);
  const rsa=await crypto.subtle.importKey('jwk',publicKey,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  const wrapped=await crypto.subtle.encrypt({name:'RSA-OAEP',label:label(value)},rsa,raw);
  return {archive:{...value,wrappedKey:b64(wrapped),iv:b64(iv),ciphertext:b64(ciphertext)},summary:{...summary,contentRoundTripVerified:true,recipientPrivateKeyVerified:false}};
 }finally{raw.fill(0);plain?.fill(0);roundTrip?.fill(0);}
}
export async function openHouseholdArchive(archive,privateKey){
 header(archive);
 if(Object.keys(archive).sort().join(',')!=='algorithm,ciphertext,createdAt,format,id,iv,recipientFingerprint,version,wrappedKey'||bytes(archive.wrappedKey,384).length!==384||bytes(archive.iv,12).length!==12)fail();
 let raw,plain;
 try{
  raw=new Uint8Array(await crypto.subtle.decrypt({name:'RSA-OAEP',label:label(archive)},privateKey,bytes(archive.wrappedKey,384)));
  if(raw.length!==32)fail();const key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);
  plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(archive.iv,12),additionalData:aad(archive)},key,bytes(archive.ciphertext)));
  return await decodeObjects(plain);
 }finally{raw?.fill(0);plain?.fill(0);}
}
export function archivedBucket(objects,bucket){
 const map=new Map(objects.filter(o=>o.bucket===bucket).map(o=>[o.key,o]));
 return {async get(key){const value=map.get(key);return value?{body:new Blob([value.bytes]).stream(),customMetadata:{...value.metadata},etag:value.etag,size:value.bytes.length}:null;}};
}
export async function rehearseHouseholdArchive(objects){
 const summary=await validateObjects(objects);let generations=0;
 for(const object of objects.filter(o=>/\/(daily|monthly)\//.test(o.key))){
  const restored=await restoreIsolated(archivedBucket(objects,object.bucket),object.key,'household');
  try{if(restored.db.prepare('SELECT COUNT(*) n FROM household_accounts WHERE is_active!=0').get().n!==0)fail();generations++;}
  finally{restored.db.close();}
 }
 if(!generations)fail();return {...summary,generations,isolatedRestoreVerified:true};
}
export function householdHistoryStatus(datasets,{observedAt=new Date().toISOString(),lastPlaintextRemovedAt=null,retentionDays=30}={}){
 if(!Number.isFinite(Date.parse(observedAt))||![7,30].includes(retentionDays)||!Array.isArray(datasets)||!datasets.length||datasets.some(d=>![0,1].includes(d.crypto_version)||!Number.isSafeInteger(d.generations)||d.generations<1))fail();
 const plaintextGenerations=datasets.filter(d=>d.crypto_version===0).reduce((n,d)=>n+Number(d.generations),0);
 if(plaintextGenerations)return {state:'blocked_by_current_plaintext',plaintextGenerations,earliestCompletionAt:null,retentionDaysUpperBound:retentionDays};
 if(!lastPlaintextRemovedAt)return {state:'requires_verified_cutover_time',plaintextGenerations:0,earliestCompletionAt:null,retentionDaysUpperBound:retentionDays};
 const cutoff=Date.parse(lastPlaintextRemovedAt);if(!Number.isFinite(cutoff)||cutoff>Date.parse(observedAt))fail();
 const expires=cutoff+retentionDays*86400000;
 return {state:Date.parse(observedAt)>=expires?'retention_window_elapsed':'waiting_for_retention',plaintextGenerations:0,earliestCompletionAt:new Date(expires).toISOString(),retentionDaysUpperBound:retentionDays};
}

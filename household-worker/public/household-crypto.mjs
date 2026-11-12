const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const PREFIX = 'T-lain household v1';
function account(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_:-]{1,180}$/.test(value)) throw new Error('記録のアカウントを確認できません。');
  return value;
}
export function b64(bytes) {
  const data=new Uint8Array(bytes);let text='';
  for(let offset=0;offset<data.length;offset+=32768)text+=String.fromCharCode(...data.subarray(offset,offset+32768));
  return btoa(text).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
export function unb64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) throw new Error('暗号化データの形式が不正です。');
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
}
async function aes(material, context) {
  const base = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(PREFIX), info: enc.encode(context) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(key, bytes, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv: b64(iv), ciphertext: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context), tagLength: 128 }, key, bytes)) };
}
async function open(key, envelope, context) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: enc.encode(context), tagLength: 128 }, key, unb64(envelope.ciphertext)));
}
export async function createClientVault(prf) {
  if (!(prf instanceof Uint8Array) || prf.length !== 32) throw new Error('この環境ではパスキーによる暗号鍵の解除を利用できません。');
  const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  try { return { publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey), ...(await seal(await aes(prf, 'client-private'), raw, `${PREFIX}|client-private`)) }; }
  finally { raw.fill(0); }
}
export async function unlockClient(prf, vault) {
  const bytes = await open(await aes(prf, 'client-private'), vault, `${PREFIX}|client-private`);
  try { return await crypto.subtle.importKey('pkcs8', bytes, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']); }
  finally { bytes.fill(0); }
}
export async function wrapMaster(master, publicKey, accountId) {
  const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  return b64(await crypto.subtle.encrypt({ name: 'RSA-OAEP', label: enc.encode(`${PREFIX}|${account(accountId)}|master`) }, key, master));
}
export async function unwrapMaster(privateKey, wrapped, accountId) {
  const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP', label: enc.encode(`${PREFIX}|${account(accountId)}|master`) }, privateKey, unb64(wrapped)));
  if (bytes.length !== 32) throw new Error('記録用の鍵を確認できません。');
  return bytes;
}
export const keyScope = config => `${account(config.householdId)}:${account(config.keyId)}`;
export async function recordKeys(master) {
  const base=await crypto.subtle.importKey('raw',master,'HKDF',false,['deriveKey']);
  const derive=(info,algorithm,uses)=>crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:enc.encode(PREFIX),info:enc.encode(info)},base,algorithm,false,uses);
  return {aes:await derive('records',{name:'AES-GCM',length:256},['encrypt','decrypt']),index:await derive('record-index',{name:'HMAC',hash:'SHA-256'},['sign'])};
}
export async function opaqueId(keys,config,kind,id) {
  return b64(await crypto.subtle.sign('HMAC',keys.index,enc.encode(`${PREFIX}|${keyScope(config)}|${kind}|${id}`)));
}
export async function encryptRow(keys,config,kind,value) {
  const id=await opaqueId(keys,config,kind,value.id);
  return {kind,id,payload:{version:1,keyId:config.keyId,...await seal(keys.aes,enc.encode(JSON.stringify(value)),`${PREFIX}|${keyScope(config)}|${kind}|${id}`)}};
}
export async function decryptRow(keys,config,row) {
  if(row.payload?.version!==1 || row.payload.keyId!==config.keyId)throw new Error('暗号化データのバージョンを確認してください。');
  const value=JSON.parse(dec.decode(await open(keys.aes,row.payload,`${PREFIX}|${keyScope(config)}|${row.kind}|${row.id}`)));
  if(!value || await opaqueId(keys,config,row.kind,value.id)!==row.id)throw new Error('暗号化データの対応を確認できません。');
  return value;
}

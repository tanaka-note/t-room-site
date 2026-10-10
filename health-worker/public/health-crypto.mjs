const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const PREFIX = 'T-lain health v1';
function account(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,128}$/.test(value)) throw new Error('記録のアカウントを確認できません。');
  return value;
}
export function b64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
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
export async function recordId(master, date, accountId) {
  const material = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(PREFIX), info: enc.encode('record-index') }, material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, enc.encode(`${account(accountId)}|${date}`)));
}
export async function encryptRecord(master, id, value, accountId) { return seal(await aes(master, 'records'), enc.encode(JSON.stringify(value)), `${PREFIX}|${account(accountId)}|${id}`); }
export async function decryptRecord(master, id, envelope, accountId) { return JSON.parse(dec.decode(await open(await aes(master, 'records'), envelope, `${PREFIX}|${account(accountId)}|${id}`))); }

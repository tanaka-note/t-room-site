// Test-only anonymous keys are passed over stdio, never logged or saved.
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
let input = '';
for await (const chunk of process.stdin) { input += chunk; if (input.length > 2 * 1024 * 1024) throw new Error('Fixture too large'); }
const request = JSON.parse(input);
const context = { crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Blob, btoa, atob };
context.window = context;
vm.runInNewContext(await readFile(new URL('../../cloud-worker/public/vendor/argon2.umd.min.js', import.meta.url), 'utf8'), context);
vm.runInNewContext(await readFile(new URL('../../cloud-worker/public/crypto-vault.js', import.meta.url), 'utf8'), context);
if (request.mode === 'device-signature') {
  const key = await webcrypto.subtle.importKey('jwk', request.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const c = request.challenge;
  const message = ['T-ROOM Cloud Storage Windows device authorization v1', 'https://tanaka-note.com/cloud/',
    c.DeviceId, c.ChallengeId, c.Nonce, c.ScopeHash, String(c.ExpiresAt)].join('\n');
  const valid = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(request.signature, 'base64'), new TextEncoder().encode(message));
  const wrongPurpose = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(request.signature, 'base64'), new TextEncoder().encode(message.replace('Windows device authorization', 'file metadata')));
  process.stdout.write(JSON.stringify({ valid, wrongPurpose }));
} else if (request.mode === 'file-package') {
  const folderBytes = Buffer.from(request.folderKey, 'base64');
  const keyBytes = Buffer.from(request.fileKey, 'base64');
  try {
    const folder = await webcrypto.subtle.importKey('raw', folderBytes, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    const fileKey = await webcrypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    const unlocked = await context.TRoomCrypto.unlockFileKey(request.file, folder);
    const metadata = await context.TRoomCrypto.decryptFileMetadata(request.file, unlocked);
    const fileEnvelope = await context.TRoomCrypto.rewrapFileForFolder(fileKey, folder);
    const metadataEnvelope = await context.TRoomCrypto.encryptFileMetadata(request.metadata, fileKey);
    const legacyMetadata = await context.TRoomCrypto.encryptFileMetadata({ name: 'legacy.txt' }, fileKey);
    const child = await context.TRoomCrypto.rewrapFolderForParent(fileKey, folder);
    const name = await context.TRoomCrypto.encryptFolderName('同期用写真', folder);
    process.stdout.write(JSON.stringify({ metadata, fileEnvelope, metadataEnvelope, legacyMetadata, child, name }));
  } finally { folderBytes.fill(0); keyBytes.fill(0); }
} else if (request.mode === 'passkey-envelope') {
  const prf = Buffer.from(request.prf, 'base64');
  try {
    const member = await context.TRoomCrypto.createPasskeyClientVault(prf);
    const accountKey = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const admin = await context.TRoomCrypto.createVault(accountKey);
    const wrappedAdmin = await context.TRoomCrypto.wrapAdminPrivateKeyForPasskey(accountKey, admin.payload, prf);
    process.stdout.write(JSON.stringify({ member: { publicKeyJwk: member.publicKeyJwk,
      encryptedPayload: member.encryptedPayload, payloadIv: member.payloadIv },
      // Security stores a null public key for admin envelopes; Cloud serves it separately.
      administrator: { ...wrappedAdmin, publicKeyJwk: null },
      cryptoConfig: { initialized: true, cryptoVersion: 1, publicKeyJwk: admin.publicKeyJwk } }));
  } finally { prf.fill(0); }
} else {
  const keyBytes = Buffer.from(request.key, 'base64');
  try {
    const key = await webcrypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const envelope = await context.TRoomCrypto.encryptFileChunk(key, Buffer.from(request.plain, 'base64'), request.index);
    const decrypted = await context.TRoomCrypto.decryptFileChunk(key, Buffer.from(request.envelope, 'base64'), request.index);
    process.stdout.write(JSON.stringify({ envelope: Buffer.from(envelope).toString('base64'), plain: Buffer.from(decrypted).toString('base64') }));
  } finally { keyBytes.fill(0); }
}

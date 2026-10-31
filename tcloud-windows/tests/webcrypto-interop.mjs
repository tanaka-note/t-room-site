// Test-only anonymous keys are passed over stdio, never logged or saved.
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
let input = '';
for await (const chunk of process.stdin) { input += chunk; if (input.length > 2 * 1024 * 1024) throw new Error('Fixture too large'); }
const request = JSON.parse(input);
const context = { crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Blob, btoa, atob };
context.window = context;
vm.runInNewContext(await readFile(new URL('../../cloud-worker/public/crypto-vault.js', import.meta.url), 'utf8'), context);
const keyBytes = Buffer.from(request.key, 'base64');
try {
  const key = await webcrypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const envelope = await context.TRoomCrypto.encryptFileChunk(key, Buffer.from(request.plain, 'base64'), request.index);
  const decrypted = await context.TRoomCrypto.decryptFileChunk(key, Buffer.from(request.envelope, 'base64'), request.index);
  process.stdout.write(JSON.stringify({ envelope: Buffer.from(envelope).toString('base64'), plain: Buffer.from(decrypted).toString('base64') }));
} finally { keyBytes.fill(0); }

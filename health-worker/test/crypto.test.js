import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, hkdfSync, createHmac, createCipheriv } from 'node:crypto';
import { fixture } from './fixture.js';
import { unlockClient, unwrapMaster, recordId, encryptRecord, decryptRecord, wrapMaster, createClientVault } from '../public/health-crypto.mjs';

test('authenticated account context retains original record IDs and AAD compatibility',async()=>{
  const master=randomBytes(32),prefix='T-lain health v1',date='2026-01-01';
  try {
    const indexKey=hkdfSync('sha256',master,Buffer.from(prefix),Buffer.from('record-index'),64);
    const legacyId=createHmac('sha256',indexKey).update(`nobumi|${date}`).digest('base64url');
    assert.equal(await recordId(master,date,'nobumi'),legacyId);
    const value={date,note:'legacy encrypted record'},iv=randomBytes(12);
    const cipher=createCipheriv('aes-256-gcm',hkdfSync('sha256',master,Buffer.from(prefix),Buffer.from('records'),32),iv);
    cipher.setAAD(Buffer.from(`${prefix}|nobumi|${legacyId}`));
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64url');
    assert.deepEqual(await decryptRecord(master,legacyId,{iv:iv.toString('base64url'),ciphertext},'nobumi'),value);
    await assert.rejects(decryptRecord(master,legacyId,{iv:iv.toString('base64url'),ciphertext},'other-account'));
    await assert.rejects(recordId(master,date),/アカウント/);
  } finally {master.fill(0);}
});
test('two separate PRFs decrypt the same record; dates and symptoms are absent from the envelope', async () => {
  const f=await fixture();try {
    const id=await recordId(f.master,'2026-01-01', 'nobumi'); const value={date:'2026-01-01',note:'頭痛の記録',symptoms:[1]}; const envelope=await encryptRecord(f.master,id,value, 'nobumi');
    for(const user of Object.values(f.users)){const key=await unwrapMaster(await unlockClient(user.prf,user.bundle.vault),user.bundle.wrappedKey, 'nobumi');assert.deepEqual(await decryptRecord(key,id,envelope, 'nobumi'),value);assert.equal(await recordId(key,'2026-01-01', 'nobumi'),id);key.fill(0);}
    assert.doesNotMatch(JSON.stringify({id,...envelope}),/2026-01-01|頭痛|symptoms/);
    assert.notEqual((await encryptRecord(f.master,id,value, 'nobumi')).iv,envelope.iv);
    await assert.rejects(decryptRecord(f.master,await recordId(f.master,'2026-01-02', 'nobumi'),envelope, 'nobumi'));
    await assert.rejects(decryptRecord(randomBytes(32),id,envelope, 'nobumi'));
    await assert.rejects(unlockClient(f.users.subject.prf,f.users.owner.bundle.vault));
  }finally{f.db.close();f.master.fill(0);}
});
test('existing admin recovery key can re-delegate master to a newly registered passkey',async()=>{
  const admin=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
  const master=randomBytes(32);const publicKey=await crypto.subtle.exportKey('jwk',admin.publicKey);
  const recovered=await unwrapMaster(admin.privateKey,await wrapMaster(master,publicKey, 'nobumi'), 'nobumi');
  const newPrf=randomBytes(32);const vault=await createClientVault(newPrf);const wrapped=await wrapMaster(recovered,vault.publicKey, 'nobumi');
  assert.deepEqual(await unwrapMaster(await unlockClient(newPrf,vault),wrapped, 'nobumi'),new Uint8Array(master));master.fill(0);recovered.fill(0);
});

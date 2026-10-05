import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from './fixture.js';
import { unlockClient, unwrapMaster, recordId, encryptRecord, decryptRecord, wrapMaster, createClientVault } from '../public/health-crypto.mjs';
test('two separate PRFs decrypt the same record; dates and symptoms are absent from the envelope', async () => {
  const f=await fixture();try {
    const id=await recordId(f.master,'2026-01-01'); const value={date:'2026-01-01',note:'頭痛の記録',symptoms:[1]}; const envelope=await encryptRecord(f.master,id,value);
    for(const user of Object.values(f.users)){const key=await unwrapMaster(await unlockClient(user.prf,user.bundle.vault),user.bundle.wrappedKey);assert.deepEqual(await decryptRecord(key,id,envelope),value);assert.equal(await recordId(key,'2026-01-01'),id);key.fill(0);}
    assert.doesNotMatch(JSON.stringify({id,...envelope}),/2026-01-01|頭痛|symptoms/);
    assert.notEqual((await encryptRecord(f.master,id,value)).iv,envelope.iv);
    await assert.rejects(decryptRecord(f.master,await recordId(f.master,'2026-01-02'),envelope));
    await assert.rejects(decryptRecord(randomBytes(32),id,envelope));
    await assert.rejects(unlockClient(f.users.subject.prf,f.users.owner.bundle.vault));
  }finally{f.db.close();f.master.fill(0);}
});
test('existing admin recovery key can re-delegate master to a newly registered passkey',async()=>{
  const admin=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
  const master=randomBytes(32);const publicKey=await crypto.subtle.exportKey('jwk',admin.publicKey);
  const recovered=await unwrapMaster(admin.privateKey,await wrapMaster(master,publicKey));
  const newPrf=randomBytes(32);const vault=await createClientVault(newPrf);const wrapped=await wrapMaster(recovered,vault.publicKey);
  assert.deepEqual(await unwrapMaster(await unlockClient(newPrf,vault),wrapped),new Uint8Array(master));master.fill(0);recovered.fill(0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { startReview } from '../tools/review-server.mjs';
import { importReview } from '../tools/review-import.mjs';
import { encryptRecord, decryptRecord, recordId, unlockClient, unwrapMaster } from '../public/health-crypto.mjs';
test('review handover preserves ciphertext and grants new fixture passkeys without writing keys to disk', async () => {
  const old = await startReview();
  let next;
  try {
    const id = await recordId(old.fixture.master,'2026-01-01');
    const value = {date:'2026-01-01',symptoms:[1],note:'synthetic',start:false,end:false,flow:null};
    const envelope = await encryptRecord(old.fixture.master,id,value);
    old.fixture.db.prepare("INSERT INTO health_records(record_id,account_id,iv,ciphertext,revision) VALUES(?,'nobumi',?,?,7)").run(id,envelope.iv,envelope.ciphertext);
    next = await startReview(0,{source:old.url});
    const row = next.fixture.db.prepare('SELECT iv,ciphertext,revision FROM health_records WHERE record_id=?').get(id);
    assert.equal(row.ciphertext,envelope.ciphertext); assert.equal(row.revision,7);
    for (const person of ['owner','subject']) {
      const {prf,bundle} = next.fixture.users[person];
      const master = await unwrapMaster(await unlockClient(prf,bundle.vault),bundle.wrappedKey);
      try { assert.deepEqual(await decryptRecord(master,id,row),value); } finally { master.fill(0); }
    }
    assert.equal(old.fixture.db.prepare('SELECT ciphertext FROM health_records WHERE record_id=?').get(id).ciphertext,envelope.ciphertext);
  } finally { if(next) await next.close(); await old.close(); }
});
test('review handover rejects remote origins and ambiguous source URLs', async () => {
  for (const source of ['https://tanaka-note.com/health/','http://127.0.0.1:8793/health/?x=1','http://localhost:8793/health/']) await assert.rejects(importReview(source),/ローカル/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {encryptedFixture} from './encryption-fixture.mjs';
import {createEncryptedLedger} from '../public/encrypted-ledger.mjs';

test('authorized bootstrap checks all retained generations and ignores another household when reporting migration readiness',async()=>{
  const f=await encryptedFixture();
  try{
    const original=f.seed(),rows=f.sqlite.prepare("SELECT kind,id,payload FROM household_records WHERE dataset_id='initial'").all();
    assert.equal(f.session.encryptionMigrationRequired,true);
    await f.unlock();
    const ready=await (await f.request('/api/session')).json();assert.equal(ready.encryptionMigrationRequired,false);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM household_datasets WHERE household_id='chiharu' AND crypto_version=0").get().n,1);
    f.sqlite.exec("INSERT INTO household_datasets(id,household_id,retired_at) VALUES('retained-plaintext','main','2026-01-01')");
    for(const row of rows)f.sqlite.prepare('INSERT INTO household_records VALUES(?,?,?,?)').run('retained-plaintext',row.kind,row.id,row.payload);
    const pending=await (await f.request('/api/session')).json();assert.equal(pending.encryptionMigrationRequired,true,'an encrypted active generation must not hide retained plaintext');
    const ledger=createEncryptedLedger(f.api,pending);await ledger.unlock(f.prf.slice());
    assert.deepEqual((await ledger.load()).data,original);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM household_datasets WHERE household_id='main' AND crypto_version=0").get().n,0);
    ledger.clear();
  }finally{f.close();}
});

test('a migrated session loads data without migration/sharing requests; optional sharing cannot block data and coalesces concurrent refreshes',async()=>{
  const f=await encryptedFixture();let release;
  try{
    f.seed();const expected=await f.unlock(),session=await (await f.request('/api/session')).json(),paths=[];
    const gate=new Promise(resolve=>{release=resolve;});
    const api=async(path,body)=>{paths.push(path);if(path==='/keys/automatic')await gate;return f.api(path,body);};
    const ledger=createEncryptedLedger(api,session);await ledger.unlock(f.prf.slice());
    assert.deepEqual((await ledger.load()).data,expected.data);assert.deepEqual(paths,['/data']);
    const sharing=ledger.refreshSharedKeys({force:true}),duplicate=ledger.refreshSharedKeys({force:true});
    assert.deepEqual((await ledger.load()).data,expected.data,'a held sharing response must not delay financial data');
    assert.equal(paths.filter(p=>p==='/keys/automatic').length,1);
    release();await Promise.all([sharing,duplicate]);
    await ledger.refreshSharedKeys();assert.equal(paths.filter(p=>p==='/keys/automatic').length,1,'ordinary sharing retains its one-minute throttle');
    ledger.clear();
  }finally{release?.();f.close();}
});

test('missing migration hints still migrate, and discarded or unauthorized sharing never succeeds',async()=>{
  const f=await encryptedFixture();let release;
  try{
    const expected=f.seed(),legacy={...f.session};delete legacy.encryptionMigrationRequired;
    const ledger=createEncryptedLedger(f.api,legacy);await ledger.unlock(f.prf.slice());assert.deepEqual((await ledger.load()).data,expected);ledger.clear();
    const session=await (await f.request('/api/session')).json(),gate=new Promise(resolve=>{release=resolve;});let writes=0;
    const api=async(path,body)=>{if(path==='/keys/automatic')await gate;if(body)writes++;return f.api(path,body);};
    const pending=createEncryptedLedger(api,session);await pending.unlock(f.prf.slice());
    const sharing=pending.refreshSharedKeys({force:true});pending.clear();release();
    await assert.rejects(sharing,e=>e.discarded===true);assert.equal(writes,0);
    const revoked=createEncryptedLedger(f.api,session);await revoked.unlock(f.prf.slice());f.setActive(false);
    await assert.rejects(revoked.refreshSharedKeys({force:true}),e=>e.status===401);
    await assert.rejects(revoked.load(),e=>e.status===401);revoked.clear();
  }finally{release?.();f.close();}
});

// Synthetic local CPU/SQLite measurement; not a production or real-PRF guarantee.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {encryptedFixture} from './encryption-fixture.mjs';
const count=Number(process.argv[2]||1000);
if(!Number.isSafeInteger(count)||count<1||count>20000)throw new Error('Use 1..20000 synthetic entries');
const f=await encryptedFixture();
try{
  const original=f.seed(),sample=original.transactions[0],insert=f.sqlite.prepare("INSERT INTO household_records VALUES('initial','transactions',?,?)");
  for(let i=1;i<count;i++){const value={...sample,id:crypto.randomUUID(),registrationOrder:i+1};insert.run(value.id,JSON.stringify(value));}
  let start=performance.now();const first=await f.unlock(),migrationMs=performance.now()-start;
  assert.equal(first.data.transactions.length,count);
  start=performance.now();await f.ledger.mutate(first.data,'transaction.save',{...first.data.transactions[0],amount:54321},first.revision,crypto.randomUUID());
  const saved=await f.ledger.load(),saveMs=performance.now()-start;
  assert.equal(saved.data.transactions.length,count);assert.ok(saved.data.transactions.some(t=>t.amount===54321));
  start=performance.now();const backup=await f.ledger.backup(),restored=await f.ledger.readBackup(backup),backupMs=performance.now()-start;
  assert.equal(restored.transactions.length,count);
  console.log(JSON.stringify({entries:count,migrationAndColdLoadMs:Math.round(migrationMs),deltaSaveAndWarmLoadMs:Math.round(saveMs),backupAndVerifyMs:Math.round(backupMs),backupMiB:Number((JSON.stringify(backup).length/1024/1024).toFixed(2))}));
}finally{f.close();}

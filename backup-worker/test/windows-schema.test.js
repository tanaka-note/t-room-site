import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database,d1 } from './fixtures.mjs';
import { assertSchema } from '../src/schema-guard.js';
import { capture } from '../src/backup.js';
for(const [service,migration] of [['security','0032_windows_device_authority.sql'],['cloud','0014_windows_device_grants.sql']])
test(`${service} backup accepts only the exact optional Windows authorization schema`,async()=>{
  const db=database(service);
  try {
    const schema=()=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all();
    await assertSchema(service,schema());
    db.exec(readFileSync(new URL(`../../${service}-worker/migrations/${migration}`,import.meta.url),'utf8'));
    await assertSchema(service,schema());
    const backup=await capture(d1(db),service);
    assert.equal(Object.keys(backup.tables).some(name=>name.includes('windows')),false,'authorization is not automatically restored from a data backup');
    if(service==='security')db.exec('DROP TRIGGER windows_link_delete');
    else db.exec('DROP INDEX cloud_windows_access_expiry');
    await assert.rejects(assertSchema(service,schema()),/SchemaReviewRequired/);
  } finally {db.close();}
});

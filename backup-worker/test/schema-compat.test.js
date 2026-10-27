import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {database} from './fixtures.mjs';
import {assertSchema,reviewedSchemaMatches} from '../src/schema-guard.js';
import {digest} from '../src/integrity.js';

// Schema metadata only: no production rows, credentials or key material.
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/reviewed-production-ddl.json',import.meta.url),'utf8'));
const tokens=sql=>sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[^\s]/g);
const hash=rows=>digest(new TextEncoder().encode(JSON.stringify(rows.map(r=>[r.type,r.name,r.tbl_name,r.sql.replace(/\r\n?/g,'\n')]))));
for(const fixture of fixtures)test(`reviewed ${fixture.service} DDL remains exact, bounded and migration-pinned`,async()=>{
 const db=database(fixture.service);
 try{
  const rows=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all();
  const baseline=await hash(rows);
  await assertSchema(fixture.service,rows);
  for(const ddl of fixture.ddl){
   const row=rows.find(r=>r.name===ddl.name);assert.ok(row);
   // The only semantic difference is an existing stronger password work factor.
   const comparable=fixture.service==='billing'&&ddl.name==='billing_accounts'
    ?ddl.sql.replace('DEFAULT 210000','DEFAULT 100000'):ddl.sql;
   assert.deepEqual(tokens(comparable),tokens(row.sql));
   row.sql=ddl.sql;
  }
  await assertSchema(fixture.service,rows);
  const deployed=await hash(rows);
  assert.ok(reviewedSchemaMatches(fixture.service,baseline,deployed));
  assert.equal(reviewedSchemaMatches(fixture.service,'future-migration',deployed),false);
  assert.equal(reviewedSchemaMatches('unknown',undefined,undefined),false);
  const changed=structuredClone(rows);
  changed.find(r=>r.type==='table').sql+=' /* unreviewed DDL */';
  await assert.rejects(assertSchema(fixture.service,changed),/SchemaReviewRequired/);
  rows.push({type:'index',name:'unexpected',tbl_name:'unexpected',sql:'CREATE INDEX unexpected ON unexpected(id)'});
  await assert.rejects(assertSchema(fixture.service,rows),/SchemaReviewRequired/);
 }finally{db.close();}
});

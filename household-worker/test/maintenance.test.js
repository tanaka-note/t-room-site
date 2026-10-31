import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.js';
import {backup} from '../src/domain.js';

test('cleanup preserves active, leased and newest three generations; preview/confirmation, replay and revision are enforced',async()=>{
 const f=fixture();try{await f.login();const initial=await f.state(),active=f.sqlite.prepare("SELECT active_dataset id FROM household_state").get().id;
 const ds=f.sqlite.prepare('INSERT INTO household_datasets VALUES(?,?,?,?,?)'),row=f.sqlite.prepare('INSERT INTO household_records VALUES(?,?,?,?)');
 for(let i=0;i<6;i++){ds.run('old'+i,'2020-01-01','2020-01-01',`2020-01-0${i+1}`,null);row.run('old'+i,'transactions','synthetic','{}');}
 ds.run('in-progress','2020-01-01',null,null,'2999-01-01');row.run('in-progress','transactions','synthetic','{}');
 f.sqlite.prepare("UPDATE household_datasets SET created_at='2020-01-01',activated_at='2020-01-01' WHERE id=?").run(active);
 const receipt=f.sqlite.prepare('INSERT INTO household_requests VALUES(?,?,?,?)');for(let i=0;i<1005;i++)receipt.run('old-request-'+String(i).padStart(4,'0'),'old','{}','2020-01-01');receipt.run('recent','new','{}','2999-01-01');
 const preview=await (await f.request('/api/maintenance/preview')).json();assert.equal(preview.requestCount,1000);assert.equal(preview.datasetCount,3);assert.equal(preview.recordCount,3);
 const body={requestId:crypto.randomUUID(),expectedRevision:initial.revision,planFingerprint:preview.planFingerprint,confirmCleanup:true};
 assert.equal((await f.request('/api/maintenance',{...body,confirmCleanup:false})).status,400);
 assert.equal((await f.request('/api/maintenance',{...body,planFingerprint:'stale'})).status,409);
 const response=await f.request('/api/maintenance',body);assert.equal(response.status,200);assert.equal((await f.request('/api/maintenance',body)).status,200);
 assert.deepEqual((await f.state()).data,initial.data);assert.equal((await f.state()).revision,initial.revision+1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM household_requests').get().n,7);
 assert.deepEqual(f.sqlite.prepare('SELECT id FROM household_datasets ORDER BY id').all().map(r=>r.id),[active,'in-progress','old3','old4','old5'].sort());
 const again=await (await f.request('/api/maintenance/preview')).json();await f.mutate('category.save',{id:crypto.randomUUID(),parent:'その他',name:'Concurrent change'});
 assert.equal((await f.request('/api/maintenance',{...body,requestId:crypto.randomUUID(),expectedRevision:again.revision,planFingerprint:again.planFingerprint})).status,409);
 }finally{f.close();}
});
test('cleanup cannot be called by viewer or a cross-origin request; restore metadata switches atomically',async()=>{
 const f=fixture(),viewer=fixture('viewer');try{await f.login();await viewer.login();assert.equal((await viewer.request('/api/maintenance/preview')).status,403);assert.equal((await viewer.request('/api/maintenance',{})).status,403);
 assert.equal((await f.request('/api/maintenance',{}, {Origin:'https://untrusted.test'})).status,403);
 const saved=backup((await f.state()).data);assert.equal((await f.request('/api/restore',{requestId:crypto.randomUUID(),expectedRevision:0,backup:saved})).status,200);
 const current=f.sqlite.prepare('SELECT active_dataset id FROM household_state').get().id,rows=f.sqlite.prepare('SELECT * FROM household_datasets').all();assert.equal(rows.length,2);assert.ok(rows.find(r=>r.id!==current).retired_at);assert.ok(rows.find(r=>r.id===current).activated_at);assert.equal(rows.find(r=>r.id===current).lease_expires_at,null);
 }finally{f.close();viewer.close();}
});
test('lease renewal between preview revalidation and commit rolls back cleanup and its receipt',async()=>{
 const f=fixture();try{await f.login();f.sqlite.exec("INSERT INTO household_datasets VALUES('staging','2020-01-01',NULL,NULL,'2020-01-02'); INSERT INTO household_records VALUES('staging','transactions','synthetic','{}')");
 const plan=await (await f.request('/api/maintenance/preview')).json();assert.equal(plan.datasetCount,1);
 const batch=f.env.DB.batch;f.env.DB.batch=async statements=>{f.sqlite.exec("UPDATE household_datasets SET lease_expires_at='2999-01-01' WHERE id='staging'");return batch.call(f.env.DB,statements);};
 const requestId=crypto.randomUUID();assert.equal((await f.request('/api/maintenance',{requestId,expectedRevision:0,planFingerprint:plan.planFingerprint,confirmCleanup:true})).status,409);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM household_records WHERE dataset_id='staging'").get().n,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM household_requests WHERE request_id=?').get(requestId).n,0);assert.equal((await f.state()).revision,0);
 }finally{f.close();}
});

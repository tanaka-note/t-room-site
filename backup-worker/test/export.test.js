import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DATABASES, exportSpec, exportPrefix, saveExport, readExportManifest, readExportParts, pruneExports } from '../src/export-backup.js';
import { dispatchBackup, dispatchServices } from '../src/dispatch.js';
import { SERVICES } from '../src/registry.js';
import { withExportLease } from '../src/export-lease.js';
import { executeExportWorkflow } from '../src/workflow-run.js';
import { sqlStatements, exportedRows } from '../src/export-sql.js';
import { compress, verifiedPut, digest } from '../src/integrity.js';
import { database, d1, Bucket, recorder } from './fixtures.mjs';
import { sqlDump, sqlStream, exportEnv, exportFetcher } from './export-fixtures.mjs';
import { restoreIsolated } from '../tools/restore-isolated.mjs';
import { runScheduledDiaryBackup } from '../../diary-worker/src/backup.js';
import { storageSnapshot } from '../src/browser.js';
import { scanBackupMetadata } from '../../diary-worker/src/backup-browser.js';

const now = Date.parse('2026-11-01T18:25:00Z'), noSleep = async () => {};

test('existing Backup-data summaries show export generations and count monthly-shared parts only once',async()=>{
  for(const service of ['health','diary']) {
    const source=database(service),bucket=new Bucket();
    try {
      if(service==='health')source.exec("INSERT INTO health_records VALUES('fixture','nobumi','iv','ciphertext',1,'now')");
      const mock=exportFetcher(source,service),env=exportEnv(service,d1(source),bucket);
      await saveExport(env,service,now,{fetcher:mock.fetcher,sleep:noSleep});
      const physical=[...bucket.objects.values()].reduce((n,o)=>n+o.bytes.length,0);
      if(service==='diary') {
        const snapshot=await scanBackupMetadata(bucket);
        assert.equal(snapshot.backupBytes,physical);assert.equal(snapshot.d1Bytes,physical);
        assert.equal(snapshot.daily.objectCount,1);assert.equal(snapshot.monthly.objectCount,1);
        assert.equal(snapshot.daily.objects[0].backupScope,'d1-only');
      }else{
        const snapshot=await storageSnapshot(env,false,null),item=snapshot.services.find(s=>s.id===service);
        assert.equal(item.bytes,physical);assert.equal(item.daily.length,1);assert.equal(item.monthly.length,1);
      }
    }finally{source.close();}
  }
});

test('SQL tokenizer preserves quote/comment delimiters, UTF8, NUL and rows across every byte boundary without executing SQL', async () => {
  const tables = [{ name: 't', sourceColumns: 'id,secret,text', columns: ['id','text'] }];
  const sql = `-- heading\nPRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "t" VALUES(1,'exclude-me','日記; ''quoted'' -- /* text */' || char(0));\n/* next */ INSERT INTO [t] (text,secret,id) VALUES('改行\n文字','omit',2),('x','omit',3);`;
  const rows = [];
  for await (const statement of sqlStatements(sqlStream(sql,1))) rows.push(...exportedRows(statement,tables));
  assert.deepEqual(rows.map(r=>r.row), [{id:1,text:"日記; 'quoted' -- /* text */\0"},{id:2,text:'改行\n文字'},{id:3,text:'x'}]);
  for (const bad of ["INSERT INTO t VALUES(1,'s','truncated'",'ATTACH DATABASE \'file\' AS x;','INSERT INTO t SELECT 1,2,3;',"INSERT INTO t VALUES(1,'s',load_extension('x'));",'INSERT INTO t VALUES(9007199254740993,\'s\',\'x\');']) {
    await assert.rejects(async()=>{for await(const stmt of sqlStatements(sqlStream(bad,2))) [...exportedRows(stmt,tables)];});
  }
});

test('every scheduled service plus Diary has a Workflow DB ID and correctly scoped bindings, retaining the original schedules',()=>{
  const backup=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url)));
  assert.deepEqual(Object.keys(DATABASES).sort(),[...Object.keys(SERVICES),'diary'].sort());
  for(const [service,id] of Object.entries(DATABASES))assert.equal(backup.d1_databases.find(d=>d.binding===exportSpec(service).binding)?.database_id,id);
  assert.ok(!backup.r2_buckets.some(b=>b.bucket_name==='t-room-cloud-private'));
  const diary=JSON.parse(readFileSync(new URL('../../diary-worker/wrangler.jsonc',import.meta.url)));
  assert.deepEqual(diary.triggers.crons,['25 18 * * *','55 18 * * *','45 0-2,19-23 * * *','5,15,25,35,55 19,20 * * *']);
  assert.equal(diary.workflows[0].script_name,backup.name);
});

test('official data-only export syntax from actual workerd restores every registered service in isolation', {timeout:120000}, async()=>{
  const { Miniflare, convertV4MiniflareOptions }=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)))('miniflare');
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-11',d1Databases:Object.fromEntries(Object.keys(DATABASES).map(id=>[id,id]))}));
  try {
    for(const service of Object.keys(DATABASES)) {
      const source=database(service),db=await mf.getD1Database(service),bucket=new Bucket(); let restored;
      try {
        const schema=source.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name").all();
        await db.batch(schema.map(s=>db.prepare(s.sql)));
        if(service==='health')await db.prepare("INSERT INTO health_records VALUES('fixture','nobumi','iv',?,1,'2026-01-01')").bind("日本語 ' quote\nnewline\0nul").run();
        const dump=await db.prepare('PRAGMA miniflare_d1_export(?,?,?);').bind(true,false,...exportSpec(service).tables.map(t=>t.name)).raw();
        const mock=exportFetcher(source,service,{sql:dump[0].join('\n'),size:37});
        const saved=await saveExport(exportEnv(service,db,bucket),service,now,{fetcher:mock.fetcher,sleep:noSleep});
        restored=await restoreIsolated(bucket,saved.daily,service);
        assert.equal(restored.payload.service,service);
        assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
        if(service==='health')assert.equal(restored.db.prepare('SELECT ciphertext FROM health_records').get().ciphertext,"日本語 ' quote\nnewline\0nul");
        if(service==='diary')assert.equal(restored.photoPayload.formatVersion,8);
        const manifest=await readExportManifest(bucket,saved.daily,service);
        for await(const part of readExportParts(bucket,manifest.payload,service)) for(const row of part.rows) {
          assert.ok(!Object.hasOwn(row,'password_hash'));assert.ok(!Object.hasOwn(row,'login_id'));
        }
      } finally {restored?.db.close();source.close();}
    }
  } finally {await mf.dispose();}
});

test('50,000 audit rows above both old bounds are saved, verified, restored, and monthly data is shared', {timeout:120000},async()=>{
  const source=database('cloud'),bucket=new Bucket();let restored;
  try {
    source.exec('BEGIN');const insert=source.prepare("INSERT INTO cloud_audit_logs(event_type,actor_role,details_json) VALUES('fixture','admin',?)");
    for(let i=0;i<50000;i++)insert.run(JSON.stringify({i,text:'synthetic '.repeat(32)}));source.exec('COMMIT');
    const mock=exportFetcher(source,'cloud',{onStart(){source.exec("INSERT INTO cloud_audit_logs(event_type,actor_role,details_json) VALUES('later','admin','{}')");}});
    const saved=await saveExport(exportEnv('cloud',d1(source),bucket),'cloud',now,{fetcher:mock.fetcher,sleep:noSleep});
    const manifest=(await readExportManifest(bucket,saved.daily,'cloud')).payload;
    assert.equal(manifest.tables.cloud_audit_logs.rowCount,50000,'all parts must use the fixed export rather than paging live D1');
    assert.ok(manifest.parts.length>1);
    assert.equal(await digest(bucket.objects.get(saved.daily).bytes),await digest(bucket.objects.get(saved.monthly).bytes));
    restored=await restoreIsolated(bucket,saved.daily,'cloud');
    assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM cloud_audit_logs').get().n,50000);
    const calls=mock.calls.length;
    await saveExport(exportEnv('cloud',d1(source),bucket),'cloud',now,{fetcher:mock.fetcher,sleep:noSleep});
    assert.equal(mock.calls.length,calls,'same-day reruns verify and reuse the existing generation');
  }finally{restored?.db.close();source.close();}
});

test('monthly failures resume from daily; damaged or semantically invalid parts cannot pass or erase prior backups',async()=>{
  const source=database('health'),bucket=new Bucket(),env=exportEnv('health',d1(source),bucket),mock=exportFetcher(source,'health');
  source.exec("INSERT INTO health_records VALUES('fixture','nobumi','iv','ciphertext',1,'now')");
  const put=bucket.put.bind(bucket);let failMonthly=true;
  bucket.put=async(key,...args)=>{if(failMonthly&&key.includes('/monthly/'))throw new Error('fixture failure');return put(key,...args);};
  try {
    await assert.rejects(saveExport(env,'health',now,{fetcher:mock.fetcher,sleep:noSleep}));
    const daily='d1/health/v3/daily/2026-11-02.json.gz';assert.ok(bucket.objects.has(daily));
    failMonthly=false;const calls=mock.calls.length;
    await saveExport(env,'health',now,{fetcher:mock.fetcher,sleep:noSleep});assert.equal(mock.calls.length,calls);
    const manifest=(await readExportManifest(bucket,daily,'health')).payload;
    bucket.objects.get(manifest.parts[0].key).bytes=new Uint8Array([0]);
    await assert.rejects(saveExport(env,'health',now,{fetcher:mock.fetcher,sleep:noSleep}));
    assert.ok(bucket.objects.has(daily));
  }finally{source.close();}
});

test('retention preserves monthly references and checks retained parts before deleting anything',async()=>{
  const source=database('health'),bucket=new Bucket(),env=exportEnv('health',d1(source),bucket),mock=exportFetcher(source,'health');
  source.exec("INSERT INTO health_records VALUES('fixture','nobumi','iv','ciphertext',1,'now')");
  try {
    const first=await saveExport(env,'health',Date.parse('2026-01-01T00:00Z'),{fetcher:mock.fetcher,sleep:noSleep});
    const old=(await readExportManifest(bucket,first.daily,'health')).payload;
    for(let i=2;i<=33;i++)await saveExport(env,'health',Date.parse('2026-01-01T00:00Z')+(i-1)*86400000,{fetcher:mock.fetcher,sleep:noSleep});
    for(let i=0;i<14;i++)await saveExport(env,'health',Date.UTC(2024,i,1),{fetcher:mock.fetcher,sleep:noSleep});
    await pruneExports(bucket,'health');
    assert.equal((await bucket.list({prefix:'d1/health/v3/daily/'})).objects.length,30);
    assert.equal((await bucket.list({prefix:'d1/health/v3/monthly/'})).objects.length,12);
    assert.ok(bucket.objects.has(old.parts[0].key),'January monthly still references the first daily part');
    await readExportManifest(bucket,first.monthly,'health');
    const head=bucket.head.bind(bucket);bucket.head=async()=>null;
    const count=bucket.objects.size;
    await assert.rejects(pruneExports(bucket,'health'));
    assert.equal(bucket.objects.size,count);bucket.head=head;
  }finally{source.close();}
});

test('global R2 lease excludes overlapping jobs and a stale owner cannot release or mutate after expiry',async()=>{
  const bucket=new Bucket();let clock=1000;
  await withExportLease(bucket,'health',async guard=>{
    await assert.rejects(withExportLease(bucket,'health',async()=>{},()=>clock),/ConcurrentWrite/);
    clock+=21*60000;
    await withExportLease(bucket,'health',async()=>{await assert.rejects(guard(),/ConcurrentWrite/);},()=>clock);
    await assert.rejects(guard(),/ConcurrentWrite/);
  },()=>clock);
  await withExportLease(bucket,'health',async()=>{},()=>clock);
});

test('Cron dispatches every DB despite one queue failure; repeated dispatch never reports a failed instance as queued',async t=>{
  t.mock.method(console,'error',()=>{});const calls=[];
  await assert.rejects(dispatchServices({D1_BACKUPS:{async create({params}){calls.push(params.service);if(params.service==='cloud')throw new Error('hidden');},get(){return{async status(){return{status:'errored'};}};}}},now),/BackupDispatchFailed/);
  assert.deepEqual(calls.sort(),Object.keys(SERVICES).sort());
  const env={D1_BACKUPS:{async create(){throw new Error('duplicate');},get(){return{async status(){return{status:'complete'};}};}}};
  assert.equal((await dispatchBackup(env,'diary',now)).scheduled,true);
  const audit=recorder();assert.deepEqual(await runScheduledDiaryBackup({...env,...audit},now),{complete:true,scheduled:true});assert.equal(audit.events.length,0,'dispatch is never recorded as backup success');
});

test('Workflow errors and persisted step results never expose provider SQL, credentials or signed URLs',async t=>{
  const bucket=new Bucket(),source=database('health'),audit=recorder(),env={...exportEnv('health',d1(source),bucket),...audit};const errors=[];
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('private-SQL signed_url fixture-credential');});
  const step={async sleep(){},async do(name,options,fn){try{return await (fn||options)();}catch(e){errors.push(e.message);throw e;}}};
  try {await assert.rejects(executeExportWorkflow(env,{service:'health',scheduledTime:now},step),/D1BackupFailed/);
    assert.doesNotMatch(JSON.stringify({errors,events:audit.events}),/private-SQL|signed_url|fixture-credential/);
    assert.equal(audit.events.at(-1).eventType,'backup_failed');
  }finally{source.close();}
});

for(const mode of ['success','success-audit-unavailable','retention-failed'])test(`Workflow reports the actual storage outcome: ${mode}`,async t=>{
  const bucket=new Bucket(),source=database('health'),audit=recorder(),env={...exportEnv('health',d1(source),bucket),...audit};
  source.exec("INSERT INTO health_records VALUES('fixture','nobumi','iv','ciphertext',1,'now')");
  const mock=exportFetcher(source,'health');t.mock.method(globalThis,'fetch',mock.fetcher);
  if(mode==='success-audit-unavailable')env.SECURITY={async recordAuditEvent(event){if(event.eventType==='backup_succeeded')throw new Error('fixture-credential');return audit.SECURITY.recordAuditEvent(event);}};
  if(mode==='retention-failed'){
    const head=bucket.head.bind(bucket);bucket.head=async key=>key.includes('/data/')?null:head(key);
  }
  const values=[],errors=[];
  const step={async sleep(){},async do(name,options,fn){try{const value=await(fn||options)();values.push(value);return value;}catch(e){errors.push(e.message);throw e;}}};
  try {
    if(mode==='success')assert.deepEqual(await executeExportWorkflow(env,{service:'health',scheduledTime:now},step),{service:'health',state:'ok'});
    else await assert.rejects(executeExportWorkflow(env,{service:'health',scheduledTime:now},step),/D1BackupFailed/);
    assert.equal(audit.events.at(-1).eventType,mode==='success'?'backup_succeeded':mode==='retention-failed'?'backup_prune_failed':'backup_failed');
    assert.doesNotMatch(JSON.stringify({values,errors,events:audit.events}),/fixture-credential|signature=|ciphertext|health_records/);
  }finally{source.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {database,d1,Bucket,recorder} from './fixtures.mjs';
import {SERVICES} from '../src/registry.js';
import {backupService,capture,decode} from '../src/backup.js';
import {getBackupSnapshot} from '../src/browser.js';
import {restoreIsolated} from '../tools/restore-isolated.mjs';
import {portfolioApi} from '../../portfolio-worker/src/api.js';

function seed(db) {
 const metadata={schemaVersion:1,period:'2026-10-31',basePrincipal:1000000,
  realizedProfit:{name:'Synthetic realized gain',value:0},performanceAdjustmentName:'Synthetic adjustment',
  performanceAdjustmentSnapshots:[],monthlyReport:{entries:[]}};
 const categories=['米株','インド株','ビットコイン','日本株'],colors=['#ff8a61','#f4ca64','#a98cff','#52e6aa'];
 const assets=categories.map((category,i)=>({id:'sample-'+i,name:'Synthetic holding '+i,category,color:colors[i],marketValue:300000}));
 db.prepare("INSERT INTO portfolio_state VALUES('main',0,?)").run(JSON.stringify(metadata));
 const insert=db.prepare('INSERT INTO portfolio_records VALUES(?,?,?,?,?,?)');
 insert.run('2026-10-30',null,1100000,null,'2026-10-31T00:00:00Z','legacy-import');
 insert.run('2026-10-31',null,1200000,JSON.stringify(assets),'2026-10-31T00:00:00Z','legacy-import');
 return assets;
}
async function save(db,record) {
 const expectedRevision=db.prepare("SELECT revision FROM portfolio_state WHERE id='main'").get().revision;
 const request=new Request('https://example.test/asset-report/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({record,expectedRevision,requestId:crypto.randomUUID()})});
 const response=await portfolioApi(request,{DB:d1(db)},'/api/save',{role:'owner',serviceAccountId:'owner'},r=>r.json(),async()=>{});
 assert.equal(response.status,200);
}
const rows=(db,table)=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
function scheduledWorker() {
 const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'')
  .replace('export class BackupBrowserIntegration','class BackupBrowserIntegration').replace('export default {','globalThis.worker = {');
 const calls=[],context={WorkerEntrypoint:class{},SERVICES,crypto,getBackupSnapshot,console:{log(){},error(){}},
  backupService:async(env,id,now)=>{calls.push({id,now});return id==='portfolio'?backupService(env,id,now,async()=>{}):{state:'ok'};}};
 vm.runInNewContext(source,context);return {worker:context.worker,calls};
}

test('Portfolio shares the existing 03:40 JST invocation and restores updated, backdated and corrected records plus revision history in isolation',async()=>{
 const db=database('portfolio'),bucket=new Bucket(),audit=recorder();let restored;
 try{
  const assets=seed(db);assets[0].name='Updated synthetic holding';assets[0].marketValue=350000;
  await save(db,{period:'2026-10-31',time:'14:35',assets});
  await save(db,{period:'2026-10-29',time:'09:15',assets:assets.map(a=>({...a,marketValue:250000}))});
  await save(db,{period:'2026-10-30',time:'10:05',assets:null,rawMarketValue:1150000});
  const before=Object.fromEntries(SERVICES.portfolio.tables.map(t=>[t.name,rows(db,t.name)]));
  assert.equal(before.portfolio_changes.length,3);assert.equal(before.portfolio_state[0].revision,3);
  const scheduledTime=Date.parse('2026-11-01T18:40:00Z'),env={PORTFOLIO_DB:d1(db),BACKUP:bucket,...audit};
  const h=scheduledWorker();await h.worker.scheduled({scheduledTime},env);
  assert.equal(h.calls.filter(c=>c.id==='portfolio').length,1);
  assert.ok(h.calls.every(c=>c.now===scheduledTime),'all services must use the same scheduled time');
  const key='d1/portfolio/v2/daily/2026-11-02.json.gz';
  assert.ok(bucket.objects.has(key));assert.ok(bucket.objects.has('d1/portfolio/v2/monthly/2026-11.json.gz'));
  const snapshot=await decode(bucket.objects.get(key).bytes);
  assert.equal(snapshot.scheduledFor,'2026-11-01T18:40:00.000Z');assert.equal(snapshot.consistency,'single-database-transaction');
  assert.equal(snapshot.expectedMigration,'0001_portfolio.sql');
  for(const t of SERVICES.portfolio.tables)assert.deepEqual(snapshot.tables[t.name].rows,before[t.name].map(r=>({...r})),t.name);
  restored=await restoreIsolated(bucket,key,'portfolio');
  for(const name of ['portfolio_state','portfolio_records','portfolio_changes'])assert.deepEqual(rows(restored.db,name),before[name],name);
  assert.ok(rows(restored.db,'portfolio_accounts').every(a=>a.is_active===0&&a.session_version===2),'restoration must not reactivate accounts or sessions');
  assert.deepEqual(restored.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  const state=restored.db.prepare("SELECT revision FROM portfolio_state WHERE id='main'").get();
  restored.db.prepare("UPDATE portfolio_state SET revision=revision+1 WHERE id='main'").run();
  assert.equal(restored.db.prepare("SELECT revision FROM portfolio_state WHERE id='main'").get().revision,state.revision+1);
  assert.throws(()=>restored.db.prepare("UPDATE portfolio_state SET revision=revision+2 WHERE id='main'").run(),/revision conflict/,'revision trigger must be restored');
  for(const t of SERVICES.portfolio.tables)assert.deepEqual(rows(db,t.name),before[t.name],'backup must not mutate source');
  assert.ok(audit.events.some(e=>e.service==='portfolio'&&e.eventType==='backup_succeeded'));
  const statusDb={prepare(){return{bind(){return{async all(){return{results:[]};}};}};}};
  const browser=await getBackupSnapshot({...env,SECURITY_DB:statusDb},{},null),entry=browser.services.find(s=>s.id==='portfolio');
  assert.equal(entry.label,'資産運用報告');assert.equal(entry.daily.length,1);assert.equal(entry.monthly.length,1);
  const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  const app=JSON.parse(readFileSync(new URL('../../portfolio-worker/wrangler.jsonc',import.meta.url),'utf8'));
  assert.deepEqual(config.triggers.crons,['40 18 * * *'],'reuse the existing shared schedule');
  assert.equal(config.d1_databases.find(d=>d.binding==='PORTFOLIO_DB').database_id,app.d1_databases.find(d=>d.binding==='DB').database_id);
  assert.deepEqual(config.r2_buckets,[{binding:'BACKUP',bucket_name:'t-room-service-backups'}]);
  assert.doesNotMatch(JSON.stringify(snapshot.tables),/SESSION_SECRET|credential_id|Cookie/);
 }finally{restored?.db.close();db.close();}
});

test('Portfolio unknown schema stops saving and preserves existing recovery points',async()=>{
 const db=database('portfolio'),bucket=new Bucket(),audit=recorder();
 try{seed(db);const env={PORTFOLIO_DB:d1(db),BACKUP:bucket,...audit};
  assert.equal((await backupService(env,'portfolio',Date.parse('2026-11-01T18:40:00Z'),async()=>{})).state,'ok');
  const prior=[...bucket.objects.keys()].filter(k=>k.includes('/daily/'));
  db.exec('ALTER TABLE portfolio_records ADD COLUMN unreviewed TEXT');
  await assert.rejects(capture(d1(db),'portfolio'),/SchemaReviewRequired/);
  assert.equal((await backupService(env,'portfolio',Date.parse('2026-11-02T18:40:00Z'),async()=>{})).state,'failed');
  assert.deepEqual([...bucket.objects.keys()].filter(k=>k.includes('/daily/')),prior);
  assert.ok(audit.events.some(e=>e.service==='portfolio'&&e.eventType==='backup_failed'&&e.details.reason==='schema_review_required'));
 }finally{db.close();}
});

test('Backup-data refreshes a cached list that predates Portfolio',async()=>{
 const bucket=new Bucket();let lists=0;const list=bucket.list.bind(bucket);bucket.list=async opts=>{lists++;return list(opts);};
 const cache={async match(){return Response.json({services:Object.entries(SERVICES).filter(([id])=>id!=='portfolio').map(([id,s])=>({id,label:s.label})).concat({id:'security-audit'}),observedAt:new Date().toISOString()});},async put(){}};
 const db={prepare(){return{bind(){return{async all(){return{results:[]};}};}};}};
 const snapshot=await getBackupSnapshot({BACKUP:bucket,SECURITY_DB:db},{},cache);
 assert.ok(lists>0);assert.ok(snapshot.services.some(s=>s.id==='portfolio'));
});

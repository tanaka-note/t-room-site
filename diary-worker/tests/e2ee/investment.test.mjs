import assert from 'node:assert/strict';import {test} from 'node:test';import {readFileSync} from 'node:fs';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {systemFixture} from './system-fixture.mjs';
import {LEGACY_TABLES,prepareMigration} from '../../e2ee/migration.mjs';
import {handleDiaryKeys,diaryKeyBundle} from '../../../security-worker/src/diary-keys.js';
import {unlockSession} from '../../e2ee/session.mjs';
import {bindingOf} from '../../e2ee/record.mjs';
import {open,signed} from '../../e2ee/crypto.mjs';
import {investmentRecords,sealInvestment,investmentProposal} from '../../e2ee/investment.mjs';
import {EncryptedDiaryClient} from '../../e2ee/client.mjs';
import {readSnapshotPages} from '../../e2ee/snapshot.mjs';
import {backup,restoreEmpty} from '../../e2ee/backup.mjs';
import {memoryDatabase} from './sqlite.mjs';
import {parseRecord} from '../../e2ee/store.mjs';
import {rotationDigest} from '../../e2ee/rotation.mjs';
import {saveExport,readExportManifest,readExportParts} from '../../../backup-worker/src/export-backup.js';
import {DIARY_ENCRYPTED_MIGRATION} from '../../../backup-worker/src/diary-encrypted.js';
import {restoreIsolated,diaryRestoreReport} from '../../../backup-worker/tools/restore-isolated.mjs';
import {Bucket} from '../../../backup-worker/test/fixtures.mjs';
import {exportEnv,exportFetcher} from '../../../backup-worker/test/export-fixtures.mjs';
const history=[{recorded_at:'2026-01-01',total:9876543210,cash:9876543210,stocks:0,funds:0,bonds:0,crypto:0,futures:0,points:0,other:0,updated_at:'2026-01-02'},
 {recorded_at:'2026-02-01',total:9876543211,cash:9876543211,stocks:0,funds:0,bonds:0,crypto:0,futures:0,points:0,other:0,updated_at:'2026-02-02'}];

test('investment history migrates, restores and updates as ciphertext with its existing viewer boundary',async()=>{
  const f=await systemFixture({phase:'legacy'}),states=[];let isolated;
  const owner=f.users['main-admin'];
  const central=async(path,body,user=owner)=>{const response=await handleDiaryKeys('/api/diary'+path.split('?')[0],new Request('https://fixture.test/security/api/diary'+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})}),f.centralEnv,{...user,authenticatedAt:Date.now()/1000},f.helpers);return response.json();};
  const request=async(user,path,body)=>{
    const origin=f.env.DIARY_ENCRYPTION_ORIGIN,response=await f.worker.fetch(new Request(origin+'/diary/api'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:f.cookie(user.serviceAccountId,user),...(body===undefined?{}:{Origin:origin,'X-Diary-Request':'1','Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),f.env,f.ctx);
    const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),{status:response.status});return value;
  };
  const unlock=async(user)=>{
    const {profile}=await request(user,'/encryption/profile');
    const state=await unlockSession({prf:new Uint8Array(user.prf),profile,anchor:f.configuration.anchor,minimumGeneration:1,checkSession:async()=>true});states.push(state);return {state,profile};
  };
  try {
    for(const row of history)f.db.sqlite.prepare('INSERT INTO investment_history VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row));
    f.db.sqlite.exec("INSERT INTO diary_entries(id,entry_date,title,content,author_id,author_name,household_id) VALUES(1,'2026-01-01','Diary title','Diary contents','main-admin','Author','tanaka-household')");
    f.db.sqlite.exec(readFileSync(new URL('../../e2ee/legacy-fences.sql',import.meta.url),'utf8'));
    await central('/control',{expectedGeneration:0,next:'migrating',evidence:null});
    const source={};for(const table of LEGACY_TABLES)source[table]=f.db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row=>({...row}));
    const plan=await prepareMigration({source,configuration:{...f.configuration,generation:1},recoveryPrivateKey:f.recovery.privateKey,trustedAnchor:f.configuration.anchor});
    assert.equal(plan.records.filter(row=>row.state==='investment').length,1);
    await central('/migration/import',{kind:'records',rows:plan.records,expectedGeneration:1});
    assert.equal(JSON.stringify(plan).includes('9876543210'),false);
    const admin=await unlock(owner),reader=await unlock(f.users['main-user']),wife=await unlock(f.users['wife-admin']);
    const financial=(await request(owner,'/encryption/investment')).record;
    assert.deepEqual(investmentRecords((await open(admin.state.keys.get(financial.scope),financial.envelope,{...bindingOf(financial),kind:'document'})).entry.records),investmentRecords(history));
    for(const user of [f.users['main-user'],f.users['wife-admin']])assert.equal((await request(user,'/encryption/investment')).record.id,financial.id);
    await assert.rejects(request(f.users['chiharu-admin'],'/encryption/investment'),error=>error.status===403);
    const profile=reader.profile,c=new EncryptedDiaryClient({profile,anchor:f.configuration.anchor,transport:{valid:async()=>true,snapshot:(h,since)=>readSnapshotPages(options=>request(f.users['main-user'],'/encryption/snapshot?'+new URLSearchParams(Object.entries(options).filter(([,v])=>v!==null))),h,since)}});
    await c.unlock(new Uint8Array(f.users['main-user'].prf));await c.sync();assert.equal(c.records.has(financial.id),true);assert.equal(c.list(new URLSearchParams()).entries.length,1);assert.equal(c.meta().months[0].count,1);c.lock();
    f.db.sqlite.exec("UPDATE diary_accounts SET can_view_investment=0 WHERE id='main-user'");
    try {await assert.rejects(request(f.users['main-user'],'/encryption/investment'),error=>error.status===403);assert.equal((await diaryKeyBundle(f.centralEnv,owner)).rekeyRequired,true);}
    finally{f.db.sqlite.exec("UPDATE diary_accounts SET can_view_investment=1 WHERE id='main-user'");}
    const bucket=new Bucket(),mock=exportFetcher(f.db.sqlite,'diary',{migration:DIARY_ENCRYPTED_MIGRATION});
    const saved=await saveExport({...exportEnv('diary',f.db,bucket),SECURITY_DB:f.central},'diary',Date.now(),{checkpoint:crypto.randomUUID(),fetcher:mock.fetcher,sleep:async()=>{}});
    const manifest=await readExportManifest(bucket,saved.daily,'diary');assert.equal(Object.hasOwn(manifest.payload.tables,'investment_history'),false);
    for await(const part of readExportParts(bucket,manifest.payload,'diary'))assert.equal(JSON.stringify(part).includes('9876543210'),false);
    const exported=await restoreIsolated(bucket,saved.daily,'diary',{anchor:f.configuration.anchor,minimumGeneration:1});
    try{assert.equal(diaryRestoreReport(exported).records.some(row=>row.state==='investment'),true);assert.equal(exported.db.prepare('SELECT COUNT(*) count FROM investment_history').get().count,0);}finally{exported.db.close();}
    const archive=await backup(f.db,{directory:f.configuration.directory,vaults:{},grants:f.configuration.grants,recoveryEnvelope:f.configuration.recoveryEnvelope});
    isolated=memoryDatabase({phase:'legacy'});await restoreEmpty(isolated,archive,{anchor:f.configuration.anchor,minimumGeneration:1});
    const restored=parseRecord(isolated.sqlite.prepare("SELECT * FROM diary_e2ee_records WHERE state='investment'").get());
    assert.deepEqual(investmentRecords((await open(reader.state.keys.get(restored.scope),restored.envelope,{...bindingOf(restored),kind:'document'})).entry.records),investmentRecords(history));
    const sequence=f.db.sqlite.prepare('SELECT MAX(seq) sequence FROM diary_e2ee_changes').get().sequence;
    const evidence=await signed({protocol:'T-lain diary cutover',version:2,records:plan.records.length,sequence,directoryGeneration:1,sourceManifestDigest:await rotationDigest(plan),restoreDigest:await rotationDigest(archive),readerBuild:'fixture-reader',writerBuild:'fixture-writer',formats:[1,2]},admin.state.privateKeys.sign);
    await central('/control',{expectedGeneration:1,next:'encrypted',evidence});
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) count FROM investment_history').get().count,0);
    await assert.rejects(request(owner,'/investment-history'),error=>error.status===426);
    const updated=[...history,{...history[1],recorded_at:'2026-03-01',total:9876543212,cash:9876543212}];
    for(const viewer of [reader,wife])await assert.rejects(sealInvestment({records:updated,current:financial,directory:viewer.state.directory,key:viewer.state.keys.get(financial.scope),signingKey:viewer.state.privateKeys.sign,writer:viewer.profile.actor.credentialId}),/UnauthorizedWriter/);
    const sealed=await sealInvestment({records:updated,current:financial,directory:admin.state.directory,key:admin.state.keys.get(financial.scope),signingKey:admin.state.privateKeys.sign,writer:admin.profile.actor.credentialId});
    const proposal=investmentProposal(sealed,crypto.randomUUID());
    await central('/investment',{proposal});await central('/investment',{proposal});
    assert.equal((await request(owner,'/encryption/investment')).record.revision,2);
    assert.equal(JSON.stringify(f.db.sqlite.prepare('SELECT * FROM diary_e2ee_records').all()).includes('9876543212'),false);
    await assert.rejects(central('/investment',{proposal},f.users['wife-admin']),/AccessDenied/);
  }finally{for(const state of states){state.keys.clear();state.privateKeys=null;}isolated?.close();await f.close();}
});


test('the existing CSV converter emits a local encrypted-import source without a remote write or financial-value logs',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'diary-investment-fixture-'));
  try {
    const monthly=join(temporary,'monthly.csv'),daily=join(temporary,'daily'),output=join(temporary,'import.json');await mkdir(daily);
    const header=Buffer.from('k/qVdCyNh4x2gWmJfoFqLJdhi+CBRYy7i+CBaYl+gWoK','base64');
    await writeFile(monthly,Buffer.concat([header,Buffer.from('2026/01/01,100,100\n2026/02/01,200,200\n')]));
    await writeFile(join(daily,'daily.csv'),Buffer.concat([header,Buffer.from('2026/02/01,250,250\n')]));
    const script=fileURLToPath(new URL('../../scripts/import-investment-data.mjs',import.meta.url)),args=[script,'--monthly',monthly,'--daily-dir',daily,'--through','2026-02-01','--json-output',output];
    const run=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
    const payload=JSON.parse(await readFile(output,'utf8'));assert.deepEqual(payload.records.map(row=>[row.date,row.total]),[['2026-01-01',100],['2026-02-01',250]]);
    assert.equal(run.stdout.includes('latest_total'),false);assert.equal(run.stdout.includes('250'),false);
    const rejected=spawnSync(process.execPath,[...args,'--remote'],{encoding:'utf8'});assert.equal(rejected.status,1);assert.match(rejected.stderr,/同時に指定できません/);
    const fake=join(temporary,'node_modules','wrangler','bin');await mkdir(fake,{recursive:true});
    const callLog=join(temporary,'calls.json');
    await writeFile(join(fake,'wrangler.js'),"require('node:fs').writeFileSync(process.env.INVESTMENT_CALL_LOG,JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify([{success:true,results:[{name:'diary_e2ee_control'}]}]));");
    const remote=spawnSync(process.execPath,[script,'--monthly',monthly,'--daily-dir',daily,'--through','2026-02-01','--remote'],{cwd:temporary,encoding:'utf8',env:{...process.env,INVESTMENT_CALL_LOG:callLog}});
    assert.equal(remote.status,1);assert.match(remote.stderr,/準備済み/);
    const calls=JSON.parse(await readFile(callLog,'utf8'));assert.equal(calls.includes('--file'),false);assert.equal(calls.includes('--command'),true);assert.equal(calls.join(' ').includes('250'),false);

  }finally{await rm(temporary,{recursive:true,force:true});}
});

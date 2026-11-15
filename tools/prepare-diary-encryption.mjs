import {readFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertSchema,assertEncryptedSchema} from '../backup-worker/src/schema-guard.js';
import {waitForProductionVerification,assertDeployedVersion,assertD1ExportReadiness} from './release-actions.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const ACCOUNT='277e86de986181599ce0db2b3ca1f186';
export const DIARY_PREPARATION_DATABASES=Object.freeze({security:'45c2e1ff-8ee1-4cc8-b8e5-cacc0846e475',diary:'e4677259-db4b-4562-ad82-fe542a1edb75'});
const fail=message=>{throw new Error(message);};

// No content-data migration, key generation, rollout switch or plaintext
// deletion belongs here. Every schema is checked BEFORE the first write.
export async function prepareDiaryEncryption({context,verification,loadSchema,readControl,deployBackup,verifyBackup,applyCandidate,guard=async()=>{}}) {
  if(context.clean!==true||context.ref!=='refs/heads/main'||context.event!=='infrastructure'||context.account!==ACCOUNT||!/^[a-f0-9]{40}$/.test(context.sha))fail('DiaryPreparationRequiresVerifiedMain');
  if(verification?.sha!==context.sha||verification.conclusion!=='success'||verification.event!=='push'||verification.branch!=='main')fail('DiaryPreparationRequiresPassingCI');
  const present={};
  for(const service of ['security','diary']) {
    const schema=await loadSchema(service),name=service==='diary'?'diary_e2ee_control':'security_diary_key_config';
    present[service]=schema.some(row=>row.name===name);
    if(present[service])await assertEncryptedSchema(service,schema);else await assertSchema(service,schema);
  }
  if(present.diary) {
    const control=await readControl();
    if(!control||control.phase!=='legacy'||control.ever_encrypted||control.generation!==0)fail('DiaryPreparationRequiresUntouchedLegacyDatabase');
  }
  await guard();
  const version=await deployBackup(context.sha);
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(version||''))fail('DiaryBackupVersionUnavailable');
  await verifyBackup(version,context.sha);
  for(const service of ['security','diary']) {
    if(!present[service]){await guard();await applyCandidate(service);}
    await assertEncryptedSchema(service,await loadSchema(service));
  }
  const control=await readControl();
  if(control?.phase!=='legacy'||control.ever_encrypted||control.generation!==0)fail('DiaryPreparationChangedRollout');
  return {prepared:true,phase:'legacy',dataMigration:false,encryptionEnabled:false,backupVersion:version};
}

async function main() {
  const env=process.env,sha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  if(process.argv[2]!=='--infrastructure'||!env.CLOUDFLARE_API_TOKEN)fail('DiaryPreparationInfrastructureAuthenticationRequired');
  const gh=path=>JSON.parse(execFileSync('gh',['api',`repos/tanaka-note/t-room-site/${path}`],{cwd:root,encoding:'utf8'}));
  const guard=async()=>{if(gh('git/ref/heads/main').object?.sha!==sha)fail('DiaryPreparationMainAdvanced');};
  await guard();
  const context={sha,ref:'refs/heads/main',event:'infrastructure',account:env.CLOUDFLARE_ACCOUNT_ID,clean:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()===''};
  const verify=gh(`actions/runs?head_sha=${sha}&per_page=100`).workflow_runs.filter(run=>run.path==='.github/workflows/verify.yml'&&run.event==='push'&&run.head_branch==='main'&&run.head_sha===sha).sort((a,b)=>b.run_number-a.run_number)[0];
  const api=async(path,body)=>{
    const response=await fetch(`https://api.cloudflare.com/client/v4${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    let data;try{data=await response.json();}catch{fail('DiaryPreparationCloudflareFailure');}
    if(!response.ok||!data.success)fail('DiaryPreparationCloudflareFailure');return data.result;
  };
  const query=async(service,sql)=>(await api(`/accounts/${ACCOUNT}/d1/database/${DIARY_PREPARATION_DATABASES[service]}/query`,{sql}))[0].results;
  const wrangler=(service,args)=>{
    const r=spawnSync(process.execPath,['--use-env-proxy',resolve(root,`${service}-worker/node_modules/wrangler/bin/wrangler.js`),...args],{cwd:resolve(root,`${service}-worker`),env,encoding:'utf8'});
    // Wrangler sees DDL and public bindings here, never diary content or keys.
    if(r.status!==0)fail('DiaryPreparationWranglerFailure');return r.stdout;
  };
  const result=await prepareDiaryEncryption({context,verification:verify?{sha:verify.head_sha,conclusion:verify.conclusion,event:verify.event,branch:verify.head_branch}:null,
    guard,
    loadSchema:service=>query(service,"SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name"),
    readControl:async()=>(await query('diary','SELECT phase,generation,ever_encrypted FROM diary_e2ee_control WHERE id=1'))[0],
    deployBackup:async head=>{
      console.log('Preparing the reviewed Backup Worker.');
      const out=wrangler('backup',['deploy','--tag',head,'--message','Diary D1 encryption preparation']);
      const match=out.match(/Current Version ID:\s*([a-f0-9-]{36})/i);if(!match)fail('DiaryBackupVersionUnavailable');return match[1];
    },
    verifyBackup:async(version,head)=>waitForProductionVerification(async()=>{
      const [deployments,detail,settings]=await Promise.all([api(`/accounts/${ACCOUNT}/workers/scripts/t-room-backup/deployments`),api(`/accounts/${ACCOUNT}/workers/scripts/t-room-backup/versions/${version}`),api(`/accounts/${ACCOUNT}/workers/scripts/t-room-backup/settings`)]);
      assertDeployedVersion(deployments,version);if(detail.id!==version)fail('DiaryBackupVersionMismatch');assertD1ExportReadiness(settings);
    }),
    applyCandidate:async service=>{
      console.log(`Applying additive ${service} encryption preparation schema.`);
      const config=JSON.parse(readFileSync(resolve(root,`${service}-worker/wrangler.jsonc`),'utf8'));
      if(config.d1_databases.find(binding=>binding.binding==='DB')?.database_id!==DIARY_PREPARATION_DATABASES[service])fail('DiaryPreparationDatabaseMismatch');
      const files=service==='security'?['e2ee/diary-keys.sql']:['e2ee/schema.sql','e2ee/legacy-fences.sql'];
      for(const file of files)wrangler(service,['d1','execute','DB','--remote','--file',file]);
    }
  });
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Diary encryption preparation failed; inspect the stage and retain all existing data.');process.exitCode=1;});

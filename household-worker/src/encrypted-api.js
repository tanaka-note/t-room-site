import {HttpError,uuid} from './domain.js';
import {b64,keyBundle,keyConfig} from './keys.js';
import {maintenancePlan,maintenanceStatements} from './maintenance.js';
const limits={accounts:200,transactions:20000,categories:500,snapshots:3600,historical:3600};
const json=(v,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
const hash=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v)))),n=>n.toString(16).padStart(2,'0')).join('');
const invalid=()=>{throw new HttpError(400,'暗号化データの形式を確認してください。');};
const conflict=()=>{throw new HttpError(409,'別の画面で変更されています。最新の状態を読み込んでください。','conflict');};
function identity(row){if(!row || !Object.hasOwn(limits,row.kind) || typeof row.id!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.id))invalid();return `${row.kind}:${row.id}`;}
function encryptedRows(rows,config){
  if(!Array.isArray(rows) || rows.length>27900)invalid();
  const seen=new Set();
  return rows.map(row=>{
    const id=identity(row),p=row.payload;
    if(seen.has(id)||!p || Object.keys(row).sort().join(',')!=='id,kind,payload' || Object.keys(p).sort().join(',')!=='ciphertext,iv,keyId,version'
      || p.version!==1 || p.keyId!==config.keyId || !b64(p.iv,16) || !b64(p.ciphertext,23,2500000))invalid();
    seen.add(id);return {kind:row.kind,id:row.id,payload:JSON.stringify(p)};
  });
}
function checkSize(rows){
  const counts={};let size=0;
  for(const r of rows){counts[r.kind]=(counts[r.kind]||0)+1;if(counts[r.kind]>limits[r.kind])invalid();size+=new TextEncoder().encode(r.payload).length;}
  if(size>24*1024*1024)throw new HttpError(413,'保存できる暗号化データ量の上限に達しました。');
}
const readRows=async(db,dataset)=>(await db.prepare('SELECT kind,id,payload FROM household_records WHERE dataset_id=? ORDER BY kind,id').bind(dataset).all()).results;
const publicRows=rows=>rows.map(r=>({...r,payload:JSON.parse(r.payload)}));
export async function encryptedApi(request,env,path,session,readJson,audit){
  const db=env.DB,hid=session.householdId;
  const config=await keyConfig(db,hid),bundle=await keyBundle(db,session);
  if(!config||!bundle)throw new HttpError(409,'Security Centerで家計簿の鍵の利用準備・承認を完了してください。','key_setup_required');
  if(['/api/backup','/api/export.csv'].includes(path))throw new HttpError(409,'暗号化対応版の画面から書き出してください。','encrypted_client_required');
  const current=await db.prepare(`SELECT s.revision,s.active_dataset,d.crypto_version FROM household_state s
    JOIN household_datasets d ON d.id=s.active_dataset AND d.household_id=s.id WHERE s.id=?`).bind(hid).first();
  if(!current)throw new HttpError(503,'データの準備ができていません。');
  if(path==='/api/data'&&request.method==='GET'){
    // One SQLite statement binds the returned ciphertext to its generation/revision.
    const result=(await db.prepare(`SELECT s.revision,s.active_dataset,d.crypto_version,r.kind,r.id,r.payload FROM household_state s
      JOIN household_datasets d ON d.id=s.active_dataset AND d.household_id=s.id
      LEFT JOIN household_records r ON r.dataset_id=d.id WHERE s.id=? ORDER BY r.kind,r.id`).bind(hid).all()).results;
    if(!result[0]||result[0].crypto_version!==1)throw new HttpError(409,'所有者の端末で暗号化への移行を完了してください。','migration_required');
    return json({encrypted:true,revision:result[0].revision,keyId:config.keyId,records:publicRows(result.filter(r=>r.kind).map(({kind,id,payload})=>({kind,id,payload})))});
  }
  if(session.role!=='owner')throw new HttpError(403,'このアカウントは閲覧専用です。');
  if(path==='/api/encryption/migration'&&request.method==='GET'){
    const source=await db.prepare(`SELECT * FROM household_datasets WHERE household_id=? AND crypto_version=0
      AND (lease_expires_at IS NULL OR datetime(lease_expires_at)<=datetime('now')) ORDER BY id LIMIT 1`).bind(hid).first();
    if(!source){
      const remaining=await db.prepare('SELECT COUNT(*) AS n FROM household_datasets WHERE household_id=? AND crypto_version=0').bind(hid).first();
      if(remaining.n)throw new HttpError(409,'以前の復元処理の保護期間が終了してから移行を再開してください。','migration_pending');
      return json({done:true,revision:current.revision});
    }
    const rows=await readRows(db,source.id);
    const after=await db.prepare('SELECT revision FROM household_state WHERE id=?').bind(hid).first();
    if(after.revision!==current.revision)conflict();
    return json({done:false,revision:current.revision,sourceDataset:source.id,sourceFingerprint:await hash(rows),records:publicRows(rows)});
  }
  if(path==='/api/maintenance/preview'&&request.method==='GET'){
    const plan=await maintenancePlan(db,hid);return json({revision:plan.revision,policy:plan.policy,planFingerprint:plan.fingerprint,requestCount:plan.requestCount,datasetCount:plan.datasetCount,recordCount:plan.recordCount});
  }
  if(!['/api/mutate','/api/restore','/api/encryption/migration','/api/maintenance'].includes(path)||request.method!=='POST')throw new HttpError(404,'ページが見つかりません。');
  const body=await readJson(request),requestId=uuid(body.requestId),fingerprint='encrypted-v1:'+await hash({path,body});
  if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)invalid();
  const replay=async()=>{
    const previous=await db.prepare('SELECT fingerprint,response_json FROM household_requests WHERE household_id=? AND request_id=?').bind(hid,requestId).first();
    if(!previous)return null;if(previous.fingerprint!==fingerprint)conflict();return json(JSON.parse(previous.response_json));
  };
  const previous=await replay();if(previous)return previous;
  if(body.expectedRevision!==current.revision)conflict();
  let statements=[],nextDataset=current.active_dataset,staging=null;
  const migrating=path==='/api/encryption/migration',restoring=path==='/api/restore';
  if(path==='/api/maintenance'){
    if(body.confirmCleanup!==true)invalid();
    const cleanup=await maintenanceStatements(db,hid,body,current.revision);
    statements=[cleanup.revisionStatement,...cleanup.statements];
  }else{
    if(body.keyId!==config.keyId || Object.hasOwn(body,'backup') || Object.hasOwn(body,'value') || Object.hasOwn(body,'operation'))invalid();
    const rows=encryptedRows(body.records,config);
    if(migrating||restoring){
      checkSize(rows);
      let source=null;
      if(migrating){
        source=await db.prepare(`SELECT * FROM household_datasets WHERE id=? AND household_id=? AND crypto_version=0
          AND (lease_expires_at IS NULL OR datetime(lease_expires_at)<=datetime('now'))`).bind(body.sourceDataset,hid).first();
        if(!source)conflict();
        const originals=await readRows(db,source.id);
        if(!Array.isArray(body.sourceRecords) || body.sourceRecords.length!==rows.length || body.sourceFingerprint!==await hash(originals)
          || JSON.stringify(originals.map(identity).sort())!==JSON.stringify(body.sourceRecords.map(identity).sort()))conflict();
        const counts=items=>JSON.stringify(Object.fromEntries(Object.keys(limits).map(k=>[k,items.filter(r=>r.kind===k).length])));
        if(counts(rows)!==counts(originals))conflict();
      }
      staging=crypto.randomUUID();
      await db.prepare("INSERT INTO household_datasets(id,household_id,crypto_version,lease_expires_at) VALUES(?,?,1,datetime('now','+1 hour'))").bind(staging,hid).run();
      for(let offset=0;offset<rows.length;offset+=50)await db.batch([
        db.prepare("UPDATE household_datasets SET lease_expires_at=datetime('now','+1 hour') WHERE id=? AND household_id=?").bind(staging,hid),
        ...rows.slice(offset,offset+50).map(r=>db.prepare('INSERT INTO household_records VALUES(?,?,?,?)').bind(staging,r.kind,r.id,r.payload))]);
      // Read back ciphertext before publishing; never make incomplete staging visible.
      if(await hash(await readRows(db,staging))!==await hash([...rows].sort((a,b)=>a.kind<b.kind?-1:a.kind>b.kind?1:a.id<b.id?-1:a.id>b.id?1:0)))throw new HttpError(503,'暗号化データの保存を確認できませんでした。');
      if(migrating){
        if(source.id===current.active_dataset)nextDataset=staging;
        statements.push(db.prepare('UPDATE household_datasets SET created_at=?,activated_at=?,retired_at=?,lease_expires_at=NULL WHERE id=? AND household_id=?')
          .bind(source.created_at,source.activated_at,source.retired_at,staging,hid),
          db.prepare('DELETE FROM household_records WHERE dataset_id=?').bind(source.id),db.prepare('DELETE FROM household_datasets WHERE id=? AND household_id=?').bind(source.id,hid));
        // Old receipts hashed plaintext inputs. Keep IDs/results but remove
        // hashes that could support offline guessing of financial values.
        statements.push(db.prepare("UPDATE household_requests SET fingerprint='retired-plaintext:'||lower(hex(randomblob(32))) WHERE household_id=? AND fingerprint NOT LIKE 'encrypted-v1:%' AND fingerprint NOT LIKE 'retired-plaintext:%'").bind(hid));
      }else{
        if(current.crypto_version!==1)throw new HttpError(409,'暗号化への移行を先に完了してください。','migration_required');
        nextDataset=staging;
        statements.push(db.prepare('UPDATE household_datasets SET retired_at=CURRENT_TIMESTAMP WHERE id=? AND household_id=?').bind(current.active_dataset,hid),
          db.prepare('UPDATE household_datasets SET activated_at=CURRENT_TIMESTAMP,lease_expires_at=NULL WHERE id=? AND household_id=?').bind(staging,hid));
      }
    }else{
      if(current.crypto_version!==1)throw new HttpError(409,'暗号化への移行を先に完了してください。','migration_required');
      if(!Array.isArray(body.deleted)||body.deleted.length>27900)invalid();
      const all=new Map((await readRows(db,current.active_dataset)).map(r=>[identity(r),r]));
      const touched=new Set(rows.map(identity));
      for(const item of body.deleted){const key=identity(item);if(touched.has(key))invalid();touched.add(key);all.delete(key);statements.push(db.prepare('DELETE FROM household_records WHERE dataset_id=? AND kind=? AND id=?').bind(current.active_dataset,item.kind,item.id));}
      for(const row of rows){all.set(identity(row),row);statements.push(db.prepare('INSERT OR REPLACE INTO household_records VALUES(?,?,?,?)').bind(current.active_dataset,row.kind,row.id,row.payload));}
      checkSize(all.values());
    }
    statements.unshift(db.prepare('UPDATE household_state SET revision=?,active_dataset=? WHERE id=?').bind(current.revision+1,nextDataset,hid));
  }
  const result={ok:true,revision:current.revision+1};
  try{await db.batch([
    db.prepare('INSERT INTO household_requests(household_id,request_id,fingerprint,response_json) VALUES(?,?,?,?)').bind(hid,requestId,fingerprint,JSON.stringify(result)),...statements]);}
  catch(error){const duplicate=await replay();if(duplicate)return duplicate;if(/household_revision_conflict/.test(String(error?.message)))conflict();throw error;}
  await audit(env,request,session,migrating?'encryption_migrated':restoring?'backup_restore':'data_update');
  return json(result);
}

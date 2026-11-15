import * as domain from './household-domain.mjs';
import {unwrapMaster,recordKeys,encryptRow,decryptRow,opaqueId,keyScope} from './household-crypto.mjs';
import {unlockAutomaticPrivate,shareAutomaticKeys} from './automatic-keys.mjs';
const kinds=['accounts','transactions','categories','snapshots','historical'];
const identity=r=>`${r.kind}:${r.id}`;
const sortRows=rows=>[...rows].sort((a,b)=>identity(a)<identity(b)?-1:identity(a)>identity(b)?1:0);
const digest=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v)))),n=>n.toString(16).padStart(2,'0')).join('');
const backupContent=(config,rows)=>({config:{householdId:config.householdId,keyId:config.keyId,recoveryWrappedKey:config.recoveryWrappedKey,recoveryPublicKey:config.recoveryPublicKey},records:sortRows(rows).map(r=>({kind:r.kind,id:r.id,payload:{version:r.payload.version,keyId:r.payload.keyId,iv:r.payload.iv,ciphertext:r.payload.ciphertext}}))});
async function cache(action,id,value) {
  try {
    return await new Promise(resolve=>{
      const open=indexedDB.open('troom-household-keys',1);
      open.onupgradeneeded=()=>open.result.createObjectStore('sessions');
      open.onerror=()=>resolve(null);
      open.onsuccess=()=>{
        const db=open.result,tx=db.transaction('sessions',action==='get'?'readonly':'readwrite'),store=tx.objectStore('sessions');let result=null;
        const request=action==='get'?store.get(id):action==='put'?store.put(value,id):store.delete(id);
        request.onsuccess=()=>{result=request.result;};
        tx.oncomplete=()=>{db.close();resolve(result);};
        tx.onerror=tx.onabort=()=>{db.close();resolve(null);};
      };
    });
  }catch{return null;}
}
const validPrivate=key=>key instanceof CryptoKey&&key.type==='private'&&key.extractable===false&&key.algorithm.name==='RSA-OAEP'&&key.algorithm.hash.name==='SHA-256'&&key.algorithm.modulusLength===3072&&key.usages.join(',')==='decrypt';
const validKeys=keys=>keys?.aes instanceof CryptoKey && keys.aes.extractable===false && keys.aes.algorithm.name==='AES-GCM' && keys.aes.algorithm.length===256
  && [...keys.aes.usages].sort().join(',')==='decrypt,encrypt' && keys.index instanceof CryptoKey && keys.index.extractable===false && keys.index.algorithm.name==='HMAC'
  && keys.index.algorithm.hash.name==='SHA-256' && keys.index.usages.join(',')==='sign' && (!keys.privateKey||validPrivate(keys.privateKey));

export function createEncryptedLedger(api,session) {
  const config=session.keyBundle;
  const cacheId=config?`${session.sessionContext}|${keyScope(config)}`:null;
  let keys=null,epoch=0,lastRows=[],decoded=new Map(),sharedAt=0,sharing=null;const requests=new Map();
  const check=token=>{if(token!==epoch)throw Object.assign(new Error('ログイン状態が変わりました。'),{discarded:true});};
  async function map(items,fn,token=epoch){
    const result=[];
    for(let i=0;i<items.length;i+=64){result.push(...await Promise.all(items.slice(i,i+64).map(fn)));check(token);if(i+64<items.length)await new Promise(resolve=>setTimeout(resolve,0));check(token);}
    return result;
  }
  const validate=data=>{domain.restoreInput({format:'troom-household',version:2,data});return data;};
  const plainRows=data=>Object.entries(data).flatMap(([kind,rows])=>rows.map(value=>({kind,id:value.id,value})));
  function size(data){if(new TextEncoder().encode(JSON.stringify(data)).length>10*1024*1024)throw new Error('保存できるデータ量の上限に達しました。');}
  async function encode(data,token=epoch){validate(data);size(data);return map(plainRows(data),r=>encryptRow(keys,config,r.kind,r.value),token);}
  async function decode(rows,sourceKeys=keys,sourceConfig=config,token=epoch){
    if(!Array.isArray(rows)||rows.length>27900)throw new Error('バックアップの形式・件数を確認してください。');
    const seen=new Set(),nextCache=new Map();
    const values=await map(rows,async r=>{
      if(!kinds.includes(r.kind)||seen.has(identity(r)))throw new Error('記録が重複しているか、形式が不正です。');seen.add(identity(r));
      const previous=sourceKeys===keys?decoded.get(identity(r)):null;
      const stamp=JSON.stringify(r.payload),value=previous?.stamp===stamp?previous.value:await decryptRow(sourceKeys,sourceConfig,r);
      nextCache.set(identity(r),{stamp,value});return {kind:r.kind,id:value.id,payload:JSON.stringify(value)};
    },token);
    const data=validate(domain.dataFromRecords(values));size(data);check(token);
    if(sourceKeys===keys)decoded=nextCache;
    return data;
  }
  async function send(path,requestId,expectedRevision,details,signature,token=epoch){
    let pending=requests.get(requestId);
    if(pending && pending.signature!==signature)throw new Error('同じ操作IDで異なる内容は送信できません。');
    if(!pending){pending={signature,body:{requestId,expectedRevision,keyId:config.keyId,...await details()}};check(token);requests.set(requestId,pending);}
    const result=await api(path,pending.body);check(token);
    if(result.ok!==true || result.revision!==expectedRevision+1)throw new Error('保存結果を確認できませんでした。入力を保持して再試行してください。');
    if(requests.size>50)requests.delete(requests.keys().next().value);
    return result;
  }
  async function migrate(token=epoch){
    if(session.role!=='owner')return;
    for(;;){
      const source=await api('/encryption/migration');check(token);if(source.done)return;
      // Validate without normalizing/replacing the original legacy payloads.
      validate(domain.dataFromRecords(source.records.map(r=>({...r,payload:JSON.stringify(r.payload)}))));
      const rows=await map(source.records,r=>encryptRow(keys,config,r.kind,r.payload),token);
      const originals=new Map(source.records.map(r=>[`${r.kind}:${r.payload.id}`,r]));
      await map(rows,async r=>{
        const value=await decryptRow(keys,config,r);
        const original=originals.get(`${r.kind}:${value.id}`);
        if(!original||JSON.stringify(value)!==JSON.stringify(original.payload))throw new Error('暗号化前後の内容が一致しません。');
      },token);
      await send('/encryption/migration',crypto.randomUUID(),source.revision,async()=>({sourceDataset:source.sourceDataset,sourceFingerprint:source.sourceFingerprint,sourceRecords:source.records.map(({kind,id})=>({kind,id})),records:rows}),source.sourceFingerprint,token);
    }
  }
  async function unlock(prf,preparedPrivate){
    const token=epoch;
    if(!config)throw new Error('パスキーでログインすると、暗号鍵の準備が自動で進みます。');
    let material;
    try{
      if(prf){const privateKey=preparedPrivate||await unlockAutomaticPrivate(prf,config.vault);check(token);material=await unwrapMaster(privateKey,config.wrappedKey,keyScope(config));check(token);keys=await recordKeys(material);check(token);if(session.role==='owner')keys.privateKey=privateKey;sharedAt=preparedPrivate?Date.now():0;}
      else keys=await cache('get',cacheId);
      check(token);
      if(!validKeys(keys)){keys=null;throw new Error('パスキーで家計簿の暗号鍵を解除してください。');}
      // Cache hits already contain validated, session-bound keys. Keep their
      // persisted representation intact instead of cloning them back into IDB.
      if(prf){
        await cache('put',cacheId,keys);
        if(token!==epoch){await cache('delete',cacheId);check(token);}
      }
      // Missing hints from an older server retain the conservative migration
      // check. The hint never authorizes data access or plaintext writes.
      if(session.encryptionMigrationRequired!==false)await migrate(token);
    }finally{material?.fill(0);prf?.fill(0);}
  }
  async function refreshSharedKeys({force=false}={}){
    const token=epoch;
    if(session.role!=='owner'||!keys?.privateKey)return;
    if(sharing)return sharing;
    if(!force&&Date.now()-sharedAt<=60000)return;
    sharedAt=Date.now();
    const privateKey=keys.privateKey;
    sharing=(async()=>{
      try{await shareAutomaticKeys(api,session,privateKey,()=>check(token));}
      catch(error){if(error.discarded||[401,403].includes(error.status))throw error;}
      finally{sharing=null;}
      check(token);
    })();
    return sharing;
  }
  async function load(){
    const token=epoch;
    if(!keys)await unlock();check(token);
    const result=await api('/data');check(token);
    if(result.encrypted!==true||result.keyId!==config.keyId||!Number.isSafeInteger(result.revision))throw new Error('暗号化データを確認できません。');
    const data=await decode(result.records,keys,config,token);check(token);lastRows=result.records;
    return {data,revision:result.revision,assetHistory:domain.assetHistory(data)};
  }
  async function mutate(data,operation,value,expectedRevision,requestId){
    const token=epoch,signature=JSON.stringify({operation,value,expectedRevision});
    return send('/mutate',requestId,expectedRevision,async()=>{
      const next=validate(domain.mutateData(data,operation,value));size(next);
      const before=new Map(plainRows(data).map(r=>[identity(r),r.value]));
      const changed=plainRows(next).filter(r=>{const old=before.get(identity(r));before.delete(identity(r));return old!==r.value;});
      const rows=await map(changed,r=>encryptRow(keys,config,r.kind,r.value),token);
      const deleted=await map([...before.keys()],async id=>{const split=id.indexOf(':'),kind=id.slice(0,split);return {kind,id:await opaqueId(keys,config,kind,id.slice(split+1))};},token);
      return {records:rows,deleted};
    },signature,token);
  }
  async function backup(){
    const token=epoch,content=backupContent(config,lastRows);
    const manifest=await encryptRow(keys,config,'manifest',{id:'backup',digest:await digest(content)});check(token);
    return {format:'troom-household',version:3,exportedAt:new Date().toISOString(),crypto:content.config,records:content.records,manifest};
  }
  async function readBackup(value){
    const token=epoch;
    if(value?.format!=='troom-household')throw new Error('家計簿のバックアップファイルを選んでください。');
    if([1,2].includes(value.version))return domain.restoreInput(value);
    if(value.version!==3||!value.crypto||!value.manifest)throw new Error('対応していないバックアップ形式です。');
    let sourceKeys=keys,material;
    try{
      if(keyScope(value.crypto)!==keyScope(config)){
        const auth=await TRoomPasskeys.authenticate('security');
        try{
          if(!auth.prfOutput)throw new Error('復元には対応端末での第一管理者の本人確認が必要です。');
          const response=await fetch('/security/api/household/recovery',{credentials:'same-origin'}),result=await response.json();check(token);
          if(!response.ok||!result.adminEnvelope)throw new Error('第一管理者による復旧用鍵の解除が必要です。');
          const privateKey=await TRoomCrypto.unlockAdminPrivateKeyWithPasskey(auth.prfOutput,result.adminEnvelope);
          material=await unwrapMaster(privateKey,value.crypto.recoveryWrappedKey,keyScope(value.crypto));check(token);sourceKeys=await recordKeys(material);
        }finally{auth.prfOutput?.fill(0);}
      }
      const manifest=await decryptRow(sourceKeys,value.crypto,value.manifest);
      if(value.manifest.kind!=='manifest'||manifest.id!=='backup'||manifest.digest!==await digest(backupContent(value.crypto,value.records)))throw new Error('バックアップの欠落・改変を検出しました。');
      const data=await decode(value.records,sourceKeys,value.crypto,token);check(token);return data;
    }finally{material?.fill(0);}
  }
  return {unlock,load,refreshSharedKeys,mutate,backup,readBackup,
    csv:data=>domain.csv(data),
    restore:(data,expectedRevision,requestId)=>send('/restore',requestId,expectedRevision,async()=>({records:await encode(data)}),JSON.stringify({data,expectedRevision})),
    clear(){epoch++;keys=null;lastRows=[];decoded.clear();requests.clear();if(cacheId)cache('delete',cacheId);}
  };
}

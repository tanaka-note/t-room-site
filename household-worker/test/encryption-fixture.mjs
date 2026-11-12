import {fixture} from './fixture.js';
import {manageKeys} from '../src/keys.js';
import * as cryptoClient from '../public/household-crypto.mjs';
import {createEncryptedLedger} from '../public/encrypted-ledger.mjs';
import {dataFromRecords,mutateData,records} from '../src/domain.js';
export async function encryptedFixture(accountId='owner',identityId='primary-admin') {
  const f=fixture(accountId,identityId);f.env.ENCRYPTION_REQUIRED='true';
  const householdId=accountId==='chiharu-admin'?'chiharu':'main';
  const config={householdId,keyId:crypto.randomUUID()},master=crypto.getRandomValues(new Uint8Array(32)),prf=crypto.getRandomValues(new Uint8Array(32));
  const recovery=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
  const recoveryPublicKey=await crypto.subtle.exportKey('jwk',recovery.publicKey),vault=await cryptoClient.createClientVault(prf);
  await manageKeys(f.env.DB,'vault',{identityId,credentialId:'fixture-credential',vault});
  await manageKeys(f.env.DB,'initialize',{serviceAccountId:accountId,...config,recoveryPublicKey,recoveryWrappedKey:await cryptoClient.wrapMaster(master,recoveryPublicKey,cryptoClient.keyScope(config))});
  await manageKeys(f.env.DB,'grant',{serviceAccountId:accountId,identityId,credentialId:'fixture-credential',serviceLinkId:'fixture-link',keyId:config.keyId,wrappedKey:await cryptoClient.wrapMaster(master,vault.publicKey,cryptoClient.keyScope(config))});
  const api=async(path,body)=>{
    const response=await f.request(`/api${path}`,body),value=await response.json();
    if(!response.ok)throw Object.assign(new Error(value.error),{status:response.status,code:value.code});
    return value;
  };
  const login=await (await f.login()).json(),ledger=createEncryptedLedger(api,login);
  return {...f,request:f.request,api,config,master,prf,recovery,vault,session:login,ledger,client:cryptoClient,
    seed(description='synthetic-private-ledger-content'){
      const dataset=f.sqlite.prepare('SELECT active_dataset FROM household_state WHERE id=?').get(householdId).active_dataset;
      const data=dataFromRecords(f.sqlite.prepare('SELECT kind,id,payload FROM household_records WHERE dataset_id=?').all(dataset));
      const next=mutateData(data,'transaction.save',{id:crypto.randomUUID(),date:'2026-11-01',type:'expense',amount:12345,categoryId:data.categories.find(c=>c.type==='expense').id,description,notes:'synthetic-private-notes'});
      const insert=f.sqlite.prepare('INSERT OR REPLACE INTO household_records VALUES(?,?,?,?)');
      for(const r of records(next))insert.run(dataset,r.kind,r.id,r.payload);
      return next;
    },
    async unlock(){await ledger.unlock(prf.slice());return ledger.load();},
    close(){ledger.clear();master.fill(0);prf.fill(0);f.close();}
  };
}

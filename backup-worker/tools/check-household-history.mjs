// Read-only Cloudflare API check; the local state contains dates/counts only.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {householdHistoryStatus} from './household-archive.mjs';
export function observeHouseholdHistory(datasets,prior,{databaseId,observedAt=new Date().toISOString()}={}){
 if(typeof databaseId!=='string'||!databaseId)throw new Error('HistoryDatabaseInvalid');
 const previous=prior?.databaseId===databaseId?prior:null;
 const preliminary=householdHistoryStatus(datasets,{observedAt});
 const firstObservedFullyEncryptedAt=preliminary.plaintextGenerations?null:previous?.firstObservedFullyEncryptedAt||observedAt;
 return {databaseId,observedAt,firstObservedFullyEncryptedAt,...householdHistoryStatus(datasets,{observedAt,lastPlaintextRemovedAt:firstObservedFullyEncryptedAt,retentionDays:30})};
}
async function main(){
 const index=process.argv.indexOf('--state-file');if(index<0||!process.argv[index+1])throw new Error('HistoryStateFileRequired');
 const stateFile=resolve(process.argv[index+1]),env=process.env;
 if(!env.CLOUDFLARE_ACCOUNT_ID||!env.CLOUDFLARE_API_TOKEN)throw new Error('HistoryCredentialsRequired');
 const config=JSON.parse(readFileSync(new URL('../../household-worker/wrangler.jsonc',import.meta.url)));
 const databaseId=config.d1_databases.find(x=>x.binding==='DB').database_id;
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseId}/query`,{method:'POST',headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({sql:'SELECT household_id,crypto_version,COUNT(*) AS generations FROM household_datasets GROUP BY household_id,crypto_version'}),signal:AbortSignal.timeout(30000)});
 const result=await response.json();if(!response.ok||!result.success)throw new Error('HistoryReadFailed');
 let prior=null;try{prior=JSON.parse(readFileSync(stateFile));}catch(error){if(error.code!=='ENOENT')throw new Error('HistoryStateInvalid');}
 const state=observeHouseholdHistory(result.result.flatMap(x=>x.results||[]),prior,{databaseId});
 writeFileSync(stateFile,JSON.stringify(state,null,2),{mode:0o600});console.log(JSON.stringify(state));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Household history check stopped; no Cloudflare data was modified.');process.exitCode=1;});

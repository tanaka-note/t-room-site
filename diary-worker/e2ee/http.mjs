import {investmentHousehold} from './investment.mjs';
import {investmentScope,canRead} from './policy.mjs';
import { assertDiaryEncryptionOrigin } from "./origin.mjs";
import { handleEncryptedMedia } from "./media.mjs";
import { verifyDirectory,DIARY_READER_PROTOCOL } from './crypto.mjs';
import { createStore } from './store.mjs';
import { readRollout,READ_FORMATS } from './rollout.mjs';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export const encryptionEnabled=env=>String(env.DIARY_ENCRYPTION_ENABLED||'false')==='true';
export async function encryptionStatus(env) {
  if(!encryptionEnabled(env))return {enabled:false};
  const control=await readRollout(env.DB);
  return {protocol:DIARY_READER_PROTOCOL,enabled:control.everEncrypted||control.phase==='encrypted',phase:control.phase,generation:control.generation,readOnly:control.phase!=='encrypted',formats:READ_FORMATS};
}
export async function encryptedContext(env,session) {
  if(!encryptionEnabled(env))fail(404,'EncryptionDisabled');
  if(session.authMethod!=='passkey')fail(401,'PasskeyRequired');
  const bundle=await env.SECURITY.getDiaryKeyBundle({identityId:session.identityId,credentialId:session.credentialId,serviceLinkId:session.serviceLinkId,serviceAccountId:session.accountId});
  if(!bundle)fail(409,'EncryptionPreparationRequired');
  if(bundle.accountId!==session.accountId||bundle.webAuthnCredentialId!==session.credentialId||bundle.serviceLinkId!==session.serviceLinkId)fail(403,'AccountMismatch');
  const directory=await verifyDirectory(bundle.directory,bundle.anchor,bundle.generation);
  const households=session.isGlobalOwner?Object.keys(directory.households):[session.householdId];
  if(!households.includes(session.activeHouseholdId))fail(403,'HouseholdDenied');
  const actor={accountId:session.accountId,credentialId:bundle.recipientId,active:true,households,canManageEntries:Boolean(session.canManageEntries),canViewInvestment:Boolean(session.canViewInvestment),canViewTrash:Boolean(session.canViewTrash),canPermanentlyDelete:Boolean(session.canPermanentlyDelete),isGlobalOwner:Boolean(session.isGlobalOwner),trashAliases:session.isGlobalOwner?Object.fromEntries(Object.entries(directory.households).filter(([,v])=>v.independent).map(([h,v])=>[h,[v.owner]])):{}};
  const registry={households:directory.households,epochs:directory.epochs,directory,photos:{},enforceRollout:true};
  return {actor,bundle,directory,registry,store:createStore(env.DB,registry)};
}
export async function handleEncryptedApi(request,env,url,path,session,{json,readJson,readMultipartForm}) {
  const photoAsset=/^\/api\/photos\/[0-9a-f-]{36}\/(original|display|thumbnail)$/.test(path);
  if(!path.startsWith('/api/encryption/')&&!photoAsset)return null;
  if(!encryptionEnabled(env))fail(404,'EncryptionDisabled');
  let control;
  if(photoAsset) {
    control=await readRollout(env.DB);
    // Enabling key preparation does not switch the existing photo reader.
    // Keep the authenticated legacy route until the actual encrypted cutover.
    if(!control.everEncrypted&&control.phase!=='encrypted')return null;
  }
  assertDiaryEncryptionOrigin(env,url);
  if(path==='/api/encryption/status'&&request.method==='GET')return json(await encryptionStatus(env));
  control??=await readRollout(env.DB);
  if(!control.everEncrypted&&!['encrypted','migrating'].includes(control.phase))fail(423,'EncryptionNotActive');
  const {actor,bundle,directory,registry,store}=await encryptedContext(env,session);
  actor.activeHouseholdId=session.activeHouseholdId;
  if(bundle.rekeyRequired&&request.method!=='GET')fail(423,'DiaryRekeyRequired');
  const media=await handleEncryptedMedia(request,env,url,path,actor,{json,readJson,readMultipartForm,store});if(media)return media;
  if(path==='/api/encryption/profile'&&request.method==='GET')return json({protocol:DIARY_READER_PROTOCOL,profile:{actor,household:session.activeHouseholdId,displayName:session.accountName,directory:bundle.directory,epochs:directory.epochs,vault:bundle.vault,grants:bundle.grants,recordGrants:bundle.recordGrants,webAuthnCredentialId:bundle.webAuthnCredentialId},minimumGeneration:bundle.generation,rekeyRequired:bundle.rekeyRequired,rollout:{phase:control.phase,generation:control.generation}});
  if(path==='/api/encryption/investment'&&request.method==='GET') {
    if(!actor.canViewInvestment)fail(403,'AccessDenied');
    const row=await store.get(investmentScope(investmentHousehold(directory)));
    if(row&&!canRead(actor,row))fail(403,'AccessDenied');
    return json({record:row});
  }
  if(path==='/api/encryption/time'&&request.method==='GET')return json({timestamp:new Date().toISOString()});
  if(path==='/api/encryption/head'&&request.method==='GET'){if(url.searchParams.get('household')!==session.activeHouseholdId)fail(403,'HouseholdDenied');return json(await store.snapshotHead(actor,session.activeHouseholdId));}
  if(path==='/api/encryption/snapshot'&&request.method==='GET') {
    const q=url.searchParams;if(q.get('household')!==session.activeHouseholdId)fail(403,'HouseholdDenied');
    const response=json(await store.snapshotPage(actor,session.activeHouseholdId,{since:Number(q.get('since')??-1),after:q.get('after'),at:q.has('at')?Number(q.get('at')):null,limit:Number(q.get('limit')||50)}));
    if(request.headers.get('Accept')==='application/vnd.tlain.diary-snapshot+json'&&typeof CompressionStream==='function'){
      const headers=new Headers(response.headers);headers.set('Content-Encoding','gzip');headers.set('Vary','Accept');
      return new Response(response.body.pipeThrough(new CompressionStream('gzip')),{status:response.status,headers,encodeBody:'manual'});
    }
    return response;
  }
  if(bundle.rekeyRequired)fail(423,'DiaryRekeyRequired');
  if(path==='/api/encryption/mutation'&&request.method==='POST') {
    const body=await readJson(request,2_000_000);if(body.proposal?.household!==session.activeHouseholdId)fail(403,'HouseholdDenied');
    if(body.operation==='import')fail(403,'UseIsolatedMigrationTool');
    const photos=await env.DB.prepare("SELECT id,household,account_id,status,expires_at FROM diary_e2ee_media WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(body.proposal?.photoIds||[])).all();for(const row of photos.results)registry.photos[row.id]={household:row.household,accountId:row.account_id,status:row.status,expiresAt:row.expires_at};
    return json(await store.mutation(actor,body.proposal,body.operation));
  }
  if(path==='/api/encryption/remove'&&request.method==='POST') {
    const body=await readJson(request,4096);if(body.household!==session.activeHouseholdId)fail(403,'HouseholdDenied');
    return json(await store.remove(actor,body));
  }
  fail(404,'UnknownEncryptedRoute');
}

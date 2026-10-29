import { requireSessionSecret } from '../../assets/session-secret.mjs';
import { serviceRollingSession, renewServiceSession, ROLLING_SESSION_VERSION } from '../../assets/passkey-calendar-policy.mjs';
import { recordSecurityAudit } from '../../assets/security-audit-worker.js';
import { HttpError,CALENDAR_TTL,idPattern,validatePayload,publicEntity,jsonBody } from './domain.js';

const encoder=new TextEncoder(),COOKIE='troom_calendar_session';
const enabled=env=>String(env.PASSKEY_ENABLED||'false')==='true';
const now=()=>Math.floor(Date.now()/1000);
export const accountVersion=(env,account)=>`${env.SESSION_VERSION||'1'}:${account.session_version}`;
export const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow',...headers}});
function b64(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function unb64(s){return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
async function key(env){return crypto.subtle.importKey('raw',encoder.encode(env.SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function signSession(value,env){const payload=b64(encoder.encode(JSON.stringify(value)));return `${payload}.${b64(new Uint8Array(await crypto.subtle.sign('HMAC',await key(env),encoder.encode(payload))))}`;}
async function verifySession(token,env){try{if(token.length>8192)return null;const [payload,signature,extra]=token.split('.');if(!payload||!signature||extra||!await crypto.subtle.verify('HMAC',await key(env),unb64(signature),encoder.encode(payload)))return null;const v=JSON.parse(new TextDecoder().decode(unb64(payload)));return v.expiresAt>now()?v:null;}catch{return null;}}
const cookie=(token)=>`${COOKIE}=${token}; Path=/calendar; Max-Age=${CALENDAR_TTL}; HttpOnly; Secure; SameSite=Strict`;
async function account(env,id){return env.DB.prepare('SELECT * FROM calendar_accounts WHERE id=? AND is_active=1').bind(id).first();}
async function audit(env,request,session,eventType,outcome='success'){
  const result=await recordSecurityAudit(env,request,{service:'calendar',eventType,outcome,authMethod:'passkey',identityId:session.identityId,credentialId:session.credentialId,serviceLinkId:session.serviceLinkId,serviceAccountId:session.serviceAccountId,role:'member',sessionId:session.sessionId,expiresAt:session.expiresAt,startedAt:session.startedAt,sessionVersion:session.sessionVersion,passkeySessionEpoch:session.passkeySessionEpoch,details:{}});
  if(!result.delivered)throw new HttpError(503,'ログイン監査を記録できませんでした。時間を置いて再試行してください。');
}
async function handoff(request,env){
  if(!enabled(env)||!env.SECURITY)throw new HttpError(503,'パスキーの利用準備を確認してください。');
  const body=await jsonBody(request,4096),verified=await env.SECURITY.redeemHandoff(String(body.handoffToken||''),'calendar');
  if(!verified)throw new HttpError(401,'パスキー認証をやり直してください。');
  const target=await account(env,verified.serviceAccountId);if(!target)throw new HttpError(403,'利用先のアカウントを確認できません。');
  const session={identityId:verified.identityId,credentialId:verified.credentialId,serviceLinkId:verified.serviceLinkId,serviceAccountId:target.id,role:'member',authMethod:'passkey',passkeySessionEpoch:verified.sessionEpoch,sessionId:crypto.randomUUID(),startedAt:new Date().toISOString(),sessionVersion:accountVersion(env,target),rollingSessionVersion:ROLLING_SESSION_VERSION,expiresAt:now()+CALENDAR_TTL};
  if(!(await serviceRollingSession(env,'calendar',session,'register')).valid)throw new HttpError(503,'ログイン状態を登録できませんでした。');
  try{await audit(env,request,session,'passkey_login_success');}catch(error){await serviceRollingSession(env,'calendar',session,'end');throw error;}
  return json({authenticated:true,accountId:target.id,displayName:target.display_name,identityId:session.identityId,sessionVersion:session.sessionVersion,expiresAt:session.expiresAt},200,{'Set-Cookie':cookie(await signSession(session,env))});
}
async function requireSession(request,env){
  if(!enabled(env))throw new HttpError(401,'パスキーでログインしてください。');
  const token=(request.headers.get('Cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1)||'';
  const session=await verifySession(token,env);if(!session||session.authMethod!=='passkey'||session.role!=='member')throw new HttpError(401,'パスキーでログインしてください。');
  const target=await account(env,session.serviceAccountId);
  if(!target||accountVersion(env,target)!==session.sessionVersion||!(await serviceRollingSession(env,'calendar',session,'read')).valid)throw new HttpError(401,'ログインまたは利用権限を確認できません。');
  return {session,target};
}
const scope=(kind,session)=>kind==='settings'?session.identityId:'';
async function entityRow(env,session,kind,id){return env.DB.prepare('SELECT * FROM calendar_entities WHERE account_id=? AND owner_identity=? AND kind=? AND id=?').bind(session.serviceAccountId,scope(kind,session),kind,id).first();}
async function validateReferences(env,session,kind,payload){
  if(kind==='event'&&!payload.purged){
    for(const [referenceKind,ids] of [['track',payload.trackIds],['tag',payload.tagIds]])for(const id of ids){const row=await entityRow(env,session,referenceKind,id);if(!row||row.purged)throw new HttpError(400,'追跡またはタグの所属アカウントを確認してください。');}
    for(const override of Object.values(payload.exceptions))if(override.replacement)await validateReferences(env,session,'event',override.replacement);
  }
  if((kind==='track'||kind==='tag')&&payload.mergedInto){
    let id=payload.mergedInto;const seen=new Set([payload.id]);
    for(let i=0;i<32;i++){if(seen.has(id))throw new HttpError(400,'循環する統合はできません。');seen.add(id);const row=await entityRow(env,session,kind,id);if(!row||row.purged)throw new HttpError(400,'統合先を確認してください。');const next=JSON.parse(row.payload).mergedInto;if(!next)return;id=next;}
    throw new HttpError(400,'統合先を確認してください。');
  }
}
async function prepareChange(env,session,change){
  const {kind,id,expectedVersion}=change;
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0||expectedVersion>=Number.MAX_SAFE_INTEGER)throw new HttpError(400,'変更の版を確認してください。');
  const payload=validatePayload(kind,id,change.payload),current=await entityRow(env,session,kind,id);
  if((Number(current?.version)||0)!==expectedVersion)throw new HttpError(409,'別の端末で更新されています。',{current:publicEntity(current)});
  if(current?.purged&&!payload.purged)throw new HttpError(409,'完全削除された予定です。',{current:publicEntity(current)});
  if(kind==='event'&&current&&!current.purged&&!payload.purged){
    const previous=JSON.parse(current.payload),cutoff=Date.now()-30*86400000;
    if(previous.deletedAt!=null&&previous.deletedAt<=cutoff&&payload.deletedAt==null)throw new HttpError(409,'復元できる30日間を過ぎています。',{current:publicEntity(current)});
    for(const [anchor,override] of Object.entries(previous.exceptions||{}))if(override.deleted&&override.deletedAt!=null&&override.deletedAt<=cutoff&&!payload.exceptions?.[anchor]?.deleted)throw new HttpError(409,'復元できる30日間を過ぎています。',{current:publicEntity(current)});
  }
  if(payload.purged&&(!current||!JSON.parse(current.payload).deletedAt))throw new HttpError(400,'ゴミ箱の予定だけを完全削除できます。');
  await validateReferences(env,session,kind,payload);
  if((kind==='track'||kind==='tag')&&!payload.mergedInto&&expectedVersion===0){
    const duplicate=await env.DB.prepare("SELECT id FROM calendar_entities WHERE account_id=? AND kind=? AND purged=0 AND json_extract(payload,'$.name')=? AND COALESCE(json_extract(payload,'$.mergedInto'),'')='' AND id!=?").bind(session.serviceAccountId,kind,payload.name,id).first();
    if(duplicate){payload.mergedInto=duplicate.id;payload.archived=true;}
  }
  const committed={kind,id,payload,version:expectedVersion+1,purged:payload.purged===true};
  return {committed,statement:env.DB.prepare(`INSERT INTO calendar_entities(account_id,owner_identity,kind,id,payload,version,purged) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(account_id,owner_identity,kind,id) DO UPDATE SET payload=excluded.payload,version=excluded.version,purged=excluded.purged,updated_at=CURRENT_TIMESTAMP`)
    .bind(session.serviceAccountId,scope(kind,session),kind,id,JSON.stringify(payload),expectedVersion+1,payload.purged?1:0)};
}
async function mutation(request,env,session){
  const body=await jsonBody(request),{kind,id,expectedVersion,requestId}=body;
  if(Object.keys(body).some(k=>!['kind','id','expectedVersion','requestId','payload'].includes(k))||!idPattern.test(requestId))throw new HttpError(400,'保存する変更を確認してください。');
  const original=JSON.stringify(body),hash=b64(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(original))));
  const replay=()=>env.DB.prepare('SELECT payload_hash,response_json FROM calendar_requests WHERE account_id=? AND owner_identity=? AND request_id=?').bind(session.serviceAccountId,session.identityId,requestId).first();
  const saved=await replay();if(saved){if(saved.payload_hash!==hash)throw new HttpError(409,'再送内容が一致しません。');return json(JSON.parse(saved.response_json));}
  const grouped=kind==='batch';
  const changes=grouped?body.payload?.operations:[body];
  if(grouped&&(!idPattern.test(id)||expectedVersion!==0||!body.payload||Object.keys(body.payload).some(k=>k!=='operations')||!Array.isArray(changes)||changes.length<2||changes.length>10||changes.some(c=>!c||!['event','settings'].includes(c.kind)||Object.keys(c).some(k=>!['kind','id','expectedVersion','payload'].includes(k)))||new Set(changes.map(c=>`${c.kind}:${c.id}`)).size!==changes.length))throw new HttpError(400,'まとめて保存する内容を確認してください。');
  const currents=async()=>Promise.all(changes.map(async c=>publicEntity(await entityRow(env,session,c.kind,c.id))));
  const prepared=[];
  try{for(const change of changes)prepared.push(await prepareChange(env,session,change));}catch(error){if(grouped&&error instanceof HttpError&&error.status===409)error.extra={currents:await currents()};throw error;}
  const result=grouped?{entities:prepared.map(c=>c.committed)}:{entity:prepared[0].committed};
  try{
    await env.DB.batch([
      env.DB.prepare('INSERT INTO calendar_requests(account_id,owner_identity,request_id,payload_hash,kind,entity_id,response_json) VALUES (?,?,?,?,?,?,?)').bind(session.serviceAccountId,session.identityId,requestId,hash,kind,id,JSON.stringify(result)),
      ...prepared.map(c=>c.statement)
    ]);
  }catch{
    const duplicate=await replay();if(duplicate&&duplicate.payload_hash===hash)return json(JSON.parse(duplicate.response_json));
    throw new HttpError(409,'別の端末で更新されています。',grouped?{currents:await currents()}:{current:publicEntity(await entityRow(env,session,kind,id))});
  }
  return json(result);
}
export async function calendarRequest(request,env){
  try{
    const url=new URL(request.url),path=url.pathname.slice('/calendar'.length);
    if(!url.pathname.startsWith('/calendar/api/'))throw new HttpError(404,'ページが見つかりません。');
    if(path==='/api/version'&&request.method==='GET')return json({service:'calendar',version:'0.1.0',build:env.BUILD_ID||'development'});
    requireSessionSecret(env.SESSION_SECRET,HttpError);
    if(request.method!=='GET'&&(request.method!=='POST'||request.headers.get('Origin')!==url.origin||!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type')||'')))throw new HttpError(403,'操作元を確認できません。');
    if(path==='/api/passkey/handoff'&&request.method==='POST')return await handoff(request,env);
    const {session,target}=await requireSession(request,env);let response;
    if(path==='/api/session'&&request.method==='GET'){
      if(request.headers.get('X-Troom-Activity')==='foreground')await audit(env,request,session,'session_resume');response=json({authenticated:true,accountId:target.id,displayName:target.display_name,identityId:session.identityId,sessionVersion:session.sessionVersion,expiresAt:session.expiresAt});
    }else if(path==='/api/logout'&&request.method==='POST'){
      if(!(await serviceRollingSession(env,'calendar',session,'end')).valid)throw new HttpError(503,'ログアウトを完了できませんでした。');
      await audit(env,request,session,'logout');return json({ok:true},200,{'Set-Cookie':`${COOKIE}=; Path=/calendar; Max-Age=0; HttpOnly; Secure; SameSite=Strict`});
    }else if(path==='/api/sync'&&request.method==='GET'){
      const cursor=Number(url.searchParams.get('cursor')||0);if(!Number.isSafeInteger(cursor)||cursor<0)throw new HttpError(400,'同期位置を確認してください。');
      const rows=(await env.DB.prepare("WITH page AS (SELECT * FROM calendar_entities WHERE account_id=? AND (owner_identity='' OR owner_identity=?) AND updated_seq>? ORDER BY updated_seq LIMIT 201), bounded AS (SELECT *,sum(length(CAST(payload AS BLOB))) OVER(ORDER BY updated_seq) AS bytes FROM page) SELECT * FROM bounded WHERE bytes<=6291456 ORDER BY updated_seq LIMIT 200").bind(session.serviceAccountId,session.identityId,cursor).all()).results||[];
      const next=rows.at(-1)?.updated_seq??cursor;
      const more=Boolean(await env.DB.prepare("SELECT 1 FROM calendar_entities WHERE account_id=? AND (owner_identity='' OR owner_identity=?) AND updated_seq>? LIMIT 1").bind(session.serviceAccountId,session.identityId,next).first());
      response=json({entities:rows.map(publicEntity),cursor:next,more});
    }else if(path==='/api/entities'&&request.method==='POST'){
      const {keys}=await jsonBody(request,4096);
      if(!Array.isArray(keys)||keys.length>8||keys.some(k=>!k||!['event','track','tag','settings'].includes(k.kind)||(k.kind==='settings'?k.id!=='preferences':!idPattern.test(k.id))))throw new HttpError(400,'確認する項目を選んでください。');
      response=json({entities:await Promise.all(keys.map(async k=>publicEntity(await entityRow(env,session,k.kind,k.id))))});
    }else if(path==='/api/mutations'&&request.method==='POST')response=await mutation(request,env,session);
    else throw new HttpError(404,'情報が見つかりません。');
    return await renewServiceSession(request,response,env,'calendar',path,session,async expiresAt=>cookie(await signSession({...session,expiresAt},env)));
  }catch(error){return json({error:error instanceof HttpError?error.message:'処理を完了できませんでした。時間を置いて再試行してください。',...(error instanceof HttpError?error.extra:{})},error instanceof HttpError?error.status:503);}
}
export async function purgeExpired(env){
  await env.DB.batch([
    env.DB.prepare("UPDATE calendar_entities SET payload=json_object('id',id,'purged',json('true')),purged=1,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE kind='event' AND purged=0 AND json_type(payload,'$.deletedAt')='integer' AND json_extract(payload,'$.deletedAt')<=?").bind(Date.now()-30*86400000),
    env.DB.prepare("UPDATE calendar_entities SET payload=json_set(payload,'$.exceptions',json((SELECT json_group_object(j.key,json(CASE WHEN json_extract(j.value,'$.deleted')=1 AND json_type(j.value,'$.deletedAt')='integer' AND json_extract(j.value,'$.deletedAt')<=? THEN '{\"deleted\":true}' ELSE j.value END)) FROM json_each(payload,'$.exceptions') j))),version=version+1,updated_at=CURRENT_TIMESTAMP WHERE kind='event' AND purged=0 AND EXISTS(SELECT 1 FROM json_each(payload,'$.exceptions') j WHERE json_extract(j.value,'$.deleted')=1 AND json_type(j.value,'$.deletedAt')='integer' AND json_extract(j.value,'$.deletedAt')<=?)").bind(Date.now()-30*86400000,Date.now()-30*86400000),
    env.DB.prepare("DELETE FROM calendar_requests WHERE created_at<datetime('now','-35 days')")
  ]);
}

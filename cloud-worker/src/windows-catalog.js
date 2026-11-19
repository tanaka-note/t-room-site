// Only the dedicated Windows device API uses this catalog. Web listings are unchanged.
import { fileContentVersion } from './file-version.js';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const fail=(code,status=409)=>json({code,error:code},status);
const integer=(value,fallback=0)=>value===null?fallback:/^(0|[1-9]\d*)$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):NaN;

export function windowsCatalogScope(chain,binding,{historical=false,unfiled=false}={}) {
  if(!Array.isArray(chain)||chain.length>100)return false;
  if(binding.role==='admin')return historical||(!chain.some(f=>f.isDeleted)&&
    (chain.length?chain.at(-1).parentId===null:unfiled));
  const roots=(binding.folderScopes||[{rootFolderId:binding.rootFolderId}]).map(s=>Number(s.rootFolderId));
  for(const folder of chain) {
    if(!historical&&folder.isDeleted)return false;
    if(roots.includes(Number(folder.id)))return true;
    if(folder.isProtected)return false;
  }
  return false;
}
async function record(row,binding) {
  const historical=['trashed','purged'].includes(row.state);
  const chain=JSON.parse(historical?row.ancestors:row.live_ancestors||'null');
  if(!windowsCatalogScope(chain,binding,{historical,unfiled:row.kind==='file'&&row.parent_id===null}))return null;
  if(historical) {
    const value=JSON.parse(row.payload);
    if(!value.deletedAt||!value.trashOperationId)return null;
    // No old key/metadata disclosure through the device's deletion feed.
    return {kind:row.kind,id:row.entity_id,revision:row.seq,state:row.state,deletedAt:value.deletedAt,trashOperationId:value.trashOperationId};
  }
  if(row.state!=='present')return null;
  const {objectKey,...value}=JSON.parse(row.payload);
  if(row.kind==='file')value.contentVersion=await fileContentVersion({object_key:JSON.parse(row.payload).objectKey});
  return {kind:row.kind,id:row.entity_id,revision:row.seq,state:'present',value};
}
export async function handleWindowsCatalog(request,env,url,route,binding) {
  if(request.method!=='GET')return fail('operation_not_allowed',403);
  const control=await env.DB.prepare(`SELECT epoch,history_floor AS floor,
    COALESCE((SELECT MAX(seq) FROM cloud_windows_changes),0) AS cursor FROM cloud_windows_catalog_control WHERE id=1`).first();
  if(!control)return fail('catalog_unavailable',503);
  if(route==='/catalog/start')return json({epoch:control.epoch,cursor:control.cursor});
  const limit=200;
  if(route==='/catalog/snapshot'||route==='/catalog/changes') {
    if(url.searchParams.get('epoch')!==control.epoch)return fail('catalog_reset');
    const snapshot=route.endsWith('/snapshot');
    const upper=integer(url.searchParams.get('until'),control.cursor);
    const after=integer(url.searchParams.get('after'));
    if(!Number.isSafeInteger(upper)||!Number.isSafeInteger(after)||upper>control.cursor||after>upper)return fail('invalid_cursor',400);
    if(!snapshot&&after<control.floor)return fail('catalog_reset');
    // Latest heads only: an item changed after the snapshot's upper bound is
    // delivered by the subsequent changes feed. Snapshot absence is never deletion.
    const rows=await env.DB.prepare(`SELECT c.*,CASE c.kind WHEN 'file' THEN fp.ancestors ELSE dp.ancestors END AS live_ancestors
      FROM cloud_windows_heads h JOIN cloud_windows_changes c ON c.seq=h.seq
      LEFT JOIN cloud_windows_file_projection fp ON c.kind='file' AND fp.entity_id=c.entity_id
      LEFT JOIN cloud_windows_folder_projection dp ON c.kind='folder' AND dp.entity_id=c.entity_id
      WHERE c.seq>? AND c.seq<=? ORDER BY c.seq LIMIT ?`).bind(after,upper,limit).all();
    const source=rows.results||[],items=(await Promise.all(source.map(row=>record(row,binding)))).filter(Boolean);
    const next=source.length===limit?source.at(-1).seq:upper;
    return json({epoch:control.epoch,until:upper,next,complete:next===upper,items});
  }
  const match=route.match(/^\/content\/([1-9]\d*)$/);
  if(!match)return fail('not_found',404);
  const revision=integer(request.headers.get('X-TCloud-Revision'));
  if(!revision)return fail('revision_required',400);
  const row=await env.DB.prepare(`SELECT f.*,h.seq,p.ancestors FROM cloud_files f
    JOIN cloud_windows_heads h ON h.kind='file' AND h.entity_id=f.id
    JOIN cloud_windows_file_projection p ON p.entity_id=f.id WHERE f.id=?`).bind(Number(match[1])).first();
  if(!row||row.status!=='ready'||row.deleted_at||!windowsCatalogScope(JSON.parse(row.ancestors),binding,{unfiled:row.folder_id===null}))return fail('file_unavailable',404);
  if(row.seq!==revision)return fail('revision_changed');
  const range=request.headers.get('Range');
  const parsed=/^bytes=(\d+)-(\d+)$/.exec(range||'');
  const start=Number(parsed?.[1]),end=Number(parsed?.[2]),size=Number(row.encrypted_size_bytes||row.size_bytes);
  if(!parsed||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=size||end-start+1>64*1024*1024+32)return fail('invalid_range',416);
  // Capture the immutable R2 object key with its revision in one SQL statement.
  // A concurrent overwrite can never replace this request's body pointer.
  const object=await env.FILES.get(row.object_key,{range:{offset:start,length:end-start+1},
    ...(request.headers.has('If-Match')?{onlyIf:request.headers}:{})});
  if(!object)return fail('file_unavailable',404);
  if(!object.body)return fail('revision_changed',412);
  if(object.size!==size||object.range?.offset!==start||object.range?.length!==end-start+1)return fail('invalid_object',502);
  return new Response(object.body,{status:206,headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store',
    'Content-Length':String(end-start+1),'Content-Range':`bytes ${start}-${end}/${size}`,'ETag':object.httpEtag,
    'X-TCloud-Revision':String(revision)}});
}

import {investmentBinding,investmentRecords} from './investment.mjs';
import {b64,encode,open,seal,signed,verifyDirectory} from './crypto.mjs';
import {bindingOf,proofOf,verifyRecord} from './record.mjs';
import {preferencesScope,publishedScope,draftScope,trashScope} from './policy.mjs';
import {openRecoveryEnvelope} from './recovery.mjs';
import {mediaBinding,rotationDigest} from './rotation.mjs';
import {createDiaryEntryDomain} from '../src/entry-domain.js';
const domain=createDiaryEntryDomain({HttpError:Error,basePath:'/diary'});
const equal=(a,b)=>b64(encode(a))===b64(encode(b));
export const LEGACY_TABLES=Object.freeze(['diary_entries','diary_tags','diary_photos','diary_trash_scopes','diary_favorites','investment_history']);
export function legacyEntryBinding(row,{photos,scopes},epochs) {
  const state=row.deleted_at?'trash':row.status==='draft'?'draft':'published';
  const retainedFor=state==='trash'?[...new Set(scopes.filter(scope=>scope.entry_id===row.id).map(scope=>scope.owner_account_id))].sort():[];
  if(state==='trash'&&!retainedFor.length)throw new Error('LegacyTrashScopeMissing');
  const excluded=new Set(JSON.parse(row.draft_excluded_photo_ids||'[]'));
  const ids=photos.filter(photo=>(photo.entry_id===row.id||state==='draft'&&row.draft_of_entry_id&&photo.entry_id===row.draft_of_entry_id)&&!excluded.has(photo.id)).sort((a,b)=>{const pos=p=>String(row.content||'').toLowerCase().indexOf('[[写真:'+p.id.toLowerCase()+']]');const x=pos(a),y=pos(b);return (x<0)-(y<0)||(x<0?0:x-y)||((a.entry_id===(row.draft_of_entry_id||row.id)?0:1)-(b.entry_id===(row.draft_of_entry_id||row.id)?0:1))||a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id);}).map(photo=>photo.id);
  const scope=state==='published'?publishedScope(row.household_id):state==='draft'?draftScope(row.household_id):trashScope(row.household_id,retainedFor);
  const epoch=epochs[scope];if(!epoch)throw new Error('MigrationScopeMissing');
  return {id:String(row.id),household:row.household_id,scope,state,author:row.author_id,revision:row.revision,epoch,
    sourceId:row.draft_of_entry_id?String(row.draft_of_entry_id):null,sourceRevision:row.draft_of_revision||null,retainedFor,photoIds:ids};
}
export function legacyPreferenceBinding(household,author,epochs) {
  const scope=preferencesScope(household,author),epoch=epochs[scope];
  if(!epoch)throw new Error('MigrationScopeMissing');
  return {id:scope,household,scope,state:'preferences',author,revision:1,epoch,sourceId:null,sourceRevision:null,retainedFor:[],photoIds:[]};
}
// The complete legacy source is fetched over the authenticated operator route
// only while database write fences are active. No plaintext source is persisted
// locally. Existing R2 object keys are copied as references; bytes stay in place.
export async function prepareMigration({source,configuration,recoveryPrivateKey,trustedAnchor,existing={records:[],media:[]},onProgress=()=>{}}) {
  for(const table of LEGACY_TABLES)if(!Array.isArray(source[table]))throw new Error('InvalidMigrationSource');
  const saved={};
  for(const kind of ['records','media']) {
    if(!Array.isArray(existing[kind]))throw new Error('InvalidMigrationInventory');
    saved[kind]=new Map(existing[kind].map(row=>[row.id,row]));
    if(saved[kind].size!==existing[kind].length)throw new Error('InvalidMigrationInventory');
  }
  const directory=await verifyDirectory(configuration.directory,trustedAnchor,configuration.generation);
  const kit=await openRecoveryEnvelope({packet:configuration.recoveryEnvelope,recoveryPrivateKey,anchor:trustedAnchor,minimumGeneration:directory.generation});
  const records=[],media=[];
  try {
    const add=async(binding,entry)=>{
      const key=kit.scopeKeys.get(binding.scope);if(!key)throw new Error('MigrationScopeMissing');
      const summary=['preferences','investment'].includes(binding.state)?{}:{entryDate:entry.entryDate,title:entry.title,tags:entry.tags,weather:entry.weather,photoCount:entry.photos.length};
      const previous=saved.records.get(binding.id);
      if(previous) {
        await verifyRecord(previous,directory);
        if(!equal(bindingOf(previous),binding)||Object.keys(previous.keyBox).length||previous.attestation.writer!=='__recovery__'||previous.attestation.recovery?.operation!=='migration'||previous.attestation.recovery.previousDigest!==await rotationDigest(binding)||previous.attestation.recovery.previousGeneration!==0||
          !equal({version:1,entry},await open(key,previous.envelope,{...binding,kind:'document'}))||!equal(summary,await open(key,previous.summary,{...binding,kind:'summary'})))throw new Error('MigrationContentMismatch');
        records.push(previous);saved.records.delete(binding.id);return;
      }
      const row={...binding,keyBox:{},envelope:await seal(key,{version:1,entry},{...binding,kind:'document'},{format:2}),
        summary:await seal(key,summary,{...binding,kind:'summary'}),
        attestation:{writer:'__recovery__',recovery:{operation:'migration',previousDigest:await rotationDigest(binding),previousGeneration:0,directoryGeneration:directory.generation}}};
      if(!equal({version:1,entry},await open(key,row.envelope,{...binding,kind:'document'})))throw new Error('MigrationContentMismatch');
      row.attestation.signature=(await signed(proofOf(row),kit.authority)).signature;
      await verifyRecord(row,directory);records.push(row);
    };
    if(source.investment_history.length){investmentRecords(source.investment_history);await add(investmentBinding(directory),{records:source.investment_history});}
    const entriesById=new Map(source.diary_entries.map(row=>[row.id,row])),photosById=new Map(source.diary_photos.map(row=>[row.id,row]));
    for(const raw of source.diary_entries) {
      const tags=source.diary_tags.filter(tag=>tag.entry_id===raw.id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(tag=>tag.tag);
      const binding=legacyEntryBinding(raw,{photos:source.diary_photos,scopes:source.diary_trash_scopes},directory.epochs);
      const photos=binding.photoIds.map(id=>domain.serializePhoto(photosById.get(id)));
      const {id,...entry}=domain.serializeEntry({...raw,tags:JSON.stringify(tags)});
      await add(binding,{...entry,photos,legacy:{entry:raw,tags:source.diary_tags.filter(tag=>tag.entry_id===raw.id),trashScopes:source.diary_trash_scopes.filter(scope=>scope.entry_id===raw.id)}});
      onProgress({phase:'verifying-source',kind:'records',completed:records.length,total:source.diary_entries.length+(source.investment_history.length?1:0)});
    }
    const favorites=new Map();
    for(const favorite of source.diary_favorites) {
      const entry=entriesById.get(favorite.entry_id);if(!entry)throw new Error('OrphanLegacyFavorite');
      const binding=legacyPreferenceBinding(entry.household_id,favorite.account_id,directory.epochs);
      if(!favorites.has(binding.id))favorites.set(binding.id,{binding,rows:[]});favorites.get(binding.id).rows.push(favorite);
    }
    for(const {binding,rows} of favorites.values())await add(binding,{favorites:rows.map(row=>String(row.entry_id)),legacyFavorites:rows});
    for(const raw of source.diary_photos) {
      const entry=entriesById.get(raw.entry_id);if(!entry)throw new Error('OrphanLegacyPhoto');
      const row={id:raw.id,household:entry.household_id,account_id:raw.created_by_id,session_id:raw.id,status:'attached',
        original_key:raw.original_key,display_key:raw.display_key,thumbnail_key:raw.thumbnail_key,metadata:'',epoch:directory.epochs[preferencesScope(entry.household_id,raw.created_by_id)],request_hash:'',expires_at:0,retired_at:null};
      const key=kit.scopeKeys.get(mediaBinding(row).scope);if(!key)throw new Error('MigrationScopeMissing');
      const plain={...domain.serializePhoto(raw),legacy:raw};
      const previous=saved.media.get(row.id);
      if(previous) {
        const {metadata,request_hash,...binding}=previous;
        if(!equal(binding,Object.fromEntries(Object.entries(row).filter(([key])=>!['metadata','request_hash'].includes(key))))||request_hash!==await rotationDigest({id:row.id,metadata})||!equal(plain,await open(key,JSON.parse(metadata),mediaBinding(row))))throw new Error('MigrationContentMismatch');
        media.push(previous);saved.media.delete(row.id);
      }else {
        row.metadata=JSON.stringify(await seal(key,plain,mediaBinding(row)));
        if(!equal(plain,await open(key,JSON.parse(row.metadata),mediaBinding(row))))throw new Error('MigrationContentMismatch');
        row.request_hash=await rotationDigest({id:row.id,metadata:row.metadata});media.push(row);
      }
      if(media.length%64===0||media.length===source.diary_photos.length)onProgress({phase:'verifying-source',kind:'media',completed:media.length,total:source.diary_photos.length});
    }
    if(saved.records.size||saved.media.size)throw new Error('UnexpectedMigrationCiphertext');
    return {records,media};
  }finally{kit.scopeKeys.clear();kit.authority=null;}
}

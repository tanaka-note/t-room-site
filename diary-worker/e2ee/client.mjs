import {investmentRecords} from './investment.mjs';
import {
  b64,
  encode,
  newKey,
  open,
  seal,
  signed,
  recipientKeyBox,
  openRecipientKey,
} from "./crypto.mjs";
import { bindingOf, verifyRecord, validateSnapshot } from "./record.mjs";
import { unlockSession } from "./session.mjs";
import {
  canRead,
  publishedScope,
  draftScope,
  preferencesScope,
  trashScope,
  trashAudience,
  retentionIds,
} from "./policy.mjs";
import { createDiaryEntryDomain } from "../src/entry-domain.js";
import { splitSearchTerms } from "../public/diary-search.js";
import {
  findPhotoMarkers,
  removeTextFromRichDocument,
} from "../public/diary-rich-text.js";
class InputError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const domain = createDiaryEntryDomain({
  HttpError: InputError,
  basePath: "/diary",
});
const numericId = () =>
  String(
    Number(BigInt("0x" + crypto.randomUUID().replaceAll("-", "").slice(0, 12))),
  );
const equal = (a, b) => b64(encode(a)) === b64(encode(b));
async function creationIdentity(actor, household, requestId, payload) {
  if(typeof requestId!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestId))throw new InputError(400,'InvalidRequestId');
  const value={version:1,accountId:actor.accountId,household,requestId:requestId.toLowerCase()};
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',encode(value)));
  const id=String((BigInt('0x'+[...digest.slice(0,7)].map(byte=>byte.toString(16).padStart(2,'0')).join(''))&((1n<<53n)-1n))||1n);
  return {id,creation:{...value,payloadHash:b64(await crypto.subtle.digest('SHA-256',encode(payload)))}};
}
const DIARY_READ_TIMEOUT_MS = 45_000;

export async function waitForDiaryRead(pending, signal) {
  if (!signal) return pending;
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([pending, interrupted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export class EncryptedDiaryClient {
  constructor({ transport, profile, anchor, minimumGeneration=1,documentFormat=1,cache=null,minimumSequence=0,lazy=false }) {
    this.transport = transport;
    this.profile = profile;
    this.anchor = anchor;
    this.minimumGeneration = minimumGeneration;
    this.documentFormat=documentFormat;this.cache=cache;this.minimumSequence=minimumSequence;
    this.actions = new Map();
    this.revisionFloor = new Map();
    this.generation = 0;
    this.keys = new Map();this.recordKeys=new Map();
    this.records = new Map();
    this.albumCache = null;
    this.pending = new Map();
    this.closed = true;
    this.switching = false;
    this.pendingDeletes = new Map();
    this.preparedBindings = new WeakMap();
    this.lazy=lazy;this.documentLoads=new WeakMap();this.background=null;
    this.indexCacheState=null;
    this.progressTimer=null;
    this.onProgress=()=>{};this.onBackgroundError=()=>{};
  }
  async unlock(prf,cachedPrivateKeys) {
    const generation = ++this.generation;
    clearTimeout(this.progressTimer);this.progressTimer=null;
    this.closed = true;
    this.records.clear();
    this.albumCache = null;
    this.keys.clear();this.recordKeys.clear();
    this.sequence = undefined;
    this.revisionFloor.clear();
    this.pending.clear();
    this.pendingDeletes.clear();
    this.actions.clear();
    this.privateKeys = null;
    this.documentLoads=new WeakMap();
    this.background=null;
    this.indexCacheState=null;
    const state = await unlockSession({
      prf,
      cachedPrivateKeys,
      profile: this.profile,
      anchor: this.anchor,
      minimumGeneration: this.minimumGeneration,
      checkSession: () => this.transport.valid(),
    });
    if (generation !== this.generation) throw new Error("SessionChanged");
    Object.assign(this, state);
    this.closed = false;
  }
  lock() {
    ++this.generation;
    clearTimeout(this.progressTimer);this.progressTimer=null;
    this.closed = true;
    this.keys.clear();this.recordKeys.clear();
    this.records.clear();
    this.albumCache = null;
    this.revisionFloor.clear();
    this.pending.clear();
    this.pendingDeletes.clear();
    this.actions.clear();
    this.privateKeys = null;
    this.documentLoads=new WeakMap();this.onProgress({phase:'locked',completed:0,total:0});
    this.indexCacheState=null;
  }
  async check(signal) {
    signal?.throwIfAborted();
    const generation=this.generation;
    this.assertOpen(generation);
    const valid=await this.transport.valid(signal);
    signal?.throwIfAborted();
    this.assertOpen(generation);
    if (!valid) {
      this.lock();
      throw Object.assign(new Error("SessionExpired"), { status: 401 });
    }
  }
  assertOpen(generation=this.generation) {
    if(this.closed)throw Object.assign(new Error('SessionExpired'),{status:401});
    if(this.switching||generation!==this.generation)throw new Error('SessionChanged');
  }
  get actor() {
    return this.profile.actor;
  }
  get household() {
    return this.profile.household;
  }
  sync(options={}) {
    if (this.syncing?.generation === this.generation && !this.syncing.signal.aborted) return this.syncing.promise;
    const signal = options.signal ?? AbortSignal.timeout(DIARY_READ_TIMEOUT_MS);
    const pending = {
      generation: this.generation, signal,
      promise: waitForDiaryRead(this.syncSnapshot({...options, signal}), signal),
    };
    this.syncing = pending;
    void pending.promise.finally(() => {
      if (this.syncing === pending) this.syncing = null;
    }).catch(() => {});
    return pending.promise;
  }
  async indexRecord(row,generation=this.generation) {
    this.assertOpen(generation);
    if (!canRead(this.actor, row)) throw new Error("AccessDenied");
    if (row.revision < (this.revisionFloor.get(row.id) || 0))
      throw new Error("RecordRollbackDetected");
    const previous = this.records.get(row.id);
    if (
      previous &&
      previous.row.revision === row.revision &&
      !equal(previous.row, row)
    )
      throw new Error("RecordEquivocation");
    if (previous && equal(previous.row, row)) {
      return previous;
    }
    await verifyRecord(row, this.directory);
    const binding = bindingOf(row);
    const key = Object.keys(row.keyBox).length
      ? (row.keyBox[this.actor.credentialId]?await openRecipientKey(
          row.keyBox,
          { ...binding, kind: "record-key" },
          this.actor.credentialId,
          this.privateKeys.rsa,
        ):this.recordKeys.get(`${row.id}:${row.revision}`))
      : this.keys.get(row.scope);
    if (!key) throw new Error("GrantDenied");
    if(this.lazy&&row.state!=='preferences') {
      const summary=await open(key,row.summary,{...binding,kind:'summary'});
      if(row.state!=='investment'&&(typeof summary.entryDate!=='string'||typeof summary.title!=='string'||!Array.isArray(summary.tags)||summary.tags.some(tag=>typeof tag!=='string')||summary.photoCount!==row.photoIds.length))throw new Error('InvalidSummary');
      this.assertOpen(generation);return {row,summary,key};
    }
    const value = await open(key, row.envelope, {
      ...binding,
      kind: "document",
    });
    if (
      value.version !== 1 ||
      !value.entry ||
      typeof value.entry !== "object"
    )
      throw new Error("UnsupportedPayload");
    if (
      !["preferences","investment"].includes(row.state) &&
      (typeof value.entry.title !== "string" ||
        typeof value.entry.content !== "string" ||
        !Array.isArray(value.entry.photos) ||
        !equal(
          value.entry.photos.map((p) => p.id),
          row.photoIds,
        ))
    )
      throw new Error("InvalidPayload");
    if(row.state==='investment')investmentRecords(value.entry.records);
    this.assertOpen(generation);return { row, entry: value.entry };
  }

  indexBinding(sequence) {
    const scope=preferencesScope(this.household,this.actor.accountId);
    return {household:this.household,scope,id:`verified-index:${sequence}`,revision:1,epoch:this.directory.epochs[scope],kind:'verified-index'};
  }
  async indexDigest(snapshot) {
    // IndexedDB preserves the normalized snapshot's property order. Hash its
    // exact JSON bytes once, without recursively copying/sorting every large
    // ciphertext object. The small authorization context stays canonical.
    const digest=b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(snapshot))));
    return b64(await crypto.subtle.digest('SHA-256',encode({snapshot:digest,actor:this.actor,directory:this.directory})));
  }
  async readPreparedIndex(key,snapshot,packet=undefined) {
    if(!this.lazy||!this.cache?.getIndex)return null;
    let available=false;
    try {
      if(packet===undefined)packet=await this.cache.getIndex(key);
      if(!packet)return null;
      available=true;
      if(packet.sequence!==snapshot.sequence)return false;
      const binding=this.indexBinding(snapshot.sequence),scopeKey=this.keys.get(binding.scope);
      if(!scopeKey)return false;
      const value=await open(scopeKey,packet.envelope,binding);
      if(value.version!==1||value.digest!==await this.indexDigest(snapshot)||!Array.isArray(value.summaries))return false;
      const rows=new Map(snapshot.records.filter(row=>row.state!=='preferences').map(row=>[row.id,row]));
      if(rows.size!==value.summaries.length)return false;
      const result=new Map();
      for(const pair of value.summaries) {
        if(!Array.isArray(pair)||pair.length!==3||result.has(pair[0])||!rows.has(pair[0]))return false;
        const row=rows.get(pair[0]),summary=pair[1];
        if(!summary||row.state!=='investment'&&(typeof summary.entryDate!=='string'||typeof summary.title!=='string'||!Array.isArray(summary.tags)||summary.tags.some(tag=>typeof tag!=='string')||summary.photoCount!==row.photoIds.length))return false;
        const order=pair[2];
        if(order!==null&&(!order||Object.keys(order).join(',')!=='lastPublishedAt'||order.lastPublishedAt!==null&&typeof order.lastPublishedAt!=='string'))return false;
        result.set(row.id,{row,summary,order});
      }
      return result;
    } catch {return available?false:null;} // Missing storage is optional; a mismatched pair requires a fresh full read.
  }
  async persistPreparedIndex() {
    const state=this.indexCacheState;
    if(!state||state.ready||state.pending||!this.cache?.putIndex||this.closed)return state?.pending;
    const generation=this.generation;
    state.pending=(async()=>{
      const binding=this.indexBinding(state.snapshot.sequence),key=this.keys.get(binding.scope);
      if(!key)return;
      const summaries=[...state.records.values()].filter(r=>r.row.state!=='preferences').map(r=>[
        r.row.id,r.summary||(r.row.state==='investment'?{}:{entryDate:r.entry.entryDate,title:r.entry.title,tags:r.entry.tags,weather:r.entry.weather,photoCount:r.row.photoIds.length}),
        r.entry&&Object.hasOwn(r.entry,'lastPublishedAt')?{lastPublishedAt:r.entry.lastPublishedAt}:r.order||null
      ]);
      const envelope=await seal(key,{version:1,digest:await this.indexDigest(state.snapshot),summaries},binding);
      this.assertOpen(generation);
      if(this.indexCacheState!==state)return;
      await this.cache.putIndex(state.key,state.snapshot.sequence,envelope);
      if(this.indexCacheState===state)state.ready=true;
    })().catch(()=>{}); // Quota/unsupported storage cannot close a valid diary.
    return state.pending;
  }

  async syncSnapshot({sessionChecked=false,parallelStartupRead=false,signal}={}) {
    signal?.throwIfAborted();
    const generation = this.generation;
    this.assertOpen(generation);
    const sessionCheck=sessionChecked?null:this.check(signal);
    const overlap=parallelStartupRead&&!sessionChecked&&this.sequence===undefined&&Boolean(this.cache);
    if(overlap)void sessionCheck.catch(()=>{});
    else await sessionCheck;
    let cached=null, checkpoint=0;
    const checkpointKey=[this.actor.accountId,this.actor.credentialId,this.household].join('/');
    const cacheKey=checkpointKey+'/'+this.directory.generation;
    let saved;
    if(this.sequence===undefined&&this.cache) {
      try{
        if(this.cache.readStartup)saved=await this.cache.readStartup(cacheKey,checkpointKey);
        cached=saved?saved.snapshot:await this.cache.get(cacheKey);
      }catch{/* A missing local snapshot uses the authoritative online path. */}
      if(cached){
        try {
          validateSnapshot(cached);
          if(cached.delta||cached.unchanged||cached.household!==this.household)throw new Error('InvalidCache');
        } catch {
          // The cached payload is disposable, but its separate checkpoint is
          // still required to detect rollback on the authoritative read.
          cached=null;
        }
      }
    }
    signal?.throwIfAborted();
    if(saved)checkpoint=saved.checkpoint??0;
    else if(this.cache?.checkpoint)try{checkpoint=await this.cache.checkpoint(checkpointKey)??0;}catch{/* Local storage is optional. */}
    signal?.throwIfAborted();
    if(!Number.isSafeInteger(checkpoint)||checkpoint<0)throw new Error('InvalidCache');
    let since=this.sequence??cached?.sequence??-1;
    let pendingDelta;
    if(overlap) {
      // The delta request has its own live authorization and yields ciphertext.
      // Wait for the separate session check before opening or applying anything.
      this.assertOpen(generation);
      const controller=cached?new AbortController():null;
      if(controller) {
        const cancelDelta = () => controller.abort(signal.reason);
        signal?.addEventListener('abort', cancelDelta, {once:true});
        pendingDelta=this.transport.snapshot(this.household,since,{signal:controller.signal})
          .finally(()=>signal?.removeEventListener('abort', cancelDelta));
        void pendingDelta.catch(()=>{});
      }
      try {
        await sessionCheck;
        this.assertOpen(generation);
      }catch(error){
        controller?.abort();throw error;
      }
    }
    signal?.throwIfAborted();
    const preparedIndex=cached?this.readPreparedIndex(cacheKey,cached,saved?(saved.index??null):undefined):Promise.resolve(null);
    // Verify/decrypt the small summaries while the remaining pages are in
    // flight. Nothing becomes visible until the complete fixed snapshot and
    // live session have passed the same validation as the non-pipelined path.
    const prefetched=new Map();
    const onPage=since<0?async(rows,{total=0}={})=>{
      let cursor=0;
      await Promise.all(Array.from({length:Math.min(2,rows.length)},async()=>{
        while (cursor < rows.length) {
          signal?.throwIfAborted();
          const row = rows[cursor++], old = prefetched.get(row.id);
          prefetched.set(row.id, old && equal(old.row, row) ? old : await this.indexRecord(row, generation));
        }
      }));
      signal?.throwIfAborted();
      if(this.lazy)this.onProgress({phase:'index',completed:prefetched.size,total});
    }:undefined;
    let [snapshot,restored]=await Promise.all([pendingDelta??this.transport.snapshot(this.household,since,{onPage,signal}),preparedIndex]);
    signal?.throwIfAborted();
    if(cached&&restored===false){
      // Never repair a damaged/context-mismatched local pair by trusting a
      // potentially incomplete cached snapshot. Retain the durable checkpoint
      // and validate a complete authoritative snapshot under current rights.
      this.assertOpen(generation);cached=null;since=-1;
      snapshot=await this.transport.snapshot(this.household,since,{onPage,signal});
    }
    signal?.throwIfAborted();
    if(generation!==this.generation||this.closed)throw new Error("SessionChanged");
    validateSnapshot(snapshot);
    if(snapshot.sequence<Math.max(this.minimumSequence,checkpoint)||snapshot.sequence<since)throw new Error('RollbackDetected');
    if(since>=0&&snapshot.sequence===since&&!snapshot.delta&&!snapshot.unchanged) {
      const known=cached?.records||[...this.records.values()].map(value=>value.row);
      if(known.length!==snapshot.records.length||known.some(row=>!snapshot.records.some(next=>next.id===row.id&&equal(row,next))))throw new Error('RecordEquivocation');
    }
    const cacheUnchanged=Boolean(cached&&snapshot.unchanged&&cached.sequence===snapshot.sequence);
    if(cached){
      const rows=new Map(cached.records.map(row=>[row.id,row]));
      if(snapshot.delta&&snapshot.baseSequence!==since)throw new Error('InvalidSnapshot');
      if(snapshot.delta||snapshot.unchanged){for(const id of snapshot.removed)rows.delete(id);for(const row of snapshot.records){const old=rows.get(row.id);if(old&&(row.revision<old.revision||row.revision===old.revision&&!equal(old,row)))throw new Error('RecordRollbackDetected');rows.set(row.id,row);}snapshot={version:1,household:this.household,sequence:snapshot.sequence,baseSequence:-1,delta:false,unchanged:false,removed:[],records:[...rows.values()]};}
    }
    if (generation !== this.generation || this.closed)
      throw new Error("SessionChanged");
    validateSnapshot(snapshot);
    if (snapshot.household !== this.household)
      throw new Error("InvalidSnapshot");
    if (this.sequence !== undefined && snapshot.sequence < this.sequence)
      throw new Error("RollbackDetected");
    if (snapshot.unchanged) {
      if (this.sequence !== snapshot.sequence)
        throw new Error("InvalidSnapshot");
      await this.check(signal);
      for (const { row } of this.records.values())
        if (!canRead(this.actor, row)) throw new Error("AccessDenied");
      return this.records;
    }
    if (snapshot.delta && snapshot.baseSequence !== since)
      throw new Error("InvalidSnapshot");
    const records = snapshot.delta ? new Map(this.records) : new Map();
    for (const id of snapshot.removed) records.delete(id);
    let cursor = 0, indexed=0;
    if(this.lazy)this.onProgress({phase:'index',completed:0,total:snapshot.records.length});
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (cursor < snapshot.records.length) {
          signal?.throwIfAborted();
          const row = snapshot.records[cursor++];
          const prepared=prefetched.get(row.id);
          const saved=restored&&restored.get(row.id);
          if(saved&&this.lazy&&row.state!=='preferences'&&!Object.keys(row.keyBox).length&&(saved.row===row||equal(saved.row,row))) {
            // This encrypted index is bound to the exact previously verified
            // ciphertext, directory and actor. Fresh deltas use normal checks;
            // every body is signed/validated again when prioritized for display.
            if(!canRead(this.actor,row))throw new Error('AccessDenied');
            const key=this.keys.get(row.scope);if(!key)throw new Error('GrantDenied');
            records.set(row.id,{row,summary:saved.summary,order:saved.order,key,verifyOnHydrate:true});
          }else records.set(row.id,prepared&&equal(prepared.row,row)?prepared:await this.indexRecord(row,generation));
          signal?.throwIfAborted();
          indexed++;if(this.lazy&&indexed%25===0)this.onProgress({phase:'index',completed:indexed,total:snapshot.records.length});
        }
      }),
    );
    await this.check(signal);
    signal?.throwIfAborted();
    if (generation !== this.generation) throw new Error("SessionChanged");
    if (snapshot.sequence < (this.sequence ?? -1))
      throw new Error("RollbackDetected");
    if(this.cache&&!cacheUnchanged){const value={version:1,household:this.household,sequence:snapshot.sequence,baseSequence:-1,delta:false,unchanged:false,removed:[],records:[...records.values()].map(r=>r.row)};try{await this.cache.put(cacheKey,value,checkpointKey);}catch(error){if(error.message==='CacheRollbackRejected')throw new Error('RollbackDetected');/* Storage availability cannot turn a durable save into a failed save. */}}
    signal?.throwIfAborted();
    if(generation!==this.generation||this.closed)throw new Error('SessionChanged');
    for (const [id, previous] of this.records)
      if (!records.has(id))
        this.revisionFloor.set(id, previous.row.revision + 1);
    for (const [id, current] of records)
      this.revisionFloor.set(id, current.row.revision);
    this.records = records;
    this.albumCache = null;
    this.sequence = snapshot.sequence;
    // Parallel verification can change Map insertion order. When the durable
    // snapshot was not rewritten, bind its exact existing bytes, not a newly
    // assembled array with a different completion order.
    if(this.lazy&&this.cache?.putIndex)this.indexCacheState={key:cacheKey,snapshot:cacheUnchanged?cached:{version:1,household:this.household,sequence:this.sequence,baseSequence:-1,delta:false,unchanged:false,removed:[],records:[...records.values()].map(r=>r.row)},records:new Map(records),ready:cacheUnchanged&&Boolean(restored)};
    if(this.lazy)this.progress(true);
    if(generation!==this.generation||this.closed)throw new Error("SessionChanged");
    return this.records;
  }
  progress(immediate=false) {
    if(!immediate) {
      if(this.progressTimer===null) {
        const generation=this.generation;
        this.progressTimer=setTimeout(()=>{
          this.progressTimer=null;
          if(!this.closed&&generation===this.generation)this.progress(true);
        },150);
      }
      return;
    }
    clearTimeout(this.progressTimer);this.progressTimer=null;
    const total=this.records.size,completed=[...this.records.values()].filter(record=>record.entry).length;
    this.onProgress({phase:completed===total?'complete':'documents',completed,total});
  }
  async hydrate(id) {
    for(let attempt=0;attempt<3;attempt++) {
      if(this.closed)throw Object.assign(new Error('SessionExpired'),{status:401});
      const record=this.records.get(String(id));if(!record)throw new InputError(404,'NotFound');
      if(record.entry)return record.entry;
      const generation=this.generation;
      if(!this.documentLoads.has(record))this.documentLoads.set(record,(async()=>{
        if(record.verifyOnHydrate){await verifyRecord(record.row,this.directory);this.assertOpen(generation);record.verifyOnHydrate=false;}
        const value=await open(record.key,record.row.envelope,{...bindingOf(record.row),kind:'document'});
        if(this.closed||generation!==this.generation)throw new Error('SessionChanged');
        if(value.version!==1||!value.entry||typeof value.entry!=='object')throw new Error('UnsupportedPayload');
        if(record.row.state==='investment')investmentRecords(value.entry.records);
        else if(typeof value.entry.title!=='string'||typeof value.entry.content!=='string'||!Array.isArray(value.entry.photos)||!equal(value.entry.photos.map(p=>p.id),record.row.photoIds)||!equal({entryDate:value.entry.entryDate,title:value.entry.title,tags:value.entry.tags,weather:value.entry.weather,photoCount:value.entry.photos.length},record.summary)||record.order&&!equal({lastPublishedAt:value.entry.lastPublishedAt},record.order))throw new Error('InvalidPayload');
        if(this.records.get(String(id))===record){record.entry=value.entry;delete record.key;this.progress();}
      })());
      await this.documentLoads.get(record);
      if(this.records.get(String(id))===record)return record.entry;
    }
    throw new Error('SnapshotChanged');
  }
  async hydrateRecords(records) {
    let cursor=0;
    await Promise.all(Array.from({length:Math.min(4,records.length)},async()=>{
      while(cursor<records.length)await this.hydrate(records[cursor++].row.id);
    }));
  }
  async ensureList(parameters) {
    if(!this.lazy)return;
    const draft=parameters.get('draft')==='1',trash=parameters.get('trash')==='1';
    if(splitSearchTerms(parameters.get('q')).length||draft||trash) {
      // Search never silently omits a document that is still being prepared.
      await this.hydrateRecords([...this.records.values()].filter(r=>r.row.state===(trash?'trash':draft?'draft':'published')));return;
    }
    const entries=this.matchingEntries(parameters),end=Math.max(0,Number(parameters.get('offset'))||0)+Math.min(50,Math.max(1,Number(parameters.get('limit'))||20));
    const boundary=entries[Math.min(end,entries.length)-1]?.entryDate;
    // summary has no publication timestamp; hydrate every tie on the boundary
    // date before applying the existing stable full-document ordering.
    const knownOrder=entries.filter(e=>e.entryDate===boundary).every(e=>{const r=this.records.get(String(e.id));return r.entry||r.order;});
    await this.hydrateRecords((knownOrder?entries.slice(0,end):entries.filter(e=>!boundary||e.entryDate>=boundary)).map(e=>this.records.get(String(e.id))));
  }
  async ensureAll() {await this.hydrateRecords([...this.records.values()]);}
  startBackground() {
    if(!this.lazy||this.closed||this.background)return this.background;
    const generation=this.generation;
    const running=(async()=>{
      await this.transport.backgroundReady?.();
      if(this.closed||generation!==this.generation)return;
      // Allow the prepared first screen to paint before optional index writes
      // and background crypto compete with input/rendering on a mobile CPU.
      if(typeof requestAnimationFrame==='function'&&globalThis.document?.visibilityState==='visible')await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      else await new Promise(resolve=>setTimeout(resolve,0));
      if(this.closed||generation!==this.generation)return;
      await this.persistPreparedIndex();
      while(!this.closed&&generation===this.generation) {
        const queue=[...this.records.values()].filter(r=>!r.entry).sort((a,b)=>String(b.summary?.entryDate||'').localeCompare(String(a.summary?.entryDate||''))).map(r=>r.row.id);
        if(!queue.length){this.progress(true);return;}
        for(let index=0;index<queue.length&&!this.closed&&generation===this.generation;) {
          const count=globalThis.navigator?.scheduling?.isInputPending?.()?2:8;
          await Promise.all(queue.slice(index,index+count).map(id=>this.hydrate(id).catch(error=>{
            // A concurrent, authenticated delta may legitimately remove a row.
            if(error.status===404&&!this.records.has(id))return;throw error;
          })));
          index+=count;
          await new Promise(resolve=>setTimeout(resolve,0));
        }
      }
    })().catch(error=>{if(!this.closed&&generation===this.generation)this.onBackgroundError(error);}).finally(()=>{if(this.background===running)this.background=null;});
    this.background=running;
    return this.background;
  }
  async prepare(
    entry,
    {
      current = null,
      state = "published",
      operation = "save",
      id = current?.id || numericId(),
      sourceId = current?.sourceId || null,
      sourceRevision = current?.sourceRevision || null,
      requestId = crypto.randomUUID(),
      draftId,
      draftRevision,
      importMeta,
    } = {},
    {sessionChecked=false} = {},
  ) {
    if(sessionChecked)this.assertOpen();else await this.check();
    const generation=this.generation;
    const revision = importMeta?.revision || (current?.revision || 0) + 1,
      author =
        importMeta?.author ||
        (state === "draft"
          ? this.actor.accountId
          : current?.author || this.actor.accountId);
    let retainedFor = current?.retainedFor || [];
    if (importMeta) {
      state = importMeta.state;
      retainedFor = importMeta.retainedFor;
      sourceId = importMeta.sourceId;
      sourceRevision = importMeta.sourceRevision;
    }
    if (operation === "trash") {
      state = "trash";
      retainedFor = trashAudience(
        this.actor,
        current,
        this.directory.households[this.household].owner,
        this.directory.households[this.household].independent,
      );
    }
    if (operation === "restore") {
      state = "published";
      retainedFor = [];
    }
    if (operation === "release") {
      state = "trash";
      retainedFor = current.retainedFor.filter(
        (a) => !retentionIds(this.actor, this.household).includes(a),
      );
    }
    if (operation === "publish-new") state = "published";
    const scope =
      state === "published"
        ? publishedScope(this.household)
        : state === "draft"
          ? draftScope(this.household)
          : state === "preferences"
            ? preferencesScope(this.household, author)
            : trashScope(this.household, retainedFor);
    const epoch = this.directory.epochs[scope];
    if (!epoch) throw new Error("UnknownScope");
    const photoIds = (entry.photos || []).map((p) => p.id);
    const binding = {
      id,
      household: this.household,
      state,
      author,
      revision,
      retainedFor,
      sourceId,
      sourceRevision,
      epoch,
      scope,
      photoIds,
    };
    let key = this.keys.get(scope),
      keyBox = {};
    if (!key) {
      key = await newKey();
      keyBox = await recipientKeyBox(
        key,
        { ...binding, kind: "record-key" },
        this.directory.members.filter((m) => m.scopes.includes(scope)),
        this.directory.recoveryPublicKey,
      );
    }
    const envelope = await seal(
      key,
      { version: 1, entry },
      { ...binding, kind: "document" },
      {format:this.documentFormat},
    );
    const summary = await seal(
      key,
      state === "preferences"
        ? {}
        : {
            entryDate: entry.entryDate,
            title: entry.title,
            tags: entry.tags,
            weather: entry.weather,
            photoCount: photoIds.length,
          },
      { ...binding, kind: "summary" },
    );
    const proof = await signed(
      { binding, envelope, summary, keyBox, writer: this.actor.credentialId },
      this.privateKeys.sign,
    );
    const attestation = {
      writer: this.actor.credentialId,
      signature: proof.signature,
    };
    const proposal = {
      id,
      household: this.household,
      expectedRevision: importMeta ? 0 : revision - 1,
      epoch,
      state,
      envelope,
      summary,
      photoIds,
      requestId,
      sourceId,
      sourceRevision,
      keyBox,
      attestation,
      ...(draftId ? { draftId, draftRevision } : {}),
    };
    this.preparedBindings.set(proposal, binding);
    this.assertOpen(generation);
    return proposal;
  }
  async commit(
    entry,
    options = {},
    { refresh = true, prepared = null, onPrepared = () => {}, sessionChecked = false } = {},
  ) {
    if(sessionChecked)this.assertOpen();else await this.check();
    const generation = this.generation;
    const intentEntry = { ...entry };
    delete intentEntry.lastPublishedAt;
    delete intentEntry.updatedAt;
    delete intentEntry.createdAt;
    const intent = b64(
      await crypto.subtle.digest(
        "SHA-256",
        encode({ entry: intentEntry, options }),
      ),
    );
    const proposal =
      prepared ||
      this.pending.get(intent) ||
      (await this.prepare(entry, options, {sessionChecked:true}));
    this.assertOpen(generation);
    this.pending.set(intent, proposal);
    onPrepared(proposal);
    const result = await this.transport.mutation(
      proposal,
      options.operation || "save",
    );
    await this.check();
    if (generation !== this.generation) throw new Error("SessionChanged");
    if (
      !result?.ok ||
      result.id !== proposal.id ||
      !Number.isSafeInteger(result.revision) ||
      result.revision !==
        (options.importMeta?.revision || proposal.expectedRevision + 1)
    )
      throw new Error("InvalidReceipt");
    this.pending.delete(intent);
    if (refresh) {await this.sync({sessionChecked:true});if(this.records.has(result.id))await this.hydrate(result.id);}
    else {
      this.albumCache = null;
      this.records.set(proposal.id, {
        row: {
          ...this.preparedBindings.get(proposal),
          envelope: proposal.envelope,
          summary: proposal.summary,
          keyBox: proposal.keyBox,
          attestation: proposal.attestation,
        },
        entry: structuredClone(entry),
      });
    }
    return result;
  }
  async commitAction(key, entry, options, {sessionChecked=false}={}) {
    const saved = this.actions.get(key);
    entry = saved?.entry || entry;
    options = saved?.options || options;
    const result = await this.commit(entry, options, {
      sessionChecked,
      prepared: saved?.proposal,
      onPrepared: (proposal) =>
        this.actions.set(key, { entry, options, proposal }),
    });
    this.actions.delete(key);
    return result;
  }
  entry(id, summaryOnly=false) {
    const record = this.records.get(String(id));
    if (!record || !["published","draft","trash"].includes(record.row.state)) throw new InputError(404, "NotFound");
    if(!record.entry&&!summaryOnly)throw new InputError(425,'EntryNotReady');
    return {
      ...(record.entry||record.summary),
      ...(!record.entry&&record.order||{}),
      id: Number(record.row.id),
      revision: record.row.revision,
      status: record.row.state === "draft" ? "draft" : "published",
      deletedAt: record.row.state === "trash" ? record.entry?.deletedAt || "retained" : null,
      draftOfEntryId: record.row.sourceId ? Number(record.row.sourceId) : null,
      draftOfRevision: record.row.sourceRevision,
      isFavorite: this.favoriteIds().includes(String(id)),
    };
  }
  favoriteIds() {
    return (
      this.records.get(preferencesScope(this.household, this.actor.accountId))
        ?.entry.favorites || []
    );
  }
  async setFavorite(id, enabled) {
    await this.sync();
    await this.hydrate(id);
    this.entry(id);
    const recordId = preferencesScope(this.household, this.actor.accountId);
    const values = new Set(this.favoriteIds());
    enabled ? values.add(String(id)) : values.delete(String(id));
    await this.commit(
      { favorites: [...values] },
      {
        id: recordId,
        current: this.records.get(recordId)?.row || null,
        state: "preferences",
      },
    );
    return { ok: true, isFavorite: enabled };
  }
  async saveEntry(body, id = null) {
    const actionKey = b64(
      await crypto.subtle.digest(
        "SHA-256",
        encode({ method: "saveEntry", body, id }),
      ),
    );
    if (this.actions.has(actionKey)) {
      const result = await this.commitAction(actionKey);
      return { entry: this.entry(result.id) };
    }
    await this.sync();
    if(id)await this.hydrate(id);
    let current = id ? this.records.get(String(id)) : null;
    if (id && !current) throw new InputError(404, "NotFound");
    if (current && body.revision !== current.row.revision)
      throw new InputError(409, "RevisionConflict");
    const state = body.status === "draft" ? "draft" : "published";
    const valid = domain.validateEntryInput(body, {
      draft: state === "draft",
      allowEmptyContent: (body.pendingPhotoIds || []).length > 0,
    });
    const creation = !id && body.requestId ? await creationIdentity(this.actor,this.household,body.requestId,
      {state,...valid,pendingPhotoIds:body.pendingPhotoIds||[],photoUploadSessionId:body.photoUploadSessionId||null}) : null;
    if(creation&&this.records.has(creation.id)){
      await this.hydrate(creation.id);const existing=this.entry(creation.id);
      if(!existing.creation||!equal(existing.creation,creation.creation))throw new InputError(409,'IdempotencyConflict');
      return {entry:existing};
    }
    const contentFormat = valid.contentFormat
      ? JSON.parse(valid.contentFormat)
      : null;
    const photos = (current?.entry.photos || []).filter(
      (p) => !valid.excludedPhotoIds.includes(p.id),
    );
    const timestamp = await this.transport.timestamp();
    if (!Number.isFinite(Date.parse(timestamp)))
      throw new Error("InvalidServerTime");
    const entry = {
      ...current?.entry,
      ...valid,
      ...(creation?{creation:creation.creation}:{}),
      contentFormat,
      photos,
      authorName:
        state === "draft"
          ? this.profile.displayName
          : current?.entry.authorName || this.profile.displayName,
      authorId:
        state === "draft"
          ? this.actor.accountId
          : current?.row.author || this.actor.accountId,
      createdAt: current?.entry.createdAt || timestamp,
      updatedAt: timestamp,
      lastPublishedAt:
        state === "published"
          ? timestamp
          : current?.entry.lastPublishedAt || null,
    };
    let options = { current: current?.row || null, state, ...(creation?{id:creation.id,requestId:creation.creation.requestId}:{}) };
    if (current?.row.state === "published" && state === "draft") {
      const draft = [...this.records.values()].find(
        (r) => r.row.sourceId === current.row.id && r.row.state === "draft",
      );
      options = {
        current: draft?.row || null,
        state,
        sourceId: current.row.id,
        sourceRevision: current.row.revision,
      };
    } else if (
      current?.row.state === "draft" &&
      state === "published" &&
      current.row.sourceId
    ) {
      const source = this.records.get(current.row.sourceId);
      if (!source || source.row.revision !== current.row.sourceRevision)
        throw new InputError(409, "RevisionConflict");
      await this.hydrate(source.row.id);
      entry.authorId = source.row.author;
      entry.authorName = source.entry.authorName;
      options = {
        current: source.row,
        state: "published",
        operation: "publish",
        draftId: current.row.id,
        draftRevision: current.row.revision,
      };
    } else if (current?.row.state === "draft" && state === "published") {
      options = {
        current: current.row,
        state: "published",
        operation: "publish-new",
      };
    }
    const result = await this.commitAction(actionKey, entry, options, {sessionChecked:true});
    return { entry: this.entry(result.id) };
  }
  async transition(id, operation, revision) {
    const actionKey = `${operation}:${id}:${revision ?? "current"}`;
    if (this.actions.has(actionKey)) return this.commitAction(actionKey);
    const pendingKey = `${operation}:${id}`,
      pending = this.pendingDeletes.get(pendingKey);
    if (pending) {
      const result = await this.transport.remove(pending);
      this.pendingDeletes.delete(pendingKey);
      await this.sync();
      return result;
    }
    await this.sync();
    const record = this.records.get(String(id));
    if (!record) throw new InputError(404, "NotFound");
    await this.hydrate(id);
    if (revision != null && record.row.revision !== revision)
      throw new InputError(409, "RevisionConflict");
    if (operation === "purge" || operation === "discard") {
      if (record.row.state === "trash" && record.row.retainedFor.length > 1)
        return this.commitAction(actionKey, record.entry, {
          current: record.row,
          operation: "release",
        });
      const proposal = {
        id: record.row.id,
        household: this.household,
        revision: record.row.revision,
        requestId: crypto.randomUUID(),
      };
      this.pendingDeletes.set(pendingKey, proposal);
      const result = await this.transport.remove(proposal);
      this.pendingDeletes.delete(pendingKey);
      await this.sync();
      return result;
    }
    const timestamp = await this.transport.timestamp();
    if (!Number.isFinite(Date.parse(timestamp)))
      throw new Error("InvalidServerTime");
    const entry = {
      ...record.entry,
      updatedAt: timestamp,
      ...(operation === "trash" ? { deletedAt: timestamp, deletedById: this.actor.accountId, deletedByName: this.profile.displayName } : {}),
      ...(operation === "restore" ? { lastPublishedAt: timestamp, deletedAt: null, deletedById: null, deletedByName: null } : {}),
    };
    return this.commitAction(actionKey, entry, {
      current: record.row,
      operation,
    });
  }
  async attachPhotos(entryId,photos) {
    const actionKey=`attachPhotos:${entryId}:${photos.map(p=>p.id).sort().join(',')}`;
    if(this.actions.has(actionKey))return this.commitAction(actionKey);
    await this.sync();await this.hydrate(entryId);const record=this.records.get(String(entryId));
    if(!record||!['published','draft'].includes(record.row.state))throw new InputError(404,'NotFound');
    const existing=new Set(record.row.photoIds),added=photos.filter(p=>!existing.has(p.id));
    if(!added.length)return {ok:true,id:String(entryId),revision:record.row.revision};
    return this.commitAction(actionKey,{...record.entry,photos:[...record.entry.photos,...added]},{current:record.row,state:record.row.state});
  }
  async deletePhoto(id, revision) {
    const actionKey = `deletePhoto:${id}:${revision}`;
    if (this.actions.has(actionKey)) {
      const result = await this.commitAction(actionKey);
      const entry = this.entry(result.id);
      return {
        ...result,
        entryId: Number(result.id),
        content: entry.content,
        contentFormat: entry.contentFormat,
      };
    }
    await this.sync();
    const record = [...this.records.values()].find(
      (r) =>
        r.row.state === "published" && r.row.photoIds.includes(id),
    );
    if (!record) throw new InputError(404, "NotFound");
    await this.hydrate(record.row.id);
    if (
      record.row.revision !== revision ||
      [...this.records.values()].some((r) => r.row.sourceId === record.row.id)
    )
      throw new InputError(409, "RevisionConflict");
    let doc = {
      content: record.entry.content,
      contentFormat: record.entry.contentFormat,
    };
    for (const marker of findPhotoMarkers(doc.content))
      if (marker.id === id)
        doc = removeTextFromRichDocument(doc, marker.marker);
    const photos = record.entry.photos.filter((p) => p.id !== id);
    if (!doc.content.trim() && !photos.length)
      throw new InputError(409, "EmptyEntry");
    const result = await this.commitAction(
      actionKey,
      { ...record.entry, ...doc, photos },
      { current: record.row, state: "published" },
    );
    return { ...result, entryId: Number(result.id), ...doc };
  }
  async migrateLegacy(entries, onProgress = () => {}) {
    await this.sync();
    await this.ensureAll();
    for (let i = 0; i < entries.length; i++) {
      if (i && i % 25 === 0) await this.sync();
      const entry = structuredClone(entries[i]),
        id = String(entry.id);
      delete entry.id;
      const existing = this.records.get(id);
      if (existing) {
        if (!equal(existing.entry, entry)) throw new Error("MigrationConflict");
      } else {
        const source = entries[i];
        const state = source.deletedAt
          ? "trash"
          : source.status === "draft"
            ? "draft"
            : "published";
        const importMeta = {
          state,
          revision: source.revision || 1,
          author: source.authorId || this.actor.accountId,
          retainedFor: source.retainedFor || [],
          sourceId: source.draftOfEntryId
            ? String(source.draftOfEntryId)
            : null,
          sourceRevision: source.draftOfRevision || null,
        };
        await this.commit(
          entry,
          { id, state, operation: "import", importMeta },
          { refresh: false },
        );
      }
      onProgress({ completed: i + 1, total: entries.length });
    }
    await this.sync();
  }
  matchingEntries(parameters) {
    const draft = parameters.get("draft") === "1",
      trash = parameters.get("trash") === "1",
      favorite = parameters.get("favorite") === "1";
    const terms = splitSearchTerms(parameters.get("q")),
      tag = parameters.get("tag"),
      month = parameters.get("month"),
      from = parameters.get("dateFrom"),
      to = parameters.get("dateTo");
    let entries = [...this.records.values()]
      .filter(
        (r) =>
          r.row.state === (trash ? "trash" : draft ? "draft" : "published"),
      )
      .map((r) => this.entry(r.row.id,true));
    if (!draft)
      entries = entries.filter(
        (e) =>
          (!favorite || e.isFavorite) &&
          (!tag || e.tags.includes(tag)) &&
          (!month || e.entryDate.startsWith(month)) &&
          (!from || e.entryDate >= from) &&
          (!to || e.entryDate <= to) &&
          terms.every(
            (t) =>
              e.title.includes(t) ||
              e.content?.includes(t) ||
              e.tags.some((tag) => tag.includes(t)),
          ),
      );
    entries.sort(
      (a, b) =>
        (draft
          ? String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
          : b.entryDate.localeCompare(a.entryDate)) ||
        String(b.lastPublishedAt).localeCompare(String(a.lastPublishedAt)) ||
        b.id - a.id,
    );
    return entries;
  }
  list(parameters) {
    const entries=this.matchingEntries(parameters);
    const offset = Math.max(0, Number(parameters.get("offset")) || 0),
      limit = Math.min(50, Math.max(1, Number(parameters.get("limit")) || 20));
    return {
      entries: entries.slice(offset, offset + limit).map(e=>this.entry(e.id)),
      hasMore: entries.length > offset + limit,
      offset,
      limit,
    };
  }
  meta() {
    const months = new Map(),
      tags = new Map();
    for (const r of this.records.values())
      if (r.row.state === "published") {
        const e = r.entry||r.summary;
        const month = e.entryDate.slice(0, 7);
        months.set(month, (months.get(month) || 0) + 1);
        for (const tag of e.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
      }
    return {
      months: [...months]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([value, count]) => ({ value, count })),
      tags: [...tags]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count })),
      draftCount: [...this.records.values()].filter(
        (r) => r.row.state === "draft",
      ).length,
    };
  }
}

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
export class EncryptedDiaryClient {
  constructor({ transport, profile, anchor, minimumGeneration=1,documentFormat=1,cache=null,minimumSequence=0 }) {
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
    this.pending = new Map();
    this.closed = true;
    this.pendingDeletes = new Map();
    this.preparedBindings = new WeakMap();
  }
  async unlock(prf) {
    const generation = ++this.generation;
    this.closed = true;
    this.records.clear();
    this.keys.clear();this.recordKeys.clear();
    this.sequence = undefined;
    this.revisionFloor.clear();
    this.pending.clear();
    this.pendingDeletes.clear();
    this.actions.clear();
    this.privateKeys = null;
    const state = await unlockSession({
      prf,
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
    this.closed = true;
    this.keys.clear();this.recordKeys.clear();
    this.records.clear();
    this.revisionFloor.clear();
    this.pending.clear();
    this.pendingDeletes.clear();
    this.actions.clear();
    this.privateKeys = null;
  }
  async check() {
    if (this.closed || !(await this.transport.valid())) {
      this.lock();
      throw Object.assign(new Error("SessionExpired"), { status: 401 });
    }
  }
  get actor() {
    return this.profile.actor;
  }
  get household() {
    return this.profile.household;
  }
  async sync() {
    await this.check();
    const generation = this.generation;
    let cached=null;
    const cacheKey=[this.actor.accountId,this.actor.credentialId,this.household,this.directory.generation].join('/');
    if(this.sequence===undefined&&this.cache){try{cached=await this.cache.get(cacheKey);}catch{cached=null;}if(cached){validateSnapshot(cached);if(cached.delta||cached.unchanged||cached.household!==this.household)throw new Error('InvalidCache');}}
    const since=this.sequence??cached?.sequence??-1;
    let snapshot=await this.transport.snapshot(this.household,since);
    validateSnapshot(snapshot);
    if(snapshot.sequence<this.minimumSequence||snapshot.sequence<since)throw new Error('RollbackDetected');
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
      await this.check();
      for (const { row } of this.records.values())
        if (!canRead(this.actor, row)) throw new Error("AccessDenied");
      return this.records;
    }
    if (snapshot.delta && snapshot.baseSequence !== since)
      throw new Error("InvalidSnapshot");
    const records = snapshot.delta ? new Map(this.records) : new Map();
    for (const id of snapshot.removed) records.delete(id);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (cursor < snapshot.records.length) {
          const row = snapshot.records[cursor++];
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
            records.set(row.id, previous);
            continue;
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
            row.state !== "preferences" &&
            (typeof value.entry.title !== "string" ||
              typeof value.entry.content !== "string" ||
              !Array.isArray(value.entry.photos) ||
              !equal(
                value.entry.photos.map((p) => p.id),
                row.photoIds,
              ))
          )
            throw new Error("InvalidPayload");
          records.set(row.id, { row, entry: value.entry });
        }
      }),
    );
    await this.check();
    if (generation !== this.generation) throw new Error("SessionChanged");
    if (snapshot.sequence < (this.sequence ?? -1))
      throw new Error("RollbackDetected");
    for (const [id, previous] of this.records)
      if (!records.has(id))
        this.revisionFloor.set(id, previous.row.revision + 1);
    for (const [id, current] of records)
      this.revisionFloor.set(id, current.row.revision);
    this.records = records;
    this.sequence = snapshot.sequence;
    if(this.cache){const value={version:1,household:this.household,sequence:this.sequence,baseSequence:-1,delta:false,unchanged:false,removed:[],records:[...records.values()].map(r=>r.row)};try{await this.cache.put(cacheKey,value);}catch{/* Cache failure cannot turn a durable save into a failed save. */}}
    if(generation!==this.generation||this.closed)throw new Error("SessionChanged");
    return this.records;
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
  ) {
    await this.check();
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
    return proposal;
  }
  async commit(
    entry,
    options = {},
    { refresh = true, prepared = null, onPrepared = () => {} } = {},
  ) {
    await this.check();
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
      (await this.prepare(entry, options));
    this.pending.set(intent, proposal);
    onPrepared(proposal);
    const generation = this.generation;
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
    if (refresh) await this.sync();
    else
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
    return result;
  }
  async commitAction(key, entry, options) {
    const saved = this.actions.get(key);
    entry = saved?.entry || entry;
    options = saved?.options || options;
    const result = await this.commit(entry, options, {
      prepared: saved?.proposal,
      onPrepared: (proposal) =>
        this.actions.set(key, { entry, options, proposal }),
    });
    this.actions.delete(key);
    return result;
  }
  entry(id) {
    const record = this.records.get(String(id));
    if (!record) throw new InputError(404, "NotFound");
    return {
      ...record.entry,
      id: Number(record.row.id),
      revision: record.row.revision,
      status: record.row.state === "draft" ? "draft" : "published",
      deletedAt: record.row.state === "trash" ? "retained" : null,
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
    let current = id ? this.records.get(String(id)) : null;
    if (id && !current) throw new InputError(404, "NotFound");
    if (current && body.revision !== current.row.revision)
      throw new InputError(409, "RevisionConflict");
    const state = body.status === "draft" ? "draft" : "published";
    const valid = domain.validateEntryInput(body, {
      draft: state === "draft",
      allowEmptyContent: (body.pendingPhotoIds || []).length > 0,
    });
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
    let options = { current: current?.row || null, state };
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
    const result = await this.commitAction(actionKey, entry, options);
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
      ...(operation === "restore" ? { lastPublishedAt: timestamp } : {}),
    };
    return this.commitAction(actionKey, entry, {
      current: record.row,
      operation,
    });
  }
  async attachPhotos(entryId,photos) {
    const actionKey=`attachPhotos:${entryId}:${photos.map(p=>p.id).sort().join(',')}`;
    if(this.actions.has(actionKey))return this.commitAction(actionKey);
    await this.sync();const record=this.records.get(String(entryId));
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
        r.row.state === "published" && r.entry.photos?.some((p) => p.id === id),
    );
    if (!record) throw new InputError(404, "NotFound");
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
  list(parameters) {
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
      .map((r) => this.entry(r.row.id));
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
              e.content.includes(t) ||
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
    const offset = Math.max(0, Number(parameters.get("offset")) || 0),
      limit = Math.min(50, Math.max(1, Number(parameters.get("limit")) || 20));
    return {
      entries: entries.slice(offset, offset + limit),
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
        const e = r.entry;
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

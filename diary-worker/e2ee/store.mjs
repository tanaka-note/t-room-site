import { encode, b64, validateEnvelope } from "./crypto.mjs";
import {
  assertActor,
  assertWrite,
  canRead,
  investmentScope,
  publishedScope,
  draftScope,
  preferencesScope,
  trashAudience,
  trashScope,
  retentionIds,
} from "./policy.mjs";
import { writeLease,leaseSQL,leaseBindings } from "./rollout.mjs";
import { verifyRecord } from "./record.mjs";
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};
// Match the cold-reader budget. Include every account's preferences so a write
// cannot make any authorized reader's next snapshot unreadable.
const recordBytesSQL = ['envelope','summary','key_box','photo_ids','attestation']
  .map(column => `length(CAST(${column} AS BLOB))`).join('+') + '+1000';
const recordBytes = row => 1000 + [row.envelope,row.summary,row.keyBox,row.photoIds,row.attestation]
  .reduce((bytes,value) => bytes + encode(value).length,0);
export const parseRecord = (row) =>
  row
    ? {
        id: row.id,
        household: row.household,
        scope: row.scope,
        state: row.state,
        author: row.author,
        revision: row.revision,
        epoch: row.epoch,
        sourceId: row.source_id,
        sourceRevision: row.source_revision,
        retainedFor: JSON.parse(row.retained_for),
        envelope: JSON.parse(row.envelope),
        summary: JSON.parse(row.summary),
        photoIds: JSON.parse(row.photo_ids),
        keyBox: JSON.parse(row.key_box),
        attestation: JSON.parse(row.attestation),
      }
    : null;
export function createStore(db, registry) {
  const get = async (id) =>
    parseRecord(
      await db
        .prepare("SELECT * FROM diary_e2ee_records WHERE id=?")
        .bind(String(id))
        .first(),
    );
  const owner = (household) =>
    registry.households[household]?.owner || fail("UnknownHousehold", 403);
  function scope(row) {
    return row.state === "investment" ? investmentScope(row.household) : row.state === "published"
      ? publishedScope(row.household)
      : row.state === "draft"
        ? draftScope(row.household)
        : row.state === "preferences"
          ? preferencesScope(row.household, row.author)
          : trashScope(row.household, row.retainedFor);
  }
  function validate(proposal) {
    const allowed = [
      "id",
      "household",
      "expectedRevision",
      "epoch",
      "state",
      "envelope",
      "summary",
      "photoIds",
      "requestId",
      "sourceId",
      "sourceRevision",
      "keyBox",
      "attestation",
      "draftId",
      "draftRevision",
    ];
    if (
      !proposal ||
      Object.keys(proposal).some((k) => !allowed.includes(k)) ||
      !/^[\w:-]{1,160}$/.test(proposal.id) ||
      !Number.isSafeInteger(proposal.expectedRevision) ||
      proposal.expectedRevision < 0 ||
      !/^[0-9a-f-]{36}$/.test(proposal.requestId) ||
      !Array.isArray(proposal.photoIds) ||
      proposal.photoIds.length > 5000 ||
      new Set(proposal.photoIds).size !== proposal.photoIds.length ||
      proposal.photoIds.some((id) => !/^[0-9a-f-]{36}$/.test(id))
    )
      fail("InvalidRequest", 400);
    try {
      validateEnvelope(proposal.envelope);
      validateEnvelope(proposal.summary);
    } catch {
      fail("InvalidEnvelope", 400);
    }
  }
  async function mutation(actor, proposal, operation = "save") {
    validate(proposal);
    const lease=registry.enforceRollout?await writeLease(db,operation):null;
    const rolloutGuard=leaseSQL(lease),rolloutBindings=leaseBindings(lease);
    assertActor(actor, proposal.household);
    owner(proposal.household);
    const fingerprint = b64(
      await crypto.subtle.digest("SHA-256", encode({ operation, proposal })),
    );
    const requestLookup = () =>
      db
        .prepare(
          "SELECT fingerprint,result FROM diary_e2ee_requests WHERE household=? AND account_id=? AND request_id=?",
        )
        .bind(proposal.household, actor.accountId, proposal.requestId)
        .first();
    const replay = await requestLookup();
    if (replay) {
      if (replay.fingerprint !== fingerprint) fail("IdempotencyConflict");
      return JSON.parse(replay.result);
    }
    const current = await get(proposal.id);
    if (
      current &&
      (current.household !== proposal.household || !canRead(actor, current))
    )
      fail("AccessDenied", 403);
    if (current) assertWrite(actor, current);
    if (proposal.expectedRevision !== (current?.revision || 0))
      fail("RevisionConflict");
    if (!current && !["save", "import"].includes(operation))
      fail("NotFound", 404);
    const next = {
      id: proposal.id,
      household: proposal.household,
      state: current?.state || proposal.state,
      author: current?.author || actor.accountId,
      revision: proposal.expectedRevision + 1,
      retainedFor: current?.retainedFor || [],
      sourceId: current?.sourceId || proposal.sourceId || null,
      sourceRevision:
        current?.sourceRevision || proposal.sourceRevision || null,
      epoch: proposal.epoch,
    };
    if (operation === "import") {
      if (
        !registry.migrationEnabled ||
        !registry.migrators?.includes(actor.accountId) ||
        current
      )
        fail("MigrationDenied", 403);
      const legacy = registry.legacyRecords?.[proposal.id];
      if (
        !legacy ||
        legacy.household !== proposal.household ||
        !canRead(actor, legacy)
      )
        fail("MigrationDenied", 403);
      Object.assign(next, {
        state: legacy.state,
        author: legacy.author,
        revision: legacy.revision,
        retainedFor: legacy.retainedFor,
        sourceId: legacy.sourceId,
        sourceRevision: legacy.sourceRevision,
      });
      if (!equalIds(proposal.photoIds, legacy.photoIds))
        fail("MigrationSourceChanged");
    }
    if (next.state === "draft" && operation === "save")
      next.author = actor.accountId;
    if (!current) assertWrite(actor, next);
    if (
      !["published", "draft", "preferences", "investment"].includes(next.state) &&
      operation === "save" &&
      !current
    )
      fail("InvalidState", 400);
    if (operation === "trash") {
      if (current.state !== "published") fail("InvalidTransition");
      next.state = "trash";
      next.retainedFor = trashAudience(
        actor,
        current,
        owner(current.household),
        registry.households[current.household].independent,
      );
    } else if (operation === "restore") {
      if (current.state !== "trash" || !actor.canViewTrash)
        fail("AccessDenied", 403);
      next.state = "published";
      next.retainedFor = [];
    } else if (operation === "release") {
      if (current.state !== "trash" || !actor.canPermanentlyDelete)
        fail("AccessDenied", 403);
      next.retainedFor = current.retainedFor.filter(
        (id) => !retentionIds(actor, current.household).includes(id),
      );
      if (!next.retainedFor.length) fail("UsePermanentDelete");
    } else if (operation === "publish") {
      const draft = await get(proposal.draftId);
      if (
        current.state !== "published" ||
        !draft ||
        draft.household !== current.household ||
        draft.state !== "draft" ||
        draft.sourceId !== current.id ||
        draft.sourceRevision !== current.revision ||
        draft.revision !== proposal.draftRevision ||
        !canRead(actor, draft)
      )
        fail("RevisionConflict");
    } else if (operation === "publish-new") {
      if (current.state !== "draft" || current.sourceId)
        fail("InvalidTransition");
      next.state = "published";
    } else if (
      operation === "save" &&
      current &&
      proposal.state !== current.state
    )
      fail("InvalidTransition");
    else if (!["save", "import"].includes(operation)) fail("InvalidTransition");
    if (next.sourceId && operation !== "import") {
      const source = await get(next.sourceId);
      const continuingDraft = current?.state === "draft" && next.state === "draft"
        && next.sourceId === current.sourceId && next.sourceRevision === current.sourceRevision;
      if (
        !continuingDraft && (next.state !== "draft" ||
        !source ||
        source.household !== next.household ||
        source.state !== "published" ||
        !canRead(actor, source) ||
        !Number.isSafeInteger(next.sourceRevision) ||
        next.sourceRevision !== source.revision)
      )
        fail("InvalidDraftSource");
    }
    next.scope = scope(next);
    if (registry.epochs[next.scope] !== next.epoch) fail("KeyEpochConflict");
    const member = registry.directory.members.find(
      (m) =>
        m.accountId === actor.accountId &&
        m.credentialId === actor.credentialId,
    );
    if (!member) fail("AccessDenied", 403);
    const binding = { ...next, photoIds: proposal.photoIds };
    try {
      await verifyRecord(
        {
          ...binding,
          envelope: proposal.envelope,
          summary: proposal.summary,
          keyBox: proposal.keyBox,
          attestation: proposal.attestation,
        },
        registry.directory,
        {currentRecipients:true},
      );
    } catch {
      fail("InvalidAttestation", 400);
    }
    if (proposal.attestation.writer !== actor.credentialId)
      fail("InvalidAttestation", 400);
    const draftSource =
      operation === "publish"
        ? await get(proposal.draftId)
        : next.sourceId
          ? await get(next.sourceId)
          : null;
    for (const id of proposal.photoIds) {
      const retired = await db
        .prepare("SELECT photo_id FROM diary_e2ee_media_gc WHERE photo_id=?")
        .bind(id)
        .first();
      if (retired) fail("PhotoRetired");
      const photo = registry.photos[id];
      if(registry.enforceRollout&&photo?.household===next.household&&photo.accountId===actor.accountId&&!current?.photoIds.includes(id)&&!draftSource?.photoIds.includes(id)&&!photo.encrypted)fail('PhotoEncryptionRequired');
      if (
        !photo ||
        photo.household !== next.household ||
        (!current?.photoIds.includes(id) &&
          !draftSource?.photoIds.includes(id) &&
          (photo.accountId !== actor.accountId || registry.enforceRollout && (photo.status!=="ready"||photo.expiresAt<=Date.now()||!photo.encrypted)) &&
          operation !== "import")
      )
        fail("PhotoAccessDenied", 403);
    }
    const addedPhotos=proposal.photoIds.filter(id=>!current?.photoIds.includes(id)&&!draftSource?.photoIds.includes(id));
    const stagedGuard=registry.enforceRollout&&addedPhotos.length?` AND (SELECT COUNT(*) FROM diary_e2ee_media WHERE id IN (SELECT value FROM json_each(?)) AND status='ready' AND expires_at>? AND original_key LIKE 'diary/encrypted-photos/v1/%' AND display_key LIKE 'diary/encrypted-photos/v1/%' AND thumbnail_key LIKE 'diary/encrypted-photos/v1/%')=?`:'';
    const stagedBindings=stagedGuard?[JSON.stringify(addedPhotos),Date.now(),addedPhotos.length]:[];
    const values = [
      next.household,
      next.scope,
      next.state,
      next.author,
      next.revision,
      next.epoch,
      next.sourceId,
      next.sourceRevision,
      JSON.stringify(next.retainedFor),
      JSON.stringify(proposal.envelope),
      JSON.stringify(proposal.summary),
      JSON.stringify(proposal.photoIds),
      proposal.requestId,
      proposal.requestId,
      JSON.stringify(proposal.keyBox),
      JSON.stringify(proposal.attestation),
    ];
    const publishGuard =
      operation === "publish"
        ? ` AND EXISTS(SELECT 1 FROM diary_e2ee_records d WHERE d.id=? AND d.state='draft' AND d.revision=? AND d.source_id=diary_e2ee_records.id AND d.source_revision=diary_e2ee_records.revision)`
        : "";
    const photoRemoval =
      current?.state === "published" &&
      current.photoIds.some((id) => !proposal.photoIds.includes(id));
    const photoGuard =
      photoRemoval && operation !== "publish"
        ? ` AND NOT EXISTS(SELECT 1 FROM diary_e2ee_records d WHERE d.state='draft' AND d.source_id=diary_e2ee_records.id)`
        : "";
    const mediaGuard = ` AND NOT EXISTS(SELECT 1 FROM diary_e2ee_media_gc WHERE photo_id IN (SELECT value FROM json_each(?)))`;
    const excluded = [next.id, ...(operation === 'publish' ? [proposal.draftId] : [])];
    const nextBytes = recordBytes(proposal);
    const needsBudget = !current || nextBytes > recordBytes(current);
    const budgetSQL = `SELECT COUNT(*) AS count,COALESCE(SUM(${recordBytesSQL}),0) AS bytes FROM diary_e2ee_records WHERE household=? AND id NOT IN (SELECT value FROM json_each(?))`;
    const budgetBindings = [next.household,JSON.stringify(excluded)];
    const capacityGuard = needsBudget ? ` AND (SELECT count<5000 AND bytes+?<=50000000 FROM (${budgetSQL}))` : '';
    const capacityBindings = needsBudget ? [nextBytes,...budgetBindings] : [];
    const write = current
      ? db
          .prepare(
            `UPDATE diary_e2ee_records SET household=?,scope=?,state=?,author=?,revision=?,epoch=?,source_id=?,source_revision=?,retained_for=?,envelope=?,summary=?,photo_ids=?,request_id=?,mutation_id=?,key_box=?,attestation=? WHERE id=? AND revision=?${publishGuard}${photoGuard}${mediaGuard}${rolloutGuard}${stagedGuard}${capacityGuard}`,
          )
          .bind(
            ...values,
            next.id,
            current.revision,
            ...(operation === "publish"
              ? [proposal.draftId, proposal.draftRevision]
              : []),
            JSON.stringify(proposal.photoIds),
            ...rolloutBindings,...stagedBindings,...capacityBindings,
          )
      : db
          .prepare(
            `INSERT INTO diary_e2ee_records(household,scope,state,author,revision,epoch,source_id,source_revision,retained_for,envelope,summary,photo_ids,request_id,mutation_id,key_box,attestation,id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM diary_e2ee_media_gc WHERE photo_id IN (SELECT value FROM json_each(?)))${rolloutGuard}${stagedGuard}${capacityGuard} ON CONFLICT(id) DO NOTHING`,
          )
          .bind(...values,next.id,JSON.stringify(proposal.photoIds),...rolloutBindings,...stagedBindings,...capacityBindings);
    const result = { ok: true, id: next.id, revision: next.revision };
    assertActor(actor, next.household);
    const statements = [
      write,
      db
        .prepare(
          `INSERT INTO diary_e2ee_requests(household,account_id,request_id,fingerprint,result) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM diary_e2ee_records WHERE id=? AND revision=? AND mutation_id=?) ON CONFLICT DO NOTHING`,
        )
        .bind(
          next.household,
          actor.accountId,
          proposal.requestId,
          fingerprint,
          JSON.stringify(result),
          next.id,
          next.revision,
          proposal.requestId,
        ),
    ];
    if(registry.enforceRollout)statements.push(db.prepare(`UPDATE diary_e2ee_media SET status='attached' WHERE id IN (SELECT value FROM json_each(?)) AND household=? AND account_id=? AND status='ready' AND EXISTS(SELECT 1 FROM diary_e2ee_records WHERE id=? AND mutation_id=?)`).bind(JSON.stringify(addedPhotos),next.household,actor.accountId,next.id,proposal.requestId));
    if (operation === "publish")
      statements.push(
        db
          .prepare(
            `DELETE FROM diary_e2ee_records WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM diary_e2ee_records s WHERE s.id=? AND s.mutation_id=?)`,
          )
          .bind(
            proposal.draftId,
            proposal.draftRevision,
            next.id,
            proposal.requestId,
          ),
      );
    if (current)
      statements.push(
        ...gcStatements(
          current.photoIds.filter((id) => !proposal.photoIds.includes(id)),
          next.household,
          proposal.requestId,
          next.id,
        ),
      );
    await db.batch(statements);
    const saved = await requestLookup();
    if (!saved) {
      if(needsBudget){const budget=await db.prepare(budgetSQL).bind(...budgetBindings).first();if(budget.count>=5000||budget.bytes+nextBytes>50_000_000)fail('DiaryCapacityExceeded',413);}
      fail("RevisionConflict");
    }
    if (saved.fingerprint !== fingerprint) fail("IdempotencyConflict");
    return JSON.parse(saved.result);
  }
  function gcStatements(ids, household, mutationId, guardId = null) {
    return ids.map((id) =>
      db
        .prepare(
          `INSERT INTO diary_e2ee_media_gc(photo_id,household,mutation_id) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM diary_e2ee_records r,json_each(r.photo_ids) p WHERE p.value=?) ${guardId ? "AND EXISTS(SELECT 1 FROM diary_e2ee_records WHERE id=? AND mutation_id=?)" : ""} ON CONFLICT DO NOTHING`,
        )
        .bind(
          id,
          household,
          mutationId,
          id,
          ...(guardId ? [guardId, mutationId] : []),
        ),
    );
  }
  async function remove(actor, proposal) {
    const { id, household, revision, requestId } = proposal;
    assertActor(actor, household);
    const lease=registry.enforceRollout?await writeLease(db):null;
    const rolloutGuard=leaseSQL(lease),rolloutBindings=leaseBindings(lease);
    if (
      Object.keys(proposal).sort().join(",") !==
        "household,id,requestId,revision" ||
      !/^[\w:-]{1,160}$/.test(id) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !/^[0-9a-f-]{36}$/.test(requestId)
    )
      fail("InvalidRequest", 400);
    const fingerprint = b64(
      await crypto.subtle.digest(
        "SHA-256",
        encode({ operation: "remove", proposal }),
      ),
    );
    const lookup = () =>
      db
        .prepare(
          "SELECT fingerprint,result FROM diary_e2ee_requests WHERE household=? AND account_id=? AND request_id=?",
        )
        .bind(household, actor.accountId, requestId)
        .first();
    const replay = await lookup();
    if (replay) {
      if (replay.fingerprint !== fingerprint) fail("IdempotencyConflict");
      return JSON.parse(replay.result);
    }
    const row = await get(id);
    if (!row || row.household !== household || !canRead(actor, row))
      fail("NotFound", 404);
    assertWrite(actor, row);
    if (
      row.state !== "draft" &&
      (row.state !== "trash" || !actor.canPermanentlyDelete)
    )
      fail("AccessDenied", 403);
    if (row.revision !== revision) fail("RevisionConflict");
    if (row.state === "trash" && row.retainedFor.length > 1)
      fail("SharedRetentionRequiresRewrap");
    const result = { ok: true, id, revision: revision + 1, requestId };
    await db.batch([
      db
        .prepare(
          `INSERT INTO diary_e2ee_requests(household,account_id,request_id,fingerprint,result) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM diary_e2ee_records WHERE id=? AND household=? AND revision=?${rolloutGuard}) ON CONFLICT DO NOTHING`,
        )
        .bind(
          household,
          actor.accountId,
          requestId,
          fingerprint,
          JSON.stringify(result),
          id,
          household,
          revision,
          ...rolloutBindings,
        ),
      db
        .prepare(
          `DELETE FROM diary_e2ee_records WHERE id=? AND household=? AND revision=? AND EXISTS(SELECT 1 FROM diary_e2ee_requests WHERE household=? AND account_id=? AND request_id=? AND fingerprint=?)${rolloutGuard}`,
        )
        .bind(
          id,
          household,
          revision,
          household,
          actor.accountId,
          requestId,
          fingerprint,
          ...rolloutBindings,
        ),
      ...gcStatements(row.photoIds, household, requestId),
    ]);
    const saved = await lookup();
    if (!saved) fail("RevisionConflict");
    if (saved.fingerprint !== fingerprint) fail("IdempotencyConflict");
    return JSON.parse(saved.result);
  }
  async function snapshot(actor, household, since = -1) {
    assertActor(actor, household);
    if (!Number.isSafeInteger(since) || since < -1)
      fail("InvalidSequence", 400);
    // D1 batch is one consistent read transaction, including the sequence.
    // Unchanged sessions avoid reading/transferring/decrypting all documents.
    const [sequence, records] = await db.batch([
      db
        .prepare(
          "SELECT COALESCE(MAX(seq),0) AS seq FROM diary_e2ee_changes WHERE household=?",
        )
        .bind(household),
      db
        .prepare(
          "SELECT * FROM diary_e2ee_records WHERE household=? AND (SELECT COALESCE(MAX(seq),0) FROM diary_e2ee_changes WHERE household=?)>? ORDER BY id LIMIT 5001",
        )
        .bind(household, household, since),
    ]);
    if (records.results.length > 5000) fail("SnapshotLimit", 413);
    const seq = sequence.results[0].seq;
    return {
      version: 1,
      household,
      sequence: seq,
      unchanged: seq === since,
      delta: false,
      baseSequence: -1,
      removed: [],
      records: records.results.map(parseRecord).filter((row) => canRead(actor, row)),
    };
  }
  const visibleSQL=`(r.state='published' OR (r.state='investment' AND ?=1) OR (r.state='draft' AND ?=1) OR (r.state='preferences' AND r.author=?) OR (r.state='trash' AND ?=1 AND EXISTS(SELECT 1 FROM json_each(r.retained_for) owned WHERE owned.value IN (SELECT value FROM json_each(?)))))`;
  const visibleBindings=(actor,household)=>[actor.canViewInvestment?1:0,actor.canManageEntries?1:0,actor.accountId,actor.canViewTrash?1:0,JSON.stringify(retentionIds(actor,household))];
  async function snapshotHead(actor,household,{pageLimit=50}={}) {
    assertActor(actor,household);
    if(pageLimit!==50&&pageLimit!==100)fail('InvalidPage',400);
    const [sequence,records]=await db.batch([
      db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM diary_e2ee_changes WHERE household=?').bind(household),
      db.prepare(`SELECT r.id,${recordBytesSQL} bytes FROM diary_e2ee_records r WHERE r.household=? AND ${visibleSQL} ORDER BY r.id LIMIT 5001`).bind(household,...visibleBindings(actor,household))
    ]);
    if(records.results.length>5000||records.results.reduce((n,r)=>n+r.bytes,0)>50_000_000)fail('SnapshotLimit',413);
    const pages=[];let after=null,previous=null,count=0,bytes=0;
    for(const row of records.results){if(count&&(count===pageLimit||bytes+row.bytes>1_000_000)){pages.push({after,limit:count});after=previous;count=0;bytes=0;}count++;bytes+=row.bytes;previous=row.id;}
    if(count)pages.push({after,limit:count});
    return {version:1,household,sequence:sequence.results[0].seq,total:records.results.length,pages};
  }
  async function snapshotPage(
    actor,
    household,
    { since = -1, after = null, at = null, limit = 50 } = {},
  ) {
    assertActor(actor, household);
    // The negotiated larger page is only for an initial fixed-sequence read.
    const fullSnapshot=since===-1&&at!==null;
    if (
      !Number.isSafeInteger(since) ||
      since < -1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > (fullSnapshot?100:50) ||
      (after !== null && !/^[\w:-]{1,160}$/.test(after)) ||
      (at !== null && (!Number.isSafeInteger(at) || at < 0))
    )
      fail("InvalidPage", 400);
    const estimate=limit>50?`,${recordBytesSQL} AS estimated_bytes`:'';
    const query =
      since < 0
        ? db
            .prepare(
              `SELECT r.*,r.id change_id${estimate} FROM diary_e2ee_records r WHERE r.household=? AND r.id>? AND ${visibleSQL} ORDER BY r.id LIMIT ?`,
            )
            .bind(household,after||"",...visibleBindings(actor,household),limit+1)
        : db
            .prepare(
              `SELECT r.*,c.id AS change_id FROM (SELECT id,MAX(seq) seq FROM diary_e2ee_changes WHERE household=? AND seq>? GROUP BY id) c LEFT JOIN diary_e2ee_records r ON r.id=c.id AND r.household=? WHERE c.id>? ORDER BY c.id LIMIT ?`,
            )
            .bind(household, since, household, after || "", limit + 1);
    const [sequence, result] = await db.batch([
      db
        .prepare(
          "SELECT COALESCE(MAX(seq),0) AS seq FROM diary_e2ee_changes WHERE household=?",
        )
        .bind(household),
      query,
    ]);
    const seq = sequence.results[0].seq;
    if (at !== null && seq !== at) fail("SnapshotChanged");
    const rows = result.results.slice(0, limit),
      records = [],
      removed = [];
    if(limit>50&&rows.reduce((total,row)=>total+row.estimated_bytes,0)>1_000_000)fail('SnapshotPageLimit',413);
    for (const raw of rows) {
      const row = raw.id === null ? null : parseRecord(raw);
      if (row && canRead(actor, row)) records.push(row);
      else if (since >= 0) removed.push(raw.change_id);
    }
    return {
      version: 1,
      household,
      sequence: seq,
      unchanged: seq === since,
      delta: since >= 0,
      baseSequence: since,
      records,
      removed,
      nextCursor: result.results.length > limit ? rows.at(-1).change_id : null,
    };
  }
  return { get, mutation, remove, snapshot, snapshotPage, snapshotHead, scope };
}
const equalIds = (a, b) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

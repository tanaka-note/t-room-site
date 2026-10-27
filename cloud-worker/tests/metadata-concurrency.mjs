import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Called by member-api-boundary so the normal Cloud CI runs these real-handler
// regressions with the existing authenticated, in-memory SQLite fixture.
export async function checkMetadataConcurrency({ db, env, api, adminCookie, memberCookie }) {
  const folderKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const pack = await TRoomCrypto.createFilePackage({ name: "before.pdf", type: "application/pdf", size: 1, lastModified: 1 }, folderKey, "document");
  const before = { encryptedMetadata: pack.payload.encryptedMetadata, metadataIv: pack.payload.metadataIv };
  const after = await TRoomCrypto.encryptFileMetadata({ name: "after.pdf" }, pack.fileKey);
  const latest = await TRoomCrypto.encryptFileMetadata({ name: "latest.pdf" }, pack.fileKey);
  const expected = { expectedEncryptedMetadata: before.encryptedMetadata, expectedMetadataIv: before.metadataIv };
  const display = name => ({ name, mimeType: "application/pdf", mediaKind: "document", signature: "pdf" });
  for (let id = 800; id < 850; id++) {
    db.prepare(`INSERT INTO cloud_files(id,folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by,
      crypto_version,encrypted_metadata,metadata_iv,wrapped_file_key,file_key_iv,display_metadata_version,display_media_kind,display_name)
      VALUES(?,7,?,'[encrypted]','application/octet-stream','other',1,'ready','admin',1,?,?,?,?,1,'document','before.pdf')`)
      .run(id, `metadata-race-${id}`, before.encryptedMetadata, before.metadataIv, pack.payload.wrappedFileKey, pack.payload.fileKeyIv);
  }
  const reset = () => db.prepare(`UPDATE cloud_files SET encrypted_metadata=?,metadata_iv=?,display_name='before.pdf',
    status='ready',deleted_at=NULL,crypto_version=1 WHERE id BETWEEN 800 AND 849`).run(before.encryptedMetadata, before.metadataIv);
  const stored = id => db.prepare("SELECT encrypted_metadata,metadata_iv,display_name FROM cloud_files WHERE id=?").get(id);
  const decryptedName = async id => {
    const row = stored(id);
    return (await TRoomCrypto.decryptFileMetadata({ encryptedMetadata: row.encrypted_metadata, metadataIv: row.metadata_iv }, pack.fileKey)).name;
  };
  const entry = (id, fastDisplay) => ({ id, ...after, ...expected, ...(fastDisplay ? { fastDisplay } : {}) });
  const batch = entries => api(adminCookie, "/files/batch-metadata", "POST", { operationId: "metadata_race_test", entries });
  const single = (id, body) => api(adminCookie, `/files/${id}`, "PATCH", body);
  const auditCount = () => db.prepare("SELECT COUNT(*) AS n FROM cloud_audit_logs WHERE event_type='file_metadata_batch_updated'").get().n;
  async function interleave(pattern, outer, inner) {
    const original = env.DB.prepare;
    let pending = true;
    function intercept(sql, args = []) {
      assert.ok(args.length <= 100, "stay within D1's per-statement parameter limit");
      const statement = original(sql).bind(...args);
      return { ...statement, bind(...values) { return intercept(sql, values); }, async run() {
        if (pending && sql.startsWith(pattern)) { pending = false; await inner(); }
        return statement.run();
      } };
    }
    env.DB.prepare = intercept;
    try {
      const result = await outer();
      assert.equal(pending, false, "the competing operation ran between SELECT and UPDATE");
      return result;
    } finally { env.DB.prepare = original; }
  }

  // A request prepared before an already-completed rename must fail atomically.
  assert.equal((await single(800, { ...latest, fastDisplay: display("latest.pdf") })).status, 200);
  const auditBefore = auditCount();
  assert.equal((await batch([entry(801, display("after.pdf")), entry(800, display("after.pdf"))])).status, 409);
  assert.equal(await decryptedName(800), "latest.pdf");
  assert.equal(stored(800).display_name, "latest.pdf");
  assert.equal(await decryptedName(801), "before.pdf");
  assert.equal(stored(801).display_name, "before.pdf");
  assert.equal(auditCount(), auditBefore, "failed batches do not record success");

  reset();
  let result = await interleave("WITH metadata_input", () => batch([entry(800), entry(801)]), async () => {
    assert.equal((await single(801, latest)).status, 200);
  });
  assert.equal(result.status, 409);
  assert.equal(await decryptedName(800), "before.pdf");
  assert.equal(await decryptedName(801), "latest.pdf");
  for (const change of ["deleted_at='concurrent delete'", "status='failed'", "crypto_version=0", "metadata_iv='differentIV'"]) {
    reset();
    result = await interleave("WITH metadata_input", () => batch([entry(800), entry(801)]), async () => {
      db.exec(`UPDATE cloud_files SET ${change} WHERE id=801`);
    });
    assert.equal(result.status, 409);
    assert.equal(await decryptedName(800), "before.pdf", "one invalid entry leaves every other entry unchanged");
  }
  reset();
  assert.equal((await batch([{ id: 800, ...after }])).status, 400, "batch preconditions are required");
  assert.equal((await batch([{ ...entry(800), expectedMetadataIv: "bad IV" }])).status, 400);
  assert.equal((await batch([entry(800), entry(800)])).status, 400);
  assert.equal((await api(memberCookie, "/files/batch-metadata", "POST", { operationId: "metadata_race_test", entries: [entry(800)] })).status, 403);
  result = await interleave("WITH metadata_input", () => batch(Array.from({ length: 50 }, (_, i) => entry(800 + i, i === 0 ? display("after.pdf") : null))), async () => {});
  assert.equal(result.status, 200);
  assert.equal(result.body.updated.length, 50);
  for (let id = 800; id < 850; id++) {
    assert.equal(await decryptedName(id), "after.pdf");
    assert.equal(stored(id).display_name, id === 800 ? "after.pdf" : "before.pdf", "omitted display fields are retained");
  }
  assert.equal((await batch([entry(800)])).status, 409, "an old operation cannot be replayed");

  // Updated Web clients send their original pair, not the server's later read.
  reset();
  assert.equal((await single(800, latest)).status, 200);
  assert.equal((await single(800, { ...after, ...expected })).status, 409);
  assert.equal(await decryptedName(800), "latest.pdf");
  assert.equal((await single(800, { ...after, expectedEncryptedMetadata: before.encryptedMetadata })).status, 400);
  assert.equal((await single(800, { ...after, expectedEncryptedMetadata: latest.encryptedMetadata, expectedMetadataIv: latest.metadataIv })).status, 200);
  assert.equal(await decryptedName(800), "after.pdf");
  reset();
  result = await interleave("UPDATE cloud_files SET encrypted_metadata", () => single(800, { ...after, ...expected }), async () => {
    assert.equal((await single(800, latest)).status, 200);
  });
  assert.equal(result.status, 409);
  assert.equal(await decryptedName(800), "latest.pdf");

  db.exec("INSERT INTO cloud_folders(id,parent_id,name,created_by,parent_wrapped_key,parent_wrap_iv) VALUES(850,7,'before','admin','AA','AA')");
  const resetFolder = () => db.exec("UPDATE cloud_folders SET name='before',parent_id=7,parent_wrapped_key='AA',parent_wrap_iv='AA',deleted_at=NULL WHERE id=850");
  const folder = () => db.prepare("SELECT name,parent_id,parent_wrapped_key,deleted_at FROM cloud_folders WHERE id=850").get();
  const move = extra => api(adminCookie, "/folders/850", "PATCH", { name: "stale", parentId: 9, parentWrappedKey: "BB", parentWrapIv: "BB", ...extra });
  for (const conditional of [false, true]) {
    const extra = conditional ? { expectedParentId: 7 } : {};
    resetFolder();
    assert.equal((await api(adminCookie, "/folders/850", "PATCH", { name: "latest" })).status, 200);
    assert.equal((await move(extra)).status, 200);
    assert.equal(folder().name, "latest", "even a delayed legacy move preserves a completed rename");
    assert.equal(folder().parent_id, 9);
    for (const change of ["name='concurrent'", "parent_id=9,parent_wrapped_key='CC'", "parent_wrapped_key='CC'", "deleted_at='concurrent delete'"]) {
      resetFolder();
      result = await interleave("UPDATE cloud_folders SET name = ?, parent_id", () => move(extra), async () => {
        db.exec(`UPDATE cloud_folders SET ${change} WHERE id=850`);
      });
      assert.equal(result.status, 409, "every folder move checks the authorized snapshot");
      assert.notEqual(folder().parent_wrapped_key, "BB");
    }
    resetFolder();
    assert.equal((await move({ ...extra, passwordAction: "replace" })).status, 400);
    assert.equal(folder().parent_id, 7, "rejected combined operations change nothing");
  }
  resetFolder();
  assert.equal((await move({ expectedParentId: 9 })).status, 409);
  await checkClientPreconditions();
  console.log("PASS metadata concurrency: atomic 50-entry batches, delayed/replayed requests, Web preconditions and unconditional folder move checks");
}

async function checkClientPreconditions() {
  const elements = new Map();
  const calls = [];
  const sandbox = vm.createContext({
    console, crypto,
    document: { addEventListener() {}, querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { value: "", textContent: "", close() {} });
      return elements.get(selector);
    } },
    TCloudMediaFormat: { normalizeContainer() { return null; } },
    TRoomCrypto: { async encryptFileMetadata() {
      // Mutate the shared record while encryption is awaited. Preconditions
      // must still describe the snapshot used to compute the outgoing metadata.
      vm.runInContext("state.selected.encryptedMetadata = 'concurrent'; state.selected.metadataIv = 'concurrentIv'", sandbox);
      return { encryptedMetadata: "outgoing", metadataIv: "outgoingIv" };
    } },
    recordCall(path, options) { calls.push({ path, body: JSON.parse(options.body) }); return {}; }
  });
  vm.runInContext(readFileSync(new URL("../public/cloud.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext(`
    api = async (path, options) => recordCall(path, options);
    canRenameFile = () => true;
    setNotice = invalidateStoredConflicts = updateDurationDisplay = () => {};
    loadItems = async () => {};
    state.session = { role: 'admin' };
    state.selected = { id: 800, name: 'before.pdf', mediaKind: 'document', cryptoVersion: 1,
      fileKey: {}, encryptedMetadata: 'original', metadataIv: 'originalIv' };
    $('#edit-file-id').value = '800'; $('#edit-name').value = 'after.pdf';
  `, sandbox);
  await vm.runInContext("saveFile({preventDefault(){}})", sandbox);
  await vm.runInContext(`
    state.selected.encryptedMetadata = 'original'; state.selected.metadataIv = 'originalIv';
    persistMediaDuration(state.selected, 20);
  `, sandbox);
  await vm.runInContext(`
    state.selected.encryptedMetadata = 'original'; state.selected.metadataIv = 'originalIv';
    state.batchRenamePlan = {operations:[{file:state.selected, after:'batch.pdf'}], already:[]};
    executeBatchRename();
  `, sandbox);
  assert.equal(calls.length, 3, "rename, duration persistence and batch execution all sent requests");
  for (const call of calls) {
    const body = call.body.entries?.[0] || call.body;
    assert.equal(body.expectedEncryptedMetadata, "original");
    assert.equal(body.expectedMetadataIv, "originalIv");
    assert.equal(body.encryptedMetadata, "outgoing");
  }
}

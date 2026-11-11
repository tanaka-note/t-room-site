import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fixture, provision, entry } from "./fixture.mjs";
import {
  b64,
  encode,
  openRecipientKey,
  open,
  seal,
  newKey,
  createVault,
  unlockVault,
  verifyDirectory,
  signed,
  makeGrant,
  fingerprint,
  unwrapGrant,
} from "../../e2ee/crypto.mjs";
import { backup, restoreEmpty } from "../../e2ee/backup.mjs";
import { memoryDatabase } from "./sqlite.mjs";
import { createStore } from "../../e2ee/store.mjs";
import {
  createRecoveryEnvelope,
  openRecoveryEnvelope,
} from "../../e2ee/recovery.mjs";
import { readSnapshotPages } from "../../e2ee/snapshot.mjs";
import { validateSnapshot } from "../../e2ee/record.mjs";
let provisioned;
before(async () => {
  provisioned = await provision();
});
test("PRF vault: wrong PRF, cross-credential labels, tampering and non-extractable unlocked keys", async () => {
  const prf = crypto.getRandomValues(new Uint8Array(32)),
    vault = await createVault(prf, "synthetic-vault");
  const key = await unlockVault(prf, "synthetic-vault", vault);
  assert.equal(key.rsa.extractable, false);
  assert.equal(key.sign.extractable, false);
  await assert.rejects(
    unlockVault(
      crypto.getRandomValues(new Uint8Array(32)),
      "synthetic-vault",
      vault,
    ),
  );
  await assert.rejects(unlockVault(prf, "other-credential", vault));
  await assert.rejects(createVault(null, "synthetic-vault"), /PRFRequired/);
  const wrong = structuredClone(vault);
  wrong.privateEnvelope.ciphertext =
    (wrong.privateEnvelope.ciphertext[0] === "A" ? "B" : "A") +
    wrong.privateEnvelope.ciphertext.slice(1);
  await assert.rejects(unlockVault(prf, "synthetic-vault", wrong));
});
test("scope, revision and kind authenticate ciphertext; different writes get different IVs", async () => {
  const key = await newKey(),
    binding = {
      household: "A",
      scope: "A:published",
      id: "1",
      revision: 1,
      epoch: 1,
      kind: "document",
    };
  const box = await seal(key, { title: "synthetic" }, binding);
  assert.deepEqual(await open(key, box, binding), { title: "synthetic" });
  assert.notEqual(
    box.iv,
    (await seal(key, { title: "synthetic" }, binding)).iv,
  );
  for (const changed of [
    { household: "B" },
    { revision: 2 },
    { kind: "summary" },
  ])
    await assert.rejects(open(key, box, { ...binding, ...changed }));
});
test("directory substitution and rollback are rejected against externally pinned authority", async () => {
  const fake = structuredClone(provisioned.packet);
  fake.value.members[0].publicKey = provisioned.directory.members[1].publicKey;
  await assert.rejects(
    verifyDirectory(fake, provisioned.anchor, 1),
    /InvalidSignature/,
  );
  await assert.rejects(
    verifyDirectory(provisioned.packet, provisioned.anchor, 2),
    /StaleDirectory/,
  );
});
test("two households, ordinary editors, reader restrictions and ciphertext-only server storage", async () => {
  const f = await fixture(provisioned);
  try {
    const owner = await f.client("ownerA"),
      user = await f.client("userA"),
      viewer = await f.client("viewerA"),
      other = await f.client("ownerB", "B");
    const saved = await user.saveEntry(entry());
    const id = saved.entry.id;
    await owner.sync();
    assert.equal(owner.entry(id).content, entry().content);
    await viewer.sync();
    assert.equal(viewer.entry(id).title, entry().title);
    await assert.rejects(viewer.saveEntry(entry()), /AccessDenied/);
    await other.sync();
    assert.equal(other.records.size, 0);
    await assert.rejects(f.store.snapshot(f.actors.userA, "B"), /AccessDenied/);
    const dump =
      JSON.stringify(
        f.db.sqlite.prepare("SELECT * FROM diary_e2ee_records").all(),
      ) + JSON.stringify(f.wire);
    for (const value of [
      "CANARY_PRIVATE_TITLE",
      "CANARY_PRIVATE_BODY",
      "CANARY_PRIVATE_TAG",
      "CANARY_PRIVATE_AUTHOR",
      "2026-01-23",
    ])
      assert.equal(dump.includes(value), false, value);
  } finally {
    f.close();
  }
});
test("shared drafts preserve the published version and publish atomically", async () => {
  const f = await fixture(provisioned);
  try {
    const owner = await f.client("ownerA"),
      editor = await f.client("editorA");
    const first = (await owner.saveEntry(entry())).entry;
    const draft = (
      await owner.saveEntry(
        { ...first, title: "edited", status: "draft" },
        first.id,
      )
    ).entry;
    assert.notEqual(draft.id, first.id);
    await editor.sync();
    assert.equal(editor.entry(first.id).title, first.title);
    assert.equal(editor.entry(draft.id).title, "edited");
    const published = (
      await editor.saveEntry({ ...draft, status: "published" }, draft.id)
    ).entry;
    assert.equal(published.id, first.id);
    assert.equal(published.title, "edited");
    assert.equal(published.authorName, first.authorName);
    assert.equal(editor.records.has(String(draft.id)), false);
    const fresh = (await editor.saveEntry({ ...entry(), status: "draft" }))
      .entry;
    assert.equal(
      (await editor.saveEntry({ ...fresh, status: "published" }, fresh.id))
        .entry.id,
      fresh.id,
    );
  } finally {
    f.close();
  }
});
test("concurrent edits and stale edit drafts fail without overwriting the newer version", async () => {
  const f = await fixture(provisioned);
  try {
    const a = await f.client("ownerA"),
      b = await f.client("editorA"),
      first = (await a.saveEntry(entry())).entry;
    const draft = (await a.saveEntry({ ...first, status: "draft" }, first.id))
      .entry;
    await b.saveEntry({ ...first, title: "newer" }, first.id);
    await assert.rejects(
      a.saveEntry({ ...first, title: "stale" }, first.id),
      /RevisionConflict/,
    );
    await assert.rejects(
      a.saveEntry({ ...draft, status: "published" }, draft.id),
      /RevisionConflict/,
    );
    await a.sync();
    assert.equal(a.entry(first.id).title, "newer");
    assert.ok(a.records.has(String(draft.id)));
  } finally {
    f.close();
  }
});
test("response loss reuses the exact ciphertext/request id and does not create duplicates", async () => {
  const f = await fixture(provisioned);
  try {
    const client = await f.client("ownerA"),
      original = client.transport.mutation;
    let once = true;
    client.transport.mutation = async (p, op) => {
      const r = await original(p, op);
      if (once) {
        once = false;
        throw new Error("ConnectionLost");
      }
      return r;
    };
    await assert.rejects(client.saveEntry(entry()), /ConnectionLost/);
    await client.saveEntry(entry());
    assert.equal(
      f.db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM diary_e2ee_records")
        .get().count,
      1,
    );
    const attempts = f.wire.filter((x) => x.proposal?.envelope);
    assert.deepEqual(attempts[0].proposal, attempts[1].proposal);
  } finally {
    f.close();
  }
});
test("personal retention is isolated and global-owner removal preserves the personal copy", async () => {
  const f = await fixture(provisioned);
  try {
    const user = await f.client("userA"),
      owner = await f.client("ownerA"),
      other = await f.client("editorA");
    const e = (await user.saveEntry(entry())).entry;
    await user.transition(e.id, "trash", e.revision);
    await owner.sync();
    assert.equal(owner.entry(e.id).deletedAt, "retained");
    await other.sync();
    assert.equal(other.records.has(String(e.id)), false);
    await owner.transition(e.id, "purge");
    assert.equal(owner.records.has(String(e.id)), false);
    await user.sync();
    assert.equal(user.entry(e.id).title, e.title);
    await user.transition(e.id, "restore");
    assert.equal(user.entry(e.id).deletedAt, null);
  } finally {
    f.close();
  }
});
test("independent household trash is available through the existing global-owner alias", async () => {
  const f = await fixture(provisioned, "B");
  try {
    const owner = await f.client("ownerA", "B"),
      local = await f.client("ownerB", "B");
    const e = (await owner.saveEntry(entry())).entry;
    await local.transition(e.id, "trash", e.revision);
    await owner.sync();
    assert.equal(owner.entry(e.id).deletedAt, "retained");
    await owner.transition(e.id, "purge");
    await local.sync();
    assert.equal(local.records.size, 0);
  } finally {
    f.close();
  }
});
test("favorites stay account-specific, with literal AND search and encrypted dates/tags", async () => {
  const f = await fixture(provisioned);
  try {
    const a = await f.client("ownerA"),
      b = await f.client("userA"),
      e = (await a.saveEntry(entry())).entry;
    await a.setFavorite(e.id, true);
    await b.sync();
    assert.equal(b.entry(e.id).isFavorite, false);
    assert.equal(
      a.list(
        new URLSearchParams({
          q: "公園 お弁当",
          favorite: "1",
          month: "2026-01",
        }),
      ).entries.length,
      1,
    );
    assert.equal(
      a.list(new URLSearchParams({ q: "公園 ABC" })).entries.length,
      0,
    );
    assert.deepEqual(a.meta().months, [{ value: "2026-01", count: 1 }]);
  } finally {
    f.close();
  }
});
test("lossless metadata migration resumes, detects changed source data, and never deletes originals", async () => {
  const f = await fixture(provisioned);
  try {
    const client = await f.client("ownerA"),
      legacy = [
        {
          id: 101,
          ...entry(),
          content: "  exact whitespace\n",
          contentFormat: {
            version: 1,
            runs: [{ start: 2, end: 5, bold: true }],
          },
          legacyNullable: null,
          legacyRevision: 17,
        },
      ];
    Object.assign(f.registry, {
      migrationEnabled: true,
      migrators: ["ownerA"],
      legacyRecords: {
        101: {
          id: "101",
          household: "A",
          state: "published",
          revision: 1,
          author: "ownerA",
          retainedFor: [],
          sourceId: null,
          sourceRevision: null,
          photoIds: [],
        },
      },
    });
    const before = structuredClone(legacy);
    await client.migrateLegacy(legacy);
    await client.migrateLegacy(legacy);
    assert.deepEqual(legacy, before);
    assert.equal(client.records.size, 1);
    assert.deepEqual(
      client.records.get("101").entry,
      (({ id, ...rest }) => rest)(legacy[0]),
    );
    await assert.rejects(
      client.migrateLegacy([{ ...legacy[0], title: "changed" }]),
      /MigrationConflict/,
    );
  } finally {
    f.close();
  }
});
test("encrypted backup restores into empty SQLite and is actually decrypted with the original PRF", async () => {
  const f = await fixture(provisioned),
    restored = memoryDatabase();
  try {
    const client = await f.client("ownerA");
    const e = (await client.saveEntry(entry())).entry;
    await client.setFavorite(e.id, true);
    const packet = await backup(f.db, {
      directory: provisioned.packet,
      vaults: Object.fromEntries(
        Object.entries(provisioned.profiles).map(([id, p]) => [id, p.vault]),
      ),
      grants: Object.fromEntries(
        Object.entries(provisioned.profiles).map(([id, p]) => [id, p.grants]),
      ),
    });
    assert.equal(JSON.stringify(packet).includes(entry().content), false);
    const result = await restoreEmpty(restored, packet, {
      anchor: provisioned.anchor,
      minimumGeneration: 1,
    });
    assert.equal(result.records, 2);
    const store = createStore(restored, f.registry);
    client.transport.snapshot = (h) => store.snapshot(f.actors.ownerA, h);
    client.sequence = undefined;
    await client.sync();
    assert.equal(client.entry(e.id).content, entry().content);
    assert.equal(client.entry(e.id).isFavorite, true);
    await assert.rejects(
      restoreEmpty(restored, packet, {
        anchor: provisioned.anchor,
        minimumGeneration: 1,
      }),
      /RestoreRequiresEmptyDatabase/,
    );
    const corrupt = structuredClone(packet);
    corrupt.value.tables.diary_e2ee_records[0].envelope = "{}";
    await assert.rejects(
      restoreEmpty(restored, corrupt, {
        anchor: provisioned.anchor,
        minimumGeneration: 1,
      }),
      /BackupIntegrityFailure/,
    );
  } finally {
    f.close();
    restored.close();
  }
});
test("revocation and delayed responses erase client state and do not reopen records", async () => {
  const f = await fixture(provisioned);
  try {
    const c = await f.client("ownerA");
    await c.saveEntry(entry());
    const original = c.transport.snapshot;
    let resolve;
    const pending = new Promise((r) => {
      resolve = r;
    });
    c.transport.snapshot = async (h) => {
      const result = await original(h);
      await pending;
      return result;
    };
    const load = c.sync();
    await new Promise((r) => setTimeout(r, 10));
    c.lock();
    resolve();
    await assert.rejects(load, /SessionExpired|SessionChanged/);
    assert.equal(c.records.size, 0);
    assert.equal(c.keys.size, 0);
    const d = await f.client("userA");
    f.actors.userA.active = false;
    await assert.rejects(d.sync(), /SessionExpired/);
    assert.equal(d.keys.size, 0);
  } finally {
    f.close();
  }
});

test("backup metadata substitution is rejected even if an attacker recomputes the checksum", async () => {
  const f = await fixture(provisioned),
    target = memoryDatabase();
  try {
    const client = await f.client("ownerA");
    await client.saveEntry(entry());
    const packet = await backup(f.db, {
      directory: provisioned.packet,
      vaults: {},
      grants: {},
    });
    packet.value.tables.diary_e2ee_records[0].author = "editorA";
    packet.digest = b64(
      await crypto.subtle.digest("SHA-256", encode(packet.value)),
    );
    await assert.rejects(
      restoreEmpty(target, packet, {
        anchor: provisioned.anchor,
        minimumGeneration: 1,
      }),
      /InvalidSignature/,
    );
    assert.equal(
      target.sqlite.prepare("SELECT COUNT(*) n FROM diary_e2ee_records").get()
        .n,
      0,
    );
  } finally {
    f.close();
    target.close();
  }
});
test("a viewer with a read key cannot forge an editor signature, even through a compromised store", async () => {
  const f = await fixture(provisioned);
  try {
    const owner = await f.client("ownerA"),
      viewer = await f.client("viewerA");
    const e = (await owner.saveEntry(entry())).entry;
    await viewer.sync();
    const forged = await viewer.prepare(entry({ title: "forged" }), {
      current: viewer.records.get(String(e.id)).row,
    });
    const row = {
      ...forged,
      ...owner.records.get(String(e.id)).row,
      revision: 2,
      attestation: forged.attestation,
      envelope: forged.envelope,
      summary: forged.summary,
    };
    delete row.expectedRevision;
    delete row.requestId;
    owner.transport.snapshot = async () => ({
      version: 1,
      household: "A",
      sequence: 999,
      unchanged: false,
      delta: false,
      baseSequence: -1,
      removed: [],
      records: [row],
    });
    await assert.rejects(owner.sync(), /UnauthorizedWriter/);
    assert.equal(owner.entry(e.id).title, e.title);
  } finally {
    f.close();
  }
});
test("replayed signed records, snapshot sequences and plaintext cache additions fail closed", async () => {
  const f = await fixture(provisioned);
  try {
    const c = await f.client("ownerA"),
      e = (await c.saveEntry(entry())).entry;
    const old = await f.store.snapshot(f.actors.ownerA, "A");
    await c.saveEntry({ ...e, title: "new" }, e.id);
    c.transport.snapshot = async () => ({ ...old, sequence: c.sequence + 1 });
    await assert.rejects(c.sync(), /RecordRollbackDetected/);
    c.transport.snapshot = async () => old;
    await assert.rejects(c.sync(), /RollbackDetected/);
    assert.throws(
      () =>
        validateSnapshot({
          ...old,
          records: [{ ...old.records[0], unexpected: { title: "private" } }],
        }),
      /InvalidRecord/,
    );
    c.lock();
    await c.unlock(new Uint8Array(provisioned.secrets.ownerA.prf));
    c.transport.snapshot = (h, s) => f.store.snapshot(f.actors.ownerA, h, s);
    await c.sync();
    assert.equal(c.entry(e.id).title, "new");
  } finally {
    f.close();
  }
});
test("permanent deletion is idempotent after a lost response and conflicting request reuse is rejected", async () => {
  const f = await fixture(provisioned);
  try {
    const c = await f.client("ownerA"),
      e = (await c.saveEntry({ ...entry(), status: "draft" })).entry;
    const remove = c.transport.remove;
    let first = true;
    c.transport.remove = async (p) => {
      const result = await remove(p);
      if (first) {
        first = false;
        throw new Error("ResponseLost");
      }
      return result;
    };
    await assert.rejects(c.transition(e.id, "discard"), /ResponseLost/);
    await c.transition(e.id, "discard");
    assert.equal(c.records.size, 0);
    const p = f.wire.find((w) => w.operation === "remove").proposal;
    await assert.rejects(
      f.store.remove(f.actors.ownerA, { ...p, revision: p.revision + 1 }),
      /IdempotencyConflict/,
    );
  } finally {
    f.close();
  }
});
test("photo metadata, marker offsets and deferred removal preserve referenced originals", async () => {
  const f = await fixture(provisioned);
  try {
    const c = await f.client("ownerA"),
      id = crypto.randomUUID();
    f.registry.photos[id] = { household: "A", accountId: "ownerA" };
    const doc = entry({
      content: `hello[[写真:${id}]]world`,
      contentFormat: { version: 1, runs: [{ start: 0, end: 5, bold: true }] },
      photos: [
        {
          id,
          fileName: "CANARY_PHOTO_NAME.jpg",
          takenAt: "2026-01-23T00:00:00Z",
          width: 200,
          height: 300,
        },
      ],
    });
    const result = await c.commit(doc);
    await c.deletePhoto(id, result.revision);
    assert.equal(c.entry(result.id).content, "helloworld");
    assert.deepEqual(c.entry(result.id).contentFormat, {
      version: 1,
      runs: [
        {
          start: 0,
          end: 5,
          bold: true,
          italic: false,
          underline: false,
          color: null,
        },
      ],
    });
    assert.equal(
      f.db.sqlite.prepare("SELECT photo_id FROM diary_e2ee_media_gc").get()
        .photo_id,
      id,
    );
    await assert.rejects(
      c.commit(doc, { current: c.records.get(result.id).row }),
      /PhotoRetired/,
    );
    assert.equal(JSON.stringify(f.wire).includes("CANARY_PHOTO_NAME"), false);
    const photo = crypto.randomUUID();
    f.registry.photos[photo] = { household: "A", accountId: "ownerA" };
    const r = await c.commit(entry({ photos: [{ id: photo }] }));
    const e = c.entry(r.id);
    const draft = (await c.saveEntry({ ...e, status: "draft" }, e.id)).entry;
    await assert.rejects(c.deletePhoto(photo, e.revision), /RevisionConflict/);
    await c.transition(draft.id, "discard");
    assert.equal(
      f.db.sqlite
        .prepare("SELECT * FROM diary_e2ee_media_gc WHERE photo_id=?")
        .get(photo),
      undefined,
    );
  } finally {
    f.close();
  }
});
test("migration preserves authors, revisions, edit drafts and independent trash without per-row full sync", async () => {
  const f = await fixture(provisioned);
  try {
    const c = await f.client("ownerA"),
      legacy = Array.from({ length: 51 }, (_, i) => ({
        id: 1000 + i,
        ...entry(),
        authorId: "editorA",
        revision: 7,
        status: i === 1 ? "draft" : "published",
        ...(i === 1 ? { draftOfEntryId: 1000, draftOfRevision: 7 } : {}),
      }));
    f.registry.migrationEnabled = true;
    f.registry.migrators = ["ownerA"];
    f.registry.legacyRecords = Object.fromEntries(
      legacy.map((e) => [
        e.id,
        {
          household: "A",
          state: e.status,
          author: e.authorId,
          revision: e.revision,
          retainedFor: [],
          sourceId: e.draftOfEntryId ? String(e.draftOfEntryId) : null,
          sourceRevision: e.draftOfRevision || null,
          photoIds: [],
        },
      ]),
    );
    await c.migrateLegacy(legacy);
    assert.equal(c.records.size, 51);
    assert.equal(c.entry(1000).revision, 7);
    assert.equal(c.entry(1001).draftOfEntryId, 1000);
    assert.ok(f.wire.filter((w) => w.operation === "snapshot").length <= 5);
  } finally {
    f.close();
  }
});
test("favorites remain isolated when the global owner switches households", async () => {
  const f = await fixture(provisioned);
  try {
    const a = await f.client("ownerA", "A"),
      b = await f.client("ownerA", "B");
    const x = (await a.saveEntry(entry())).entry,
      y = (await b.saveEntry(entry())).entry;
    await a.setFavorite(x.id, true);
    await b.setFavorite(y.id, true);
    await a.sync();
    assert.deepEqual(a.favoriteIds(), [String(x.id)]);
    assert.deepEqual(b.favoriteIds(), [String(y.id)]);
  } finally {
    f.close();
  }
});
test("existing central recovery key provisions a new credential without a diary recovery secret or old PRF", async () => {
  const recoveryPublicKey = await crypto.subtle.exportKey(
      "jwk",
      provisioned.securityRecovery.publicKey,
    ),
    expectedRecoveryFingerprint = await fingerprint(recoveryPublicKey);
  const parameters = {
    scopeKeys: provisioned.scopeKeys,
    authority: provisioned.authority.privateKey,
    directory: provisioned.packet,
    anchor: provisioned.anchor,
    recoveryPublicKey,
    expectedRecoveryFingerprint,
  };
  const kit = await createRecoveryEnvelope(parameters);
  assert.equal(Object.hasOwn(kit, "secret"), false);
  await assert.rejects(
    createRecoveryEnvelope({
      ...parameters,
      expectedRecoveryFingerprint: "untrusted",
    }),
    /UntrustedRecoveryKey/,
  );
  const recoveryParameters = {
    packet: kit,
    recoveryPrivateKey: provisioned.securityRecovery.privateKey,
    anchor: provisioned.anchor,
  };
  const recovered = await openRecoveryEnvelope(recoveryParameters);
  await assert.rejects(
    openRecoveryEnvelope({
      ...recoveryParameters,
      recoveryPrivateKey: provisioned.authority.privateKey,
    }),
  );
  await assert.rejects(
    openRecoveryEnvelope({ ...recoveryParameters, minimumGeneration: 2 }),
    /InvalidRecoveryKit/,
  );
  const prf = crypto.getRandomValues(new Uint8Array(32)),
    vault = await createVault(prf, "new-approved-credential");
  const member = {
    ...provisioned.directory.members[0],
    credentialId: "new-approved-credential",
    publicKey: vault.publicKey,
    signPublicKey: vault.signPublicKey,
    fingerprint: await fingerprint(vault.publicKey),
  };
  const directory = {
    ...recovered.directory,
    generation: 2,
    members: [...recovered.directory.members, member],
  };
  const updatedRecovery = await createRecoveryEnvelope({
    ...parameters,
    scopeKeys: recovered.scopeKeys,
    authority: recovered.authority,
    directory: await signed(directory, recovered.authority),
  });
  const reopened = await openRecoveryEnvelope({
    ...recoveryParameters,
    packet: updatedRecovery,
    minimumGeneration: 2,
  });
  assert.equal(reopened.directory.generation, 2);
  reopened.scopeKeys.clear();
  const packet = await signed(directory, recovered.authority),
    verified = await verifyDirectory(packet, provisioned.anchor, 2);
  const scope = "A:published",
    grant = await makeGrant(
      recovered.scopeKeys.get(scope),
      { household: "A", scope, epoch: 1 },
      member,
      2,
      recovered.authority,
    );
  const keys = await unlockVault(prf, member.credentialId, vault);
  const key = await unwrapGrant(grant, {
    directory: verified,
    anchor: provisioned.anchor,
    accountId: member.accountId,
    credentialId: member.credentialId,
    household: "A",
    scope,
    epoch: 1,
    privateKey: keys.rsa,
  });
  const ctx = {
    household: "A",
    scope,
    id: "123",
    revision: 1,
    epoch: 1,
    kind: "document",
  };
  assert.deepEqual(
    await open(
      key,
      await seal(provisioned.scopeKeys.get(scope), { recovered: true }, ctx),
      ctx,
    ),
    { recovered: true },
  );
  recovered.scopeKeys.clear();
});

test("paged snapshots restart on concurrent writes and never combine two revisions", async () => {
  const f = await fixture(provisioned);
  try {
    const c = await f.client("ownerA");
    for (let i = 0; i < 52; i++) await c.commit(entry({ title: `page ${i}` }));
    let calls = 0,
      changed = false;
    const snapshot = await readSnapshotPages(async (options) => {
      calls++;
      const page = await f.store.snapshotPage(f.actors.ownerA, "A", options);
      if (!changed) {
        changed = true;
        await c.saveEntry(entry({ title: "concurrent addition" }));
      }
      return page;
    }, "A");
    assert.equal(snapshot.records.length, 53);
    assert.ok(calls >= 3);
    const unchanged = await readSnapshotPages(
      (p) => f.store.snapshotPage(f.actors.ownerA, "A", p),
      "A",
      snapshot.sequence,
    );
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.records.length, 0);
  } finally {
    f.close();
  }
});

test("lost edit and trash responses replay the original proposal before refreshing revisions", async () => {
  const f = await fixture(provisioned);
  try {
    const c = await f.client("ownerA"),
      e = (await c.saveEntry(entry())).entry;
    const mutation = c.transport.mutation;
    let lose = true;
    c.transport.mutation = async (p, op) => {
      const result = await mutation(p, op);
      if (lose) {
        lose = false;
        throw new Error("ResponseLost");
      }
      return result;
    };
    const edited = { ...e, title: "edited after response loss" };
    await assert.rejects(c.saveEntry(edited, e.id), /ResponseLost/);
    const saved = (await c.saveEntry(edited, e.id)).entry;
    assert.equal(saved.revision, 2);
    assert.equal(saved.title, edited.title);
    lose = true;
    await assert.rejects(
      c.transition(e.id, "trash", saved.revision),
      /ResponseLost/,
    );
    await c.transition(e.id, "trash", saved.revision);
    assert.equal(c.entry(e.id).revision, 3);
    const attempts = f.wire.filter((w) => w.operation === "trash");
    assert.deepEqual(attempts[0].proposal, attempts[1].proposal);
  } finally {
    f.close();
  }
});

test("delta sync transfers only changed records and removes data after access narrows", async () => {
  const f = await fixture(provisioned);
  try {
    const owner = await f.client("ownerA"),
      editor = await f.client("editorA");
    const a = (await owner.saveEntry(entry())).entry,
      b = (await owner.saveEntry(entry({ title: "unchanged" }))).entry;
    await editor.sync();
    const since = editor.sequence;
    await owner.saveEntry({ ...a, title: "changed" }, a.id);
    const delta = await readSnapshotPages(
      (p) => f.store.snapshotPage(f.actors.editorA, "A", p),
      "A",
      since,
    );
    assert.equal(delta.delta, true);
    assert.equal(delta.records.length, 1);
    assert.equal(delta.records[0].id, String(a.id));
    await editor.sync();
    assert.equal(editor.entry(a.id).title, "changed");
    assert.equal(editor.entry(b.id).title, "unchanged");
    await owner.transition(a.id, "trash");
    await editor.sync();
    assert.equal(editor.records.has(String(a.id)), false);
    assert.equal(editor.entry(b.id).title, "unchanged");
  } finally {
    f.close();
  }
});

test("central recovery also recovers per-record keys after a trash retention narrows", async () => {
  const f = await fixture(provisioned);
  try {
    const owner = await f.client("ownerA"),
      user = await f.client("userA");
    const e = (await user.saveEntry(entry())).entry;
    await user.transition(e.id, "trash");
    await owner.sync();
    await owner.transition(e.id, "purge");
    assert.equal(owner.records.has(String(e.id)), false);
    const row = await f.store.get(String(e.id));
    assert.ok(row.keyBox.__recovery__);
    const { bindingOf } = await import("../../e2ee/record.mjs");
    const binding = bindingOf(row),
      key = await openRecipientKey(
        row.keyBox,
        { ...binding, kind: "record-key" },
        "__recovery__",
        provisioned.securityRecovery.privateKey,
      );
    const value = await open(key, row.envelope, {
      ...binding,
      kind: "document",
    });
    assert.equal(value.entry.content, e.content);
    await assert.rejects(
      openRecipientKey(
        row.keyBox,
        { ...binding, household: "B", kind: "record-key" },
        "__recovery__",
        provisioned.securityRecovery.privateKey,
      ),
    );
  } finally {
    f.close();
  }
});

test("encrypted database backup includes the central recovery envelope without a user secret", async () => {
  const f = await fixture(provisioned),
    restored = memoryDatabase();
  try {
    const c = await f.client("ownerA"),
      e = (await c.saveEntry(entry())).entry;
    const recoveryPublicKey = provisioned.directory.recoveryPublicKey;
    const recoveryEnvelope = await createRecoveryEnvelope({
      scopeKeys: provisioned.scopeKeys,
      authority: provisioned.authority.privateKey,
      directory: provisioned.packet,
      anchor: provisioned.anchor,
      recoveryPublicKey,
      expectedRecoveryFingerprint: provisioned.directory.recoveryFingerprint,
    });
    const packet = await backup(f.db, {
      directory: provisioned.packet,
      vaults: { ownerA: provisioned.profiles.ownerA.vault },
      grants: { ownerA: provisioned.profiles.ownerA.grants },
      recoveryEnvelope,
    });
    const result = await restoreEmpty(restored, packet, {
      anchor: provisioned.anchor,
      minimumGeneration: 1,
    });
    assert.deepEqual(result.recoveryEnvelope, recoveryEnvelope);
    const recovered = await openRecoveryEnvelope({
      packet: result.recoveryEnvelope,
      recoveryPrivateKey: provisioned.securityRecovery.privateKey,
      anchor: provisioned.anchor,
    });
    const store = createStore(restored, f.registry),
      row = await store.get(String(e.id)),
      { bindingOf } = await import("../../e2ee/record.mjs");
    assert.equal(
      (
        await open(recovered.scopeKeys.get(row.scope), row.envelope, {
          ...bindingOf(row),
          kind: "document",
        })
      ).entry.content,
      e.content,
    );
    await assert.rejects(
      backup(f.db, {
        directory: provisioned.packet,
        vaults: { bad: { plaintextKey: "never persist" } },
        grants: {},
      }),
      /InvalidKeyMetadata/,
    );
    recovered.scopeKeys.clear();
  } finally {
    f.close();
    restored.close();
  }
});

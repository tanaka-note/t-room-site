import {
  b64,
  encode,
  verifyDirectory,
  validateEnvelope,
  unb64,
} from "./crypto.mjs";
import { verifyRecord } from "./record.mjs";
const digest = async (value) =>
  b64(await crypto.subtle.digest("SHA-256", encode(value)));
const TABLES = [
  "diary_e2ee_records",
  "diary_e2ee_changes",
  "diary_e2ee_requests",
  "diary_e2ee_media_gc",
  "diary_e2ee_media",
  "diary_e2ee_uploads",
];
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
function validateKeyMetadata({ vaults, grants, recoveryEnvelope }) {
  for (const vault of Object.values(vaults || {})) {
    if (
      !exact(vault, ["publicKey", "signPublicKey", "privateEnvelope"]) ||
      [vault.publicKey, vault.signPublicKey].some(
        (key) =>
          !key ||
          ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some((name) =>
            Object.hasOwn(key, name),
          ),
      )
    )
      throw new Error("InvalidKeyMetadata");
    validateEnvelope(vault.privateEnvelope);
  }
  for (const list of Object.values(grants || {})) {
    if (!Array.isArray(list)) throw new Error("InvalidKeyMetadata");
    for (const grant of list) {
      if (
        !exact(grant, ["value", "signature"]) ||
        !exact(grant.value, [
          "version",
          "household",
          "scope",
          "epoch",
          "accountId",
          "credentialId",
          "fingerprint",
          "directoryGeneration",
          "wrapped",
        ]) ||
        unb64(grant.signature, 100).length !== 64 ||
        unb64(grant.value.wrapped, 512).length !== 384
      )
        throw new Error("InvalidKeyMetadata");
    }
  }
  if (recoveryEnvelope !== null) {
    if (
      !exact(recoveryEnvelope, [
        "version",
        "generation",
        "authority",
        "recoveryFingerprint",
        "envelope",
        "wrappedKey",
      ]) ||
      recoveryEnvelope.version !== 1 ||
      unb64(recoveryEnvelope.wrappedKey, 684).length !== 512
    )
      throw new Error("InvalidKeyMetadata");
    validateEnvelope(recoveryEnvelope.envelope);
  }
}
// Ciphertext and public/PRF-sealed key metadata only. Actor/session state is excluded.
export async function backup(
  db,
  { directory, vaults, grants, recoveryEnvelope = null },
) {
  validateKeyMetadata({ vaults, grants, recoveryEnvelope });
  const snapshots = await db.batch(
    TABLES.map((name) =>
      db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).bind(),
    ),
  );
  const tables = Object.fromEntries(
    TABLES.map((name, index) => [name, snapshots[index].results]),
  );
  const value = {
    format: "T-lain diary encrypted backup",
    version: 1,
    directory,
    vaults,
    grants,
    recoveryEnvelope,
    tables,
  };
  if (encode(value).length > 100_000_000)
    throw new Error("BackupBudgetExceeded");
  return { value, digest: await digest(value) };
}
export async function restoreEmpty(db, packet, { anchor, minimumGeneration }) {
  if (
    !packet?.value ||
    encode(packet.value).length > 100_000_000 ||
    (await digest(packet.value)) !== packet.digest
  )
    throw new Error("BackupIntegrityFailure");
  const value = packet.value;
  if (
    value.format !== "T-lain diary encrypted backup" ||
    value.version !== 1 ||
    Object.keys(value.tables || {})
      .sort()
      .join(",") !== [...TABLES].sort().join(",")
  )
    throw new Error("UnsupportedBackup");
  const directory = await verifyDirectory(
    value.directory,
    anchor,
    minimumGeneration,
  );
  validateKeyMetadata(value);
  const statements = [];
  for (const table of TABLES) {
    const present = await db
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .bind()
      .first();
    if (present.count) throw new Error("RestoreRequiresEmptyDatabase");
  }
  for (const row of value.tables.diary_e2ee_records) {
    await verifyRecord(
      {
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
      },
      directory,
    );
  }
  for (const table of TABLES) {
    const columns = (
      await db.prepare(`PRAGMA table_info(${table})`).bind().all()
    ).results.map((c) => c.name);
    for (const row of value.tables[table]) {
      if (Object.keys(row).sort().join(",") !== [...columns].sort().join(","))
        throw new Error("BackupSchemaMismatch");
      statements.push(
        db
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .bind(...columns.map((c) => row[c])),
      );
    }
  }
  // Record triggers generate change rows while restoring; replace them atomically
  // with the backed-up sequence (checksum detects accidental corruption; it is not a signature) before the database becomes visible.
  const split=value.tables.diary_e2ee_records.length;
  statements.splice(
    split,
    0,
    db.prepare("DELETE FROM diary_e2ee_changes").bind(),
  );
  await db.batch(statements);
  const integrity = await db.prepare("PRAGMA integrity_check").bind().first();
  if (integrity.integrity_check !== "ok")
    throw new Error("RestoreIntegrityFailure");
  return {
    directory,
    vaults: value.vaults,
    grants: value.grants,
    recoveryEnvelope: value.recoveryEnvelope,
    records: value.tables.diary_e2ee_records.length,
  };
}

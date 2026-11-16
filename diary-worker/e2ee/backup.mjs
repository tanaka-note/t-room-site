import {
  b64,
  encode,
  verifyDirectory,
  validateEnvelope,
  unb64,
  validatePublicKey,
  recoveryWrappedBytes,
  fingerprint,
  verifySigned,
} from "./crypto.mjs";
import { verifyRecord } from "./record.mjs";
import {validateSealedTrust} from './trust.mjs';
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
export async function validateKeyMetadata({ vaults, grants, recordGrants = {}, recoveryEnvelope }, directory, anchor = null) {
  for (const vault of Object.values(vaults || {})) {
    if (
      !exact(vault, ["publicKey", "signPublicKey", "privateEnvelope",...(Object.hasOwn(vault,'trust')?['trust']:[])]) ||
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
    if(vault.trust){validateSealedTrust(vault.trust);if(vault.trust.generation>directory.generation)throw new Error('InvalidKeyMetadata');}
    validatePublicKey(vault.publicKey, "recipient");
    validatePublicKey(vault.signPublicKey, "signing");
  }
  for (const [record, collections] of [[false, grants], [true, recordGrants]]) for (const list of Object.values(collections || {})) {
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
          ...(record ? ["id", "revision", "kind"] : []),
        ]) ||
        unb64(grant.signature, 100).length !== 64 ||
        unb64(grant.value.wrapped, 512).length !== 384
      )
        throw new Error("InvalidKeyMetadata");
      if (anchor) {
        const value = await verifySigned(grant, anchor);
        const member = directory.members.find(m => m.credentialId === value.credentialId && m.accountId === value.accountId);
        if (!member || value.version !== 1 || value.directoryGeneration !== directory.generation ||
          value.fingerprint !== member.fingerprint || !member.scopes.includes(value.scope) ||
          value.epoch !== directory.epochs[value.scope] || !value.scope.startsWith(value.household + ':') ||
          record && (value.kind !== 'record' || !Number.isSafeInteger(value.revision) || value.revision < 1))
          throw new Error('InvalidKeyMetadata');
      }
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
      unb64(recoveryEnvelope.wrappedKey, 684).length !== recoveryWrappedBytes(directory.recoveryPublicKey) ||
      recoveryEnvelope.generation !== directory.generation ||
      anchor && recoveryEnvelope.authority !== await fingerprint(anchor) ||
      recoveryEnvelope.recoveryFingerprint !== directory.recoveryFingerprint
    )
      throw new Error("InvalidKeyMetadata");
    validateEnvelope(recoveryEnvelope.envelope);
  }
}
// Ciphertext and public/PRF-sealed key metadata only. Actor/session state is excluded.
export async function backup(
  db,
  { directory, vaults, grants, recordGrants = {}, recoveryEnvelope = null },
) {
  await validateKeyMetadata({ vaults, grants, recordGrants, recoveryEnvelope }, directory.value);
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
    recordGrants,
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
  await validateKeyMetadata(value, directory, anchor);
  const statements = [];
  const control = await db.prepare('SELECT phase,generation,ever_encrypted FROM diary_e2ee_control WHERE id=1').first();
  for (const table of TABLES) {
    const present = await db
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .bind()
      .first();
    if (present.count) throw new Error("RestoreRequiresEmptyDatabase");
  }
  if (!control || control.ever_encrypted || control.generation !== 0)
    throw new Error('RestoreRequiresIsolatedDatabase');
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
  // The guard and all writes share one transaction. A concurrent activation or
  // write cannot turn an isolated restore into an overwrite of a live database.
  const empty = TABLES.map(table => `NOT EXISTS(SELECT 1 FROM ${table})`).join(' AND ');
  statements.push(db.prepare(`UPDATE diary_e2ee_control SET phase=CASE WHEN generation=? AND ever_encrypted=0 AND ${empty} THEN 'restoring' ELSE 'invalid-restore' END,generation=generation+1 WHERE id=1`).bind(control.generation));
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
    split + 1,
    0,
    db.prepare("DELETE FROM diary_e2ee_changes").bind(),
  );
  // Restored data remains read-only until the normal signed cutover drill.
  statements.push(db.prepare("UPDATE diary_e2ee_control SET phase='paused',ever_encrypted=1 WHERE id=1 AND phase='restoring'").bind());
  await db.batch(statements);
  const integrity = await db.prepare("PRAGMA integrity_check").bind().first();
  if (integrity.integrity_check !== "ok")
    throw new Error("RestoreIntegrityFailure");
  return {
    directory,
    vaults: value.vaults,
    grants: value.grants,
    recordGrants: value.recordGrants || {},
    recoveryEnvelope: value.recoveryEnvelope,
    records: value.tables.diary_e2ee_records.length,
  };
}

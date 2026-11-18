import { billingEncryptedDigest, verifyBillingState } from "../public/billing-crypto.mjs";

const opaqueId = /^[A-Za-z0-9_-]{43}$/;
const storedIv = /^[A-Za-z0-9_-]{16}$/;
const storedCiphertext = /^[A-Za-z0-9_-]{22,174784}$/;
const maxPage = 32;
const maxRecords = 10000;

export function validateBillingCiphertext(record, revision) {
  if (!record || typeof record.id !== "string" || !opaqueId.test(record.id)
    || record.revision !== revision || typeof record.iv !== "string" || !storedIv.test(record.iv)
    || typeof record.ciphertext !== "string" || !storedCiphertext.test(record.ciphertext)
    || Object.keys(record).length !== 4) throw new Error("Invalid billing candidate ciphertext");
}

function ledgerStatement(db, migration, scope) {
  return db.prepare(`SELECT generation, ledger_id, account_id, revision, digest, signature, record_count,recovery_wrapped_key
    FROM billing_encryption_candidate_ledgers WHERE generation = ? AND ledger_id = ?`)
    .bind(migration, scope.ledgerId);
}

export async function reserveBillingCandidate(db, migration, scope, accountId, { revision, recordCount, recoveryWrappedKey = null }) {
  if (!Number.isSafeInteger(recordCount) || recordCount < 0 || recordCount > maxRecords
    || !Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error("Invalid billing candidate header");
  }
  const [, read] = await db.batch([
    db.prepare(`INSERT INTO billing_encryption_candidate_ledgers
      (generation,ledger_id,account_id,revision,record_count,recovery_wrapped_key)
      VALUES (?,?,?,?,?,?) ON CONFLICT(generation,ledger_id) DO NOTHING`)
      .bind(migration, scope.ledgerId, accountId, revision, recordCount, recoveryWrappedKey),
    ledgerStatement(db, migration, scope)
  ]);
  const stored = read.results?.[0];
  if (!stored || stored.account_id !== accountId || stored.revision !== revision || stored.record_count !== recordCount
    || stored.recovery_wrapped_key !== recoveryWrappedKey) {
    throw new Error("Billing candidate header conflicts with the stored revision");
  }
}

export async function writeBillingCandidatePage(db, migration, scope, records) {
  if (!Array.isArray(records) || !records.length || records.length > maxPage) throw new Error("Invalid billing candidate page");
  const header = await ledgerStatement(db, migration, scope).first();
  if (!header) throw new Error("Billing candidate header is missing");
  for (const record of records) validateBillingCiphertext(record, header.revision);
  if (new Set(records.map(record => record.id)).size !== records.length) throw new Error("Duplicate billing candidate ciphertext");
  // SQLite aborts the entire statement if a retry changes a stored envelope or
  // would exceed the signed count, including when concurrent pages arrive.
  // D1 limits one prepared statement to 100 bindings. Pages are split into
  // smaller statements inside a single rollback-capable batch.
  const statements = [];
  for (let offset = 0; offset < records.length; offset += 16) {
    const subset = records.slice(offset, offset + 16);
    const args = subset.flatMap(record => [migration, scope.ledgerId, record.id, record.revision, record.iv, record.ciphertext]);
    const values = subset.map(() => "(?,?,?,?,?,?)").join(",");
    statements.push(db.prepare(`INSERT INTO billing_encryption_candidate_records
      (generation,ledger_id,id,revision,iv,ciphertext) VALUES ${values}
      ON CONFLICT(generation,ledger_id,id) DO UPDATE SET iv=excluded.iv, ciphertext=excluded.ciphertext`).bind(...args));
  }
  await db.batch(statements);
}

export async function readBillingCandidate(db, migration, scope) {
  const [headerResult, recordResult] = await db.batch([
    ledgerStatement(db, migration, scope),
    db.prepare(`SELECT id, revision, iv, ciphertext FROM billing_encryption_candidate_records
      WHERE generation = ? AND ledger_id = ? ORDER BY id`).bind(migration, scope.ledgerId)
  ]);
  const header = headerResult.results?.[0];
  if (!header) throw new Error("Billing candidate header is missing");
  return { header, records: recordResult.results };
}

// The writer key comes from authenticated migration state established by the
// primary administrator. Requests may not supply their own verification key.
export async function attestBillingCandidate(db, migration, scope, { revision, digest, signature }, writerPublicKey) {
  const { header, records } = await readBillingCandidate(db, migration, scope);
  if (revision !== header.revision || records.length !== header.record_count || await billingEncryptedDigest(records) !== digest
    || !await verifyBillingState(writerPublicKey, scope, revision, digest, signature)) {
    throw new Error("Billing candidate attestation verification failed");
  }
  const [, result] = await db.batch([
    db.prepare(`UPDATE billing_encryption_candidate_ledgers SET digest = ?, signature = ?
      WHERE generation = ? AND ledger_id = ? AND revision = ? AND staged_count = record_count AND digest IS NULL`)
      .bind(digest, signature, migration, scope.ledgerId, revision),
    ledgerStatement(db, migration, scope)
  ]);
  const saved = result.results?.[0];
  if (!saved || saved.digest !== digest || saved.signature !== signature) throw new Error("Billing candidate attestation conflict");
}

export async function loadVerifiedBillingCandidate(db, migration, scope, writerPublicKey) {
  const { header, records } = await readBillingCandidate(db, migration, scope);
  if (!header.digest || records.length !== header.record_count || await billingEncryptedDigest(records) !== header.digest
    || !await verifyBillingState(writerPublicKey, scope, header.revision, header.digest, header.signature)) {
    throw new Error("Billing candidate staging verification failed");
  }
  return { revision: header.revision, digest: header.digest, signature: header.signature, records };
}

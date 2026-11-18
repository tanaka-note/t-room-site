import { billingEncryptedDigest, verifyBillingState } from '../../billing-worker/public/billing-crypto.mjs';
import { compress, digest, publishGeneration, verifiedGeneration, withBackupLock } from './integrity.js';

const format = 'troom-billing-encrypted-checkpoint';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const pathFor = generation => {
  if (typeof generation !== 'string' || !uuid.test(generation)) throw new Error('BillingCheckpointInvalid');
  return `d1/billing/encrypted/checkpoints/${generation}.json.gz`;
};
const payloadHash = payload => digest(new TextEncoder().encode(JSON.stringify(payload)));

async function verifyCheckpoint(payload,generation) {
  if (payload?.format !== format || payload.version !== 1 || payload.generation !== generation
    || !Array.isArray(payload.ledgers) || !Array.isArray(payload.grants) || !payload.writer) throw new Error('BillingCheckpointInvalid');
  const ledgers = new Map();
  for (const ledger of payload.ledgers) {
    if (!uuid.test(ledger.ledgerId) || ledgers.has(ledger.ledgerId) || !Array.isArray(ledger.records)
      || await billingEncryptedDigest(ledger.records) !== ledger.digest
      || !await verifyBillingState(payload.writer,{ ledgerId:ledger.ledgerId,generation:1 },1,ledger.digest,ledger.signature)) {
      throw new Error('BillingCheckpointInvalid');
    }
    ledgers.set(ledger.ledgerId,ledger);
  }
  if (payload.grants.some(grant => !ledgers.has(grant.ledger_id))
    || payload.ledgers.filter(ledger => ledger.accountId === null).length !== 1) throw new Error('BillingCheckpointInvalid');
}

async function capture(db,generation) {
  const [state,accounts,headers,records,grants] = await db.batch([
    db.prepare('SELECT writer_public_key,activated_at FROM billing_encryption_migration WHERE id=1 AND generation=?').bind(generation),
    db.prepare('SELECT id FROM billing_accounts ORDER BY id'),
    db.prepare(`SELECT ledger_id AS ledgerId,account_id AS accountId,recovery_wrapped_key AS recoveryWrappedKey,
      revision,digest,signature,record_count FROM billing_encryption_candidate_ledgers WHERE generation=? ORDER BY ledger_id`).bind(generation),
    db.prepare(`SELECT ledger_id,id,revision,iv,ciphertext FROM billing_encryption_candidate_records
      WHERE generation=? ORDER BY ledger_id,id`).bind(generation),
    db.prepare(`SELECT ledger_id,identity_id,credential_id,service_link_id,key_source,wrapped_key
      FROM billing_encryption_grants WHERE generation=? ORDER BY ledger_id,credential_id,service_link_id,key_source`).bind(generation)
  ]);
  const control = state.results[0];
  if (!control?.writer_public_key || control.activated_at) throw new Error('BillingCheckpointRequiresStaging');
  const byLedger = new Map();
  for (const { ledger_id, ...row } of records.results) {
    if (!byLedger.has(ledger_id)) byLedger.set(ledger_id,[]);
    byLedger.get(ledger_id).push(row);
  }
  const ledgers = headers.results.map(({ record_count, ...header }) => {
    const items = byLedger.get(header.ledgerId) ?? [];
    if (header.revision !== 1 || !header.recoveryWrappedKey || items.length !== record_count) throw new Error('BillingCheckpointIncomplete');
    return { ...header,records:items };
  });
  if (ledgers.length !== accounts.results.length+1 || accounts.results.some(account => !ledgers.some(ledger => ledger.accountId === account.id))) {
    throw new Error('BillingCheckpointIncomplete');
  }
  return { format,version:1,generation,writer:JSON.parse(control.writer_public_key),ledgers,grants:grants.results };
}

export async function billingCheckpoint(env,generation,create = false) {
  const key = pathFor(generation);
  const validate = payload => verifyCheckpoint(payload,generation);
  let saved = await verifiedGeneration(env.BACKUP,key,validate);
  if (!saved && create) saved = await withBackupLock(async () => {
    const payload = await capture(env.BILLING_DB,generation);
    return publishGeneration(env.BACKUP,key,await compress(payload),{ service:'billing',format },validate);
  });
  if (!saved) throw new Error('BillingCheckpointMissing');
  return { payload:saved.payload, archiveSha256:saved.sha256, payloadSha256:await payloadHash(saved.payload) };
}

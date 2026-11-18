import { assertArchiveSchema } from "../../backup-worker/src/schema-guard.js";
import { BILLING_ENCRYPTED_MIGRATION } from "../../backup-worker/src/billing-encrypted.js";

const eventType = "encrypted_legacy_source_cleaned";
const tables = ["billing_entries", "billing_settlements", "billing_opening_balances"];
const fences = [
  "billing_freeze_entries_delete", "billing_freeze_settlements_delete",
  "billing_freeze_balances_delete", "billing_freeze_audit_update"
];
const active = `EXISTS (SELECT 1 FROM billing_encryption_migration
  WHERE id=1 AND generation=? AND activated_at IS NOT NULL AND verified_checkpoint=?)`;
const privateAudit = "(entry_id IS NOT NULL OR details_json <> '{}')";

export async function billingLegacyPlaintextStatus(db) {
  return db.prepare(`SELECT (SELECT COUNT(*) FROM billing_entries) AS entries,
    (SELECT COUNT(*) FROM billing_settlements) AS settlements,
    (SELECT COUNT(*) FROM billing_opening_balances) AS openingBalances,
    (SELECT COUNT(*) FROM billing_audit_logs WHERE ${privateAudit}) AS auditDetails,
    (SELECT MAX(occurred_at) FROM billing_audit_logs WHERE event_type=?) AS cleanedAt`).bind(eventType).first();
}

export async function clearVerifiedBillingPlaintext(db, { generation, verified_checkpoint: checkpoint }) {
  const schema = (await db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name`).all()).results;
  await assertArchiveSchema("billing", BILLING_ENCRYPTED_MIGRATION, schema);
  const triggers = fences.map(name => schema.find(item => item.type === "trigger" && item.name === name));
  const statements = [
    // Recheck the fences and checkpoint inside the write transaction. SQLite
    // aborts the batch on malformed JSON when any precondition changed.
    db.prepare(`SELECT CASE WHEN ${active}
      AND (SELECT COUNT(*) FROM sqlite_schema WHERE type='trigger' AND sql IN (?,?,?,?))=4
      THEN 1 ELSE json('billing cleanup state changed') END`).bind(generation, checkpoint, ...triggers.map(row => row.sql)),
    ...fences.map(name => db.prepare(`DROP TRIGGER ${name}`)),
    ...tables.map(name => db.prepare(`DELETE FROM ${name} WHERE ${active}`).bind(generation, checkpoint)),
    db.prepare(`UPDATE billing_audit_logs SET entry_id=NULL,details_json='{}' WHERE ${privateAudit} AND ${active}`)
      .bind(generation, checkpoint),
    ...triggers.map(({ sql }) => db.prepare(sql)),
    db.prepare(`INSERT INTO billing_audit_logs (event_type,actor_account_id,target_account_id)
      SELECT ?, 'owner', 'owner' WHERE ${active} AND NOT EXISTS
      (SELECT 1 FROM billing_audit_logs WHERE event_type=?)`).bind(eventType, generation, checkpoint, eventType)
  ];
  await db.batch(statements);
  return billingLegacyPlaintextStatus(db);
}

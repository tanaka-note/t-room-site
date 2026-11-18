const sources = {
  entries: {
    table: "billing_entries",
    columns: "id,account_id,document_type,entry_date,category,amount_yen,description,note,created_by,created_at,updated_at,deleted_at"
  },
  settlements: {
    table: "billing_settlements",
    columns: "id,account_id,settlement_date,direction,method,amount_yen,note,created_by,legacy_entry_id,created_at,updated_at,deleted_at"
  },
  openingBalances: {
    table: "billing_opening_balances",
    columns: "account_id,effective_date,balance_yen,updated_by,updated_at"
  },
  auditLogs: {
    table: "billing_audit_logs",
    columns: "id,event_type,actor_account_id,target_account_id,entry_id,attempted_login_id,details_json,occurred_at"
  }
};
const maxPage = 50;
const readMigration = db => db.prepare("SELECT generation,started_at,audit_through_id,writer_public_key,activated_at,verified_checkpoint FROM billing_encryption_migration WHERE id=1");
const isGeneration = generation => typeof generation === "string"
  && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(generation);

// The caller establishes recovery-key possession and authorization before
// invoking this transition. A retry must retain its original generation.
export function billingMigrationState(db) {
  return readMigration(db).first();
}

export async function freezeBillingMigrationSource(db, generation, writerPublicKey = null) {
  if (!isGeneration(generation)) throw new Error("Invalid billing migration generation");
  const [write, read] = await db.batch([
    db.prepare(`INSERT INTO billing_encryption_migration (id,generation,audit_through_id,writer_public_key)
      SELECT 1,?,COALESCE(MAX(id),0),? FROM billing_audit_logs WHERE TRUE
      ON CONFLICT(id) DO NOTHING`).bind(generation, writerPublicKey ? JSON.stringify(writerPublicKey) : null),
    readMigration(db)
  ]);
  const state = read.results?.[0];
  if (write.success === false || !state || state.generation !== generation) throw new Error("Billing migration generation conflict");
  return state;
}

export async function readBillingMigrationPage(db, { generation, collection, accountId, after = 0 }) {
  const source = Object.hasOwn(sources, collection) ? sources[collection] : null;
  if (!isGeneration(generation) || !source || !Number.isSafeInteger(after) || after < 0) throw new Error("Invalid billing migration page");
  const isAudit = collection === "auditLogs";
  const isOpening = collection === "openingBalances";
  if (!isAudit && (typeof accountId !== "string" || !/^[a-z0-9_-]{1,100}$/.test(accountId))) {
    throw new Error("Invalid billing migration account");
  }
  if (isOpening && after !== 0) throw new Error("Invalid billing migration opening balance cursor");
  const filter = isAudit
    ? "source.id <= migration.audit_through_id AND source.id > ? AND (source.entry_id IS NOT NULL OR source.details_json <> '{}')"
    : isOpening ? "source.account_id = ?" : "source.account_id = ? AND source.id > ?";
  const columns = source.columns.split(",").map(name => `source.${name}`).join(",");
  const query = db.prepare(`SELECT ${columns}
    FROM ${source.table} AS source CROSS JOIN billing_encryption_migration AS migration
    WHERE migration.id = 1 AND migration.generation = ? AND ${filter}
    ORDER BY source.${isOpening ? "account_id" : "id"} LIMIT ${maxPage + 1}`)
    .bind(generation, ...(isAudit ? [after] : isOpening ? [accountId] : [accountId, after]));
  const [stateResult, dataResult] = await db.batch([readMigration(db), query]);
  if (stateResult.results?.[0]?.generation !== generation || dataResult.success === false) {
    throw new Error("Billing migration generation conflict");
  }
  const rows = dataResult.results.slice(0, maxPage);
  return { rows, next: dataResult.results.length > maxPage ? rows.at(-1).id : null };
}

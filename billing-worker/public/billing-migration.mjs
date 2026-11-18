import {
  billingEncryptedDigest, billingRecordId, openBillingRecord, sealBillingRecord,
  signBillingState, verifyBillingState
} from "./billing-crypto.mjs";
import { monthBounds, summarizeLedger, summarizeSettlements } from "./billing-finance.mjs";

const sourceFields = Object.freeze({
  entry: "id,account_id,document_type,entry_date,category,amount_yen,description,note,created_by,created_at,updated_at,deleted_at",
  settlement: "id,account_id,settlement_date,direction,method,amount_yen,note,created_by,legacy_entry_id,created_at,updated_at,deleted_at",
  "opening-balance": "account_id,effective_date,balance_yen,updated_by,updated_at",
  audit: "id,event_type,actor_account_id,target_account_id,entry_id,attempted_login_id,details_json,occurred_at"
});

function projectedSource(kind, row) {
  const fields = sourceFields[kind].split(",");
  if (!row || Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field))) {
    throw new Error("Unexpected billing migration source columns");
  }
  for (const value of Object.values(row)) {
    if (value !== null && typeof value !== "string" && !Number.isSafeInteger(value)) {
      throw new Error("Unexpected billing migration source value");
    }
  }
  if (kind === "opening-balance" ? typeof row.account_id !== "string" : !Number.isSafeInteger(row.id) || row.id < 1) {
    throw new Error("Invalid billing migration source ID");
  }
  return {
    kind, sourceId: String(kind === "opening-balance" ? row.account_id : row.id),
    data: Object.fromEntries(fields.map(field => [field, row[field]]))
  };
}

export function billingMigrationSources(snapshot) {
  if (!snapshot || !["entries", "settlements", "openingBalances", "auditLogs"].every(key => Array.isArray(snapshot[key]))) {
    throw new Error("Invalid billing migration snapshot");
  }
  return {
    ledger: [
      ...snapshot.entries.map(row => projectedSource("entry", row)),
      ...snapshot.settlements.map(row => projectedSource("settlement", row)),
      ...snapshot.openingBalances.map(row => projectedSource("opening-balance", row))
    ],
    audit: snapshot.auditLogs.map(row => projectedSource("audit", row))
  };
}

function equalSource(left, right) {
  return left.kind === right.kind && left.sourceId === right.sourceId && equalJson(left.data, right.data);
}

function equalJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equalJson(left[key], right[key]));
}

export function billingMonthlySources(account, sources) {
  const entries = sources.filter(source => source.kind === "entry").map(source => source.data);
  const settlements = sources.filter(source => source.kind === "settlement").map(source => source.data);
  if (sources.some(source => !["entry", "settlement", "opening-balance"].includes(source.kind)
    || source.data.account_id !== account.id)) throw new Error("Billing migration source account mismatch");
  const months = new Set([
    ...entries.filter(row => row.deleted_at === null && row.category !== "income").map(row => row.entry_date.slice(0, 7)),
    ...settlements.filter(row => row.deleted_at === null).map(row => row.settlement_date.slice(0, 7))
  ]);
  const monthly = [...months].sort().map(month => ({
    kind: "month", sourceId: month, data: summarizeLedger(account, month, entries, settlements)
  }));
  return [...monthly, {
    kind: "index", sourceId: "months", data: {
      account: { id: account.id, displayName: account.displayName },
      months: monthly.map(({ data }) => ({ month: data.month, closingBalanceYen: data.closingBalanceYen }))
    }
  }];
}

// The selected month and nearby months can be requested by an opaque record ID
// without sending a transaction date or account balance to the server.
export async function readBillingEncryptedMonth({ scope, keys, revision, loadRecord, month, signal }) {
  monthBounds(month);
  async function read(kind, sourceId) {
    const id = await billingRecordId(keys, kind, sourceId);
    signal?.throwIfAborted();
    const record = await loadRecord(id, signal);
    if (record?.id !== id || record.revision !== revision) throw new Error("Billing month revision mismatch");
    const value = await openBillingRecord(keys, scope, record);
    signal?.throwIfAborted();
    return value.data;
  }
  const index = await read("index", "months");
  if (index.months.some(item => item.month === month)) return read("month", month);
  const opening = index.months.findLast(item => item.month < month)?.closingBalanceYen ?? 0;
  return {
    account: index.account, month, openingBalanceYen: opening, closingBalanceYen: opening,
    entries: [], settlements: [], settlementTotals: summarizeSettlements([])
  };
}

async function mapPages(items, fn, signal) {
  const result = [];
  for (let offset = 0; offset < items.length; offset += 32) {
    signal?.throwIfAborted();
    result.push(...await Promise.all(items.slice(offset, offset + 32).map(fn)));
    signal?.throwIfAborted();
  }
  return result;
}

export async function sealBillingMigrationLedger({ scope, keys, revision, sources, writer, stagedRecords = [], signal }) {
  const expected = new Map();
  const ids = await mapPages(sources, source => billingRecordId(keys, source.kind, source.sourceId), signal);
  for (let index = 0; index < sources.length; index++) expected.set(ids[index], sources[index]);
  if (expected.size !== sources.length) throw new Error("Duplicate billing migration source");
  const verified = await mapPages(stagedRecords, async record => {
    const source = expected.get(record.id);
    if (!source || record.revision !== revision || !equalSource(source, await openBillingRecord(keys, scope, record))) {
      throw new Error("Billing migration source comparison failed");
    }
    return record;
  }, signal);
  if (new Set(verified.map(record => record.id)).size !== verified.length) throw new Error("Duplicate billing ciphertext");
  for (const record of verified) expected.delete(record.id);
  const missing = await mapPages([...expected.values()], source => sealBillingRecord(keys, scope, revision, source), signal);
  const records = [...verified, ...missing];
  const digest = await billingEncryptedDigest(records);
  const signature = await signBillingState(writer, scope, revision, digest);
  signal?.throwIfAborted();
  return { revision, digest, signature, records };
}

export async function verifyBillingMigrationLedger({ scope, keys, state, sources, writerPublicKey, signal }) {
  if (!Array.isArray(state?.records) || state.records.length !== sources.length
    || state.digest !== await billingEncryptedDigest(state.records)
    || !await verifyBillingState(writerPublicKey, scope, state.revision, state.digest, state.signature)) {
    throw new Error("Billing migration state verification failed");
  }
  const ids = await mapPages(sources, source => billingRecordId(keys, source.kind, source.sourceId), signal);
  const expected = new Map(sources.map((source, index) => [ids[index], source]));
  if (expected.size !== sources.length) throw new Error("Duplicate billing migration source");
  const verified = await mapPages(state.records, async record => {
    const source = expected.get(record.id);
    if (!source || record.revision !== state.revision || !equalSource(source, await openBillingRecord(keys, scope, record))) {
      throw new Error("Billing migration source comparison failed");
    }
    return record.id;
  }, signal);
  return verified.length;
}

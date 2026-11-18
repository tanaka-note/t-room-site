export function monthBounds(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Invalid month");
  const [year, monthNumber] = month.split("-").map(Number);
  if (monthNumber < 1 || monthNumber > 12) throw new Error("Invalid month");
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  return {
    start: `${String(year).padStart(4, "0")}-${String(monthNumber).padStart(2, "0")}-01`,
    next: `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`
  };
}

export function signedDocumentAmount(category, amount, otherDirection = "plus") {
  const value = Number(amount);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Amount must be a positive integer");
  if (category === "purchase") return value;
  if (["discount", "income", "offset"].includes(category)) return -value;
  if (category === "other") return otherDirection === "minus" ? -value : value;
  throw new Error("Invalid category");
}

export function balanceEffect(documentType, amountYen) {
  if (!Number.isSafeInteger(amountYen)) throw new Error("Invalid amount");
  if (documentType === "invoice") return amountYen;
  if (documentType === "payment_notice") return -amountYen;
  throw new Error("Invalid document type");
}

export function settlementEffect(direction, method, amountYen) {
  const amount = Number(amountYen);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Invalid amount");
  if (!["incoming", "outgoing"].includes(direction)) throw new Error("Invalid direction");
  if (method === "offset") return 0;
  return direction === "incoming" ? -amount : amount;
}

export function summarizeSettlements(settlements) {
  return settlements.reduce((totals, settlement) => {
    if (settlement.method === "offset") totals.offsetYen += settlement.amountYen;
    else if (settlement.direction === "incoming") totals.incomingYen += settlement.amountYen;
    else totals.outgoingYen += settlement.amountYen;
    return totals;
  }, { incomingYen: 0, outgoingYen: 0, offsetYen: 0 });
}

export function normalizeAccountId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9-]{1,50}$/.test(id) ? id : "";
}

function normalizeDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? "" : value;
}

function positiveYen(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= 999999999999 ? number : null;
}

function normalizeText(value, maxLength) {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/\r\n/g, "\n");
  return text.length > maxLength ? "" : text;
}

export function entryInput(body) {
  const accountId = normalizeAccountId(body?.accountId);
  const documentType = body?.documentType;
  const entryDate = normalizeDate(body?.entryDate);
  const categories = documentType === "invoice" ? ["purchase", "discount", "offset", "other"] : ["purchase", "offset", "other"];
  const category = body?.category;
  const amount = positiveYen(body?.amountYen);
  const description = normalizeText(body?.description, 100);
  if (!accountId || !["invoice", "payment_notice"].includes(documentType) || !entryDate
    || !categories.includes(category) || amount === null || !description) return null;
  return {
    accountId, documentType, entryDate, category,
    amountYen: signedDocumentAmount(category, amount, body.otherDirection === "minus" ? "minus" : "plus"),
    description, note: normalizeText(body.note, 500)
  };
}

export function settlementInput(body) {
  const accountId = normalizeAccountId(body?.accountId);
  const settlementDate = normalizeDate(body?.settlementDate);
  const direction = body?.direction;
  const method = body?.method;
  const amountYen = positiveYen(body?.amountYen);
  if (!accountId || !settlementDate || !["incoming", "outgoing"].includes(direction)
    || !["bank_transfer", "cash", "offset", "other"].includes(method) || amountYen === null) return null;
  return { accountId, settlementDate, direction, method, amountYen, note: normalizeText(body.note, 500) };
}

export function serializeEntry(row) {
  return {
    id: Number(row.id),
    documentType: row.document_type,
    entryDate: row.entry_date,
    category: row.category,
    amountYen: Number(row.amount_yen),
    description: row.description,
    note: row.note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function serializeSettlement(row) {
  return {
    id: Number(row.id),
    settlementDate: row.settlement_date,
    direction: row.direction,
    method: row.method,
    amountYen: Number(row.amount_yen),
    note: row.note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// This mirrors the current D1 summary. Baseline rows are retained for recovery,
// and old income entries are counted through their corresponding settlements.
export function summarizeLedger(account, month, entryRows, settlementRows) {
  const { start, next } = monthBounds(month);
  const entries = [];
  const settlements = [];
  let opening = 0n;
  let closing = 0n;
  function count(date, amount) {
    if (date < start) opening += BigInt(amount);
    closing += BigInt(amount);
  }
  for (const row of entryRows) {
    if (row.account_id !== account.id || row.deleted_at !== null || row.category === "income" || row.entry_date >= next) continue;
    count(row.entry_date, balanceEffect(row.document_type, row.amount_yen));
    if (row.entry_date >= start) entries.push(serializeEntry(row));
  }
  for (const row of settlementRows) {
    if (row.account_id !== account.id || row.deleted_at !== null || row.settlement_date >= next) continue;
    count(row.settlement_date, settlementEffect(row.direction, row.method, row.amount_yen));
    if (row.settlement_date >= start) settlements.push(serializeSettlement(row));
  }
  entries.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.id - b.id);
  settlements.sort((a, b) => a.settlementDate.localeCompare(b.settlementDate) || a.id - b.id);
  const openingBalanceYen = Number(opening), closingBalanceYen = Number(closing);
  if (!Number.isSafeInteger(openingBalanceYen) || !Number.isSafeInteger(closingBalanceYen)) throw new Error("Billing balance exceeds safe integer range");
  const settlementTotals = summarizeSettlements(settlements);
  if (!Object.values(settlementTotals).every(Number.isSafeInteger)) throw new Error("Billing settlement total exceeds safe integer range");
  return { account: { id: account.id, displayName: account.displayName }, month, openingBalanceYen, closingBalanceYen, entries, settlements, settlementTotals };
}

export function formatMonthJp(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${year}年${monthNumber}月`;
}

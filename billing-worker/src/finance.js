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

export function formatMonthJp(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${year}年${monthNumber}月`;
}

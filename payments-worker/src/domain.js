export class HttpError extends Error {
  constructor(status, message, code = '') { super(message); this.status = status; this.code = code; }
}
export function text(value, max, label, optional = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (!optional && !value.trim())) throw new HttpError(400, `${label}を確認してください。`);
  return value.trim();
}
export function month(value) {
  if (typeof value !== 'string' || !/^(?:19|[2-9]\d)\d{2}-(?:0[1-9]|1[0-2])$/.test(value)) throw new HttpError(400, '対象開始月を確認してください。');
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1;
}
export function monthText(index) { return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`; }
export function paymentInput(body) {
  const paidOn = text(body.paidOn, 10, '支払日');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`)) || new Date(`${paidOn}T00:00:00Z`).toISOString().slice(0, 10) !== paidOn) throw new HttpError(400, '支払日を確認してください。');
  month(paidOn.slice(0, 7));
  const start = month(body.startMonth);
  if (!Number.isSafeInteger(body.amount) || body.amount <= 0 || body.amount > 999999999999) throw new HttpError(400, '支払総額は1円から999,999,999,999円の整数で入力してください。');
  if (!Number.isSafeInteger(body.months) || body.months < 1 || body.months > 1200 || start + body.months > 120000) throw new HttpError(400, '対象月数は1から1200の整数で入力してください。');
  return { paidOn, payee: text(body.payee, 120, '支払先'), description: text(body.description ?? '', 240, '摘要', true), amount: body.amount, startMonth: body.startMonth, months: body.months, notes: text(body.notes ?? '', 2000, '備考', true) };
}
export function paymentView(row, currentMonth) {
  const start = month(row.start_month), end = start + row.months - 1, current = month(currentMonth);
  const completed = Number(row.completed_count || 0), past = Math.max(0, Math.min(row.months, current - start));
  const currentAmount = current >= start && current <= end ? allocation(row.amount, row.months, current - start) : null;
  return { ...row, end_month: monthText(end), monthly_amount: allocation(row.amount, row.months, 0),
    remaining_months: Math.max(0, end - Math.max(start, current) + 1),
    remaining_count: row.months - completed, completed_count: completed,
    past_pending_count: past - Number(row.past_completed_count || 0),
    past_pending_amount: allocationPrefix(row.amount, row.months, past) - Number(row.past_completed_amount || 0),
    current_amount: currentAmount, current_completed: Boolean(row.current_completed),
    period_status: current < start ? 'upcoming' : current > end ? 'ended' : 'active',
    status: completed === row.months ? 'completed' : 'pending' };
}
// BigInt division/remainder keep every allocation exact, including amounts < months.
export function allocation(amount, months, offset) {
  const total = BigInt(amount), count = BigInt(months);
  return Number(total / count + (BigInt(offset) < total % count ? 1n : 0n));
}
export function allocationPrefix(amount, months, count) {
  const total = BigInt(amount), n = BigInt(months), k = BigInt(count), remainder = total % n;
  return Number(total / n * k + (k < remainder ? k : remainder));
}
export function monthlyView(row, marks, currentMonth) {
  const byMonth = new Map(marks.map(m => [m.target_month, m]));
  const start = month(row.start_month);
  return Array.from({ length: row.months }, (_, offset) => {
    const targetMonth = monthText(start + offset), mark = byMonth.get(targetMonth);
    return { target_month: targetMonth, amount: allocation(row.amount, row.months, offset), completed_at: mark?.completed_at || null,
      can_complete: targetMonth <= currentMonth };
  });
}
export function dashboard(entries) {
  const current = entries.filter(e => e.current_amount !== null), pending = current.filter(e => !e.current_completed);
  return { current_pending_count: pending.length, current_pending_amount: pending.reduce((n,e) => n + BigInt(e.current_amount), 0n).toString(),
    current_completed_count: current.length - pending.length, current_count: current.length,
    past_pending_count: entries.reduce((n,e) => n + e.past_pending_count, 0),
    past_pending_amount: entries.reduce((n,e) => n + BigInt(e.past_pending_amount), 0n).toString(),
    completed_count: entries.reduce((n,e) => n + e.completed_count, 0), total_count: entries.reduce((n,e) => n + e.months, 0) };
}
export function currentJstMonth(now = new Date()) { return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 7); }
export function uuid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new HttpError(400, '操作IDを確認してください。');
  return value;
}

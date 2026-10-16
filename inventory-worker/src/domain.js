export class HttpError extends Error {
  constructor(status, message, code = 'request_failed') { super(message); this.name = 'HttpError'; this.status = status; this.code = code; }
}
export const MAX_QUANTITY = 1000000000;
export function text(value, max, label) {
  if (typeof value !== 'string') throw new HttpError(400, `${label}を入力してください。`);
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max || /[\u0000-\u001f\u007f]/.test(cleaned)) throw new HttpError(400, `${label}の長さや文字を確認してください。`);
  return cleaned;
}
export function quantity(value, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > MAX_QUANTITY) throw new HttpError(400, '数量は範囲内の整数で入力してください。');
  return value;
}
export function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(400, '操作の識別情報を確認してください。');
  return value.toLowerCase();
}
export function occurredAt(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) throw new HttpError(400, '日時を確認してください。');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < Date.parse('2000-01-01T00:00:00Z') || milliseconds > now + 60000) throw new HttpError(400, '過去または現在の日時を入力してください。');
  // Date.parse normalizes impossible dates; compare calendar fields explicitly.
  const day = value.slice(0, 10), parsedDay = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day) throw new HttpError(400, '存在する日付を入力してください。');
  return new Date(milliseconds).toISOString();
}
export function yearBounds(year) {
  const number = Number(year);
  if (!Number.isInteger(number) || number < 2000 || number > 2100) throw new HttpError(400, '年を確認してください。');
  return { year: number, start: new Date(Date.UTC(number, 0, 1) - 9 * 3600000).toISOString(), end: new Date(Date.UTC(number + 1, 0, 1) - 9 * 3600000).toISOString() };
}
export function jstYear(now = new Date()) { return Number(new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 4)); }

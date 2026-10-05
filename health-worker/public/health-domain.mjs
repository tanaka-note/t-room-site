export const SYMPTOMS = Object.freeze(['腹痛・生理痛', '頭痛', '腰痛', 'だるさ・疲れ', '眠気', '気分の落ち込み']);
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function addDays(date, count) { return new Date(Date.parse(`${date}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10); }
export function daysBetween(a, b) { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000); }
export function today() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
export function normalizeRecord(value) {
  if (!validDate(value?.date)) throw new Error('日付を確認してください。');
  if (!Array.isArray(value.symptoms) || value.symptoms.some(s => !Number.isInteger(s) || s < 0 || s >= SYMPTOMS.length)) throw new Error('症状を確認してください。');
  if (![null, '', '少ない', '普通', '多い'].includes(value.flow ?? null)) throw new Error('経血量を確認してください。');
  if (typeof value.note !== 'string' || value.note.length > 10000) throw new Error('備考は1万文字以内で入力してください。');
  return { date: value.date, start: value.start === true, end: value.end === true, symptoms: [...new Set(value.symptoms)], flow: value.flow || null, note: value.note };
}
export function periods(records) {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  const result = []; let current = null;
  for (const row of sorted) {
    if (row.start) { current = { start: row.date, end: null }; result.push(current); }
    if (row.end) {
      if (!current || current.end) throw new Error('終了日に対応する開始日を先に登録してください。');
      current.end = row.date;
    }
  }
  return result;
}
export function predict(records, settings = {}) {
  const starts = [...records].filter(r => r.start).map(r => r.date).sort();
  const intervals = starts.slice(1).map((date, i) => daysBetween(starts[i], date)).slice(-6);
  const entered = Number(settings.cycleDays);
  const fallback = Number.isInteger(entered) && entered >= 1 && entered <= 180 ? entered : 28;
  const personalized = intervals.length >= 3;
  const sorted = [...intervals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const cycle = personalized ? Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : fallback;
  const lastStart = starts.at(-1) || (validDate(settings.lastStart) ? settings.lastStart : null);
  if (!lastStart) return { date: null, cycle, personalized: false, latestCycle: intervals.at(-1) ?? null, count: intervals.length };
  const date = addDays(lastStart, cycle);
  return { date, from: personalized ? addDays(lastStart, Math.min(...intervals)) : addDays(date, -3), to: personalized ? addDays(lastStart, Math.max(...intervals)) : addDays(date, 3), cycle, personalized, latestCycle: intervals.at(-1) ?? null, count: intervals.length };
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function toCsv(records, from, to) {
  if (!validDate(from) || !validDate(to) || from > to) throw new Error('出力期間を確認してください。');
  const rows = [['日付', '生理開始', '生理終了', ...SYMPTOMS, '経血量', '備考']];
  for (const r of [...records].filter(r => r.date >= from && r.date <= to).sort((a, b) => b.date.localeCompare(a.date))) rows.push([r.date, r.start ? '開始' : '', r.end ? '終了' : '', ...SYMPTOMS.map((_, i) => r.symptoms.includes(i) ? 'あり' : ''), r.flow || '', r.note]);
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

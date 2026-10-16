export const RECORD_VERSION = 2;
export const CONDITIONS = Object.freeze([
  { id: 'good', label: '良い' }, { id: 'normal', label: '普通' },
  { id: 'not_good', label: 'いまいち' }, { id: 'bad', label: '悪い' },
].map(Object.freeze));
export const SYMPTOMS = Object.freeze([
  { id: 'abdominal_pain', label: '腹痛・生理痛' }, { id: 'headache', label: '頭痛' },
  { id: 'back_pain', label: '腰痛' }, { id: 'fatigue', label: 'だるさ・疲れ' },
  { id: 'sleepiness', label: '眠気' }, { id: 'low_mood', label: '気分の落ち込み' },
].map(Object.freeze));
// This mapping is immutable history, independent of the catalog's display order.
export const LEGACY_SYMPTOM_IDS = Object.freeze({ 0: 'abdominal_pain', 1: 'headache', 2: 'back_pain', 3: 'fatigue', 4: 'sleepiness', 5: 'low_mood' });
export const INTENSITIES = Object.freeze({ light: '軽い', normal: '普通', strong: '強い' });
export const conditionLabel = id => CONDITIONS.find(item => item.id === id)?.label || '';
export const symptomLabel = (id, catalog = SYMPTOMS) => catalog.find(item => item.id === id)?.label || id;

export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function addDays(date, count) { return new Date(Date.parse(`${date}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10); }
export function daysBetween(a, b) { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000); }
export function today() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function emptyRecord(date) { return { schemaVersion: RECORD_VERSION, date, condition: null, start: false, end: false, symptoms: [], flow: null, note: '' }; }

export function normalizeRecord(value, { asOf = today(), catalog = SYMPTOMS } = {}) {
  if (!validDate(value?.date)) throw new Error('日付を確認してください。');
  if (!validDate(asOf) || value.date > asOf) throw new Error('未来の日付を実績として保存することはできません。');
  if (value.schemaVersion != null && ![1, RECORD_VERSION].includes(value.schemaVersion)) throw new Error('この記録形式に対応する最新版で開いてください。');
  if (value.condition != null && !CONDITIONS.some(item => item.id === value.condition)) throw new Error('今日の調子を確認してください。');
  if (!Array.isArray(value.symptoms)) throw new Error('症状を確認してください。');
  const symptoms = value.symptoms.map(item => {
    const id = typeof item === 'number' ? LEGACY_SYMPTOM_IDS[item] : typeof item === 'string' ? item : item?.id;
    const intensity = typeof item === 'object' && item ? item.intensity ?? null : null;
    if (!catalog.some(definition => definition.id === id) || intensity != null && !Object.hasOwn(INTENSITIES, intensity)) throw new Error('症状を確認してください。');
    return { id, intensity };
  });
  if (new Set(symptoms.map(item => item.id)).size !== symptoms.length) throw new Error('同じ症状が重複しています。');
  if (![null, '', '少ない', '普通', '多い'].includes(value.flow ?? null)) throw new Error('経血量を確認してください。');
  if (typeof value.note !== 'string' || value.note.length > 10000) throw new Error('備考は1万文字以内で入力してください。');
  return { schemaVersion: RECORD_VERSION, date: value.date, condition: value.condition ?? null, start: value.start === true, end: value.end === true, symptoms, flow: value.flow || null, note: value.note };
}
export function normalizeSettings(value, asOf = today()) {
  const cycleDays = value.cycleDays == null || value.cycleDays === '' ? null : Number(value.cycleDays);
  const lastStart = value.lastStart || null;
  if (cycleDays != null && (!Number.isInteger(cycleDays) || cycleDays < 1 || cycleDays > 180)
    || lastStart && (!validDate(lastStart) || lastStart > asOf)) throw new Error('周期日数・開始日を確認してください。');
  return { kind: 'settings', cycleDays, lastStart };
}
export function periods(records) {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  const result = []; let current = null;
  for (const record of sorted) {
    if (record.start) { current = { start: record.date, end: null }; result.push(current); }
    if (record.end) {
      if (!current || current.end) throw new Error('終了日に対応する開始日を先に登録してください。');
      current.end = record.date;
    }
  }
  return result;
}
export function cycleIntervals(records) {
  const starts = [...records].filter(record => record.start).map(record => record.date).sort();
  return starts.slice(1).map((date, index) => ({ from: starts[index], to: date, days: daysBetween(starts[index], date) }));
}
export function predict(records, settings = {}) {
  const intervals = cycleIntervals(records).slice(-6).map(item => item.days);
  const entered = Number(settings.cycleDays);
  const fallback = Number.isInteger(entered) && entered >= 1 && entered <= 180 ? entered : 28;
  const personalized = intervals.length >= 3;
  const cycle = personalized ? Math.round(median(intervals)) : fallback;
  const lastStart = [...records].filter(record => record.start).map(record => record.date).sort().at(-1)
    || (validDate(settings.lastStart) ? settings.lastStart : null);
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
  const rows = [['日付', '生理開始', '生理終了', '今日の調子', ...SYMPTOMS.map(item => item.label), '経血量', '備考']];
  for (const value of [...records].filter(record => record.date >= from && record.date <= to).sort((a, b) => b.date.localeCompare(a.date))) {
    const record = normalizeRecord(value);
    rows.push([record.date, record.start ? '開始' : '', record.end ? '終了' : '', conditionLabel(record.condition),
      ...SYMPTOMS.map(item => { const symptom = record.symptoms.find(entry => entry.id === item.id); return symptom ? symptom.intensity ? `あり（${INTENSITIES[symptom.intensity]}）` : 'あり' : ''; }), record.flow || '', record.note]);
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

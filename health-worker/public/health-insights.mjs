import { CONDITIONS, SYMPTOMS, today, addDays, validDate, normalizeRecord, median, cycleIntervals, periods } from './health-domain.mjs';

// A reusable factual window aggregation; no DOM, storage, diagnoses or inferred absence.
export function summarizeWindow(records, from, to, { catalog = SYMPTOMS, asOf = today() } = {}) {
  if (!validDate(from) || !validDate(to) || from > to) throw new Error('集計期間を確認してください。');
  const days = [...new Map(records.filter(record => record.date >= from && record.date <= to && record.date <= asOf)
    .map(record => { const value = normalizeRecord(record, { asOf, catalog }); return [value.date, value]; })).values()].sort((a, b) => b.date.localeCompare(a.date));
  const conditionCounts = CONDITIONS.map(item => ({ ...item, days: days.filter(record => record.condition === item.id).length }));
  return {
    from, to, records: days, recordedDays: days.length,
    noteDays: days.filter(record => record.note.trim()).length,
    missingConditionDays: days.filter(record => record.condition == null).length,
    conditions: conditionCounts,
    symptoms: catalog.map(item => ({ ...item, days: days.filter(record => record.symptoms.some(symptom => symptom.id === item.id)).length })),
  };
}
export function summarizeCycles(records, asOf = today()) {
  const actual = records.filter(record => record.date <= asOf);
  const starts = actual.filter(record => record.start).map(record => record.date).sort();
  if (!starts.length) return null;
  const history = cycleIntervals(actual).slice(-6);
  const intervals = history.map(item => item.days);
  return { lastStart: starts.at(-1), latestCycle: intervals.at(-1) ?? null, medianCycle: median(intervals),
    shortest: intervals.length ? Math.min(...intervals) : null, longest: intervals.length ? Math.max(...intervals) : null, history };
}
export function buildInsights(records, { asOf = today(), catalog = SYMPTOMS } = {}) {
  const from = addDays(asOf, -29);
  const previousTo = addDays(from, -1);
  const current = summarizeWindow(records, from, asOf, { asOf, catalog });
  const previous = summarizeWindow(records, addDays(asOf, -59), previousTo, { asOf, catalog });
  const symptoms = current.symptoms.map(item => ({ ...item, previousDays: previous.symptoms.find(prior => prior.id === item.id).days }))
    .sort((a, b) => b.days - a.days || b.previousDays - a.previousDays || catalog.findIndex(item => item.id === a.id) - catalog.findIndex(item => item.id === b.id));
  const periodHistory = periods(records.filter(record => record.date <= asOf)).filter(period => period.end
    ? period.start <= asOf && period.end >= from : period.start >= from && period.start <= asOf);
  return { current, previous, symptoms, cycles: summarizeCycles(records, asOf), periods: periodHistory, unrecordedDays: 30 - current.recordedDays };
}

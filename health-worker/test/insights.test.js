import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInsights, summarizeWindow, summarizeCycles } from '../public/health-insights.mjs';
import { addDays, emptyRecord } from '../public/health-domain.mjs';
const asOf = '2026-03-01';
const row = (days, extra = {}) => ({ ...emptyRecord(addDays(asOf, days)), ...extra });
test('30 days include today and both boundaries, with separate previous period and future exclusion', () => {
  const model = buildInsights([row(0,{condition:'good'}),row(-29,{condition:'normal'}),row(-30,{condition:'bad'}),row(-59),row(-60),row(1)],{asOf});
  assert.deepEqual([model.current.from,model.current.to,model.previous.from,model.previous.to],['2026-01-31','2026-03-01','2026-01-01','2026-01-30']);
  assert.equal(model.current.recordedDays,2);assert.equal(model.previous.recordedDays,2);assert.equal(model.unrecordedDays,28);
  assert.equal(model.current.conditions.find(item=>item.id==='normal').days,1);
  assert.equal(model.previous.missingConditionDays,1);
});
test('symptom counts are per recorded day, sorted by counts; blank records imply no health judgement', () => {
  const records=[row(0,{symptoms:[1,4],note:'memo'}),row(-1,{symptoms:[{id:'headache',intensity:'strong'}]}),row(-2),row(-30,{symptoms:[4],condition:'normal'}),row(-31,{symptoms:[4]})];
  const model=buildInsights(records,{asOf});
  assert.equal(model.current.recordedDays,3);assert.equal(model.current.noteDays,1);assert.equal(model.current.missingConditionDays,3);
  assert.ok(model.current.conditions.every(item=>item.days===0));
  assert.deepEqual(model.symptoms.slice(0,2).map(item=>[item.id,item.days,item.previousDays]),[['headache',2,0],['sleepiness',1,2]]);
  assert.equal(summarizeWindow([row(0),row(0)],asOf,asOf,{asOf}).recordedDays,1);
});
test('actual cycle facts require starts, include outliers and preserve missing period ends', () => {
  assert.equal(summarizeCycles([row(0)],asOf),null);
  const records=['2025-09-01','2025-09-29','2025-10-28','2025-11-25','2026-02-01'].map(date=>({...emptyRecord(date),start:true}));
  const model=buildInsights(records,{asOf});
  assert.equal(model.cycles.lastStart,'2026-02-01');assert.equal(model.cycles.latestCycle,68);
  assert.equal(model.cycles.medianCycle,28.5);assert.equal(model.cycles.shortest,28);assert.equal(model.cycles.longest,68);
  assert.equal(model.cycles.history.length,4);assert.deepEqual(model.periods,[{start:'2026-02-01',end:null}]);
  assert.equal(buildInsights([], {asOf}).current.recordedDays,0);
});

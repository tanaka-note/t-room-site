import test from 'node:test';
import assert from 'node:assert/strict';
import { predict, periods, normalizeRecord, toCsv, validDate } from '../public/health-domain.mjs';
const row = (date, extra = {}) => ({ date, symptoms: [], flow: null, note: '', start: false, end: false, ...extra });
test('optional records and missing symptoms remain unrecorded', () => {
  assert.deepEqual(normalizeRecord(row('2026-01-01')), row('2026-01-01'));
  assert.equal(validDate('2026-02-30'), false);
  assert.throws(() => normalizeRecord(row('2026-01-01', { symptoms: [6] })));
});
test('forecast uses initial setting then last six completed intervals, including unusual cycles', () => {
  assert.equal(predict([], {}).date, null);
  assert.equal(predict([], { lastStart: '2026-01-01' }).date, '2026-01-29');
  assert.equal(predict([row('2026-01-01', { start: true })], { cycleDays: 31 }).date, '2026-02-01');
  const records = ['2026-01-01','2026-01-28','2026-02-27','2026-03-27'].map(date => row(date, { start: true }));
  const result = predict(records);
  assert.deepEqual([result.cycle,result.latestCycle,result.from,result.to,result.personalized], [28,28,'2026-04-23','2026-04-26',true]);
  records.push(row('2026-05-27', { start: true })); assert.equal(predict(records).to, '2026-07-27');
  const many = ['2025-01-01','2025-04-01','2025-04-29','2025-05-27','2025-06-24','2025-07-22','2025-08-19','2025-09-16'].map(date => row(date,{start:true}));
  assert.equal(predict(many).count,6); assert.equal(predict(many).cycle,28);
});
test('end is explicit; new start never invents the previous end', () => {
  assert.deepEqual(periods([row('2026-01-01',{start:true}),row('2026-02-01',{start:true})]),[{start:'2026-01-01',end:null},{start:'2026-02-01',end:null}]);
  assert.throws(() => periods([row('2026-01-01',{end:true})]));
  assert.deepEqual(periods([row('2026-01-01',{start:true,end:true})]),[{start:'2026-01-01',end:'2026-01-01'}]);
});
test('CSV limits dates, quotes multiline notes and prevents formula execution', () => {
  const csv=toCsv([row('2026-01-01',{note:'=HYPERLINK("x")'}),row('2026-02-01',{note:'out'})],'2026-01-01','2026-01-31');
  assert.match(csv,/'=HYPERLINK/); assert.doesNotMatch(csv,/out/); assert.match(csv,/"日付"/);
  assert.throws(()=>toCsv([],'2026-01-02','2026-01-01'));
});

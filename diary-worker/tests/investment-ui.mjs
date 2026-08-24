import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [source, html] = await Promise.all([
  readFile(`${root}/public/investment.js`, "utf8"),
  readFile(`${root}/public/investment.html`, "utf8")
]);
const context = {
  window: { __investmentDisableAutoInit: true },
  document: { querySelector: () => null },
  Intl,
  Date,
  Math,
  Number,
  Object,
  RegExp,
  String
};
vm.createContext(context);
vm.runInContext(source, context, { filename: "investment.js" });

const hooks = context.window.__investmentTestHooks;
assert.ok(hooks, "investment test hooks must be available");
const {
  RANGE_DEFINITIONS,
  availableRangeDefinitions,
  recordsInRange,
  spansAtLeastCalendarMonths,
  subtractCalendarMonths,
  formatDateAxis,
  formatDateLong,
  calculateChartScale
} = hooks;
const definition = (key) => RANGE_DEFINITIONS.find((entry) => entry.key === key);
const record = (date, total = 1_000_000) => ({ date, total });
const keysFor = (oldest, latest) => [...availableRangeDefinitions([record(oldest), record(latest)])].map((entry) => entry.key);

assert.deepEqual([...RANGE_DEFINITIONS].map((entry) => entry.key), ["1m", "3m", "6m", "1y", "2y", "3y", "5y", "7y", "10y", "max"]);
assert.doesNotMatch(html, /<button[^>]+data-range=/, "期間ボタンをHTMLへ重複定義しない");

assert.equal(subtractCalendarMonths("2026-01-31", 1), "2025-12-31", "1月31日から前年12月31日");
assert.equal(subtractCalendarMonths("2026-03-31", 1), "2026-02-28", "平年3月31日から2月末");
assert.equal(subtractCalendarMonths("2024-03-31", 1), "2024-02-29", "うるう年3月31日から2月末");
assert.equal(subtractCalendarMonths("2024-02-29", 12), "2023-02-28", "うるう日の年戻し");
assert.equal(subtractCalendarMonths("2026-01-15", 3), "2025-10-15", "年をまたぐ月数計算");

const rangeRecords = [
  record("2025-07-30", 900_000),
  record("2025-07-31", 1_000_000),
  record("2026-01-31", 1_100_000),
  record("2026-04-30", 1_200_000),
  record("2026-06-30", 1_300_000),
  record("2026-07-31", 1_400_000)
];
assert.deepEqual([...recordsInRange(rangeRecords, definition("1m"))].map((entry) => entry.date), ["2026-06-30", "2026-07-31"]);
assert.deepEqual([...recordsInRange(rangeRecords, definition("3m"))].map((entry) => entry.date), ["2026-04-30", "2026-06-30", "2026-07-31"]);
assert.deepEqual([...recordsInRange(rangeRecords, definition("6m"))].map((entry) => entry.date), ["2026-01-31", "2026-04-30", "2026-06-30", "2026-07-31"]);
assert.deepEqual([...recordsInRange(rangeRecords, definition("1y"))].map((entry) => entry.date), ["2025-07-31", "2026-01-31", "2026-04-30", "2026-06-30", "2026-07-31"]);
assert.deepEqual([...recordsInRange(rangeRecords, definition("max"))].map((entry) => entry.date), rangeRecords.map((entry) => entry.date));
const shortHistory = [record("2026-05-31"), record("2026-07-31")];
assert.deepEqual([...recordsInRange(shortHistory, definition("6m"))].map((entry) => entry.date), ["2026-05-31", "2026-07-31"], "指定期間より短い場合は全履歴を表示");

assert.deepEqual(keysFor("2026-05-01", "2026-07-31"), ["1m", "3m", "max"], "3ヶ月未満");
assert.deepEqual(keysFor("2026-04-30", "2026-07-31"), ["1m", "3m", "6m", "max"], "3ヶ月で6ヶ月を解禁");
assert.deepEqual(keysFor("2026-01-31", "2026-07-31"), ["1m", "3m", "6m", "1y", "max"], "6ヶ月で1年を解禁");
assert.deepEqual(keysFor("2025-07-31", "2026-07-31"), ["1m", "3m", "6m", "1y", "2y", "max"], "1年で2年を解禁");
assert.deepEqual(keysFor("2024-07-31", "2026-07-31"), ["1m", "3m", "6m", "1y", "2y", "3y", "max"], "2年で3年を解禁");
assert.deepEqual(keysFor("2023-07-31", "2026-07-31"), ["1m", "3m", "6m", "1y", "2y", "3y", "5y", "max"], "3年で5年を解禁");
assert.deepEqual(keysFor("2021-07-31", "2026-07-31"), ["1m", "3m", "6m", "1y", "2y", "3y", "5y", "7y", "max"], "5年で7年を解禁");
assert.deepEqual(keysFor("2019-07-31", "2026-07-31"), ["1m", "3m", "6m", "1y", "2y", "3y", "5y", "7y", "10y", "max"], "7年で10年を解禁");
assert.equal(keysFor("2026-07-31", "2026-07-31").at(-1), "max", "最長は常に最後");
assert.equal(spansAtLeastCalendarMonths("2023-07-31", "2026-07-31", 36), true, "欠損日ではなく最古日と最新日で判定");

assert.equal(formatDateAxis("2026-07-31", "1m", rangeRecords), "7/31", "短期は月日");
assert.equal(formatDateAxis("2026-07-31", "1y", rangeRecords), "26.7", "長期は年月");
assert.equal(formatDateAxis("2026-07-31", "max", shortHistory), "7/31", "短い最長は月日");
assert.equal(formatDateAxis("2026-07-31", "max", rangeRecords), "26.7", "1年以上の最長は年月");
assert.equal(formatDateLong("2026-08-20"), "2026年8月20日", "最新記録日をそのまま表示");

const shortScale = calculateChartScale(recordsInRange(rangeRecords, definition("1m")).map((entry) => entry.total));
const longScale = calculateChartScale(recordsInRange(rangeRecords, definition("max")).map((entry) => entry.total));
assert.ok(shortScale.yMin <= 1_300_000 && shortScale.yMax >= 1_400_000, "短期の表示データからY軸を計算");
assert.ok(longScale.yMin <= 900_000 && longScale.yMax >= 1_400_000, "長期の表示データからY軸を再計算");
assert.notDeepEqual({ yMin: shortScale.yMin, yMax: shortScale.yMax }, { yMin: longScale.yMin, yMax: longScale.yMax });

assert.match(source, /const xFor = \(index\) => padding\.left \+ \(pointCount === 1 \? width \/ 2 : \(index \/ \(pointCount - 1\)\) \* width\)/, "データ点はindex基準で等間隔");
assert.match(source, /const values = state\.visibleRecords\.map\(\(record\) => record\.total\);\s*const \{ yMin, yMax, ySpan, step \} = calculateChartScale\(values\);/s, "Y軸は選択期間の表示データだけで計算");
assert.match(source, /const items = COMPOSITION[\s\S]*?Number\(record\[item\.key\]\) \|\| 0/s, "既存資産構成計算を維持");
assert.match(source, /const label = `\$\{formatDateLong\(dateText\)\}時点`;[\s\S]*?headerAsOf\.textContent = label;[\s\S]*?compositionAsOf\.textContent = label;/s, "基準日は最新記録日の単一ラベルを共有");
assert.doesNotMatch(source, /月末時点|\.setMonth\(/, "月末の誤表示とDate.setMonthのあふれを残さない");

process.stdout.write("My Investment range and date tests passed.\n");

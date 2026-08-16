import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const reportSource = await readFile(resolve(root, "asset-report-k7m4q9x2/report.js"), "utf8");

const context = {
  window: {
    __assetReportDisableAutoRender: true,
    addEventListener: () => {}
  },
  document: {},
  Intl,
  Date,
  Math,
  Number,
  parseInt,
  parseFloat,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: () => {},
  cancelAnimationFrame: () => {}
};

vm.createContext(context);
vm.runInContext(reportSource, context, { filename: "asset-report-report.js" });

const hooks = context.window.__assetReportTestHooks;
assert.ok(hooks, "window.__assetReportTestHooks must exist");
assert.equal(typeof hooks.calculateHistoryScale, "function");
assert.equal(typeof hooks.historyMarketValue, "function");

const { calculateHistoryScale, historyMarketValue } = hooks;

const small = calculateHistoryScale([6380000, 6400000, 6420000, 6390000, 6410000]);
assert.equal(small.minValue, 6380000);
assert.equal(small.maxValue, 6420000);
assert.equal(small.adjustedSpread, 160500);
assert.ok((small.yMax - small.yMin) < 300000, `小さな変動のY軸が過剰に広がっていない: ${small.yMax - small.yMin}`);

const large = calculateHistoryScale([6000000, 8000000]);
assert.equal(large.minValue, 6000000);
assert.equal(large.maxValue, 8000000);
assert.ok(large.yMin <= 6000000, `下限は最小値を下回るまたは同値: ${large.yMin}`);
assert.ok(large.yMax >= 8000000, `上限は最大値を上回るまたは同値: ${large.yMax}`);

const tenMillion = calculateHistoryScale([10_000_000, 10_150_000, 10_100_000, 10_080_000]);
assert.ok(tenMillion.ySpan > 0, "10万円以上の規模で幅が算出される");
assert.ok(tenMillion.adjustedSpread >= 100000, "最小表示幅は100000以上");

const weekScale = calculateHistoryScale([6_341_192, 6_345_218, 6_397_495, 6_382_548, 6_384_282]);
const allScale = calculateHistoryScale([6_221_192, 6_167_574, 6_237_083, 6_345_218, 6_343_667, 6_393_495, 6_387_548, 6_384_282, 6_409_958, 6_389_451, 6_411_887, 6_423_188, 6_422_213]);
assert.ok(allScale.ySpan >= weekScale.ySpan, "全期間のY軸幅は週次より小さくならない");

const latest = historyMarketValue({ period: "2026-08-15", marketValue: 6422213 });
assert.equal(latest, 6322213);
const previous = historyMarketValue({ period: "2026-08-14", marketValue: 6423188 });
assert.equal(previous, 6423188);

assert.doesNotMatch(reportSource, /yFor\(entry\.marketValue\)/, "時価総額描画はentry.marketValueを直接使っていない");
assert.match(reportSource, /yFor\(historyMarketValue\(entry\)\)/, "時価総額描画のy計算はhistoryMarketValueを通る");
assert.match(reportSource, /renderHistoryTooltip\(entry, xFor\(index\), yFor\(historyMarketValue\(entry\)\)\);/, "tooltipYはdisplay値と同じ計算");

process.stdout.write("asset report history scale tests passed.\n");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const reportSource = await readFile(resolve(root, "asset-report-k7m4q9x2/report.js"), "utf8");
const reportHtml = await readFile(resolve(root, "asset-report-k7m4q9x2/index.html"), "utf8");
const reportCss = await readFile(resolve(root, "asset-report-k7m4q9x2/report.css"), "utf8");

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

const summaryElements = new Map([
  ["#principal-value", { textContent: "" }],
  ["#market-value", { textContent: "" }],
  ["#profit-value", { textContent: "", className: "" }],
  ["#return-value", { textContent: "", className: "" }],
  ["#donut-total", { textContent: "" }]
]);
context.document.querySelector = (selector) => summaryElements.get(selector);
const portfolioTotal = vm.runInContext("renderSummary()", context);
assert.equal(summaryElements.get("#market-value").textContent, summaryElements.get("#donut-total").textContent,
  "上部の時価総額と資産構成中央は同一の調整後金額を表示する");
assert.equal(summaryElements.get("#principal-value").textContent, "￥6,000,000", "上部の元本は維持する");
assert.equal(summaryElements.get("#profit-value").textContent, "+￥431,675", "調整後の損益計算を維持する");
assert.equal(summaryElements.get("#return-value").textContent, "+7.19%", "調整後の損益率計算を維持する");
assert.equal(summaryElements.get("#market-value").textContent, "￥6,431,675", "投資信託他売却損を反映した時価総額を表示する");
assert.equal(portfolioTotal, 6_651_675, "資産構成のセグメント・構成比には従来の保有資産合計を使う");
assert.match(reportHtml, /<time datetime="2026-08-24">2026\.08\.24<\/time>/);
assert.match(reportHtml, /2026年8月24日時点/);
assert.match(reportHtml, /datetime="2026-08-24">2026年8月24日<\/time>/);

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
assert.equal(latest, 6202213);
const previous = historyMarketValue({ period: "2026-08-14", marketValue: 6423188 });
assert.equal(previous, 6423188);
const current = historyMarketValue({ period: "2026-08-16", marketValue: 6424845 });
assert.equal(current, 6204845);
const latestCurrent = historyMarketValue({ period: "2026-08-17", marketValue: 6416884 });
assert.equal(latestCurrent, 6196884);

assert.match(reportSource, /period: "2026-08-24"/);
assert.match(reportSource, /appliedFrom: "2026-08-15"/);
assert.match(reportSource, /name: "投資信託他売却損"/);
assert.doesNotMatch(reportSource, /name: "運用手数料・雑費"/);
assert.match(reportSource, /value: -220000/);
assert.match(reportSource, /\{ period: "2026-08-17", principal: 6000000, marketValue: 6416884 \}/);
assert.match(reportSource, /\{ period: "2026-08-18", principal: 6000000, marketValue: 6402118 \}/);
assert.match(reportSource, /\{ period: "2026-08-19", principal: 6000000, marketValue: 6298001 \}/);
assert.match(reportSource, /\{ period: "2026-08-20", principal: 6000000, marketValue: 6510008 \}/);
assert.match(reportSource, /\{ period: "2026-08-21", principal: 6000000, marketValue: 6679288 \}/);
assert.match(reportSource, /\{ period: "2026-08-22", principal: 6000000, marketValue: 6666459 \}/);
assert.match(reportSource, /\{ period: "2026-08-24", principal: 6000000, marketValue: 6651675 \}/);
assert.match(reportSource, /name: "ビットコイン"[\s\S]*?marketValue: 1998720/);

assert.doesNotMatch(reportSource, /yFor\(entry\.marketValue\)/, "時価総額描画はentry.marketValueを直接使っていない");
assert.match(reportSource, /yFor\(historyMarketValue\(entry\)\)/, "時価総額描画のy計算はhistoryMarketValueを通る");
assert.match(reportSource, /renderHistoryTooltip\(entry, xFor\(index\), yFor\(historyMarketValue\(entry\)\)\);/, "tooltipYはdisplay値と同じ計算");
assert.doesNotMatch(reportSource, /drawSeries\(\(entry\) => entry\.principal/, "元本の破線を描画しない");
assert.doesNotMatch(reportSource, /\[entry\.principal, "#8996a8"\]/, "選択位置に元本のポイントを描画しない");
assert.match(reportSource, /drawSeries\(\(entry\) => historyMarketValue\(entry\), "#52e6aa"/, "時価総額の緑色ラインを維持する");
assert.match(reportSource, /createLinearGradient[\s\S]*?context\.fill\(\);/, "時価総額の緑色の塗りを維持する");

const historySection = reportHtml.match(/<section id="history-section"[\s\S]*?<\/section>/)?.[0] || "";
assert.match(historySection, /aria-label="時価総額の日次推移"/, "チャートARIAは時価総額のみを表す");
assert.doesNotMatch(historySection, /元本/, "資産推移チャートの凡例・ARIAに元本を表示しない");
assert.match(historySection, /history-dot-market[\s\S]*?時価総額/, "時価総額の凡例を維持する");
assert.doesNotMatch(reportCss, /history-dot-principal/, "不要になった元本凡例スタイルを残さない");

process.stdout.write("asset report history scale tests passed.\n");

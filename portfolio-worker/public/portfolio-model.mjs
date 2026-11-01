// Portfolio values are supplied only by the authenticated report API.

export const ALLOCATION_GROUPS = Object.freeze([
  { id: "us-stocks", name: "米株", color: "#ff8a61" },
  { id: "india-stocks", name: "インド株", color: "#f4ca64" },
  { id: "bitcoin", name: "ビットコイン", color: "#a98cff" },
  { id: "japan-stocks", name: "日本株", color: "#52e6aa" }
].map(Object.freeze));

export function allocationGroups(data) {
  const groups = ALLOCATION_GROUPS.map(group => ({ ...group, marketValue: 0 }));
  for (const asset of data.assets) {
    const group = groups.find(group => group.name === asset.category);
    requireValue(group, "asset.category: unknown allocation group");
    group.marketValue += asset.marketValue;
  }
  return groups;
}

// Presentation-only allocation: never write these adjusted amounts back into
// assets/history. Use the same single dated snapshot as the portfolio summary.
export function adjustedAllocationGroups(data) {
  const groups = allocationGroups(data);
  const deduction = -adjustmentForPeriod(data.performanceAdjustmentSnapshots, data.period);
  const perGroup = Math.floor(deduction / groups.length);
  const remainder = deduction % groups.length;
  return groups.map((group, index) => {
    // Integer yen, deterministic remainder order: US, India, BTC, Japan.
    const allocatedDeduction = perGroup + (index < remainder ? 1 : 0);
    const adjustment = allocatedDeduction === 0 ? 0 : -allocatedDeduction;
    const marketValue = group.marketValue + adjustment;
    requireValue(marketValue >= 0, "adjusted allocation must not be negative");
    return { ...group, rawMarketValue: group.marketValue, adjustment, marketValue };
  });
}

export function isReportDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value, keys, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), label + ": object required");
  requireValue(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), label + ": unexpected or missing fields");
}

function amount(value, label, minimum = 0) {
  requireValue(Number.isSafeInteger(value) && value >= minimum, label + ": safe integer required");
}

function text(value, label) {
  requireValue(typeof value === "string" && value.trim().length > 0, label + ": nonempty text required");
}

export function rawMarketValue(data) {
  return data.assets.reduce((sum, asset) => sum + asset.marketValue, 0);
}

// Snapshots are ordered by effectiveFrom. Each value replaces the earlier value;
// binary search keeps dated lookups O(log n) even after years of adjustments.
export function adjustmentForPeriod(snapshots, period) {
  let low = 0, high = snapshots.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (snapshots[middle].effectiveFrom <= period) low = middle + 1;
    else high = middle;
  }
  return low ? snapshots[low - 1].cumulativeValue : 0;
}

export function assetProfit(asset) {
  return asset.marketValue - asset.costBasis;
}

export function assetReturnRate(asset) {
  return (assetProfit(asset) / asset.costBasis) * 100;
}

export function createPortfolioModel(data) {
  const adjustment = period => adjustmentForPeriod(data.performanceAdjustmentSnapshots, period);
  return {
    adjustmentForPeriod: adjustment,
    historyMarketValue: entry => entry.rawMarketValue + adjustment(entry.period),
    summary() {
      const raw = rawMarketValue(data);
      const applied = adjustment(data.period);
      const marketValue = raw + applied;
      const profit = marketValue - data.basePrincipal;
      return { rawMarketValue: raw, adjustment: applied, marketValue, profit, returnRate: profit / data.basePrincipal * 100 };
    }
  };
}

export function validatePortfolioData(data, { expectedBasePrincipal = data.basePrincipal } = {}) {
  record(data, ["schemaVersion", "period", "basePrincipal", "realizedProfit", "performanceAdjustmentName", "performanceAdjustmentSnapshots", "monthlyReport", "history", "assets"], "portfolio");
  requireValue(data.schemaVersion === 1, "unsupported schemaVersion");
  requireValue(isReportDate(data.period), "period: invalid calendar date");
  amount(data.basePrincipal, "basePrincipal", 1);
  requireValue(data.basePrincipal === expectedBasePrincipal, "basePrincipal: reporting policy mismatch");
  record(data.realizedProfit, ["name", "value"], "realizedProfit");
  text(data.realizedProfit.name, "realizedProfit.name");
  amount(data.realizedProfit.value, "realizedProfit.value");
  text(data.performanceAdjustmentName, "performanceAdjustmentName");
  requireValue(Array.isArray(data.performanceAdjustmentSnapshots), "performanceAdjustmentSnapshots: array required");
  let previousDate = "";
  for (const snapshot of data.performanceAdjustmentSnapshots) {
    record(snapshot, ["effectiveFrom", "cumulativeValue"], "performanceAdjustmentSnapshot");
    requireValue(isReportDate(snapshot.effectiveFrom) && snapshot.effectiveFrom > previousDate, "performanceAdjustmentSnapshots: dates must be unique and ascending");
    requireValue(Number.isSafeInteger(snapshot.cumulativeValue) && snapshot.cumulativeValue <= 0, "performanceAdjustmentSnapshots: loss must be a nonpositive safe integer");
    previousDate = snapshot.effectiveFrom;
  }
  requireValue(Array.isArray(data.assets) && data.assets.length > 0, "assets: nonempty array required");
  const ids = new Set();
  for (const asset of data.assets) {
    record(asset, ["id", "name", "category", "costBasis", "marketValue", "color"], "asset");
    requireValue(typeof asset.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(asset.id) && !ids.has(asset.id), "asset.id: invalid or duplicate stable ID");
    ids.add(asset.id);
    text(asset.name, "asset.name");
    text(asset.category, "asset.category");
    const group = ALLOCATION_GROUPS.find(group => group.name === asset.category);
    requireValue(group, "asset.category: unknown allocation group");
    amount(asset.costBasis, "asset.costBasis", 1);
    amount(asset.marketValue, "asset.marketValue");
    requireValue(typeof asset.color === "string" && /^#[a-f0-9]{6}$/i.test(asset.color), "asset.color: hex color required");
    requireValue(asset.color === group.color, "asset.color: must match allocation group");
  }
  amount(rawMarketValue(data), "assets total");
  record(data.monthlyReport, ["entries"], "monthlyReport");
  requireValue(Array.isArray(data.monthlyReport.entries), "monthlyReport.entries: array required");
  for (const entry of data.monthlyReport.entries) {
    record(entry, ["date", "dateLabel", "text"], "monthlyReport entry");
    requireValue(isReportDate(entry.date) || (typeof entry.date === "string" && /^\d{4}-\d{2}$/.test(entry.date) && isReportDate(entry.date + "-01")), "monthlyReport.date: invalid calendar date");
    text(entry.dateLabel, "monthlyReport.dateLabel");
    requireValue(typeof entry.text === "string", "monthlyReport.text: text required");
  }
  requireValue(Array.isArray(data.history) && data.history.length > 0, "history: nonempty array required");
  previousDate = "";
  for (const entry of data.history) {
    record(entry, ["period", "basePrincipal", "rawMarketValue"], "history entry");
    requireValue(isReportDate(entry.period) && entry.period > previousDate, "history: dates must be unique and ascending");
    amount(entry.basePrincipal, "history.basePrincipal", 1);
    requireValue(entry.basePrincipal === expectedBasePrincipal, "history.basePrincipal: reporting policy mismatch");
    amount(entry.rawMarketValue, "history.rawMarketValue");
    previousDate = entry.period;
  }
  const latest = data.history.at(-1);
  requireValue(latest.period === data.period, "latest history date must match report period");
  requireValue(latest.rawMarketValue === rawMarketValue(data), "latest history rawMarketValue must match assets total");
  return data;
}

export function calculateHistoryScale(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return {
      yMin: 0,
      yMax: 1,
      ySpan: 1,
      tickInterval: 1,
      minValue: 0,
      maxValue: 1,
      adjustedSpread: 1
    };
  }

  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (!finiteValues.length) {
    return {
      yMin: 0,
      yMax: 1,
      ySpan: 1,
      tickInterval: 1,
      minValue: 0,
      maxValue: 1,
      adjustedSpread: 1
    };
  }

  const minValue = Math.min(...finiteValues);
  const maxValue = Math.max(...finiteValues);
  const actualSpread = Math.max(maxValue - minValue, 0);
  const minimumSpread = Math.max(maxValue * 0.025, 100000);
  const adjustedSpread = Math.max(actualSpread, minimumSpread);
  const padding = adjustedSpread * 0.08;
  const lowerBound = minValue - padding;
  const upperBound = maxValue + padding;
  const tickInterval = niceHistoryStep(adjustedSpread / 4);
  const yMin = Math.floor(lowerBound / tickInterval) * tickInterval;
  const yMax = Math.ceil(upperBound / tickInterval) * tickInterval;
  const ySpan = Math.max(yMax - yMin, tickInterval);

  return {
    yMin,
    yMax,
    ySpan,
    tickInterval,
    minValue,
    maxValue,
    adjustedSpread
  };
}


function niceHistoryStep(value) {
  const safeValue = Math.max(Number(value) || 1, 1);
  const magnitude = 10 ** Math.floor(Math.log10(safeValue));
  const normalized = safeValue / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

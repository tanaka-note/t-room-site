"use strict";

const reportData = {
  period: "2026-08-15",
  principal: 6000000,
  realizedProfit: {
    name: "投資信託売却益",
    value: 1058649
  },
  operatingExpense: {
    name: "運用手数料・雑費",
    value: 0
  },
  monthlyReport: {
    entries: [
      {
        date: "2026-08-03",
        dateLabel: "2026年8月3日",
        text: "追加で日本株式と米国株式の上場投信を購入。個別銘柄については、長期で成長が期待できる銘柄を選定。"
      },
      {
        date: "2026-07",
        dateLabel: "2026年7月",
        text: "インド株式の低迷とBTC価格下落に伴い、損益が悪化。バランス改善のため国内株式および全世界株式への分散投資の比率を引き上げました。インド株式への投資については追加の売却を行う予定はありません。"
      }
    ],
    updated: "2026-08-15",
    updatedLabel: "2026年8月15日"
  },
  history: [
    { period: "2026-07-31", principal: 6000000, marketValue: 6221192 },
    { period: "2026-08-03", principal: 6000000, marketValue: 6167574 },
    { period: "2026-08-04", principal: 6000000, marketValue: 6237083 },
    { period: "2026-08-05", principal: 6000000, marketValue: 6345218 },
    { period: "2026-08-06", principal: 6000000, marketValue: 6343667 },
    { period: "2026-08-07", principal: 6000000, marketValue: 6393495 },
    { period: "2026-08-08", principal: 6000000, marketValue: 6387548 },
    { period: "2026-08-09", principal: 6000000, marketValue: 6384282 },
    { period: "2026-08-10", principal: 6000000, marketValue: 6409958 },
    { period: "2026-08-11", principal: 6000000, marketValue: 6389451 },
    { period: "2026-08-13", principal: 6000000, marketValue: 6411887 },
    { period: "2026-08-14", principal: 6000000, marketValue: 6423188 },
    { period: "2026-08-15", principal: 6000000, marketValue: 6422213 }
  ],
  assets: [
    {
      name: "iFナス100H無",
      category: "ETF",
      principal: 2002329,
      marketValue: 2146074,
      color: "#ff8a61"
    },
    {
      name: "iSNIFTY50",
      category: "ETF",
      principal: 866320,
      marketValue: 877744,
      color: "#f4ca64"
    },
    {
      name: "三菱電",
      category: "日本株",
      principal: 553200,
      marketValue: 615300,
      color: "#52e6aa"
    },
    {
      name: "三菱HCキャピタル",
      category: "日本株",
      principal: 430200,
      marketValue: 420300,
      color: "#68a7ff"
    },
    {
      name: "伊藤忠",
      category: "日本株",
      principal: 198100,
      marketValue: 206450,
      color: "#ffb454"
    },
    {
      name: "アコム",
      category: "日本株",
      principal: 142500,
      marketValue: 145080,
      color: "#50d3c2"
    },
    {
      name: "イオン",
      category: "日本株",
      principal: 135100,
      marketValue: 137400,
      color: "#f06fa9"
    },
    {
      name: "ソフトバンク",
      category: "日本株",
      principal: 111500,
      marketValue: 117450,
      color: "#96a7ff"
    },
    {
      name: "NTT",
      category: "日本株",
      principal: 75500,
      marketValue: 81350,
      color: "#c6dc70"
    },
    {
      name: "ムニノバHD",
      category: "日本株",
      principal: 43900,
      marketValue: 45500,
      color: "#7e8da1"
    },
    {
      name: "ビットコイン",
      category: "暗号資産",
      principal: 2500000,
      marketValue: 1629565,
      color: "#a98cff"
    }
  ]
};

const yenFormatter = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0
});

const HISTORY_RANGE_DEFINITIONS = {
  "7d": { label: "1週間", days: 7 },
  "1m": { label: "1ヶ月", days: 31 },
  all: { label: "すべて", days: null }
};

const historyView = {
  range: "all",
  records: [],
  visibleRecords: [],
  geometry: null,
  selectedIndex: -1,
  eventsBound: false,
  resizeObserver: null,
  observedWidth: 0
};

let currentPortfolioTotal = 0;

function formatYen(value, signed = false) {
  if (value === null || value === undefined) return "—";
  const formatted = yenFormatter.format(Math.abs(value));
  if (!signed || value === 0) return formatted;
  return `${value > 0 ? "+" : "−"}${formatted}`;
}

function formatPercent(value, signed = false) {
  if (value === null || value === undefined) return "—";
  const prefix = signed && value > 0 ? "+" : value < 0 ? "−" : "";
  return `${prefix}${Math.abs(value).toFixed(2)}%`;
}

function valueClass(value) {
  if (value === null || value === undefined || value === 0) return "";
  return value > 0 ? "is-positive" : "is-negative";
}

function assetsByMarketValue() {
  return [...reportData.assets].sort((assetA, assetB) => assetB.marketValue - assetA.marketValue);
}

function assetProfit(asset) {
  return asset.marketValue - asset.principal;
}

function assetReturnRate(asset) {
  return (assetProfit(asset) / asset.principal) * 100;
}

function totalMarketValue(includeAdjustment = false) {
  const baseTotal = reportData.assets.reduce((sum, asset) => sum + asset.marketValue, 0);
  return includeAdjustment ? baseTotal + reportData.operatingExpense.value : baseTotal;
}

function historyMarketValue(entry) {
  return entry.marketValue + (entry.period === reportData.period ? reportData.operatingExpense.value : 0);
}

function renderSummary() {
  const total = totalMarketValue(false);
  const adjustedTotal = totalMarketValue(true);
  const profit = adjustedTotal - reportData.principal;
  const returnRate = (profit / reportData.principal) * 100;

  document.querySelector("#principal-value").textContent = formatYen(reportData.principal);
  document.querySelector("#market-value").textContent = formatYen(adjustedTotal);

  const profitElement = document.querySelector("#profit-value");
  profitElement.textContent = formatYen(profit, true);
  profitElement.className = valueClass(profit);

  const returnElement = document.querySelector("#return-value");
  returnElement.textContent = formatPercent(returnRate, true);
  returnElement.className = valueClass(returnRate);

  document.querySelector("#donut-total").textContent = formatYen(total);
  return total;
}

function renderLegend(total) {
  const legend = document.querySelector("#allocation-legend");
  const fragment = document.createDocumentFragment();

  assetsByMarketValue().forEach((asset) => {
    const share = (asset.marketValue / total) * 100;
    const item = document.createElement("li");
    item.innerHTML = `
      <span class="legend-color" style="background:${asset.color};color:${asset.color}" aria-hidden="true"></span>
      <span class="legend-name">${asset.name}<small>${formatYen(asset.marketValue)}</small></span>
      <strong class="legend-share">${share.toFixed(2)}%</strong>
    `;
    fragment.appendChild(item);
  });

  legend.replaceChildren(fragment);
}

function renderHoldings() {
  const body = document.querySelector("#holdings-body");
  const fragment = document.createDocumentFragment();

  assetsByMarketValue().forEach((asset) => {
    const row = document.createElement("tr");
    const profit = assetProfit(asset);
    const returnRate = assetReturnRate(asset);
    const profitClass = valueClass(profit);
    const returnClass = valueClass(returnRate);

    row.innerHTML = `
      <td><span class="asset-name"><strong>${asset.name}</strong><small>${asset.category}</small></span></td>
      <td data-label="時価総額">${formatYen(asset.marketValue)}</td>
      <td data-label="損益" class="${profitClass}">${formatYen(profit, true)}</td>
      <td data-label="損益率" class="${returnClass}">${formatPercent(returnRate, true)}</td>
    `;
    fragment.appendChild(row);
  });

  const realizedRow = document.createElement("tr");
  realizedRow.className = "realized-profit-row";
  realizedRow.innerHTML = `
    <td><span class="asset-name"><strong>${reportData.realizedProfit.name}</strong><small>実現損益</small></span></td>
    <td data-label="時価総額" class="unknown-value">—</td>
    <td data-label="売却益" class="is-positive">${formatYen(reportData.realizedProfit.value, true)}</td>
    <td data-label="損益率" class="unknown-value">—</td>
  `;
  fragment.appendChild(realizedRow);

  const operatingExpenseRow = document.createElement("tr");
  const operatingExpenseClass = valueClass(reportData.operatingExpense.value);
  operatingExpenseRow.className = "realized-profit-row";
  operatingExpenseRow.innerHTML = `
    <td><span class="asset-name"><strong>${reportData.operatingExpense.name}</strong><small>運用成績調整</small></span></td>
    <td data-label="時価総額" class="unknown-value">—</td>
    <td data-label="手数料・雑費" class="${operatingExpenseClass}">${formatYen(reportData.operatingExpense.value, true)}</td>
    <td data-label="損益率" class="unknown-value">—</td>
  `;
  fragment.appendChild(operatingExpenseRow);

  body.replaceChildren(fragment);
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function drawAllocationChart(total) {
  const canvas = document.querySelector("#allocation-chart");
  const { context, width, height } = setupCanvas(canvas);
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.45;
  const lineWidth = Math.max(28, radius * 0.28);
  let startAngle = -Math.PI / 2;

  context.clearRect(0, 0, width, height);
  context.lineCap = "butt";

  assetsByMarketValue().forEach((asset) => {
    const angle = (asset.marketValue / total) * Math.PI * 2;
    context.beginPath();
    context.arc(centerX, centerY, radius - lineWidth / 2, startAngle, startAngle + angle);
    context.strokeStyle = asset.color;
    context.lineWidth = lineWidth;
    context.stroke();
    startAngle += angle;
  });
}

function initializeHistoryChart() {
  const section = document.querySelector("#history-section");
  historyView.records = [...reportData.history]
    .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.period)
      && Number.isFinite(entry.principal)
      && Number.isFinite(entry.marketValue))
    .sort((entryA, entryB) => entryA.period.localeCompare(entryB.period));

  if (historyView.records.length < 2) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  bindHistoryChartEvents();
  applyHistoryRange(historyView.range);
}

function bindHistoryChartEvents() {
  if (historyView.eventsBound) return;
  historyView.eventsBound = true;
  const controls = document.querySelector("#history-range-controls");
  const canvas = document.querySelector("#history-chart");
  const frame = document.querySelector(".chart-frame-history");
  controls.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-history-range]");
    if (button) applyHistoryRange(button.dataset.historyRange);
  });
  canvas.addEventListener("pointerdown", showNearestHistoryPoint);
  canvas.addEventListener("pointermove", showNearestHistoryPoint);
  canvas.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") hideHistoryTooltip();
  });
  if ("ResizeObserver" in window) {
    historyView.resizeObserver = new ResizeObserver(([entry]) => {
      const nextWidth = Math.round(entry.contentRect.width);
      if (!nextWidth || nextWidth === historyView.observedWidth) return;
      historyView.observedWidth = nextWidth;
      window.requestAnimationFrame(() => drawHistoryChart());
    });
    historyView.resizeObserver.observe(frame);
  }
}

function applyHistoryRange(rangeKey) {
  const definition = HISTORY_RANGE_DEFINITIONS[rangeKey] || HISTORY_RANGE_DEFINITIONS.all;
  historyView.range = HISTORY_RANGE_DEFINITIONS[rangeKey] ? rangeKey : "all";
  const latestDate = parseHistoryDate(historyView.records.at(-1).period);
  let threshold = null;
  if (definition.days) {
    threshold = new Date(latestDate);
    threshold.setDate(threshold.getDate() - definition.days);
  }
  historyView.visibleRecords = threshold
    ? historyView.records.filter((entry) => parseHistoryDate(entry.period) >= threshold)
    : [...historyView.records];
  if (!historyView.visibleRecords.length) historyView.visibleRecords = [historyView.records.at(-1)];
  historyView.selectedIndex = -1;
  hideHistoryTooltip(false);
  updateHistoryRangeUi(definition);
  drawHistoryChart();
}

function updateHistoryRangeUi(definition) {
  const first = historyView.visibleRecords[0];
  const latest = historyView.visibleRecords.at(-1);
  document.querySelector("#history-period").textContent = `${formatHistoryDateShort(first.period)} — ${formatHistoryDateShort(latest.period)}`;
  document.querySelector("#history-summary").textContent = `${formatHistoryDateLong(first.period)}の${formatYen(historyMarketValue(first))}から、${formatHistoryDateLong(latest.period)}の${formatYen(historyMarketValue(latest))}までの推移です。`;
  document.querySelectorAll("button[data-history-range]").forEach((button) => {
    const active = button.dataset.historyRange === historyView.range;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    if (active) button.setAttribute("aria-label", `${definition.label}を表示中`);
    else button.removeAttribute("aria-label");
  });
}

function drawHistoryChart() {
  if (!historyView.visibleRecords?.length) return;

  const canvas = document.querySelector("#history-chart");
  const { context, width, height } = setupCanvas(canvas);
  const compact = width < 560;
  const padding = { top: 24, right: compact ? 12 : 22, bottom: 44, left: compact ? 62 : 82 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const values = historyView.visibleRecords.flatMap((entry) => [entry.principal, historyMarketValue(entry)]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const rawSpread = Math.max(maxValue - minValue, 100000);
  const tickInterval = niceHistoryStep(rawSpread / 5);
  const yMin = Math.max(0, Math.floor((minValue - rawSpread * 0.08) / tickInterval) * tickInterval);
  const yMax = Math.ceil((maxValue + rawSpread * 0.08) / tickInterval) * tickInterval;
  const ySpan = Math.max(yMax - yMin, tickInterval);
  const pointCount = historyView.visibleRecords.length;
  const xFor = (index) => padding.left + (pointCount === 1 ? chartWidth / 2 : (index / (pointCount - 1)) * chartWidth);
  const yFor = (value) => padding.top + ((yMax - value) / ySpan) * chartHeight;

  context.clearRect(0, 0, width, height);
  context.font = `600 ${compact ? 10 : 11}px "Yu Gothic UI", sans-serif`;
  context.fillStyle = "#8996a8";
  context.strokeStyle = "rgba(178, 201, 218, 0.15)";
  context.lineWidth = 1;

  for (let value = yMin; value <= yMax + tickInterval * 0.5; value += tickInterval) {
    const y = yFor(value);
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.textAlign = "right";
    context.textBaseline = "middle";
    context.fillText(formatHistoryAxisValue(value), padding.left - 10, y);
  }

  const labelCount = Math.min(compact ? 4 : 6, pointCount);
  const labelIndexes = new Set();
  for (let index = 0; index < labelCount; index += 1) {
    labelIndexes.add(Math.round((index / Math.max(labelCount - 1, 1)) * (pointCount - 1)));
  }
  context.fillStyle = "#8996a8";
  context.textBaseline = "top";
  [...labelIndexes].forEach((recordIndex, position, indexes) => {
    const x = xFor(recordIndex);
    context.textAlign = position === 0 ? "left" : position === indexes.length - 1 ? "right" : "center";
    context.fillText(formatHistoryDateAxis(historyView.visibleRecords[recordIndex].period), x, padding.top + chartHeight + 14);
  });

  const gradient = context.createLinearGradient(0, padding.top, 0, padding.top + chartHeight);
  gradient.addColorStop(0, "rgba(82, 230, 170, 0.24)");
  gradient.addColorStop(1, "rgba(82, 230, 170, 0)");
  context.beginPath();
  historyView.visibleRecords.forEach((entry, index) => {
    const x = xFor(index);
    const y = yFor(entry.marketValue);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.lineTo(xFor(pointCount - 1), padding.top + chartHeight);
  context.lineTo(xFor(0), padding.top + chartHeight);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  const drawSeries = (key, color, options = {}) => {
    context.beginPath();
    historyView.visibleRecords.forEach((entry, index) => {
      const x = xFor(index);
      const yValue = key === "marketValue" ? historyMarketValue(entry) : entry[key];
      const y = yFor(yValue);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = color;
    context.lineWidth = options.lineWidth || 2.5;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.setLineDash(options.dash || []);
    context.stroke();
    context.setLineDash([]);
  };

  drawSeries("principal", "#8996a8", { lineWidth: 1.8, dash: [7, 7] });
  drawSeries("marketValue", "#52e6aa", { lineWidth: compact ? 2.2 : 2.8 });

  if (historyView.selectedIndex >= 0 && historyView.visibleRecords[historyView.selectedIndex]) {
    const entry = historyView.visibleRecords[historyView.selectedIndex];
    const x = xFor(historyView.selectedIndex);
    const marketValue = historyMarketValue(entry);
    context.strokeStyle = "rgba(245, 247, 250, 0.25)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, padding.top);
    context.lineTo(x, padding.top + chartHeight);
    context.stroke();
    [[marketValue, "#52e6aa"], [entry.principal, "#8996a8"]].forEach(([value, color]) => {
      context.beginPath();
      context.arc(x, yFor(value), 5, 0, Math.PI * 2);
      context.fillStyle = "#07090d";
      context.fill();
      context.strokeStyle = color;
      context.lineWidth = 3;
      context.stroke();
    });
  }

  historyView.geometry = { padding, chartWidth, xFor, yFor };
}

function showNearestHistoryPoint(event) {
  if (!historyView.geometry || !historyView.visibleRecords.length) return;
  const canvas = document.querySelector("#history-chart");
  const bounds = canvas.getBoundingClientRect();
  const localX = event.clientX - bounds.left;
  const { padding, chartWidth, xFor, yFor } = historyView.geometry;
  const clampedX = Math.min(chartWidth, Math.max(0, localX - padding.left));
  const index = historyView.visibleRecords.length === 1
    ? 0
    : Math.round((clampedX / chartWidth) * (historyView.visibleRecords.length - 1));
  const entry = historyView.visibleRecords[index];
  historyView.selectedIndex = index;
  drawHistoryChart();
  renderHistoryTooltip(entry, xFor(index), yFor(entry.marketValue));
}

function renderHistoryTooltip(entry, x, y) {
  const tooltip = document.querySelector("#history-tooltip");
  const frame = document.querySelector(".chart-frame-history");
  const canvas = document.querySelector("#history-chart");
  const marketValue = historyMarketValue(entry);
  const profit = marketValue - entry.principal;
  const date = document.createElement("time");
  date.dateTime = entry.period;
  date.textContent = formatHistoryDateLong(entry.period);
  const value = document.createElement("strong");
  value.textContent = formatYen(marketValue);
  const change = document.createElement("span");
  change.className = valueClass(profit);
  change.textContent = `損益 ${formatYen(profit, true)}`;
  tooltip.replaceChildren(date, value, change);
  const tooltipHalf = 84;
  const relativeX = canvas.offsetLeft + x;
  tooltip.style.left = `${Math.min(frame.clientWidth - tooltipHalf, Math.max(tooltipHalf, relativeX))}px`;
  tooltip.style.top = `${Math.max(92, canvas.offsetTop + y)}px`;
  tooltip.hidden = false;
}

function hideHistoryTooltip(redraw = true) {
  historyView.selectedIndex = -1;
  document.querySelector("#history-tooltip").hidden = true;
  if (redraw && historyView.visibleRecords?.length) drawHistoryChart();
}

function parseHistoryDate(value) {
  return new Date(`${value}T00:00:00+09:00`);
}

function formatHistoryDateLong(value) {
  const date = parseHistoryDate(value);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatHistoryDateShort(value) {
  const date = parseHistoryDate(value);
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function formatHistoryDateAxis(value) {
  const date = parseHistoryDate(value);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatHistoryAxisValue(value) {
  return `${Math.round(value / 10000).toLocaleString("ja-JP")}万円`;
}

function niceHistoryStep(value) {
  const safeValue = Math.max(Number(value) || 1, 1);
  const magnitude = 10 ** Math.floor(Math.log10(safeValue));
  const normalized = safeValue / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function renderComment() {
  const section = document.querySelector("#comment-section");
  const report = reportData.monthlyReport;
  const entries = [...report.entries]
    .filter((entry) => entry.text.trim().length > 0)
    .sort((entryA, entryB) => entryB.date.localeCompare(entryA.date));
  section.hidden = entries.length === 0;
  if (entries.length === 0) return;

  const container = document.querySelector("#monthly-report-entries");
  const fragment = document.createDocumentFragment();
  entries.forEach((entry) => {
    const article = document.createElement("section");
    article.className = "monthly-report-entry";

    const date = document.createElement("time");
    date.className = "report-month";
    date.dateTime = entry.date;
    date.textContent = entry.dateLabel;

    const text = document.createElement("p");
    text.className = "monthly-comment";
    text.textContent = entry.text;

    article.append(date, text);
    fragment.appendChild(article);
  });
  container.replaceChildren(fragment);

  const updated = document.querySelector("#report-updated");
  updated.dateTime = report.updated;
  updated.textContent = report.updatedLabel;
}

function renderReport() {
  const total = renderSummary();
  currentPortfolioTotal = total;
  renderLegend(total);
  renderHoldings();
  renderComment();
  drawAllocationChart(total);
  initializeHistoryChart();
}

let resizeTimer;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    drawAllocationChart(currentPortfolioTotal);
    drawHistoryChart();
  }, 120);
});

renderReport();

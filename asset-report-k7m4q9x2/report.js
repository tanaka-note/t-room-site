"use strict";

const reportData = {
  period: "2026-07",
  principal: 6000000,
  monthlyReport: {
    period: "2026-07",
    periodLabel: "2026年7月",
    text: "インド株式の低迷とBTC価格下落に伴い、損益が悪化。バランス改善のため国内株式および全世界株式への分散投資の比率を引き上げました。インド株式への投資については追加の売却を行う予定はありません。",
    updated: "2026-08-02",
    updatedLabel: "2026年8月2日"
  },
  history: [
    { period: "2026-07", principal: 6000000, marketValue: 6221192 }
  ],
  assets: [
    {
      name: "三菱電機",
      category: "日本株",
      principal: 553200,
      marketValue: 591200,
      color: "#52e6aa"
    },
    {
      name: "三菱HCキャピタル",
      category: "日本株",
      principal: 430200,
      marketValue: 441900,
      color: "#68a7ff"
    },
    {
      name: "NTT",
      category: "日本株",
      principal: 75500,
      marketValue: 76200,
      color: "#f4ca64"
    },
    {
      name: "ビットコイン",
      category: "暗号資産",
      principal: 2000000,
      marketValue: 1611913,
      color: "#a98cff"
    },
    {
      name: "投資信託",
      category: "投資信託",
      principal: 2941100,
      marketValue: 3499979,
      color: "#ff8a61"
    }
  ]
};

const yenFormatter = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0
});

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

function renderSummary() {
  const total = reportData.assets.reduce((sum, asset) => sum + asset.marketValue, 0);
  const profit = total - reportData.principal;
  const returnRate = (profit / reportData.principal) * 100;

  document.querySelector("#principal-value").textContent = formatYen(reportData.principal);
  document.querySelector("#market-value").textContent = formatYen(total);

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

function drawHistoryChart() {
  const section = document.querySelector("#history-section");
  if (reportData.history.length < 2) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  document.querySelector("#allocation-number").textContent = "02";
  document.querySelector("#holdings-number").textContent = "03";
  document.querySelector("#comment-number").textContent = "04";

  const canvas = document.querySelector("#history-chart");
  const { context, width, height } = setupCanvas(canvas);
  const padding = { top: 24, right: 24, bottom: 44, left: 76 };
  const values = reportData.history.flatMap((entry) => [entry.principal, entry.marketValue]);
  const minValue = Math.min(...values) * 0.96;
  const maxValue = Math.max(...values) * 1.04;
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const xStep = chartWidth / (reportData.history.length - 1);
  const yFor = (value) => padding.top + chartHeight - ((value - minValue) / (maxValue - minValue)) * chartHeight;

  context.clearRect(0, 0, width, height);
  context.font = '600 11px "Yu Gothic UI", sans-serif';
  context.fillStyle = "#8996a8";
  context.strokeStyle = "rgba(178, 201, 218, 0.15)";
  context.lineWidth = 1;

  for (let index = 0; index <= 3; index += 1) {
    const y = padding.top + (chartHeight / 3) * index;
    const value = maxValue - ((maxValue - minValue) / 3) * index;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillText(`${Math.round(value / 10000)}万円`, 4, y + 4);
  }

  const drawSeries = (key, color) => {
    context.beginPath();
    reportData.history.forEach((entry, index) => {
      const x = padding.left + xStep * index;
      const y = yFor(entry[key]);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.stroke();
  };

  drawSeries("principal", "#8996a8");
  drawSeries("marketValue", "#52e6aa");
}

function renderComment() {
  const section = document.querySelector("#comment-section");
  const report = reportData.monthlyReport;
  const comment = report.text.trim();
  section.hidden = comment.length === 0;
  if (!comment) return;

  const month = document.querySelector("#report-month");
  month.dateTime = report.period;
  month.textContent = report.periodLabel;
  document.querySelector("#monthly-comment").textContent = comment;

  const updated = document.querySelector("#report-updated");
  updated.dateTime = report.updated;
  updated.textContent = report.updatedLabel;
}

function renderReport() {
  const total = renderSummary();
  renderLegend(total);
  renderHoldings();
  renderComment();
  drawAllocationChart(total);
  drawHistoryChart();
}

let resizeTimer;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(renderReport, 120);
});

renderReport();

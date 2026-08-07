"use strict";

const reportData = {
  period: "2026-08-07",
  principal: 6000000,
  realizedProfit: {
    name: "投資信託売却益",
    value: 1058649
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
    updated: "2026-08-03",
    updatedLabel: "2026年8月3日"
  },
  history: [
    { period: "2026-07-31", principal: 6000000, marketValue: 6221192 },
    { period: "2026-08-03", principal: 6000000, marketValue: 6167574 },
    { period: "2026-08-04", principal: 6000000, marketValue: 6237083 },
    { period: "2026-08-05", principal: 6000000, marketValue: 6345218 },
    { period: "2026-08-06", principal: 6000000, marketValue: 6343667 },
    { period: "2026-08-07", principal: 6000000, marketValue: 6393495 }
  ],
  assets: [
    {
      name: "iFナス100H無",
      category: "ETF",
      principal: 2002329,
      marketValue: 2088576,
      color: "#ff8a61"
    },
    {
      name: "iSNIFTY50",
      category: "ETF",
      principal: 866320,
      marketValue: 885360,
      color: "#f4ca64"
    },
    {
      name: "三菱電",
      category: "日本株",
      principal: 553200,
      marketValue: 582600,
      color: "#52e6aa"
    },
    {
      name: "三菱HCキャピタル",
      category: "日本株",
      principal: 430200,
      marketValue: 433950,
      color: "#68a7ff"
    },
    {
      name: "伊藤忠",
      category: "日本株",
      principal: 198100,
      marketValue: 208000,
      color: "#ffb454"
    },
    {
      name: "アコム",
      category: "日本株",
      principal: 142500,
      marketValue: 144960,
      color: "#50d3c2"
    },
    {
      name: "イオン",
      category: "日本株",
      principal: 135100,
      marketValue: 139100,
      color: "#f06fa9"
    },
    {
      name: "ソフトバンク",
      category: "日本株",
      principal: 111500,
      marketValue: 115450,
      color: "#96a7ff"
    },
    {
      name: "NTT",
      category: "日本株",
      principal: 75500,
      marketValue: 79250,
      color: "#c6dc70"
    },
    {
      name: "ムニノバHD",
      category: "日本株",
      principal: 43900,
      marketValue: 46500,
      color: "#7e8da1"
    },
    {
      name: "ビットコイン",
      category: "暗号資産",
      principal: 2500000,
      marketValue: 1669749,
      color: "#a98cff"
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

  const realizedRow = document.createElement("tr");
  realizedRow.className = "realized-profit-row";
  realizedRow.innerHTML = `
    <td><span class="asset-name"><strong>${reportData.realizedProfit.name}</strong><small>実現損益</small></span></td>
    <td data-label="時価総額" class="unknown-value">—</td>
    <td data-label="売却益" class="is-positive">${formatYen(reportData.realizedProfit.value, true)}</td>
    <td data-label="損益率" class="unknown-value">—</td>
  `;
  fragment.appendChild(realizedRow);

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

  const canvas = document.querySelector("#history-chart");
  const { context, width, height } = setupCanvas(canvas);
  const padding = { top: 24, right: 24, bottom: 44, left: 76 };
  const minValue = 5900000;
  const maxValue = 6400000;
  const tickInterval = 100000;
  const tickCount = (maxValue - minValue) / tickInterval;
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const xStep = chartWidth / (reportData.history.length - 1);
  const yFor = (value) => padding.top + chartHeight - ((value - minValue) / (maxValue - minValue)) * chartHeight;

  context.clearRect(0, 0, width, height);
  context.font = '600 11px "Yu Gothic UI", sans-serif';
  context.fillStyle = "#8996a8";
  context.strokeStyle = "rgba(178, 201, 218, 0.15)";
  context.lineWidth = 1;

  for (let index = 0; index <= tickCount; index += 1) {
    const y = padding.top + (chartHeight / tickCount) * index;
    const value = maxValue - tickInterval * index;
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

    reportData.history.forEach((entry, index) => {
      const x = padding.left + xStep * index;
      const y = yFor(entry[key]);
      context.beginPath();
      context.arc(x, y, 4, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
    });
  };

  drawSeries("principal", "#8996a8");
  drawSeries("marketValue", "#52e6aa");

  context.fillStyle = "#8996a8";
  context.font = '600 11px "Yu Gothic UI", sans-serif';
  context.textAlign = "center";
  reportData.history.forEach((entry, index) => {
    const [, month, day] = entry.period.split("-");
    const x = padding.left + xStep * index;
    context.fillText(`${Number(month)}/${Number(day)}`, x, height - 14);
  });
  context.textAlign = "start";
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

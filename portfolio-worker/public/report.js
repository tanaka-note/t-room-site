"use strict";

import { createPortfolioModel, adjustedAllocationGroups } from './portfolio-model.mjs';
let reportData, allocation = [], adjustmentForPeriod;
const yenFormatter = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0
});

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

function renderSummary() {
  const { marketValue: adjustedTotal, profit, returnRate } = reportData.summary;
  const isLatest = reportData.period === reportData.history.at(-1)?.period;
  document.querySelector(".summary-grid").classList.toggle("is-historical", !isLatest);

  document.querySelector("#principal-value").textContent = formatYen(reportData.basePrincipal);
  document.querySelector("#market-value").textContent = formatYen(adjustedTotal);

  const profitElement = document.querySelector("#profit-value");
  profitElement.closest(".summary-card").hidden = !isLatest;
  profitElement.textContent = isLatest ? formatYen(profit, true) : "";
  profitElement.className = isLatest ? valueClass(profit) : "";

  const returnElement = document.querySelector("#return-value");
  returnElement.closest(".summary-card").hidden = !isLatest;
  returnElement.textContent = isLatest ? formatPercent(returnRate, true) : "";
  returnElement.className = isLatest ? valueClass(returnRate) : "";

  document.querySelector("#donut-total").textContent = formatYen(adjustedTotal);
  return adjustedTotal;
}

function renderLegend(total) {
  const legend = document.querySelector("#allocation-legend");
  const fragment = document.createDocumentFragment();

  allocation.forEach((group) => {
    const share = total > 0 ? (group.marketValue / total) * 100 : 0;
    const item = document.createElement("li");
    item.dataset.groupId = group.id;
    item.innerHTML = `
      <span class="legend-color" style="background:${group.color};color:${group.color}" aria-hidden="true"></span>
      <span class="legend-name">${group.name}<small>${formatYen(group.marketValue)}</small></span>
      <strong class="legend-share">${share.toFixed(2)}%</strong>
    `;
    fragment.appendChild(item);
  });

  legend.replaceChildren(fragment);
}

function renderHoldings() {
  const body = document.querySelector('#holdings-body');
  body.replaceChildren();
  for (const asset of assetsByMarketValue()) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const strong = document.createElement('strong'); strong.textContent = asset.name;
    const small = document.createElement('small'); small.textContent = asset.category;
    const span = document.createElement('span'); span.className = 'asset-name'; span.append(strong, small); name.append(span);
    const value = document.createElement('td'); value.dataset.label = '時価総額'; value.textContent = formatYen(asset.marketValue);
    row.append(name, value); body.append(row);
  }
  for (const [name, value] of [[reportData.realizedProfit.name, reportData.realizedProfit.value], [reportData.performanceAdjustmentName, adjustmentForPeriod(reportData.period)]]) {
    const row = document.createElement('tr'); row.className = 'realized-profit-row';
    const title = document.createElement('td'); title.textContent = name;
    const amount = document.createElement('td'); amount.textContent = formatYen(value, true); amount.className = valueClass(value);
    row.append(title, amount); body.append(row);
  }
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

  allocation.forEach((group) => {
    const angle = total > 0 ? (group.marketValue / total) * Math.PI * 2 : 0;
    context.beginPath();
    context.arc(centerX, centerY, radius - lineWidth / 2, startAngle, startAngle + angle);
    context.strokeStyle = group.color;
    context.lineWidth = lineWidth;
    context.stroke();
    startAngle += angle;
  });
}

function formatReportDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
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

}

function renderReport() {
  const total = renderSummary();
  const updated = document.querySelector("#report-updated");
  updated.dateTime = reportData.period;
  updated.textContent = formatReportDate(reportData.period) + (reportData.time ? ' ' + reportData.time : '');
  currentPortfolioTotal = total;
  renderLegend(total);
  renderHoldings();
  renderComment();
  document.querySelector('.allocation-panel').hidden = !reportData.hasBreakdown;
  document.querySelector('.holdings-panel').hidden = !reportData.hasBreakdown;
  if (reportData.hasBreakdown) drawAllocationChart(total);
}

let resizeTimer;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (reportData?.hasBreakdown) drawAllocationChart(currentPortfolioTotal);
  }, 120);
});

export function showReport(data) {
  reportData = data;
  ({ adjustmentForPeriod } = createPortfolioModel(data));
  allocation = data.hasBreakdown ? adjustedAllocationGroups(data) : [];
  renderReport();
}
export function clearReport() {
  reportData = null; allocation = []; currentPortfolioTotal = 0;
  for (const canvas of document.querySelectorAll('canvas')) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  for (const id of ['holdings-body', 'allocation-legend', 'monthly-report-entries']) document.getElementById(id).replaceChildren();
  for (const id of ['principal-value', 'market-value', 'profit-value', 'return-value', 'report-updated', 'donut-total']) document.getElementById(id).textContent = '';
}

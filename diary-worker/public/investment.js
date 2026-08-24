(() => {
  "use strict";

  const RANGE_DEFINITIONS = Object.freeze([
    { key: "1m", label: "1ヶ月", months: 1, unlockMonths: 0, axis: "short" },
    { key: "3m", label: "3ヶ月", months: 3, unlockMonths: 0, axis: "short" },
    { key: "6m", label: "6ヶ月", months: 6, unlockMonths: 3, axis: "short" },
    { key: "1y", label: "1年", months: 12, unlockMonths: 6, axis: "long" },
    { key: "2y", label: "2年", months: 24, unlockMonths: 12, axis: "long" },
    { key: "3y", label: "3年", months: 36, unlockMonths: 24, axis: "long" },
    { key: "5y", label: "5年", months: 60, unlockMonths: 36, axis: "long" },
    { key: "7y", label: "7年", months: 84, unlockMonths: 60, axis: "long" },
    { key: "10y", label: "10年", months: 120, unlockMonths: 84, axis: "long" },
    { key: "max", label: "最長", months: null, unlockMonths: 0, axis: "auto" }
  ]);
  const RANGE_DEFINITION_BY_KEY = Object.freeze(Object.fromEntries(
    RANGE_DEFINITIONS.map((definition) => [definition.key, definition])
  ));

  const COMPOSITION = [
    { key: "funds", label: "投資信託", color: "#9bd5a9" },
    { key: "stocks", label: "株式（現物）", color: "#d6bc77" },
    { key: "crypto", label: "暗号資産", color: "#e48b5a" },
    { key: "cash", label: "預金・現金", color: "#7da8c9" },
    { key: "bonds", label: "債券", color: "#aa91c6" },
    { key: "futures", label: "先物OP", color: "#d77d9b" },
    { key: "points", label: "ポイント", color: "#c58ad9" },
    { key: "other", label: "その他", color: "#8d9b94" }
  ];

  const state = {
    records: [],
    visibleRecords: [],
    range: "max",
    chartGeometry: null,
    selectedIndex: -1
  };

  const elements = {
    loading: document.querySelector("#loading-message"),
    dashboard: document.querySelector("#dashboard"),
    headerAsOf: document.querySelector("#header-as-of"),
    currentTotal: document.querySelector("#current-total"),
    changeLabel: document.querySelector("#change-label"),
    periodChange: document.querySelector("#period-change"),
    rateLabel: document.querySelector("#rate-label"),
    periodRate: document.querySelector("#period-rate"),
    allTimeHigh: document.querySelector("#all-time-high"),
    allTimeHighDate: document.querySelector("#all-time-high-date"),
    chartPeriod: document.querySelector("#chart-period"),
    rangeControls: document.querySelector("#range-controls"),
    chart: document.querySelector("#asset-chart"),
    tooltip: document.querySelector("#chart-tooltip"),
    chartSummary: document.querySelector("#chart-summary"),
    compositionAsOf: document.querySelector("#composition-as-of"),
    compositionChart: document.querySelector("#composition-chart"),
    compositionList: document.querySelector("#composition-list"),
    donutTotal: document.querySelector("#donut-total")
  };

  const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
  const integer = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
  const percent = new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  exposeTestHooks();
  if (!window.__investmentDisableAutoInit) init();

  async function init() {
    bindEvents();
    try {
      const response = await fetch("/diary/api/investment-history", { headers: { Accept: "application/json" } });
      if (response.status === 401) {
        window.location.replace("/diary/");
        return;
      }
      if (!response.ok) throw new Error("資産データを取得できませんでした。");
      const payload = await response.json();
      state.records = Array.isArray(payload.records)
        ? payload.records.filter(isValidRecord).sort((a, b) => a.date.localeCompare(b.date))
        : [];
      if (!state.records.length) throw new Error("表示できる資産データがありません。");
      renderRangeControls();
      renderAsOf(state.records.at(-1).date);
      renderComposition(state.records.at(-1));
      applyRange("max");
      elements.loading.hidden = true;
      elements.dashboard.hidden = false;
      requestAnimationFrame(renderAllCharts);
    } catch (error) {
      elements.loading.textContent = error instanceof Error ? error.message : "資産データを読み込めませんでした。";
    }
  }

  function bindEvents() {
    elements.rangeControls.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-range]");
      if (!button) return;
      applyRange(button.dataset.range);
    });
    elements.chart.addEventListener("pointermove", showNearestPoint);
    elements.chart.addEventListener("pointerdown", showNearestPoint);
    elements.chart.addEventListener("pointerleave", hideTooltip);
    window.addEventListener("resize", debounce(renderAllCharts, 100));
  }

  function applyRange(rangeKey) {
    const definition = RANGE_DEFINITION_BY_KEY[rangeKey] || RANGE_DEFINITION_BY_KEY.max;
    state.range = RANGE_DEFINITION_BY_KEY[rangeKey] ? rangeKey : "max";
    const threshold = definition.months
      ? subtractCalendarMonths(state.records.at(-1).date, definition.months)
      : null;
    state.visibleRecords = recordsInRange(state.records, definition);
    if (!state.visibleRecords.length) state.visibleRecords = [state.records.at(-1)];
    state.selectedIndex = -1;
    hideTooltip();
    updateRangeButtons();
    renderKpis(definition, threshold);
    if (!elements.dashboard.hidden) renderAssetChart();
  }

  function renderKpis(definition, threshold) {
    const first = state.visibleRecords[0];
    const latest = state.visibleRecords.at(-1);
    const change = latest.total - first.total;
    const rate = first.total ? (change / first.total) * 100 : 0;
    const peak = state.records.reduce((best, record) => record.total > best.total ? record : best, state.records[0]);
    const coversRequestedRange = !threshold || state.records[0].date <= threshold;
    const changeLabel = definition.months && !coversRequestedRange ? "表示期間" : definition.label;

    elements.currentTotal.textContent = yen.format(latest.total);
    elements.changeLabel.textContent = `${changeLabel}の増減`;
    elements.periodChange.textContent = signedYen(change);
    elements.rateLabel.textContent = `${changeLabel}の増減率`;
    elements.periodRate.textContent = `${rate > 0 ? "+" : ""}${percent.format(rate)}%`;
    setTrendClass(elements.periodChange, change);
    setTrendClass(elements.periodRate, rate);
    elements.allTimeHigh.textContent = yen.format(peak.total);
    elements.allTimeHighDate.textContent = formatDateLong(peak.date);
    elements.chartPeriod.textContent = `${formatDateShort(first.date)} — ${formatDateShort(latest.date)}`;
    elements.chartSummary.textContent = `${formatDateLong(first.date)}の${yen.format(first.total)}から、${formatDateLong(latest.date)}の${yen.format(latest.total)}まで、${signedYen(change)}変動しました。`;
  }

  function renderAsOf(dateText) {
    const label = `${formatDateLong(dateText)}時点`;
    elements.headerAsOf.textContent = label;
    elements.compositionAsOf.textContent = label;
  }

  function renderRangeControls() {
    const definitions = availableRangeDefinitions(state.records);
    elements.rangeControls.replaceChildren(...definitions.map((definition) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.range = definition.key;
      button.textContent = definition.label;
      const active = definition.key === state.range;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
      return button;
    }));
  }

  function renderAllCharts() {
    if (elements.dashboard.hidden) return;
    renderAssetChart();
    renderCompositionChart();
  }

  function renderAssetChart() {
    const canvas = elements.chart;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    const compact = rect.width < 520;
    const padding = { top: 18, right: compact ? 12 : 22, bottom: 42, left: compact ? 58 : 78 };
    const width = rect.width - padding.left - padding.right;
    const height = rect.height - padding.top - padding.bottom;
    const values = state.visibleRecords.map((record) => record.total);
    const { yMin, yMax, ySpan, step } = calculateChartScale(values);
    const pointCount = state.visibleRecords.length;
    const xFor = (index) => padding.left + (pointCount === 1 ? width / 2 : (index / (pointCount - 1)) * width);
    const yFor = (value) => padding.top + ((yMax - value) / ySpan) * height;

    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.font = `${compact ? 10 : 11}px "Yu Gothic", sans-serif`;
    ctx.textBaseline = "middle";
    for (let value = yMin; value <= yMax + step * 0.5; value += step) {
      const y = yFor(value);
      ctx.strokeStyle = "rgba(226, 239, 231, 0.11)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + width, y);
      ctx.stroke();
      ctx.fillStyle = "#889890";
      ctx.textAlign = "right";
      ctx.fillText(formatAxisValue(value), padding.left - 10, y);
    }

    const xLabelCount = Math.min(compact ? 4 : 6, pointCount);
    const labelIndexes = new Set();
    for (let i = 0; i < xLabelCount; i += 1) {
      labelIndexes.add(Math.round((i / Math.max(xLabelCount - 1, 1)) * (pointCount - 1)));
    }
    ctx.fillStyle = "#889890";
    ctx.textBaseline = "top";
    [...labelIndexes].forEach((index, position, indexes) => {
      const x = xFor(index);
      ctx.textAlign = position === 0 ? "left" : (position === indexes.length - 1 ? "right" : "center");
      ctx.fillText(formatDateAxis(state.visibleRecords[index].date, state.range, state.visibleRecords), x, padding.top + height + 14);
    });

    const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + height);
    gradient.addColorStop(0, "rgba(155, 213, 169, 0.28)");
    gradient.addColorStop(1, "rgba(155, 213, 169, 0)");
    ctx.beginPath();
    state.visibleRecords.forEach((record, index) => {
      const x = xFor(index);
      const y = yFor(record.total);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.lineTo(xFor(pointCount - 1), padding.top + height);
    ctx.lineTo(xFor(0), padding.top + height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    state.visibleRecords.forEach((record, index) => {
      const x = xFor(index);
      const y = yFor(record.total);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#9bd5a9";
    ctx.lineWidth = compact ? 2 : 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    if (state.selectedIndex >= 0 && state.visibleRecords[state.selectedIndex]) {
      const record = state.visibleRecords[state.selectedIndex];
      const x = xFor(state.selectedIndex);
      const y = yFor(record.total);
      ctx.fillStyle = "#0d1411";
      ctx.strokeStyle = "#9bd5a9";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    state.chartGeometry = { rect, padding, width, height, xFor, yFor };
  }

  function showNearestPoint(event) {
    if (!state.chartGeometry || !state.visibleRecords.length) return;
    const bounds = elements.chart.getBoundingClientRect();
    const localX = event.clientX - bounds.left;
    const { padding, width, xFor, yFor } = state.chartGeometry;
    const clamped = Math.min(width, Math.max(0, localX - padding.left));
    const index = state.visibleRecords.length === 1
      ? 0
      : Math.round((clamped / width) * (state.visibleRecords.length - 1));
    const record = state.visibleRecords[index];
    state.selectedIndex = index;
    renderAssetChart();
    elements.tooltip.innerHTML = `${formatDateLong(record.date)}<strong>${yen.format(record.total)}</strong>`;
    const x = xFor(index);
    const y = yFor(record.total);
    const tooltipHalf = 74;
    elements.tooltip.style.left = `${Math.min(bounds.width - tooltipHalf, Math.max(tooltipHalf, x))}px`;
    elements.tooltip.style.top = `${Math.max(72, y)}px`;
    elements.tooltip.hidden = false;
  }

  function hideTooltip() {
    state.selectedIndex = -1;
    elements.tooltip.hidden = true;
    if (!elements.dashboard.hidden) renderAssetChart();
  }

  function renderComposition(record) {
    const items = COMPOSITION
      .map((item) => ({ ...item, value: Number(record[item.key]) || 0 }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);
    elements.donutTotal.textContent = compactYen(record.total);
    elements.compositionList.replaceChildren(...items.map((item) => {
      const row = document.createElement("div");
      row.className = "composition-row";
      row.innerHTML = `
        <div class="composition-name">
          <span class="composition-dot" style="background:${item.color}" aria-hidden="true"></span>
          <span>${item.label}</span>
        </div>
        <div class="composition-values">
          <strong>${yen.format(item.value)}</strong>
          <span>${percent.format((item.value / record.total) * 100)}%</span>
        </div>`;
      return row;
    }));
    elements.compositionChart.dataset.items = JSON.stringify(items);
  }

  function renderCompositionChart() {
    const canvas = elements.compositionChart;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const items = JSON.parse(canvas.dataset.items || "[]");
    const total = items.reduce((sum, item) => sum + item.value, 0);
    if (!total) return;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const radius = Math.min(rect.width, rect.height) * 0.44;
    const lineWidth = radius * 0.32;
    let angle = -Math.PI / 2;
    items.forEach((item) => {
      const sweep = (item.value / total) * Math.PI * 2;
      const nextAngle = angle + sweep;
      const gap = Math.min(0.012, sweep * 0.24);
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius - lineWidth / 2, angle + gap, nextAngle - gap);
      ctx.strokeStyle = item.color;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
      angle = nextAngle;
    });
  }

  function updateRangeButtons() {
    elements.rangeControls.querySelectorAll("button[data-range]").forEach((button) => {
      const active = button.dataset.range === state.range;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function availableRangeDefinitions(records) {
    if (!records.length) return RANGE_DEFINITIONS.filter((definition) => ["1m", "3m", "max"].includes(definition.key));
    const oldest = records[0].date;
    const latest = records.at(-1).date;
    return RANGE_DEFINITIONS.filter((definition) => (
      definition.key === "max"
      || definition.unlockMonths === 0
      || spansAtLeastCalendarMonths(oldest, latest, definition.unlockMonths)
    ));
  }

  function recordsInRange(records, definition) {
    if (!records.length || !definition.months) return [...records];
    const threshold = subtractCalendarMonths(records.at(-1).date, definition.months);
    return records.filter((record) => record.date >= threshold);
  }

  function spansAtLeastCalendarMonths(oldestDate, latestDate, months) {
    return oldestDate <= subtractCalendarMonths(latestDate, months);
  }

  function subtractCalendarMonths(value, months) {
    const { year, month, day } = parseDateParts(value);
    const targetMonthIndex = (year * 12) + month - 1 - months;
    const targetYear = Math.floor(targetMonthIndex / 12);
    const targetMonth = ((targetMonthIndex % 12) + 12) % 12 + 1;
    const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
    return `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function parseDateParts(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new Error("日付を確認できませんでした。");
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  }

  function isValidRecord(record) {
    return record && /^\d{4}-\d{2}-\d{2}$/.test(record.date) && Number.isFinite(Number(record.total));
  }

  function formatDateLong(value) {
    const { year, month, day } = parseDateParts(value);
    return `${year}年${month}月${day}日`;
  }

  function formatDateShort(value) {
    const { year, month, day } = parseDateParts(value);
    return `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`;
  }

  function formatDateAxis(value, rangeKey, visibleRecords = []) {
    const { year, month, day } = parseDateParts(value);
    const definition = RANGE_DEFINITION_BY_KEY[rangeKey] || RANGE_DEFINITION_BY_KEY.max;
    const shortAxis = definition.axis === "short"
      || (definition.axis === "auto" && !visibleRecordsSpanAtLeastMonths(visibleRecords, 12));
    if (shortAxis) return `${month}/${day}`;
    return `${String(year).slice(2)}.${month}`;
  }

  function visibleRecordsSpanAtLeastMonths(records, months) {
    return records.length > 1 && spansAtLeastCalendarMonths(records[0].date, records.at(-1).date, months);
  }

  function formatAxisValue(value) {
    if (value >= 100000000) return `${(value / 100000000).toFixed(value % 100000000 ? 1 : 0)}億`;
    return `${integer.format(Math.round(value / 10000))}万`;
  }

  function compactYen(value) {
    if (value >= 100000000) return `${(value / 100000000).toFixed(2)}億円`;
    return `${(value / 10000).toFixed(value >= 10000000 ? 0 : 1)}万円`;
  }

  function signedYen(value) {
    if (value > 0) return `+${yen.format(value)}`;
    if (value < 0) return `△${yen.format(Math.abs(value))}`;
    return yen.format(0);
  }

  function setTrendClass(element, value) {
    element.classList.toggle("is-positive", value > 0);
    element.classList.toggle("is-negative", value < 0);
  }

  function niceStep(value) {
    const exponent = Math.floor(Math.log10(Math.max(value, 1)));
    const fraction = value / (10 ** exponent);
    const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    return niceFraction * (10 ** exponent);
  }

  function calculateChartScale(values) {
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const rawSpread = Math.max(maxValue - minValue, Math.max(maxValue * 0.025, 100000));
    const step = niceStep(rawSpread / 4);
    const yMin = Math.max(0, Math.floor((minValue - rawSpread * 0.12) / step) * step);
    const yMax = Math.ceil((maxValue + rawSpread * 0.12) / step) * step;
    return { minValue, maxValue, rawSpread, step, yMin, yMax, ySpan: Math.max(yMax - yMin, step) };
  }

  function exposeTestHooks() {
    window.__investmentTestHooks = {
      RANGE_DEFINITIONS,
      availableRangeDefinitions,
      recordsInRange,
      spansAtLeastCalendarMonths,
      subtractCalendarMonths,
      formatDateAxis,
      formatDateLong,
      calculateChartScale
    };
  }

  function debounce(callback, delay) {
    let timer;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => callback(...args), delay);
    };
  }
})();

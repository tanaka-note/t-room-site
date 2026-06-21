(() => {
  const display = document.querySelector("#calcDisplay");
  const expression = document.querySelector("#calcExpression");
  const modeStatus = document.querySelector("#modeStatus");
  const keypad = document.querySelector(".keypad");
  const modePanel = document.querySelector("#modePanel");
  const modeBackdrop = document.querySelector("#modeBackdrop");
  const modeOpen = document.querySelector("#modeOpen");
  const modeClose = document.querySelector("#modeClose");
  const add2Toggle = document.querySelector("#add2Toggle");
  const vibrationToggle = document.querySelector("#vibrationToggle");
  const taxRateInput = document.querySelector("#taxRateInput");

  if (!display || !keypad) return;

  const SETTINGS_KEY = "tRoomCalculatorSettings.v2";
  const MAX_DIGITS = 18;
  const DEFAULT_SETTINGS = {
    decimalMode: "F",
    rounding: "5/4",
    add2: false,
    taxRate: 10,
    vibrate: true,
  };

  const state = {
    input: "0",
    rawDigits: "",
    add2Input: false,
    storedValue: null,
    operator: null,
    waitingForNext: false,
    justEvaluated: false,
    lastOperator: null,
    lastOperand: null,
    memory: 0,
    grandTotal: 0,
    taxCycle: null,
    error: false,
    note: "",
  };

  const settings = loadSettings();
  settings.taxRate = normalizeTaxRate(settings.taxRate);

  render();
  updateModeControls();
  registerServiceWorker();

  keypad.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    pulse(button);

    if (button.dataset.number) {
      inputNumber(button.dataset.number);
      return;
    }

    if (button.dataset.operator) {
      chooseOperator(button.dataset.operator);
      return;
    }

    runAction(button.dataset.action);
  });

  document.addEventListener("keydown", (event) => {
    if (handleKeyboard(event)) event.preventDefault();
  });

  modeOpen?.addEventListener("click", openModePanel);
  modeClose?.addEventListener("click", closeModePanel);
  modeBackdrop?.addEventListener("click", closeModePanel);

  document.querySelectorAll(".mode-segment button").forEach((button) => {
    button.addEventListener("click", () => {
      const group = button.closest(".mode-segment");
      const setting = group?.dataset.setting;
      const value = button.dataset.value;
      if (!setting || !value) return;

      settings[setting] = value;
      saveSettings();
      updateModeControls();
      render();
    });
  });

  add2Toggle?.addEventListener("click", () => {
    settings.add2 = !settings.add2;
    if (state.add2Input) {
      state.rawDigits = "";
      state.add2Input = false;
      state.input = toInputString(parseInput());
    }
    saveSettings();
    updateModeControls();
    render();
  });

  vibrationToggle?.addEventListener("click", () => {
    settings.vibrate = !settings.vibrate;
    saveSettings();
    updateModeControls();
    render();
  });

  taxRateInput?.addEventListener("change", () => {
    settings.taxRate = normalizeTaxRate(taxRateInput.value);
    state.taxCycle = null;
    saveSettings();
    updateModeControls();
    render();
  });

  taxRateInput?.addEventListener("input", () => {
    settings.taxRate = normalizeTaxRate(taxRateInput.value);
    state.taxCycle = null;
    saveSettings();
    render();
  });

  taxRateInput?.addEventListener("blur", () => {
    settings.taxRate = normalizeTaxRate(taxRateInput.value);
    state.taxCycle = null;
    saveSettings();
    updateModeControls();
    render();
  });

  function loadSettings() {
    try {
      return {
        ...DEFAULT_SETTINGS,
        ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"),
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // localStorage is optional; calculation should keep working without it.
    }
  }

  function inputNumber(value) {
    if (state.error) clearAll();

    if (state.waitingForNext || state.justEvaluated) {
      beginNewInput();
      state.waitingForNext = false;
      state.justEvaluated = false;
    }

    appendNumber(value);
    render();
  }

  function appendNumber(value) {
    if (settings.add2 && (state.add2Input || !state.input.includes("."))) {
      appendAdd2Digits(value);
      return;
    }

    const digitCount = state.input.replace("-", "").replace(".", "").length;
    if (digitCount >= MAX_DIGITS) return;

    if (state.input === "0") {
      state.input = value === "00" ? "0" : value;
      return;
    }

    if (state.input === "-0") {
      state.input = value === "00" ? "-0" : `-${value}`;
      return;
    }

    state.input += value;
  }

  function appendAdd2Digits(value) {
    const negative = state.input.startsWith("-");
    const next = `${state.rawDigits}${value}`.replace(/^0+(?=\d)/, "").slice(0, MAX_DIGITS);
    state.rawDigits = next || "0";
    state.add2Input = true;
    state.input = add2Text(state.rawDigits, negative);
  }

  function add2Text(rawDigits, negative = false) {
    const digits = rawDigits || "0";
    const cents = digits.padStart(3, "0");
    const integer = cents.slice(0, -2) || "0";
    const decimal = cents.slice(-2);
    const sign = negative && Number(digits) !== 0 ? "-" : "";
    return `${sign}${Number(integer)}.${decimal}`;
  }

  function inputDecimal() {
    if (state.error) clearAll();

    if (state.waitingForNext || state.justEvaluated) {
      beginNewInput();
      state.waitingForNext = false;
      state.justEvaluated = false;
      state.input = "0.";
      render();
      return;
    }

    if (state.add2Input) {
      state.rawDigits = "";
      state.add2Input = false;
      render();
      return;
    }

    if (!state.input.includes(".")) {
      state.input += ".";
      render();
    }
  }

  function chooseOperator(nextOperator) {
    if (state.error) return;

    const current = parseInput();

    if (state.operator && !state.waitingForNext) {
      const result = calculate(state.storedValue, current, state.operator);
      if (!setResult(result, false)) return;
    } else {
      state.storedValue = current;
    }

    state.operator = nextOperator;
    state.taxCycle = null;
    state.waitingForNext = true;
    state.justEvaluated = false;
    state.lastOperator = null;
    state.lastOperand = null;
    render();
  }

  function runAction(action) {
    if (action === "clear-all") clearAll();
    if (action === "clear-entry") clearEntry();
    if (action === "decimal") inputDecimal();
    if (action === "equals") equals();
    if (action === "percent") percent();
    if (action === "sign") toggleSign();
    if (action === "backspace") backspace();
    if (action === "tax-excluded") taxExcluded();
    if (action === "tax-included") taxIncluded();
    if (action === "hms") showHmsHint();
    if (action === "memory-clear") memoryClear();
    if (action === "memory-recall") memoryRecall();
    if (action === "memory-minus") memorySubtract();
    if (action === "memory-plus") memoryAdd();
  }

  function equals() {
    if (state.error) return;

    const current = parseInput();

    if (state.operator && !state.waitingForNext) {
      const result = calculate(state.storedValue, current, state.operator);
      state.lastOperator = state.operator;
      state.lastOperand = current;
      state.operator = null;
      state.waitingForNext = true;
      state.justEvaluated = true;
      setResult(result, true);
      return;
    }

    if (state.lastOperator && state.lastOperand != null) {
      const result = calculate(current, state.lastOperand, state.lastOperator);
      state.justEvaluated = true;
      setResult(result, true);
    }
  }

  function percent() {
    if (state.error) return;

    const current = parseInput();
    const base = state.storedValue ?? 1;
    const value = state.operator === "+" || state.operator === "-"
      ? preciseMultiply(base, preciseDivide(current, 100))
      : preciseDivide(current, 100);

    setInputFromNumber(value);
    render();
  }

  function toggleSign() {
    if (state.error || state.input === "0") return;
    state.input = state.input.startsWith("-") ? state.input.slice(1) : `-${state.input}`;
    render();
  }

  function backspace() {
    if (state.error || state.waitingForNext || state.justEvaluated) {
      clearEntry();
      return;
    }

    if (state.add2Input) {
      const negative = state.input.startsWith("-");
      state.rawDigits = state.rawDigits.slice(0, -1);
      if (!state.rawDigits) {
        state.add2Input = false;
        state.input = "0";
      } else {
        state.input = add2Text(state.rawDigits, negative);
      }
      render();
      return;
    }

    state.input = state.input.length > 1 ? state.input.slice(0, -1) : "0";
    if (state.input === "-") state.input = "0";
    render();
  }

  function taxIncluded() {
    if (state.error) return;

    if (state.taxCycle?.action === "tax-included") {
      state.taxCycle.mode = state.taxCycle.mode === "total" ? "tax" : "total";
      setInputFromNumber(state.taxCycle.mode === "total" ? state.taxCycle.total : state.taxCycle.tax);
      state.note = state.taxCycle.mode === "total" ? `Tax+ ${formatTaxRate()}%` : `Tax ${formatTaxRate()}%`;
      state.waitingForNext = true;
      render();
      return;
    }

    const base = parseInput();
    const total = normalizeNumber(preciseMultiply(base, 1 + settings.taxRate / 100));
    const tax = normalizeNumber(preciseSubtract(total, base));
    state.taxCycle = { action: "tax-included", mode: "total", base, total, tax };
    setInputFromNumber(total);
    state.note = `Tax+ ${formatTaxRate()}%`;
    state.waitingForNext = true;
    render();
  }

  function taxExcluded() {
    if (state.error) return;

    if (state.taxCycle?.action === "tax-excluded") {
      state.taxCycle.mode = state.taxCycle.mode === "net" ? "tax" : "net";
      setInputFromNumber(state.taxCycle.mode === "net" ? state.taxCycle.net : state.taxCycle.tax);
      state.note = state.taxCycle.mode === "net" ? `Tax- ${formatTaxRate()}%` : `Tax ${formatTaxRate()}%`;
      state.waitingForNext = true;
      render();
      return;
    }

    const total = parseInput();
    const net = normalizeNumber(preciseDivide(total, 1 + settings.taxRate / 100));
    const tax = normalizeNumber(preciseSubtract(total, net));
    state.taxCycle = { action: "tax-excluded", mode: "net", total, net, tax };
    setInputFromNumber(net);
    state.note = `Tax- ${formatTaxRate()}%`;
    state.waitingForNext = true;
    render();
  }

  function showHmsHint() {
    state.note = "H/M/S";
    render();
  }

  function clearEntry() {
    state.input = "0";
    state.rawDigits = "";
    state.add2Input = false;
    state.taxCycle = null;
    state.error = false;
    state.justEvaluated = false;
    state.note = "";
    render();
  }

  function clearAll() {
    state.input = "0";
    state.rawDigits = "";
    state.add2Input = false;
    state.storedValue = null;
    state.operator = null;
    state.waitingForNext = false;
    state.justEvaluated = false;
    state.lastOperator = null;
    state.lastOperand = null;
    state.taxCycle = null;
    state.error = false;
    state.note = "";
    render();
  }

  function memoryClear() {
    state.memory = 0;
    render();
  }

  function memoryRecall() {
    if (state.error) clearAll();
    setInputFromNumber(state.memory);
    state.waitingForNext = false;
    state.justEvaluated = false;
    render();
  }

  function memoryAdd() {
    if (state.error) return;
    state.memory = normalizeNumber(preciseAdd(state.memory, parseInput()));
    state.waitingForNext = true;
    render();
  }

  function memorySubtract() {
    if (state.error) return;
    state.memory = normalizeNumber(preciseSubtract(state.memory, parseInput()));
    state.waitingForNext = true;
    render();
  }

  function beginNewInput() {
    state.input = "0";
    state.rawDigits = "";
    state.add2Input = false;
    state.taxCycle = null;
    state.note = "";
  }

  function parseInput() {
    return Number(state.input);
  }

  function setResult(value, addToGrandTotal) {
    if (!Number.isFinite(value)) {
      showError();
      return false;
    }

    const rounded = applyMode(value);
    state.input = toInputString(rounded);
    state.rawDigits = "";
    state.add2Input = false;
    state.storedValue = rounded;
    state.error = false;
    if (addToGrandTotal) state.grandTotal = normalizeNumber(preciseAdd(state.grandTotal, rounded));
    render();
    return true;
  }

  function setInputFromNumber(value) {
    if (!Number.isFinite(value)) {
      showError();
      return;
    }
    state.input = toInputString(applyMode(value));
    state.rawDigits = "";
    state.add2Input = false;
    state.error = false;
  }

  function showError() {
    state.input = "Error";
    state.error = true;
    state.rawDigits = "";
    state.add2Input = false;
    state.storedValue = null;
    state.operator = null;
    state.waitingForNext = true;
    render();
  }

  function calculate(left, right, operator) {
    if (operator === "+") return normalizeNumber(preciseAdd(left, right));
    if (operator === "-") return normalizeNumber(preciseSubtract(left, right));
    if (operator === "*") return normalizeNumber(preciseMultiply(left, right));
    if (operator === "/") return right === 0 ? Number.NaN : normalizeNumber(preciseDivide(left, right));
    return right;
  }

  function preciseAdd(left, right) {
    const scale = commonScale(left, right);
    return (Math.round(left * scale) + Math.round(right * scale)) / scale;
  }

  function preciseSubtract(left, right) {
    const scale = commonScale(left, right);
    return (Math.round(left * scale) - Math.round(right * scale)) / scale;
  }

  function preciseMultiply(left, right) {
    const leftDigits = decimalLength(left);
    const rightDigits = decimalLength(right);
    const leftInt = Math.round(left * 10 ** leftDigits);
    const rightInt = Math.round(right * 10 ** rightDigits);
    return (leftInt * rightInt) / 10 ** (leftDigits + rightDigits);
  }

  function preciseDivide(left, right) {
    return left / right;
  }

  function commonScale(left, right) {
    return 10 ** Math.min(10, Math.max(decimalLength(left), decimalLength(right)));
  }

  function decimalLength(value) {
    const text = String(value);
    if (text.includes("e-")) return Number(text.split("e-")[1]) || 0;
    const decimal = text.split(".")[1];
    return decimal ? decimal.length : 0;
  }

  function normalizeNumber(value) {
    if (!Number.isFinite(value)) return value;
    return Number.parseFloat(value.toPrecision(14));
  }

  function applyMode(value) {
    if (settings.decimalMode === "F") return normalizeNumber(value);

    const digits = Number(settings.decimalMode);
    const factor = 10 ** digits;
    const sign = Math.sign(value) || 1;
    const absolute = Math.abs(value);
    let rounded;

    if (settings.rounding === "CUT") {
      rounded = Math.trunc(absolute * factor) / factor;
    } else if (settings.rounding === "UP") {
      rounded = Math.ceil((absolute - Number.EPSILON) * factor) / factor;
    } else {
      rounded = Math.round((absolute + Number.EPSILON) * factor) / factor;
    }

    return normalizeNumber(rounded * sign);
  }

  function toInputString(value) {
    if (settings.decimalMode !== "F") return Number(value).toFixed(Number(settings.decimalMode));
    return String(value);
  }

  function formatDisplay(value) {
    if (state.error) return "Error";

    const text = String(value);
    const negative = text.startsWith("-");
    const clean = negative ? text.slice(1) : text;
    const [integer = "0", decimal] = clean.split(".");
    const grouped = groupInteger(integer || "0");
    const sign = negative ? "-" : "";

    if (text.endsWith(".")) return `${sign}${grouped}.`;
    if (decimal != null) return `${sign}${grouped}.${decimal}`;
    return `${sign}${grouped}`;
  }

  function groupInteger(value) {
    const trimmed = String(value).replace(/^0+(?=\d)/, "") || "0";
    return trimmed.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function render() {
    const displayText = formatDisplay(state.input);
    display.textContent = displayText;
    updateDisplaySize(displayText);
    display.classList.toggle("is-error", state.error);
    expression.textContent = expressionText();
    modeStatus.textContent = `${settings.decimalMode} / ${settings.rounding} / TAX ${formatTaxRate()}% / ADD2 ${settings.add2 ? "ON" : "OFF"} / VIB ${settings.vibrate ? "ON" : "OFF"}`;
  }

  function updateDisplaySize(text) {
    const digits = String(text).replace(/[^\d]/g, "").length;
    if (digits <= 6) {
      display.dataset.size = "short";
    } else if (digits <= 9) {
      display.dataset.size = "medium";
    } else if (digits <= 12) {
      display.dataset.size = "long";
    } else if (digits <= 15) {
      display.dataset.size = "xlong";
    } else {
      display.dataset.size = "xxlong";
    }
  }

  function expressionText() {
    if (state.error) return "計算できません";
    if (state.note) return state.note;
    if (!state.operator) return "";
    return `${formatDisplay(toInputString(state.storedValue ?? 0))} ${operatorLabel(state.operator)}`;
  }

  function operatorLabel(operator) {
    return { "+": "+", "-": "−", "*": "×", "/": "÷" }[operator] || operator;
  }

  function updateModeControls() {
    document.querySelectorAll(".mode-segment").forEach((group) => {
      const setting = group.dataset.setting;
      group.querySelectorAll("button").forEach((button) => {
        button.classList.toggle("is-active", settings[setting] === button.dataset.value);
      });
    });

    if (add2Toggle) {
      add2Toggle.textContent = settings.add2 ? "ON" : "OFF";
      add2Toggle.classList.toggle("is-active", settings.add2);
      add2Toggle.setAttribute("aria-pressed", String(settings.add2));
    }

    if (vibrationToggle) {
      vibrationToggle.textContent = settings.vibrate ? "ON" : "OFF";
      vibrationToggle.classList.toggle("is-active", settings.vibrate);
      vibrationToggle.setAttribute("aria-pressed", String(settings.vibrate));
    }

    if (taxRateInput) {
      taxRateInput.value = formatTaxRate();
    }
  }

  function normalizeTaxRate(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 10;
    const clamped = Math.min(99.99, Math.max(0, numeric));
    return Number(clamped.toFixed(2));
  }

  function formatTaxRate() {
    return String(settings.taxRate).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  }

  function openModePanel() {
    modePanel.classList.add("is-open");
    modePanel.setAttribute("aria-hidden", "false");
    modeBackdrop.hidden = false;
    modeOpen?.setAttribute("aria-expanded", "true");
  }

  function closeModePanel() {
    modePanel.classList.remove("is-open");
    modePanel.setAttribute("aria-hidden", "true");
    modeBackdrop.hidden = true;
    modeOpen?.setAttribute("aria-expanded", "false");
  }

  function pulse(button) {
    vibrate();
    button.classList.add("is-pressed");
    window.setTimeout(() => button.classList.remove("is-pressed"), 90);
  }

  function vibrate() {
    if (!settings.vibrate || !navigator.vibrate) return;
    try {
      navigator.vibrate(8);
    } catch {
      // Vibration is optional and unsupported browsers should never block input.
    }
  }

  function handleKeyboard(event) {
    const key = event.key;
    const operators = { "+": "+", "-": "-", "*": "*", "/": "/" };

    if (/^\d$/.test(key)) {
      inputNumber(key);
      return true;
    }
    if (key === ".") {
      inputDecimal();
      return true;
    }
    if (key in operators) {
      chooseOperator(operators[key]);
      return true;
    }
    if (key === "Enter" || key === "=") {
      equals();
      return true;
    }
    if (key === "Escape") {
      clearAll();
      return true;
    }
    if (key === "Backspace") {
      backspace();
      return true;
    }
    if (key === "%") {
      percent();
      return true;
    }

    return false;
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;

    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
        // PWA support is a convenience feature; calculation must remain available.
      });
    });
  }
})();

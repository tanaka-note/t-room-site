(() => {
  const BUTTON_SELECTOR = "[data-date-picker-target][data-date-picker-mode]";
  const MIN_YEAR = 1900;
  const MAX_YEAR = 2100;
  const YEARS_PER_PAGE = 12;
  const state = {
    dialog: null,
    target: null,
    opener: null,
    mode: "date",
    view: "date",
    yearPageStart: MIN_YEAR,
    year: null,
    month: null
  };

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function daysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function japanTodayParts() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
  }

  function parseValue(value, mode = "date") {
    const match = String(value || "").match(mode === "month"
      ? /^(\d{4})-(\d{2})$/
      : /^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = mode === "month" ? 1 : Number(match[3]);
    if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12) return null;
    if (day < 1 || day > daysInMonth(year, month)) return null;
    return { year, month, day };
  }

  function formatValue({ year, month, day }, mode = "date") {
    const monthValue = `${year}-${pad2(month)}`;
    return mode === "month" ? monthValue : `${monthValue}-${pad2(day)}`;
  }

  function calendarCells(year, month) {
    const leading = new Date(year, month - 1, 1).getDay();
    const total = daysInMonth(year, month);
    return [
      ...Array.from({ length: leading }, () => null),
      ...Array.from({ length: total }, (_, index) => index + 1)
    ];
  }

  function buildDialog() {
    const dialog = document.createElement("dialog");
    dialog.id = "troom-calendar-dialog";
    dialog.className = "troom-calendar-dialog";
    dialog.setAttribute("aria-labelledby", "troom-calendar-title");
    dialog.innerHTML = `
      <section class="troom-calendar-sheet">
        <header class="troom-calendar-head">
          <button class="troom-calendar-nav" type="button" data-calendar-action="previous" aria-label="前へ">‹</button>
          <button id="troom-calendar-title" class="troom-calendar-title" type="button" data-calendar-action="years" aria-label="年を選択"></button>
          <button class="troom-calendar-nav" type="button" data-calendar-action="next" aria-label="次へ">›</button>
        </header>
        <div class="troom-calendar-weekdays" aria-hidden="true">
          <span>日</span><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span>土</span>
        </div>
        <div class="troom-calendar-grid" role="grid"></div>
      </section>`;
    dialog.addEventListener("click", handleDialogClick);
    dialog.addEventListener("cancel", () => closeCalendar());
    dialog.addEventListener("close", resetCalendar);
    document.body.append(dialog);
    return dialog;
  }

  function ensureDialog() {
    state.dialog ||= document.querySelector("#troom-calendar-dialog") || buildDialog();
    return state.dialog;
  }

  function initialize(root = document) {
    const buttons = [...root.querySelectorAll(BUTTON_SELECTOR)];
    if (!buttons.length) return;
    ensureDialog();
    for (const button of buttons) {
      if (button.dataset.datePickerBound === "true") continue;
      button.dataset.datePickerBound = "true";
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-controls", "troom-calendar-dialog");
      button.addEventListener("click", openFromButton);
    }
  }

  function openFromButton(event) {
    event.preventDefault();
    event.stopPropagation();
    const opener = event.currentTarget;
    const target = document.getElementById(opener.dataset.datePickerTarget);
    if (!target) return;
    const mode = opener.dataset.datePickerMode === "month" ? "month" : "date";
    const selected = parseValue(target.value, mode) || japanTodayParts();
    state.target = target;
    state.opener = opener;
    state.mode = mode;
    state.view = mode;
    state.year = selected.year;
    state.month = selected.month;
    renderCalendar();
    const dialog = ensureDialog();
    if (!dialog.open) dialog.showModal();
    window.setTimeout(() => {
      dialog.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
    }, 0);
  }

  function handleDialogClick(event) {
    if (event.target === state.dialog) {
      closeCalendar();
      return;
    }
    const navigation = event.target.closest("[data-calendar-action]");
    if (navigation) {
      if (navigation.dataset.calendarAction === "years") {
        state.view = "year";
        state.yearPageStart = MIN_YEAR + Math.floor((state.year - MIN_YEAR) / YEARS_PER_PAGE) * YEARS_PER_PAGE;
        renderCalendar();
        focusCalendarOption(String(state.year));
        return;
      }
      changeCalendar(navigation.dataset.calendarAction === "previous" ? -1 : 1);
      return;
    }
    const option = event.target.closest("[data-calendar-value]");
    if (option) selectCalendarValue(option.dataset.calendarValue);
  }

  function changeCalendar(delta) {
    if (state.view === "year") {
      const lastPage = MIN_YEAR + Math.floor((MAX_YEAR - MIN_YEAR) / YEARS_PER_PAGE) * YEARS_PER_PAGE;
      state.yearPageStart = clamp(state.yearPageStart + delta * YEARS_PER_PAGE, MIN_YEAR, lastPage);
    } else if (state.view === "month") {
      state.year = clamp(state.year + delta, MIN_YEAR, MAX_YEAR);
    } else {
      const next = new Date(state.year, state.month - 1 + delta, 1);
      state.year = clamp(next.getFullYear(), MIN_YEAR, MAX_YEAR);
      state.month = next.getFullYear() < MIN_YEAR ? 1 : next.getFullYear() > MAX_YEAR ? 12 : next.getMonth() + 1;
    }
    renderCalendar();
  }

  function renderCalendar() {
    const dialog = ensureDialog();
    const title = dialog.querySelector("#troom-calendar-title");
    const weekdays = dialog.querySelector(".troom-calendar-weekdays");
    const grid = dialog.querySelector(".troom-calendar-grid");
    const selected = parseValue(state.target?.value, state.mode);
    const today = japanTodayParts();
    dialog.dataset.mode = state.view;
    weekdays.hidden = state.view !== "date";
    title.disabled = state.view === "year";
    grid.replaceChildren();

    if (state.view === "year") {
      const lastYear = Math.min(state.yearPageStart + YEARS_PER_PAGE - 1, MAX_YEAR);
      title.textContent = `${state.yearPageStart}年～${lastYear}年`;
      for (let year = state.yearPageStart; year <= lastYear; year += 1) {
        grid.append(createOption({
          value: String(year), text: `${year}年`,
          selected: selected?.year === year, today: today.year === year
        }));
      }
    } else if (state.view === "month") {
      title.textContent = `${state.year}年`;
      for (let month = 1; month <= 12; month += 1) {
        grid.append(createOption({
          value: `${state.year}-${pad2(month)}`,
          text: `${month}月`,
          selected: selected?.year === state.year && selected?.month === month,
          today: today.year === state.year && today.month === month
        }));
      }
    } else {
      title.textContent = `${state.year}年${state.month}月`;
      for (const day of calendarCells(state.year, state.month)) {
        if (day === null) {
          const spacer = document.createElement("span");
          spacer.className = "troom-calendar-spacer";
          grid.append(spacer);
          continue;
        }
        grid.append(createOption({
          value: `${state.year}-${pad2(state.month)}-${pad2(day)}`,
          text: String(day),
          selected: selected?.year === state.year && selected?.month === state.month && selected?.day === day,
          today: today.year === state.year && today.month === state.month && today.day === day
        }));
      }
    }

    title.setAttribute("aria-label", title.textContent + (state.view === "year" ? "" : "、年を選択"));
    const previous = dialog.querySelector('[data-calendar-action="previous"]');
    const next = dialog.querySelector('[data-calendar-action="next"]');
    previous.setAttribute("aria-label", state.view === "year" ? "前の12年" : state.view === "month" ? "前年" : "前月");
    next.setAttribute("aria-label", state.view === "year" ? "次の12年" : state.view === "month" ? "翌年" : "翌月");
    previous.disabled = state.view === "year" ? state.yearPageStart <= MIN_YEAR
      : state.view === "month" ? state.year <= MIN_YEAR : state.year <= MIN_YEAR && state.month <= 1;
    next.disabled = state.view === "year" ? state.yearPageStart + YEARS_PER_PAGE > MAX_YEAR
      : state.view === "month" ? state.year >= MAX_YEAR : state.year >= MAX_YEAR && state.month >= 12;
  }

  function focusCalendarOption(value) {
    const grid = state.dialog.querySelector(".troom-calendar-grid");
    (grid.querySelector(`[data-calendar-value="${value}"]`)
      || grid.querySelector('[aria-selected="true"]') || grid.querySelector("button"))?.focus({ preventScroll: true });
  }

  function createOption({ value, text, selected, today }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "troom-calendar-option";
    button.dataset.calendarValue = value;
    button.textContent = text;
    button.setAttribute("role", "gridcell");
    button.setAttribute("aria-selected", String(Boolean(selected)));
    if (today) button.dataset.today = "true";
    return button;
  }

  function selectCalendarValue(value) {
    const target = state.target;
    if (!target) return;
    if (state.view === "year") {
      const year = Number(value);
      if (!/^\d{4}$/.test(value) || year < MIN_YEAR || year > MAX_YEAR) return;
      state.year = year;
      state.view = "month";
      renderCalendar();
      focusCalendarOption(`${state.year}-${pad2(state.month)}`);
      return;
    }
    if (state.view === "month" && state.mode === "date") {
      const selected = parseValue(value, "month");
      if (!selected) return;
      state.year = selected.year;
      state.month = selected.month;
      state.view = "date";
      renderCalendar();
      focusCalendarOption();
      return;
    }
    if (!target || !parseValue(value, state.mode)) return;
    if (target.value !== value) {
      target.value = value;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }
    closeCalendar();
  }

  function closeCalendar() {
    if (state.dialog?.open) state.dialog.close();
  }

  function resetCalendar() {
    const opener = state.opener;
    state.target = null;
    state.opener = null;
    state.mode = "date";
    state.view = "date";
    state.yearPageStart = MIN_YEAR;
    state.year = null;
    state.month = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  window.TRoomDatePicker = Object.freeze({ initialize, parseValue, formatValue, calendarCells });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => initialize());
  else initialize();
})();

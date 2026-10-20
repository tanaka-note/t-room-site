// Diary's bottom wheel interaction, supporting payment dates and start months.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const range = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => start + index);
  const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
  let navigation, blocked, target = null, draft = null, mode = 'date';
  const timers = {};

  function updateValue() {
    $('date-wheel-value').textContent = `${draft.year}年${draft.month}月${mode === 'date' ? `${draft.day}日` : ''}`;
  }

  function fill(column, values, selected, suffix) {
    clearTimeout(timers[column.id]);
    delete column.dataset.clickScrollTarget;
    const token = String((Number(column.dataset.scrollToken) || 0) + 1);
    column.dataset.scrollToken = token;
    column.dataset.settingScroll = 'true';
    column.replaceChildren(...values.map((value, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'date-wheel-option';
      button.dataset.value = String(value); button.dataset.index = String(index);
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(value === selected));
      button.textContent = `${value}${suffix}`;
      return button;
    }));
    requestAnimationFrame(() => {
      if (column.dataset.scrollToken !== token) return;
      column.scrollTo({ top: Math.max(0, values.indexOf(selected)) * 44, behavior: 'instant' });
      setTimeout(() => {
        if (column.dataset.scrollToken === token) delete column.dataset.settingScroll;
      }, 160);
    });
  }

  function renderDays() {
    draft.day = clamp(draft.day, 1, daysInMonth(draft.year, draft.month));
    if (mode === 'date') fill($('date-wheel-day'), range(1, daysInMonth(draft.year, draft.month)), draft.day, '日');
  }

  function select(column, key, option) {
    if (!draft || !option) return;
    const value = Number(option.dataset.value);
    if (draft[key] === value) return;
    draft[key] = value;
    column.querySelectorAll('.date-wheel-option').forEach(item => item.setAttribute('aria-selected', String(item === option)));
    if (key !== 'day') renderDays();
    updateValue();
  }

  function syncScroll(column, key) {
    const options = column.querySelectorAll('.date-wheel-option');
    select(column, key, options[clamp(Math.round(column.scrollTop / 44), 0, options.length - 1)]);
  }

  function bindColumn(column, key) {
    column.addEventListener('click', event => {
      const option = event.target.closest('.date-wheel-option');
      if (!option) return;
      select(column, key, option);
      const top = Number(option.dataset.index) * 44;
      column.dataset.clickScrollTarget = String(top);
      column.scrollTo({ top, behavior: 'smooth' });
    });
    column.addEventListener('pointerdown', () => { delete column.dataset.clickScrollTarget; });
    column.addEventListener('wheel', event => {
      if (!event.deltaY) return;
      event.preventDefault();
      delete column.dataset.clickScrollTarget;
      const count = column.children.length;
      const index = clamp(Math.round(column.scrollTop / 44) + Math.sign(event.deltaY), 0, count - 1);
      column.scrollTo({ top: index * 44, behavior: 'instant' });
      syncScroll(column, key);
    }, { passive: false });
    column.addEventListener('scroll', () => {
      if (column.dataset.settingScroll === 'true') return;
      if (column.dataset.clickScrollTarget !== undefined) {
        if (Math.abs(column.scrollTop - Number(column.dataset.clickScrollTarget)) > 1) return;
        delete column.dataset.clickScrollTarget;
      }
      clearTimeout(timers[column.id]);
      timers[column.id] = setTimeout(() => syncScroll(column, key), 80);
    }, { passive: true });
  }

  function open(input) {
    if (blocked() || $('date-wheel-dialog').open) return;
    target = input; mode = input.dataset.dateWheelMode;
    draft = TRoomDatePicker.parseValue(input.value, mode);
    if (!draft) { target = null; return; }
    $('date-wheel-title').textContent = mode === 'month' ? '対象開始月を選択' : '日付を選択';
    $('date-wheel-dialog').querySelector('.date-wheel-window').dataset.mode = mode;
    $('date-wheel-day').parentElement.hidden = mode === 'month';
    // Retain the ledger's existing accepted year range, including saved future entries.
    fill($('date-wheel-year'), range(1900, 9999), draft.year, '年');
    fill($('date-wheel-month'), range(1, 12), draft.month, '月');
    renderDays(); updateValue(); navigation.open('date-wheel-dialog');
  }

  function apply() {
    if (!target || !draft || blocked()) return;
    // Flush a pending touch scroll before committing the visible selection.
    for (const key of ['year', 'month', ...(mode === 'date' ? ['day'] : [])]) {
      const column = $(`date-wheel-${key}`);
      if (column.dataset.settingScroll !== 'true' && column.dataset.clickScrollTarget === undefined) syncScroll(column, key);
    }
    const value = TRoomDatePicker.formatValue(draft, mode);
    if (target.value !== value) {
      target.value = value;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
    navigation.close('date-wheel-dialog');
  }

  function initialize(dialogs, isBlocked) {
    navigation = dialogs; blocked = isBlocked;
    navigation.register('date-wheel-dialog', {
      blocked, backdrop: apply,
      onClose: () => {
        Object.values(timers).forEach(clearTimeout);
        target = null; draft = null;
      }
    });
    for (const key of ['year', 'month', 'day']) bindColumn($(`date-wheel-${key}`), key);
    for (const input of document.querySelectorAll('[data-date-wheel-mode]')) {
      input.addEventListener('click', event => { event.preventDefault(); open(input); });
      input.addEventListener('keydown', event => {
        if (event.key === 'Tab') return;
        event.preventDefault();
        if (['Enter', ' '].includes(event.key)) open(input);
      });
    }
    $('date-wheel-cancel').onclick = () => navigation.close('date-wheel-dialog');
    $('date-wheel-done').onclick = apply;
  }

  window.TRoomDateWheel = Object.freeze({ initialize });
})();

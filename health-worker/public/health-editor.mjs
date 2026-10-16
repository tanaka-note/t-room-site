import { CONDITIONS, SYMPTOMS, emptyRecord, periods, normalizeRecord, normalizeSettings, today, toCsv } from './health-domain.mjs';
import { $, dateFormat, element } from './health-format.mjs';

export function createEditor(state, repository, nav) {
  let selected = null, original = '', expectedRevision = 0, originalSymptoms = [];
  for (const symptom of SYMPTOMS) {
    const label = element('label');
    const input = element('input'); input.type = 'checkbox'; input.value = symptom.id;
    label.append(input, document.createTextNode(symptom.label)); $('symptoms').append(label);
  }
  for (const condition of CONDITIONS) {
    const button = element('button', condition.label);
    button.type = 'button'; button.dataset.condition = condition.id; button.setAttribute('aria-pressed', 'false');
    button.onclick = () => {
      const wasSelected = button.getAttribute('aria-pressed') === 'true';
      $('conditions').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button && !wasSelected)));
    };
    $('conditions').append(button);
  }
  for (const id of ['start-period', 'end-period']) $(id).onclick = () => $(id).setAttribute('aria-pressed', String($(id).getAttribute('aria-pressed') !== 'true'));
  function formValue() {
    return { schemaVersion: 2, date: selected,
      condition: $('conditions').querySelector('[aria-pressed="true"]')?.dataset.condition || null,
      start: $('start-period').getAttribute('aria-pressed') === 'true',
      end: $('end-period').getAttribute('aria-pressed') === 'true',
      symptoms: [...$('symptoms').querySelectorAll('input:checked')].map(input => ({
        id: input.value, intensity: originalSymptoms.find(item => item.id === input.value)?.intensity || null,
      })),
      flow: $('flow').value || null, note: $('note').value };
  }
  function settingsValue() { return { kind: 'settings', cycleDays: $('cycle-days').value ? Number($('cycle-days').value) : null, lastStart: $('last-start').value || null }; }
  function dirty() {
    return $('editor').open && JSON.stringify(formValue()) !== original
      || $('settings').open && JSON.stringify(settingsValue()) !== original;
  }
  function edit(date, { end = false } = {}) {
    if (state.ui.busy || !state.auth.session) return;
    const record = state.data.records.find(row => row.date === date) || emptyRecord(date);
    selected = date; expectedRevision = repository.revision(date); originalSymptoms = record.symptoms;
    $('record-date').textContent = dateFormat.format(new Date(`${date}T00:00:00Z`));
    $('editor-error').textContent = '';
    $('conditions').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.condition === record.condition)));
    $('start-period').setAttribute('aria-pressed', String(record.start));
    $('end-period').setAttribute('aria-pressed', String(record.end));
    $('symptoms').querySelectorAll('input').forEach(input => { input.checked = record.symptoms.some(item => item.id === input.value); });
    $('flow').value = record.flow || ''; $('note').value = record.note; $('note').defaultValue = record.note;
    $('delete').hidden = expectedRevision === 0;
    const missingEnd = record.start && !periods(state.data.records).find(span => span.start === date)?.end;
    $('period-status').textContent = missingEnd ? '終了未記録です。終了日は自動補完しません。' : '';
    $('period-details').open = Boolean(end || record.start || record.end || record.flow);
    original = JSON.stringify(formValue());
    if (end) $('end-period').setAttribute('aria-pressed', 'true');
    nav.open('editor');
  }
  async function closeSaved(id) { state.ui.busy = false; await nav.close(id, { force: true }); }
  async function saveRecord(generation) {
    const record = normalizeRecord(formValue());
    const next = state.data.records.filter(row => row.date !== record.date).concat(record);
    periods(next);
    await repository.store(record.date, record, expectedRevision, generation);
    state.check(generation);
    state.data.records = next; original = JSON.stringify(formValue());
    await closeSaved('editor');
  }
  async function deleteRecord(generation) {
    const next = state.data.records.filter(record => record.date !== selected);
    periods(next);
    await repository.remove(selected, expectedRevision, generation);
    state.check(generation); state.data.records = next;
    await closeSaved('editor');
  }
  function openSettings() {
    expectedRevision = repository.revision('settings');
    $('cycle-days').value = state.data.settings.cycleDays || '';
    $('last-start').value = state.data.settings.lastStart || '';
    $('settings-error').textContent = ''; original = JSON.stringify(settingsValue()); nav.open('settings');
  }
  async function saveSettings(generation) {
    const value = { kind: 'settings', ...normalizeSettings(settingsValue()) };
    await repository.store('settings', value, expectedRevision, generation);
    state.check(generation); state.data.settings = value; original = JSON.stringify(value);
    await closeSaved('settings');
  }
  function openExport() {
    $('export-from').value = state.data.records.map(record => record.date).sort()[0] || today();
    $('export-to').value = today(); $('export-error').textContent = ''; nav.open('export');
  }
  async function exportRecords() {
    const content = toCsv(state.data.records, $('export-from').value, $('export-to').value);
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const anchor = element('a'); anchor.href = url; anchor.download = '体調管理.csv'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); await closeSaved('export');
  }
  function reset() {
    selected = null; original = ''; expectedRevision = 0; originalSymptoms = [];
    for (const id of ['note', 'flow', 'cycle-days', 'last-start', 'export-from', 'export-to']) $(id).value = '';
    $('note').defaultValue = '';
    $('symptoms').querySelectorAll('input').forEach(input => { input.checked = false; });
    $('conditions').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', 'false'));
    $('period-details').open = false;
    for (const id of ['start-period', 'end-period']) $(id).setAttribute('aria-pressed', 'false');
    for (const id of ['record-date', 'period-status', 'editor-error', 'settings-error', 'export-error']) $(id).textContent = '';
  }
  return { edit, dirty, saveRecord, deleteRecord, openSettings, saveSettings, openExport, exportRecords, reset };
}

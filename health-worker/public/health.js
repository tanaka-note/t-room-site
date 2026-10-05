import { SYMPTOMS, today, validDate, normalizeRecord, periods, predict, toCsv } from './health-domain.mjs';
import { unlockClient, unwrapMaster, recordId, encryptRecord, decryptRecord } from './health-crypto.mjs';

const $ = id => document.getElementById(id);
const state = {
  master: null,
  session: null,
  records: [],
  settings: {},
  selected: null,
  original: '',
  busy: false,
  generation: 0,
  month: today().slice(0, 7),
};
let expiryTimer;
const nav = TroomDialogNavigation.create({ key: 'health-dialogs' });
const recordDateFormat = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', timeZone: 'UTC' });

// Async work belongs to the current unlocked view. A lock invalidates every result.
function checkCurrent(generation) {
  if (generation !== state.generation) throw new Error('画面を離れたため処理を中止しました。');
}

async function api(path, options = {}, generation = state.generation) {
  checkCurrent(generation);
  const response = await fetch(`/health/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.session ? { 'X-Health-Session': state.session } : {}),
      ...options.headers,
    },
  });
  const value = await response.json();
  checkCurrent(generation);
  if (!response.ok) {
    const message = value.error || '処理を完了できませんでした。';
    if ([401, 403, 409].includes(response.status) && state.session) {
      lock();
      $('message').textContent = message;
    }
    throw new Error(message);
  }
  return value;
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('button, input, select, textarea').forEach(control => { control.disabled = busy; });
}

async function task(fn, errorId = 'message') {
  if (state.busy) return;
  const generation = state.generation;
  setBusy(true);
  $(errorId).textContent = '';
  try {
    await fn(generation);
  } catch (error) {
    if (generation === state.generation) $(errorId).textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function load(generation) {
  const response = await api('/records', {}, generation);
  const records = [];
  let settings = {};
  for (const row of response.records) {
    const value = await decryptRecord(state.master, row.id, row);
    checkCurrent(generation);
    if (value.kind === 'settings') {
      if (row.id !== await recordId(state.master, 'settings')) throw new Error('設定の暗号化識別子が一致しません。');
      settings = value;
    } else {
      const record = normalizeRecord(value);
      if (row.id !== await recordId(state.master, record.date)) throw new Error('記録の暗号化識別子が一致しません。');
      records.push(record);
    }
  }
  checkCurrent(generation);
  periods(records);
  state.records = records;
  state.settings = settings;
  render();
}

async function store(id, value, generation) {
  checkCurrent(generation);
  const encrypted = await encryptRecord(state.master, id, value);
  await api(`/records/${id}`, { method: 'PUT', body: JSON.stringify(encrypted) }, generation);
}

async function signIn(generation) {
  const auth = await TRoomPasskeys.authenticate('health');
  try {
    checkCurrent(generation);
    if (!auth.prfOutput) throw new Error('この環境ではパスキーによる暗号鍵の解除を利用できません。平文での保存は行いません。');
    const result = await api('/passkey/handoff', {
      method: 'POST',
      body: JSON.stringify({ handoffToken: auth.handoff.handoffToken }),
    }, generation);
    const key = await unlockClient(auth.prfOutput, result.keyBundle.vault);
    checkCurrent(generation);
    const master = await unwrapMaster(key, result.keyBundle.wrappedKey);
    if (generation !== state.generation) {
      master.fill(0);
      checkCurrent(generation);
    }
    state.master?.fill(0);
    state.master = master;
    state.session = result.sessionId;
    await load(generation);
    checkCurrent(generation);
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(lock, Math.max(0, result.expiresAt * 1000 - Date.now()));
    $('login').hidden = true;
    $('app').hidden = false;
  } catch (error) {
    if (generation === state.generation) {
      lock();
      $('message').textContent = error.message;
    }
    throw error;
  } finally {
    auth.prfOutput?.fill(0);
  }
}

// Rendering keeps daily health separate from the smaller cycle context.
function shortDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return `${year === Number(today().slice(0, 4)) ? '' : `${year}/`}${month}/${day}`;
}

function healthText(record) {
  return [...record.symptoms.map(index => SYMPTOMS[index]), record.note.trim()].filter(Boolean).join(' / ');
}

function renderToday() {
  const date = today();
  const record = state.records.find(row => row.date === date);
  $('today-date').textContent = recordDateFormat.format(new Date(`${date}T00:00:00Z`));
  const text = record && healthText(record);
  $('today-status').textContent = text
    ? text.length > 100 ? `${text.slice(0, 100)}…` : text
    : record ? '記録済み（体調・備考は未入力）' : 'まだ記録はありません。';
  $('record-today').textContent = record ? '今日の記録を編集' : '今日の体調を記録';
}

function renderCycle(prediction, spans) {
  const latest = spans.at(-1);
  const lastStart = latest?.start || (validDate(state.settings.lastStart) ? state.settings.lastStart : null);
  $('prediction-window').textContent = prediction.date ? `${shortDate(prediction.from)} 〜 ${shortDate(prediction.to)}` : '開始日を記録すると表示';
  $('last-period-start').textContent = lastStart ? shortDate(lastStart) : '未記録';
  $('prediction').textContent = prediction.date || '開始日を記録すると表示します';
  $('prediction-range').textContent = prediction.date
    ? `${prediction.from} 〜 ${prediction.to}（${prediction.personalized ? '実績から予測' : '仮予測'}）${today() > prediction.to ? ' — 予測期間を過ぎています' : ''}`
    : '';
  $('latest-cycle').textContent = prediction.latestCycle ? `${prediction.latestCycle}日` : '記録不足';
  const missingEnd = Boolean(latest && !latest.end);
  $('period-reminder').hidden = !missingEnd;
  $('period-reminder-message').textContent = missingEnd ? `${shortDate(latest.start)} 開始・終了未記録` : '';
}

function renderCalendar(prediction, spans) {
  $('month').textContent = `${state.month.slice(0, 4)}年${Number(state.month.slice(5))}月`;
  const calendar = $('calendar');
  calendar.replaceChildren();
  for (const name of ['日', '月', '火', '水', '木', '金', '土']) {
    const weekday = document.createElement('div');
    weekday.className = 'weekday';
    weekday.textContent = name;
    calendar.append(weekday);
  }
  const first = new Date(`${state.month}-01T00:00:00Z`);
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  for (let index = 0; index < first.getUTCDay(); index++) calendar.append(document.createElement('div'));
  for (let day = 1; day <= count; day++) {
    const date = `${state.month}-${String(day).padStart(2, '0')}`;
    const record = state.records.find(row => row.date === date);
    const button = document.createElement('button');
    button.className = 'day';
    const labels = [date, record ? '記録あり' : '', record?.start ? '生理開始' : '', record?.end ? '生理終了' : ''];
    if (record?.start && !spans.find(span => span.start === date)?.end) labels.push('終了未記録');
    button.setAttribute('aria-label', labels.filter(Boolean).join(' '));
    button.textContent = day;
    if (date === today()) button.classList.add('current');
    if (spans.some(span => span.end && date >= span.start && date <= span.end)) button.classList.add('period');
    if (prediction.date && date >= prediction.from && date <= prediction.to) button.classList.add('predicted');
    if (record) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '●';
      button.append(dot);
    }
    if (record?.start || record?.end) {
      const label = document.createElement('small');
      label.textContent = record.start && record.end ? '開始\n終了' : record.start ? '開始' : '終了';
      button.append(label);
    }
    button.onclick = () => edit(date);
    calendar.append(button);
  }
}

function renderRecords() {
  const list = $('records');
  list.replaceChildren();
  for (const record of [...state.records].sort((a, b) => b.date.localeCompare(a.date))) {
    const button = document.createElement('button');
    button.className = 'entry';
    const heading = document.createElement('span');
    heading.className = 'entry-heading';
    const date = document.createElement('strong');
    date.textContent = record.date;
    const meta = document.createElement('span');
    meta.className = 'entry-meta';
    meta.textContent = [record.start ? '生理開始' : '', record.end ? '生理終了' : '', record.flow ? `経血量：${record.flow}` : ''].filter(Boolean).join(' / ');
    heading.append(date, meta);
    const text = document.createElement('span');
    text.className = 'entry-content';
    text.textContent = [...record.symptoms.map(index => SYMPTOMS[index]), record.note].filter(Boolean).join('\n') || '体調・備考は未入力';
    button.append(heading, text);
    button.onclick = () => edit(record.date);
    list.append(button);
  }
  if (!state.records.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-records';
    empty.textContent = '記録はまだありません。今日の体調や、カレンダーの日付から記録できます。';
    list.append(empty);
  }
}

function render() {
  const prediction = predict(state.records, state.settings);
  const spans = periods(state.records);
  renderToday();
  renderCycle(prediction, spans);
  renderCalendar(prediction, spans);
  renderRecords();
  if (state.busy) setBusy(true);
}

// Form state is kept only in memory; opening optional sections never makes it dirty.
function formValue() {
  return {
    date: state.selected,
    start: $('start-period').getAttribute('aria-pressed') === 'true',
    end: $('end-period').getAttribute('aria-pressed') === 'true',
    symptoms: [...document.querySelectorAll('#symptoms input:checked')].map(input => Number(input.value)),
    flow: $('flow').value || null,
    note: $('note').value,
  };
}

function settingsValue() {
  return { kind: 'settings', cycleDays: $('cycle-days').value ? Number($('cycle-days').value) : null, lastStart: $('last-start').value || null };
}

function dirty() {
  return $('editor').open && JSON.stringify(formValue()) !== state.original
    || $('settings').open && JSON.stringify(settingsValue()) !== state.original;
}

function edit(date, { end = false } = {}) {
  if (state.busy || !state.session) return;
  const record = state.records.find(row => row.date === date) || { date, start: false, end: false, symptoms: [], flow: null, note: '' };
  state.selected = date;
  $('record-date').textContent = recordDateFormat.format(new Date(`${date}T00:00:00Z`));
  $('editor-error').textContent = '';
  $('start-period').setAttribute('aria-pressed', String(record.start));
  $('end-period').setAttribute('aria-pressed', String(record.end));
  document.querySelectorAll('#symptoms input').forEach(input => { input.checked = record.symptoms.includes(Number(input.value)); });
  $('flow').value = record.flow || '';
  $('note').value = record.note;
  $('note').defaultValue = record.note;
  $('delete').hidden = !state.records.some(row => row.date === date);
  const missingEnd = record.start && !periods(state.records).find(span => span.start === date)?.end;
  $('period-status').textContent = missingEnd ? '終了未記録です。終了日は自動補完しません。' : '';
  $('period-details').open = Boolean(end || record.start || record.end || record.flow);
  state.original = JSON.stringify(formValue());
  if (end) $('end-period').setAttribute('aria-pressed', 'true');
  nav.open('editor');
}

async function closeSavedForm(id) {
  state.busy = false;
  await nav.close(id, { force: true });
}

async function saveRecord(generation) {
  const record = normalizeRecord(formValue());
  if (record.date > today()) throw new Error('未来の日付を実績として保存することはできません。');
  const next = state.records.filter(row => row.date !== record.date).concat(record);
  periods(next);
  await store(await recordId(state.master, record.date), record, generation);
  checkCurrent(generation);
  state.records = next;
  state.original = JSON.stringify(formValue());
  render();
  await closeSavedForm('editor');
}

async function deleteRecord(generation) {
  const next = state.records.filter(record => record.date !== state.selected);
  periods(next);
  await api(`/records/${await recordId(state.master, state.selected)}`, { method: 'DELETE', body: '{}' }, generation);
  checkCurrent(generation);
  state.records = next;
  render();
  await closeSavedForm('editor');
}

function openSettings() {
  $('cycle-days').value = state.settings.cycleDays || '';
  $('last-start').value = state.settings.lastStart || '';
  $('settings-error').textContent = '';
  state.original = JSON.stringify(settingsValue());
  nav.open('settings');
}

async function saveSettings(generation) {
  const value = settingsValue();
  if (value.cycleDays != null && (!Number.isInteger(value.cycleDays) || value.cycleDays < 1 || value.cycleDays > 180)
    || value.lastStart && (!validDate(value.lastStart) || value.lastStart > today())) {
    throw new Error('周期日数・開始日を確認してください。');
  }
  await store(await recordId(state.master, 'settings'), value, generation);
  checkCurrent(generation);
  state.settings = value;
  state.original = JSON.stringify(value);
  render();
  await closeSavedForm('settings');
}

function openExport() {
  $('export-from').value = [...state.records].map(record => record.date).sort()[0] || today();
  $('export-to').value = today();
  $('export-error').textContent = '';
  nav.open('export');
}

async function exportRecords() {
  const content = toCsv(state.records, $('export-from').value, $('export-to').value);
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '体調管理.csv';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  await closeSavedForm('export');
}

function moveMonth(delta) {
  const date = new Date(`${state.month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  state.month = date.toISOString().slice(0, 7);
  render();
}

function showTab(name) {
  for (const tab of ['calendar', 'list']) {
    $(`${tab}-panel`).hidden = tab !== name;
    $(`${tab}-tab`).setAttribute('aria-pressed', String(tab === name));
  }
}

function lock() {
  state.generation++;
  clearTimeout(expiryTimer);
  state.master?.fill(0);
  state.master = null;
  state.session = null;
  state.records = [];
  state.settings = {};
  state.original = '';
  state.selected = null;
  nav.reset();
  $('app').hidden = true;
  $('login').hidden = false;
  $('records').replaceChildren();
  $('calendar').replaceChildren();
  for (const id of ['note', 'flow', 'cycle-days', 'last-start', 'export-from', 'export-to']) $(id).value = '';
  $('note').defaultValue = '';
  document.querySelectorAll('#symptoms input').forEach(input => { input.checked = false; });
  for (const id of ['today-date', 'today-status', 'prediction-window', 'last-period-start', 'period-reminder-message', 'prediction', 'prediction-range', 'latest-cycle', 'record-date', 'period-status']) $(id).textContent = '';
  $('period-reminder').hidden = true;
  $('cycle-details').open = false;
  $('period-details').open = false;
  $('start-period').setAttribute('aria-pressed', 'false');
  $('end-period').setAttribute('aria-pressed', 'false');
  $('record-today').textContent = '今日の体調を記録';
}

async function logout(generation) {
  try {
    await api('/logout', { method: 'POST', body: '{}' }, generation);
  } finally {
    if (generation === state.generation) lock();
  }
}

// Event bindings are defined once, after the view and form functions.
for (const id of ['editor', 'settings', 'export']) {
  nav.register(id, { guard: () => !state.busy && (!dirty() || confirm('入力を破棄しますか？')), blocked: () => state.busy });
  $(`${id}-close`).onclick = () => nav.close(id);
}
for (const [index, name] of SYMPTOMS.entries()) {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.value = index;
  label.append(input, document.createTextNode(name));
  $('symptoms').append(label);
}
for (const id of ['start-period', 'end-period']) {
  $(id).onclick = () => $(id).setAttribute('aria-pressed', String($(id).getAttribute('aria-pressed') !== 'true'));
}
$('sign-in').onclick = () => task(signIn);
$('record-today').onclick = () => edit(today());
$('record-end').onclick = () => edit(today(), { end: true });
$('record-form').onsubmit = event => { event.preventDefault(); task(saveRecord, 'editor-error'); };
$('delete').onclick = () => {
  if (confirm('この日の記録を削除しますか？削除した内容は復元できません。')) task(deleteRecord, 'editor-error');
};
$('settings-open').onclick = openSettings;
$('settings-form').onsubmit = event => { event.preventDefault(); task(saveSettings, 'settings-error'); };
$('export-open').onclick = openExport;
$('export-form').onsubmit = event => { event.preventDefault(); task(exportRecords, 'export-error'); };
$('refresh').onclick = () => task(load);
$('logout').onclick = () => task(logout);
$('previous').onclick = () => moveMonth(-1);
$('next').onclick = () => moveMonth(1);
$('today').onclick = () => { state.month = today().slice(0, 7); render(); };
for (const name of ['calendar', 'list']) $(`${name}-tab`).onclick = () => showTab(name);
window.addEventListener('pagehide', lock);
window.addEventListener('beforeunload', event => {
  if (dirty() || state.busy) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('troom:before-auto-update', event => {
  if (dirty() || state.busy || $('export').open) event.preventDefault();
});

import { SYMPTOMS, today, validDate, normalizeRecord, periods, predict, toCsv } from './health-domain.mjs';
import { unlockClient, unwrapMaster, recordId, encryptRecord, decryptRecord } from './health-crypto.mjs';
const $ = id => document.getElementById(id);
const state = { master: null, session: null, records: [], settings: {}, selected: null, original: '', busy: false, month: today().slice(0, 7) };
let expiryTimer;
const nav = TroomDialogNavigation.create({ key: 'health-dialogs' });
function formValue() { return { date: state.selected, start: $('start-period').getAttribute('aria-pressed') === 'true', end: $('end-period').getAttribute('aria-pressed') === 'true', symptoms: [...document.querySelectorAll('#symptoms input:checked')].map(c => Number(c.value)), flow: $('flow').value || null, note: $('note').value }; }
function dirty() { return $('editor').open && JSON.stringify(formValue()) !== state.original || $('settings').open && JSON.stringify(settingsValue()) !== state.original; }
for (const id of ['editor', 'settings', 'export']) nav.register(id, { guard: () => !state.busy && (!dirty() || confirm('入力を破棄しますか？')), blocked: () => state.busy });
async function api(path, options = {}) {
  const r = await fetch(`/health/api${path}`, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(state.session ? { 'X-Health-Session': state.session } : {}), ...options.headers } });
  const v = await r.json(); if (!r.ok && [401, 403, 409].includes(r.status) && state.session) lock(); if (!r.ok) throw new Error(v.error || '処理を完了できませんでした。'); return v;
}
async function task(fn, errorId = 'message') {
  if (state.busy) return; state.busy = true; $(errorId).textContent = '';
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  try { await fn(); } catch (e) { $(errorId).textContent = e.message; }
  finally { state.busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); }
}
async function load() {
  const response = await api('/records'); const records = []; let settings = {};
  for (const row of response.records) {
    const v = await decryptRecord(state.master, row.id, row);
    if (v.kind === 'settings') { if (row.id !== await recordId(state.master, 'settings')) throw new Error('設定の暗号化識別子が一致しません。'); settings = v; }
    else { const record = normalizeRecord(v); if (row.id !== await recordId(state.master, record.date)) throw new Error('記録の暗号化識別子が一致しません。'); records.push(record); }
  }
  periods(records); state.records = records; state.settings = settings; render();
}
async function store(id, value) { const encrypted = await encryptRecord(state.master, id, value); await api(`/records/${id}`, { method: 'PUT', body: JSON.stringify(encrypted) }); }
$('sign-in').onclick = () => task(async () => {
  const auth = await TRoomPasskeys.authenticate('health');
  try {
    if (!auth.prfOutput) throw new Error('この環境ではパスキーによる暗号鍵の解除を利用できません。平文での保存は行いません。');
    const result = await api('/passkey/handoff', { method: 'POST', body: JSON.stringify({ handoffToken: auth.handoff.handoffToken }) });
    const key = await unlockClient(auth.prfOutput, result.keyBundle.vault);
    state.master?.fill(0); state.master = await unwrapMaster(key, result.keyBundle.wrappedKey); state.session = result.sessionId;
    await load(); clearTimeout(expiryTimer); expiryTimer = setTimeout(lock, Math.max(0, result.expiresAt * 1000 - Date.now())); $('login').hidden = true; $('app').hidden = false;
  } catch (e) { lock(); throw e; } finally { auth.prfOutput?.fill(0); }
});
function render() {
  const p = predict(state.records, state.settings);
  $('prediction').textContent = p.date || '開始日を記録すると表示します';
  $('prediction-range').textContent = p.date ? `${p.from} 〜 ${p.to}（${p.personalized ? '実績から予測' : '仮予測'}）${today() > p.to ? ' — 予測期間を過ぎています' : ''}` : '';
  $('latest-cycle').textContent = p.latestCycle ? `${p.latestCycle}日` : '記録不足';
  renderCalendar(p); $('records').replaceChildren();
  for (const r of [...state.records].sort((a, b) => b.date.localeCompare(a.date))) {
    const button = document.createElement('button'); button.className = 'entry';
    const title = document.createElement('strong'); title.textContent = r.date;
    const text = document.createElement('span'); text.textContent = [r.start ? '生理開始' : '', r.end ? '生理終了' : '', ...r.symptoms.map(i => SYMPTOMS[i]), r.flow ? `経血量：${r.flow}` : '', r.note].filter(Boolean).join(' / ') || '任意項目の入力なし';
    button.append(title, text); button.onclick = () => edit(r.date); $('records').append(button);
  }
  if (!state.records.length) $('records').textContent = '記録はまだありません。カレンダーの日付を押して記録できます。';
}
function renderCalendar(prediction) {
  $('month').textContent = `${state.month.slice(0, 4)}年${Number(state.month.slice(5))}月`; $('calendar').replaceChildren();
  for (const name of ['日','月','火','水','木','金','土']) { const el = document.createElement('div'); el.className = 'weekday'; el.textContent = name; $('calendar').append(el); }
  const first = new Date(`${state.month}-01T00:00:00Z`); const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  for (let i = 0; i < first.getUTCDay(); i++) $('calendar').append(document.createElement('div'));
  const spans = periods(state.records);
  for (let n = 1; n <= count; n++) {
    const date = `${state.month}-${String(n).padStart(2, '0')}`; const row = state.records.find(r => r.date === date);
    const el = document.createElement('button'); el.className = 'day'; el.setAttribute('aria-label', `${date}${row ? ' 記録あり' : ''}`); el.textContent = n;
    if (date === today()) el.classList.add('current');
    if (spans.some(p => p.end && date >= p.start && date <= p.end)) el.classList.add('period');
    if (prediction.date && date >= prediction.from && date <= prediction.to) el.classList.add('predicted');
    if (row) { const dot = document.createElement('span'); dot.className = 'dot'; dot.textContent = '●'; el.append(dot); }
    if (row?.start) { const label = document.createElement('small'); label.textContent = spans.find(p => p.start === date)?.end ? '開始' : '開始\n終了未記録'; el.append(label); }
    if (row?.end) { const label = document.createElement('small'); label.textContent = '終了'; el.append(label); }
    el.onclick = () => edit(date); $('calendar').append(el);
  }
}
function edit(date) {
  if (state.busy) return;
  const r = state.records.find(r => r.date === date) || { date, start: false, end: false, symptoms: [], flow: null, note: '' };
  state.selected = date; $('record-date').textContent = date; $('editor-error').textContent = '';
  $('start-period').setAttribute('aria-pressed', String(r.start)); $('end-period').setAttribute('aria-pressed', String(r.end));
  document.querySelectorAll('#symptoms input').forEach(c => c.checked = r.symptoms.includes(Number(c.value)));
  $('flow').value = r.flow || ''; $('note').value = r.note; $('note').defaultValue = r.note;
  $('delete').hidden = !state.records.some(r => r.date === date);
  $('period-status').textContent = r.start && !periods(state.records).find(p => p.start === date)?.end ? '終了未記録です。終了日は自動補完しません。' : '';
  state.original = JSON.stringify(formValue()); nav.open('editor');
}
for (const [i, name] of SYMPTOMS.entries()) { const label = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.value = i; label.append(input, document.createTextNode(name)); $('symptoms').append(label); }
for (const id of ['start-period', 'end-period']) $(id).onclick = () => $(id).setAttribute('aria-pressed', String($(id).getAttribute('aria-pressed') !== 'true'));
$('record-form').onsubmit = e => { e.preventDefault(); task(async () => {
  const r = normalizeRecord(formValue()); if (r.date > today()) throw new Error('未来の日付を実績として保存することはできません。');
  const next = state.records.filter(v => v.date !== r.date).concat(r); periods(next);
  await store(await recordId(state.master, r.date), r); state.records = next; state.original = JSON.stringify(formValue()); render();
  state.busy = false; await nav.close('editor', { force: true });
}, 'editor-error'); };
$('delete').onclick = () => { if (!confirm('この日の記録を削除しますか？削除した内容は復元できません。')) return; task(async () => {
  const next = state.records.filter(r => r.date !== state.selected); periods(next);
  await api(`/records/${await recordId(state.master, state.selected)}`, { method: 'DELETE', body: '{}' }); state.records = next; render(); state.busy = false; await nav.close('editor', { force: true });
}, 'editor-error'); };
function settingsValue() { return { kind: 'settings', cycleDays: $('cycle-days').value ? Number($('cycle-days').value) : null, lastStart: $('last-start').value || null }; }
$('settings-open').onclick = () => { $('cycle-days').value = state.settings.cycleDays || ''; $('last-start').value = state.settings.lastStart || ''; $('settings-error').textContent = ''; state.original = JSON.stringify(settingsValue()); nav.open('settings'); };
$('settings-form').onsubmit = e => { e.preventDefault(); task(async () => {
  const v = settingsValue(); if (v.cycleDays != null && (!Number.isInteger(v.cycleDays) || v.cycleDays < 1 || v.cycleDays > 180) || v.lastStart && (!validDate(v.lastStart) || v.lastStart > today())) throw new Error('周期日数・開始日を確認してください。');
  await store(await recordId(state.master, 'settings'), v); state.settings = v; state.original = JSON.stringify(v); render(); state.busy = false; await nav.close('settings', { force: true });
}, 'settings-error'); };
$('export-open').onclick = () => { $('export-from').value = [...state.records].map(r => r.date).sort()[0] || today(); $('export-to').value = today(); $('export-error').textContent = ''; nav.open('export'); };
$('export-form').onsubmit = e => { e.preventDefault(); task(async () => { const content = toCsv(state.records, $('export-from').value, $('export-to').value); const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = '体調管理.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); state.busy = false; await nav.close('export', { force: true }); }, 'export-error'); };
for (const id of ['editor', 'settings', 'export']) $(`${id}-close`).onclick = () => nav.close(id);
function moveMonth(delta) { const d = new Date(`${state.month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + delta); state.month = d.toISOString().slice(0, 7); render(); }
$('previous').onclick = () => moveMonth(-1); $('next').onclick = () => moveMonth(1); $('today').onclick = () => { state.month = today().slice(0, 7); render(); };
for (const name of ['calendar', 'list']) $(`${name}-tab`).onclick = () => { for (const tab of ['calendar', 'list']) { $(`${tab}-panel`).hidden = tab !== name; $(`${tab}-tab`).setAttribute('aria-pressed', String(tab === name)); } };
$('refresh').onclick = () => task(load);
function lock() { clearTimeout(expiryTimer); state.master?.fill(0); state.master = null; state.session = null; state.records = []; state.settings = {}; state.original = ''; state.selected = null; nav.reset(); $('app').hidden = true; $('login').hidden = false; $('records').replaceChildren(); $('calendar').replaceChildren(); $('note').value = ''; $('note').defaultValue = ''; $('flow').value = ''; $('cycle-days').value = ''; $('last-start').value = ''; $('export-from').value = ''; $('export-to').value = ''; document.querySelectorAll('#symptoms input').forEach(c => c.checked = false); $('prediction').textContent = ''; $('prediction-range').textContent = ''; $('latest-cycle').textContent = ''; $('record-date').textContent = ''; $('period-status').textContent = ''; }
$('logout').onclick = () => task(async () => { try { await api('/logout', { method: 'POST', body: '{}' }); } finally { lock(); } });
window.addEventListener('pagehide', lock);
window.addEventListener('beforeunload', e => { if (dirty() || state.busy) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('troom:before-auto-update', e => { if (dirty() || state.busy || $('export').open) e.preventDefault(); });

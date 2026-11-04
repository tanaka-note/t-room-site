import { showReport, clearReport } from './report.js';
import { ALLOCATION_GROUPS, adjustmentForPeriod } from './portfolio-model.mjs';
const $ = id => document.getElementById(id);
let session = null, dataset = null, selected = null, draft = null, dirty = false, busy = false, generation = 0, activity = Date.now(), expiryTimer;
const requests = new Set(), channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('portfolio') : null;
const pickerCleanups = [];
const dialogs = window.TroomDialogNavigation.create({ key: 'portfolio-date-dialogs' });
const dateNavigation = { ...dialogs, register(id, options) { pickerCleanups.push(options.onClose); dialogs.register(id, options); } };
window.TRoomDatePicker.setNavigation(dateNavigation);
window.TRoomDateWheel.initialize(dateNavigation, () => busy || !session);
const pickerOpen = () => Boolean(document.querySelector('dialog[open]'));
const clone = value => structuredClone(value);
const money = value => new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(value);
function message(value, login = false) { $(login ? 'login-message' : 'app-message').textContent = value; }
function clearSession(broadcast = false) {
  generation++; session = dataset = selected = draft = null; dirty = busy = false;
  clearTimeout(expiryTimer); for (const controller of requests) controller.abort(); requests.clear();
  // Navigation reset closes dialogs; run their registered cleanup to cancel wheel timers too.
  dialogs.reset(); for (const cleanup of pickerCleanups) cleanup?.();
  for (const id of ['date-wheel-value', 'date-wheel-year', 'date-wheel-month', 'date-wheel-day', 'troom-calendar-title']) $(id).replaceChildren();
  document.querySelector('.troom-calendar-grid')?.replaceChildren();
  clearReport(); $('editor-form').reset(); $('asset-editors').replaceChildren(); $('view-date').value = '';
  for (const id of ['account-label','app-message','editor-note','editor-total']) $(id).textContent = '';
  $('report-app').hidden = true; $('editor-panel').hidden = true; $('login-panel').hidden = false;
  $('login-button').disabled = false; $('login-button').removeAttribute('aria-busy'); $('passkey-login-label').textContent = 'パスキーでログイン';
  if (broadcast) channel?.postMessage('session-changed');
}
function armExpiry() {
  clearTimeout(expiryTimer);
  if (session) expiryTimer = setTimeout(() => { clearSession(); message('ログインの有効期限が切れました。', true); }, Math.min(2147483647, Math.max(0, session.expiresAt * 1000 - Date.now())));
}
async function api(path, body) {
  const ownGeneration = generation, controller = new AbortController(); requests.add(controller);
  try {
    const response = await fetch(`/asset-report/api${path}`, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: controller.signal,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { 'X-Portfolio-Session': session.sessionContext } : {}),
        ...(!document.hidden && Date.now() - activity < 60000 ? { 'X-Troom-Activity': 'foreground' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (ownGeneration !== generation) throw Object.assign(new Error('表示を終了しました。'), { discarded: true });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) clearSession();
      throw Object.assign(new Error(data.error || '処理を完了できませんでした。'), { status: response.status, code: data.code });
    }
    const expires = Number(response.headers.get('X-Troom-Session-Expires'));
    if (session && expires > session.expiresAt) { session.expiresAt = expires; armExpiry(); }
    return data;
  } finally { requests.delete(controller); }
}
function failure(error) { if (error.discarded || error.name === 'AbortError') return; message(error.message, !session); }
function markDirty(value = true) { dirty = value; document.dispatchEvent(new Event('troom:auto-update-ready')); }
function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll('button')) button.disabled = value;
  window.TRoomPwaInstall?.setBlocked(value);
  $('view-date').disabled = value;
  for (const input of $('editor-form').querySelectorAll('input,select')) input.disabled = value;
}
function discard() { return !dirty || confirm('未保存の編集を破棄しますか？'); }
function displayRecord(record) {
  selected = clone(record);
  const adjustment = adjustmentForPeriod(dataset.metadata.performanceAdjustmentSnapshots, record.period);
  const marketValue = record.rawMarketValue + adjustment, profit = marketValue - dataset.metadata.basePrincipal;
  showReport({ ...dataset.metadata, ...record, assets: record.assets || [], hasBreakdown: record.assets !== null, history: dataset.history,
    summary: { marketValue, profit, returnRate: profit / dataset.metadata.basePrincipal * 100 } });
  $('view-date').value = record.period;
  message(record.assets === null ? 'この日の移行データは合計額のみです。銘柄別の内訳は記録されていません。' : '');
}
async function load(period) {
  const data = await api('/data'); dataset = data;
  const record = period && period !== data.record.period ? (await api(`/record?period=${encodeURIComponent(period)}`)).record : data.record;
  displayRecord(record);
}
function numeric(value) {
  const text = normalizeMoneyText(value).trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) throw new Error('金額は0以上の整数円で入力してください。');
  const number = Number(text.replaceAll(',', '')); if (!Number.isSafeInteger(number) || number > 1e12) throw new Error('金額が大きすぎます。');
  return number;
}
function normalizeMoneyText(value) {
  return String(value).replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 0xff10)).replaceAll('，', ',');
}
const isMoneyInput = input => input.matches?.('#base-principal, #legacy-total, [data-field="amount"]');
function formatMoneyInput(input, editing = false) {
  const original = input.value, start = input.selectionStart, end = input.selectionEnd;
  const normalized = normalizeMoneyText(original);
  // Native digit edits can temporarily disturb commas that we inserted ourselves.
  const candidate = editing && !input.validity.customError ? normalized.replaceAll(',', '') : normalized;
  if (!candidate.trim()) { input.setCustomValidity(''); return; }
  try {
    const value = numeric(candidate);
    input.value = value.toLocaleString('ja-JP');
    input.setCustomValidity('');
    const position = offset => {
      const digits = normalized.slice(0, offset).replace(/[^0-9]/g, '').length;
      if (!digits) return 0;
      let count = 0;
      for (let i = 0; i < input.value.length; i++) if (/\d/.test(input.value[i]) && ++count === digits) return i + 1;
      return input.value.length;
    };
    if (document.activeElement === input) input.setSelectionRange(position(start), position(end));
  } catch (error) { input.setCustomValidity(error.message); }
}
function setMoneyInput(input, value) { input.value = value; input.setCustomValidity(''); formatMoneyInput(input); }
$('editor-form').addEventListener('beforeinput', event => {
  const input = event.target;
  if (!isMoneyInput(input) || event.isComposing || input.selectionStart !== input.selectionEnd) return;
  const caret = input.selectionStart;
  // Delete the adjacent digit too when Backspace/Delete touches a generated comma.
  if (event.inputType === 'deleteContentBackward' && input.value[caret - 1] === ',') input.setSelectionRange(caret - 2, caret);
  if (event.inputType === 'deleteContentForward' && input.value[caret] === ',') input.setSelectionRange(caret, caret + 2);
});
$('editor-form').addEventListener('paste', event => {
  const input = event.target;
  if (!isMoneyInput(input) || !event.clipboardData) return;
  event.preventDefault();
  try {
    const pasted = normalizeMoneyText(event.clipboardData.getData('text')).trim();
    numeric(pasted);
    const digits = pasted.replaceAll(',', '');
    const start = normalizeMoneyText(input.value.slice(0, input.selectionStart)).replaceAll(',', '');
    const end = normalizeMoneyText(input.value.slice(input.selectionEnd)).replaceAll(',', '');
    input.value = start + digits + end;
    input.setSelectionRange(start.length + digits.length, start.length + digits.length);
    input.setCustomValidity('');
    input.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertFromPaste'}));
  } catch (error) { input.setCustomValidity(error.message); input.reportValidity(); }
});
$('editor-form').addEventListener('compositionend', event => {
  if (isMoneyInput(event.target)) { formatMoneyInput(event.target); markDirty(); updateTotal(); }
});
$('editor-form').addEventListener('focusout', event => { if (isMoneyInput(event.target)) formatMoneyInput(event.target); });
function collectDraft() {
  const record = { period: $('record-date').value, time: $('record-time').value || null, assets: draft.assets === null ? null : [], rawMarketValue: 0 };
  if (record.assets === null) record.rawMarketValue = numeric($('legacy-total').value);
  else for (const row of $('asset-editors').children) {
    const category = row.querySelector('[data-field=category]').value;
    record.assets.push({ id: row.dataset.id, name: row.querySelector('[data-field=name]').value.trim(), category,
      marketValue: numeric(row.querySelector('[data-field=amount]').value), color: ALLOCATION_GROUPS.find(g => g.name === category)?.color });
  }
  return record;
}
function updateTotal() {
  try { const value = collectDraft(); $('editor-total').textContent = money(value.assets === null ? value.rawMarketValue : value.assets.reduce((sum, asset) => sum + asset.marketValue, 0)); }
  catch { $('editor-total').textContent = '入力内容を確認してください'; }
}
function addRow(asset) {
  const row = document.createElement('div'); row.className = 'asset-editor'; row.dataset.id = asset.id;
  for (const [field, label, value] of [['name','銘柄名',asset.name],['category','資産分類',asset.category],['amount','評価額（円）',asset.marketValue]]) {
    const wrapper = document.createElement('label'); wrapper.textContent = label;
    const input = document.createElement(field === 'category' ? 'select' : 'input'); input.dataset.field = field;
    if (field === 'category') for (const group of ALLOCATION_GROUPS) { const option = document.createElement('option'); option.value = option.textContent = group.name; input.append(option); }
    else { input.type = 'text'; input.required = true; if (field === 'amount') input.inputMode = 'numeric'; else input.maxLength = 120; }
    if (field === 'amount') setMoneyInput(input, value); else input.value = value; wrapper.append(input); row.append(wrapper);
  }
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '削除';
  remove.onclick = () => { if (busy || !confirm('この日付の保有銘柄から削除しますか？ 過去の記録には影響しません。')) return; row.remove(); markDirty(); updateTotal(); };
  row.append(remove); $('asset-editors').append(row);
}
function openDraft(record, basePrincipal = dataset.metadata.basePrincipal) {
  draft = clone(record); markDirty(false); setMoneyInput($('base-principal'), basePrincipal); $('record-date').value = record.period; $('record-time').value = record.time || '';
  $('legacy-total').setCustomValidity('');
  $('asset-editors').replaceChildren(); $('legacy-total-label').hidden = record.assets !== null; $('add-asset').hidden = record.assets === null;
  $('editor-note').textContent = record.assets === null ? '移行済みの過去記録には銘柄別データがないため、この日は控除前の合計額を修正します。' : '評価額を編集すると合計を自動計算します。新しい日付を指定すると、その日の記録として保存できます。';
  if (record.assets === null) setMoneyInput($('legacy-total'), record.rawMarketValue); else record.assets.forEach(addRow);
  $('editor-panel').hidden = false; updateTotal();
}
$('edit-toggle').onclick = () => { if (!session || busy) return; if (!$('editor-panel').hidden) { if (discard()) { $('editor-panel').hidden = true; markDirty(false); } } else openDraft(selected); };
$('cancel-edit').onclick = () => { if (!busy && discard()) { $('editor-panel').hidden = true; markDirty(false); } };
$('editor-form').addEventListener('input', event => {
  if (event.target.id === 'record-date') return;
  markDirty();
  if (event.isComposing) return;
  if (isMoneyInput(event.target)) formatMoneyInput(event.target,
    event.inputType?.startsWith('delete') || (event.inputType === 'insertText' && /^[0-9０-９]$/.test(event.data || '')));
  updateTotal();
});
let dateRequest = 0;
$('record-date').addEventListener('change', async () => {
  if (!draft || busy) return;
  const period = $('record-date').value, ticket = ++dateRequest, previous = draft.period;
  if (!period) return;
  if (dataset.history.some(entry => entry.period === period) && !discard()) { $('record-date').value = previous; return; }
  setBusy(true);
  try {
    if (dataset.history.some(entry => entry.period === period)) {
      const result = await api(`/record?period=${encodeURIComponent(period)}`);
      if (ticket === dateRequest) openDraft(result.record);
    } else {
      // A new date explicitly copies the last known stock list as an input template.
      const template = draft.assets === null ? dataset.record : collectDraft();
      openDraft({ ...template, period, time: null }, $('base-principal').value);
      $('editor-note').textContent = '新しい日付です。表示中の銘柄を入力用に引き継ぎました。この日時点の評価額を確認して保存してください。';
      markDirty();
    }
  } catch (error) { failure(error); $('record-date').value = previous; }
  finally { setBusy(false); }
});
$('add-asset').onclick = () => { if (busy) return; addRow({ id: `asset-${crypto.randomUUID()}`, name: '', category: ALLOCATION_GROUPS[0].name, marketValue: 0 }); markDirty(); updateTotal(); };
$('view-date').onchange = async () => {
  if (busy || !discard()) { $('view-date').value = selected?.period || ''; return; }
  const period = $('view-date').value; setBusy(true);
  try { const result = await api(`/record?period=${encodeURIComponent(period)}`); displayRecord(result.record); $('editor-panel').hidden = true; markDirty(false); }
  catch (error) { failure(error); $('view-date').value = selected?.period || ''; } finally { setBusy(false); }
};
$('editor-form').onsubmit = async event => {
  event.preventDefault(); if (busy || !session) return;
  try {
    const record = collectDraft(), basePrincipal = numeric($('base-principal').value);
    if (basePrincipal === 0) throw new Error('元本は1円以上の整数円で入力してください。');
    if (basePrincipal !== dataset.metadata.basePrincipal && !confirm('元本を変更すると、過去を含む全日付の損益・損益率を再計算します。保存しますか？')) return;
    if (dataset.history.some(entry => entry.period === record.period) && !confirm(`${record.period} の記録を訂正して保存しますか？`)) return;
    setBusy(true);
    await api('/save', { record, basePrincipal, expectedRevision: dataset.revision, requestId: crypto.randomUUID() });
    markDirty(false); $('editor-panel').hidden = true;
    await load(record.period); message('保存しました。合計とチャートを更新しました。'); channel?.postMessage('data-changed');
  } catch (error) { failure(error); } finally { setBusy(false); }
};
$('login-button').onclick = async () => {
  if (busy) return; setBusy(true); $('login-button').setAttribute('aria-busy', 'true'); $('passkey-login-label').textContent = '確認中…'; message('', true);
  try {
    const auth = await window.TRoomPasskeys.authenticate('portfolio', links => window.TRoomPasskeys.chooseLinkDialog(links, 'portfolio'));
    await enter(await api('/passkey/handoff', { handoffToken: auth.handoff.handoffToken })); channel?.postMessage('session-changed');
  } catch (error) { failure(error); } finally { setBusy(false); $('login-button').removeAttribute('aria-busy'); $('passkey-login-label').textContent = 'パスキーでログイン'; }
};
async function enter(value) {
  session = value; armExpiry(); $('login-panel').hidden = true; $('report-app').hidden = false;
  $('account-label').textContent = value.displayName; $('edit-toggle').hidden = value.role !== 'owner';
  await load();
}
$('logout-button').onclick = async () => { if (busy || !discard()) return; setBusy(true); try { await api('/logout', {}); } catch { message('通信を完了できませんでした。この画面のデータは消去しました。', true); } finally { clearSession(true); } };
$('backup-button').onclick = async () => {
  if (busy) return; setBusy(true);
  try { const data = await api('/backup'); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `asset-report-${selected.period}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { failure(error); } finally { setBusy(false); }
};
for (const name of ['pointerdown','keydown','touchstart','wheel']) window.addEventListener(name, event => { if (event.isTrusted) activity = Date.now(); }, { passive: true });
window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('troom:before-auto-update', event => { if (dirty || busy || pickerOpen()) event.preventDefault(); });
window.addEventListener('pageshow', async event => { if (event.persisted && session) try { await api('/session'); } catch (error) { failure(error); } });
document.addEventListener('visibilitychange', async () => { if (!document.hidden && session) try { await api('/session'); } catch (error) { failure(error); } });
if (channel) channel.onmessage = event => { if (event.data === 'session-changed') clearSession(); else if (session) message('別の画面で更新されました。未保存の入力を確認し、再読み込みしてください。'); };
setBusy(true);
try { await enter(await api('/session')); } catch (error) { if (error.status !== 401) failure(error); } finally { setBusy(false); }

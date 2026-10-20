(() => {
  'use strict';
  const $ = id => document.getElementById(id), form = $('entry-form');
  const dialogs = TroomDialogNavigation.create({ key: 'troomPaymentsDialogs' });
  TRoomDatePicker.setNavigation(dialogs);
  TRoomDateWheel.initialize(dialogs, () => busy);
  const money = value => new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 2 }).format(value);
  let entries = [], editing = null, initial = '', busy = false, requestId = null, confirmAction = null, confirmRequestId = null;
  let activity = Date.now();
  for (const type of ['pointerdown', 'keydown', 'touchstart', 'wheel']) window.addEventListener(type, event => { if (event.isTrusted) activity = Date.now(); }, { passive: true, capture: true });
  const values = () => Object.fromEntries(new FormData(form));
  const dirty = () => JSON.stringify(values()) !== initial;
  function protect() { form.dataset.troomDirty = String($('entry-dialog').open && dirty()); }
  function setBusy(value) {
    busy = value; document.body.dataset.troomUpdateBlock = String(value);
    for (const el of document.querySelectorAll('button')) el.disabled = value;
    for (const el of form.querySelectorAll('input,textarea')) el.readOnly = value || el.hasAttribute('data-date-wheel-mode');
  }
  async function api(path, body, method = 'POST') {
    const response = await fetch(`/payments/api${path}`, { method: body === undefined ? 'GET' : method, credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(!document.hidden && Date.now() - activity < 60000 ? { 'X-Troom-Activity': 'foreground' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).catch(() => { throw new Error('通信を完了できませんでした。入力内容は保持されています。もう一度お試しください。'); });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) {
      $('app-view').hidden = true; $('login-view').hidden = false; $('login').hidden = false; $('boot-message').textContent = 'パスキーでログインしてください。';
      // Keep an open editor and its inputs in memory until the user chooses to close it.
    }
    if (!response.ok) throw new Error(result.error || '処理を完了できませんでした。時間を置いて再試行してください。');
    return result;
  }
  function showApp(session) { $('account-name').textContent = session.displayName; $('login-view').hidden = true; $('app-view').hidden = false; }
  function cell(row, value, className = '') { const el = document.createElement('td'); el.textContent = value; el.className = className; row.append(el); return el; }
  function render() {
    const root = $('entries'); root.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('tr'); row.dataset.id = entry.id;
      cell(row, entry.paid_on); cell(row, entry.payee); cell(row, entry.description);
      cell(row, money(entry.amount), 'numeric'); cell(row, `${entry.start_month} 〜\n${entry.end_month}`);
      cell(row, `${entry.months}ヶ月`, 'numeric'); cell(row, money(entry.monthly_amount), 'numeric');
      const status = cell(row, ''), badge = document.createElement('span'); badge.className = `badge ${entry.status}`;
      badge.textContent = entry.status === 'completed' ? '対象期間終了' : entry.status === 'upcoming' ? `開始前・${entry.months}ヶ月` : `残り${entry.remaining_months}ヶ月`; status.append(badge);
      cell(row, entry.notes);
      const actions = cell(row, '');
      for (const [label, action] of [['編集', () => openEditor(entry)], ['削除', () => confirmDelete(entry)]]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.setAttribute('aria-label', `${entry.payee}の明細を${label}`);
        if (label === '削除') button.className = 'delete'; button.onclick = action; actions.append(button);
      }
      root.append(row);
    }
    $('count').textContent = `${entries.length}件`; $('empty').hidden = entries.length !== 0;
  }
  async function load() {
    $('loading').hidden = false;
    try { const result = await api('/entries'); entries = result.entries; render(); $('message').textContent = ''; }
    catch (error) { $('message').textContent = error.message; throw error; }
    finally { $('loading').hidden = true; }
  }
  function calculation() {
    const data = values(), months = Number(data.months), amount = Number(data.amount);
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(data.startMonth) || !Number.isSafeInteger(months) || months < 1 || months > 1200 || !Number.isSafeInteger(amount) || amount < 1) { $('calculation').textContent = ''; return; }
    const start = Number(data.startMonth.slice(0, 4)) * 12 + Number(data.startMonth.slice(5)) - 1, end = start + months - 1;
    $('calculation').textContent = `月単価 ${money(amount / months)}\n${Math.floor(end / 12)}年${end % 12 + 1}月分まで`;
  }
  function openEditor(entry = null) {
    editing = entry; requestId = null; form.reset();
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const data = entry ? { paidOn: entry.paid_on, payee: entry.payee, description: entry.description, amount: entry.amount, startMonth: entry.start_month, months: entry.months, notes: entry.notes } : { paidOn: today, startMonth: today.slice(0, 7), months: 12 };
    for (const [key, value] of Object.entries(data)) form.elements.namedItem(key).value = value;
    initial = JSON.stringify(values()); $('form-error').textContent = '';
    $('editor-title').textContent = entry ? '明細を編集' : '明細を登録'; $('save').textContent = entry ? '変更を保存' : '登録する';
    calculation(); dialogs.open('entry-dialog'); protect();
  }
  function ask(title, copy, ok, action) {
    $('confirm-title').textContent = title; $('confirm-copy').textContent = copy; $('confirm-ok').textContent = ok; confirmAction = action; dialogs.open('confirm-dialog');
  }
  function confirmDelete(entry) {
    confirmRequestId = crypto.randomUUID();
    ask('この明細を削除しますか？', `${entry.payee}\n${entry.paid_on}　${money(entry.amount)}\n一覧から削除します。`, '削除する', async () => {
      await api(`/entries/${entry.id}`, { requestId: confirmRequestId, expectedVersion: entry.version }, 'DELETE');
      await dialogs.close('confirm-dialog', { force: true }); await load();
    });
  }
  dialogs.register('entry-dialog', { blocked: () => busy, guard: () => {
    if (busy) return false;
    if (!dirty()) return true;
    ask('入力内容を破棄しますか？', '保存していない入力内容があります。', '破棄する', async () => { await dialogs.close('confirm-dialog', { force: true }); await dialogs.close('entry-dialog', { force: true }); });
    return false;
  }, onClose: () => { form.reset(); initial = JSON.stringify(values()); protect(); editing = null; requestId = null; } });
  dialogs.register('confirm-dialog', { guard: () => !busy, blocked: () => busy, onClose: () => { confirmAction = null; } });
  form.addEventListener('input', () => { requestId = null; protect(); calculation(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    $('form-error').textContent = ''; const data = values(); requestId ||= crypto.randomUUID();
    setBusy(true);
    try {
      await api(editing ? `/entries/${editing.id}` : '/entries', { ...data, amount: Number(data.amount), months: Number(data.months), requestId, ...(editing ? { expectedVersion: editing.version } : {}) }, editing ? 'PUT' : 'POST');
      setBusy(false); await dialogs.close('entry-dialog', { force: true }); await load();
    } catch (error) { $('form-error').textContent = error.message; }
    finally { setBusy(false); protect(); }
  });
  $('confirm-ok').onclick = async () => {
    if (busy || !confirmAction) return; const action = confirmAction; setBusy(true);
    try { await action(); } catch (error) { $('confirm-copy').textContent = error.message; } finally { setBusy(false); }
  };
  $('confirm-cancel').onclick = () => dialogs.close('confirm-dialog');
  $('close-editor').onclick = $('cancel-editor').onclick = () => dialogs.close('entry-dialog');
  $('add').onclick = () => openEditor();
  $('login').onclick = async () => {
    $('login-error').textContent = ''; setBusy(true);
    try { const auth = await TRoomPasskeys.authenticate('payments'); const session = await api('/passkey/handoff', { handoffToken: auth.handoff.handoffToken }); showApp(session); await load(); }
    catch (error) { $('login-error').textContent = error.message; } finally { setBusy(false); }
  };
  $('logout').onclick = async () => {
    setBusy(true); $('message').textContent = '';
    try { await api('/logout', {}); entries = []; render(); dialogs.reset(); $('app-view').hidden = true; $('login-view').hidden = false; $('login').hidden = false; $('boot-message').textContent = 'パスキーでログインしてください。'; }
    catch (error) { $('message').textContent = error.message; } finally { setBusy(false); }
  };
  window.addEventListener('beforeunload', event => { if (busy || ($('entry-dialog').open && dirty())) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('troom:before-auto-update', event => { if (busy || ($('entry-dialog').open && dirty()) || $('confirm-dialog').open || $('date-wheel-dialog').open || $('troom-calendar-dialog').open) event.preventDefault(); });
  (async () => {
    try { const session = await api('/session'); showApp(session); await load(); }
    catch (error) { if ($('app-view').hidden) { $('boot-message').textContent = 'パスキーでログインしてください。'; $('login').hidden = false; if (!error.message.includes('ログインしてください')) $('login-error').textContent = error.message; } else $('message').textContent = error.message; }
  })();
})();

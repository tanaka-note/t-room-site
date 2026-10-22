(() => {
  'use strict';
  const $ = id => document.getElementById(id), form = $('entry-form');
  const dialogs = TroomDialogNavigation.create({ key: 'troomPaymentsDialogs' });
  TRoomDatePicker.setNavigation(dialogs);
  TRoomDateWheel.initialize(dialogs, () => busy);
  const money = value => new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(value);
  let entries = [], editing = null, initial = '', busy = false, requestId = null, confirmAction = null, confirmRequestId = null;
  let currentMonth = '', summary = {}, detail = null, detailEntry = null, monthPage = 0;
  const pendingMarks = new Map(), pageSize = 60;
  const jstTime = value => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)) + '（日本時間）';
  const preciseMoney = value => money(typeof value === 'string' ? BigInt(value) : value);
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('payments-ledger') : null;
  let needsRefresh = false;
  let activity = Date.now();
  for (const type of ['pointerdown', 'keydown', 'touchstart', 'wheel']) window.addEventListener(type, event => { if (event.isTrusted) activity = Date.now(); }, { passive: true, capture: true });
  const values = () => Object.fromEntries(new FormData(form));
  const dirty = () => JSON.stringify(values()) !== initial;
  function protect() { form.dataset.troomDirty = String($('entry-dialog').open && dirty()); }
  function setBusy(value) {
    busy = value; document.body.dataset.troomUpdateBlock = String(value);
    for (const el of document.querySelectorAll('button')) el.disabled = value || el.dataset.unavailable === 'true';
    for (const el of form.querySelectorAll('input,textarea')) el.readOnly = value || el.hasAttribute('data-date-wheel-mode');
  }
  async function api(path, body, method = 'POST') {
    const response = await fetch(`/payments/api${path}`, { method: body === undefined ? 'GET' : method, credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(!document.hidden && Date.now() - activity < 60000 ? { 'X-Troom-Activity': 'foreground' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).catch(() => { throw new Error('通信を完了できませんでした。入力内容は保持されています。もう一度お試しください。'); });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) {
      $('app-view').hidden = true; $('login-view').hidden = false; $('login').hidden = false; $('boot-message').textContent = 'パスキーでログインしてください。';
      // Keep an open editor and its inputs in memory until the user chooses to close it.
    }
    if (!response.ok) { const error = new Error(result.error || '処理を完了できませんでした。時間を置いて再試行してください。'); error.status = response.status; throw error; }
    return result;
  }
  function showApp(session) { $('account-name').textContent = session.displayName; $('login-view').hidden = true; $('app-view').hidden = false; }
  function cell(row, value, className = '') { const el = document.createElement('td'); el.textContent = value; el.className = className; row.append(el); return el; }
  function render() {
    const root = $('entries'); root.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('tr'); row.dataset.id = entry.id;
      cell(row, entry.paid_on); cell(row, entry.payee); cell(row, entry.description);
      cell(row, money(entry.amount), 'numeric'); cell(row, `${entry.start_month} 〜 ${entry.end_month}\n期間終了まで：残り${entry.remaining_months}ヶ月`);
      cell(row, `${entry.months}ヶ月`, 'numeric'); cell(row, money(entry.monthly_amount), 'numeric');
      const status = cell(row, ''), badge = document.createElement('span'); badge.className = `badge ${entry.status}`;
      badge.textContent = entry.status === 'completed' ? '計上完了' : `残り${entry.remaining_count}回・計上済み${entry.completed_count}回`;
      status.append(badge, document.createElement('br'), entry.period_status === 'ended' ? '対象期間終了' : entry.period_status === 'upcoming' ? '開始前' : '対象期間中');
      if (entry.past_pending_count) status.append(document.createElement('br'), `過去未計上 ${entry.past_pending_count}件`);
      cell(row, entry.notes);
      const actions = cell(row, '');
      for (const [label, action] of [['月別履歴', () => openMonths(entry)], ['編集', () => openEditor(entry)], ['削除', () => confirmDelete(entry)]]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.setAttribute('aria-label', `${entry.payee}の明細を${label}`);
        if (label === '削除') button.className = 'delete'; button.onclick = action; actions.append(button);
      }
      root.append(row);
    }
    renderDashboard(); $('count').textContent = `${entries.length}件`; $('empty').hidden = entries.length !== 0;
  }
  async function load() {
    $('loading').hidden = false;
    try { const result = await api('/entries'); entries = result.entries; currentMonth = result.currentMonth; summary = result.dashboard || {}; render(); $('message').textContent = ''; }
    catch (error) { $('message').textContent = error.message; throw error; }
    finally { $('loading').hidden = true; }
  }
  function calculation() {
    const data = values(), months = Number(data.months), amount = Number(data.amount);
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(data.startMonth) || !Number.isSafeInteger(months) || months < 1 || months > 1200 || !Number.isSafeInteger(amount) || amount < 1) { $('calculation').textContent = ''; return; }
    const start = Number(data.startMonth.slice(0, 4)) * 12 + Number(data.startMonth.slice(5)) - 1, end = start + months - 1;
    $('calculation').textContent = `月単価目安 ${money(Number((BigInt(amount) + BigInt(months) - 1n) / BigInt(months)))}（1円単位切り上げ）\n${Math.floor(end / 12)}年${end % 12 + 1}月分まで`;
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
    ask('この明細を削除しますか？', `${entry.payee}\n${entry.paid_on}　${money(entry.amount)}\n一覧から削除します。計上済み月がある場合は、先に月別履歴で全て取り消してください。`, '削除する', async () => {
      await api(`/entries/${entry.id}`, { requestId: confirmRequestId, expectedVersion: entry.version }, 'DELETE');
      await dialogs.close('confirm-dialog', { force: true }); await load(); channel?.postMessage('changed');
    });
  }
  dialogs.register('entry-dialog', { blocked: () => busy, guard: () => {
    if (busy) return false;
    if (!dirty()) return true;
    ask('入力内容を破棄しますか？', '保存していない入力内容があります。', '破棄する', async () => { await dialogs.close('confirm-dialog', { force: true }); await dialogs.close('entry-dialog', { force: true }); });
    return false;
  }, onClose: () => { form.reset(); initial = JSON.stringify(values()); protect(); editing = null; requestId = null; } });
  dialogs.register('months-dialog', {
    blocked: () => busy, guard: () => !busy,
    capture: () => ({ detail, entry: detailEntry, monthPage }),
    restore: saved => {
      const entry = entries.find(e => e.id === saved?.entry?.id);
      if (!entry || entry.version !== saved.detail?.version || $('app-view').hidden || saved.detail.currentMonth !== new Date(Date.now()+9*3600000).toISOString().slice(0,7)) return false;
      detail = saved.detail; detailEntry = entry; monthPage = saved.monthPage;
      $('months-title').textContent = `${entry.payee}の月別計上履歴`; renderMonths(); return true;
    },
    onClose: () => {
      const id = detailEntry?.id; detail = null; detailEntry = null;
      // A completion refresh replaces the original row; retain a safe focus target.
      [...$('entries').rows].find(row => row.dataset.id === id)?.querySelector('button')?.focus({ preventScroll:true });
    }
  });
  dialogs.register('confirm-dialog', { guard: () => !busy, blocked: () => busy, onClose: () => { confirmAction = null; } });
  form.addEventListener('input', () => { requestId = null; protect(); calculation(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    $('form-error').textContent = ''; const data = values(); requestId ||= crypto.randomUUID();
    setBusy(true);
    try {
      await api(editing ? `/entries/${editing.id}` : '/entries', { ...data, amount: Number(data.amount), months: Number(data.months), requestId, ...(editing ? { expectedVersion: editing.version } : {}) }, editing ? 'PUT' : 'POST');
      setBusy(false); await dialogs.close('entry-dialog', { force: true }); await load(); channel?.postMessage('changed');
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

  function button(label, action, unavailable = false) {
    const el = document.createElement('button'); el.type = 'button'; el.textContent = label;
    el.dataset.unavailable = String(unavailable); el.disabled = busy || unavailable; el.onclick = action; return el;
  }
  function markButton(entry, target, completed, canComplete = true) {
    const el = button(completed ? '計上を取り消す' : canComplete ? '計上済みにする' : '未来月', () => changeMark(entry, target, !completed), !completed && !canComplete);
    el.setAttribute('aria-label', `${entry.payee} ${target} ${el.textContent}`); return el;
  }
  function renderDashboard() {
    $('dashboard-month').textContent = `${currentMonth} の計上管理`;
    $('current-pending').textContent = `今月未計上：${summary.current_pending_count || 0}件／${preciseMoney(summary.current_pending_amount || '0')}`;
    $('current-done').textContent = `今月計上済み：${summary.current_completed_count || 0}件`;
    $('past-pending').textContent = `過去月未計上：${summary.past_pending_count || 0}件／${preciseMoney(summary.past_pending_amount || '0')}`;
    $('past-pending').classList.toggle('error', !!summary.past_pending_count);
    $('progress').textContent = `今月の進捗 ${summary.current_completed_count || 0}／${summary.current_count || 0}件　全期間の計上済み ${summary.completed_count || 0}／${summary.total_count || 0}件`;
    const root = $('current-items'); root.replaceChildren();
    for (const entry of entries.filter(e => e.current_amount !== null)) {
      const item = document.createElement('div'); item.className = 'monthly-item';
      const text = document.createElement('p'); text.textContent = `${entry.payee}　${money(entry.current_amount)}　${entry.current_completed ? '計上済み' : '未計上'}`;
      if (entry.current_completed_at) { const time = document.createElement('small'); time.textContent = jstTime(entry.current_completed_at); text.append(document.createElement('br'), time); }
      item.append(text, markButton(entry, currentMonth, entry.current_completed)); root.append(item);
    }
    if (!root.childElementCount) root.textContent = '今月の対象明細はありません。';
    const past = $('past-items'); past.replaceChildren();
    for (const entry of entries.filter(e => e.past_pending_count)) {
      past.append(button(`${entry.payee}：${entry.past_pending_count}件／${money(entry.past_pending_amount)} → 月別履歴`, () => openMonths(entry, true)));
    }
  }
  async function openMonths(entry, overdue = false) {
    if (busy) return; setBusy(true); $('message').textContent = '';
    try {
      detail = await api(`/entries/${entry.id}/months`); detailEntry = { ...entry, version: detail.version }; monthPage = 0;
      if (overdue) { const index = detail.months.findIndex(m => !m.completed_at && m.target_month < detail.currentMonth); monthPage = Math.floor(Math.max(0,index) / pageSize); }
      $('months-title').textContent = `${entry.payee}の月別計上履歴`; renderMonths(); dialogs.open('months-dialog');
    } catch (error) { $('message').textContent = error.message; } finally { setBusy(false); }
  }
  function renderMonths() {
    $('months-error').textContent = '';
    const root = $('month-items'); root.replaceChildren();
    for (const item of detail.months.slice(monthPage * pageSize, (monthPage + 1) * pageSize)) {
      const row = document.createElement('div'); row.className = 'monthly-item';
      const copy = document.createElement('p'); copy.textContent = `${item.target_month}　${money(item.amount)}　${item.completed_at ? '計上済み' : '未計上'}`;
      if (item.completed_at) { const time = document.createElement('small'); time.textContent = jstTime(item.completed_at); copy.append(document.createElement('br'),time); }
      row.append(copy,markButton(detailEntry,item.target_month,!!item.completed_at,item.can_complete)); root.append(row);
    }
    $('month-pagination').replaceChildren(button('前の月へ', () => { monthPage--; renderMonths(); }, monthPage === 0),
      document.createTextNode(` ${monthPage+1}／${Math.ceil(detail.months.length/pageSize)} `),
      button('次の月へ', () => { monthPage++; renderMonths(); }, (monthPage+1)*pageSize >= detail.months.length));
    const labels = { entry_create:'明細登録', entry_edit:'明細編集', allocation_change:'配分変更', entry_delete:'明細削除', month_complete:'計上完了', month_undo:'計上取消' };
    const history = $('operation-history'); history.replaceChildren();
    for (const event of detail.history) { const item = document.createElement('li'); item.textContent = `${jstTime(event.occurred_at)}　${event.target_month || ''} ${labels[event.action]}　操作者：${event.identity_id}`; history.append(item); }
  }
  async function changeMark(entry, target, completed) {
    if (busy) return;
    const key = `${entry.id}:${target}:${entry.version}:${completed}`;
    if (!pendingMarks.has(key)) pendingMarks.set(key, crypto.randomUUID());
    setBusy(true); $('message').textContent = ''; $('months-error').textContent = '';
    try {
      await api(`/entries/${entry.id}/months/${target}`, { requestId:pendingMarks.get(key), expectedVersion:entry.version, completed }, 'PUT');
      pendingMarks.delete(key); channel?.postMessage('changed'); await load();
      if (detailEntry?.id === entry.id) { detail = await api(`/entries/${entry.id}/months`); detailEntry = { ...entry, version:detail.version }; renderMonths(); }
    } catch (error) {
      if (error.status === 409) { pendingMarks.delete(key); await load().catch(() => {}); if (detailEntry?.id === entry.id) { try { detail=await api(`/entries/${entry.id}/months`); detailEntry={...entry,version:detail.version}; renderMonths(); } catch {} } }
      (detail ? $('months-error') : $('message')).textContent = error.message;
    } finally { setBusy(false); }
  }
  $('close-months').onclick = () => dialogs.close('months-dialog');
  $('refresh').onclick = async () => { if (busy) return; setBusy(true); try { await load(); } catch {} finally { setBusy(false); } };
  async function refreshIfSafe() {
    if (document.hidden || busy || $('app-view').hidden || document.querySelector('dialog[open]')) return;
    const nowMonth = new Date(Date.now()+9*3600000).toISOString().slice(0,7);
    if (needsRefresh || (currentMonth && currentMonth !== nowMonth)) {
      needsRefresh=false; setBusy(true);
      try { await load(); } catch {} finally { setBusy(false); }
    }
  }
  if (channel) channel.onmessage = () => { needsRefresh=true; refreshIfSafe(); };
  document.addEventListener('visibilitychange', refreshIfSafe); window.addEventListener('focus', refreshIfSafe);
  setInterval(refreshIfSafe, 60000);

  window.addEventListener('beforeunload', event => { if (busy || ($('entry-dialog').open && dirty())) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('troom:before-auto-update', event => { if (busy || ($('entry-dialog').open && dirty()) || $('confirm-dialog').open || $('date-wheel-dialog').open || $('troom-calendar-dialog').open) event.preventDefault(); });
  (async () => {
    try { const session = await api('/session'); showApp(session); await load(); }
    catch (error) { if ($('app-view').hidden) { $('boot-message').textContent = 'パスキーでログインしてください。'; $('login').hidden = false; if (!error.message.includes('ログインしてください')) $('login-error').textContent = error.message; } else $('message').textContent = error.message; }
  })();
})();

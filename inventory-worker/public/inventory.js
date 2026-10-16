(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const yearNow = Number(new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 4));
  const labels = { opening: '初期在庫', restock: '補充', use: '使用', adjust: '在庫調整' };
  let items = [], detail = null, cursor = null, listScroll = 0, listYear = yearNow, mode = '', editedItem = null;
  let dirty = false, busy = false, approvedClose = false, openToken = '', opener = null, retry = null, backgroundPointer = null;
  let activity = Date.now(), renderSequence = 0, listSequence = 0;
  let listAnchors = [];
  let sessionGeneration = 0;
  const pendingRequests = new Set();
  const detailPositions = new Map();
  const unavailableMessage = '一時的に接続できません。時間を置いて再試行してください。';
  // Only fixed, public Worker messages may be reflected from an error response.
  const publicErrors = new Set([
    'ページが見つかりません。', 'この操作は利用できません。', '画面を読み込めませんでした。', 'ログアウトを完了できませんでした。',
    '品目が見つかりません。', '履歴のページを確認してください。', '記録の種類を確認してください。', 'アーカイブ済みの品目には追加できません。',
    '記録が見つかりません。', '同じ操作IDで異なる内容を送信できません。', '別の操作で在庫が変わりました。再読み込みして入力し直してください。',
    '初期在庫は取り消せません。在庫調整を利用してください。', 'この記録は既に取り消されています。', '在庫0の有効な品目だけをアーカイブできます。', '削除済みの品目は変更できません。',
    '在庫が不足しているか、数量の上限を超えています。取消できない場合は在庫調整を利用してください。',
    '認証の準備ができていません。', 'アカウントの準備ができていません。', '利用できるパスキーを確認できませんでした。',
    'セッションを開始できませんでした。', 'パスキーでログインしてください。', '認証設定を確認してください。', 'セッションの認証設定が完了していません。',
    '操作元を確認できません。', '入力内容を確認してください。', '入力内容が大きすぎます。', '数量は範囲内の整数で入力してください。',
    '操作の識別情報を確認してください。', '日時を確認してください。', '過去または現在の日時を入力してください。', '存在する日付を入力してください。', '年を確認してください。',
    ...['品目名', '単位', '認証情報'].flatMap(label => [`${label}を入力してください。`, `${label}の長さや文字を確認してください。`])
  ]);
  const currentSession = generation => { if (generation !== sessionGeneration) throw Object.assign(new Error(''), { discarded: true }); };
  const report = (error, target = 'message') => { if (error.discarded) return; if (target === 'message' || error.status === 401) message(error.message); else $(target).textContent = error.message; };
  const positionKey = value => `${value.item.id}:${value.year}`;
  const el = (tag, content, className) => { const node = document.createElement(tag); if (content != null) node.textContent = content; if (className) node.className = className; return node; };
  const button = (label, action, className) => { const b = el('button', label, className); b.type = 'button'; b.addEventListener('click', action); return b; };
  const message = value => { $('message').textContent = value; $('message').hidden = !value; };
  const ready = () => document.dispatchEvent(new Event('troom:auto-update-ready'));
  // datetime-local normalizes zero seconds away, but the API requires seconds.
  const localTimestamp = value => `${/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value) ? `${value}:00` : value}+09:00`;
  async function api(path, body) {
    const generation = sessionGeneration, controller = new AbortController(); pendingRequests.add(controller);
    const headers = { 'Content-Type': 'application/json' };
    if (!document.hidden && Date.now() - activity < 60000) headers['X-Troom-Activity'] = 'foreground';
    try {
      const response = await fetch(`/inventory/api${path}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      currentSession(generation);
      let value = null;
      if (/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|\s*$)/i.test(response.headers.get('Content-Type') || '')) {
        try { value = await response.json(); } catch { /* Never display parser errors or response text. */ }
      }
      currentSession(generation);
      if (!response.ok || !value || typeof value !== 'object' || Array.isArray(value)) {
        const text = response.status === 429 ? 'アクセスが集中しています。少し時間を置いて再試行してください。'
          : publicErrors.has(value?.error) ? value.error : unavailableMessage;
        const error = Object.assign(new Error(text), { status: response.status });
        if (response.status === 401) loginView();
        throw error;
      }
      return value;
    } catch (error) {
      if (error.status === 401) throw error;
      currentSession(generation);
      throw error.status ? error : new Error(unavailableMessage);
    } finally { pendingRequests.delete(controller); }
  }
  function loginView() {
    sessionGeneration++; renderSequence++;
    for (const controller of pendingRequests) controller.abort(); pendingRequests.clear();
    if ($('editor').open) $('editor').close();
    items = []; detail = cursor = editedItem = retry = opener = backgroundPointer = null;
    listAnchors = []; detailPositions.clear(); listScroll = 0; listYear = yearNow;
    mode = openToken = ''; dirty = busy = approvedClose = false;
    $('record-form').reset(); $('record-form').dataset.troomDirty = 'false';
    for (const id of ['name','unit','quantity','occurred-at','search']) $(id).value = '';
    for (const id of ['items','movements','chart','month-labels','item-name','item-stock','annual-total','detail-actions','month-values','editor-title','form-message']) $(id).replaceChildren();
    $('quantity-label').textContent = '数量';
    $('show-archived').checked = false; $('list-year').value = $('detail-year').value = String(yearNow);
    $('more').hidden = true; $('detail-view').hidden = true; $('list-view').hidden = false;
    const url = new URL(location.href); url.searchParams.delete('item'); url.searchParams.delete('year');
    const state = { ...history.state }; delete state.inventory; delete state.inventoryDialog; history.replaceState(state, '', url);
    $('login-view').hidden = false; $('app-view').hidden = true; $('logout').hidden = true; $('account-name').textContent = '';
    $('login').disabled = false; markBusy(false); message('');
  }
  async function enter(account, generation = sessionGeneration) { currentSession(generation); $('account-name').textContent = account.displayName; $('login-view').hidden = true; $('app-view').hidden = false; $('logout').hidden = false; message(''); await loadItems(); currentSession(generation); await renderLocation(); }
  async function loadItems() { const generation = sessionGeneration, sequence = ++listSequence, value = await api(`/items?year=${listYear}`); currentSession(generation); if (sequence !== listSequence) return; items = value.items; renderItems(); }
  function renderItems() {
    const search = $('search').value.trim().toLocaleLowerCase(); $('items').replaceChildren();
    const shown = items.filter(item => (!item.archived_at || $('show-archived').checked) && item.name.toLocaleLowerCase().includes(search));
    for (const item of shown) {
      const row = el('article', null, 'item'); row.dataset.itemId = item.id;
      row.append(button(item.name + (item.archived_at ? '（アーカイブ）' : ''), () => openDetail(item.id), 'item-link'));
      for (const [caption, count] of [['現在庫', item.stock], [`${listYear}年の使用`, item.annual_usage]]) { const cell = el('div'); cell.append(el('span', caption, 'caption'), el('span', `${count.toLocaleString()} ${item.unit}`, 'number')); row.append(cell); }
      const actions = el('div', null, 'actions'); if (!item.archived_at) actions.append(button('使用', e => edit('use', item, e.currentTarget)), button('補充', e => edit('restock', item, e.currentTarget))); row.append(actions); $('items').append(row);
    }
    if (!shown.length) $('items').append(el('p', items.length ? '該当する品目はありません。' : '品目を追加して、在庫の記録を始めましょう。', 'empty'));
  }
  function openDetail(id) { listScroll = window.scrollY; listAnchors = [...$('items').children].filter(n => n.dataset.itemId && n.getBoundingClientRect().bottom > 0).slice(0, 2).map(n => ({ id: n.dataset.itemId, top: n.getBoundingClientRect().top })); const url = new URL(location.href); url.searchParams.set('item', id); url.searchParams.set('year', String(listYear)); history.pushState({ ...history.state, inventory: { itemId: id, year: listYear } }, '', url); void renderLocation(true).catch(report); }
  async function renderLocation(fresh = false) {
    const sequence = ++renderSequence, params = new URL(location.href).searchParams, id = params.get('item');
    if (!id) { $('detail-view').hidden = true; $('list-view').hidden = false; detail = null; requestAnimationFrame(() => { if (sequence !== renderSequence) return; const anchor = listAnchors.find(a => [...$('items').children].some(n => n.dataset.itemId === a.id)); const row = anchor && [...$('items').children].find(n => n.dataset.itemId === anchor.id); window.scrollTo(0, row ? window.scrollY + row.getBoundingClientRect().top - anchor.top : listScroll); }); return; }
    const priorScroll = detail && detail.item.id === id ? window.scrollY : null;
    const year = Number(params.get('year') || listYear);
    let value;
    try { value = await api(`/items/${encodeURIComponent(id)}?year=${year}`); }
    catch (error) {
      if (sequence !== renderSequence) return;
      if (error.status === 404) { await returnToList('品目が見つかりません。', id); return; }
      throw error;
    }
    if (sequence !== renderSequence) return;
    detail = value; cursor = value.nextCursor; $('list-view').hidden = true; $('detail-view').hidden = false; $('item-name').textContent = value.item.name;
    $('item-stock').textContent = `現在庫 ${value.item.stock.toLocaleString()} ${value.item.unit}${value.item.archived_at ? '（アーカイブ）' : ''}`;
    $('detail-year').value = String(value.year); $('annual-total').textContent = `年間使用数 ${value.annualUsage.toLocaleString()} ${value.item.unit}`;
    $('detail-actions').replaceChildren(); if (!value.item.archived_at) { $('detail-actions').append(button('使用', e => edit('use', value.item, e.currentTarget)), button('補充', e => edit('restock', value.item, e.currentTarget)), button('在庫を合わせる', e => edit('adjust', value.item, e.currentTarget))); if (value.item.stock === 0) $('detail-actions').append(button('アーカイブ', () => archive(value.item))); }
    $('detail-actions').append(button('品目を削除', () => deleteItem(value.item)));
    renderChart(value); $('movements').replaceChildren(); appendHistory(value.movements); $('more').hidden = !cursor;
    requestAnimationFrame(() => { if (sequence === renderSequence) window.scrollTo(0, fresh ? 0 : priorScroll ?? detailPositions.get(positionKey(value)) ?? 0); });
  }
  function renderChart(value) {
    $('chart').replaceChildren(); $('month-labels').replaceChildren(); $('month-values').replaceChildren();
    const maximum = Math.max(1, ...value.months.map(m => m.used));
    const svg = (tag, attrs, content) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v)); if (content != null) node.textContent = content; $('chart').append(node); return node; };
    svg('line', { x1: 15, y1: 185, x2: 625, y2: 185 });
    for (const m of value.months) { const x = 18 + (m.month - 1) * 51, height = m.used / maximum * 135;
      const rect = svg('rect', { x, y: 185 - height, width: 32, height, rx: 3 }); const title = document.createElementNS(rect.namespaceURI, 'title'); title.textContent = `${m.month}月 ${m.used} ${value.item.unit}`; rect.append(title);
      svg('text', { x: x + 16, y: 178 - height, 'text-anchor': 'middle' }, m.used.toLocaleString()); svg('text', { x: x + 16, y: 207, 'text-anchor': 'middle' }, `${m.month}月`);
      $('month-labels').append(el('th', `${m.month}月`)); $('month-values').append(el('td', `${m.used.toLocaleString()} ${value.item.unit}`)); }
  }
  function appendHistory(rows) {
    if (!rows.length && !$('movements').children.length) $('movements').append(el('p', 'この年の記録はありません。', 'empty'));
    for (const movement of rows) { const row = el('div', null, 'movement'); const label = el('div', `${labels[movement.kind]} ${movement.quantity_delta > 0 ? '+' : ''}${movement.quantity_delta} ${detail.item.unit}`, movement.voided_at ? 'voided' : '');
      label.append(el('small', new Date(movement.occurred_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }) + (movement.voided_at ? ' · 取消済み' : ''))); row.append(label);
      if (!movement.voided_at && movement.kind !== 'opening') row.append(button('取消', () => cancel(movement))); $('movements').append(row); }
  }
  function markBusy(value) { busy = value; document.body.dataset.troomUpdateBlock = String(value); $('fields').disabled = value; if (!value) ready(); }
  function edit(kind, item, origin) {
    if (busy || $('editor').open) return; mode = kind; editedItem = item; opener = origin; dirty = false; retry = null; approvedClose = false; openToken = crypto.randomUUID();
    $('record-form').reset(); $('record-form').dataset.troomDirty = 'false'; $('editor-title').textContent = kind === 'add' ? '品目を追加' : `${item.name} · ${labels[kind]}`;
    $('name-fields').hidden = kind !== 'add'; $('name').required = $('unit').required = kind === 'add'; $('time-field').hidden = kind === 'add'; $('occurred-at').required = kind !== 'add';
    $('quantity-label').textContent = kind === 'add' ? '初期在庫数' : kind === 'adjust' ? `実際の在庫数（${item.unit}）` : `数量（${item.unit}）`;
    $('quantity').min = ['add', 'adjust'].includes(kind) ? '0' : '1'; $('quantity').value = kind === 'adjust' ? String(item.stock) : kind === 'add' ? '0' : '1';
    const jst = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 19); $('occurred-at').value = jst; $('form-message').textContent = '';
    history.pushState({ ...history.state, inventoryDialog: openToken }, '', location.href); $('editor').showModal();
    (kind === 'add' ? $('name') : $('quantity')).focus();
  }
  function allowClose() { return !busy && (!dirty || confirm('未保存の入力を破棄して閉じますか？')); }
  function closeEditor() { if (!allowClose()) return; approvedClose = true; if (history.state?.inventoryDialog === openToken) history.back(); else finishClose(); }
  function finishClose() { $('editor').close(); dirty = false; retry = editedItem = null; mode = openToken = ''; $('record-form').dataset.troomDirty = 'false'; const origin = opener; opener = backgroundPointer = null; origin?.focus({ preventScroll: true }); ready(); }
  async function save(event) {
    event.preventDefault(); if (busy) return; const generation = sessionGeneration, editingMode = mode;
    const data = { quantity: Number($('quantity').value), occurredAt: localTimestamp($('occurred-at').value) };
    const input = mode === 'add' ? { name: $('name').value, unit: $('unit').value, stock: data.quantity } : { ...data, kind: mode, ...(mode === 'adjust' ? { expectedVersion: editedItem.version } : {}) };
    const path = mode === 'add' ? '/items' : `/items/${editedItem.id}/movements`;
    const fingerprint = JSON.stringify(input); if (!retry || retry.fingerprint !== fingerprint) retry = { fingerprint, requestId: crypto.randomUUID() };
    markBusy(true); $('form-message').textContent = '';
    try { await api(path, { ...input, requestId: retry.requestId }); currentSession(generation); dirty = false; approvedClose = true; history.back(); await loadItems(); if (detail) await renderLocation(); currentSession(generation); message('記録しました。'); }
    catch (error) { report(error, 'form-message'); if (generation === sessionGeneration && error.status === 409 && editingMode === 'adjust') { message('最新の在庫を確認し、フォームを閉じてから入力し直してください。'); await loadItems().catch(report); } }
    finally { if (generation === sessionGeneration) markBusy(false); }
  }
  async function cancel(movement) {
    if (busy || !confirm('この記録を取り消しますか？ 在庫と使用数へ反映されます。')) return;
    const generation = sessionGeneration; markBusy(true); try { await api(`/movements/${movement.id}/void`, { requestId: crypto.randomUUID() }); currentSession(generation); await loadItems(); await renderLocation(); currentSession(generation); message('取り消しました。'); } catch (e) { report(e); } finally { if (generation === sessionGeneration) markBusy(false); }
  }
  async function archive(item) {
    if (busy || !confirm('この品目をアーカイブしますか？ 過去の記録は残ります。')) return;
    const generation = sessionGeneration; markBusy(true); try { await api(`/items/${item.id}/archive`, { requestId: crypto.randomUUID() }); currentSession(generation); await loadItems(); await renderLocation(); currentSession(generation); message('アーカイブしました。'); } catch (e) { report(e); } finally { if (generation === sessionGeneration) markBusy(false); }
  }
  async function returnToList(notice, itemId) {
    const generation = sessionGeneration;
    renderSequence++; detail = cursor = null;
    for (const key of detailPositions.keys()) if (key.startsWith(`${itemId}:`)) detailPositions.delete(key);
    for (const id of ['item-name','item-stock','annual-total','detail-actions','movements','chart','month-labels','month-values']) $(id).replaceChildren();
    $('more').hidden = true; $('detail-view').hidden = true; $('list-view').hidden = false;
    const url = new URL(location.href); url.searchParams.delete('item'); url.searchParams.delete('year');
    const state = { ...history.state }; delete state.inventory; delete state.inventoryDialog; history.replaceState(state, '', url);
    await loadItems(); currentSession(generation); await renderLocation(); message(notice);
  }
  async function deleteItem(item) {
    if (busy || !confirm('この品目を削除しますか？ 在庫数にかかわらず、一覧・使用数の集計・履歴画面から除外されます。元に戻せません。')) return;
    const generation = sessionGeneration; markBusy(true);
    try {
      await api(`/items/${item.id}/delete`, { requestId: crypto.randomUUID(), expectedVersion: item.version });
      currentSession(generation); await returnToList('品目を削除しました。', item.id);
    } catch (error) {
      if (generation !== sessionGeneration) { report(error); return; }
      if (error.status === 404) await returnToList('品目は既に削除されています。', item.id).catch(report);
      else if (error.status === 409) {
        try { await loadItems(); currentSession(generation); await renderLocation(); currentSession(generation); report(error); }
        catch (refreshError) { report(refreshError); }
      }
      else report(error);
    } finally { if (generation === sessionGeneration) markBusy(false); }
  }
  document.addEventListener('DOMContentLoaded', async () => {
    for (const id of ['list-year', 'detail-year']) for (let year = yearNow; year >= 2000; year--) { const option = el('option', `${year}年`); option.value = String(year); $(id).append(option); } $('list-year').value = String(yearNow);
    $('search').addEventListener('input', renderItems); $('show-archived').addEventListener('change', renderItems); $('add-item').addEventListener('click', e => edit('add', null, e.currentTarget));
    $('list-year').addEventListener('change', async () => { listYear = Number($('list-year').value); try { await loadItems(); } catch (e) { report(e); } });
    $('detail-year').addEventListener('change', () => { const url = new URL(location.href); url.searchParams.set('year', $('detail-year').value); history.replaceState(history.state, '', url); void renderLocation().catch(report); });
    $('back').addEventListener('click', () => { if (history.state?.inventory?.itemId) history.back(); else { const url = new URL(location.href); url.searchParams.delete('item'); url.searchParams.delete('year'); history.replaceState(history.state, '', url); void renderLocation().catch(report); } });
    $('more').addEventListener('click', async () => { if (!cursor || busy) return; const generation = sessionGeneration; markBusy(true); try { const value = await api(`/items/${detail.item.id}?year=${detail.year}&before=${encodeURIComponent(cursor)}`); currentSession(generation); appendHistory(value.movements); cursor = value.nextCursor; $('more').hidden = !cursor; } catch (e) { report(e); } finally { if (generation === sessionGeneration) markBusy(false); } });
    $('close-editor').addEventListener('click', closeEditor); $('editor').addEventListener('cancel', e => { e.preventDefault(); closeEditor(); });
    const outside = e => { const r = $('editor').getBoundingClientRect(); return e.target === $('editor') && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom); };
    $('editor').addEventListener('pointerdown', e => { backgroundPointer = outside(e) ? e.pointerId : null; });
    $('editor').addEventListener('pointerup', e => { if (backgroundPointer === e.pointerId && outside(e)) { e.preventDefault(); e.stopPropagation(); closeEditor(); } backgroundPointer = null; });
    $('editor').addEventListener('pointercancel', () => { backgroundPointer = null; });
    $('record-form').addEventListener('input', () => { dirty = true; retry = null; $('record-form').dataset.troomDirty = 'true'; }); $('record-form').addEventListener('submit', save);
    $('login').addEventListener('click', async () => { if (busy) return; const generation = sessionGeneration; markBusy(true); $('login').disabled = true; try { const auth = await window.TRoomPasskeys.authenticate('inventory'); currentSession(generation); await enter(await api('/passkey/handoff', { handoffToken: auth.handoff.handoffToken }), generation); } catch (e) { if (generation !== sessionGeneration && e.status !== 401) return; if (e.name === 'NotAllowedError') message('本人確認をキャンセルしました。'); else report(e); } finally { if (generation === sessionGeneration) { markBusy(false); $('login').disabled = false; } } });
    $('logout').addEventListener('click', async () => { if (busy || !allowClose()) return; const generation = sessionGeneration; markBusy(true); try { await api('/logout', {}); currentSession(generation); loginView(); message('ログアウトしました。'); } catch (e) { report(e); } finally { if (generation === sessionGeneration) markBusy(false); } });
    const generation = sessionGeneration;
    try { await enter(await api('/session'), generation); } catch (e) { if (!e.discarded) { loginView(); message(e.status === 401 ? '' : e.message); } }
  });
  window.addEventListener('popstate', () => {
    if (detail && !$('detail-view').hidden) detailPositions.set(positionKey(detail), window.scrollY);
    if ($('editor').open && history.state?.inventoryDialog !== openToken) { if (!approvedClose && !allowClose()) { history.go(1); return; } finishClose(); approvedClose = false; }
    if (busy) return; if (!$('app-view').hidden) void renderLocation().catch(report);
  });
  window.addEventListener('beforeunload', e => { if (dirty || busy) { e.preventDefault(); e.returnValue = ''; } });
  for (const type of ['pointerdown', 'keydown', 'touchstart', 'wheel']) window.addEventListener(type, event => { if (event.isTrusted) activity = Date.now(); }, { passive: true, capture: true });
})();

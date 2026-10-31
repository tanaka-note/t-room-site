export class HttpError extends Error {
  constructor(status, message, code = 'invalid') { super(message); this.status = status; this.code = code; }
}
export function text(value, limit, label = '入力内容', required = true) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (required && !value.trim())) throw new HttpError(400, `${label}を確認してください。`);
  return value.trim();
}
export function uuid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new HttpError(400, '操作IDを確認してください。');
  return value;
}
const MAX_AMOUNT = 90_000_000_000;
export function amount(value, signed = false) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_AMOUNT || (!signed && value <= 0)) throw new HttpError(400, '金額は範囲内の整数で入力してください。');
  return value;
}
export const jstDate = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
export const ASSET_START_MONTH = '2022-06';
export const ACCOUNT_ASSET_PRIORITY_MONTH = '2026-10';
export function date(value) {
  const parsed = typeof value === 'string' ? new Date(`${value}T00:00:00Z`) : new Date(NaN);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2199-12-31' || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new HttpError(400, '日付を確認してください。');
  return value;
}
export function monthEnd(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value < '1900-01' || value > '2199-12') throw new HttpError(400, '対象月を確認してください。');
  return new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5)), 0)).toISOString().slice(0, 10);
}
const definitions = {
  '収入': ['給与','賞与','売電収入','還付金・手当て等','贈与・援助（現物）','その他入金'],
  '食費': ['食費','食料品','外食','カフェ','デザート他','無人・自動販売機','その他食費'],
  '日用品': ['日用品','ドラッグストア','子育て用品','消耗品','その他日用品'],
  '趣味・娯楽': ['趣味','家族サービス','インドア','アウトドア','映画・音楽・ゲーム','旅行','その他趣味・娯楽'],
  '交際費': ['交際費','飲み会','プレゼント代','御祝・御見舞・香典','特別接待交際費','その他交際費'],
  '交通費': ['電車','バス','タクシー','駐車料金','その他交通費'],
  '衣服・美容': ['衣服','美容院・理髪','化粧品','クリーニング','その他衣服・美容'],
  '健康・医療': ['医療費','薬','フィットネス','その他健康・医療'],
  '自動車': ['ガソリン','駐車場','洗車・クリーニング','自動車保険','自動車税','その他自動車'],
  '教養・教育': ['習いごと','学費','書籍','その他教養・教育'],
  '特別な支出': ['家具家電・修理','その他特別な支出'],
  '現金・カード': ['使途不明金','カード引落し','その他現金・カード'],
  '水道・光熱費': ['電気代','ガス・灯油代','水道代','その他水道・光熱費'],
  '通信費': ['携帯電話','インターネット','情報サービス','その他デバイス','その他通信費'],
  '住宅': ['家賃・地代','ローン返済','管理費・積立金','その他住宅'],
  '税・社会保障': ['所得税・住民税','固定資産税','年金保険料','健康保険','その他税・社会保障'],
  '保険': ['生命保険','医療保険','その他保険'],
  'その他': ['買い物代行','事業経費','ATM手数料','雑費','その他'],
  '未分類': ['未分類']
};
// Money Forward ME's published category order. IDs remain unchanged for existing records/backups.
export const CATEGORY_ORDER = ['収入','食費','現金・カード','交通費','趣味・娯楽','日用品','衣服・美容','特別な支出','交際費','住宅','水道・光熱費','自動車','保険','税・社会保障','教養・教育','通信費','健康・医療','その他','未分類'];
export function orderedCategories(categories) {
  return [...categories].sort((a,b)=>CATEGORY_ORDER.indexOf(a.parent)-CATEGORY_ORDER.indexOf(b.parent)||Number(b.builtin)-Number(a.builtin)||(a.builtin&&b.builtin?Number(a.id.split('-').at(-1))-Number(b.id.split('-').at(-1)):a.name.localeCompare(b.name,'ja')));
}
export function defaultCategories() {
  return orderedCategories(Object.entries(definitions).flatMap(([parent, names], p) => names.map((name, n) => ({ id: `builtin-${p}-${n}`, parent, name, type: parent === '収入' ? 'income' : 'expense', builtin: true }))));
}
export function emptyData() {
  return { accounts: [], transactions: [], snapshots: [], historical: [], categories: defaultCategories() };
}
export function accountInput(input) {
  const items = input?.items;
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new HttpError(400, '口座の内訳は1〜100件で入力してください。');
  const seen = new Set();
  const row = { id: uuid(input.id), name: text(input.name, 80, '口座名'), type: text(input.type || 'その他', 40, '口座の種類'), archived: input.archived === true,
    items: items.map(item => { const id = uuid(item?.id); if (seen.has(id)) throw new HttpError(400, '内訳が重複しています。'); seen.add(id); return { id, name: text(item.name, 80, '内訳名'), amount: amount(item.amount, true) }; }) };
  if (input.historyId) row.historyId = text(input.historyId, 100, '過去チャートの口座');
  if (input.balances !== undefined) {
    if (!Array.isArray(input.balances) || input.balances.length > 3600) throw new HttpError(400, '残高履歴の件数を確認してください。');
    const dates = new Set();
    row.balances = input.balances.map(balance => {
      const asOf = balanceDate(balance?.date);
      if (dates.has(asOf)) throw new HttpError(400, '同じ基準日の残高が重複しています。');
      dates.add(asOf);
      return { date: asOf, items: accountInput({ ...row, items: balance.items }).items };
    }).sort((a,b) => a.date.localeCompare(b.date));
    if (row.balances.length) row.items = structuredClone(row.balances.at(-1).items);
  }
  return row;
}
function balanceDate(value) {
  const asOf = date(value);
  if (asOf < `${ASSET_START_MONTH}-30`) throw new HttpError(400, '資産残高の基準日は2022年6月30日以降を指定してください。');
  if (asOf > jstDate()) throw new HttpError(400, '残高の基準日は今日以前を指定してください。');
  return asOf;
}

// Dated balances are the source of truth. Monthly values are projections, never editable records.
export function assetHistory(data, today = jstDate()) {
  const legacy = [...new Map([...data.historical.map(s=>({...s,historical:true})), ...data.snapshots.map(s=>({...s,historical:false}))].map(s=>[s.month,s])).values()];
  const result = new Map(legacy.map(s=>[s.month,s]));
  const dates = data.accounts.flatMap(a=>(a.balances || []).map(b=>b.date)).sort();
  if (!dates.length) return legacy.sort((a,b)=>a.month.localeCompare(b.month));
  const first = dates[0].slice(0,7), last = today.slice(0,7), cursors = new Map();
  for (let month = first; month <= last;) {
    const end = monthEnd(month), cutoff = end < today ? end : today;
    const accounts = [], missing = [];
    for (const account of data.accounts) {
      const balances = account.balances || [];
      let index = cursors.get(account.id) ?? -1;
      while (index+1 < balances.length && balances[index+1].date <= cutoff) index++;
      cursors.set(account.id,index);
      const selected = balances[index];
      if (!selected) { if (!balances.length && !account.archived) missing.push(account.id); continue; }
      const value = selected.items.reduce((sum,item)=>sum+item.amount,0);
      if (!Number.isSafeInteger(value)) throw new HttpError(400, '合計金額が大きすぎます。');
      accounts.push({id:account.historyId || account.id,name:account.name,amount:value,asOf:selected.date});
    }
    // Keep imported months through September 2026. From October onward, dated
    // account balances take priority, including corrections and later imports.
    // Only the projection changes; stored imports remain available in backups.
    if ((!result.has(month) || month >= ACCOUNT_ASSET_PRIORITY_MONTH) && accounts.length) {
      const total = accounts.reduce((sum,a)=>sum+a.amount,0);
      if (!Number.isSafeInteger(total)) throw new HttpError(400, '合計金額が大きすぎます。');
      result.set(month,{id:month,month,date:end,accounts,total:missing.length?null:total,missing,derived:true,provisional:end>today});
    }
    month = new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),1)).toISOString().slice(0,7);
  }
  return [...result.values()].sort((a,b)=>a.month.localeCompare(b.month));
}
export function transactionInput(input, data) {
  if (!['income', 'expense', 'transfer'].includes(input?.type)) throw new HttpError(400, '収支の種類を確認してください。');
  for (const field of ['accountId', 'toAccountId']) if (input[field] && !data.accounts.some(a => a.id === input[field])) throw new HttpError(400, '口座を確認してください。');
  if (input.type === 'transfer' && (!input.accountId || !input.toAccountId || input.accountId === input.toAccountId)) throw new HttpError(400, '振替元と振替先には異なる口座を選んでください。');
  const category = data.categories.find(c => c.id === input.categoryId);
  if (input.type !== 'transfer' && (!category || category.type !== input.type)) throw new HttpError(400, '分類を確認してください。');
  return { id: uuid(input.id), date: date(input.date), type: input.type, amount: amount(input.amount), description: text(input.description || '', 300, '内容', false),
    notes: text(input.notes || '', 1000, 'メモ', false), categoryId: input.type === 'transfer' ? null : category.id,
    accountId: input.accountId || null, toAccountId: input.type === 'transfer' ? input.toAccountId : null, included: input.included !== false };
}
export function snapshotInput(input, historical = false) {
  const end = monthEnd(input?.month);
  if (input.month < ASSET_START_MONTH) throw new HttpError(400, '資産推移は2022年6月末以降の記録を指定してください。');
  const sourceAsOf = historical && input.sourceAsOf ? balanceDate(input.sourceAsOf) : null;
  if (sourceAsOf && sourceAsOf.slice(0,7) !== input.month) throw new HttpError(400, '取得日と対象月を確認してください。');
  if (end > jstDate() && !sourceAsOf) throw new HttpError(400, '月末を迎えた月を選んでください。');
  if (!Array.isArray(input.accounts) || input.accounts.length > 200) throw new HttpError(400, '月末残高を確認してください。');
  const seen = new Set();
  const accounts = input.accounts.map(a => { const id = text(a?.id, 100, '口座ID'); if (seen.has(id)) throw new HttpError(400, '口座が重複しています。'); seen.add(id);
    return { id, name: text(a.name, 80, '口座名'), amount: amount(a.amount, true) }; });
  const total = accounts.reduce((sum, a) => sum + a.amount, 0);
  if (!Number.isSafeInteger(total)) throw new HttpError(400, '合計金額が大きすぎます。');
  return { id: input.month, month: input.month, date: end, accounts, total,
    ...(historical ? { source: 'moneyforward', notes: text(input.notes || '', 500, '記録メモ', false), ...(sourceAsOf ? {sourceAsOf} : {}) } : {}) };
}
export function mutateData(data, operation, value) {
  // Retain unchanged record identities so persistence can reuse their JSON.
  const next = Object.fromEntries(Object.entries(data).map(([kind,rows])=>[kind,[...rows]]));
  const upsert = (list, row) => { const index = list.findIndex(r => r.id === row.id); if (index < 0) list.push(row); else list[index] = row; };
  if (operation === 'transaction.save') {
    if (!['income','expense'].includes(value?.type)) throw new HttpError(400,'収入または支出を選んでください。');
    const category = next.categories.find(c=>c.id===value.categoryId);
    const categoryId = category?.parent==='未分類' ? next.categories.find(c=>c.parent==='その他'&&c.name==='その他')?.id : value.categoryId;
    const parsed=transactionInput({...value,categoryId},next);
    upsert(next.transactions, {...parsed,accountId:null,toAccountId:null,included:true});
  }
  else if (operation === 'transaction.delete') next.transactions = next.transactions.filter(t => t.id !== uuid(value?.id));
  else if (operation === 'account.save') {
    const existing = next.accounts.find(a=>a.id===value?.id);
    if (value?.historyId && value.historyId !== existing?.historyId) throw new HttpError(400, '口座の対応付け機能は利用できません。');
    // Keep any legacy backup metadata intact; new account links are no longer accepted.
    const row = accountInput({ ...value, historyId: existing?.historyId, balances: existing?.balances || [] });
    const asOf = balanceDate(value?.asOf);
    const submitted = accountInput({ ...value, balances: undefined }).items;
    const balances = row.balances.filter(b=>b.date!==asOf);
    balances.push({date:asOf,items:submitted});
    row.balances = balances.sort((a,b)=>a.date.localeCompare(b.date));
    if (row.balances.length > 3600) throw new HttpError(400, '残高履歴の件数が上限に達しました。');
    row.items = structuredClone(row.balances.at(-1).items);
    if (row.archived && row.items.some(i => i.amount !== 0)) throw new HttpError(400, '残高のある口座は保管できません。');
    if (!next.accounts.some(a => a.id === row.id) && next.accounts.length >= 200) throw new HttpError(400, '口座数の上限に達しました。');
    upsert(next.accounts, row);
  } else if (['snapshot.save','snapshot.delete','historical.save','historical.delete'].includes(operation)) throw new HttpError(400, '資産推移は自動集計です。口座画面から基準日と残高を入力してください。');
  else if (operation === 'category.save') {
    const existing = next.categories.find(c => c.id === value?.id);
    if (existing?.builtin) throw new HttpError(400, '標準の分類は変更できません。');
    const parent = text(value?.parent, 50, '大項目');
    if (!Object.hasOwn(definitions, parent)) throw new HttpError(400, '大項目を確認してください。');
    const row = { id: uuid(value.id), parent, name: text(value.name, 60, '中項目'), type: parent === '収入' ? 'income' : 'expense', builtin: false };
    if (next.categories.some(c => c.id !== row.id && c.parent === row.parent && c.name === row.name)) throw new HttpError(400, '同じ分類が登録されています。');
    if (next.transactions.some(t => t.categoryId === row.id && t.type !== row.type)) throw new HttpError(400, '使用中の分類の収支区分は変更できません。');
    upsert(next.categories, row);
  } else if (operation === 'category.delete') {
    const id = uuid(value?.id), existing = next.categories.find(c => c.id === id);
    if (existing?.builtin || next.transactions.some(t => t.categoryId === id)) throw new HttpError(400, '標準または使用中の分類は削除できません。');
    next.categories = next.categories.filter(c => c.id !== id);
  } else throw new HttpError(400, '操作を確認してください。');
  if (next.transactions.length > 20000 || next.categories.length > 500) throw new HttpError(400, '登録件数の上限に達しました。');
  return next;
}
export function records(data) { return Object.entries(data).flatMap(([kind, rows]) => rows.map(row => ({ kind, id: row.id, payload: JSON.stringify(row) }))); }
export function dataFromRecords(rows) {
  const data = { accounts: [], transactions: [], snapshots: [], historical: [], categories: [] };
  for (const row of rows) if (Object.hasOwn(data, row.kind)) data[row.kind].push(JSON.parse(row.payload));
  data.categories=orderedCategories(data.categories);
  return data;
}
export function backup(data) { return { format: 'troom-household', version: 2, exportedAt: new Date().toISOString(), data }; }
export function restoreInput(input) {
  if (input?.format !== 'troom-household' || ![1,2].includes(input.version) || !input.data || typeof input.data !== 'object') throw new HttpError(400, '家計簿のバックアップファイルを選んでください。');
  const raw = input.data, data = { accounts: [], transactions: [], snapshots: [], historical: [], categories: [] };
  const limits = { accounts: 200, transactions: 20000, snapshots: 3600, historical: 3600, categories: 500 };
  for (const [key, max] of Object.entries(limits)) if (!Array.isArray(raw[key]) || raw[key].length > max) throw new HttpError(400, 'バックアップの形式・件数を確認してください。');
  const standard = defaultCategories();
  const seen = new Set();
  for (const c of raw.categories) {
    if (seen.has(c?.id)) throw new HttpError(400, '分類IDが重複しています。'); seen.add(c?.id);
    const builtin = standard.find(s => s.id === c?.id);
    if (builtin) { if (['id','parent','name','type','builtin'].some(key=>builtin[key]!==c[key])) throw new HttpError(400, '標準分類が変更されています。'); data.categories.push(builtin); }
    else { const updated = mutateData({ ...data, transactions: [] }, 'category.save', c); data.categories = updated.categories; }
  }
  if (standard.some(s => !seen.has(s.id))) throw new HttpError(400, '標準分類が不足しています。');
  for (const key of ['accounts', 'transactions', 'snapshots', 'historical']) {
    seen.clear();
    for (const row of raw[key]) {
      if (seen.has(row?.id)) throw new HttpError(400, '記録IDが重複しています。'); seen.add(row?.id);
      const parsed = key === 'accounts' ? accountInput(row) : key === 'transactions' ? transactionInput(row, data) : snapshotInput(row, key === 'historical');
      if (parsed.id !== row.id) throw new HttpError(400, '記録IDを確認してください。');
      data[key].push(parsed);
    }
  }
  const links = new Set();
  for (const account of data.accounts) if (account.historyId) {
    if (links.has(account.historyId) || ![...data.historical,...data.snapshots].some(s=>s.accounts.some(a=>a.id===account.historyId))) throw new HttpError(400, '過去チャートの対応付けを確認してください。');
    links.add(account.historyId);
  }
  return data;
}
export function csv(data) {
  const escape = value => { let s = String(value ?? ''); if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replaceAll('"', '""')}"`; };
  const rows = [['計算対象','日付','内容','金額（円）','口座','大項目','中項目','メモ','振替','振替先','ID']];
  for (const t of [...data.transactions].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    const c = data.categories.find(c => c.id === t.categoryId);
    rows.push([t.type==='transfer' ? 0 : 1,t.date,t.description,t.type === 'income' ? t.amount : -t.amount,data.accounts.find(a => a.id === t.accountId)?.name || '',c?.parent==='未分類'?'その他':c?.parent || '',c?.parent==='未分類'?'その他':c?.name || '',t.notes,t.type === 'transfer' ? 1 : 0,data.accounts.find(a => a.id === t.toAccountId)?.name || '',t.id]);
  }
  return '\ufeff' + rows.map(row => row.map(escape).join(',')).join('\r\n');
}

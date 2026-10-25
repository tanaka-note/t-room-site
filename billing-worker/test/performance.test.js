import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, payload } from './performance-fixture.mjs';

const summaryPath = 'summary?accountId=chiharu&month=2026-10';

test('handoff and session resume keep their synchronous audit boundary', async () => {
  const f = fixture();
  try {
    let cookie;
    for (const type of ['passkey_login_success','session_resume']) {
      let reached, release, settled = false;
      const entered = new Promise(resolve=>{reached=resolve;});
      const gate = new Promise(resolve=>{release=resolve;});
      f.env.SECURITY.recordAuditEvent = async event => { assert.equal(event.eventType,type); reached(); await gate; };
      const task = (type === 'session_resume' ? f.request('session',cookie) : f.login()).then(result=>{settled=true;return result;});
      await entered; assert.equal(settled,false);
      release(); const result = await task; assert.equal(result.status,200);
      if(result.cookie)cookie=result.cookie;
    }
  } finally { f.close(); }
});

test('GET validation is request-local; session/excluded, inactive and error requests never touch', async () => {
  const f = fixture();
  try {
    const login = await f.login();
    assert.equal(login.status, 200);
    assert.deepEqual(f.metrics.audits, ['passkey_login_success']);
    assert.match(login.headers.get('set-cookie'), /Max-Age=43200; HttpOnly; SameSite=Strict; Secure/);
    for (const [path, active, status, actions] of [
      ['session', true, 200, ['read']], ['accounts', true, 200, ['read', 'touch']],
      [summaryPath, true, 200, ['read', 'touch']], ['accounts', false, 200, ['read']],
      ['missing', true, 404, ['read']], ['accounts?includeSummary=1&month=2026-10', true, 200, ['read', 'touch']]
    ]) {
      f.reset();
      const r = await f.request(path, login.cookie, { active });
      assert.equal(r.status, status);
      assert.deepEqual(f.metrics.rpc.map(r => r.action), actions);
      assert.equal(f.metrics.security.sql.length, actions.includes('touch') ? 3 : 1, 'live Security validation has a bounded SQL budget');
      if (!actions.includes('touch')) assert.equal(r.cookie, undefined);
      if (path === summaryPath) { assert.equal(f.metrics.billing.sql.length, 7); assert.equal(f.metrics.billing.batches, 1); }
      if (path === 'session') assert.deepEqual(f.metrics.audits, ['session_resume']);
    }
    f.securityDb.exec("UPDATE security_credentials SET status='revoked'");
    assert.equal((await f.request('accounts', login.cookie)).status, 401, 'no cross-request validation cache');
  } finally { f.close(); }
});

const revoke = {
  credential: f => f.securityDb.exec("UPDATE security_credentials SET status='revoked'"),
  identity: f => f.securityDb.exec("UPDATE security_identities SET status='disabled'"),
  link: f => f.securityDb.exec("UPDATE security_service_links SET status='disabled'"),
  epoch: f => f.securityDb.exec('UPDATE security_runtime_state SET passkey_session_epoch=2'),
  ended: f => f.securityDb.exec('UPDATE security_active_sessions SET ended_at=CURRENT_TIMESTAMP'),
  expired: f => f.securityDb.exec('UPDATE security_active_sessions SET expires_at=0'),
  accountVersion: f => f.db.exec('UPDATE billing_accounts SET session_version=2'),
  role: f => f.db.exec("UPDATE billing_accounts SET role='member' WHERE id='owner'"),
  inactiveAccount: f => f.db.exec("UPDATE billing_accounts SET is_active=0 WHERE id='owner'"),
  globalVersion: f => { f.env.SESSION_VERSION = '4'; },
  disabled: f => { f.security.env.PASSKEY_ENABLED = 'false'; },
  failure: f => { f.security.passkeyRollingSession = async () => { throw Error('fixture unavailable'); }; }
};
for (const [name, change] of Object.entries(revoke)) {
  for (const stage of ['before read', 'before release']) test(`${name}: ${stage} rejects without protected body or renewal`, async () => {
    const f = fixture();
    try {
      const { cookie } = await f.login();
      if (stage === 'before read') change(f);
      else f.beforeTouch = () => change(f);
      const r = await f.request(summaryPath, cookie);
      assert.equal(r.status, 401);
      assert.equal(r.cookie, undefined);
      assert.equal(r.body.entries, undefined);
      assert.equal(r.body.openingBalanceYen, undefined);
    } finally { f.close(); }
  });
}

test('legacy GET retains its final read, and rolling mutations use read/touch', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.login();
    const legacy = payload(cookie); delete legacy.rollingSessionVersion;
    let validations = 0;
    const original = f.env.SECURITY.validatePasskeySession;
    f.env.SECURITY.validatePasskeySession = async input => {
      const result = await original(input);
      if (++validations === 1) revoke.credential(f);
      return result;
    };
    assert.equal((await f.request(summaryPath, f.sign(legacy))).status, 401);
    assert.equal(validations, 2);
    f.securityDb.exec("UPDATE security_credentials SET status='active'");
    f.reset();
    const r = await f.request('entries', cookie, { method: 'POST', body: {
      accountId: 'chiharu', documentType: 'invoice', entryDate: '2026-10-01', category: 'purchase', amountYen: 100, description: 'Fixture'
    } });
    assert.equal(r.status, 201);
    assert.deepEqual(f.metrics.rpc.map(r => r.action), ['read', 'touch']);
    assert.equal(f.metrics.security.sql.length, 3);
    // Revoke during a mutation: its final touch must fail closed. This cannot
    // undo a completed write; the original two-phase API has the same limit.
    f.afterRead = () => { revoke.credential(f); f.afterRead = null; };
    assert.equal((await f.request('entries', cookie, { method: 'POST', body: {
      accountId: 'chiharu', documentType: 'invoice', entryDate: '2026-10-02', category: 'purchase', amountYen: 100, description: 'Fixture'
    } })).status, 401);
  } finally { f.close(); }
});

test('twelve-hour rolling preserves claims and logout cannot be replayed', async () => {
  const f = fixture(), RealDate = Date;
  let now = RealDate.now();
  globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  try {
    const login = await f.login(), original = payload(login.cookie);
    now += 11 * 3600000;
    const renewed = await f.request('accounts', login.cookie);
    assert.equal(renewed.status, 200);
    const next = payload(renewed.cookie);
    assert.equal(next.exp, Math.floor(now / 1000) + 43200);
    for (const key of Object.keys(original).filter(k => k !== 'exp')) assert.equal(next[key], original[key], key);
    now += 2 * 3600000;
    assert.equal((await f.request('accounts', renewed.cookie)).status, 200, 'beyond original expiry');
    assert.equal((await f.request('accounts', login.cookie)).status, 401, 'old expired cookie cannot revive');
    assert.equal((await f.request('logout', renewed.cookie, { method: 'POST', body: {} })).status, 200);
    assert.equal((await f.request('accounts', renewed.cookie)).status, 401);
  } finally { globalThis.Date = RealDate; f.close(); }
});

function reference(f, account, month) {
  const start = `${month}-01`, next = new Date(`${start}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
  const end = next.toISOString().slice(0, 10);
  const documents = f.db.prepare("SELECT * FROM billing_entries WHERE account_id=? AND deleted_at IS NULL AND category!='income'").all(account);
  const settlements = f.db.prepare('SELECT * FROM billing_settlements WHERE account_id=? AND deleted_at IS NULL').all(account);
  const before = date => documents.filter(e => e.entry_date < date).reduce((n, e) => n + (e.document_type === 'invoice' ? e.amount_yen : -e.amount_yen), 0)
    + settlements.filter(s => s.settlement_date < date).reduce((n, s) => n + (s.method === 'offset' ? 0 : s.direction === 'incoming' ? -s.amount_yen : s.amount_yen), 0);
  return { opening: before(start), closing: before(end), entries: documents.filter(e => e.entry_date >= start && e.entry_date < end).map(e => e.id).sort((a,b) => a-b),
    settlements: settlements.filter(s => s.settlement_date >= start && s.settlement_date < end).map(s => s.id).sort((a,b) => a-b) };
}

test('all admin targets, history, financial signs and CRUD recalculate against an independent ledger', async () => {
  const f = fixture();
  try {
    const { cookie } = await f.login();
    const accounts = (await f.request('accounts', cookie)).body.accounts;
    const entry = f.db.prepare("INSERT INTO billing_entries(account_id,document_type,entry_date,category,amount_yen,description,created_by,deleted_at) VALUES(?,?,?,?,?,'Fixture','owner',?)");
    const settlement = f.db.prepare("INSERT INTO billing_settlements(account_id,settlement_date,direction,method,amount_yen,created_by,deleted_at) VALUES(?,?,?,?,?,'owner',?)");
    for (const a of accounts) for (const date of ['2025-12-31','2026-01-01','2026-09-30','2026-10-01','2026-10-31','2026-11-01']) {
      for (const type of ['invoice','payment_notice']) for (const [category, amount] of [['purchase',1000],['offset',-10],['other',-3],['other',9],['income',-50], ...(type === 'invoice' ? [['discount',-5]] : [])]) {
        entry.run(a.id, type, date, category, amount, null); entry.run(a.id, type, date, category, amount, '2026-10-01');
      }
      for (const direction of ['incoming','outgoing']) for (const method of ['cash','bank_transfer','offset','other','unspecified']) {
        settlement.run(a.id,date,direction,method,7,null); settlement.run(a.id,date,direction,method,7,'2026-10-01');
      }
    }
    async function compare(account, month) {
      const r = await f.request(`summary?accountId=${account}&month=${month}`, cookie);
      assert.equal(r.status, 200);
      const expected = reference(f, account, month);
      assert.equal(r.body.openingBalanceYen, expected.opening); assert.equal(r.body.closingBalanceYen, expected.closing);
      assert.deepEqual(r.body.entries.map(e => e.id).sort((a,b)=>a-b), expected.entries);
      assert.deepEqual(r.body.settlements.map(s => s.id).sort((a,b)=>a-b), expected.settlements);
      assert.equal(r.body.settlementTotals.offsetYen, r.body.settlements.filter(s=>s.method==='offset').reduce((n,s)=>n+s.amountYen,0));
    }
    for (const a of accounts) for (const month of ['2025-11','2025-12','2026-01','2026-09','2026-10','2026-11']) await compare(a.id,month);
    for (const kind of ['entries','settlements']) {
      const body = kind === 'entries' ? { accountId:'chiharu', documentType:'invoice', entryDate:'2026-10-04', category:'purchase', amountYen:123, description:'Fixture' }
        : { accountId:'chiharu', settlementDate:'2026-10-04', direction:'incoming', method:'cash', amountYen:123 };
      const created = await f.request(kind, cookie, { method:'POST', body }); assert.equal(created.status,201); await compare('chiharu','2026-10');
      assert.equal((await f.request(`${kind}/${created.body.id}`,cookie,{method:'PUT',body:{...body,amountYen:456}})).status,200); await compare('chiharu','2026-10');
      assert.equal((await f.request(`${kind}/${created.body.id}`,cookie,{method:'DELETE',body:{}})).status,200); await compare('chiharu','2026-10');
    }
    const initial = await f.request('accounts?includeSummary=1&month=2026-10', cookie);
    assert.equal(initial.status,200); assert.equal(initial.body.summary.account.id,accounts[0].id);
    assert.deepEqual(initial.body.summary, (await f.request(`summary?accountId=${accounts[0].id}&month=2026-10`,cookie)).body);
    assert.ok(f.metrics.audits.includes('admin_access'));
    const member = await f.login('chiharu');
    assert.deepEqual((await f.request('accounts', member.cookie)).body.accounts.map(a=>a.id), ['chiharu']);
    assert.equal((await f.request('summary?accountId=masami&month=2026-10',member.cookie)).body.account.id, 'chiharu');
    assert.equal((await f.request('accounts?includeSummary=1&accountId=masami&month=2026-10',member.cookie)).body.summary.account.id,'chiharu');
    for (const method of ['POST','PUT','DELETE']) assert.equal((await f.request(method === 'POST' ? 'entries' : 'entries/1',member.cookie,{method,body:{}})).status,403);
  } finally { f.close(); }
});

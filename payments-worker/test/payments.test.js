import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentInput, paymentView, currentJstMonth } from '../src/domain.js';
import { fixture, payments } from './fixture.js';
const input = (extra = {}) => ({ paidOn: '2026-10-20', payee: 'Sample Service', description: 'Annual plan', amount: 12000, startMonth: '2026-10', months: 12, notes: '', ...extra });
test('year boundaries, inclusive months, rounding and Japan month boundary', () => {
  const view = paymentView({ amount: 10000, start_month: '2026-10', months: 12 }, '2026-10');
  assert.equal(view.end_month, '2027-09'); assert.equal(view.remaining_months, 12);
  assert.equal(paymentView({ amount: 10000, start_month: '2026-10', months: 12 }, '2027-09').remaining_months, 1);
  assert.equal(paymentView({ amount: 10000, start_month: '2026-10', months: 12 }, '2027-10').status, 'completed');
  assert.equal(paymentView({ amount: 10000, start_month: '2026-10', months: 3 }, '2026-09').remaining_months, 3);
  assert.equal(paymentView({ amount: 10000, start_month: '2026-12', months: 3 }, '2026-12').end_month, '2027-02');
  assert.equal(currentJstMonth(new Date('2026-10-31T15:00:00Z')), '2026-11');
  assert.equal(currentJstMonth(new Date('2026-10-31T14:59:59Z')), '2026-10');
  assert.equal(paymentInput(input({ paidOn: '2024-02-29' })).paidOn, '2024-02-29');
  for (const extra of [{ amount: 0 }, { amount: '100' }, { amount: 1.2 }, { months: 0 }, { months: 1.5 }, { months: 1201 }, { paidOn: '2026-02-29' }, { startMonth: '2026-13' }, { startMonth: '9999-12', months: 2 }, { payee: ' ' }, { notes: 'x'.repeat(2001) }]) assert.throws(() => paymentInput(input(extra)), e => e.status === 400);
});
test('CRUD, lost-response retries and stale edits/deletes remain atomic', async () => {
  const f = fixture(); try {
    await f.login(); const requestId = crypto.randomUUID(), body = { ...input(), requestId };
    assert.equal((await f.request('/api/entries', body)).status, 200);
    assert.equal((await f.request('/api/entries', body)).status, 200);
    assert.equal((await f.request('/api/entries', { ...body, amount: 1 })).status, 409);
    let result = await (await f.request('/api/entries')).json(); assert.equal(result.entries.length, 1); assert.equal(result.entries[0].monthly_amount, 1000);
    const id = result.entries[0].id;
    const update = { ...input({ amount: 10000, months: 3 }), expectedVersion: 1, requestId: crypto.randomUUID() };
    assert.equal((await f.request(`/api/entries/${id}`, update, {}, 'PUT')).status, 200);
    assert.equal((await f.request(`/api/entries/${id}`, update, {}, 'PUT')).status, 200);
    assert.equal((await f.request(`/api/entries/${id}`, { ...update, requestId: crypto.randomUUID() }, {}, 'PUT')).status, 409);
    assert.equal((await f.request(`/api/entries/${id}`, { expectedVersion: 1, requestId: crypto.randomUUID() }, {}, 'DELETE')).status, 409);
    const deletion = { expectedVersion: 2, requestId: crypto.randomUUID() };
    assert.equal((await f.request(`/api/entries/${id}`, deletion, {}, 'DELETE')).status, 200);
    assert.equal((await f.request(`/api/entries/${id}`, deletion, {}, 'DELETE')).status, 200);
    result = await (await f.request('/api/entries')).json(); assert.equal(result.entries.length, 0);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM payments_entries WHERE deleted_at IS NOT NULL').get().n, 1);
    assert.equal((await f.request(`/api/entries/${id}`, { ...update, expectedVersion: 3, requestId: crypto.randomUUID() }, {}, 'PUT')).status, 404);
  } finally { f.close(); }
});
test('passkey-only authorization, session revocation, CSRF and input boundaries', async () => {
  const f = fixture(); try {
    assert.equal((await f.request('/api/entries')).status, 401);
    await f.login(); const originalCookie = f.cookie;
    assert.equal((await f.request('/api/entries', { ...input(), requestId: crypto.randomUUID() }, { Origin: 'https://other.test' })).status, 403);
    assert.equal((await f.request('/api/entries', { ...input({ amount: -1 }), requestId: crypto.randomUUID() })).status, 400);
    assert.equal((await f.request('/api/entries', { ...input(), requestId: crypto.randomUUID() }, { 'Content-Type': 'text/plain' })).status, 403);
    f.cookie += 'broken'; assert.equal((await f.request('/api/entries')).status, 401); f.cookie = originalCookie;
    assert.equal((await f.request('/api/logout', {})).status, 200);
    f.cookie = originalCookie; assert.equal((await f.request('/api/entries')).status, 401);
    f.renewHandoff(); await f.login(); f.setActive(false); assert.equal((await f.request('/api/entries')).status, 401);
    f.setActive(true); f.env.PASSKEY_ENABLED = 'false'; assert.equal((await f.request('/api/entries')).status, 401);
    assert.equal((await f.request('/api/login', { password: 'fixture' })).status, 401);
  } finally { f.close(); }
});
test('cannot log in using another Identity or use the account integration for extra accounts', async () => {
  const f = fixture(); try {
    f.env.SECURITY.redeemHandoff = async () => ({ identityId: 'someone-else', serviceAccountId: 'owner' });
    assert.equal((await f.request('/api/passkey/handoff', { handoffToken: 'fixture-handoff' })).status, 401);
    const integration = new payments.SecurityIntegration({}, f.env);
    assert.equal((await integration.listLinkTargets()).targets.length, 1);
    assert.equal((await integration.describeAccount({ accountId: 'other' })).valid, false);
    assert.throws(() => f.sqlite.prepare('INSERT INTO payments_accounts(id,display_name) VALUES(?,?)').run('other', 'Other'));
  } finally { f.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, inventory } from './fixture.js';
import { occurredAt, yearBounds, quantity } from '../src/domain.js';
const requestId = () => crypto.randomUUID();
async function result(f, path, body, status = 200) { const r = await f.request(path, body); const value = await r.json(); assert.equal(r.status, status, JSON.stringify(value)); return value; }
const create = (f, stock = 10) => result(f, '/api/items', { name: 'サンプル消耗品', unit: '個', stock, requestId: requestId() });
const record = (f, id, kind, amount, time = '2026-01-01T00:00:00+09:00', extra = {}) => result(f, `/api/items/${id}/movements`, { kind, quantity: amount, occurredAt: time, requestId: requestId(), ...extra });

test('stock, annual use, zero months, adjustment and cancellation have independent meanings', async () => {
  const f = fixture(); try { await f.login(); const { itemId } = await create(f); await record(f, itemId, 'restock', 3); const use = await record(f, itemId, 'use', 2);
    let value = await result(f, `/api/items/${itemId}?year=2026`); assert.equal(value.item.stock, 11); assert.equal(value.annualUsage, 2); assert.equal(value.months.length, 12); assert.equal(value.months[0].used, 2); assert.equal(value.months[11].used, 0);
    await record(f, itemId, 'adjust', 20, undefined, { expectedVersion: value.item.version }); value = await result(f, `/api/items/${itemId}?year=2026`); assert.equal(value.item.stock, 20); assert.equal(value.annualUsage, 2);
    await result(f, `/api/movements/${use.movementId}/void`, { requestId: requestId() }); value = await result(f, `/api/items/${itemId}?year=2026`); assert.equal(value.item.stock, 22); assert.equal(value.annualUsage, 0);
    const sum = f.sqlite.prepare('SELECT SUM(quantity_delta) AS n FROM inventory_movements WHERE item_id=? AND voided_at IS NULL').get(itemId).n; assert.equal(sum, value.item.stock);
  } finally { f.close(); }
});
test('Japan month and year boundaries use occurrence time, including backdated records', async () => {
  const f = fixture(); try { await f.login(); const { itemId } = await create(f, 30); await record(f, itemId, 'use', 1, '2025-12-31T14:59:59Z'); await record(f, itemId, 'use', 2, '2025-12-31T15:00:00Z'); await record(f, itemId, 'use', 3, '2026-01-31T15:00:00Z');
    assert.equal((await result(f, `/api/items/${itemId}?year=2025`)).annualUsage, 1);
    const value = await result(f, `/api/items/${itemId}?year=2026`); assert.equal(value.annualUsage, 5); assert.equal(value.months[0].used, 2); assert.equal(value.months[1].used, 3);
  } finally { f.close(); }
});
test('double sends replay one result; changed payloads conflict; failed mutations roll back request and stock', async () => {
  const f = fixture(); try { await f.login(); const body = { name: 'Sample', unit: '枚', stock: 1, requestId: requestId() };
    const first = await result(f, '/api/items', body); assert.deepEqual(await result(f, '/api/items', body), first); await result(f, '/api/items', { ...body, stock: 2 }, 409);
    const use = { kind: 'use', quantity: 2, occurredAt: '2026-01-02T00:00:00Z', requestId: requestId() }; await result(f, `/api/items/${first.itemId}/movements`, use, 409);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_requests WHERE request_id=?').get(use.requestId).n, 0); assert.equal((await result(f, `/api/items/${first.itemId}?year=2026`)).item.stock, 1);
    use.quantity = 1; const a = await result(f, `/api/items/${first.itemId}/movements`, use); assert.deepEqual(await result(f, `/api/items/${first.itemId}/movements`, use), a);
  } finally { f.close(); }
});
test('simultaneous requests cannot consume more stock than exists', async () => {
  const f = fixture(); try { await f.login(); const { itemId } = await create(f, 1); const responses = await Promise.all([1, 2].map(() => f.request(`/api/items/${itemId}/movements`, { kind: 'use', quantity: 1, occurredAt: '2026-01-02T00:00:00Z', requestId: requestId() })));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]); assert.equal((await result(f, `/api/items/${itemId}?year=2026`)).item.stock, 0);
  } finally { f.close(); }
});
test('adjustment rejects a stale version and cancellation cannot create negative stock', async () => {
  const f = fixture(); try { await f.login(); const { itemId, movementId: opening } = await create(f, 0); const restock = await record(f, itemId, 'restock', 2); const old = (await result(f, `/api/items/${itemId}?year=2026`)).item;
    await record(f, itemId, 'use', 1); await result(f, `/api/items/${itemId}/movements`, { kind: 'adjust', quantity: 8, expectedVersion: old.version, occurredAt: '2026-01-01T00:00:00Z', requestId: requestId() }, 409);
    await result(f, `/api/movements/${restock.movementId}/void`, { requestId: requestId() }, 409); await result(f, `/api/movements/${opening}/void`, { requestId: requestId() }, 409);
    assert.equal((await result(f, `/api/items/${itemId}?year=2026`)).item.stock, 1);
  } finally { f.close(); }
});
test('archive requires zero stock and retains annual history; pagination handles identical dates', async () => {
  const f = fixture(); try { await f.login(); const { itemId } = await create(f, 51); await result(f, `/api/items/${itemId}/archive`, { requestId: requestId() }, 409);
    for (let i = 0; i < 51; i++) await record(f, itemId, 'use', 1);
    const first = await result(f, `/api/items/${itemId}?year=2026`); assert.equal(first.movements.length, 50); assert.ok(first.nextCursor);
    const second = await result(f, `/api/items/${itemId}?year=2026&before=${encodeURIComponent(first.nextCursor)}`); assert.equal(second.movements.length, 2); assert.equal(new Set([...first.movements, ...second.movements].map(m => m.id)).size, 52);
    await result(f, `/api/items/${itemId}/archive`, { requestId: requestId() }); const archived = await result(f, `/api/items/${itemId}?year=2026`); assert.ok(archived.item.archived_at); assert.equal(archived.annualUsage, 51);
    await result(f, `/api/items/${itemId}/movements`, { kind: 'restock', quantity: 1, occurredAt: '2026-01-01T00:00:00Z', requestId: requestId() }, 409);
    await result(f, `/api/movements/${first.movements.find(m => m.kind === 'use').id}/void`, { requestId: requestId() });
    const restored = await result(f, `/api/items/${itemId}?year=2026`); assert.equal(restored.item.stock, 1); assert.equal(restored.item.archived_at, null); assert.equal(restored.annualUsage, 50);
  } finally { f.close(); }
});
test('authentication is fail-closed and tokens, sessions and CSRF are service bound', async () => {
  const f = fixture(); try {
    assert.equal((await f.request('/api/items')).status, 401); const login = await f.login(); assert.match(login.headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict; Secure/); assert.match(login.headers.get('Set-Cookie'), /Max-Age=43200/);
    assert.equal((await f.request('/api/passkey/handoff', { handoffToken: 'fixture-handoff' })).status, 401);
    assert.equal((await f.request('/api/items', { requestId: requestId() }, { Origin: 'https://evil.test' })).status, 403);
    assert.equal((await f.request('/api/items')).headers.get('Cache-Control'), 'no-store');
    f.setActive(false); assert.equal((await f.request('/api/items')).status, 401); f.setActive(true);
    f.env.PASSKEY_ENABLED = 'false'; assert.equal((await f.request('/api/items')).status, 401); f.env.PASSKEY_ENABLED = 'true';
    await result(f, '/api/logout', {}); assert.equal((await f.request('/api/items')).status, 401);
    f.env.SESSION_SECRET = ''; assert.equal((await f.request('/api/items')).status, 503);
  } finally { f.close(); }
});
test('account activation/version and owner binding are enforced on every request', async () => {
  const f = fixture(); try { await f.login(); const good = f.cookie; const payload = JSON.parse(Buffer.from(good.split('=')[1].split('.')[0], 'base64url'));
    for (const patch of [{ identityId: 'other' }, { service: 'billing' }, { role: 'user' }, { serviceAccountId: 'other' }, { expiresAt: 1 }]) {
      f.cookie = `troom_inventory_session=${await inventory.signSession({ ...payload, ...patch }, f.env)}`; assert.equal((await f.request('/api/items')).status, 401);
    }
    f.cookie = good; f.sqlite.exec("UPDATE inventory_accounts SET session_version=2"); assert.equal((await f.request('/api/items')).status, 401);
    const provider = new inventory.SecurityIntegration({}, f.env); assert.equal((await provider.describeAccount({ accountId: 'owner' })).valid, true); assert.equal((await provider.describeAccount({ accountId: 'other' })).valid, false);
    f.sqlite.exec('UPDATE inventory_accounts SET is_active=0'); assert.deepEqual((await provider.listLinkTargets()).targets, []);
  } finally { f.close(); }
});
test('validation rejects fractions, invalid dates, future records and anonymous oversized input', async () => {
  assert.throws(() => quantity(1.5)); assert.throws(() => quantity('2')); assert.throws(() => occurredAt('2026-02-30T00:00:00Z')); assert.throws(() => occurredAt('2099-01-01T00:00:00Z')); assert.equal(yearBounds(2026).start, '2025-12-31T15:00:00.000Z');
  const f = fixture(); try { await f.login(); assert.equal((await f.request('/api/items', { name: 'x'.repeat(9000) })).status, 413);
    const line = await f.request('/api/items', undefined, { 'User-Agent': 'Line/15.0.0' }); assert.equal(line.status, 403); assert.equal(line.headers.get('Set-Cookie'), null);
  } finally { f.close(); }
});

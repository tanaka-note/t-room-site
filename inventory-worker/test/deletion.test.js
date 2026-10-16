import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fixture } from './fixture.js';

const requestId = () => crypto.randomUUID();
async function call(f, path, body, status = 200) {
  const response = await f.request(path, body), value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value)); return value;
}
const create = (f, stock = 10) => call(f, '/api/items', { name: 'Deletion fixture', unit: '個', stock, requestId: requestId() });
const detail = (f, id) => call(f, `/api/items/${id}?year=2026`);
const movement = (kind = 'use') => ({ kind, quantity: 2, occurredAt: '2026-01-01T00:00:00+09:00', requestId: requestId() });
const counts = f => ['inventory_items','inventory_movements','inventory_requests'].map(table => f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);

test('deletion migration preserves existing items, stock, history and replay records', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON'); db.exec(readFileSync(new URL('../migrations/0001_inventory.sql', import.meta.url), 'utf8'));
    db.exec(`INSERT INTO inventory_accounts(id,display_name) VALUES('owner','Sample Owner');
      INSERT INTO inventory_items(id,account_id,name,unit,created_at) VALUES('item','owner','Fixture','個','2026-01-01');
      INSERT INTO inventory_movements(id,account_id,item_id,kind,quantity_delta,occurred_at,created_at) VALUES('opening','owner','item','opening',10,'2026-01-01','2026-01-01');
      INSERT INTO inventory_requests VALUES('owner','request','hash','{}','2026-01-01');`);
    const tables = ['inventory_accounts','inventory_items','inventory_movements','inventory_requests'];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
    db.exec(readFileSync(new URL('../migrations/0002_item_deletion.sql', import.meta.url), 'utf8'));
    const after = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all().map(row => { delete row.deleted_at; return row; }));
    assert.deepEqual(after, before); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('SELECT deleted_at FROM inventory_items').get().deleted_at, null);
  } finally { db.close(); }
});

test('nonzero-stock deletion removes item and usage from every API view, retaining immutable data', async () => {
  const f = fixture(); try {
    await f.login(); const { itemId } = await create(f), other = await create(f, 3);
    const use = await call(f, `/api/items/${itemId}/movements`, movement());
    const current = (await detail(f, itemId)).item, before = counts(f);
    await call(f, `/api/items/${itemId}/delete`, { requestId: requestId(), expectedVersion: current.version });
    for (const year of [2025,2026]) {
      assert.deepEqual((await call(f, `/api/items?year=${year}`)).items.map(i => i.id), [other.itemId]);
      await call(f, `/api/items/${itemId}?year=${year}`, undefined, 404);
    }
    assert.deepEqual(counts(f), [before[0],before[1],before[2]+1]);
    const stored = f.sqlite.prepare('SELECT * FROM inventory_items WHERE id=?').get(itemId);
    assert.ok(stored.deleted_at); assert.equal(stored.stock, 8);
    assert.equal(f.sqlite.prepare('SELECT SUM(quantity_delta) n FROM inventory_movements WHERE item_id=? AND voided_at IS NULL').get(itemId).n, stored.stock);
    await call(f, `/api/items/${itemId}/movements`, movement('restock'), 404);
    await call(f, `/api/items/${itemId}/archive`, { requestId: requestId() }, 404);
    await call(f, `/api/movements/${use.movementId}/void`, { requestId: requestId() }, 409);
    assert.throws(() => f.sqlite.prepare('DELETE FROM inventory_movements WHERE item_id=?').run(itemId), /inventory_history_required/);
    assert.throws(() => f.sqlite.prepare('UPDATE inventory_items SET deleted_at=NULL WHERE id=?').run(itemId), /inventory_item_deleted/);
    assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { f.close(); }
});

test('archived items can be deleted and cancellation cannot resurrect them', async () => {
  const f = fixture(); try {
    await f.login(); const { itemId } = await create(f, 2);
    const use = await call(f, `/api/items/${itemId}/movements`, movement());
    await call(f, `/api/items/${itemId}/archive`, { requestId: requestId() });
    const item = (await detail(f, itemId)).item;
    await call(f, `/api/items/${itemId}/delete`, { requestId: requestId(), expectedVersion: item.version });
    await call(f, `/api/movements/${use.movementId}/void`, { requestId: requestId() }, 409);
    assert.deepEqual((await call(f, '/api/items')).items, []);
    assert.equal(f.sqlite.prepare('SELECT stock FROM inventory_items WHERE id=?').get(itemId).stock, 0);
  } finally { f.close(); }
});

test('delete and old create replays never duplicate or resurrect data; conflicting request IDs remain rejected', async () => {
  const f = fixture(); try {
    await f.login(); const body = { name: 'Replay fixture', unit: '個', stock: 5, requestId: requestId() };
    const created = await call(f, '/api/items', body), item = (await detail(f, created.itemId)).item;
    const path = `/api/items/${item.id}/delete`, deletion = { requestId: requestId(), expectedVersion: item.version };
    const result = await call(f, path, deletion), before = counts(f);
    assert.deepEqual(await call(f, path, deletion), result);
    await call(f, path, { ...deletion, expectedVersion: item.version + 1 }, 409);
    await call(f, path, { ...deletion, requestId: requestId() }, 404);
    assert.deepEqual(await call(f, '/api/items', body), created);
    await call(f, '/api/items', { ...body, stock: 6 }, 409);
    assert.deepEqual(counts(f), before); assert.deepEqual((await call(f, '/api/items')).items, []);
  } finally { f.close(); }
});

test('stale or invalid deletion is atomic and a fresh version is required', async () => {
  const f = fixture(); try {
    await f.login(); const { itemId } = await create(f), old = (await detail(f, itemId)).item;
    await call(f, `/api/items/${itemId}/movements`, movement()); const before = counts(f);
    const deletion = { requestId: requestId(), expectedVersion: old.version };
    await call(f, `/api/items/${itemId}/delete`, deletion, 409); assert.deepEqual(counts(f), before);
    for (const expectedVersion of [undefined,-1,1.5,'2']) await call(f, `/api/items/${itemId}/delete`, { ...deletion, expectedVersion }, 400);
    const current = (await detail(f, itemId)).item; assert.equal(current.stock, 8);
    await call(f, `/api/items/${itemId}/delete`, { ...deletion, expectedVersion: current.version });
  } finally { f.close(); }
});

test('database guards resolve mutations interleaved between prepare and commit safely', async t => {
  for (const scenario of ['delete-before-use','delete-before-void','delete-before-archive','use-before-delete','void-before-delete']) await t.test(scenario, async () => {
    const f = fixture(); try {
      await f.login(); const { itemId } = await create(f, scenario === 'delete-before-archive' ? 2 : 4);
      const use = await call(f, `/api/items/${itemId}/movements`, movement());
      const item = (await detail(f, itemId)).item, deletion = { requestId: requestId(), expectedVersion: item.version };
      const paths = { delete: `/api/items/${itemId}/delete`, use: `/api/items/${itemId}/movements`, void: `/api/movements/${use.movementId}/void`, archive: `/api/items/${itemId}/archive` };
      const bodies = { delete: deletion, use: movement(), void: { requestId: requestId() }, archive: { requestId: requestId() } };
      const [inner,outer] = scenario.split('-before-'), batch = f.env.DB.batch.bind(f.env.DB);
      f.env.DB.batch = async statements => { f.env.DB.batch = batch; await call(f, paths[inner], bodies[inner]); return batch(statements); };
      await call(f, paths[outer], bodies[outer], 409);
      assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_requests WHERE request_id=?').get(bodies[outer].requestId).n, 0);
      const stored = f.sqlite.prepare('SELECT * FROM inventory_items WHERE id=?').get(itemId);
      assert.equal(Boolean(stored.deleted_at), inner === 'delete');
      assert.equal(stored.stock, f.sqlite.prepare('SELECT SUM(quantity_delta) n FROM inventory_movements WHERE item_id=? AND voided_at IS NULL').get(itemId).n);
      assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { f.close(); }
  });
});

test('delete requires authentication and same-origin JSON requests', async () => {
  const f = fixture(); try {
    await f.login(); const { itemId } = await create(f), item = (await detail(f, itemId)).item;
    const path = `/api/items/${itemId}/delete`, body = { requestId: requestId(), expectedVersion: item.version }, before = counts(f), cookie = f.cookie;
    f.cookie = ''; await call(f, path, body, 401); f.cookie = cookie;
    for (const headers of [{ Origin: 'https://evil.test' }, { 'Content-Type': 'text/plain' }]) assert.equal((await f.request(path, body, headers)).status, 403);
    assert.deepEqual(counts(f), before); assert.equal((await detail(f, itemId)).item.deleted_at, null);
  } finally { f.close(); }
});

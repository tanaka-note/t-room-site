import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.js';

test('malformed cookies and non-JSON cross-site mutations fail closed', async () => {
  const f=fixture(); try {
    for (const cookie of ['troom_inventory_session=invalid','troom_inventory_session=..','another_session=invalid']) {
      f.cookie=cookie; assert.equal((await f.request('/api/items')).status,401);
    }
    await f.login();
    assert.equal((await f.request('/api/items',{}, {'Content-Type':'text/plain'})).status,403);
    assert.equal((await f.request('/api/items',{}, {Origin:'https://other.test'})).status,403);
  } finally {f.close();}
});

test('Inventory rejects foreign identities, accounts and Cloud root-folder handoff claims', async () => {
  for (const patch of [{identityId:'other-identity'},{serviceAccountId:'other-owner'},{cloudRootFolderId:7}]) {
    const f=fixture(); try {
      f.env.SECURITY.redeemHandoff=async()=>({identityId:'primary-admin',serviceAccountId:'owner',credentialId:'fixture-credential',serviceLinkId:'fixture-link',sessionEpoch:1,...patch});
      const response=await f.request('/api/passkey/handoff',{handoffToken:'synthetic-handoff'});
      assert.equal(response.status,401); assert.equal(response.headers.get('Set-Cookie'),null);
      assert.equal((await f.request('/api/items')).status,401);
    } finally {f.close();}
  }
});

test('SQL and HTML input remain data; overlength unit attacks are rejected without changing schema', async () => {
  const attacks=['<script>alert(1)</script>','<img src=x onerror=alert(1)>','"><svg/onload=alert(1)>',"'; DROP TABLE inventory_items; --"];
  const f=fixture(); try {await f.login();
    for (const name of attacks) {
      const response=await f.request('/api/items',{name,unit:'<b>',stock:1,requestId:crypto.randomUUID()}); assert.equal(response.status,200);
      const {itemId}=await response.json();
      const detail=await (await f.request(`/api/items/${itemId}`)).json(); assert.equal(detail.item.name,name); assert.equal(detail.item.unit,'<b>');
    }
    for (const unit of attacks) assert.equal((await f.request('/api/items',{name:'Sample',unit,stock:1,requestId:crypto.randomUUID()})).status,400);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_items').get().n,attacks.length);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,attacks.length);
  } finally {f.close();}
});

test('old request records retain lifetime idempotency and conflicting retries stay rejected', async () => {
  const f=fixture(); try {await f.login();
    const created=await (await f.request('/api/items',{name:'Sample',unit:'個',stock:10,requestId:crypto.randomUUID()})).json();
    const input={kind:'use',quantity:2,occurredAt:'2026-01-02T00:00:00Z',requestId:crypto.randomUUID()};
    const first=await (await f.request(`/api/items/${created.itemId}/movements`,input)).json();
    f.sqlite.prepare('UPDATE inventory_requests SET created_at=? WHERE request_id=?').run('2000-01-01T00:00:00.000Z',input.requestId);
    const replay=await f.request(`/api/items/${created.itemId}/movements`,input); assert.equal(replay.status,200); assert.deepEqual(await replay.json(),first);
    assert.equal((await f.request(`/api/items/${created.itemId}/movements`,{...input,quantity:3})).status,409);
    assert.equal(f.sqlite.prepare('SELECT stock FROM inventory_items WHERE id=?').get(created.itemId).stock,8);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_movements WHERE item_id=?').get(created.itemId).n,2);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_requests WHERE request_id=?').get(input.requestId).n,1);
  } finally {f.close();}
});

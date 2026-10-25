import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './performance-fixture.mjs';

for (const kind of ['entries','settlements']) for (const method of ['POST','PUT','DELETE']) {
  for (const stage of ['before write','after write','before touch']) {
    test(`${kind} ${method}: ${stage} returns only 401, with no protected result or replay`, async () => {
      const f=fixture();
      try {
        const {cookie}=await f.login();
        const body=kind==='entries'
          ? {accountId:'chiharu',documentType:'invoice',entryDate:'2026-10-01',category:'purchase',amountYen:123,description:'Fixture'}
          : {accountId:'chiharu',settlementDate:'2026-10-01',direction:'incoming',method:'cash',amountYen:123};
        let path=kind;
        if(method!=='POST') {const created=await f.request(kind,cookie,{method:'POST',body});assert.equal(created.status,201);path+=`/${created.body.id}`;}
        f.reset();
        const revoke=()=>f.securityDb.exec("UPDATE security_credentials SET status='revoked'");
        if(stage==='before write')revoke();
        if(stage==='after write') {
          const prepare=f.env.DB.prepare;
          const wrap=statement=>({ ...statement, bind:(...args)=>wrap(statement.bind(...args)), async run(){
            const result=await statement.run(); revoke(); return result;
          } });
          f.env.DB.prepare=(sql)=>/^(?:\s*INSERT INTO|\s*UPDATE) billing_(entries|settlements)\b/.test(sql) ? wrap(prepare(sql)) : prepare(sql);
        }
        if(stage==='before touch')f.beforeTouch=revoke;
        const result=await f.request(path,cookie,{method,body:{...body,amountYen:456}});
        assert.equal(result.status,401);
        assert.deepEqual(Object.keys(result.body),['error']);
        assert.equal(result.cookie,undefined);
        const writes=f.metrics.billing.sql.filter(q=>new RegExp(`(?:INSERT INTO|UPDATE) billing_${kind}\\b`).test(q.sql));
        assert.equal(writes.length,stage==='before write'?0:1,'one committed write at most; no automatic retry');
        const row=f.db.prepare(`SELECT amount_yen,deleted_at FROM billing_${kind} ORDER BY id DESC LIMIT 1`).get();
        if(stage!=='before write') {
          assert.ok(row);
          if(method==='DELETE')assert.ok(row.deleted_at);
          else {assert.equal(row.amount_yen,456);assert.equal(row.deleted_at,null);}
        } else if(method==='POST')assert.equal(row,undefined);
        else {assert.equal(row.amount_yen,123);assert.equal(row.deleted_at,null);}
        const count=f.db.prepare(`SELECT COUNT(*) AS count FROM billing_${kind}`).get().count;
        await f.request('session',cookie);
        assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM billing_${kind}`).get().count,count);
      } finally {f.close();}
    });
  }
}

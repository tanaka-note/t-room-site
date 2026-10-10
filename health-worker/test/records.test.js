import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createState } from '../public/health-state.mjs';
import { createRepository } from '../public/health-records.mjs';

test('unconfirmed write/delete results leave revisions and local data intact',async()=>{
  const state=createState();state.auth.master=randomBytes(32);state.auth.accountId='fixture-account';
  const value={date:'2026-01-01',note:'retained draft'};
  state.data.records=[value];state.data.revisions.set(value.date,3);
  try {
    for(const result of [{},{ok:false,revision:4},{ok:true,revision:'4'},{ok:true,revision:5},{ok:true,revision:3}]){
      const repo=createRepository(state,async()=>result);
      await assert.rejects(repo.store(value.date,value,3,0),/保存結果/);
      await assert.rejects(repo.remove(value.date,3,0),/削除結果/);
      assert.equal(repo.revision(value.date),3);assert.deepEqual(state.data.records,[value]);
    }
    const repo=createRepository(state,async()=>({ok:true,revision:4}));
    await repo.store(value.date,value,3,0);assert.equal(repo.revision(value.date),4);
    const deletion=createRepository(state,async()=>({ok:true,revision:5}));
    await deletion.remove(value.date,4,0);assert.equal(deletion.revision(value.date),0);
  } finally { state.erase();assert.equal(state.auth.accountId,null); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createState } from '../public/health-state.mjs';
import { createRepository } from '../public/health-records.mjs';
import { handleRequest } from '../src/worker.js';
import { fixture } from './fixture.js';
import { emptyRecord } from '../public/health-domain.mjs';

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

test('new writes accept positive safe counters, but reject malformed creation acknowledgements',async()=>{
  const state=createState();state.auth.master=randomBytes(32);state.auth.accountId='fixture-account';
  try {
    for(const revision of [1,4,Number.MAX_SAFE_INTEGER]){
      const repo=createRepository(state,async()=>({ok:true,revision}));
      await repo.store('2026-01-01',{date:'2026-01-01'},0,0);
      assert.equal(repo.revision('2026-01-01'),revision);
    }
    state.data.revisions.clear();
    for(const result of [{},{ok:false,revision:4},...['4',0,-1,1.5,Number.MAX_SAFE_INTEGER+1].map(revision=>({ok:true,revision}))]){
      const repo=createRepository(state,async()=>result);
      await assert.rejects(repo.store('2026-01-01',{date:'2026-01-01'},0,0),/保存結果/);
      assert.equal(repo.revision('2026-01-01'),0);
    }
  } finally {state.erase();}
});

test('repository recreates a deleted date through the actual handler and continues from its tombstone counter',async()=>{
  const f=await fixture(),state=createState(),origin='https://tanaka-note.com';
  try {
    const login=await handleRequest(new Request(origin+'/health/api/passkey/handoff',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({handoffToken:f.issue('owner')})}),f.env);
    const auth=await login.json();
    state.auth.session=auth.sessionId;state.auth.master=new Uint8Array(f.master);state.auth.accountId=auth.keyBundle.accountId;
    const repo=createRepository(state,async(path,options={})=>{
      const response=await handleRequest(new Request(origin+'/health/api'+path,{...options,headers:{Origin:origin,'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0],'X-Health-Session':state.auth.session}}),f.env);
      return response.json();
    });
    const date='2026-01-01';
    const value=note=>({...emptyRecord(date),note});
    await repo.store(date,value('created'),0,0);assert.equal(repo.revision(date),1);
    await repo.store(date,value('updated'),1,0);assert.equal(repo.revision(date),2);
    await repo.remove(date,2,0);await repo.load(0);
    assert.equal(repo.revision(date),0);assert.deepEqual(state.data.records,[]);
    assert.equal(f.db.prepare('SELECT revision FROM health_records').get().revision,3);
    await repo.store(date,value('recreated'),0,0);assert.equal(repo.revision(date),4);
    await repo.load(0);assert.equal(state.data.records[0].note,'recreated');
    await assert.rejects(repo.store(date,value('stale'),2,0),error=>error.code==='revision_conflict');
    assert.equal(repo.revision(date),4);
    await repo.store(date,value('edited after recreation'),4,0);await repo.load(0);
    assert.equal(repo.revision(date),5);assert.equal(state.data.records[0].note,'edited after recreation');
  } finally {state.erase();f.master.fill(0);f.db.close();}
});

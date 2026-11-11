import assert from 'node:assert/strict';
import { before,test } from 'node:test';
import { fixture,provision,entry } from './fixture.mjs';
import { EncryptedDiaryClient } from '../../e2ee/client.mjs';
import { newKey,seal,open } from '../../e2ee/crypto.mjs';
let prepared;before(async()=>{prepared=await provision();});
test('new compressed format is smaller and both formats remain readable',async()=>{
  const key=await newKey(),binding={id:'1',household:'A',scope:'A:published',revision:1,epoch:1,kind:'document'},value={content:'日本語の合成本文。'.repeat(1000)};
  const old=await seal(key,value,binding),compressed=await seal(key,value,binding,{format:2});
  assert.ok(compressed.ciphertext.length<old.ciphertext.length/4);assert.deepEqual(await open(key,old,binding),value);assert.deepEqual(await open(key,compressed,binding),value);
  await assert.rejects(open(key,{...compressed,version:1},binding));
});
test('fresh session validates ciphertext cache and syncs from its checkpoint without a full download',async()=>{
  const f=await fixture(prepared);try {
    const values=new Map(),cache={get:async key=>structuredClone(values.get(key)),put:async(key,value)=>values.set(key,structuredClone(value))};
    const first=await f.client('ownerA');first.cache=cache;first.documentFormat=2;const e=(await first.saveEntry(entry())).entry;
    const seen=[];const transport={...first.transport,snapshot:async(h,since)=>{seen.push(since);return first.transport.snapshot(h,since);}};
    const second=new EncryptedDiaryClient({transport,profile:{...prepared.profiles.ownerA,actor:f.actors.ownerA},anchor:prepared.anchor,cache,documentFormat:2});
    await second.unlock(new Uint8Array(prepared.secrets.ownerA.prf));await second.sync();assert.ok(seen[0]>=1);assert.equal(second.entry(e.id).title,e.title);
    assert.equal(JSON.stringify([...values]).includes(e.title),false);
    const cached=[...values.values()][0];cached.sequence=9999;
    values.set([...values.keys()][0],cached);
    second.lock();await second.unlock(new Uint8Array(prepared.secrets.ownerA.prf));await assert.rejects(second.sync(),/RollbackDetected/);
  }finally{f.close();}
});

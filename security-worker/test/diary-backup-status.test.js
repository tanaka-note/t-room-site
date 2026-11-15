import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditFixture } from './audit-history-fixture.mjs';
import { runState } from '../../backup-worker/src/monitor.js';

test('actual status RPC isolates D1, photo copy and revalidation without expanding the service allowlist', async () => {
  const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
  const body=source.match(/  async getBackupStatus\(service\) \{([\s\S]*?)\n  \}/)[1];
  const read=new Function('runState', 'return async function(service) {'+body+'}')(runState);
  const f=auditFixture(), targets=[];
  const env={DB:{prepare(sql){
    assert.match(sql,/^SELECT /);
    assert.match(sql,/LIMIT 40$/);
    return {bind(target){targets.push(target);return {async all(){return {results:f.db.prepare(sql).all(target)};}};}};
  }}};
  try {
    for(const [target,event] of [['diary','failed'],['diary-photos','succeeded'],['diary-photo-verification','partial']]) f.add({service:'diary',target_type:'backup',target_id:target,event_type:'backup_'+event,occurred_at:new Date().toISOString()});
    assert.equal((await read.call({env},'diary')).state,'failed');
    assert.equal((await read.call({env},'diary-photos')).state,'ok');
    assert.equal((await read.call({env},'diary-photo-verification')).state,'partial');
    await assert.rejects(read.call({env},'cloud'),/UnknownBackup/);
    assert.deepEqual(targets,['diary','diary-photos','diary-photo-verification']);
  } finally {f.close();}
});

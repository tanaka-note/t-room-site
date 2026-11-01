import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scanBackupMetadata } from '../src/backup-browser.js';

// Use the repository's pinned runtime, including Workers DigestStream and R2
// conditional/checksummed writes. All buckets/DBs below are isolated in memory.
const require = createRequire(realpathSync(new URL('../../node_modules/wrangler/package.json', import.meta.url)));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
test('workerd streams, resumes, pairs and restores photos; R2 corruption stays preserved', { timeout: 120000 }, async () => {
  const row = { id: 'synthetic', original_size: 3, original_key: 'source/original', display_key: 'source/display', thumbnail_key: 'source/thumbnail', created_at: '2026-10-01', backup_identity: null };
  const bundled = await build({ stdin: { contents: `
    import {runPhotoBatch} from './src/photo-backup-job.js';
    import {resolvePhotoManifest,restorePhotos} from './src/photo-backup.js';
    export default {async fetch(request,env) {
      const path=new URL(request.url).pathname;
      if(path==='/restore') {
        const paired=await resolvePhotoManifest(env.BACKUP,{formatVersion:8,backupScope:'d1-only',tables:{diary_photos:{rows:(await env.DB.prepare('SELECT * FROM diary_photos').all()).results}}});
        return Response.json(await restorePhotos({BACKUP:env.BACKUP,MEDIA:env.RESTORE},paired));
      }
      const now=Date.parse('2026-10-30T18:55:00Z')+(path==='/verify'?31*86400000:path==='/resume'?600000:0);
      const result=await runPhotoBatch(env,{now,clock:()=>now,mode:path==='/verify'?'verify':'copy',maxObjects:path==='/first'?1:40});
      return Response.json({...result,digestStream:typeof crypto.DigestStream});
    }};`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, format: 'esm', platform: 'browser', write: false });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-08-04', d1Databases: { DB: 'photo-fixture' }, r2Buckets: { MEDIA: 'source-fixture', BACKUP: 'backup-fixture', RESTORE: 'restore-fixture' } }));
  try {
    const db = await mf.getD1Database('DB'), media = await mf.getR2Bucket('MEDIA'), backup = await mf.getR2Bucket('BACKUP');
    await db.prepare('CREATE TABLE diary_photos(id TEXT PRIMARY KEY,original_size INTEGER,original_key TEXT,display_key TEXT,thumbnail_key TEXT,created_at TEXT,backup_identity TEXT)').run();
    await db.prepare('INSERT INTO diary_photos VALUES(?,?,?,?,?,?,?)').bind(...Object.values(row)).run();
    for (const key of [row.original_key,row.display_key,row.thumbnail_key]) await media.put(key,new Uint8Array([1,2,3]));
    const call = async path => { const response=await mf.dispatchFetch('http://fixture'+path); assert.equal(response.status,200); return response.json(); };
    const first=await call('/first'); assert.equal(first.copied,1); assert.equal(first.digestStream,'function');
    assert.equal((await call('/first')).skipped,true);
    const second=await call('/resume'); assert.equal(second.copied,2); assert.equal(second.complete,true);
    const summary=await scanBackupMetadata(backup);
    assert.equal(summary.photoSummary.backedUp,3); assert.equal(summary.photoSummary.unknown,0);
    assert.equal(summary.photoSummary.complete,true); assert.equal(summary.daily.objectCount,0);
    assert.equal((await call('/restore')).restored,3);
    const physical=await backup.list({prefix:'media/verified-photos/'});
    assert.equal(physical.objects.length,3);
    await backup.put(physical.objects[0].key,new Uint8Array([9,9,9]));
    const corrupt=await call('/verify'); assert.equal(corrupt.corrupt,1); assert.equal(corrupt.complete,false);
    assert.deepEqual(new Uint8Array(await (await backup.get(physical.objects[0].key)).arrayBuffer()),new Uint8Array([9,9,9]));
    assert.equal((await backup.list({prefix:'media/photo-issues/'})).objects.length,1);
  } finally { await mf.dispose(); }
});

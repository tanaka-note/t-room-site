import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { deleteAlbumPhoto } from '../src/photo-deletion.js';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const marker = `[[写真:${id}]]`;
const session = { activeHouseholdId: 'tanaka-household' };
function fixture(t, content = `前${marker}後`) {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  t.after(() => db.close());
  db.prepare(`INSERT INTO diary_entries(id, entry_date, title, content, household_id, last_published_at)
    VALUES(1, '2026-11-02', '写真削除', ?, 'tanaka-household', '2026-11-02T00:00:00Z')`).run(content);
  db.prepare(`INSERT INTO diary_photos(id,entry_id,file_name,content_type,original_size,original_key,display_key,thumbnail_key,created_by_id,created_by_name)
    VALUES(?,1,'fixture.jpg','image/jpeg',1,'original','display','thumbnail','main-admin','fixture')`).run(id);
  function prepare(sql, params = []) {
    return { bind: (...values) => prepare(sql, values),
      first: async () => db.prepare(sql).get(...params) || null,
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } }) };
  }
  const f = { db, beforeBatch: () => {}, env: { MEDIA: {}, DB: { prepare, batch: async statements => {
    f.beforeBatch();
    db.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } } } };
  f.remove = (revision = 1, context = session) => deleteAlbumPhoto(id, revision, f.env, context, HttpError);
  f.entry = () => db.prepare('SELECT * FROM diary_entries WHERE id=1').get();
  f.intact = () => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary_photos').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary_media_deletion_queue').get().n, 0);
  };
  return f;
}
const rejected = (operation, status) => assert.rejects(operation, error => error.status === status);

test('deletes repeated/case-insensitive references and shifts formatting in the same transaction', async t => {
  const content = `前${marker}${marker.toUpperCase()}後`;
  const f = fixture(t, content);
  f.db.prepare('UPDATE diary_entries SET content_format=? WHERE id=1').run(JSON.stringify({ version: 1, runs: [
    { start: content.length - 1, end: content.length, bold: true }
  ] }));
  const result = await f.remove();
  assert.equal(result.content, '前後');
  assert.deepEqual(result.contentFormat.runs, [{ start: 1, end: 2, bold: true, italic: false, underline: false, color: null }]);
  assert.equal(f.entry().content, '前後');
  assert.equal(f.entry().revision, 2);
  assert.equal(f.entry().last_published_at, '2026-11-02T00:00:00Z', 'photo deletion does not republish the diary');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM diary_photos').get().n, 0);
  assert.deepEqual(f.db.prepare('SELECT object_key FROM diary_media_deletion_queue ORDER BY object_key').all().map(x => x.object_key), ['display','original','thumbnail']);
  await rejected(f.remove(2), 404);
});

test('rejects invalid/stale revisions, missing storage, other households and unpublished/deleted entries', async t => {
  const f = fixture(t);
  for (const revision of [null, '1', 0, -1, 1.5]) await rejected(f.remove(revision), 400);
  await rejected(f.remove(2), 409);
  await rejected(f.remove(1, { activeHouseholdId: 'chiharu-household' }), 404);
  delete f.env.MEDIA; await rejected(f.remove(), 503); f.env.MEDIA = {};
  f.db.exec("UPDATE diary_entries SET status='draft'"); await rejected(f.remove(), 404);
  f.db.exec("UPDATE diary_entries SET status='published', deleted_at=CURRENT_TIMESTAMP"); await rejected(f.remove(), 404);
  f.intact();
});

test('blocks the last photo of a photo-only entry, but retains other photos and article text', async t => {
  const f = fixture(t, `\n${marker}\n`);
  await rejected(f.remove(), 409); f.intact();
  assert.equal(f.entry().content, `\n${marker}\n`);
  const second = id.replace(/1$/, '2');
  f.db.prepare(`INSERT INTO diary_photos SELECT ?,entry_id,'other.jpg',content_type,original_size,'o2','d2','t2',width,height,created_by_id,created_by_name,created_at,backup_identity FROM diary_photos WHERE id=?`).run(second, id);
  f.db.prepare('UPDATE diary_entries SET content=?').run(marker + `[[写真:${second}]]`);
  await f.remove();
  assert.equal(f.entry().content, `[[写真:${second}]]`);
  assert.equal(f.db.prepare('SELECT id FROM diary_photos').get().id, second);
});

for (const race of ['revision', 'draft', 'trash']) test(`concurrent ${race} changes cannot partly delete a photo`, async t => {
  const f = fixture(t);
  f.beforeBatch = () => {
    if (race === 'revision') f.db.exec('UPDATE diary_entries SET revision=revision+1');
    if (race === 'trash') f.db.exec('UPDATE diary_entries SET deleted_at=CURRENT_TIMESTAMP');
    if (race === 'draft') f.db.exec(`INSERT INTO diary_entries(entry_date,title,content,household_id,status,draft_of_entry_id,draft_of_revision)
      VALUES('2026-11-02','編集中','下書き','tanaka-household','draft',1,1)`);
  };
  await rejected(f.remove(), 409); f.intact();
  assert.equal(f.entry().content, `前${marker}後`);
});

test('SQL failure rolls back text, revision, photo record and deletion queue', async t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER fail_photo_delete BEFORE DELETE ON diary_photos BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
  await assert.rejects(f.remove(), /fixture failure/);
  f.intact(); assert.equal(f.entry().revision, 1); assert.equal(f.entry().content, `前${marker}後`);
});

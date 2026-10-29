import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createDiaryEntryDomain } from '../src/entry-domain.js';

// Exercise the actual handlers and their SQL, with no remote storage or photos.
const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const domain = createDiaryEntryDomain({ HttpError: Error, basePath: '/diary' });
function handler(name, next) {
  const start = source.indexOf(`async function ${name}(`);
  return source.slice(start, source.indexOf(`\nasync function ${next}(`, start));
}
const { getEntry, listEntryPhotos, listPhotos } = new Function('domain', `
  const { serializePhoto, serializeEntry, parsePhotoIdList } = domain;
  const clampNumber = (v, min, max, fallback) => v == null ? fallback : Math.min(max, Math.max(min, Number(v)));
  const normalizeSearch = v => v, json = value => value;
  const canAccessTrashEntry = async () => false;
  ${handler('getEntry', 'updateFavorite')}
  ${handler('listEntryPhotos', 'listPhotos')}
  ${handler('listPhotos', 'listPhotoMeta')}
  return { getEntry, listEntryPhotos, listPhotos };
`)(domain);
const db = new DatabaseSync(':memory:');
const migrations = new URL('../migrations/', import.meta.url);
for (const name of readdirSync(migrations).filter(n => n.endsWith('.sql')).sort()) {
  db.exec(readFileSync(new URL(name, migrations), 'utf8'));
}
function prepare(sql, params = []) {
  return { bind: (...values) => prepare(sql, values),
    first: async () => db.prepare(sql).get(...params) || null,
    all: async () => ({ results: db.prepare(sql).all(...params) }) };
}
const env = { DB: { prepare } };
const session = { accountId: 'main-admin', activeHouseholdId: 'tanaka-household', canManageEntries: true };
const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const marker = n => `[[写真:${id(n)}]]`;
const ids = photos => photos.map(p => p.id);
function entry(n, content, date = '2026-10-29', published = '2026-10-29T10:00:00Z') {
  db.prepare(`INSERT INTO diary_entries(id, entry_date, title, content, household_id, last_published_at)
    VALUES (?, ?, '写真の順番', ?, 'tanaka-household', ?)`).run(n, date, content, published);
}
function photo(n, entryId, time) {
  db.prepare(`INSERT INTO diary_photos(id, entry_id, file_name, content_type, original_size,
    original_key, display_key, thumbnail_key, created_by_id, created_by_name, created_at)
    VALUES (?, ?, ?, 'image/jpeg', 1, ?, ?, ?, 'main-admin', 'fixture', ?)`)
    .run(id(n), entryId, `${n}.jpg`, `o/${n}`, `d/${n}`, `t/${n}`, `2026-10-29T11:00:${time}Z`);
}
const album = async query => (await listPhotos(new URL(`https://fixture.test/?${query}`), env, session));
try {
  entry(1, marker(1) + marker(2).toUpperCase() + marker(3));
  // Parallel uploads finish in a different order from the body.
  photo(1, 1, '01'); photo(2, 1, '03'); photo(3, 1, '02');
  assert.deepEqual(ids(await listEntryPhotos(1, env, session)), [1, 2, 3].map(id));
  assert.deepEqual(ids((await album('')).photos), [3, 2, 1].map(id));
  assert.deepEqual(ids((await album('month=2026-10&order=oldest')).photos), [1, 2, 3].map(id));
  assert.deepEqual(ids((await album('order=oldest')).photos), [3, 2, 1].map(id), 'all months stays newest first');
  assert.deepEqual(ids((await album('month=2026-10&order=invalid')).photos), [3, 2, 1].map(id));

  // The draft's body, not the published source's body, determines viewer order.
  entry(4, marker(3) + marker(1) + marker(4));
  photo(4, 4, '04');
  db.prepare(`UPDATE diary_entries SET status='draft', draft_of_entry_id=1,
    draft_excluded_photo_ids=? WHERE id=4`).run(JSON.stringify([id(2)]));
  assert.deepEqual(ids((await getEntry(4, env, session)).entry.photos), [3, 1, 4].map(id));

  // Same-day entries follow diary publication order; uploads never interleave entries.
  entry(2, marker(5) + marker(6), '2026-10-29', '2026-10-29T12:00:00Z');
  photo(5, 2, '00'); photo(6, 2, '00');
  entry(3, marker(7), '2026-09-30'); photo(7, 3, '59');
  const newest = [6, 5, 3, 2, 1].map(id);
  const oldest = [...newest].reverse();
  for (const [order, expected] of [['newest', newest], ['oldest', oldest]]) {
    const combined = [];
    for (let offset = 0; offset < expected.length; offset += 2) {
      const page = await album(`month=2026-10&order=${order}&limit=2&offset=${offset}`);
      combined.push(...ids(page.photos));
      assert.equal(page.hasMore, offset + 2 < expected.length);
    }
    assert.deepEqual(combined, expected, `stable ${order} pagination`);
  }
  assert.deepEqual(ids((await album('')).photos), [...newest, id(7)]);
  assert.deepEqual(ids((await album('month=2026-10&order=oldest&fileName=2.jpg')).photos), [id(2)]);
  db.exec("INSERT INTO diary_tags(entry_id,tag) VALUES(1,'限定タグ')");
  assert.deepEqual(ids((await album('month=2026-10&order=oldest&entryQuery=限定タグ')).photos), [1, 2, 3].map(id));

  // Unreferenced legacy photos stay after body photos; album reverses that entire order.
  entry(8, marker(8) + marker(8), '2026-08-01');
  photo(8, 8, '09'); photo(9, 8, '05'); photo(10, 8, '05');
  assert.deepEqual(ids(await listEntryPhotos(8, env, session)), [8, 9, 10].map(id));
  assert.deepEqual(ids((await album('month=2026-08')).photos), [10, 9, 8].map(id));
  assert.deepEqual(ids((await album('month=2026-08&order=oldest')).photos), [8, 9, 10].map(id));
  db.prepare('UPDATE diary_entries SET content=? WHERE id=8').run('写真参照のない旧日記');
  assert.deepEqual(ids(await listEntryPhotos(8, env, session)), [9, 10, 8].map(id));
  assert.deepEqual(ids((await album('month=2026-08')).photos), [8, 10, 9].map(id));

  entry(11, marker(11)); photo(11, 11, '58');
  db.exec("UPDATE diary_entries SET household_id='chiharu-household' WHERE id=11");
  entry(12, marker(12)); photo(12, 12, '57');
  db.exec("UPDATE diary_entries SET deleted_at=CURRENT_TIMESTAMP WHERE id=12");
  for (const order of ['newest', 'oldest']) {
    const photos = (await album(`month=2026-10&order=${order}`)).photos;
    assert.ok(photos.every(p => ![4, 11, 12].includes(p.entryId)), 'exclude drafts, deleted and other households');
  }
  console.log('Photo order: body/viewer, reverse album, monthly directions, pagination, filters, drafts and legacy photos passed.');
} finally { db.close(); }

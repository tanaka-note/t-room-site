import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PhotoMigration, entryMatches, photoContent, validateManifest } from '../public/photo-migration-core.js';

const hash = 'a'.repeat(64);
const dateOne = '2025-06-01', dateTwo = '2025-06-02';
const photoId = n => `20000000-0000-5000-8000-${String(n).padStart(12, '0')}`;
const requestId = n => `10000000-0000-5000-8000-${String(n).padStart(12, '0')}`;
function photo(n, date, hour = 12) {
  const id = photoId(n);
  const timestamp = Math.floor(Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00+09:00`) / 1000);
  return {
    id, date, timestamp, fileName: `${n}.jpg`, mimeType: 'image/jpeg', width: 100, height: 80,
    original: { path: `photos/${id}/original.jpg`, bytes: 200, sha256: hash },
    display: { path: `photos/${id}/display.webp`, bytes: 100, sha256: hash },
    thumbnail: { path: `photos/${id}/thumbnail.webp`, bytes: 50, sha256: hash }
  };
}
const day = (date, n) => ({ date, title: date, requestId: requestId(n), photos: [photo(n, date), photo(n + 1, date, 13)] });
const fixture = () => ({
  version: 1, id: 'b'.repeat(64), year: 2025, timezone: 'Asia/Tokyo',
  days: [day(dateOne, 1), day(dateTwo, 3)]
});

test('multiple-day import keeps each day and its photo order isolated', () => {
  const manifest = fixture();
  assert.equal(validateManifest(manifest), manifest);
  for (const d of manifest.days) {
    assert.equal(photoContent(d), d.photos.map(p => `[[写真:${p.id}]]`).join('\n'));
    assert.ok(entryMatches({
      entryDate: d.date, title: d.title, content: photoContent(d),
      photos: d.photos.map(p => ({ id: p.id }))
    }, d));
  }
  assert.notEqual(manifest.days[0].requestId, manifest.days[1].requestId);
});

test('verification rejects wrong order, missing photos, extra photos and changed body', () => {
  const d = fixture().days[0];
  const entry = { entryDate: d.date, title: d.title, content: photoContent(d), photos: d.photos.map(p => ({ id: p.id })) };
  for (const change of [
    e => { e.photos.reverse(); },
    e => { e.photos.pop(); },
    e => { e.photos.push({ id: photoId(99) }); },
    e => { e.content += ' user edit'; },
    e => { e.entryDate = dateTwo; },
    e => { e.title = 'different'; }
  ]) {
    const altered = structuredClone(entry);
    change(altered);
    assert.equal(entryMatches(altered, d), false);
  }
  assert.equal(entryMatches(entry, d), true);
});

test('manifest rejects path traversal, changed checksum, invalid size and cross-date photo reuse', () => {
  for (const change of [
    m => { m.days[0].photos[0].original.path = '../outside.jpg'; },
    m => { m.days[0].photos[0].display.sha256 = 'not-a-sha'; },
    m => { m.days[0].photos[0].thumbnail.bytes = 0; },
    m => { m.days[1].photos[0].id = m.days[0].photos[0].id; },
    m => { m.days[1].photos[0].date = dateOne; },
    m => { m.days[1].photos[0].timestamp = m.days[0].photos[0].timestamp; }
  ]) {
    const manifest = fixture();
    change(manifest);
    assert.throws(() => validateManifest(manifest));
  }
});

test('progress journal is bound to its manifest and destination before an API call', () => {
  const manifest = fixture();
  const destination = { origin: 'https://diary.example', householdId: 'household-1', loginId: 'test@example.test', role: 'admin' };
  const journal = { version: 1, manifestId: manifest.id, destination, days: {} };
  const options = { manifest, journal, destination, api: async () => { throw new Error('must not call API'); },
    readFile: async () => { throw new Error('must not read file'); }, saveJournal: async () => {} };
  assert.doesNotThrow(() => new PhotoMigration(options));
  assert.throws(() => new PhotoMigration({ ...options, journal: { ...journal, manifestId: 'c'.repeat(64) } }), /進捗/);
  assert.throws(() => new PhotoMigration({ ...options, destination: { ...destination, householdId: 'household-2' } }), /保存先/);
});

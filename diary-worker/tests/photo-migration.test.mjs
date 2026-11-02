import test from 'node:test';
import assert from 'node:assert/strict';
import { PhotoMigration, validateManifest, photoContent } from '../public/photo-migration-core.js';

const sha = bytes => crypto.subtle.digest('SHA-256', bytes).then(buffer => Buffer.from(buffer).toString('hex'));
const bytes = new Uint8Array([1, 2, 3]);
const digest = await sha(bytes);
const photo = id => ({ id, date: '2025-01-01', timestamp: 1735700400, fileName: `${id}.jpg`, mimeType: 'image/jpeg', width: 20, height: 10,
  ...Object.fromEntries(['original', 'display', 'thumbnail'].map(key => [key, { path: `photos/${id}/${key}.${key === 'original' ? 'jpg' : 'webp'}`, bytes: 3, sha256: digest }])) });
const day = { date: '2025-01-01', title: '2025-01-01', requestId: '10000000-0000-5000-8000-000000000000',
  photos: [photo('20000000-0000-5000-8000-000000000001'), photo('20000000-0000-5000-8000-000000000002')] };
const manifest = { version: 1, id: 'a'.repeat(64), year: 2025, timezone: 'Asia/Tokyo', days: [day] };
const destination = { origin: 'https://diary.example', householdId: 'test-household', loginId: 'test@example.test', role: 'user' };

function fixture() {
  let journal;
  let entry;
  let failAfter;
  let stop = false;
  let creates = 0;
  let uploads = 0;
  let unrelated = [];
  let staged = new Set();
  let sessionCounter = 0;
  let session = { authenticated: true, canManageEntries: true, activeHouseholdId: destination.householdId, loginId: destination.loginId, role: destination.role };
  async function api(path, options = {}) {
    if (path === '/session') return session;
    if (path.startsWith('/entries?')) return { entries: unrelated, hasMore: false };
    if (path === '/entries') {
      if (!entry) { creates++; entry = { id: 1, ...options.body, revision: 1, photos: [] }; }
      if (failAfter === 'create') { failAfter = null; throw new Error('lost create response'); }
      return { entry: structuredClone(entry) };
    }
    if (path === '/photo-upload-sessions') {
      sessionCounter++;
      return { uploadSession: { id: `30000000-0000-5000-8000-${String(sessionCounter).padStart(12, '0')}`, expiresAt: new Date(Date.now() + 86400000).toISOString() } };
    }
    if (options.method === 'DELETE') {
      staged.clear();
      if (failAfter === 'expired-cleanup') { failAfter = null; throw Object.assign(new Error('already cleaned'), { status: 404 }); }
      return { ok: true };
    }
    if (/\/photos\/[a-f0-9-]{36}$/.test(path)) {
      const id = path.split('/').at(-1);
      if (staged.has(id)) return { photo: { id } };
      throw Object.assign(new Error('missing staged photo'), { status: 404 });
    }
    if (path.endsWith('/commit')) {
      for (const id of options.body.photoIds) if (!entry.photos.some(photo => photo.id === id)) entry.photos.push({ id });
      if (failAfter === 'commit') { failAfter = null; throw new Error('lost commit response'); }
      return { photos: structuredClone(entry.photos) };
    }
    if (path.endsWith('/photos')) {
      const id = options.body.get('id');
      if (!staged.has(id)) { uploads++; staged.add(id); }
      if (failAfter === 'upload') { failAfter = null; throw new Error('lost upload response'); }
      if (failAfter === 'stop') { failAfter = null; stop = true; }
      return { photo: { id } };
    }
    if (options.method === 'PUT') {
      assert.equal(entry.photos.length, day.photos.length, 'must not publish a partial day');
      assert.equal(options.body.revision, entry.revision);
      Object.assign(entry, options.body, { revision: entry.revision + 1 });
      if (failAfter === 'publish') { failAfter = null; throw new Error('lost publish response'); }
    }
    return { entry: structuredClone(entry) };
  }
  return {
    get journal() { return journal; }, get entry() { return entry; }, get creates() { return creates; }, get uploads() { return uploads; },
    set failure(value) { failAfter = value; }, set unrelated(value) { unrelated = value; }, set session(value) { session = value; },
    resume() { stop = false; },
    engine(overrides = {}) { return new PhotoMigration({ manifest, journal: structuredClone(journal), destination, api,
      readFile: async () => bytes, saveJournal: async value => { journal = structuredClone(value); }, shouldStop: () => stop, ...overrides }); }
  };
}

test('resume after lost create response does not create a second diary', async () => {
  const f = fixture(); f.failure = 'create';
  await assert.rejects(f.engine().run(), /lost create/);
  assert.equal(f.journal.days[day.date].status, 'creating');
  await f.engine().run();
  assert.equal(f.creates, 1); assert.equal(f.uploads, 2); assert.equal(f.entry.content, photoContent(day));
  assert.equal(f.journal.days[day.date].status, 'complete');
});
test('resume after lost photo response reconciles saved photos', async () => {
  const f = fixture(); f.failure = 'upload';
  await assert.rejects(f.engine().run(), /lost upload/);
  assert.equal(f.entry.status, 'draft');
  await f.engine().run();
  assert.equal(f.creates, 1); assert.equal(f.uploads, 2);
});
test('resume after lost publication response does not repost or overwrite', async () => {
  const f = fixture(); f.failure = 'publish';
  await assert.rejects(f.engine().run(), /lost publish/);
  assert.equal(f.entry.status, 'published');
  await f.engine().run();
  assert.equal(f.creates, 1); assert.equal(f.uploads, 2); assert.equal(f.entry.revision, 2);
  await f.engine().run({ verifyOnly: true });
});
test('resume after lost staging commit response reconciles final photos', async () => {
  const f = fixture(); f.failure = 'commit';
  await assert.rejects(f.engine().run(), /lost commit/);
  assert.equal(f.entry.status, 'draft'); assert.equal(f.entry.photos.length, 2);
  await f.engine().run();
  assert.equal(f.creates, 1); assert.equal(f.uploads, 2); assert.equal(f.entry.status, 'published');
});
test('expired staging renews only the pending day, retaining completed records', async () => {
  const f = fixture(); f.failure = 'stop'; await f.engine().run();
  f.journal.days[day.date].uploadExpiresAt = '2020-01-01T00:00:00Z';
  f.resume(); await f.engine().run();
  assert.equal(f.creates, 1); assert.equal(f.uploads, 3); assert.equal(f.entry.photos.length, 2);
  assert.equal(f.entry.status, 'published');
});
test('expired staging already removed by cleanup is safely recreated', async () => {
  const f = fixture(); f.failure = 'stop'; await f.engine().run();
  f.journal.days[day.date].uploadExpiresAt = '2020-01-01T00:00:00Z';
  f.failure = 'expired-cleanup'; f.resume(); await f.engine().run();
  assert.equal(f.creates, 1); assert.equal(f.entry.status, 'published'); assert.equal(f.entry.photos.length, 2);
});
test('stopping leaves a draft and resumes without duplicating the saved photo', async () => {
  const f = fixture(); f.failure = 'stop';
  await f.engine().run();
  assert.equal(f.entry.status, 'draft'); assert.equal(f.uploads, 1);
  f.resume(); await f.engine().run();
  assert.equal(f.entry.status, 'published'); assert.equal(f.uploads, 2);
});
test('existing diaries are never overwritten', async () => {
  const f = fixture(); f.unrelated = [{ id: 9, entryDate: day.date }];
  await assert.rejects(f.engine().run(), /既存の日記/); assert.equal(f.creates, 0);
});
test('unrelated drafts outside the requested date do not block migration', async () => {
  const f = fixture(); f.unrelated = [{ id: 9, entryDate: '2026-01-01' }];
  await f.engine().run(); assert.equal(f.creates, 1);
});
test('journal must be writable before any production mutation', async () => {
  const f = fixture();
  await assert.rejects(f.engine({ saveJournal: async () => { throw new Error('disk failure'); } }).run(), /disk failure/);
  assert.equal(f.creates, 0);
});
test('changed local image fails its checksum before upload', async () => {
  const f = fixture();
  await assert.rejects(f.engine({ readFile: async () => new Uint8Array([9]) }).run(), /検証に失敗/);
  assert.equal(f.uploads, 0); assert.equal(f.entry.status, 'draft');
});
test('changed authentication or journal destination is rejected', async () => {
  const f = fixture(); f.session = { authenticated: true, canManageEntries: true, activeHouseholdId: 'another-household' };
  await assert.rejects(f.engine().run(), /ログイン先/); assert.equal(f.creates, 0);
  assert.throws(() => f.engine({ destination: { ...destination, role: 'admin' } }), /保存先/);
});
test('changed draft and published content are not overwritten on resume', async () => {
  const f = fixture(); f.failure = 'stop'; await f.engine().run();
  f.entry.content = 'user edit'; f.resume();
  await assert.rejects(f.engine().run(), /下書きが変更/);
  f.entry.status = 'published';
  await assert.rejects(f.engine().run(), /一致しません/);
});
test('unsafe paths, duplicate IDs, and unsorted timestamps are rejected', () => {
  for (const mutate of [
    m => { m.days[0].photos[0].original.path = '../secret'; },
    m => { m.days[0].photos[1].id = m.days[0].photos[0].id; },
    m => { m.days[0].photos[1].timestamp--; }
  ]) {
    const copy = structuredClone(manifest); mutate(copy); assert.throws(() => validateManifest(copy));
  }
});

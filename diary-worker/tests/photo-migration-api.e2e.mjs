import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { passkeyFixtureArgs } from './passkey-fixture.mjs';
import { PhotoMigration } from '../public/photo-migration-core.js';

// Synthetic bytes and local D1/R2 only; never use a personal browser or production data.
const cwd = fileURLToPath(new URL('../', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const persist = mkdtempSync(join(tmpdir(), 'diary-migration-api-'));
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const migrated = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'diary-db', '--local', '--persist-to', persist], { cwd, encoding: 'utf8' });
assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
const server = spawn(process.execPath, [wrangler, 'dev', ...passkeyFixtureArgs, '--local', '--persist-to', persist, '--port', String(port),
  '--var', 'DIARY_MAIN_ADMIN_LOGIN_ID:main@example.test', '--var', `SESSION_SECRET:${randomBytes(32).toString('hex')}`], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.resume(); server.stderr.resume();
let cookie;
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${origin}/diary/api${path}`, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'X-Diary-Request': '1',
      ...(body instanceof FormData || body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json();
  assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(result)}`);
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';', 1)[0];
  return result;
}
try {
  for (let attempt = 0; ; attempt++) {
    try { await api('/session'); break; }
    catch (error) {
      if (attempt >= 80 || server.exitCode !== null) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  await api('/passkey/handoff', { method: 'POST', body: { handoffToken: 'fixture-main-admin' } });
  const session = await api('/session');
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const photos = ['20000000-0000-4000-8000-000000000001', '20000000-0000-5000-8000-000000000002'].map((id, index) => ({
    id, date: '2025-01-01', timestamp: 1735700400 + index, fileName: `migration-${index}.png`, mimeType: 'image/png', width: 2, height: 2,
    ...Object.fromEntries(['original', 'display', 'thumbnail'].map(key => [key, {
      path: `photos/${id}/${key}.${key === 'original' ? 'png' : 'webp'}`,
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')
    }]))
  }));
  const manifest = { version: 1, id: 'b'.repeat(64), year: 2025, timezone: 'Asia/Tokyo', days: [{
    date: '2025-01-01', title: '2025-01-01', requestId: '10000000-0000-5000-8000-000000000000', photos
  }] };
  let journal;
  const options = { manifest, destination: { origin, householdId: session.activeHouseholdId, loginId: session.loginId, role: session.role },
    api, readFile: async () => bytes, saveJournal: async value => { journal = structuredClone(value); } };
  await new PhotoMigration(options).run();
  assert.equal(journal.days['2025-01-01'].status, 'complete');
  const entryId = journal.days['2025-01-01'].entryId;
  await new PhotoMigration({ ...options, journal }).run();
  await new PhotoMigration({ ...options, journal }).run({ verifyOnly: true });
  const entry = (await api(`/entries/${entryId}`)).entry;
  assert.equal(entry.status, 'published');
  assert.equal(entry.title, '2025-01-01');
  assert.equal(entry.content, photos.map(photo => `[[写真:${photo.id}]]`).join('\n'));
  assert.deepEqual(entry.photos.map(photo => photo.id), photos.map(photo => photo.id));
  for (const photo of entry.photos) {
    const response = await fetch(`${origin}${photo.originalUrl}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  }
  const entries = (await api('/entries?dateFrom=2025-01-01&dateTo=2025-01-01')).entries;
  assert.deepEqual(entries.map(entry => entry.id), [entryId]);
  console.log('PhotoMigration real Worker: v4/v5 IDs, create, staging, commit, publication, resume, order and original bytes passed.');
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]);
  }
  try { rmSync(persist, { recursive: true, force: true }); } catch {}
}

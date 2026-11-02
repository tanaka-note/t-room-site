import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Entirely synthetic fixture: no production cookies, files, uploads, or tracing.
const session = { authenticated: true, canManageEntries: true, accountName: 'fixture', accountDisplayName: 'fixture',
  activeHouseholdId: 'fixture', loginId: 'fixture@example.test', role: 'user' };
const original = new Uint8Array([1, 2, 3]);
const digest = Buffer.from(await crypto.subtle.digest('SHA-256', original)).toString('hex');
const id = '20000000-0000-5000-8000-000000000001';
const manifest = { version: 1, id: 'a'.repeat(64), year: 2025, timezone: 'Asia/Tokyo', days: [{
  date: '2025-01-01', title: '2025-01-01', requestId: '10000000-0000-5000-8000-000000000000', photos: [{
    id, date: '2025-01-01', timestamp: 1735700400, fileName: 'fixture.jpg', mimeType: 'image/jpeg', width: 20, height: 10,
    ...Object.fromEntries(['original', 'display', 'thumbnail'].map(key => [key, { path: `photos/${id}/${key}.${key === 'original' ? 'jpg' : 'webp'}`, bytes: 3, sha256: digest }]))
  }]
}] };
let entry, requests = 0;
const staged = new Set();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/diary/api/session') return json(session);
  if (url.pathname.includes('/api/')) {
    if (req.method === 'GET') return json(url.pathname.endsWith('/entries') ? { entries: [], hasMore: false } : { entry });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests++;
    if (url.pathname.endsWith('/photo-upload-sessions')) return json({ uploadSession: { id: '30000000-0000-5000-8000-000000000001', expiresAt: new Date(Date.now() + 86400000).toISOString() } });
    if (req.method === 'POST' && url.pathname.endsWith('/entries')) {
      entry = { id: 1, ...JSON.parse(body), revision: 1, photos: [] }; return json({ entry });
    }
    if (url.pathname.endsWith('/photos')) { staged.add(id); return json({ photo: { id } }); }
    if (url.pathname.endsWith('/commit')) { entry.photos = [...staged].map(id => ({ id })); return json({ photos: entry.photos }); }
    Object.assign(entry, JSON.parse(body)); entry.revision++; return json({ entry });
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<div id="boot-view"></div><div id="login-view"></div><div id="app-view" hidden></div><script type="module">import {startDiary} from '/diary/diary.js'; await startDiary(${JSON.stringify(session)});</script>`);
  }
  try {
    const name = url.pathname.slice('/diary/'.length);
    if (!['diary.js', 'photo-migration.js', 'photo-migration-core.js', 'photo-migration.css'].includes(name)) throw Error('not found');
    res.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css' : 'application/javascript' });
    res.end(await readFile(new URL(`../../public/${name}`, import.meta.url)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ manifest }) => {
    const store = new Map([['manifest.json', JSON.stringify(manifest)]]);
    window.fixtureStore = store;
    function handle(prefix = '') {
      return {
        getDirectoryHandle: async name => handle(prefix + name + '/'),
        getFileHandle: async (name, options = {}) => {
          const path = prefix + name;
          if (!store.has(path) && !path.startsWith('photos/') && !options.create) throw new DOMException('missing', 'NotFoundError');
          return {
            getFile: async () => new Blob([path.startsWith('photos/') ? new Uint8Array([1, 2, 3]) : store.get(path)]),
            createWritable: async () => {
              let pending;
              return { write: async value => { pending = value; }, close: async () => { store.set(path, pending); }, abort: async () => {} };
            }
          };
        }
      };
    }
    window.showDirectoryPicker = async () => handle();
  }, { manifest });
  await page.goto(`http://127.0.0.1:${server.address().port}/?takeout-migration=2025`);
  await page.getByRole('button', { name: '移行フォルダを選択', exact: true }).click();
  await page.getByText('準備完了', { exact: true }).waitFor();
  assert.equal(requests, 0, 'selecting files does not upload or write production data');
  await page.getByRole('button', { name: '未処理の1日分を取り込む', exact: true }).click();
  await page.getByText('処理完了：1/1日を保存済み', { exact: true }).first().waitFor();
  assert.equal(entry.status, 'published'); assert.equal(entry.content, `[[写真:${id}]]`);
  const journal = await page.evaluate(() => JSON.parse(window.fixtureStore.get('migration-progress.json')));
  assert.equal(journal.days['2025-01-01'].status, 'complete');
  assert.equal(journal.days['2025-01-01'].entryId, 1);
  await page.getByRole('button', { name: '保存結果を照合', exact: true }).click();
  await page.getByText('処理完了：1/1日を保存済み', { exact: true }).first().waitFor();
  assert.equal(requests, 5, 'verification never modifies saved diaries');
  assert.deepEqual(errors, []);
  console.log('photo migration browser fixture passed (folder, durable journal, API upload, publication, verification)');
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}

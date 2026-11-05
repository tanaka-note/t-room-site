import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

// Entirely synthetic fixture: no production cookies, files, uploads, or tracing.
const session = { authenticated: true, canManageEntries: true, accountName: 'fixture', accountDisplayName: 'fixture',
  activeHouseholdId: 'fixture', loginId: 'fixture@example.test', role: 'user' };
const original = new Uint8Array([1, 2, 3]);
const digest = Buffer.from(await crypto.subtle.digest('SHA-256', original)).toString('hex');
const id = '20000000-0000-5000-8000-000000000001';
const manifest2025 = { version: 1, id: 'a'.repeat(64), year: 2025, timezone: 'Asia/Tokyo', days: [{
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
const temporary = await mkdtemp(join(tmpdir(), 'diary-migration-folder-'));
try {
  for (const [year, date, manifestKey] of [[2025, '2025-01-01', 'a'], [2024, '2024-02-29', 'b'], [2023, '2023-12-31', 'c']]) {
  const manifest = structuredClone(manifest2025);
  manifest.year = year;
  manifest.id = manifestKey.repeat(64);
  manifest.days[0].date = manifest.days[0].title = date;
  manifest.days[0].photos[0].date = date;
  manifest.days[0].photos[0].timestamp = Date.parse(`${date}T12:00:00+09:00`) / 1000;
  entry = undefined; requests = 0; staged.clear();
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
  await page.goto(`http://127.0.0.1:${server.address().port}/?takeout-migration=${year}`);
  await page.getByRole('heading', { name: `${year}年 写真移行`, exact: true }).waitFor();
  assert.equal(await page.locator('#migration-through').inputValue(), `${year}-12-31`);
  assert.equal(await page.locator('#migration-through').getAttribute('min'), `${year}-01-01`);
  assert.equal(await page.locator('#migration-through').getAttribute('max'), `${year}-12-31`);
  await page.getByRole('button', { name: '移行フォルダを選択', exact: true }).click();
  await page.getByText('準備完了', { exact: true }).waitFor();
  assert.equal(requests, 0, 'selecting files does not upload or write production data');
  await page.getByRole('button', { name: '未処理の1日分を取り込む', exact: true }).click();
  await page.getByText('処理完了：1/1日を保存済み', { exact: true }).first().waitFor();
  assert.equal(entry.status, 'published'); assert.equal(entry.content, `[[写真:${id}]]`);
  const journal = await page.evaluate(() => JSON.parse(window.fixtureStore.get('migration-progress.json')));
  assert.equal(journal.days[date].status, 'complete');
  assert.equal(journal.days[date].entryId, 1);
  assert.equal(entry.entryDate, date); assert.equal(entry.title, date);
  await page.getByRole('button', { name: '保存結果を照合', exact: true }).click();
  await page.getByText('処理完了：1/1日を保存済み', { exact: true }).first().waitFor();
  assert.equal(requests, 5, 'verification never modifies saved diaries');
  assert.deepEqual(errors, []);
  console.log(`${year} photo migration browser fixture passed (folder, durable journal, API upload, publication, verification)`);
  await page.close();

  const folder = join(temporary, String(year), 'package');
  await mkdir(join(folder, 'photos', id), { recursive: true });
  await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest));
  for (const key of ['original', 'display', 'thumbnail']) await writeFile(join(folder, manifest.days[0].photos[0][key].path), original);
  entry = undefined; requests = 0; staged.clear();
  const standardPage = await browser.newPage();
  standardPage.on('pageerror', error => errors.push(error.message));
  await standardPage.goto(`http://127.0.0.1:${server.address().port}/?takeout-migration=${year}`);
  async function chooseFolder() {
    const chooserPromise = standardPage.waitForEvent('filechooser');
    await standardPage.getByLabel('標準のフォルダー選択', { exact: true }).click();
    await (await chooserPromise).setFiles(folder);
    await standardPage.getByText('準備完了', { exact: true }).waitFor();
  }
  await chooseFolder();
  assert.equal(requests, 0, 'standard folder selection never uploads files or mutates diaries');
  await standardPage.getByRole('button', { name: '未処理の1日分を取り込む', exact: true }).click();
  await standardPage.getByText('処理完了：1/1日を保存済み', { exact: true }).first().waitFor();
  assert.equal(requests, 5);
  assert.equal(entry.status, 'published');
  const downloadPromise = standardPage.waitForEvent('download');
  await standardPage.getByRole('link', { name: '再開用の進捗ファイルを保存', exact: true }).click();
  const downloadPath = await (await downloadPromise).path();
  const exported = JSON.parse(await readFile(downloadPath, 'utf8'));
  assert.equal(exported.manifestId, manifest.id);
  assert.equal(exported.days[date].status, 'complete');
  assert.ok(exported.checkpoint > 0);
  assert.ok(!('photos' in exported) && !('cookie' in exported) && !('token' in exported));
  await standardPage.reload();
  await chooseFolder();
  assert.match(await standardPage.locator('#migration-summary').innerText(), /完了済み 1日/);
  await standardPage.getByRole('button', { name: '未処理の1日分を取り込む', exact: true }).click();
  await standardPage.getByText('処理完了：1/1日を保存済み', { exact: true }).first().waitFor();
  assert.equal(requests, 5, 'reload resumes IndexedDB journal without duplicate mutation');
  assert.deepEqual(errors, []);
  console.log(`${year} standard directory chooser, IndexedDB checkpoint, progress export, and reload resume passed`);
  await standardPage.goto(`http://127.0.0.1:${server.address().port}/?takeout-migration=${year === 2024 ? 2025 : 2024}`);
  const wrongChooser = standardPage.waitForEvent('filechooser');
  await standardPage.getByLabel('標準のフォルダー選択', { exact: true }).click();
  await (await wrongChooser).setFiles(folder);
  await standardPage.getByText(`選択されたデータは${year}年分です。`, { exact: false }).waitFor();
  assert.equal(await standardPage.getByRole('button', { name: '終了日まで取り込む', exact: true }).isDisabled(), true);
  assert.equal(requests, 5, 'wrong-year package cannot upload, publish or change saved diaries');
  assert.deepEqual(errors, []);
  await standardPage.close();
  }
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}

import { selectAlbumMonth } from "./album-month-fixture.mjs";
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { createDiaryFixtureServer } from './bootstrap-fixture.mjs';

const publicRoot = new URL('../../public/', import.meta.url);
const photoId = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const photos = Array.from({ length: 60 }, (_, i) => ({ id: photoId(i + 1), entryId: 1,
  entryDate: '2026-10-29', entryTitle: '並び確認', fileName: `${i + 1}.png`,
  thumbnailUrl: `/fixture-photo/${i + 1}.svg`, displayUrl: `/fixture-photo/${i + 1}.svg` }));
const entry = { id: 1, entryDate: '2026-10-29', title: '並び確認', content: [1, 2, 3].map(n => `[[写真:${photoId(n)}]]`).join(''),
  photos: photos.slice(0, 3), tags: [], status: 'published', revision: 1 };
const requests = [];
let holdOldest = false, releaseStale = null;
function json(response, data) {
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
}
const server = createDiaryFixtureServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname.startsWith('/diary/api/')) {
    const path = url.pathname.slice('/diary/api'.length);
    if (path === '/session') return json(response, { authenticated: true, accountName: 'Fixture', role: 'admin',
      activeHouseholdId: 'tanaka-household', householdId: 'tanaka-household', canManageEntries: true, canViewTrash: true });
    if (path === '/meta') return json(response, { months: [{ value: '2026-10', count: 1 }], tags: [], draftCount: 0 });
    if (path === '/entries') return json(response, { entries: [entry], hasMore: false });
    if (path === '/entries/1') return json(response, { entry });
    if (path === '/photos/meta') return json(response, { months: [
      { value: '2026-10', count: 60 }, { value: '2025-10', count: 4 }, { value: '2025-11', count: 1234 }
    ] });
    if (path === '/photos') {
      requests.push(Object.fromEntries(url.searchParams));
      const oldest = url.searchParams.get('month') && url.searchParams.get('order') === 'oldest';
      const ordered = oldest ? photos : [...photos].reverse();
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 48);
      if (oldest && holdOldest) {
        holdOldest = false;
        await new Promise(resolve => { releaseStale = resolve; });
      }
      return json(response, { photos: ordered.slice(offset, offset + limit), hasMore: offset + limit < ordered.length });
    }
    return json(response, {});
  }
  const image = url.pathname.match(/^\/fixture-photo\/(\d+)\.svg$/);
  if (image) {
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    return response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#d9ece8"/><text x="80" y="90" text-anchor="middle" font-size="35">${image[1]}</text></svg>`);
  }
  const special = { '/assets/pwa-auto-update.js': new URL('../../assets/pwa-auto-update.js', publicRoot),
    '/security/passkey-client.js': new URL('../../security-worker/public/passkey-client.js', publicRoot) };
  const relative = url.pathname === '/diary/' ? 'index.html' : url.pathname.replace(/^\/diary\//, '');
  const file = special[url.pathname] || new URL(relative, publicRoot);
  if (!special[url.pathname] && !file.href.startsWith(publicRoot.href)) return response.writeHead(404).end();
  try {
    const content = await readFile(file);
    response.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' })[extname(file.pathname)] || 'application/octet-stream' });
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = [process.env.TROOM_CHROMIUM_EXECUTABLE, chromium.executablePath(),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => p && existsSync(p));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  for (const [name, options] of [['desktop', { viewport: { width: 1280, height: 900 } }],
    ['touch', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
    const context = await browser.newContext(options);
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const order = () => page.locator('#camera-roll-grid img').evaluateAll(images => images.map(image => Number.parseInt(image.alt)));
    const waitFirst = first => page.waitForFunction(n => document.querySelector('#camera-roll-grid img')?.alt === `${n}.png`, first);
    try {
      await page.goto(`${origin}/diary/`);
      await page.waitForSelector('#app-view:not([hidden])');
      await page.click('[data-entry-id="1"]');
      await page.waitForSelector('#entry-dialog[open] .entry-photo');
      assert.deepEqual(await page.locator('#entry-dialog .entry-photo').evaluateAll(images => images.map(i => i.alt)), ['1.png', '2.png', '3.png']);
      await page.locator('#entry-dialog .entry-photo').first().click();
      await page.waitForSelector('#photo-viewer-dialog[open]');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('#photo-viewer-image').alt === '2.png');
      await page.click('[data-close-dialog="photo-viewer-dialog"]');
      await page.waitForSelector('#photo-viewer-dialog', { state: 'hidden' });
      await page.click('[data-close-dialog="entry-dialog"]');
      await page.waitForSelector('#entry-dialog', { state: 'hidden' });
      await page.click('#camera-roll-button');
      await waitFirst(60);
      await page.waitForFunction(() => document.getElementById('photo-month-filter').textContent === 'すべて（1,298枚）');
      assert.equal(await page.locator('#photo-month-filter svg').count(), 0, 'no calendar icon');
      const requestCount = requests.length;
      await page.locator('#photo-month-filter').focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('#date-wheel-dialog[open]');
      assert.equal(await page.locator('#date-wheel-title').textContent(), '年月を選択');
      assert.equal(await page.locator('#date-wheel-day').isVisible(), false);
      assert.equal(await page.locator('#date-wheel-all').textContent(), 'すべて（1,298枚）');
      assert.equal(await page.locator('#date-wheel-month .date-wheel-option').count(), 12);
      await page.locator('#date-wheel-year [data-value="2026"]').click();
      await page.waitForFunction(() => document.querySelector('#date-wheel-year').dataset.settingScroll !== 'true');
      const counts = () => page.locator('#date-wheel-month .date-wheel-count').allTextContents();
      assert.deepEqual(await counts(), Array.from({ length: 12 }, (_, i) => i === 9 ? '60枚' : '0枚'));
      const monthTop = await page.locator('#date-wheel-month').evaluate(node => node.scrollTop);
      // Multiple scroll events leave all 12 counts intact until the year settles.
      assert.equal(await page.evaluate(() => {
        const column = document.getElementById('date-wheel-year');
        for (const year of [2024, 2025]) {
          column.scrollTop = (year - 1900) * 44;
          column.dispatchEvent(new Event('scroll'));
        }
        return document.getElementById('date-wheel-month').dataset.countYear;
      }), '2026');
      await page.waitForFunction(() => document.getElementById('date-wheel-month').dataset.countYear === '2025');
      assert.deepEqual(await counts(), Array.from({ length: 12 }, (_, i) => i === 9 ? '4枚' : i === 10 ? '1,234枚' : '0枚'));
      assert.equal(await page.locator('#date-wheel-month').evaluate(node => node.scrollTop), monthTop);
      assert.equal(await page.locator('#date-wheel-all').textContent(), 'すべて（1,298枚）');
      assert.equal(requests.length, requestCount, 'browsing years never fetches photos');
      await page.locator('#date-wheel-year [data-value="2024"]').click();
      assert.deepEqual(await counts(), Array(12).fill('0枚'), 'an empty year retains all 12 selectable months');
      assert.equal(await page.locator('#date-wheel-month button:disabled').count(), 0);
      await page.locator('#date-wheel-year [data-value="2025"]').click();
      if (process.env.TROOM_ALBUM_SCREENSHOT_DIR) {
        await mkdir(process.env.TROOM_ALBUM_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.TROOM_ALBUM_SCREENSHOT_DIR, `month-picker-${name}.png`) });
      }
      await page.click('#date-wheel-cancel');
      await page.waitForFunction(() => !document.getElementById('date-wheel-dialog').open);
      assert.equal(await page.locator('#photo-month-filter').evaluate(node => node.value), '');
      assert.equal(await page.locator('#photo-month-filter').evaluate(node => node === document.activeElement), true);
      assert.equal(requests.length, requestCount, 'cancel does not filter');
      await page.click('#photo-month-filter');
      await page.waitForSelector('#date-wheel-dialog[open]');
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => !document.getElementById('date-wheel-dialog').open);
      assert.equal(await page.locator('#camera-roll-dialog').evaluate(node => node.open), true);
      assert.equal(await page.locator('#photo-sort-button').isVisible(), false);
      assert.equal(requests.at(-1).order, undefined);
      await Promise.all([page.waitForResponse(r => r.url().includes('/api/photos?') && r.url().includes('month=2026-10')),
        selectAlbumMonth(page, '2026-10')]);
      await waitFirst(1);
      assert.equal(requests.at(-1).order, 'oldest');
      assert.equal(await page.locator('#photo-sort-button').getAttribute('aria-pressed'), 'true');
      assert.match(await page.locator('#photo-sort-button').getAttribute('aria-label'), /古い順で表示中/);
      assert.deepEqual(await order(), Array.from({ length: 48 }, (_, i) => i + 1));
      assert.equal(requests.at(-1).offset, '0');
      await page.click('#camera-roll-more');
      await page.waitForFunction(() => document.querySelectorAll('#camera-roll-grid img').length === 60);
      assert.deepEqual(await order(), Array.from({ length: 60 }, (_, i) => i + 1));
      await page.locator('#camera-roll-grid button').first().click();
      await page.waitForSelector('#photo-viewer-dialog[open]');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('#photo-viewer-image').alt === '2.png');
      await page.click('[data-close-dialog="photo-viewer-dialog"]');
      await page.waitForSelector('#photo-viewer-dialog', { state: 'hidden' });
      assert.equal(await page.locator('#photo-sort-button').getAttribute('aria-pressed'), 'true');
      if (process.env.TROOM_ALBUM_SCREENSHOT_DIR) {
        await mkdir(process.env.TROOM_ALBUM_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.TROOM_ALBUM_SCREENSHOT_DIR, `${name}.png`) });
      }
      await page.click('#photo-sort-button');
      await waitFirst(60);
      // Also cover the second page in descending order: switching direction
      // after paging must reset the offset, then append 60..1 without duplicates.
      await page.click('#camera-roll-more');
      await page.waitForFunction(() => document.querySelectorAll('#camera-roll-grid img').length === 60);
      assert.deepEqual(await order(), Array.from({ length: 60 }, (_, i) => 60 - i));
      assert.equal(requests.at(-1).order, 'newest');
      assert.equal(requests.at(-1).offset, '48');
      // An older sort request must never overwrite a newer sort selection.
      holdOldest = true;
      await page.click('#photo-sort-button');
      for (let attempt = 0; attempt < 200 && !releaseStale; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(releaseStale, 'the slow sort request reached the server');
      await page.click('#photo-sort-button');
      await waitFirst(60);
      const staleDone = page.waitForResponse(r => r.url().includes('/api/photos?') && r.url().includes('order=oldest'));
      releaseStale(); releaseStale = null;
      await staleDone;
      await page.waitForTimeout(50);
      assert.equal((await order())[0], 60);
      await page.click('#photo-sort-button');
      await waitFirst(1);
      await selectAlbumMonth(page, '');
      await waitFirst(60);
      assert.equal(await page.locator('#photo-sort-button').isVisible(), false);
      assert.equal(requests.at(-1).order, undefined);
      await selectAlbumMonth(page, '2026-10');
      await waitFirst(1);
      assert.equal(requests.at(-1).order, 'oldest');
      assert.equal(requests.at(-1).offset, '0');
      assert.equal(await page.locator('#photo-sort-button').isVisible(), true);
      assert.equal(await page.locator('#photo-sort-button').getAttribute('aria-pressed'), 'true');
      // Closing the album clears its own filters; closing a child must not.
      for (const close of ['button', 'escape', 'back', 'backdrop']) {
        await page.fill('#photo-entry-search', 'reset-fixture');
        await page.waitForResponse(response => response.url().includes('entryQuery=reset-fixture'));
        await page.click('#photo-sort-button'); await waitFirst(60);
        await page.locator('#camera-roll-grid button').first().click();
        await page.waitForSelector('#photo-viewer-dialog[open]');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('photo-viewer-dialog').open);
        assert.equal(await page.locator('#photo-entry-search').inputValue(), 'reset-fixture');
        assert.equal(await page.locator('#photo-month-filter').evaluate(node => node.value), '2026-10');
        const card = await page.locator('#camera-roll-grid button').first().elementHandle();
        await page.locator('#camera-roll-dialog').evaluate(node => { node.scrollTop = 200; });
        if (close === 'button') await page.click('[data-close-dialog="camera-roll-dialog"]');
        else if (close === 'escape') await page.keyboard.press('Escape');
        else if (close === 'back') await page.evaluate(() => history.back());
        else {
          const rect = await page.locator('#camera-roll-dialog').boundingBox();
          if (options.hasTouch) await page.touchscreen.tap(rect.x / 2, rect.y + 20);
          else await page.mouse.click(rect.x / 2, rect.y + 20);
        }
        await page.waitForFunction(() => !document.getElementById('camera-roll-dialog').open);
        assert.equal(await page.locator('#photo-entry-search').inputValue(), '');
        assert.equal(await page.locator('#photo-month-filter').evaluate(node => node.value), '');
        assert.equal(await card.evaluate(node => node.isConnected), false);
        await page.click('#camera-roll-button'); await waitFirst(60);
        assert.equal(await page.locator('#photo-sort-button').isVisible(), false);
        assert.equal(await page.locator('#camera-roll-dialog').evaluate(node => node.scrollTop), 0);
        assert.equal(requests.at(-1).month, undefined);
        assert.equal(requests.at(-1).entryQuery, undefined);
        assert.equal(requests.at(-1).offset, '0');
        await selectAlbumMonth(page, '2026-10'); await waitFirst(1);
      }
      await page.fill('#photo-entry-search', 'reset-fixture');
      await page.waitForResponse(response => response.url().includes('entryQuery=reset-fixture'));
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => !document.getElementById('camera-roll-dialog').open);
      await page.evaluate(() => history.forward());
      await page.waitForSelector('#camera-roll-dialog[open]'); await waitFirst(60);
      assert.equal(await page.locator('#photo-month-filter').evaluate(node => node.value), '');
      assert.equal(await page.locator('#photo-entry-search').inputValue(), '');
      assert.equal(await page.locator('#camera-roll-dialog').evaluate(node => node.scrollTop), 0);
      assert.deepEqual(errors, []);
      console.log(`Album order ${name}: oldest monthly default, toggle, pagination, viewer, return and stale responses passed.`);
    } finally { if (releaseStale) { releaseStale(); releaseStale = null; } await context.close(); }
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

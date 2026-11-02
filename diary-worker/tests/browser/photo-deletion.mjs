import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { chromium } from 'playwright';
import { createDiaryFixtureServer } from './bootstrap-fixture.mjs';

const publicRoot = new URL('../../public/', import.meta.url);
const photoId = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
let photos, entry, canManage = true, failDelete = false, holdDelete = false, releaseDelete;
const requests = [], deletes = [];
const json = (response, data, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
};
function reset() {
  photos = Array.from({ length: 60 }, (_, i) => ({ id: photoId(i + 1), entryId: 1,
    entryDate: i === 59 ? '2026-11-02' : '2026-10-29', entryTitle: '削除確認', fileName: `fixture-${i + 1}.png`,
    thumbnailUrl: '/fixture.svg', displayUrl: '/fixture.svg', originalUrl: `/original/${i + 1}` }));
  entry = { id: 1, entryDate: '2026-10-29', title: '削除確認', content: '本文' + photos.map(p => `[[写真:${p.id}]]`).join(''),
    photos, tags: [], status: 'published', revision: 1 };
  requests.length = 0; deletes.length = 0;
  canManage = true; failDelete = false; holdDelete = false;
}
const server = createDiaryFixtureServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const path = url.pathname.replace('/diary/api', '');
  if (url.pathname.startsWith('/diary/api/')) {
    if (path === '/session') return json(response, { authenticated: true, role: canManage ? 'admin' : 'user',
      activeHouseholdId: 'tanaka-household', householdId: 'tanaka-household', canManageEntries: canManage, canViewTrash: canManage });
    if (path === '/meta') return json(response, { months: [{ value: '2026-10', count: 1 }], tags: [], draftCount: 0 });
    if (path === '/entries') return json(response, { entries: [entry], hasMore: false });
    if (path === '/entries/1') return json(response, { entry });
    if (path === '/photos/meta') return json(response, { months: ['2026-11','2026-10'].map(value => ({ value,
      count: photos.filter(p => p.entryDate.startsWith(value)).length })).filter(item => item.count) });
    if (path === '/photos') {
      requests.push(Object.fromEntries(url.searchParams));
      const month = url.searchParams.get('month'), file = url.searchParams.get('fileName');
      let result = photos.filter(p => (!month || p.entryDate.startsWith(month)) && (!file || p.fileName.includes(file)));
      if (!month || url.searchParams.get('order') !== 'oldest') result = [...result].reverse();
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 48);
      return json(response, { photos: result.slice(offset, offset + limit), hasMore: offset + limit < result.length });
    }
    if (path.startsWith('/photos/') && request.method === 'DELETE') {
      let text = ''; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      const id = path.split('/').at(-1);
      deletes.push({ id, body });
      if (holdDelete) await new Promise(resolve => { releaseDelete = resolve; });
      if (failDelete) return json(response, { error: 'fixture conflict' }, 409);
      assert.equal(body.revision, entry.revision);
      photos = photos.filter(p => p.id !== id);
      entry = { ...entry, content: entry.content.replace(`[[写真:${id}]]`, ''), photos, revision: entry.revision + 1 };
      return json(response, { ok: true, entryId: 1, revision: entry.revision, content: entry.content, contentFormat: null });
    }
    return json(response, {});
  }
  if (url.pathname === '/fixture.svg') {
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    return response.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ddeee8"/></svg>');
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
  for (const touch of [false, true]) {
    reset();
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 900 }, isMobile: touch, hasTouch: touch, serviceWorkers: 'block' });
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const open = id => page.waitForFunction(id => document.getElementById(id).open, id);
    const closed = id => page.waitForFunction(id => !document.getElementById(id).open, id);
    const clickPhoto = id => page.locator(`[data-photo-id="${photoId(id)}"]`).evaluate(button => button.click());
    const confirm = async () => { await page.click('#photo-delete'); await open('delete-confirm-dialog'); };
    try {
      await page.goto(`${origin}/diary/`);
      await page.waitForSelector('#app-view:not([hidden])');
      await page.click('#camera-roll-button'); await open('camera-roll-dialog');
      await page.selectOption('#photo-month-filter', '2026-10');
      await page.fill('#photo-entry-search', 'fixture');
      await page.waitForFunction(() => document.querySelectorAll('[data-photo-id]').length === 48 && !document.getElementById('camera-roll-more').disabled);
      await page.waitForTimeout(350);
      await page.locator('#camera-roll-dialog').evaluate(dialog => { dialog.scrollTop = 450; });
      const beforeScroll = await page.locator('#camera-roll-dialog').evaluate(dialog => dialog.scrollTop);
      await clickPhoto(20); await open('photo-viewer-dialog');
      assert.equal(await page.locator('#photo-download-low').count(), 0);
      assert.equal(await page.locator('#photo-delete').isVisible(), true);
      await confirm(); await page.click('#delete-confirm-no'); await closed('delete-confirm-dialog');
      await confirm(); await page.keyboard.press('Escape'); await closed('delete-confirm-dialog');
      await confirm(); await page.evaluate(() => history.back()); await closed('delete-confirm-dialog');
      await confirm();
      const rect = await page.locator('#delete-confirm-dialog').boundingBox();
      if (touch) await page.touchscreen.tap(Math.max(1, rect.x / 2), Math.max(1, rect.y / 2));
      else await page.mouse.click(Math.max(1, rect.x / 2), Math.max(1, rect.y / 2));
      await closed('delete-confirm-dialog');
      assert.equal(deletes.length, 0, 'cancel, Esc, Back and backdrop never delete');
      holdDelete = true;
      await confirm(); await page.click('#delete-confirm-yes');
      await page.waitForFunction(() => document.getElementById('delete-confirm-yes').disabled);
      await page.keyboard.press('Escape');
      await page.evaluate(() => history.back());
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#delete-confirm-dialog').evaluate(d => d.open), true, 'busy confirmation stays open');
      assert.equal(await page.locator('#photo-viewer-dialog').evaluate(d => d.open), true);
      assert.equal(deletes.length, 1, 'one mutation only');
      holdDelete = false; releaseDelete(); releaseDelete = null;
      await closed('delete-confirm-dialog');
      await page.waitForFunction(() => document.getElementById('photo-viewer-image').alt === 'fixture-21.png');
      assert.equal(await page.locator('#photo-download-original').getAttribute('href'), '/original/21?download=1');
      assert.equal(await page.locator(`[data-photo-id="${photoId(20)}"]`).count(), 0);
      assert.match(await page.locator('#photo-month-filter option[value="2026-10"]').textContent(), /58/);
      failDelete = true;
      await confirm(); await page.click('#delete-confirm-yes'); await closed('delete-confirm-dialog');
      assert.equal(await page.locator('#photo-viewer-image').getAttribute('alt'), 'fixture-21.png');
      assert.equal(await page.locator('[data-photo-id]').count(), 47);
      failDelete = false;
      await page.keyboard.press('Escape'); await closed('photo-viewer-dialog');
      assert.equal(await page.locator('#camera-roll-dialog').evaluate(d => d.scrollTop), beforeScroll, 'return keeps album position');
      await page.evaluate(() => history.forward()); await open('photo-viewer-dialog');
      assert.notEqual(await page.locator('#photo-viewer-image').getAttribute('alt'), 'fixture-20.png', 'Forward never restores a deleted photo');
      await page.keyboard.press('Escape'); await closed('photo-viewer-dialog');
      requests.length = 0;
      await page.click('#camera-roll-more');
      await page.waitForFunction(() => document.getElementById('camera-roll-more').hidden);
      assert.equal(requests[0].offset, '47', 'pagination compensates for deleted loaded item');
      assert.equal(requests[0].entryQuery, 'fixture');
      assert.equal(requests[0].order, 'oldest');
      const ids = await page.locator('[data-photo-id]').evaluateAll(nodes => nodes.map(node => node.dataset.photoId));
      assert.equal(ids.length, 58); assert.equal(new Set(ids).size, 58);
      assert.equal(ids.at(-1), photoId(59), 'no skipped tail photo');
      await clickPhoto(59); await open('photo-viewer-dialog');
      await confirm(); await page.click('#delete-confirm-yes'); await closed('delete-confirm-dialog');
      await page.waitForFunction(() => document.getElementById('photo-viewer-image').alt === 'fixture-58.png');
      await page.keyboard.press('Escape'); await closed('photo-viewer-dialog');
      await page.selectOption('#photo-month-filter', '2026-11');
      await page.waitForFunction(() => document.querySelectorAll('[data-photo-id]').length === 1);
      await clickPhoto(60); await open('photo-viewer-dialog');
      await confirm(); await page.click('#delete-confirm-yes'); await closed('photo-viewer-dialog');
      assert.equal(await page.locator('#camera-roll-dialog').evaluate(d => d.open), true);
      assert.equal(await page.locator('#photo-month-filter').inputValue(), '2026-11', 'empty selected month is retained');
      assert.match(await page.locator('#photo-month-filter option:checked').textContent(), /0/);
      assert.equal(await page.locator('[data-photo-id]').count(), 0);
      await page.keyboard.press('Escape'); await closed('camera-roll-dialog');
      await page.click('[data-entry-id="1"]'); await open('entry-dialog');
      await page.locator('#entry-dialog .entry-photo').first().click(); await open('photo-viewer-dialog');
      assert.equal(await page.locator('#photo-viewer-image').getAttribute('alt'), 'fixture-1.png');
      await confirm(); await page.click('#delete-confirm-yes'); await closed('delete-confirm-dialog');
      await page.waitForFunction(() => document.getElementById('photo-viewer-image').alt === 'fixture-2.png');
      await page.keyboard.press('Escape'); await closed('photo-viewer-dialog');
      assert.equal(await page.locator('#entry-dialog img[alt="fixture-1.png"]').count(), 0, 'open article refreshes its deleted photo');
      await page.click('#edit-entry-button'); await open('editor-dialog');
      assert.equal(Number(await page.locator('#entry-revision').inputValue()), entry.revision, 'editing uses the revised article');
      assert.doesNotMatch(await page.locator('#entry-content').innerText(), new RegExp(photoId(1)), 'deleted reference never returns to the editor');
      canManage = false;
      await page.reload(); await page.waitForSelector('#app-view:not([hidden])');
      await page.click('#camera-roll-button'); await page.waitForSelector('[data-photo-id]');
      await page.locator('[data-photo-id]').first().click(); await open('photo-viewer-dialog');
      assert.equal(await page.locator('#photo-delete').isVisible(), false, 'readers cannot delete');
      assert.deepEqual(errors, []);
      console.log(`Photo deletion ${touch ? 'touch' : 'desktop'}: confirmation, busy Back, failures, viewer, pagination, filters, empty month and permissions passed.`);
    } finally { releaseDelete?.(); releaseDelete = null; await context.close(); }
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

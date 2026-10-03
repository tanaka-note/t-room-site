import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { chromium } from 'playwright';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkerEntrypoint {}', shortCircuit: true };
  return next(specifier, context);
} });
const diaryWorker = (await import('../../src/index.js')).default;

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = { id: 1, entryDate: '2026-10-01', title: '戻る確認', content: '保存済みの本文', authorName: 'fixture', tags: [], status: 'published', revision: 1, photos: [] };
const photo = { id: 1, entryId: 1, entryDate: entry.entryDate, entryTitle: entry.title, fileName: 'fixture.svg', thumbnailUrl: '/fixture.svg', displayUrl: '/fixture.svg', originalSize: 100, width: 100, height: 100 };
const account = { id: 'fixture', displayName: 'fixture' };
const settlement = { id: 1, settlementDate: '2026-10-01', direction: 'incoming', method: 'cash', amountYen: 100, note: 'fixture' };
const json = (response, value) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };

export async function runDialogs(service) {
  let writes = 0, releaseSave;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/diary/api/')) {
      const path = url.pathname.slice('/diary/api'.length);
      if (path === '/session') return json(response, { authenticated: true, role: 'admin', householdId: 'main-household', activeHouseholdId: 'main-household', canManageEntries: true, canViewTrash: true, canPermanentlyDelete: true });
      if (path === '/meta') return json(response, { months: [], tags: [], draftCount: 0 });
      if (path === '/entries') return json(response, { entries: [entry], hasMore: false });
      if (path === '/entries/1') return json(response, { entry });
      if (path === '/photos/meta') return json(response, { months: [] });
      if (path === '/photos') return json(response, { photos: Array.from({ length: 48 }, (_, i) => ({ ...photo, id: i + 1 })), hasMore: false });
      if (request.method !== 'GET') writes++;
      return json(response, {});
    }
    if (url.pathname.startsWith('/billing/api/')) {
      const path = url.pathname.slice('/billing/api'.length);
      if (path === '/session') return json(response, { authenticated: true, role: 'owner', accountId: account.id, accountName: 'fixture' });
      if (path === '/accounts') return json(response, { accounts: [account] });
      if (path === '/summary') return json(response, { account, month: url.searchParams.get('month'), entries: [], settlements: [settlement], settlementTotals: { incomingYen: 100, outgoingYen: 0 }, openingBalanceYen: 0, closingBalanceYen: 100 });
      if (path === '/audit-logs') return json(response, { logs: [] });
      if (request.method !== 'GET') {
        writes++;
        await new Promise(resolveSave => { releaseSave = resolveSave; });
      }
      return json(response, {});
    }
    if (url.pathname === '/previous') { response.writeHead(200, { 'content-type': 'text/html' }); return response.end('<p>previous</p>'); }
    if (url.pathname === '/fixture.svg') { response.writeHead(200, { 'content-type': 'image/svg+xml' }); return response.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="blue"/></svg>'); }
    if (url.pathname === '/diary/dialog-navigation.js') {
      const result = await diaryWorker.fetch(new Request(url.href), { ASSETS: { async fetch(assetRequest) {
        assert.equal(new URL(assetRequest.url).pathname, '/dialog-navigation.js');
        return new Response(await readFile(resolve(root, 'diary-worker/public/dialog-navigation.js')), { headers: { 'content-type': 'text/javascript' } });
      } } }, {});
      response.writeHead(result.status, Object.fromEntries(result.headers));
      return response.end(await result.text());
    }
    const prefix = ['/diary/', '/billing/', '/security/', '/assets/'].find(p => url.pathname.startsWith(p));
    if (!prefix) return response.writeHead(404).end();
    let base = prefix === '/assets/' ? resolve(root, 'assets') : resolve(root, `${prefix.slice(1,-1)}-worker/public`);
    const leaf = url.pathname.slice(prefix.length) || 'index.html';
    const path = resolve(base, leaf);
    if (!path.startsWith(base) || !existsSync(path)) return response.writeHead(404).end();
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json' };
    response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(await readFile(path));
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.TROOM_CHROMIUM_EXECUTABLE || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    for (const touch of [false, true]) {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: touch ? 700 : 1280, height: 900 }, hasTouch: touch, isMobile: touch });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.dismiss());
      await page.goto(`${origin}/previous`);
      await page.goto(`${origin}/${service}/`);
      await page.waitForSelector('#app-view:not([hidden])');
      await page.evaluate(() => history.replaceState({ ...history.state, foreign: 'preserved' }, '', location.href));
      const opened = id => page.waitForFunction(id => document.getElementById(id).open, id);
      const closed = id => page.waitForFunction(id => !document.getElementById(id).open, id);
      const back = async id => { await page.evaluate(() => history.back()); await closed(id); };
      const background = async id => {
        const box = await page.locator(`#${id}`).boundingBox();
        const point = { x: box.x > 2 ? box.x / 2 : box.x + 10, y: box.x > 2 ? box.y + box.height / 2 : Math.max(1, box.y - 2) };
        if (touch) await page.touchscreen.tap(point.x, point.y);
        else await page.mouse.click(point.x, point.y);
      };
      if (service === 'diary') {
        await page.click('#camera-roll-button');
        await opened('camera-roll-dialog');
        await page.waitForSelector('[data-photo-index="47"]');
        const position = await page.locator('#camera-roll-dialog').evaluate(dialog => { dialog.scrollTop = 350; return dialog.scrollTop; });
        await page.locator('[data-photo-index="0"]').evaluate(button => button.click());
        await opened('photo-viewer-dialog');
        await back('photo-viewer-dialog');
        assert.equal(await page.locator('#camera-roll-dialog').evaluate(dialog => dialog.scrollTop), position);
        await page.evaluate(() => history.forward());
        await opened('photo-viewer-dialog');
        await background('photo-viewer-dialog');
        await closed('photo-viewer-dialog');
        assert.equal(await page.locator('#camera-roll-dialog').evaluate(dialog => dialog.open), true);
        // Neither internal blank space nor a drag out of the dialog closes it.
        await page.locator('#camera-roll-status').click();
        const box = await page.locator('#camera-roll-dialog').boundingBox();
        await page.mouse.move(box.x + 30, box.y + 50);
        await page.mouse.down();
        await page.mouse.move(1, box.y + 50);
        await page.mouse.up();
        assert.equal(await page.locator('#camera-roll-dialog').evaluate(dialog => dialog.open), true);
        await background('camera-roll-dialog');
        await closed('camera-roll-dialog');
        await page.click('#new-entry-button');
        await opened('editor-dialog');
        await page.locator('#entry-content').fill('未保存の本文');
        await page.evaluate(() => history.back());
        await opened('editor-leave-dialog');
        await back('editor-leave-dialog');
        assert.equal(await page.locator('#entry-content').innerText(), '未保存の本文');
        assert.ok(!(await page.evaluate(() => JSON.stringify(history.state))).includes('未保存の本文'), 'history must not contain form text');
        await page.click('#entry-date');
        await opened('date-wheel-dialog');
        const initial = await page.locator('#entry-date').inputValue();
        await page.locator('#date-wheel-day [data-value="2"]').click();
        await back('date-wheel-dialog');
        assert.equal(await page.locator('#entry-date').inputValue(), initial);
        assert.equal(await page.locator('#editor-dialog').evaluate(dialog => dialog.open), true);
        await page.click('[data-date-picker-target="entry-date"]');
        await opened('troom-calendar-dialog');
        await back('troom-calendar-dialog');
        assert.equal(await page.locator('#entry-date').inputValue(), initial);
        await page.click('#cancel-entry-button');
        await opened('editor-leave-dialog');
        await page.click('#editor-leave-discard');
        await closed('editor-dialog');
        await page.evaluate(() => history.forward());
        await page.waitForFunction(() => history.state?.troomDiaryDialogs?.stack.length === 0);
        assert.equal(await page.locator('#editor-dialog').evaluate(dialog => dialog.open), false, 'Forward must not restore an editor');
        await page.locator('[data-entry-id="1"]').first().click();
        await opened('entry-dialog');
        await page.click('#delete-entry-button');
        await opened('delete-confirm-dialog');
        await back('delete-confirm-dialog');
        assert.equal(await page.locator('#entry-dialog').evaluate(dialog => dialog.open), true);
        await page.keyboard.press('Escape');
        await closed('entry-dialog');
        assert.equal(writes, 0, 'closing and discard must not write');
      } else {
        await page.click('#settlements-card');
        await opened('settlements-dialog');
        await background('settlements-dialog');
        await closed('settlements-dialog');
        await page.evaluate(() => history.forward());
        await opened('settlements-dialog');
        await page.click('[data-settlement-action="edit"]');
        await opened('entry-dialog');
        await page.fill('#entry-note', '未保存');
        await page.evaluate(() => history.back());
        await page.waitForTimeout(150);
        assert.equal(await page.locator('#entry-dialog').evaluate(dialog => dialog.open), true);
        assert.equal(await page.locator('#entry-note').inputValue(), '未保存');
        await page.click('#entry-date');
        await opened('date-wheel-dialog');
        const initial = await page.locator('#entry-date').inputValue();
        await page.locator('#date-wheel-day [data-value="2"]').click();
        await back('date-wheel-dialog');
        assert.equal(await page.locator('#entry-date').inputValue(), initial);
        await page.click('[data-date-picker-target="entry-date"]');
        await opened('troom-calendar-dialog');
        await back('troom-calendar-dialog');
        assert.equal(await page.locator('#entry-date').inputValue(), initial);
        await page.click('#entry-date');
        await opened('date-wheel-dialog');
        await page.locator('#date-wheel-day [data-value="2"]').click();
        await background('date-wheel-dialog');
        await closed('date-wheel-dialog');
        assert.equal((await page.locator('#entry-date').inputValue()).slice(-2), '02', 'background applies the date wheel selection');
        await background('entry-dialog');
        assert.equal(await page.locator('#entry-dialog').evaluate(dialog => dialog.open), true);
        await page.fill('#entry-note', settlement.note);
        await page.locator('#entry-date').evaluate((input, value) => { input.value = value; }, initial);
        await page.keyboard.press('Escape');
        await closed('entry-dialog');
        await back('settlements-dialog');
        await page.click('#logs-button');
        await opened('logs-dialog');
        await page.locator('[data-close-dialog="logs-dialog"]').click();
        await closed('logs-dialog');
        await page.click('#new-entry-button');
        await opened('entry-dialog');
        await page.fill('#entry-description', 'fixture');
        await page.fill('#entry-amount', '100');
        releaseSave = null;
        await page.click('#entry-form [type="submit"]');
        await page.waitForFunction(() => document.querySelector('#entry-form [type="submit"]').disabled);
        await page.evaluate(() => history.back());
        await page.waitForTimeout(150);
        assert.equal(await page.locator('#entry-dialog').evaluate(dialog => dialog.open), true, 'saving blocks Back');
        assert.ok(releaseSave);
        releaseSave();
        await closed('entry-dialog');
      }
      assert.equal(await page.evaluate(() => history.state.foreign), 'preserved');
      await page.evaluate(() => history.back());
      await page.waitForURL(`${origin}/previous`);
      assert.deepEqual(errors, [], `${service} ${touch ? 'touch' : 'mouse'} errors`);
      await context.close();
      console.log(`${service}: ${touch ? 'touch' : 'mouse'} layered Back, forward, backdrop, guards, position and history passed`);
    }
  } finally {
    await browser.close();
    releaseSave?.();
    await new Promise(resolveClose => server.close(resolveClose));
  }
}

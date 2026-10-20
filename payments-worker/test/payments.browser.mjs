import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fixture } from './fixture.js';
const { chromium } = createRequire(new URL('../../diary-worker/package.json', import.meta.url))('playwright');
const browser = await chromium.launch({ headless: true });
try {
  for (const mobile of [false, true]) {
    const f = fixture();
    f.env.ASSETS.fetch = async req => {
      const path = new URL(req.url).pathname;
      return new Response(await readFile(new URL(`../public/${path === '/' ? 'index.html' : path.slice(1)}`, import.meta.url)), { headers: { 'Content-Type': path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' } });
    };
    const server = createServer(async (req, res) => {
      try {
        const url = `http://127.0.0.1:${server.address().port}${req.url}`;
        if (req.url.startsWith('/security/passkey-client.js')) {
          res.setHeader('Content-Type', 'application/javascript'); res.end('window.TRoomPasskeys={authenticate:async()=>({handoff:{handoffToken:"fixture-handoff"}})};'); return;
        }
        if (req.url.startsWith('/assets/pwa-auto-update.js')) { res.setHeader('Content-Type', 'application/javascript'); res.end(''); return; }
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await f.worker.fetch(new Request(url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) }));
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end('fixture error'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/payments/`);
      await page.locator('#login').click(); await page.locator('#app-view').waitFor({ state: 'visible' });
      await page.locator('#empty').waitFor({ state: 'visible' });
      await page.locator('#add').click();
      await page.locator('#editor-title').click();
      assert.equal(await page.locator('#entry-dialog').evaluate(el => el.open), true);
      if (mobile) await page.touchscreen.tap(2, 2); else await page.mouse.click(2, 2);
      await page.locator('#entry-dialog').waitFor({ state: 'hidden' });
      await page.locator('#add').click();
      await page.locator('[name=paidOn]').fill('2026-10-20'); await page.locator('[name=payee]').fill('サンプル年会費');
      await page.locator('[name=amount]').fill('12000'); await page.locator('[name=startMonth]').fill('2026-10');
      assert.match(await page.locator('#calculation').innerText(), /1,000[\s\S]*2027年9月/);
      await page.locator('#save').click(); await page.locator('#entry-dialog').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelectorAll('#entries tr').length === 1);
      assert.match(await page.locator('#entries').innerText(), /2027-09/);
      await page.getByRole('button', { name: 'サンプル年会費の明細を編集', exact: true }).click();
      await page.locator('[name=amount]').fill('10000'); await page.locator('[name=months]').fill('3');
      assert.match(await page.locator('#calculation').innerText(), /3,333\.33/);
      assert.equal(await page.evaluate(() => document.dispatchEvent(new CustomEvent('troom:before-auto-update', { cancelable: true }))), false);
      await page.locator('#close-editor').click(); await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
      await page.locator('#confirm-cancel').click(); await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('[name=amount]').inputValue(), '10000');
      await page.goBack(); await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
      await page.locator('#confirm-cancel').click(); await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
      // A response lost after the DB commit must be safe to retry with the same operation ID.
      let lose = true;
      await page.route('**/payments/api/entries/*', async route => {
        if (lose && route.request().method() === 'PUT') { lose = false; await route.fetch(); await route.abort(); } else await route.continue();
      });
      await page.locator('#save').click(); await page.locator('#form-error').waitFor({ state: 'visible' });
      assert.equal(await page.locator('[name=amount]').inputValue(), '10000');
      await page.locator('#save').click(); await page.locator('#entry-dialog').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.getElementById('entries').textContent.includes('3,333.33'));
      assert.equal(f.sqlite.prepare('SELECT version FROM payments_entries').get().version, 2);
      await page.locator('#add').click(); await page.locator('[name=payee]').fill('未保存');
      await page.keyboard.press('Escape'); await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
      await page.locator('#confirm-ok').click(); await page.locator('#entry-dialog').waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'サンプル年会費の明細を削除', exact: true }).click();
      await page.keyboard.press('Escape'); await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
      assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM payments_entries WHERE deleted_at IS NULL').get().n, 1);
      await page.getByRole('button', { name: 'サンプル年会費の明細を削除', exact: true }).click();
      await page.locator('#confirm-ok').click(); await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
      await page.locator('#empty').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.locator('#logout').click(); await page.locator('#login-view').waitFor({ state: 'visible' });
      assert.deepEqual(errors, []);
    } finally { await context.close(); await new Promise(resolve => server.close(resolve)); f.close(); }
  }
  console.log('Payments Chromium desktop/touch: login, CRUD, year boundary, precision, lost-response retry, unsaved input, Back, Escape, delete cancel, layout and logout passed.');
} finally { await browser.close(); }

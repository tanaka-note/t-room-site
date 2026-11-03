import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { verifyDirectPwaInstall } from './pwa-install-browser-check.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../diary-worker/package.json', import.meta.url));
const { chromium } = require('playwright');
const directory = resolve(root, 'apps/calculator');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://fixture.test').pathname;
    const file = path === '/assets/pwa-auto-update.js' ? resolve(root, 'assets/pwa-auto-update.js')
      : resolve(directory, path.slice('/apps/calculator/'.length) || 'index.html');
    if (path !== '/assets/pwa-auto-update.js' && (!path.startsWith('/apps/calculator/') || !file.startsWith(directory + sep))) throw new Error('missing');
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'text/plain' }); response.end(body);
  } catch { response.writeHead(404); response.end('missing'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
    try {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://fonts.**/*', route => route.abort());
      await page.goto(`http://127.0.0.1:${server.address().port}/apps/calculator/`);
      await page.locator('#modeOpen').click();
      await page.locator('#modePanel.is-open [data-pwa-install]').waitFor({ state: 'visible' });
      assert.equal(await page.locator('[data-pwa-install]').count(), 1);
      assert.equal(await page.locator('[data-pwa-install]').evaluate(button => button.closest('#modePanel') !== null), true);
      const rect = await page.locator('[data-pwa-install]').boundingBox();
      assert.ok(rect.width > 100 && rect.height >= 38 && rect.x >= 0 && rect.x + rect.width <= width);
      await verifyDirectPwaInstall(page);
      await page.locator('#modeClose').click();
      await page.locator('[data-number="7"]').click(); await page.locator('[data-operator="+"]').click();
      await page.locator('[data-number="2"]').click(); await page.locator('[data-action="equals"]').click();
      assert.equal((await page.locator('#calcDisplay').textContent()).trim(), '9');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log('Calculator install: settings placement, direct prompt, update protection, installed state and arithmetic passed at 1440/390/320px.');
} finally { await browser.close(); await new Promise(done => server.close(done)); }

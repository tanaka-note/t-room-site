import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../diary-worker/package.json', import.meta.url));
const { chromium } = require('playwright');
const registry = JSON.parse(await readFile(resolve(root, 'web-apps.json')));
const apps = [];
for (const app of registry.apps) {
  const source = await readFile(resolve(root, app.entrypoints[0]), 'utf8');
  if (/passkey-login-button/.test(source)) apps.push(app);
}
const mime = { '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://fixture.test').pathname;
    const app = registry.apps.filter(a => a.deployCwd !== '.').find(a => path.startsWith(new URL(a.publicUrls[0]).pathname));
    const base = app ? new URL(app.publicUrls[0]).pathname : '/';
    let file = app ? resolve(root, dirname(app.entrypoints[0]), path.slice(base.length) || 'index.html') : resolve(root, '.' + path);
    if (file.endsWith('/cloud/cloud.js')) file = resolve(root, 'cloud-worker/public/cloud.js');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data);
  } catch { res.writeHead(404); res.end('missing'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const width of [1440, 390, 320]) for (const app of apps) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    try {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/security/api/setup/status') return route.fulfill({ json: {} });
        if (path === '/security/api/status') return route.fulfill({ json: { enabled: true, initialized: true, adminAuthenticated: false } });
        return route.fulfill({ status: 401, json: { error: 'パスキーでログインしてください。' } });
      });
      await page.goto(origin + new URL(app.publicUrls[0]).pathname);
      const button = page.locator('.passkey-login-button:visible').first();
      await button.waitFor({ state: 'visible' });
      const card = button.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," tlain-login-card ")]').first();
      await card.waitFor({ state: 'visible' });
      const metrics = await card.evaluate(el => {
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        const b = el.querySelector('.passkey-login-button'), br = b.getBoundingClientRect(), bs = getComputedStyle(b);
        return { x: rect.x, width: rect.width, right: rect.right, background: style.backgroundColor, radius: style.borderRadius, buttonWidth: br.width, buttonHeight: br.height, buttonColor: bs.backgroundColor, padding: parseFloat(style.paddingLeft), border: parseFloat(style.borderLeftWidth), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(Math.round(metrics.width), Math.min(440, width - (width <= 600 ? 32 : 48)), app.id);
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(244, 246, 243)', app.id);
      assert.equal(metrics.background, 'rgb(255, 255, 255)', app.id);
      assert.equal(metrics.radius, '18px', app.id);
      assert.equal(metrics.buttonColor, 'rgb(87, 114, 99)', app.id);
      assert.ok(metrics.buttonHeight >= 48, app.id);
      assert.ok(Math.abs(metrics.buttonWidth - (metrics.width - 2 * metrics.padding - 2 * metrics.border)) < 2, app.id);
      assert.ok(metrics.x >= 15 && metrics.right <= width - 15, app.id);
      assert.equal(metrics.overflow, false, app.id);
      if (process.env.TLAIN_LOGIN_SCREENSHOTS && width === 390) {
        await mkdir(process.env.TLAIN_LOGIN_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: resolve(process.env.TLAIN_LOGIN_SCREENSHOTS, app.id + '.png') });
      }
      // Existing handlers retain their IDs; visible login notices belong to the card.
      const statusId = await card.locator('xpath=parent::*').getAttribute('data-login-status');
      if (statusId) {
        await page.evaluate(id => { const node = document.getElementById(id); node.hidden = false; node.textContent = '表示確認'; }, statusId);
        await page.waitForFunction(id => document.getElementById(id).closest('.tlain-login-card'), statusId);
        await card.evaluate(el => { el.hidden = true; });
        await page.waitForFunction(id => !document.getElementById(id).closest('.tlain-login-card'), statusId);
        assert.equal(await page.locator('[data-login-app-header]:visible').count(), 1, app.id);
      }
      assert.deepEqual(errors, [], app.id);
      results.push({ app: app.id, width, card: Math.round(metrics.width), button: Math.round(metrics.buttonWidth) });

    } finally { await context.close(); }
  }
} finally { await browser.close(); await new Promise(done => server.close(done)); }
console.log('Shared login cards passed: ' + JSON.stringify(results));

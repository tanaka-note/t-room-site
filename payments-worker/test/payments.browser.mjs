import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fixture } from './fixture.js';
const { chromium } = createRequire(new URL('../../diary-worker/package.json', import.meta.url))('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.TROOM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.TROOM_CHROMIUM_EXECUTABLE } : {}) });
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
      const wheel = page.locator('#date-wheel-dialog'), calendar = page.locator('#troom-calendar-dialog');
      async function chooseCalendar(id, year, month, day) {
        await page.locator(`[data-date-picker-target="${id}"]`).click();
        await calendar.waitFor({ state: 'visible' });
        await page.locator('#troom-calendar-title').click();
        const years = calendar.locator('[data-calendar-value]');
        while (!(await calendar.locator(`[data-calendar-value="${year}"]`).count())) {
          const first = Number(await years.first().getAttribute('data-calendar-value'));
          await calendar.locator(`[data-calendar-action="${year < first ? 'previous' : 'next'}"]`).click();
        }
        await calendar.locator(`[data-calendar-value="${year}"]`).click();
        await calendar.locator(`[data-calendar-value="${year}-${month}"]`).click();
        if (day) await calendar.locator(`[data-calendar-value="${year}-${month}-${day}"]`).click();
        await calendar.waitFor({ state: 'hidden' });
      }
      async function scrollToValue(key, value) {
        const column = page.locator(`#date-wheel-${key}`);
        await page.waitForFunction(id => !document.getElementById(id).dataset.settingScroll, `date-wheel-${key}`);
        await column.evaluate((el, value) => {
          const option = el.querySelector(`[data-value="${value}"]`);
          el.scrollTo({ top: Number(option.dataset.index) * 44, behavior: 'instant' });
        }, value);
        await page.waitForFunction(({key,value}) => document.querySelector(`#date-wheel-${key} [aria-selected="true"]`).dataset.value === String(value), {key,value});
      }
      await chooseCalendar('paidOn', 2024, '01', '31');
      await page.locator('#paidOn').click(); await wheel.waitFor({ state: 'visible' });
      assert.equal(await calendar.evaluate(el => el.open), false);
      assert.equal(await page.evaluate(() => document.dispatchEvent(new CustomEvent('troom:before-auto-update', { cancelable: true }))), false);
      await scrollToValue('month', 2);
      assert.equal(await page.locator('#date-wheel-day [aria-selected="true"]').textContent(), '29日', 'leap-year February clamps the 31st');
      await scrollToValue('year', 2025);
      assert.equal(await page.locator('#date-wheel-day [aria-selected="true"]').textContent(), '28日');
      await page.locator('#date-wheel-month').hover(); await page.mouse.wheel(0, 80);
      await page.waitForFunction(() => document.querySelector('#date-wheel-month [aria-selected="true"]').dataset.value === '3');
      await page.locator('#date-wheel-done').click(); await wheel.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#paidOn').inputValue(), '2025-03-28');
      for (const close of ['cancel', 'escape', 'back']) {
        await page.locator('#paidOn').click(); await wheel.waitFor({ state: 'visible' });
        await scrollToValue('month', 4);
        if (close === 'cancel') await page.locator('#date-wheel-cancel').click();
        if (close === 'escape') await page.keyboard.press('Escape');
        if (close === 'back') await page.goBack();
        await wheel.waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#paidOn').inputValue(), '2025-03-28');
        assert.equal(await page.locator('#entry-dialog').evaluate(el => el.open), true);
        assert.equal(await page.locator('#confirm-dialog').evaluate(el => el.open), false);
      }
      await page.locator('[data-date-picker-target="paidOn"]').click();
      await page.goBack(); await calendar.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#entry-dialog').evaluate(el => el.open), true);
      await chooseCalendar('paidOn', 2026, '10', '20');
      await chooseCalendar('startMonth', 2026, '09');
      await page.locator('#startMonth').focus(); await page.keyboard.press('Enter');
      await wheel.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#date-wheel-day').isVisible(), false);
      await scrollToValue('month', 10);
      // Diary applies a wheel draft on a deliberate backdrop tap/click.
      if (mobile) await page.touchscreen.tap(2, 2); else await page.mouse.click(2, 2);
      await wheel.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#startMonth').inputValue(), '2026-10');
      await page.locator('[name=payee]').fill('サンプル年会費');
      await page.locator('[name=amount]').fill('12000');
      assert.match(await page.locator('#calculation').innerText(), /1,000[\s\S]*2027年9月/);
      await page.locator('#save').click(); await page.locator('#entry-dialog').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelectorAll('#entries tr').length === 1);
      assert.match(await page.locator('#entries').innerText(), /2027-09/);
      await page.getByRole('button', { name: 'サンプル年会費の明細を編集', exact: true }).click();
      assert.equal(await page.locator('#paidOn').inputValue(), '2026-10-20');
      assert.equal(await page.locator('#paidOn').getAttribute('readonly'), '');
      await page.locator('#paidOn').click(); await wheel.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#date-wheel-value').textContent(), '2026年10月20日');
      await page.locator('#date-wheel-cancel').click(); await wheel.waitFor({ state: 'hidden' });
      await page.locator('#paidOn').click(); await wheel.waitFor({ state: 'visible' });
      await page.locator('#date-wheel-month [data-value="11"]').click();
      await page.locator('#date-wheel-done').click(); await wheel.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#paidOn').inputValue(), '2026-11-20', 'Done retains a clicked month while its smooth scroll is running');
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
  console.log('Payments Chromium desktop/touch: calendar, date/month wheels, scroll, leap-year clamp, picker cancel/Back/Escape/backdrop, login, CRUD, year boundary, precision, lost-response retry, unsaved input, layout and logout passed.');
} finally { await browser.close(); }

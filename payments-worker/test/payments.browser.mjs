import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fixture } from './fixture.js';
import { currentJstMonth, month, monthText } from '../src/domain.js';
const { chromium } = createRequire(new URL('../../diary-worker/package.json', import.meta.url))('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.TROOM_CHROMIUM_PATH ? { executablePath:process.env.TROOM_CHROMIUM_PATH } : {}) });
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
      await page.locator('[name=description]').fill('<img src=x onerror=alert(1)>'); await page.locator('[name=amount]').fill('12000'); await page.locator('[name=startMonth]').fill('2026-10');
      assert.match(await page.locator('#calculation').innerText(), /1,000[\s\S]*2027年9月/);
      await page.locator('#save').click(); await page.locator('#entry-dialog').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelectorAll('#entries tr').length === 1);
      assert.match(await page.locator('#entries').innerText(), /2027-09/); assert.equal(await page.locator('#entries img').count(),0);
      await page.getByRole('button', { name: 'サンプル年会費の明細を編集', exact: true }).click();
      await page.locator('[name=amount]').fill('10000'); await page.locator('[name=months]').fill('3');
      assert.match(await page.locator('#calculation').innerText(), /3,334/);
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
      await page.waitForFunction(() => document.getElementById('entries').textContent.includes('3,334'));
      assert.equal(f.sqlite.prepare('SELECT version FROM payments_entries').get().version, 2);
      const monthlyLabel = 'サンプル年会費の明細を月別履歴';
      await page.getByRole('button', { name:monthlyLabel, exact:true }).click();
      await page.locator('#months-dialog').waitFor({state:'visible'});
      assert.match(await page.locator('#month-items').innerText(), /2026-10[\s\S]*3,334/);
      let markRequests = 0;
      page.on('request', request => { if (request.method() === 'PUT' && /\/months\/\d{4}-\d{2}$/.test(request.url())) markRequests++; });
      const current = new Date(Date.now()+9*3600000).toISOString().slice(0,7);
      if (current >= '2026-10') {
        let loseMark = true;
        await page.route('**/payments/api/entries/*/months/*', async route => {
          if (loseMark && route.request().method() === 'PUT') { loseMark=false; await route.fetch(); await route.abort(); } else await route.continue();
        });
        const complete = page.locator('#months-dialog').getByRole('button',{name:'サンプル年会費 2026-10 計上済みにする',exact:true});
        // Every dismissal is a cancellation, with no mutation API or audit.
        for (const close of ['cancel', 'escape', 'back', 'backdrop']) {
          await complete.click(); await page.locator('#confirm-dialog').waitFor({state:'visible'});
          assert.match(await page.locator('#confirm-copy').innerText(), /サンプル年会費[\s\S]*2026-10[\s\S]*3,334[\s\S]*家計簿には自動反映されません/);
          assert.equal(await page.evaluate(() => document.dispatchEvent(new CustomEvent('troom:before-auto-update', {cancelable:true}))), false);
          if (close === 'cancel') await page.locator('#confirm-cancel').click();
          if (close === 'escape') await page.keyboard.press('Escape');
          if (close === 'back') await page.goBack();
          if (close === 'backdrop') { if (mobile) await page.touchscreen.tap(2,2); else await page.mouse.click(2,2); }
          await page.locator('#confirm-dialog').waitFor({state:'hidden'});
          assert.equal(await page.locator('#months-dialog').evaluate(el => el.open), true);
          assert.equal(markRequests,0);
          assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM payments_monthly_marks').get().n,0);
        }
        await complete.click(); await page.locator('#confirm-ok').click();
        await page.locator('#confirm-error').waitFor({state:'visible'});
        assert.match(await page.locator('#confirm-copy').innerText(), /2026-10[\s\S]*3,334/);
        // A lost-response retry keeps its ID; two synchronous clicks submit once.
        await page.locator('#confirm-ok').evaluate(el => { el.click(); el.click(); });
        await page.locator('#confirm-dialog').waitFor({state:'hidden'});
        assert.equal(markRequests,2);
        await page.locator('#months-dialog').getByRole('button',{name:'サンプル年会費 2026-10 計上を取り消す',exact:true}).waitFor();
        assert.match(await page.locator('#month-items').innerText(), /日本時間/);
        assert.match(await page.locator('#month-items').innerText(), /計上済み（月単位）/);
        assert.doesNotMatch(await page.locator('#entries .entry-status').innerText(), /計上完了/);
        assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM payments_operation_audit WHERE action='month_complete'").get().n,1);
        const undo = page.locator('#months-dialog').getByRole('button',{name:'サンプル年会費 2026-10 計上を取り消す',exact:true});
        await undo.click();
        assert.match(await page.locator('#confirm-copy').innerText(), /未計上に戻します/);
        await page.locator('#confirm-cancel').click(); await page.locator('#confirm-dialog').waitFor({state:'hidden'});
        assert.equal(markRequests,2);
        // Approval from an old version must not overwrite another tab's edit.
        await undo.click();
        const stored = f.sqlite.prepare('SELECT id,version FROM payments_entries').get();
        const concurrent = await page.request.put(new URL('/payments/api/entries/'+stored.id,page.url()).href, {
          headers:{Origin:new URL(page.url()).origin},
          data:{requestId:crypto.randomUUID(),expectedVersion:stored.version,paidOn:'2026-10-20',payee:'サンプル年会費',description:'<img src=x onerror=alert(1)>',amount:10000,startMonth:'2026-10',months:3,notes:'競合確認'}
        });
        assert.equal(concurrent.status(),200);
        await page.locator('#confirm-ok').click(); await page.locator('#confirm-error').waitFor({state:'visible'});
        assert.equal(await page.locator('#confirm-ok').isDisabled(),true);
        assert.ok(f.sqlite.prepare('SELECT completed_at FROM payments_monthly_marks').get().completed_at);
        await page.locator('#confirm-cancel').click(); await page.locator('#confirm-dialog').waitFor({state:'hidden'});
        await undo.click(); assert.equal(await page.locator('#confirm-ok').isEnabled(),true);
        await page.locator('#confirm-ok').click(); await page.locator('#confirm-dialog').waitFor({state:'hidden'});
        await complete.waitFor();
        await page.locator('#months-dialog details summary').click();
        assert.match(await page.locator('#operation-history').innerText(), /計上取消[\s\S]*primary-admin/);
      }
      assert.equal(await page.locator('#month-items button').first().evaluate(el=>el.getBoundingClientRect().height>=44), true);
      await page.goBack(); await page.locator('#months-dialog').waitFor({state:'hidden'});
      assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'月別履歴');
      await page.goForward(); await page.locator('#months-dialog').waitFor({state:'visible'});
      await page.locator('#close-months').click(); await page.locator('#months-dialog').waitFor({state:'hidden'});
      await page.getByRole('button',{name:monthlyLabel,exact:true}).click(); await page.locator('#months-dialog').waitFor({state:'visible'});
      if (mobile) await page.touchscreen.tap(2,2); else await page.mouse.click(2,2);
      await page.locator('#months-dialog').waitFor({state:'hidden'});
      await page.getByRole('button',{name:monthlyLabel,exact:true}).click(); await page.locator('#months-dialog').waitFor({state:'visible'});
      await page.keyboard.press('Escape'); await page.locator('#months-dialog').waitFor({state:'hidden'});
      const entryRow = page.locator('#entries tr').first();
      assert.equal(await entryRow.evaluate(el => getComputedStyle(el).display), mobile ? 'grid' : 'table-row');
      if (mobile) {
        assert.equal(await page.locator('.table-scroll').evaluate(el => el.scrollWidth <= el.clientWidth),true);
        await entryRow.locator('summary').click();
        assert.match(await entryRow.locator('.mobile-details').innerText(), /支払日：2026-10-20[\s\S]*競合確認/);
        await entryRow.locator('summary').click();
        for (const action of await entryRow.locator('button').all()) assert.ok(await action.evaluate(el=>el.getBoundingClientRect().height>=44));
      }
      if (process.env.TROOM_SCREENSHOT_DIR) {
        await mkdir(process.env.TROOM_SCREENSHOT_DIR,{recursive:true});
        await page.screenshot({path:`${process.env.TROOM_SCREENSHOT_DIR}/payments-${mobile?'mobile':'desktop'}.png`,fullPage:true});
      }
      // A second tab must observe completion changes without overwriting a stale view.
      if (new Date(Date.now()+9*3600000).toISOString().slice(0,7) === '2026-10') {
        const other=await context.newPage(); await other.goto(page.url()); await other.locator('#current-items button').waitFor();
        await page.locator('#current-items button').click(); await page.locator('#confirm-ok').click(); await page.locator('#confirm-dialog').waitFor({state:'hidden'});
        await other.waitForFunction(()=>document.getElementById('current-items').textContent.includes('計上を取り消す'));
        await other.locator('#current-items button').click(); await other.locator('#confirm-ok').click(); await other.locator('#confirm-dialog').waitFor({state:'hidden'});
        await page.waitForFunction(()=>document.getElementById('current-items').textContent.includes('計上済みにする'));
        await other.close();
      }
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
      // Elapsed calendar months and unrecorded household entries remain distinct.
      const periodCurrent = month(currentJstMonth()), periodCases = [];
      for (const [label, offset, remaining] of [['開始前',1,3],['対象期間中',-1,2],['対象期間終了',-3,0]]) {
        const id = crypto.randomUUID(); periodCases.push({id, remaining});
        const response = await page.request.post(new URL('/payments/api/entries',page.url()).href, {
          headers: {Origin:new URL(page.url()).origin},
          data: {requestId:id,paidOn:'2020-01-01',payee:`期間表示確認・${label}`,description:'長い摘要・'.repeat(30),notes:'長い備考・'.repeat(50),amount:999999999999,startMonth:monthText(periodCurrent+offset),months:3}
        });
        assert.equal(response.status(),200);
      }
      await page.locator('#refresh').click();
      await page.waitForFunction(()=>document.querySelectorAll('#entries tr').length===3);
      for (const {id,remaining} of periodCases) {
        const row = page.locator(`#entries tr[data-id="${id}"]`);
        assert.match(await row.innerText(),new RegExp(`期間終了まで：残り${remaining}ヶ月`));
        assert.match(await row.innerText(),/残り3回・計上済み0回/);
      }
      if (mobile) {
        assert.equal(await page.locator('.table-scroll').evaluate(el => el.scrollWidth <= el.clientWidth),true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true);
      }
      await page.locator('#logout').click(); await page.locator('#login-view').waitFor({ state: 'visible' });
      assert.deepEqual(errors, []);
    } finally { await context.close(); await new Promise(resolve => server.close(resolve)); f.close(); }
  }
  console.log('Confirm cancellations, exact amount, idempotent retry, double submit, stale approval, responsive cards and Payments Chromium desktop/touch: login, CRUD, year boundary, integer allocation, monthly complete/undo, JST timestamps, cross-tab refresh, XSS text, lost-response retry, unsaved input, Back, Escape, delete cancel, layout and logout passed.');
} finally { await browser.close(); }

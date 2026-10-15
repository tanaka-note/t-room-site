import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fixture } from './fixture.js';
const require = createRequire(new URL('../../diary-worker/package.json', import.meta.url));
const { chromium } = require('playwright');
const root = new URL('../public/', import.meta.url);
const browser = await chromium.launch({ headless: true });
try {
  for (const mobile of [false, true]) {
    const f = fixture(); await f.login();
    let publishedBuild = null;
    const server = createServer(async (req, res) => {
      try { const origin = `http://127.0.0.1:${server.address().port}`, url = new URL(req.url, origin);
        if (url.pathname.startsWith('/inventory/api/')) { let body = ''; for await (const c of req) body += c;
          const response = await f.worker.fetch(new Request(url, { method: req.method, headers: req.headers, ...(['GET','HEAD'].includes(req.method) ? {} : { body }) }));
          res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
        }
        let path = url.pathname === '/inventory/' ? 'index.html' : url.pathname.replace('/inventory/', '');
        let bytes = path === '/assets/pwa-auto-update.js' ? readFileSync(new URL('../../assets/pwa-auto-update.js', import.meta.url)) : readFileSync(new URL(path, root));
        if (path === 'index.html' && publishedBuild) bytes = Buffer.from(bytes.toString().replace(/(<meta name="troom-app-build" content=")[^"]+/, `$1${publishedBuild}`));
        res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'); res.end(bytes);
      } catch { res.writeHead(404); res.end('not found'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
    try {
      await context.addCookies([{ name: 'troom_inventory_session', value: f.cookie.split('=')[1], url: origin, httpOnly: true, sameSite: 'Strict' }]);
      const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); let acceptDialog = true; page.on('dialog', d => acceptDialog ? d.accept() : d.dismiss());
      await page.goto(`${origin}/inventory/`); await page.locator('#app-view').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: '品目を追加', exact: true }).click(); await page.locator('#name').fill('サンプル消耗品'); await page.locator('#quantity').fill('10'); await page.getByRole('button', { name: '記録する' }).click(); await page.locator('#editor').waitFor({ state: 'hidden' }); await page.locator('.item').waitFor();
      await page.locator('#search').fill('存在しない検索語');
      assert.match(await page.locator('#items').textContent(), /該当する品目はありません/);
      await page.locator('#search-clear').click();
      assert.equal(await page.locator('#search').inputValue(), '');
      assert.equal(await page.locator('#search-clear').isVisible(), false);
      assert.equal(await page.locator('#search').evaluate(n => n === document.activeElement), true);
      await page.locator('.item').waitFor();
      await page.locator('.item').getByRole('button', { name: '補充', exact: true }).click(); await page.locator('#quantity').fill('3'); await page.getByRole('button', { name: '記録する' }).click(); await page.locator('#editor').waitFor({ state: 'hidden' }); await page.locator('.item .number').filter({ hasText: '13 個' }).waitFor();
      await page.locator('.item').getByRole('button', { name: '使用', exact: true }).click(); await page.locator('#quantity').fill('2'); await page.getByRole('button', { name: '記録する' }).click(); await page.locator('#editor').waitFor({ state: 'hidden' }); await page.locator('.item .number').filter({ hasText: '11 個' }).waitFor();
      await page.locator('#search').fill('サンプル'); await page.locator('.item-link').click(); await page.locator('#detail-view').waitFor({ state: 'visible' });
      assert.match(await page.locator('#annual-total').innerText(), /2 個/); assert.equal(await page.locator('#chart rect').count(), 12); assert.equal(await page.locator('#month-values td').count(), 12);
      await page.locator('#movements .movement').filter({ hasText: '使用' }).getByRole('button', { name: '取消' }).click(); await page.waitForFunction(() => document.getElementById('annual-total').textContent.includes('0 個'));
      await page.getByRole('button', { name: '一覧へ戻る', exact: false }).click(); await page.locator('#list-view').waitFor({ state: 'visible' }); assert.equal(await page.locator('#search').inputValue(), 'サンプル');
      for (let i=0;i<18;i++) await f.request('/api/items',{name:`Sample ${String(i).padStart(2,'0')}`,unit:'個',stock:0,requestId:crypto.randomUUID()});
      await page.reload(); await page.locator('#app-view').waitFor({state:'visible'}); await page.locator('.item').filter({hasText:'サンプル消耗品'}).waitFor();
      const source = page.locator('.item').filter({hasText:'サンプル消耗品'}); await source.scrollIntoViewIfNeeded(); const sourceTop = await source.evaluate(n=>n.getBoundingClientRect().top);
      await source.locator('.item-link').click(); await page.locator('#detail-view').waitFor({state:'visible'}); await page.waitForFunction(()=>window.scrollY===0);
      await page.evaluate(()=>window.scrollTo(0,200)); const detailScroll = await page.evaluate(()=>window.scrollY); await page.goBack(); await page.locator('#list-view').waitFor({state:'visible'});
      await page.waitForFunction(({top})=>Math.abs([...document.querySelectorAll('.item')].find(n=>n.textContent.includes('サンプル消耗品')).getBoundingClientRect().top-top)<4,{top:sourceTop});
      await page.goForward(); await page.locator('#detail-view').waitFor({state:'visible'}); await page.waitForFunction(y=>Math.abs(window.scrollY-y)<4,detailScroll); await page.goBack(); await page.locator('#list-view').waitFor({state:'visible'});
      await page.getByRole('button', { name: '品目を追加', exact: true }).click(); await page.locator('#name').fill('未保存');
      assert.equal(await page.locator('#record-form').getAttribute('data-troom-dirty'), 'true'); acceptDialog = false;
      publishedBuild = 'inventory-ffffffffffff';
      await page.evaluate(() => window.TRoomPwaUpdater.checkForUpdate({ force: true }));
      assert.equal(new URL(page.url()).searchParams.has('app-update'), false);
      await page.keyboard.press('Escape'); assert.equal(await page.locator('#editor').evaluate(n => n.open), true);
      await page.goBack(); await page.waitForFunction(() => Boolean(history.state?.inventoryDialog)); assert.equal(await page.locator('#name').inputValue(), '未保存');
      acceptDialog = true; await page.keyboard.press('Escape'); await page.locator('#editor').waitFor({ state: 'hidden' });
      await page.waitForURL(/app-update=inventory-ffffffffffff/); await page.locator('#app-view').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: '品目を追加', exact: true }).click(); await page.mouse.click(3, 3); await page.locator('#editor').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => Boolean(window.TRoomPwaUpdater)), true);
      console.log(`Inventory browser flow passed: ${mobile ? 'touch' : 'desktop'}`);
    } finally { await context.close(); await new Promise(resolve => server.close(resolve)); f.close(); }
  }
} finally { await browser.close(); }

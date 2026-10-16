import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fixture } from './fixture.js';
const require = createRequire(new URL('../package.json', import.meta.url));
const playwright = require('playwright');
const engine = process.env.TROOM_BROWSER || 'chromium';
if (!['chromium', 'webkit'].includes(engine)) throw new Error('Inventory browser must be chromium or webkit');
const root = new URL('../public/', import.meta.url);
const browser = await playwright[engine].launch({ headless: true });
try {
  for (const mobile of [false, true]) {
    const f = fixture(); await f.login();
    let publishedBuild = null, issuedCookiePolicy = null, crossSiteChecked = false;
    const server = createServer(async (req, res) => {
      try { const origin = `http://127.0.0.1:${server.address().port}`, url = new URL(req.url, origin);
        if (url.pathname.startsWith('/inventory/api/')) { let body = ''; for await (const c of req) body += c;
          const response = await f.worker.fetch(new Request(url, { method: req.method, headers: req.headers, ...(['GET','HEAD'].includes(req.method) ? {} : { body }) }));
          if (url.pathname === '/inventory/api/passkey/handoff' && response.status === 200) {
            const header=response.headers.get('Set-Cookie') || '';
            issuedCookiePolicy={strict:/; SameSite=Strict(?:;|$)/.test(header),httpOnly:/; HttpOnly(?:;|$)/.test(header),path:/; Path=\/inventory(?:;|$)/.test(header)};
          }
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
      await context.addCookies([{ name: 'troom_inventory_session', value: f.cookie.split('=')[1], domain: '127.0.0.1', path: '/inventory', httpOnly: true, sameSite: 'Strict' }]);
      const page = await context.newPage(); const errors = [], unexpectedDialogs = []; page.on('pageerror', e => errors.push(e.message)); let acceptDialog = true, beforeUnloadSeen = false;
      page.on('dialog', d => { if (d.type() === 'beforeunload') beforeUnloadSeen = true; else if (d.type() !== 'confirm') unexpectedDialogs.push(d.type()); return acceptDialog ? d.accept() : d.dismiss(); });
      const activate = locator => mobile ? locator.tap() : locator.click();
      await page.goto(`${origin}/inventory/`); await page.locator('#app-view').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: '品目を追加', exact: true }).click(); await page.locator('#name').fill('サンプル消耗品'); await page.locator('#quantity').fill('10'); await page.getByRole('button', { name: '記録する' }).click(); await page.locator('#editor').waitFor({ state: 'hidden' }); await page.locator('.item').waitFor();
      await page.locator('.item').getByRole('button', { name: '補充', exact: true }).click(); await page.locator('#quantity').fill('3'); await page.getByRole('button', { name: '記録する' }).click(); await page.locator('#editor').waitFor({ state: 'hidden' }); await page.locator('.item .number').filter({ hasText: '13 個' }).waitFor();
      await page.locator('.item').getByRole('button', { name: '使用', exact: true }).click(); await page.locator('#quantity').fill('2'); await page.getByRole('button', { name: '記録する' }).click(); await page.locator('#editor').waitFor({ state: 'hidden' }); await page.locator('.item .number').filter({ hasText: '11 個' }).waitFor();
      await page.locator('#search').fill('サンプル'); await page.locator('.item-link').click(); await page.locator('#detail-view').waitFor({ state: 'visible' });
      assert.match(await page.locator('#annual-total').innerText(), /2 個/); assert.equal(await page.locator('#chart rect').count(), 12); assert.equal(await page.locator('#month-values td').count(), 12);
      await page.locator('#movements .movement').filter({ hasText: '使用' }).getByRole('button', { name: '取消' }).click(); await page.waitForFunction(() => document.getElementById('annual-total').textContent.includes('0 個'));
      assert.match(await page.locator('#item-stock').innerText(), /13 個/);
      await activate(page.getByRole('button', {name:'在庫を合わせる',exact:true})); await page.locator('#quantity').fill('9'); await page.locator('#occurred-at').fill('2026-02-01T09:15');
      await page.getByRole('button',{name:'記録する',exact:true}).click(); await page.locator('#editor').waitFor({state:'hidden'}); await page.waitForFunction(()=>document.getElementById('item-stock').textContent.includes('9 個'));
      assert.match(await page.locator('#annual-total').innerText(),/0 個/);
      await page.getByRole('button', { name: '一覧へ戻る', exact: false }).click(); await page.locator('#list-view').waitFor({ state: 'visible' }); assert.equal(await page.locator('#search').inputValue(), 'サンプル');
      for (let i=0;i<18;i++) await f.request('/api/items',{name:`Sample ${String(i).padStart(2,'0')}`,unit:'個',stock:0,requestId:crypto.randomUUID()});
      assert.equal(await page.locator('body').getAttribute('data-troom-update-block'),'false');
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
      assert.equal(await page.evaluate(()=>{ const e=new Event('beforeunload',{cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; }),true);
      if (!mobile) {
        await page.reload({timeout:5000}).catch(error=>assert.match(error.message,/aborted|cancel|timeout|interrupted/i));
        assert.equal(beforeUnloadSeen,true); assert.equal(await page.locator('#name').inputValue(),'未保存');
      }
      await page.keyboard.press('Escape'); assert.equal(await page.locator('#editor').evaluate(n => n.open), true);
      await page.goBack(); await page.waitForFunction(() => Boolean(history.state?.inventoryDialog)); assert.equal(await page.locator('#name').inputValue(), '未保存');
      acceptDialog = true; await page.keyboard.press('Escape'); await page.locator('#editor').waitFor({ state: 'hidden' });
      await page.waitForURL(/app-update=inventory-ffffffffffff/); await page.locator('#app-view').waitFor({ state: 'visible' });
      await activate(page.getByRole('button', { name: '品目を追加', exact: true })); if(mobile) await page.touchscreen.tap(3,3); else await page.mouse.click(3, 3); await page.locator('#editor').waitFor({ state: 'hidden' });
      const attacks=['<script>alert(1)</script>','<img src=x onerror=alert(1)>','"><svg/onload=alert(1)>',"'; DROP TABLE inventory_items; --"];
      for (const name of attacks) { const response=await f.request('/api/items',{name,unit:'<b>',stock:1,requestId:crypto.randomUUID()}); assert.equal(response.status,200); }
      await page.reload(); await page.locator('#app-view').waitFor({state:'visible'});
      for (const name of attacks) assert.equal(await page.getByRole('button',{name,exact:true}).innerText(),name);
      assert.equal(await page.locator('.item script,.item img,.item svg,.item b').count(),0);
      await page.getByRole('button',{name:attacks[0],exact:true}).click(); await page.locator('#detail-view').waitFor({state:'visible'});
      assert.match(await page.locator('#item-stock').innerText(),/1 <b>/); assert.equal(await page.locator('#detail-view b').count(),0);
      const assertLoggedOut=async()=>{
        await page.locator('#login-view').waitFor({state:'visible'}); assert.equal(await page.locator('#editor').evaluate(n=>n.open),false);
        for(const id of ['name','unit','quantity','occurred-at','search']) assert.equal(await page.locator(`#${id}`).inputValue(),'');
        for(const id of ['items','movements','chart','item-name','item-stock','annual-total','detail-actions','month-values','month-labels','form-message','editor-title','account-name']) assert.equal(await page.locator(`#${id}`).textContent(),'');
        assert.equal(await page.locator('#record-form').getAttribute('data-troom-dirty'),'false');
        assert.equal(await page.locator('body').getAttribute('data-troom-update-block'),'false');
        assert.equal(await page.locator('#fields').isDisabled(),false); assert.equal(await page.locator('#login').isDisabled(),false);
        assert.equal(new URL(page.url()).searchParams.has('item'),false);
      };
      const loginAgain=async()=>{
        f.renewHandoff(); await page.evaluate(()=>{ window.TRoomPasskeys={...window.TRoomPasskeys,authenticate:async()=>({handoff:{handoffToken:'fixture-handoff'}})}; });
        await activate(page.getByRole('button',{name:'パスキーでログイン',exact:true})); await page.locator('#app-view').waitFor({state:'visible'});
        await page.locator('.item').first().waitFor(); assert.equal(await page.locator('#detail-view').isHidden(),true);
        assert.equal(await page.locator('#search').inputValue(),''); assert.equal(await page.locator('#show-archived').isChecked(),false);
        assert.deepEqual(issuedCookiePolicy,{strict:true,httpOnly:true,path:true});
        const cookies=await context.cookies(`${origin}/inventory/`); assert(cookies.some(c=>c.name==='troom_inventory_session' && c.httpOnly && c.path==='/inventory'));
        if (!crossSiteChecked) {
          crossSiteChecked=true;
          if (engine==='webkit' && process.platform==='win32' && !cookies.some(c=>c.name==='troom_inventory_session' && c.sameSite==='Strict')) {
            // Reproduced with an isolated Set-Cookie server: this Windows port
            // reports None and sends Strict cookies cross-site. macOS CI must
            // enforce the behavioral assertion below; never relax Worker cookies.
            console.log('SameSite enforcement SKIP: Windows WebKit port; raw Strict header verified, macOS CI required');
          } else {
            assert(cookies.some(c=>c.name==='troom_inventory_session' && c.sameSite==='Strict'));
            const crossSite=await context.newPage();
            try {
              await crossSite.route('http://cross-site.test/**',route=>route.fulfill({contentType:'text/html',body:`<a href="${origin}/inventory/api/session">Continue</a>`}));
              await crossSite.goto('http://cross-site.test/');
              const [response]=await Promise.all([crossSite.waitForResponse(`${origin}/inventory/api/session`),crossSite.getByRole('link').click()]);
              assert.equal(response.status(),401,'Strict cookie must not accompany a cross-site navigation');
            } finally {await crossSite.close();}
          }
        }
      };
      await activate(page.getByRole('button',{name:'在庫を合わせる',exact:true})); await page.locator('#quantity').fill('7'); await page.locator('#occurred-at').fill('2026-03-01T12:34:56');
      await page.keyboard.press('Escape'); await page.locator('#editor').waitFor({state:'hidden'});
      await activate(page.getByRole('button',{name:'ログアウト',exact:true})); await assertLoggedOut();
      assert.equal((await context.cookies(`${origin}/inventory/`)).filter(c=>c.name==='troom_inventory_session').length,0);
      await loginAgain();
      await activate(page.getByRole('button',{name:'品目を追加',exact:true})); assert.equal(await page.locator('#name').inputValue(),''); assert.equal(await page.locator('#unit').inputValue(),'個');
      await page.locator('#name').fill('前の入力'); await page.locator('#unit').fill('箱'); await page.locator('#quantity').fill('7');
      await page.keyboard.press('Escape'); await page.locator('#editor').waitFor({state:'hidden'});
      await activate(page.getByRole('button',{name:'ログアウト',exact:true})); await assertLoggedOut(); await loginAgain();
      await activate(page.getByRole('button',{name:'品目を追加',exact:true})); assert.equal(await page.locator('#name').inputValue(),''); assert.equal(await page.locator('#unit').inputValue(),'個'); assert.equal(await page.locator('#quantity').inputValue(),'0');
      await page.locator('#name').fill('失効時の入力'); await page.locator('#unit').fill('箱'); await page.locator('#quantity').fill('8');
      f.setActive(false); await page.getByRole('button',{name:'記録する',exact:true}).click(); await assertLoggedOut();
      f.setActive(true); await loginAgain(); await activate(page.getByRole('button',{name:'品目を追加',exact:true}));
      assert.equal(await page.locator('#name').inputValue(),''); assert.equal(await page.locator('#quantity').inputValue(),'0');
      await page.keyboard.press('Escape'); await page.locator('#editor').waitFor({state:'hidden'});
      // Deletion covers nonzero stock, confirmation, stale versions, history and stale tabs.
      const liveCookie=(await context.cookies(`${origin}/inventory/`)).find(c=>c.name==='troom_inventory_session');
      f.cookie=`${liveCookie.name}=${liveCookie.value}`;
      const createResponse=await f.request('/api/items',{name:'Delete fixture',unit:'個',stock:5,requestId:crypto.randomUUID()}); assert.equal(createResponse.status,200);
      const created=await createResponse.json();
      await f.request(`/api/items/${created.itemId}/movements`,{kind:'use',quantity:2,occurredAt:'2026-01-01T09:00:00+09:00',requestId:crypto.randomUUID()});
      await page.reload(); await page.locator('#app-view').waitFor({state:'visible'}); await page.locator('#search').fill('Delete fixture');
      await activate(page.getByRole('button',{name:'Delete fixture',exact:true})); await page.locator('#detail-view').waitFor({state:'visible'});
      assert.match(await page.locator('#annual-total').innerText(),/2 個/);
      const staleUrl=page.url(), staleTab=await context.newPage(); await staleTab.goto(staleUrl); await staleTab.locator('#detail-view').waitFor({state:'visible'});
      try {
        acceptDialog=false; await activate(page.getByRole('button',{name:'品目を削除',exact:true}));
        assert.equal(await page.locator('#detail-view').isVisible(),true); assert.equal((await f.request(`/api/items/${created.itemId}`)).status,200);
        acceptDialog=true;
        await f.request(`/api/items/${created.itemId}/movements`,{kind:'restock',quantity:1,occurredAt:'2026-01-01T09:00:00+09:00',requestId:crypto.randomUUID()});
        await activate(page.getByRole('button',{name:'品目を削除',exact:true}));
        await page.waitForFunction(()=>document.getElementById('item-stock').textContent.includes('4 個') && document.getElementById('message').textContent.includes('別の操作'));
        assert.equal((await f.request(`/api/items/${created.itemId}`)).status,200);
        const deletionResponse=page.waitForResponse(r=>r.url().endsWith(`/items/${created.itemId}/delete`) && r.status()===200);
        await activate(page.getByRole('button',{name:'品目を削除',exact:true})); await deletionResponse;
        await page.locator('#list-view').waitFor({state:'visible'}); await page.getByText('品目を削除しました。',{exact:true}).waitFor();
        assert.equal(await page.locator('#search').inputValue(),'Delete fixture'); assert.equal(await page.locator('.item').count(),0);
        assert.equal(new URL(page.url()).searchParams.has('item'),false);
        await page.locator('#show-archived').check(); assert.equal(await page.locator('.item').count(),0);
        await page.goBack(); await page.locator('#list-view').waitFor({state:'visible'}); await page.goForward(); await page.locator('#list-view').waitFor({state:'visible'});
        await staleTab.reload(); await staleTab.locator('#list-view').waitFor({state:'visible'});
        await staleTab.getByText('品目が見つかりません。',{exact:true}).waitFor(); assert.equal(new URL(staleTab.url()).searchParams.has('item'),false);
        await page.goto(staleUrl); await page.getByText('品目が見つかりません。',{exact:true}).waitFor(); assert.equal(await page.locator('#detail-view').isHidden(),true);
      } finally { await staleTab.close(); }
      const archived=await (await f.request('/api/items',{name:'Archived delete fixture',unit:'個',stock:0,requestId:crypto.randomUUID()})).json();
      await f.request(`/api/items/${archived.itemId}/archive`,{requestId:crypto.randomUUID()});
      await page.goto(`${origin}/inventory/?item=${archived.itemId}`); await page.locator('#detail-view').waitFor({state:'visible'});
      await activate(page.getByRole('button',{name:'品目を削除',exact:true})); await page.getByText('品目を削除しました。',{exact:true}).waitFor();
      assert.equal((await f.request(`/api/items/${archived.itemId}`)).status,404);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); assert.deepEqual(errors, []);
      assert.deepEqual(unexpectedDialogs,[]);
      assert.equal(await page.evaluate(() => Boolean(window.TRoomPwaUpdater)), true);
      console.log(`Inventory browser flow passed: ${engine} ${mobile ? 'touch' : 'desktop'}`);
    } finally { await context.close(); await new Promise(resolve => server.close(resolve)); f.close(); }
  }
} finally { await browser.close(); }
if (process.env.TROOM_TRACE_DIR) {
  const files=readdirSync(process.env.TROOM_TRACE_DIR);
  assert(files.some(name=>name.endsWith('.zip')) && files.some(name=>name.endsWith('.png')),'Inventory browser tracing must use the same Playwright installation as the fixture');
}

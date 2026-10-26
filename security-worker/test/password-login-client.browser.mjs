import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, fixturePassword, securityDatabase } from './password-login-audit-fixture.mjs';
const { chromium } = createRequire(new URL('../../diary-worker/package.json', import.meta.url))('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const f = fixture('billing');
f.security = await securityDatabase(f, 'billing');
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const prefix = ['/billing/', '/security/', '/diary/', '/cloud/', '/downloader/', '/downloader2/', '/inventory/', '/health/', '/payments/', '/assets/'].find(p => url.pathname.startsWith(p));
  if (!prefix) return res.writeHead(404).end();
  const base = resolve(root, prefix === '/assets/' ? 'assets' : `${prefix.slice(1, -1)}-worker/public`);
  const path = resolve(base, url.pathname.slice(prefix.length) || 'index.html');
  if (!path.startsWith(base + sep)) return res.writeHead(404).end();
  if (!existsSync(path)) return res.writeHead(404).end();
  const types = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json'};
  res.writeHead(200, {'Content-Type':types[extname(path)] || 'application/octet-stream'});
  res.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.TROOM_CHROMIUM_EXECUTABLE || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch({headless:true, ...(executablePath ? {executablePath} : {})});
try {
  // Render the real markup and stylesheet for each service without booting APIs.
  // Compare the action itself against billing on desktop and narrow screens.
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin !== origin || route.request().resourceType() === 'script'
        ? route.abort() : route.continue();
    });
    let reference;
    for (const service of ['billing', 'cloud', 'security', 'diary', 'downloader', 'downloader2', 'inventory', 'health', 'payments']) {
      await page.goto(`${origin}/${service}/`);
      const id = { security: 'admin-passkey-login', health: 'sign-in', inventory: 'login', payments: 'login' }[service] || 'passkey-login';
      const result = await page.locator(`#${id}`).evaluate(button => {
        document.body.replaceChildren(button);
        document.body.style.cssText = 'width:330px;max-width:100%;margin:0;padding:0;';
        button.hidden = false;
        const style = getComputedStyle(button), icon = button.querySelector('svg'), iconStyle = getComputedStyle(icon);
        const properties = ['display', 'gap', 'minHeight', 'padding', 'borderWidth', 'borderRadius', 'backgroundColor', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing'];
        return { label: button.textContent.trim(), iconCount: button.querySelectorAll('svg').length,
          iconHidden: icon.getAttribute('aria-hidden'), iconSize: [iconStyle.width, iconStyle.height],
          overflow: button.getBoundingClientRect().width > innerWidth,
          styles: Object.fromEntries(properties.map(key => [key, style[key]])) };
      });
      assert.equal(result.label, 'パスキーでログイン', service);
      assert.equal(result.iconCount, 1, service);
      assert.equal(result.iconHidden, 'true', service);
      assert.deepEqual(result.iconSize, ['24px', '24px'], service);
      assert.equal(result.overflow, false, service);
      if (!reference) reference = result.styles;
      else assert.deepEqual(result.styles, reference, `${service} matches billing at ${width}px`);
    }
    await context.close();
    console.log(`All nine passkey buttons match billing at ${width}px`);
  }
  for (const mobile of [false, true]) {
    const context = await browser.newContext({viewport:{width:mobile ? 390 : 1280,height:mobile ? 844 : 900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
    const page = await context.newPage(), errors = [], paths = [];
    page.on('pageerror', e => errors.push(e.message));
    let authenticated = false, failHandoff = true;
    const account = {id:'chiharu',displayName:'Fixture',role:'member'};
    const session = {authenticated:true,accountId:account.id,accountName:account.displayName,role:account.role,authMethod:'passkey'};
    await page.route('**/billing/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      const path = url.pathname.slice('/billing/api/'.length); paths.push(path);
      if (['login','password-login-audit'].includes(path)) {
        const result = await f.request(path, request.postData());
        return route.fulfill({status:result.status,contentType:'application/json',body:result.body ? JSON.stringify(result.body) : ''});
      }
      if (path === 'passkey/handoff' && failHandoff) return route.fulfill({status:401,json:{error:'fixture handoff expired'}});
      if (path === 'passkey/handoff') authenticated = true;
      if (path === 'logout') authenticated = false;
      const data = path === 'session' ? (authenticated ? session : {authenticated:false})
        : path === 'passkey/handoff' ? session
        : path === 'accounts' ? {accounts:[account]}
        : path === 'summary' ? {account,month:url.searchParams.get('month'),entries:[],settlements:[],settlementTotals:{incomingYen:0,outgoingYen:0},openingBalanceYen:0,closingBalanceYen:0}
        : {};
      return route.fulfill({json:data});
    });
    await page.goto(`${origin}/billing/`);
    await page.locator('#login-view').waitFor({state:'visible'});
    assert.equal(await page.locator('#login-view input').count(), 0);
    assert.equal(await page.locator('#passkey-login').innerText(), 'パスキーでログイン');
    assert.equal(await page.locator('#passkey-login svg.passkey-icon').count(), 1);
    assert.equal(await page.locator('#login-view a').getAttribute('href'), '/security/');
    const layout = await page.evaluate(() => {
      const r = document.querySelector('#login-view .login-card').getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2,w:innerWidth,h:innerHeight,overflow:document.documentElement.scrollWidth > innerWidth};
    });
    assert.ok(Math.abs(layout.x-layout.w/2)<2 && Math.abs(layout.y-layout.h/2)<2);
    assert.equal(layout.overflow, false);
    const stubPasskey = () => page.evaluate(() => { window.TRoomPasskeys = { ...window.TRoomPasskeys, authenticate: async service => {
      if (service !== 'billing') throw Error('wrong service');
      return {handoff:{handoffToken:'fixture-token'}};
    } }; });
    await stubPasskey();
    await page.locator('#passkey-login').click();
    await page.locator('#login-error').filter({hasText:'fixture handoff expired'}).waitFor();
    assert.equal(await page.locator('#passkey-login-label').innerText(), 'パスキーでログイン');
    assert.equal(await page.locator('#passkey-login svg.passkey-icon').count(), 1);
    assert.equal(await page.locator('#passkey-login').getAttribute('aria-busy'), null);
    assert.equal(await page.locator('#passkey-login').isEnabled(), true);
    failHandoff = false;
    await page.locator('#passkey-login').focus(); await page.keyboard.press('Enter');
    await page.locator('#app-view').waitFor({state:'visible'});
    assert.equal(await page.locator('#new-entry-button').isVisible(), false);
    await page.reload();
    await page.locator('#app-view').waitFor({state:'visible'});
    await stubPasskey();
    await page.locator('#logout-button').click();
    await page.locator('#login-view').waitFor({state:'visible'});
    assert.equal(await page.locator('#passkey-login').isEnabled(), true);
    assert.equal(paths.includes('login'), false, 'current UI never sends password login');
    await page.locator('#passkey-login').click();
    await page.locator('#app-view').waitFor({state:'visible'});
    // Old cached clients can still submit safe metadata; their password request
    // reaches the real Worker and Security SQLite but can never authenticate.
    const result = await page.evaluate(async password => {
      const response = await fetch('/billing/api/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({loginId:'masami@example.test',password})});
      return {status:response.status,cookie:response.headers.get('set-cookie')};
    }, fixturePassword);
    assert.equal(result.status, 401); assert.equal(result.cookie, null);
    assert.equal(f.stored.at(-1).details.reason, 'password_auth_disabled');
    assert.ok(f.security.db.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE event_type='password_login_failure'").get().n > 0);
    assert.deepEqual(errors, []);
    assert.doesNotMatch(JSON.stringify(f.stored), /masami@example.test|local-audit-fixture-password/);
    await context.close();
    console.log(`Billing ${mobile ? 'mobile' : 'desktop'}: centered passkey UI, errors, handoff, resume, logout/relogin and cached password rejection passed`);
  }
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve)); f.security.close(); f.close();
}

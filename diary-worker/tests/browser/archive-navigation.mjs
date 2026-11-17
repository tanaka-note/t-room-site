import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createDiaryFixtureServer } from './bootstrap-fixture.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const publicRoot = resolve(root, 'diary-worker/public');
const currentMonth = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(new Date());
const year = Number(currentMonth.slice(0, 4));
const many = [0, 1, 2, 3].flatMap(offset => Array.from({ length: offset ? 12 : 8 }, (_, i) => ({
  value: `${year - offset}-${String(12 - i).padStart(2, '0')}`, count: 11 + i
}))).concat([{ value: `${year - 5}-02`, count: 1 }, { value: `${year - 6}-01`, count: 2 }]);
// Include this month even when the test runs early in the year, retaining 46 months.
if (!many.some(item => item.value === currentMonth)) many[7].value = currentMonth;
const datasets = { many, sparse: [{ value: currentMonth, count: 1 }], empty: [], old: [{ value: `${year - 1}-02`, count: 1 }] };
let active = 'many';
const entryRequests = [];
const session = () => ({ authenticated: true, role: 'admin', accountName: '合成アカウント', householdId: 'many',
  activeHouseholdId: active, isGlobalOwner: true, canManageEntries: true, canViewTrash: true });
const entriesFor = month => Array.from({ length: Math.min(datasets[active].find(item => item.value === month)?.count || 0, 9) }, (_, i) => ({
  id: Number(month.replace('-', '')) * 100 + i + 1, entryDate: `${month}-${String(20 - i).padStart(2, '0')}`,
  title: '年月表示の合成日記', content: '表示と戻る位置を確認するための合成本文です。'.repeat(6),
  authorName: 'テスト', tags: [], status: 'published', revision: 1, photos: []
}));
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const server = createDiaryFixtureServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/diary/api/')) {
    const path = url.pathname.slice('/diary/api'.length);
    if (path === '/session') return json(res, session());
    if (path === '/households') return json(res, { households: Object.keys(datasets).map(id => ({ id, name: `合成 ${id}` })), activeHouseholdId: active });
    if (path === '/households/select') {
      let body = ''; for await (const part of req) body += part;
      active = JSON.parse(body).householdId;
      return json(res, { activeHouseholdId: active });
    }
    if (path === '/meta') return json(res, { months: datasets[active], tags: [{ value: 'テスト', count: 1 }], draftCount: 0 });
    if (path === '/entries') {
      entryRequests.push(url.search);
      const entries = entriesFor(url.searchParams.get('month') || currentMonth);
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 20);
      return json(res, { entries: entries.slice(offset, offset + limit), hasMore: offset + limit < entries.length });
    }
    const detail = path.match(/^\/entries\/(\d+)$/);
    if (detail) return json(res, { entry: datasets[active].flatMap(item => entriesFor(item.value)).find(item => item.id === Number(detail[1])) });
    if (path === '/photos/meta') return json(res, { months: [{ value: '2026-11', count: 3 }] });
    if (path === '/photos') return json(res, { photos: ['2026-11-10', '2024-02-29', '2023-01-01'].map((entryDate, i) => ({
      id: `fixture-${i}`, entryId: 1, entryDate, entryTitle: '合成写真', fileName: 'fixture.svg', thumbnailUrl: '/fixture.svg'
    })), hasMore: false });
    return json(res, {});
  }
  if (url.pathname === '/fixture.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#d9ece8"/></svg>'); }
  const special = { '/assets/pwa-auto-update.js': 'assets/pwa-auto-update.js', '/security/passkey-client.js': 'security-worker/public/passkey-client.js' };
  const file = special[url.pathname] ? resolve(root, special[url.pathname]) : resolve(publicRoot, /^\/diary\/(?:|favorites\/)$/.test(url.pathname) ? 'index.html' : url.pathname.replace(/^\/diary\//, ''));
  if (!file.startsWith(root)) return res.writeHead(404).end();
  try { const data = await readFile(file); res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[extname(file)] || 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404).end(); }
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = [process.env.TROOM_CHROMIUM_EXECUTABLE, chromium.executablePath(), '/usr/bin/chromium'].find(p => p && existsSync(p));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  for (const [name, width, height, timezoneId] of [['desktop', 1280, 800, 'Asia/Tokyo'], ['mobile', 390, 844, 'America/Los_Angeles'], ['small-mobile', 320, 720, 'Asia/Tokyo']]) {
    active = 'many';
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 860, hasTouch: width < 860, timezoneId, serviceWorkers: 'block' });
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(`${origin}/diary/`);
      await page.locator('#archive-year-select').waitFor();
      await page.waitForFunction(() => !document.querySelector('#load-more-button').disabled);
      const panel = page.locator('#archive-panel');
      const geometry = await panel.evaluate(node => ({ height: node.offsetHeight, width: node.offsetWidth, parent: node.parentElement.id,
        beforeEntries: Boolean(node.compareDocumentPosition(document.querySelector('#entry-list')) & Node.DOCUMENT_POSITION_FOLLOWING),
        overflow: document.documentElement.scrollWidth > innerWidth }));
      assert.ok(geometry.height < 500, `${name}: 46か月でも欄の高さを抑える`);
      assert.equal(geometry.overflow, false, `${name}: 横にはみ出さない`);
      assert.equal(geometry.parent === 'diary-main', width < 860, `${name}: PCは右欄、スマホは本文側`);
      if (width < 860) assert.equal(geometry.beforeEntries, true, `${name}: 記事一覧より先に選択できる`);
      assert.equal(await page.locator('#archive-year-select option').count(), 6);
      assert.equal(await page.locator('.archive-button').count(), 8);
      assert.equal(await page.locator('.archive-button[aria-pressed="true"]').getAttribute('data-month'), currentMonth);
      const requestsBeforeYear = entryRequests.length;
      await page.selectOption('#archive-year-select', String(year - 1));
      assert.equal(entryRequests.length, requestsBeforeYear, '年の閲覧だけでは記事を取得しない');
      assert.equal(await page.locator('.archive-button').count(), 12);
      assert.equal(await page.locator('.archive-button').first().getAttribute('aria-label'), `${year - 1}年1月、22件`);
      // Reload must restore the browsed year even when the selected article month differs.
      await page.reload();
      await page.waitForFunction(y => document.querySelector('#archive-year-select')?.value === y, String(year - 1));
      await page.locator(`[data-month="${year - 1}-12"]`).click();
      await page.waitForFunction(m => document.querySelector('.archive-button[aria-pressed="true"]')?.dataset.month === m, `${year - 1}-12`);
      await page.locator('#entry-list [data-entry-id]').first().waitFor();
      await page.waitForFunction(() => Math.abs(document.querySelector('#diary-recent-title').getBoundingClientRect().top - document.querySelector('#site-header').offsetHeight - 12) <= 2);
      const entry = page.locator('#entry-list [data-entry-id]').nth(2);
      await entry.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const top = await entry.evaluate(node => node.getBoundingClientRect().top);
      await entry.click(); await page.locator('#entry-dialog[open]').waitFor(); await page.goBack();
      await page.waitForFunction(() => !document.querySelector('#entry-dialog').open);
      assert.ok(Math.abs(await entry.evaluate(node => node.getBoundingClientRect().top) - top) <= 2, '詳細から戻ると位置が維持される');
      assert.equal(await page.locator('#archive-year-select').inputValue(), String(year - 1));
      await page.click('#next-month-button');
      await page.waitForFunction(y => document.querySelector('#archive-year-select')?.value === y, String(year));
      await page.click('#current-month-button');
      await page.waitForFunction(m => document.querySelector('.archive-button[aria-pressed="true"]')?.dataset.month === m, currentMonth);
      if (width === 390) {
        await page.setViewportSize({ width: 1000, height });
        await page.waitForFunction(() => document.querySelector('#archive-panel').parentElement.classList.contains('diary-side'));
        assert.equal(await panel.evaluate(node => node.parentElement.className), 'diary-side');
        await page.setViewportSize({ width, height });
        await page.waitForFunction(() => document.querySelector('#archive-panel').parentElement.id === 'diary-main');
        assert.equal(await panel.evaluate(node => node.parentElement.id), 'diary-main');
        assert.equal(await page.locator('#archive-panel').count(), 1);
      }
      // Scope changes must remove the previous account's years and counts.
      await page.selectOption('#household-switcher', 'sparse');
      await page.waitForFunction(() => document.querySelectorAll('.archive-button').length === 1);
      assert.equal(await page.locator('#archive-year-select').count(), 0, '1年だけなら年選択は不要');
      assert.equal(await page.locator('.archive-button').textContent(), `${Number(currentMonth.slice(5))}月1件`);
      await page.selectOption('#household-switcher', 'old');
      await page.waitForFunction(y => document.querySelector('.archive-year')?.textContent === `${y}年`, year - 1);
      assert.equal(await page.locator('.archive-button').count(), 1, '今月の記録がないアカウントでも過去の月に到達できる');
      await page.selectOption('#household-switcher', 'empty');
      await page.waitForFunction(() => document.querySelector('#archive-list').textContent === '年月別の記録はまだありません。');
      assert.equal(await page.locator('.archive-button').count(), 0);
      assert.equal(await page.locator('#archive-year-select').count(), 0);
      await page.selectOption('#household-switcher', 'many');
      await page.locator('#archive-year-select').waitFor();
      await page.click('#camera-roll-button');
      await page.locator('.camera-roll-date').last().waitFor();
      assert.deepEqual(await page.locator('.camera-roll-date').allTextContents(), ['2026.11.10（火）', '2024.2.29（木）', '2023.1.1（日）']);
      assert.equal(await page.locator('.camera-roll-date').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)), true, `${name}: 曜日を含めてカード内に収まる`);
      assert.deepEqual(errors, [], `${name}: JavaScriptエラーなし`);
      if (process.env.DIARY_ARCHIVE_SCREENSHOTS) {
        await mkdir(process.env.DIARY_ARCHIVE_SCREENSHOTS, { recursive: true });
        await page.locator('#camera-roll-dialog').screenshot({ path: resolve(process.env.DIARY_ARCHIVE_SCREENSHOTS, `album-${name}.png`) });
        await page.click('[data-close-dialog="camera-roll-dialog"]');
        await page.waitForFunction(() => !document.querySelector('#camera-roll-dialog').open);
        await panel.screenshot({ path: resolve(process.env.DIARY_ARCHIVE_SCREENSHOTS, `archive-${name}.png`) });
      }
      console.log(`${name}: archive navigation, sparse/empty household isolation, return state, weekday and layout passed (${Math.round(geometry.height)}px).`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); await new Promise(r => server.close(r)); }

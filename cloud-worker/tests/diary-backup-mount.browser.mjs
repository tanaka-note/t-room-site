import assert from 'node:assert/strict';
import { chromium, startUIFixture, preparePage } from './ui-fixture.mjs';

const fixture = await startUIFixture();
const browser = await chromium.launch({ headless: true });
const snapshot = {
  available: true, type: 'diary-backup', folderId: 2850, readOnly: true,
  lastBackupAt: '2026-10-25T18:40:00Z', observedAt: '2026-10-26T01:00:00Z', backupBytes: 1234, mediaComplete: true,
  daily: { bytes: 1000, objectCount: 1, objects: [{ name: '<fixture>.json.gz', sizeBytes: 1000, updatedAt: '2026-10-25T18:40:00Z', mediaComplete: true, format: 'fixture' }] },
  monthly: { bytes: 200, objectCount: 1, objects: [{ name: '2026-10.json.gz', sizeBytes: 200, updatedAt: '2026-10-25T18:40:00Z' }] },
  photo: { bytes: 34, objectCount: 2, lastUpdatedAt: '2026-10-25T18:40:00Z' }
};
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let status = 200, listingStatus = 200, delayed = null, delayNext = false;
    const calls = [];
    await page.route('**/cloud/api/**', async route => {
      const url = new URL(route.request().url()); calls.push(url.pathname + url.search);
      if (url.pathname.endsWith('/diary-backups')) {
        if (delayNext) { delayNext = false; await new Promise(resolve => { delayed = resolve; }); }
        await route.fulfill({ status, json: status === 200 ? snapshot : { error: 'fixture failure' } });
      } else if (url.pathname.endsWith('/items')) {
        const id = Number(url.searchParams.get('folderId'));
        await route.fulfill({ status: listingStatus, json: listingStatus === 200 ? {
          folder: { id, name: 'renamed mount' }, folders: [],
          files: [{ id: 1, name: 'ordinary.txt', originalName: 'ordinary.txt', mediaKind: 'document', sizeBytes: 10 }],
          breadcrumbs: [], backupMount: id === 2850 ? { type: 'diary-backup', folderId: id } : null
        } : { error: 'fixture denied' } });
      } else await route.fulfill({ json: {} });
    });
    await preparePage(page, fixture.origin, 0);
    const panel = page.locator('#diary-backup-mount');
    const open = async (role = 'member', folderId = 2850) => page.evaluate(async ({ role, folderId }) => {
      __test.state.session = { role, serviceAccountId: role === 'member' ? 'folder-member' : 'admin', sessionCacheId: 'fixture-' + role, rootFolderId: 2850, serviceLinkId: 'ordinary-member' };
      __test.state.folderId = folderId; __test.state.view = 'all'; __test.state.query = '';
      return __test.loadItems();
    }, { role, folderId });
    const loaded = () => panel.locator('.backup-summary').waitFor();
    await open('admin'); await loaded();
    const adminText = await panel.textContent();
    const memberStart = calls.length;
    await open('member'); await loaded();
    assert.equal(await panel.textContent(), adminText, 'one renderer supplies identical admin/member details');
    assert.match(adminText, /最終バックアップ|バックアップ容量/);
    assert.equal(await panel.locator('a, input, [draggable=true], .file-card, .folder-card').count(), 0);
    await panel.locator('[data-backup-group=daily] summary').click();
    assert.match(await panel.textContent(), /<fixture>\.json\.gz/);
    assert.equal(await panel.locator('fixture').count(), 0, 'generation names are escaped');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.locator('.backup-refresh').click(); await loaded();
    assert.ok(calls.some(path => path.endsWith('/diary-backups?refresh=1')));
    assert.equal(calls.slice(memberStart).some(path => /\/usage(?:-details)?(?:\?|$)/.test(path)), false, 'member refresh never requests admin usage APIs');
    await open('member', 7); await panel.waitFor({ state: 'hidden' });
    assert.equal(await panel.textContent(), '');
    await open(); await loaded();
    // A failed normal listing must not retain the old mount permission or data.
    listingStatus = 403; await page.evaluate(() => __test.loadItems());
    await panel.waitFor({ state: 'hidden' }); assert.equal(await panel.textContent(), ''); listingStatus = 200;
    // Snapshot errors leave ordinary files usable.
    status = 503; await open();
    await page.getByText('バックアップ情報を取得できませんでした。通常ファイルは引き続き利用できます。', { exact: true }).waitFor();
    assert.equal(await page.locator('#content-grid .file-card').count(), 1);
    status = 200; await open(); await loaded();
    for (const denied of [403, 423, 401, 419]) {
      status = denied;
      await panel.locator('.backup-refresh').click(); await panel.waitFor({ state: 'hidden' });
      assert.equal(await panel.textContent(), '');
      assert.equal(await page.evaluate(() => __test.state.backupMount), null);
      status = 200; await open(); await loaded();
    }
    // An already-authorized late response cannot repopulate a departed folder.
    delayNext = true; await open();
    await page.waitForFunction(() => document.querySelector('.backup-snapshot')?.textContent.includes('取得しています'));
    while (!delayed) await new Promise(resolve => setTimeout(resolve, 10));
    await open('member', 7); delayed(); delayed = null;
    await panel.waitFor({ state: 'hidden' }); assert.equal(await panel.textContent(), '');
    // Logout and a new session also discard an in-flight response.
    delayNext = true; await open();
    while (!delayed) await new Promise(resolve => setTimeout(resolve, 10));
    await page.evaluate(() => __test.releaseSessionState()); delayed(); delayed = null;
    await panel.waitFor({ state: 'hidden' }); assert.equal(await panel.textContent(), '');
    await preparePage(page, fixture.origin, 0, { reload: true });
    assert.equal(await panel.textContent(), ''); await open(); await loaded();
    assert.deepEqual(errors, []);
    console.log('PASS backup mount common renderer, read-only UI, navigation/reload/session isolation, late replies, 401/403/419/423 and outage', viewport);
    await page.close();
  }
} finally { await browser.close(); await fixture.close(); }

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { engines, startUIFixture, preparePage, root } from './ui-fixture.mjs';

const fixture = await startUIFixture();
const empty = { bytes: 0, objectCount: 0, objects: [] };
const snapshot = { daily: empty, monthly: empty, photo: empty, backupBytes: 1200, diaryAvailable: true, serviceBackupsAvailable: true,
  observedAt: new Date().toISOString(), status: { state: 'ok', lastSuccessAt: new Date().toISOString() },
  services: [{ id: 'billing', label: '請求書管理', available: true, state: 'failed', stage: 'daily_save', reason: 'operation_failed', attempt: 3,
    lastSuccessAt: '2026-10-24T18:40:00Z', lastAttemptAt: '2026-10-25T18:40:00Z', history: [{ state: 'failed', at: '2026-10-25T18:40:00Z' }] },
  { id: 'security-audit', label: 'セキュリティ監査の長期保管', available: true, state: 'partial', pendingCount:1001, pendingCapped:true, oldestPendingAt:'2026-01-01T00:00:00Z', retention: 'indefinite', periods: [
    { month: '2026-10', bytes: 200, rowCount: 10, firstAt: '2026-01-01T00:00:00Z', lastAt: '2026-01-02T00:00:00Z' }] },
  { id: 'escaped', label: '<img id="injected" src=x>', available: false, state: 'unavailable' }] };
const writes = [];
try {
  for (const [name, engine, options] of engines) {
    const browser = await engine.launch({ headless: true, ...options });
    try {
      for (const mobile of [false, true]) {
        const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
        await page.route('**/cloud/api/**', async route => {
          if (route.request().method() !== 'GET') writes.push(route.request().method());
          await route.fulfill({ json: route.request().url().includes('/diary-backups') ? snapshot : {} });
        });
        await preparePage(page, fixture.origin, 0);
        await page.evaluate(() => {
          Object.assign(__test.state, { session: { role: 'admin' }, folderId: 2850, backupMount: { type: 'diary-backup', folderId: 2850 }, query: '', view: 'all' });
          renderDiaryBackupMount();
        });
        const panel = page.locator('#diary-backup-mount');
        await panel.getByText('請求書管理：失敗', { exact: true }).waitFor();
        assert.match(await panel.innerText(), /日次保存.*処理に失敗しました.*試行 3回/);
        await panel.getByText('セキュリティ監査の長期保管：一部未完了', { exact: true }).waitFor();
        assert.match(await panel.innerText(), /180日超の履歴を期限なしで保管/);
        assert.match(await panel.innerText(),/未保管 1001件以上.*最古の未保管/);
        assert.equal(await page.locator('#injected').count(), 0);
        assert.equal(await panel.locator('input[type=checkbox], [draggable=true], a').count(), 0);
        const adminDetails = await panel.textContent();
        await page.evaluate(() => { __test.state.folderId = 7; renderDiaryBackupMount(); });
        assert.equal(await panel.isVisible(), false);
        await page.evaluate(() => {
          __test.state.session = { role: 'member', sessionCacheId: 'delegated-member' };
          __test.state.folderId = 2850;
          renderDiaryBackupMount();
        });
        await panel.getByText('請求書管理：失敗', { exact: true }).waitFor();
        await panel.getByText('セキュリティ監査の長期保管：一部未完了', { exact: true }).waitFor();
        assert.equal(await panel.isVisible(), true, 'authorized members see aggregated status, errors, history and archive periods');
        assert.equal(await page.evaluate(() => document.querySelector('#diary-backup-mount').textContent), adminDetails);
        await page.evaluate(() => { __test.state.backupMount = null; renderDiaryBackupMount(); });
        assert.equal(await panel.isVisible(), false, 'a member without an authorized mount sees no details');
        assert.equal(await panel.textContent(), '');
        assert.deepEqual(writes, []);
        await page.evaluate(() => { __test.state.session = { role: 'admin' }; __test.state.backupMount = { type: 'diary-backup', folderId: 2850 }; renderDiaryBackupMount(); });
        await panel.getByText('請求書管理：失敗', { exact: true }).waitFor();
        await panel.getByText('セキュリティ監査の長期保管：一部未完了', { exact: true }).waitFor();
        mkdirSync(root + '/tmp/backup-ui', { recursive: true });
        await panel.screenshot({ path: root + `/tmp/backup-ui/${name}-${mobile ? 'mobile' : 'desktop'}.png` });
        await page.close();
      }
    } finally { await browser.close(); }
    console.log('PASS', name, 'backup status, error history, long-term archive, folder/role boundaries, escaped metadata and read-only desktop/mobile UI');
  }
} finally { await fixture.close(); }

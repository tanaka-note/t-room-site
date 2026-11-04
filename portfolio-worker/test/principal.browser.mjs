import assert from 'node:assert/strict';
import { pickDate } from './date-picker.browser.mjs';
import { fixture } from './fixture.js';

async function verifyHistoryTooltips(page, history) {
  const yen = value => new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(value);
  for (const range of ['7d', '1m', 'all']) {
    await page.locator(`button[data-history-range="${range}"]`).click();
    assert.equal(await page.locator(`button[data-history-range="${range}"]`).getAttribute('aria-pressed'), 'true');
    const chart = page.locator('#history-chart'), box = await chart.boundingBox();
    for (const [entry, x] of [[history[0], box.x], [history.at(-1), box.x + box.width]]) {
      await chart.dispatchEvent('pointerdown', { clientX: x, clientY: box.y + 100, pointerType: 'touch' });
      const tooltip = page.locator('#history-tooltip');
      assert.equal(await tooltip.isVisible(), true);
      assert.equal(await tooltip.locator('time').getAttribute('datetime'), entry.period);
      assert.equal(await tooltip.locator('strong').textContent(), yen(entry.rawMarketValue - 32000));
      assert.equal(await tooltip.locator(':scope > *').count(), 2);
      assert.doesNotMatch(await tooltip.textContent(), /損益/);
    }
    await chart.dispatchEvent('pointermove', { clientX: box.x, clientY: box.y + 100, pointerType: 'mouse' });
    assert.equal(await page.locator('#history-tooltip time').getAttribute('datetime'), history[0].period);
    await chart.dispatchEvent('pointerleave', { pointerType: 'mouse' });
    assert.equal(await page.locator('#history-tooltip').isVisible(), false);
  }
}

export async function verifyPrincipalEditor(browser, url, routeApi) {
  for (const width of [1440, 390, 320]) {
    const f = fixture(), context = await browser.newContext({ viewport: { width, height: 1000 } });
    try {
      await f.login();
      const page = await context.newPage();
      await routeApi(page, f); await page.goto(url);
      await page.locator('#report-app').waitFor({ state: 'visible' });
      await verifyHistoryTooltips(page, (await f.state()).history);
      await page.locator('#edit-toggle').click();
      assert.equal(await page.locator('#base-principal').inputValue(), '1,000,000');
      await page.locator('#base-principal').fill('800,000');
      await pickDate(page, 'record-date', '2026-11-01');
      await page.waitForFunction(() => document.querySelector('#editor-note').textContent.includes('新しい日付'));
      assert.equal(await page.locator('#base-principal').inputValue(), '800,000');
      let confirmation = '';
      page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.dismiss(); });
      await page.locator('#save-button').click();
      assert.match(confirmation, /全日付の損益・損益率/);
      assert.equal((await f.state()).revision, 0);
      assert.equal(await page.locator('#base-principal').inputValue(), '800,000');
      await page.locator('#base-principal').fill('0'); await page.locator('#save-button').click();
      await page.waitForFunction(() => document.querySelector('#app-message').textContent.includes('1円以上'));
      assert.equal((await f.state()).revision, 0);
      page.on('dialog', dialog => dialog.accept());
      await page.locator('#base-principal').fill('800,000'); await page.locator('#save-button').click();
      await page.waitForFunction(() => document.querySelector('#app-message').textContent.includes('保存しました'));
      assert.match(await page.locator('#principal-value').textContent(), /800,000/);
      assert.match(await page.locator('#profit-value').textContent(), /368,000/);
      assert.match(await page.locator('#return-value').textContent(), /46\.00/);
      await page.reload(); await page.locator('#report-app').waitFor({ state: 'visible' });
      assert.match(await page.locator('#principal-value').textContent(), /800,000/);
      await verifyHistoryTooltips(page, (await f.state()).history);
      await pickDate(page, 'view-date', '2026-10-30');
      await page.waitForFunction(() => document.querySelector('.holdings-panel').hidden);
      assert.equal(await page.locator('#profit-value').isVisible(), false);
      assert.equal(await page.locator('#return-value').isVisible(), false);
      assert.equal(await page.locator('#profit-value').textContent(), '');
      assert.equal(await page.locator('#return-value').textContent(), '');
      assert.equal(await page.locator('.summary-card:visible').count(), 2);
      assert.match(await page.locator('#market-value').textContent(), /1,068,000/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await pickDate(page, 'view-date', '2026-11-01');
      await page.locator('#profit-value').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#return-value').isVisible(), true);
      assert.equal(await page.locator('.summary-card:visible').count(), 4);
      assert.match(await page.locator('#profit-value').textContent(), /368,000/);
      assert.match(await page.locator('#return-value').textContent(), /46\.00/);
      await pickDate(page, 'view-date', '2026-10-30');
      await page.locator('#profit-value').waitFor({ state: 'hidden' });
      await page.locator('#edit-toggle').click();
      assert.equal(await page.locator('#base-principal').inputValue(), '800,000');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      f.setActive(false);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.locator('#login-panel').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#base-principal').inputValue(), '');
    } finally { await context.close(); f.close(); }
  }
  console.log('Principal editor: confirmation, persistence, latest-only performance, date/value-only tooltips, ranges, touch/mouse and revocation at desktop/mobile widths passed.');
}

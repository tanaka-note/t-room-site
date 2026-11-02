import assert from 'node:assert/strict';
import { fixture } from './fixture.js';

export async function verifyPrincipalEditor(browser, url, routeApi) {
  for (const width of [1440, 390, 320]) {
    const f = fixture(), context = await browser.newContext({ viewport: { width, height: 1000 } });
    try {
      await f.login();
      const page = await context.newPage();
      await routeApi(page, f); await page.goto(url);
      await page.locator('#report-app').waitFor({ state: 'visible' });
      await page.locator('#edit-toggle').click();
      assert.equal(await page.locator('#base-principal').inputValue(), '1000000');
      await page.locator('#base-principal').fill('800,000');
      await page.locator('#record-date').fill('2026-11-01');
      await page.locator('#record-date').dispatchEvent('change');
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
      await page.locator('#view-date').selectOption('2026-10-30');
      await page.waitForFunction(() => document.querySelector('.holdings-panel').hidden);
      assert.match(await page.locator('#profit-value').textContent(), /268,000/);
      await page.locator('#edit-toggle').click();
      assert.equal(await page.locator('#base-principal').inputValue(), '800000');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      f.setActive(false);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.locator('#login-panel').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#base-principal').inputValue(), '');
    } finally { await context.close(); f.close(); }
  }
  console.log('Principal editor: confirmation, validation, persistence, recalculation and revocation at desktop/mobile widths passed.');
}

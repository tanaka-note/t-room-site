import assert from 'node:assert/strict';
import { fixture } from './fixture.js';

export async function pickDate(page, target, value) {
  await page.locator(`[data-date-picker-target="${target}"]`).click();
  const dialog = page.locator('#troom-calendar-dialog');
  await dialog.waitFor({ state: 'visible' });
  // Select through the shared year/month views when crossing a month boundary.
  if (!await dialog.locator(`[data-calendar-value="${value}"]`).count()) {
    await dialog.locator('#troom-calendar-title').click();
    const year = value.slice(0, 4), month = value.slice(0, 7);
    const currentYear = Number((await dialog.locator('#troom-calendar-title').textContent()).match(/\d+/)[0]);
    while (!await dialog.locator(`[data-calendar-value="${year}"]`).count()) {
      await dialog.locator(`[data-calendar-action="${Number(year) < currentYear ? 'previous' : 'next'}"]`).click();
    }
    await dialog.locator(`[data-calendar-value="${year}"]`).click();
    await dialog.locator(`[data-calendar-value="${month}"]`).click();
  }
  await dialog.locator(`[data-calendar-value="${value}"]`).click();
  await dialog.waitFor({ state: 'hidden' });
}

export async function verifyDatePickers(browser, url, routeApi) {
  for (const width of [1440, 390, 320]) {
    const f = fixture(), context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 600 });
    try {
      await f.login();
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      await routeApi(page, f); await page.goto(url);
      await page.locator('#report-app').waitFor({ state: 'visible' });
      assert.equal(await page.locator('input[type=date]').count(), 0);
      await pickDate(page, 'view-date', '2026-10-30');
      await page.waitForFunction(() => document.querySelector('.holdings-panel').hidden);
      assert.match(await page.locator('#report-updated').textContent(), /2026年10月30日/);
      await pickDate(page, 'view-date', '2026-10-28');
      await page.waitForFunction(() => document.querySelector('#app-message').textContent.includes('この日付の記録はありません'));
      assert.equal(await page.locator('#view-date').inputValue(), '2026-10-30');
      await pickDate(page, 'view-date', '2026-10-31');
      await page.locator('.holdings-panel').waitFor({ state: 'visible' });
      await page.locator('#edit-toggle').click();
      await page.locator('#base-principal').fill('800000');
      const wheel = page.locator('#date-wheel-dialog'), calendar = page.locator('#troom-calendar-dialog');
      await page.locator('#record-date').click(); await wheel.waitFor({ state: 'visible' });
      assert.match(await wheel.locator('#date-wheel-value').textContent(), /2026年10月31日/);
      assert.ok(await wheel.evaluate(el => el.getBoundingClientRect().right <= innerWidth));
      // The wheel has the same cancellation and history behavior as other services.
      await wheel.locator('#date-wheel-day').press('ArrowUp');
      await wheel.locator('#date-wheel-cancel').click(); await wheel.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#record-date').inputValue(), '2026-10-31');
      assert.equal(await page.locator('#base-principal').inputValue(), '800000');
      await page.locator('#record-date').click(); await wheel.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape'); await wheel.waitFor({ state: 'hidden' });
      await page.locator('#record-date').click(); await wheel.waitFor({ state: 'visible' });
      if (width < 600) await page.touchscreen.tap(5, 5); else await page.mouse.click(5, 5);
      await wheel.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#record-date').inputValue(), '2026-10-31');
      await page.locator('[data-date-picker-target=record-date]').click(); await calendar.waitFor({ state: 'visible' });
      assert.ok(await calendar.evaluate(el => el.getBoundingClientRect().right <= innerWidth));
      assert.equal(await calendar.locator('[aria-selected=true]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(87, 114, 99)');
      if (width < 600) await page.touchscreen.tap(5, 5); else await page.mouse.click(5, 5);
      await calendar.waitFor({ state: 'hidden' });
      await page.locator('[data-date-picker-target=record-date]').click(); await calendar.waitFor({ state: 'visible' });
      await page.goBack(); await calendar.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#record-date').inputValue(), '2026-10-31');
      assert.equal(await page.locator('#editor-panel').isVisible(), true);
      await pickDate(page, 'record-date', '2028-02-29');
      await page.waitForFunction(() => document.querySelector('#editor-note').textContent.includes('新しい日付'));
      assert.equal(await page.locator('#base-principal').inputValue(), '800000');
      await page.locator('#record-date').click(); await wheel.waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('#date-wheel-day').dataset.settingScroll);
      await wheel.locator('#date-wheel-day').press('ArrowUp');
      await wheel.locator('#date-wheel-done').click(); await wheel.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#record-date').inputValue(), '2028-02-28');
      await page.locator('#save-button').click();
      await page.waitForFunction(() => document.querySelector('#app-message').textContent.includes('保存しました'));
      assert.equal((await f.state()).record.period, '2028-02-28');
      await page.locator('#view-date').click(); await wheel.waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => document.dispatchEvent(new Event('troom:before-auto-update', { cancelable: true }))), false);
      f.setActive(false); await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.locator('#login-panel').waitFor({ state: 'visible' });
      assert.equal(await page.locator('dialog[open]').count(), 0);
      assert.equal(await page.locator('#date-wheel-value').textContent(), '');
      assert.equal(await page.locator('#view-date').inputValue(), '');
      assert.deepEqual(errors, []);
    } finally { await context.close(); f.close(); }
  }
  console.log('Shared date pickers: record viewing, missing dates, year/month/leap day, wheel apply/cancel, Escape/Back, dirty inputs and revocation passed at desktop/mobile widths.');
}

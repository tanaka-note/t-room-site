import assert from 'node:assert/strict';
import { verifyDirectPwaInstall } from '../../tools/pwa-install-browser-check.mjs';

export async function verifyBillingHomeInput(page, { db, mobile }) {
  const install = page.locator('#install-app-button');
  assert.equal(await install.isVisible(), true);
  assert.equal(await page.locator('#print-button').isVisible(), false);
  assert.equal(await install.evaluate(button => button.previousElementSibling.querySelector('select')?.id), 'document-filter');
  assert.equal(await install.evaluate(button => button.nextElementSibling.id), 'print-button');
  // No browser offer must produce guidance rather than claiming installation.
  await install.click();
  assert.match(await page.locator('#install-app-message').textContent(), /まだ利用できません/);
  await verifyDirectPwaInstall(page);

  const description = `Input order ${mobile ? 'touch' : 'mouse'}`;
  const note = `Income order ${mobile ? 'touch' : 'mouse'}`;
  await page.selectOption('#document-filter', 'invoice');
  await page.click('#new-entry-button');
  const order = () => page.evaluate(() => {
    const amount = document.getElementById('entry-amount');
    const description = document.getElementById('entry-description');
    return {
      dom: Boolean(amount.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING),
      visual: amount.getBoundingClientRect().top < description.getBoundingClientRect().top
    };
  });
  assert.deepEqual(await order(), { dom: true, visual: true });
  await page.fill('#entry-amount', '12345');
  assert.equal(await page.locator('#entry-amount').inputValue(), '12,345');
  await page.locator('#entry-amount').press('Tab');
  assert.equal(await page.locator('#entry-description').evaluate(node => node === document.activeElement), true);
  await page.fill('#entry-description', description);
  await page.evaluate(() => { document.getElementById('entry-date').value = '2026-11-04'; });
  const save = async (path, method) => {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === `/billing/api/${path}` && r.request().method() === method);
    await page.click('#entry-form button[type=submit]');
    assert.equal((await response).ok(), true);
    await page.locator('#entry-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.getElementById('report').getAttribute('aria-busy') === 'false');
  };
  await save('entries', 'POST');
  const record = db.prepare('SELECT id,amount_yen,description FROM billing_entries WHERE description=?').get(description);
  assert.equal(record.amount_yen, 12345);
  assert.equal(record.description, description);
  const row = page.locator('#entries-body tr').filter({ hasText: description });
  await row.waitFor();
  await row.locator('[data-action=edit]').click();
  assert.equal(await page.locator('#entry-dialog-title').textContent(), '明細を編集');
  assert.deepEqual(await order(), { dom: true, visual: true });
  assert.equal(await page.locator('#entry-description').inputValue(), description);
  assert.equal(await page.locator('#entry-amount').inputValue(), '12,345');
  await page.fill('#entry-amount', '54321');
  await page.fill('#entry-description', `${description} edited`);
  await save(`entries/${record.id}`, 'PUT');
  const edited = db.prepare('SELECT amount_yen,description FROM billing_entries WHERE id=?').get(record.id);
  assert.equal(edited.amount_yen, 54321);
  assert.equal(edited.description, `${description} edited`);

  // Income shares the form but must keep its own required/hidden controls.
  await page.click('#new-entry-button');
  await page.selectOption('#entry-category', 'income');
  assert.equal(await page.locator('#entry-description').isVisible(), false);
  assert.equal(await page.locator('#entry-description').getAttribute('required'), null);
  assert.equal(await page.locator('#settlement-direction').isVisible(), true);
  assert.equal(await page.locator('#settlement-method').isVisible(), true);
  await page.fill('#entry-amount', '6789');
  await page.selectOption('#settlement-direction', 'incoming');
  await page.selectOption('#settlement-method', 'cash');
  await page.fill('#entry-note', note);
  await page.evaluate(() => { document.getElementById('entry-date').value = '2026-11-04'; });
  await save('settlements', 'POST');
  const income = db.prepare('SELECT amount_yen,direction,method FROM billing_settlements WHERE note=?').get(note);
  assert.equal(income.amount_yen, 6789);
  assert.equal(income.direction, 'incoming');
  assert.equal(income.method, 'cash');
  await page.click('#settlements-card');
  await page.locator('#settlements-body tr').filter({ hasText: note }).locator('[data-settlement-action=edit]').click();
  assert.equal(await page.locator('#entry-description').isVisible(), false);
  assert.equal(await page.locator('#entry-amount').inputValue(), '6,789');
  await page.click('#entry-dialog [data-close-dialog]');
  await page.locator('#entry-dialog').waitFor({ state: 'hidden' });
  await page.click('#settlements-dialog [data-close-dialog]');
  await page.locator('#settlements-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log(`billing home install + entry add/edit + income: passed (${mobile ? 'touch' : 'desktop'})`);
}

export async function verifyBillingInstallModes(browser, origin) {
  for (const standalone of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
    });
    try {
      if (standalone) await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
      const page = await context.newPage();
      await page.goto(`${origin}/billing/`);
      await page.waitForSelector('#app-view:not([hidden])');
      assert.equal(await page.locator('#install-app-button').isVisible(), !standalone);
      if (!standalone) {
        await page.click('#install-app-button');
        assert.match(await page.locator('#install-app-message').textContent(), /Safariの共有ボタン.*ホーム画面に追加/);
      } else assert.equal(await page.locator('#install-app-message').isVisible(), false);
    } finally { await context.close(); }
  }
  console.log('billing iOS guidance + standalone suppression: passed (simulated browser state)');
}

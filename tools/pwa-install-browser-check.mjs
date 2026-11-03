import assert from 'node:assert/strict';

// Synthetic native events exercise the page's actual buttons. This does not
// claim to install an Android WebAPK or reproduce a device's package registry.
export async function verifyDirectPwaInstall(page) {
  const url = page.url();
  await page.evaluate(() => {
    window.installProbe = { calls: 0, activeClick: false, updateAllowed: true };
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = () => {
      window.installProbe.calls++;
      window.installProbe.activeClick = navigator.userActivation.isActive;
      window.installProbe.updateAllowed = document.dispatchEvent(new Event('troom:before-auto-update', { cancelable: true }));
      return Promise.resolve();
    };
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);
  });
  await page.locator('[data-pwa-install]').click();
  await page.waitForFunction(() => document.querySelector('[data-pwa-install-status]').textContent.includes('受け付けました'));
  assert.deepEqual(await page.evaluate(() => window.installProbe), { calls: 1, activeClick: true, updateAllowed: false });
  assert.equal(page.url(), url, 'installation must not redirect the page');
  assert.doesNotMatch(await page.locator('[data-pwa-install-status]').textContent(), /完了しました/);
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  assert.equal(await page.locator('[data-pwa-install]').isDisabled(), true);
  assert.equal(await page.locator('[data-pwa-install]').textContent(), '追加済み');
  assert.match(await page.locator('[data-pwa-install-status]').textContent(), /完了しました/);
}

// Exercise the same year/month wheel that users operate, including completion.
export async function selectAlbumMonth(page, value) {
  await page.click('#photo-month-filter');
  await page.waitForSelector('#date-wheel-dialog[open]');
  if (value) {
    const [year, month] = value.split('-').map(Number);
    await page.locator(`#date-wheel-year [data-value="${year}"]`).click();
    await page.locator(`#date-wheel-month [data-value="${month}"]`).click();
    await page.click('#date-wheel-done');
  } else await page.click('#date-wheel-all');
  await page.waitForFunction(() => !document.getElementById('date-wheel-dialog').open);
}

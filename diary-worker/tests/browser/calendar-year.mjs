import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch(process.platform === "win32" ? { channel: "msedge", headless: true } : { headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, serviceWorkers: "block" });
  const errors = [];
  const queries = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://diary.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/diary/api/")) {
      let result = {};
      if (url.pathname.endsWith("/session")) result = {
        authenticated: true, role: "admin", accountName: "カレンダーテスト", householdId: "test",
        activeHouseholdId: "test", isGlobalOwner: false, canManageEntries: true, canViewTrash: true
      };
      if (url.pathname.endsWith("/meta")) result = { months: [], tags: [], draftCount: 0 };
      if (url.pathname.endsWith("/entries")) {
        queries.push(Object.fromEntries(url.searchParams));
        result = { entries: [], hasMore: false };
      }
      return route.fulfill({ json: result });
    }
    const shared = {
      "/assets/pwa-auto-update.js": "../../../assets/pwa-auto-update.js",
      "/security/passkey-client.js": "../../../security-worker/public/passkey-client.js"
    };
    const path = shared[url.pathname] || `../../public/${url.pathname === "/diary/" ? "index.html" : url.pathname.slice("/diary/".length)}`;
    const contentType = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
    try { await route.fulfill({ body: await readFile(new URL(path, import.meta.url)), contentType }); }
    catch { await route.fulfill({ status: 404, body: "Not found" }); }
  });
  await page.goto("http://diary.test/diary/", { waitUntil: "networkidle" });
  await page.waitForSelector("#app-view:not([hidden])");
  await page.evaluate(() => {
    window.calendarEvents = [];
    for (const id of ["diary-date-from", "diary-date-to"]) {
      for (const type of ["input", "change"]) document.getElementById(id).addEventListener(type, () => {
        window.calendarEvents.push([id, type]);
      });
    }
  });
  const calendar = page.locator("#troom-calendar-dialog");
  async function selectDate(id, year, month, day) {
    const input = page.locator(`#${id}`);
    await input.click();
    await page.waitForSelector("#date-wheel-dialog[open]");
    assert.equal(await calendar.evaluate((node) => node.open), false, "field opens the existing wheel only");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#date-wheel-dialog").open);
    const before = await input.inputValue();
    await page.locator(`[data-date-picker-target="${id}"]`).click();
    await page.waitForSelector('#troom-calendar-dialog[open][data-mode="date"]');
    const title = page.locator("#troom-calendar-title");
    await title.focus();
    await page.keyboard.press("Enter");
    assert.equal(await calendar.getAttribute("data-mode"), "year");
    assert.ok(await calendar.locator("[data-calendar-value]").count() <= 12);
    while (!(await calendar.locator(`[data-calendar-value="${year}"]`).count())) {
      const first = Number(await calendar.locator("[data-calendar-value]").first().getAttribute("data-calendar-value"));
      await calendar.locator(`[data-calendar-action="${year < first ? "previous" : "next"}"]`).click();
    }
    const size = await calendar.locator(`[data-calendar-value="${year}"]`).boundingBox();
    assert.ok(size.width >= 44 && size.height >= 44);
    await calendar.locator(`[data-calendar-value="${year}"]`).click();
    assert.equal(await calendar.getAttribute("data-mode"), "month");
    assert.equal(await calendar.locator("[data-calendar-value]").count(), 12);
    await calendar.locator(`[data-calendar-value="${year}-${month}"]`).click();
    assert.equal(await calendar.getAttribute("data-mode"), "date");
    assert.equal(await input.inputValue(), before, "year/month browsing does not commit a search");
    await calendar.locator(`[data-calendar-value="${year}-${month}-${day}"]`).click();
    await page.waitForFunction(() => !document.querySelector("#troom-calendar-dialog").open);
    assert.equal(await input.inputValue(), `${year}-${month}-${day}`);
  }
  await selectDate("diary-date-from", "2020", "02", "29");
  await page.setViewportSize({ width: 390, height: 844 });
  await selectDate("diary-date-to", "2020", "03", "10");
  await page.waitForLoadState("networkidle");
  assert.deepEqual(await page.evaluate(() => window.calendarEvents), [
    ["diary-date-from", "input"], ["diary-date-from", "change"], ["diary-date-to", "input"], ["diary-date-to", "change"]
  ]);
  assert.ok(queries.some((query) => query.dateFrom === "2020-02-29" && query.dateTo === "2020-03-10"));
  await page.locator('[data-date-picker-target="diary-date-to"]').click();
  assert.equal(await calendar.locator('[data-calendar-value="2020-03-10"]').getAttribute("aria-selected"), "true");
  await page.locator("#troom-calendar-title").click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#troom-calendar-dialog").open);
  await page.locator('[data-date-picker-target="diary-date-to"]').click();
  assert.equal(await calendar.getAttribute("data-mode"), "date", "reopening resets the selection view");
  await page.mouse.click(2, 2);
  await page.waitForFunction(() => !document.querySelector("#troom-calendar-dialog").open);
  assert.equal(await page.locator("#diary-date-to").inputValue(), "2020-03-10");
  assert.deepEqual(errors, []);
  console.log("Chromium: year/month/day selection for both date filters, original wheel, events, selection and dismissal passed.");
} finally {
  await browser.close();
}

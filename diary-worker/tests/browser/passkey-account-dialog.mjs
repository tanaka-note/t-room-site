import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Load the shipped CSS and shared dialog implementation, never a mock dialog.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const services = ["diary", "billing", "cloud"];
const assets = new Map(await Promise.all(services.map(async (service) => [
  `/${service}.css`, ["text/css", await readFile(resolve(root, `${service}-worker/public/${service}.css`), "utf8")]
])));
assets.set("/passkey-client.js", ["text/javascript", await readFile(resolve(root, "security-worker/public/passkey-client.js"), "utf8")]);
const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const service = pathname.slice(1);
  const asset = assets.get(pathname);
  if (asset) {
    response.writeHead(200, { "Content-Type": `${asset[0]}; charset=utf-8` });
    return response.end(asset[1]);
  }
  if (!services.includes(service)) { response.writeHead(404); return response.end(); }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="stylesheet" href="/${service}.css"><script src="/passkey-client.js" defer></script></head><body></body></html>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.TROOM_CHROMIUM_EXECUTABLE || [
  chromium.executablePath(),
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
].find(existsSync);
let browser;
const links = [
  { id: "owner", accountId: "admin", accountDisplayName: "田中宏知（オーナー）", roleLabel: "管理者・全体管理" },
  { id: "member", accountId: "subadmin", accountDisplayName: "田中宏知（一般ユーザー）", roleLabel: "一般ユーザー" }
];

async function openDialog(page, service, choices = links) {
  await page.evaluate(({ service, choices }) => {
    window.accountChoice = "pending";
    TRoomPasskeys.chooseLinkDialog(choices, service).then((value) => { window.accountChoice = value; });
  }, { service, choices });
  await page.locator(".troom-passkey-account-dialog").waitFor({ state: "visible" });
}

async function geometry(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector(".troom-passkey-account-dialog");
    const list = dialog.querySelector(".troom-passkey-account-list");
    const cancel = dialog.querySelector(".troom-passkey-account-cancel");
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    return {
      dialog: rect(dialog), list: rect(list), cancel: rect(cancel), modal: dialog.matches(":modal"),
      overflow: document.documentElement.scrollWidth > innerWidth,
      dialogOverflow: dialog.scrollWidth > dialog.clientWidth,
      listOverflow: list.scrollWidth > list.clientWidth,
      backdrop: getComputedStyle(dialog, "::backdrop").backgroundColor,
      options: [...list.children].map((button) => ({
        rect: rect(button), name: rect(button.querySelector("strong")), role: rect(button.querySelector("small")),
        overflow: button.scrollWidth > button.clientWidth,
        border: parseFloat(getComputedStyle(button).borderTopWidth),
        rowGap: parseFloat(getComputedStyle(button).rowGap),
        radius: parseFloat(getComputedStyle(button).borderTopLeftRadius)
      }))
    };
  });
}

function assertWithinViewport(g, viewport, label) {
  assert.equal(g.overflow || g.dialogOverflow || g.listOverflow || g.options.some(o => o.overflow), false, `${label}: no horizontal overflow`);
  assert.ok(g.dialog.x >= 0 && g.dialog.right <= viewport.width + 1, `${label}: dialog fits width`);
  assert.ok(g.dialog.y >= 0 && g.dialog.bottom <= viewport.height + 1, `${label}: dialog fits height`);
}

try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  for (const service of services) for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/${service}`);
    await openDialog(page, service);
    const label = `${service} ${viewport.width}x${viewport.height}`;
    const options = page.locator(".troom-passkey-account-option");
    assert.equal(await options.first().evaluate(el => el === document.activeElement), true, `${label}: initial focus`);
    assert.deepEqual(await options.locator("strong").allTextContents(), links.map(l => l.accountDisplayName), `${label}: names`);
    assert.deepEqual(await options.locator("small").allTextContents(), links.map(l => l.roleLabel), `${label}: roles`);
    assert.equal(await page.getByRole("heading", { name: service === "cloud" ? "利用するT-Cloudアカウントを選択" : "利用するアカウントを選択", exact: true }).count(), 1);
    const g = await geometry(page);
    assertWithinViewport(g, viewport, label);
    assert.equal(g.modal, true);
    assert.ok(Math.abs(g.dialog.x + g.dialog.width / 2 - viewport.width / 2) <= 2, `${label}: horizontal center`);
    assert.ok(Math.abs(g.dialog.y + g.dialog.height / 2 - viewport.height / 2) <= 2, `${label}: vertical center`);
    assert.notEqual(g.backdrop, "rgba(0, 0, 0, 0)", `${label}: backdrop`);
    for (const option of g.options) {
      assert.ok(option.role.y >= option.name.bottom + 2, `${label}: role appears below name`);
      if (service !== "cloud") assert.ok(option.rowGap >= 8, `${label}: name/role spacing`);
      assert.ok(option.rect.height >= 44 && option.border >= 1 && option.radius >= 8, `${label}: selectable card`);
    }
    assert.ok(g.options[1].rect.y - g.options[0].rect.bottom >= 8, `${label}: card spacing`);
    assert.ok(g.cancel.y - g.options[1].rect.bottom >= 12, `${label}: cancel spacing`);
    // Cloud's existing cancel uses the native button size; only the repaired
    // services adopt the 44px target. Cloud remains an unchanged regression case.
    if (service !== "cloud") assert.ok(g.cancel.height >= 44, `${label}: cancel touch target`);
    assert.equal(await page.getByRole("button", { name: "キャンセル", exact: true }).isVisible(), true);
    await page.keyboard.press("Tab");
    const focus = await options.nth(1).evaluate(el => ({ active: el === document.activeElement, width: parseFloat(getComputedStyle(el).outlineWidth), style: getComputedStyle(el).outlineStyle }));
    assert.equal(focus.active, true);
    assert.ok(focus.width >= 2 && focus.style !== "none", `${label}: keyboard focus visible`);
    if (service !== "cloud") {
      await page.keyboard.press("Tab");
      assert.equal(await page.locator(".troom-passkey-account-cancel").evaluate(el => el === document.activeElement && parseFloat(getComputedStyle(el).outlineWidth) >= 2), true, `${label}: cancel keyboard focus`);
    }
    const beforeHover = await options.first().evaluate(el => getComputedStyle(el).backgroundColor);
    await options.first().hover();
    await page.waitForFunction(before => getComputedStyle(document.querySelector(".troom-passkey-account-option")).backgroundColor !== before, beforeHover);
    if (process.env.TROOM_DIALOG_SCREENSHOTS) {
      await mkdir(process.env.TROOM_DIALOG_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(process.env.TROOM_DIALOG_SCREENSHOTS, `${service}-${viewport.width}.png`) });
    }
    await options.nth(1).click();
    await page.waitForFunction(() => window.accountChoice?.id === "member");
    assert.deepEqual(await page.evaluate(() => window.accountChoice), links[1]);
    await openDialog(page, service);
    await page.getByRole("button", { name: "キャンセル", exact: true }).click();
    await page.waitForFunction(() => window.accountChoice === null);
    await openDialog(page, service);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.accountChoice === null);
    assert.equal(await page.locator("dialog").count(), 0);
    assert.deepEqual(await page.evaluate(link => TRoomPasskeys.chooseLinkDialog([link], "diary"), links[0]), links[0]);
    if (service !== "cloud") {
      const longLinks = Array.from({ length: 16 }, (_, i) => ({ ...links[i % 2], id: `long-${i}`, accountDisplayName: `非常に長い名前${"Account".repeat(18)}`, roleLabel: `管理者・全体管理${"Scope".repeat(20)}` }));
      for (const size of [viewport, { width: 390, height: 360 }]) {
        await page.setViewportSize(size);
        await openDialog(page, service, longLinks);
        assertWithinViewport(await geometry(page), size, `${label} long names / height ${size.height}`);
        assert.equal(await page.locator(".troom-passkey-account-list").evaluate(el => el.scrollHeight > el.clientHeight), true);
        await options.last().click();
        await page.waitForFunction(() => window.accountChoice?.id === "long-15");
        await openDialog(page, service, longLinks);
        await page.getByRole("button", { name: "キャンセル", exact: true }).click();
        await page.waitForFunction(() => window.accountChoice === null);
      }
    }
    assert.deepEqual(errors, [], `${label}: no script errors`);
    await context.close();
    console.log(`${label}: PASS`);
  }
  for (const service of services) {
    assert.doesNotMatch(assets.get(`/${service}.css`)[1], /^\s*(?:\+\.|\+\s+[\w-]+\s*:|\+\}|<<<<<<<|=======|>>>>>>>)/m, `${service}: no pasted diff markers`);
  }
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}

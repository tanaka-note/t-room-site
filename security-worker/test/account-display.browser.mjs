import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { accountDisplayName } from "../../assets/account-display.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
function clientFunction(service, name) {
  const text = read(`${service}-worker/public/${service}.js`);
  const match = text.match(new RegExp(`(?:async )?function ${name}\\([^]*?(?=\\n  (?:async )?function )`));
  assert.ok(match, name); return match[0];
}
// Real HTML/CSS and the actual login-success render functions. Data loading is
// stubbed locally; no logins, file operations, containers or paid APIs are run.
const browser = await chromium.launch({ headless: true });
try {
  for (const service of ["diary", "billing"]) {
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== "account-display.test") return route.abort();
      const file = url.pathname.split("/").at(-1) || "index.html";
      if (!/^[a-z0-9.-]+$/.test(file)) return route.abort();
      try {
        let body = read(`${service}-worker/public/${file}`);
        if (file.endsWith(".html")) body = body.replace(/<script\b[^]*?<\/script>/gi, "");
        return route.fulfill({ body, contentType: file.endsWith(".css") ? "text/css" : "text/html" });
      } catch { return route.abort(); }
    });
    await page.goto(`http://account-display.test/${service}/`);
    const name = service === "diary" ? "enterDiary" : "enterApp";
    const setup = service === "diary" ? `
      const state = {};
      const elements = Object.fromEntries(["bootView","loginView","appView","roleLabel","newEntryButton","draftButton","trashButton","investmentSection"].map(key => [key,document.getElementById(key.replace(/[A-Z]/g,c=>"-"+c.toLowerCase()))]));
      const takeDiaryReturnView=()=>null, updateFilterControls=()=>{}, loadHouseholdSwitcher=async()=>{}, loadMeta=async()=>{}, loadEntries=async()=>{}, resetHeaderVisibilityTracking=()=>{};`
      : `const state = {}; const el = Object.fromEntries([...document.querySelectorAll("[id]")].map(node=>[node.id,node]));
      const api=async()=>({accounts:[]}), fillAccountSelects=()=>{}, applyPreferredDocumentType=()=>{}, loadSummary=async()=>{};`;
    await page.addScriptTag({ content: `{${setup}\n${clientFunction(service, name)}\nwindow.renderAccount=${name};}` });
    const cases = service === "diary" ? [
      ["main-admin", "admin", "田中宏知", "global_owner"], ["main-user", "user", "田中宏知", "user"], ["wife-admin", "admin", "田中暢美", "admin"]
    ] : [["owner", "owner", "田中宏知", "owner"], ["masami", "member", "田中暢美", "member"]];
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [accountId, role, accountName, auditRole] of cases) {
        const fallback = service === "diary" ? `${accountName}（${role === "admin" ? "管理者" : "一般ユーザー"}）` : accountName;
        const expected = accountDisplayName({ service, accountId, role: auditRole }, fallback);
        await page.evaluate((session) => window.renderAccount(session), { accountId, role, accountName, accountDisplayName: expected });
        const label = page.locator(service === "diary" ? "#role-label" : "#account-label");
        assert.equal(await label.textContent(), expected);
        if (service === "diary" && width === 390) {
          assert.equal(await label.isVisible(), false, "existing mobile header intentionally hides the account label");
        } else {
          assert.ok(await label.isVisible());
          const box = await label.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `${service}:${width}:${expected}`);
        }
      }
    }
    await page.close(); console.log(`${service}: owner/user/other account rendering passed at 1280px and 390px`);
  }
} finally { await browser.close(); }

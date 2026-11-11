import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { fixture, provision } from "./fixture.mjs";

const provisioned = await provision(),
  f = await fixture(provisioned);
const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const wire = [],
  httpPaths = [];
let active = true;
const session = {
  authenticated: true,
  role: "admin",
  accountName: "Synthetic owner",
  householdId: "A",
  activeHouseholdId: "A",
  isGlobalOwner: false,
  canManageEntries: true,
  canViewTrash: true,
  canPermanentlyDelete: true,
  canViewInvestment: false,
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  httpPaths.push(url.pathname + url.search);
  const json = (body, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname.startsWith("/__encrypted/")) {
      if (!active) return json({ error: "SessionExpired" }, 401);
      if (url.pathname.endsWith("/valid")) return json({ valid: active });
      if (url.pathname.endsWith("/time"))
        return json({ timestamp: new Date().toISOString() });
      if (url.pathname.endsWith("/snapshot"))
        return json(
          await f.store.snapshotPage(
            f.actors.ownerA,
            url.searchParams.get("household"),
            {
              since: Number(url.searchParams.get("since")),
              after: url.searchParams.get("after"),
              at: url.searchParams.has("at")
                ? Number(url.searchParams.get("at"))
                : null,
            },
          ),
        );
      if (
        req.method !== "POST" ||
        req.headers.origin !== `http://${req.headers.host}`
      )
        return json({ error: "InvalidOrigin" }, 403);
      let bytes = 0,
        chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2_000_000) throw new Error("RequestLimit");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks));
      wire.push(body);
      if (url.pathname.endsWith("/mutation"))
        return json(
          await f.store.mutation(
            f.actors.ownerA,
            body.proposal,
            body.operation,
          ),
        );
      if (url.pathname.endsWith("/remove"))
        return json(await f.store.remove(f.actors.ownerA, body));
      return json({ error: "UnknownRoute" }, 404);
    }
    // Any accidental plaintext HTTP API access fails this test.
    if (url.pathname.startsWith("/diary/api/"))
      return json({ error: "PlaintextApiForbidden" }, 500);
    let relative;
    if (url.pathname.startsWith("/diary/"))
      relative =
        "diary-worker/public/" +
        (url.pathname.endsWith("/") ? "index.html" : url.pathname.slice(7));
    else if (url.pathname.startsWith("/assets/"))
      relative = url.pathname.slice(1);
    else if (
      [
        "/diary-worker/e2ee/",
        "/diary-worker/public/",
        "/diary-worker/tests/e2ee/",
      ].some((p) => url.pathname.startsWith(p)) ||
      url.pathname === "/diary-worker/src/entry-domain.js"
    )
      relative = url.pathname.slice(1);
    else return res.writeHead(404).end();
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep)) throw new Error("InvalidPath");
    let body = await readFile(file);
    if (file.endsWith("/public/index.html"))
      body = Buffer.from(
        body.toString().replace(/<script[\s\S]*?<\/script>/g, "") +
          '<script type="module" src="/diary-worker/tests/e2ee/browser-bootstrap.mjs"></script>',
      );
    res.writeHead(200, {
      "Content-Type":
        {
          ".mjs": "text/javascript",
          ".js": "text/javascript",
          ".html": "text/html",
          ".css": "text/css",
          ".png": "image/png",
          ".svg": "image/svg+xml",
        }[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (error) {
    json(
      { error: error.status ? error.message : "FixtureFailure" },
      error.status || 500,
    );
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath =
  process.env.TROOM_CHROMIUM_EXECUTABLE ||
  [chromium.executablePath(), "/usr/bin/chromium"].find(existsSync);
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addInitScript(
    ({ profile, anchor, prf, session }) => {
      window.syntheticEncryptionFixture = { profile, anchor, prf, session };
    },
    {
      profile: provisioned.profiles.ownerA,
      anchor: provisioned.anchor,
      prf: [...provisioned.secrets.ownerA.prf],
      session,
    },
  );
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error("Fixture page error:", e.message);
  });
  page.on("response", (response) => {
    if (
      response.status() >= 400 &&
      !(
        response.status() === 401 &&
        new URL(response.url()).pathname === "/__encrypted/valid"
      )
    )
      console.error(
        "Fixture HTTP error:",
        response.status(),
        new URL(response.url()).pathname,
      );
  });
  await page.goto(origin + "/diary/");
  await page.waitForFunction(() => window.encryptionFixtureReady === true);
  await page.click("#new-entry-button");
  await page.fill("#entry-title", "BROWSER_CANARY_TITLE");
  await page.locator("#entry-content").fill("BROWSER_CANARY_BODY 公園 お弁当");
  await page.click("#save-entry-button");
  await page.waitForFunction(() =>
    document
      .querySelector("#entry-list")
      ?.textContent.includes("BROWSER_CANARY_TITLE"),
  );
  await page.locator("#entry-list [data-entry-id]").first().click();
  await page.waitForSelector("#entry-dialog[open]");
  assert.match(
    await page.locator("#detail-content").innerText(),
    /BROWSER_CANARY_BODY/,
  );
  await page.click("#favorite-entry-button");
  await page.waitForSelector('#favorite-entry-button[aria-pressed="true"]');
  await page.click('[data-close-dialog="entry-dialog"]');
  await page.click("#favorites-link");
  await page.waitForSelector('#favorites-link[aria-current="page"]');
  await page.waitForFunction(() => window.encryptionFixtureReady === true);
  assert.match(
    await page.locator("#entry-list").innerText(),
    /BROWSER_CANARY_TITLE/,
  );
  const cache = await page.evaluate(async () => {
    const { openCipherCache } = await import("/diary-worker/e2ee/cache.mjs");
    const cache = await openCipherCache("synthetic-only");
    const snapshot = await window.encryptedClient.transport.snapshot("A", -1);
    await cache.put("A", snapshot);
    const value = await cache.get("A");
    let rejected = false;
    try {
      await cache.put("bad", {
        ...snapshot,
        records: [
          { ...snapshot.records[0], secret: { title: "BROWSER_CANARY_TITLE" } },
        ],
      });
    } catch {
      rejected = true;
    }
    cache.close();
    return { serialized: JSON.stringify(value), rejected };
  });
  assert.equal(cache.rejected, true);
  assert.equal(cache.serialized.includes("BROWSER_CANARY"), false);
  const dump = JSON.stringify(
    f.db.sqlite.prepare("SELECT * FROM diary_e2ee_records").all(),
  );
  assert.equal((dump + JSON.stringify(wire)).includes("BROWSER_CANARY"), false);
  assert.equal(
    httpPaths.some((p) => p.startsWith("/diary/api/")),
    false,
  );
  let performanceResult = null;
  if (process.argv.includes("--performance")) {
    const { seedPerformanceData, measurePerformance } = await import(
      "./performance.mjs"
    );
    const scale = await seedPerformanceData(f);
    performanceResult = { ...scale, ...(await measurePerformance(page)) };
    await mkdir(resolve(root, "tmp/diary-e2ee"), { recursive: true });
    await writeFile(
      resolve(root, "tmp/diary-e2ee/performance.json"),
      JSON.stringify(performanceResult, null, 2),
    );
  }
  // Fail closed on session revocation, with no plaintext retained by the core.
  active = false;
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.encryptedClient.sync();
        return false;
      } catch {
        return (
          window.encryptedClient.closed &&
          window.encryptedClient.records.size === 0 &&
          window.encryptedClient.keys.size === 0
        );
      }
    }),
    true,
  );
  assert.deepEqual(errors, []);
  await mkdir(resolve(root, "tmp/diary-e2ee"), { recursive: true });
  const result = {
    checks: [
      "current UI create/detail/favorite",
      "ciphertext HTTP/SQLite/IndexedDB",
      "nested plaintext cache rejection",
      "session revocation",
    ],
    httpRequests: httpPaths.length,
    productionRequests: 0,
    realWebAuthn: false,
    ...(performanceResult ? { performance: performanceResult } : {}),
  };
  await writeFile(
    resolve(root, "tmp/diary-e2ee/browser.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  f.close();
}

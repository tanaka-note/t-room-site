import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, startUIFixture, engines } from "./ui-fixture.mjs";

const fixture = await startUIFixture(undefined, { handleRequest(req, res) {
  if (new URL(req.url, "http://localhost").pathname !== "/security/passkey-client.js") return false;
  res.setHeader("Content-Type", "text/javascript");
  res.end(readFileSync(new URL("../../security-worker/public/passkey-client.js", import.meta.url)));
  return true;
} });
const browser = await chromium.launch({ headless: true, ...engines.find(([name]) => name === "chromium")[2] });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {});
    const page = await context.newPage();
    await page.goto(fixture.origin + "/cloud/");
    await page.waitForFunction(() => globalThis.__test && globalThis.TRoomPasskeys);
    await page.evaluate(() => {
      globalThis.__members = [
        { id: "one", accountId: "folder-member", role: "member", rootFolderId: 7 },
        { id: "two", accountId: "folder-member", role: "member", rootFolderId: 9 }
      ];
      globalThis.__links = [{ id: "admin", accountId: "admin", role: "admin", rootFolderId: null }, ...__members];
    });
    const ordinary = await page.evaluate(() => __test.choosePasskeyLink(__members));
    assert.equal(ordinary.id, "cloud-member");
    assert.equal(await page.locator(".troom-passkey-account-dialog").count(), 0);
    const open = () => page.evaluate(() => { globalThis.__choice = __test.choosePasskeyLink(__links); });
    await open();
    assert.deepEqual(await page.locator(".troom-passkey-account-option strong").allTextContents(), ["管理者として利用", "通常利用"]);
    await page.getByRole("button", { name: "通常利用" }).click();
    assert.equal((await page.evaluate(() => __choice)).id, "cloud-member");
    assert.equal(await page.evaluate(() => Boolean(history.state?.tcloudLoginMode)), false);
    await open();
    await page.getByRole("button", { name: "管理者として利用" }).click();
    assert.equal((await page.evaluate(() => __choice)).id, "admin");
    await open();
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => __choice), null);
    await open();
    await page.goBack();
    assert.equal(await page.evaluate(() => __choice), null);
    await open();
    if (mobile) await page.touchscreen.tap(5, 5); else await page.mouse.click(5, 5);
    assert.equal(await page.evaluate(() => __choice), null);
    assert.equal(await page.locator(".troom-passkey-account-dialog").count(), 0);

    const result = await page.evaluate(async () => {
      const prf = crypto.getRandomValues(new Uint8Array(32));
      const vault = await TRoomCrypto.createPasskeyClientVault(prf);
      const originals = await Promise.all([7, 9].map(() => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])));
      const folderScopes = [{ serviceLinkId: "one", rootFolderId: 7 }, { serviceLinkId: "two", rootFolderId: 9 }];
      const folder_keys_rsa = await Promise.all(folderScopes.map(async (scope, index) => ({ ...scope, wrappedKey: await TRoomCrypto.wrapFolderKeyForIdentity(originals[index], vault.publicKeyJwk) })));
      // Keep real PRF/HKDF, RSA-OAEP and AES key operations; replace only the API.
      globalThis.api = async () => ({ initialized: true, publicKeyJwk: vault.publicKeyJwk });
      globalThis.syncAvailableActions = () => {};
      __test.state.session = { role: "member", authMethod: "passkey", serviceAccountId: "folder-member", serviceLinkId: "one", rootFolderId: 7, sessionCacheId: "fixture-session", folderScopes };
      __test.state.crypto = { folderKeys: new Map(), adminPrivateKey: null };
      await __test.prepareCryptoSession("", null, { prfOutput: prf, tcloudKey: { client_private_prf: vault, folder_keys_rsa } });
      const witness = new TextEncoder().encode("local key proof");
      const decoded = [];
      for (const [index, scope] of folderScopes.entries()) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, originals[index], witness);
        decoded.push(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, __test.state.crypto.folderKeys.get(scope.rootFolderId), cipher)));
      }
      const namespaces = folderScopes.map(scope => __test.offlineAccountScope(scope.rootFolderId));
      const cache = __test.memberCacheScope();
      const resume = __test.resumePasskeyLink(__links, __test.state.session).id;
      __test.state.session.folderScopes = [folderScopes[0]];
      const isolated = cache !== __test.memberCacheScope();
      __test.state.session.folderScopes = folderScopes;
      __test.state.breadcrumbs = [{ id: 9, isProtected: false }];
      return { decoded, namespaces, isolated, resume, adminKey: __test.state.crypto.adminPrivateKey,
        moveRoot: __test.unlockedMoveScopeRoot().id, canMoveRoot: __test.canMoveFolder({ id: 9 }) };
    });
    assert.deepEqual(result.decoded, ["local key proof", "local key proof"]);
    assert.deepEqual(result.namespaces, ["member:one:7", "member:two:9"]);
    assert.equal(result.adminKey, null);
    assert.equal(result.isolated, true);
    assert.equal(result.resume, "cloud-member");
    assert.equal(result.moveRoot, 9);
    assert.equal(result.canMoveRoot, false);
    await context.close();
  }
  console.log("PASS ordinary auto-selection, two owner modes, PC/touch/Esc/back cancellation, real multi-root PRF/RSA unlock, preserved offline namespaces and root move policy");
} finally { await browser.close(); await fixture.close(); }

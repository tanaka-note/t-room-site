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
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(fixture.origin + "/cloud/");
    await page.waitForFunction(() => globalThis.__test && globalThis.TRoomPasskeys);
    // Run the real startup and event binding with the removed PW fields absent.
    // Only server/WebAuthn responses are replaced with local fixture responses.
    await page.evaluate(async () => {
      globalThis.api = async path => {
        if (path === "/session") return { authenticated: false };
        throw new Error(`Unexpected login fixture API: ${path}`);
      };
      globalThis.__passkeyCalls = 0;
      globalThis.__passkeyError = new Error("認証をキャンセルしました。");
      globalThis.TRoomPasskeys = { ...TRoomPasskeys, authenticate: async service => {
        if (service !== "cloud") throw new Error("Unexpected service");
        __passkeyCalls += 1;
        throw __passkeyError;
      } };
      await __test.initialize();
    });
    await page.locator("#login-view").waitFor({ state: "visible" });
    assert.equal(await page.locator("#login-id, #login-password, #remember-login, #login-form").count(), 0);
    assert.equal(await page.locator("#login-view button").count(), 1);
    await page.getByRole("button", { name: "パスキーでログイン", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#login-error").textContent.includes("キャンセル"));
    assert.equal(await page.evaluate(() => __passkeyCalls), 1);
    assert.equal(await page.locator("#passkey-login").isEnabled(), true);
    for (const kind of ["options", "unsupported"]) {
      await page.evaluate(kind => {
        __passkeyError = kind === "options" ? new TRoomPasskeys.PasskeyOptionsError()
          : new Error("このブラウザは端末のロック解除ログインに対応していません。ID・パスワードでログインしてください。");
      }, kind);
      await page.getByRole("button", { name: "パスキーでログイン", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector("#passkey-login").disabled);
      const message = await page.locator("#login-error").textContent();
      assert.match(message, kind === "options" ? /再読み込み/ : /対応するブラウザ/);
      assert.doesNotMatch(message, /ID・パスワード/);
    }

    await page.evaluate(() => {
      globalThis.__passkeyCalls = 0;
      globalThis.__keyStatusChecks = 0;
      globalThis.__fixturePrf = crypto.getRandomValues(new Uint8Array(32));
      globalThis.TRoomPasskeys = { ...TRoomPasskeys,
        authenticate: async (service, choose, options) => {
          if (service !== "cloud" || options.prepareCloudKeys !== true) throw new Error("Unexpected login flow");
          __passkeyCalls++;
          return { credentialId: "fixture", prfOutput: __fixturePrf, verified: { links: [] } };
        },
        api: async (path, body) => {
          if (path !== "/tcloud/key-preparation" || body.credentialId !== "fixture" || body.action !== "status") throw new Error("Unexpected preparation request");
          __keyStatusChecks++;
          return { links: [], hasMember: true, memberVault: {}, recipients: { admin: [], folders: [] } };
        }
      };
    });
    await page.getByRole("button", { name: "パスキーでログイン", exact: true }).click();
    const checkKeys = page.getByRole("button", { name: "鍵の受け取りを確認", exact: true });
    await checkKeys.waitFor();
    await page.locator("#login-passkey-status").waitFor();
    assert.match(await page.locator("#login-passkey-status").textContent(), /ログイン済み.*管理者/);
    await checkKeys.click();
    await page.waitForFunction(() => !document.querySelector("#passkey-login").disabled);
    assert.deepEqual(await page.evaluate(() => [__passkeyCalls, __keyStatusChecks, __fixturePrf.every(value => value === 0)]), [1, 2, true]);
    assert.deepEqual(errors, [], "startup/button binding must not reference deleted PW elements");
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

    const deliveryPage = await context.newPage();
    deliveryPage.on("pageerror", error => errors.push(error.message));
    const warnings = [];
    deliveryPage.on("console", message => {
      if (message.type() === "warning" && message.text().startsWith("T-Cloud key delivery")) warnings.push(message.text());
    });
    await deliveryPage.goto(fixture.origin + "/cloud/");
    await deliveryPage.waitForFunction(() => globalThis.__test && globalThis.TRoomPasskeys);
    await deliveryPage.evaluate(async () => {
      prepareCryptoSession = async () => {};
      navigateToFolder = async () => ({ ok: true });
      scheduleUsageLoad = () => {};
      scheduleLegacyFolderMigration = () => {};
      const adminLink = { id: "admin", accountId: "admin", role: "admin" };
      globalThis.__deliveryAttempt = 0;
      globalThis.__grants = [];
      globalThis.__authentications = 0;
      globalThis.api = async path => {
        if (path === "/session") return { authenticated: false };
        if (path === "/passkey/handoff") return { role: "admin", authMethod: "passkey", accountName: "Fixture", loginId: "fixture",
          serviceAccountId: "admin", serviceLinkId: "admin", sessionCacheId: "fixture-admin",
          expiresAt: Math.floor(Date.now() / 1000) + 3600 };
        throw new Error(`Unexpected Cloud request: ${path}`);
      };
      const recipient = credentialId => ({ credentialId, publicKey: "{}", recipientFingerprint: "fixture" });
      const folder = credentialId => ({ ...recipient(credentialId), folder: {}, linkId: "link" });
      const handedOff = new Set();
      globalThis.TRoomCrypto = { ...TRoomCrypto,
        cloudPasskeyPreparation: async () => ({ sendAdminKey: async () => ({}), unlockAdminVault: async () => ({}) }),
        unlockFolderAsAdmin: async () => ({}), wrapFolderKeyForIdentity: async () => "wrapped-fixture"
      };
      globalThis.TRoomPasskeys = { ...TRoomPasskeys,
        authenticate: async () => {
          __authentications++;
          return { credentialId: "sender", prfOutput: new Uint8Array(32), verified: { links: [adminLink] } };
        },
        api: async (path, body) => {
          if (path === "/auth/handoff") return { handoffToken: "fixture" };
          if (path !== "/tcloud/key-preparation" || body.credentialId !== "sender") throw new Error("Unexpected key request");
          if (body.action === "status") return { links: [adminLink], adminEnvelope: {}, canSend: __deliveryAttempt !== 2,
            recipients: { admin: [recipient("forbidden"), recipient("conflict")].filter(x => !handedOff.has(x.credentialId)),
              folders: [folder("lost-response"), folder("success")].filter(x => !handedOff.has(x.credentialId)),
              unavailableFolders: __deliveryAttempt === 1 ? 1 : 0 } };
          const target = body.targetCredentialId;
          __grants.push(target);
          if (__deliveryAttempt === 0 && (target === "forbidden" || target === "conflict")) {
            throw Object.assign(new Error("synthetic-sensitive-error"), { status: target === "forbidden" ? 403 : 409 });
          }
          handedOff.add(target);
          if (target === "lost-response") throw new TypeError("synthetic-sensitive-error");
          return { ok: true };
        }
      };
      await __test.initialize();
    });
    await deliveryPage.locator("#passkey-login").click();
    const notice = deliveryPage.locator("#key-delivery-notice");
    const deliveryStatus = deliveryPage.locator("#key-delivery-status");
    const retry = deliveryPage.getByRole("button", { name: "鍵の引き渡しを再試行" });
    await notice.waitFor({ state: "visible" });
    assert.match(await deliveryStatus.textContent(), /3件/);
    assert.equal(await deliveryPage.locator("#app-view").isVisible(), true);
    assert.equal(warnings.length, 3);
    assert.doesNotMatch(warnings.join("\n"), /synthetic-sensitive-error|lost-response|forbidden|conflict/);
    await deliveryPage.evaluate(attempt => { __deliveryAttempt = attempt; }, mobile ? 2 : 1);
    await retry.click();
    if (mobile) {
      await retry.waitFor({ state: "hidden" });
      assert.match(await deliveryStatus.textContent(), /3件.*再ログイン/);
    } else {
      await notice.getByText(/1件/).waitFor();
      await deliveryPage.evaluate(() => { __deliveryAttempt = 3; });
      await retry.click();
      await notice.waitFor({ state: "hidden" });
      assert.match(await deliveryPage.locator("#notice").textContent(), /引き渡しを確認/);
    }
    assert.deepEqual(await deliveryPage.evaluate(() => __grants), ["forbidden", "conflict", "lost-response", "success",
      ...(!mobile ? ["forbidden", "conflict"] : [])]);
    assert.equal(await deliveryPage.evaluate(() => __authentications), 1);
    await deliveryPage.evaluate(() => __test.releaseSessionState());
    assert.equal(await notice.isVisible(), false);
    assert.equal(await deliveryStatus.textContent(), "");
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS owner modes, PC/touch cancellation, multi-root PRF/RSA unlock, and administrator key delivery failure, retry and reauthentication");
} finally { await browser.close(); await fixture.close(); }

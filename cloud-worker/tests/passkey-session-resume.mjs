import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [source, runtime] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud-runtime-20260816-1.js", import.meta.url), "utf8")
]);

assert.equal(runtime, source, "公開用とruntime用のCloudクライアントが一致していません。");
assert.equal((source.match(/requirePasskeyPrf\(authentication\);/g) || []).length, 2,
  "初回ログインとsession再開が同じPRF判定を利用していません。");

async function resumePasskeySession(accountId, prfOutput = null, returnedAccountId = accountId, chooseFromMultiple = false) {
  const calls = { handoff: 0, logout: 0, enterApp: [], errors: [] };
  const role = accountId === "folder-member" ? "member" : accountId;
  const rootFolderId = role === "member" ? 7 : null;
  const session = { authenticated: true, authMethod: "passkey", role, serviceAccountId: accountId, serviceLinkId: `cloud-${accountId}`, rootFolderId };
  const context = {
    console,
    URL,
    URLSearchParams,
    AbortController,
    Blob,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    document: { addEventListener() {} },
    navigator: {},
    location: { href: "https://example.test/cloud/" },
    history: {},
    window: { setInterval() { return 0; } },
    TCloudOffline: { async cleanupExpired() {} },
    TRoomPasskeys: {
      async authenticate(_service, chooseLink) {
        const link = { id: `cloud-${returnedAccountId}`, accountId: returnedAccountId, role: returnedAccountId === "folder-member" ? "member" : returnedAccountId, rootFolderId: returnedAccountId === "folder-member" ? 7 : null };
        const selected = chooseFromMultiple ? await chooseLink([
          { id: "cloud-admin", accountId: "admin", role: "admin", rootFolderId: null }, link
        ]) : link;
        return {
          link: selected,
          prfOutput,
          handoff: { handoffToken: `handoff-${accountId}`, tcloudKey: {} }
        };
      }
    },
    __api: async (path) => {
      if (path === "/session") return session;
      if (path === "/passkey/handoff") {
        calls.handoff += 1;
        return session;
      }
      if (path === "/logout") {
        calls.logout += 1;
        return { ok: true };
      }
      throw new Error(`想定外のAPI呼び出し: ${path}`);
    },
    __enterApp: async (session, _password, _accountKey, passkeyContext) => {
      calls.enterApp.push({ session, passkeyContext });
    },
    __showLoginError: (message) => calls.errors.push(message)
  };
  context.globalThis = context;
  vm.runInNewContext(`${source}\n
    bindEvents = () => {};
    restoreInstalledAppPortrait = async () => {};
    updateInstallButtons = () => {};
    restoreRememberedLogin = async () => {};
    reportCompletedAppUpdate = () => {};
    showLoginView = () => {};
    showLoginError = globalThis.__showLoginError;
    enterApp = globalThis.__enterApp;
    api = globalThis.__api;
    globalThis.__initialize = initialize;
    globalThis.__state = state;
  `, vm.createContext(context), { filename: "cloud.js" });

  await context.__initialize();
  return { calls, state: context.__state };
}

const subadmin = await resumePasskeySession("subadmin");
assert.equal(subadmin.calls.handoff, 0, "旧副管理者パスキーsessionは再開しない");
assert.equal(subadmin.calls.logout, 1);
assert.equal(subadmin.calls.enterApp.length, 0);

for (const accountId of ["admin", "folder-member"]) {
  const rejected = await resumePasskeySession(accountId);
  assert.equal(rejected.calls.handoff, 0, `PRFなし${accountId}でhandoffが発行されました。`);
  assert.equal(rejected.calls.enterApp.length, 0, `PRFなし${accountId}でCloud sessionが開始されました。`);
  assert.equal(rejected.calls.logout, 1, `PRFなし${accountId}の既存sessionがlogoutされていません。`);
  assert.equal(rejected.state.session, null, `PRFなし${accountId}のsession状態が残っています。`);
  assert.match(rejected.calls.errors.at(-1) || "", /ID・パスワードでログインしてください/);
}

for (const accountId of ["admin", "folder-member"]) {
  const resumed = await resumePasskeySession(accountId, new Uint8Array(32));
  assert.equal(resumed.calls.handoff, 1);
  assert.equal(resumed.calls.enterApp[0].session.serviceAccountId, accountId);
  assert.equal(resumed.calls.enterApp[0].session.rootFolderId, accountId === "folder-member" ? 7 : null);
}
const promoted = await resumePasskeySession("folder-member", new Uint8Array(32), "admin");
assert.equal(promoted.calls.handoff, 0, "再読込時に唯一の候補がadminになっても昇格しない");
assert.equal(promoted.calls.enterApp.length, 0);
const multiple = await resumePasskeySession("folder-member", new Uint8Array(32), "folder-member", true);
assert.equal(multiple.calls.handoff, 1, "複数候補では既存member linkだけを選ぶ");
assert.equal(multiple.calls.enterApp[0].session.role, "member");

process.stdout.write("Cloud passkey session resume PRF role boundary passed.\n");

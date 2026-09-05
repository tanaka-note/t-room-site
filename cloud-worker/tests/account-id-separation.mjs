import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [worker, client, cryptoClient, example] = await Promise.all([
  readFile(new URL("../src/index.js", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/crypto-vault.js", import.meta.url), "utf8"),
  readFile(new URL("../.dev.vars.example", import.meta.url), "utf8")
]);

assert.match(worker, /env\.ADMIN_LOGIN_ID/, "管理者専用ログインID設定がありません。");
assert.match(worker, /env\.SUBADMIN_LOGIN_ID/, "副管理者専用ログインID設定がありません。");
assert.match(worker, /env\.ACCOUNT_KDF_ID \|\| env\.LOGIN_ID/, "既存暗号鍵との互換用識別子がありません。");
assert.match(worker, /matchingAccounts = configuredAccounts\.filter/, "入力IDに一致する権限だけを認証していません。");
assert.match(worker, /credentialSalt: await accountCredentialSalt\(env\)/, "認証用ソルトをクライアントへ安全に引き継いでいません。");
assert.match(client, /deriveAccountCredentials\(password, loginId, mode\.credentialSalt\)/, "ログインIDと暗号鍵識別子が分離されていません。");
assert.match(client, /deriveAccountKey\([^\n]+state\.credentialSalt\)/, "暗号鍵解除時に互換用ソルトを使用していません。");
assert.match(cryptoClient, /deriveAccountCredentials\(password, loginId, credentialSalt = ""\)/, "明示的な認証用ソルトに対応していません。");
assert.match(example, /ADMIN_LOGIN_ID=/);
assert.match(example, /SUBADMIN_LOGIN_ID=/);
assert.match(example, /ACCOUNT_KDF_ID=/);

const labels = new Map();
const state = { session: null, unlockedTopFolderNames: new Map() };
const context = vm.createContext({ state, $: (selector) => {
  if (!labels.has(selector)) labels.set(selector, {});
  return labels.get(selector);
} });
const start = client.indexOf("function syncAccountIdentity()");
vm.runInContext(client.slice(start, client.indexOf("\n}", start) + 2), context);
for (const [session, expected] of [
  [{ role: "admin" }, "管理者"],
  [{ role: "member", accountName: "Atsushi" }, "Atsushi"],
  [{ role: "member", accountName: "一般利用者のフォルダー" }, "一般利用者のフォルダー"],
  [{ role: "subadmin" }, "未ログイン"]
]) {
  state.session = session;
  vm.runInContext("syncAccountIdentity()", context);
  for (const selector of ["#account-name", "#mobile-account-name"]) assert.equal(labels.get(selector).textContent, expected);
}
state.unlockedTopFolderNames.set(9, "PW解除済みのフォルダー");
vm.runInContext("syncAccountIdentity()", context);
assert.equal(labels.get("#account-name").textContent, "PW解除済みのフォルダー");
console.log("account login ID separation and member labels: ok");

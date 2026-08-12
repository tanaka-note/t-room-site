import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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

console.log("account login ID separation: ok");

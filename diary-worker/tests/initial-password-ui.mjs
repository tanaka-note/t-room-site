import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(`${root}/public/index.html`, "utf8");
const script = readFileSync(`${root}/public/diary.js`, "utf8");

assert.match(html, /id="initial-password-dialog"/);
assert.match(html, /id="initial-password-cancel"/);
assert.match(html, /ログイン画面へ戻る/);
assert.match(html, /初回設定後は、登録したパスワードを確認し、安全な場所に保管してください。/);
assert.match(html, /パスワードを紛失するとログインできません。/);
assert.match(html, /T-ROOM管理者へ再発行をご依頼ください。/);
assert.match(html, /minlength="6"/);
assert.match(html, /パスワードは6文字以上で設定してください。/);
assert.match(html, /data-password-toggle="initial-password"/);
assert.match(html, /data-password-toggle="initial-password-confirmation"/);
assert.match(script, /if \(result\.mustChangePassword\)/);
assert.match(script, /elements\.initialPasswordDialog\.showModal\(\)/);
assert.match(script, /elements\.initialPasswordDialog\.addEventListener\("cancel"/);
assert.match(script, /async function leaveInitialPasswordSetup\(\)/);
assert.match(script, /await api\("\/logout", \{ method: "POST" \}\)/);
assert.match(script, /elements\.investmentSection\.hidden = !state\.canViewInvestment/);

process.stdout.write("Diary initial password UI contract test passed.\n");

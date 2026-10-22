import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(`${root}/public/index.html`, "utf8");
const script = readFileSync(`${root}/public/cloud.js`, "utf8");

assert.match(html, /id="boot-view"[^>]*aria-busy="true"/);
assert.match(html, /id="login-view"[^>]*hidden/);
assert.match(html, /id="app-view"[^>]*hidden/);
assert.match(script, /if \(session\.authenticated && session\.authMethod === "passkey"\)[\s\S]*?await enterApp\(session,[\s\S]*?else \{\s*showLoginView\(\)/);
assert.match(script, /async function enterApp[\s\S]*?\$\("#boot-view"\)\.hidden = true/);
assert.match(script, /function showLoginView\(\) \{[\s\S]*?\$\("#boot-view"\)\.hidden = true;[\s\S]*?\$\("#login-view"\)\.hidden = false;[\s\S]*?\$\("#app-view"\)\.hidden = true/);
const enterApp = script.match(/async function enterApp\(session, password = "", accountKey = null, passkeyContext = null\) \{[\s\S]*?\n\}/)?.[0] || "";
assert.ok(enterApp.indexOf("await prepareCryptoSession(password, accountKey, passkeyContext)") < enterApp.indexOf('$("#app-view").hidden = false'), "暗号鍵準備後に本体を表示します");
const visible = enterApp.indexOf('$("#app-view").hidden = false');
const load = enterApp.indexOf('await navigateToFolder(restoredNavigation.folderId');
assert.ok(visible >= 0 && load > visible, "鍵準備後は本体を表示し、初回も検証済み一覧と位置を一括確定します");
assert.match(enterApp, /restoreEntry: restoredNavigation/);
assert.doesNotMatch(enterApp, /await loadItems\(\)/, "初回起動が一括確定バリアを迂回しません");

process.stdout.write("T-Cloud authenticated startup view contract test passed.\n");

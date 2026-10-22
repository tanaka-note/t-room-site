import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(`${root}/public/index.html`, "utf8");
const bootstrap = readFileSync(`${root}/public/diary-bootstrap.js`, "utf8");
const script = readFileSync(`${root}/public/diary.js`, "utf8");

assert.match(html, /id="boot-view"[^>]*aria-busy="true"/);
assert.match(html, /id="login-view"[^>]*hidden/);
assert.match(html, /id="app-view"[^>]*hidden/);
assert.match(bootstrap, /const session = await api\("\/session"\);[\s\S]*?if \(session\.authenticated\)/);
assert.match(script, /async function enterDiary[\s\S]*?elements\.bootView\.hidden = true;[\s\S]*?elements\.loginView\.hidden = true;[\s\S]*?elements\.appView\.hidden = false/);
assert.match(bootstrap, /function showLogin[\s\S]*?bootView\.hidden = true;[\s\S]*?loginView\.hidden = false/);
const enterDiary = script.match(/async function enterDiary\(session\) \{[\s\S]*?\n  \}/)?.[0] || "";
assert.ok(enterDiary.indexOf("elements.appView.hidden = false") < enterDiary.indexOf("await loadEntries(true, true,"), "認可適用後の画面枠を先に表示します");
assert.doesNotMatch(script, /navigator\.serviceWorker\.register/, "Service Worker登録は共通Updaterへ集約します");
assert.match(script, /function restoreDiaryReturnPosition[\s\S]*?restoreEntryListPosition\(returnView\.position\)[\s\S]*?restoreTagListPosition\(returnView\.tagListPosition\)/, "描画後に一覧と内部スクロール領域の戻り位置を反映します");

process.stdout.write("Diary authenticated startup view contract test passed.\n");

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("認証確認中はログイン画面を見せず、初期データ後に本体を表示する", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.js", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="boot-view"[^>]*aria-busy="true"/);
  assert.match(html, /id="login-view"[^>]*hidden/);
  assert.match(html, /id="app-view"[^>]*hidden/);
  assert.match(script, /if \(session\.authenticated\) await enterApp\(session\);\s*else showLogin\(\)/);
  const enterApp = script.match(/async function enterApp\(session\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.ok(enterApp.indexOf("await loadSummary()") < enterApp.indexOf('el["app-view"].hidden = false'), "月次データ取得前に空の本体を表示しません");
  assert.match(script, /function showLogin\(\) \{\s*el\["boot-view"\]\.hidden = true;/);
});

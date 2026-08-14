import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("billing login supports Enter submission without event.submitter", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.js", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="login-submit"[^>]*type="submit"/);
  assert.match(script, /event\.submitter\s*\|\|\s*el\["login-submit"\]/);
  assert.match(script, /submit\.textContent = "確認中…"/);
  assert.match(script, /canonicalLoginId\(el\["login-id"\]\.value\)/);
  assert.match(script, /const CURRENT_OWNER_LOGIN_ID = "contact@a-tanaka\.jp"/);
  assert.match(script, /const LEGACY_OWNER_LOGIN_ID = "sub@a-tanaka\.jp"/);
  assert.match(script, /normalized === LEGACY_OWNER_LOGIN_ID \? CURRENT_OWNER_LOGIN_ID : normalized/);
  assert.match(script, /localStorage\.setItem\(SAVED_LOGIN_ID_KEY, savedLoginId\)/);
  assert.match(script, /await enterApp\(session\);[\s\S]*?saveLoginPreference\(loginId, password\)\.catch/);
  assert.match(script, /submit\.textContent = submitLabel/);
  assert.match(script, /submit\.removeAttribute\("aria-busy"\)/);
});

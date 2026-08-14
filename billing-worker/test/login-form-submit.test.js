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
  assert.match(script, /el\["login-id"\]\.value\.trim\(\)/);
  assert.match(script, /submit\.removeAttribute\("aria-busy"\)/);
});

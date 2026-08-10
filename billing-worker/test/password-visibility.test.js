import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("login password visibility control uses a right-side eye icon", async () => {
  const [html, client, css] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.js", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.css", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="password-toggle"[^>]*aria-controls="login-password"/);
  assert.match(html, /password-eye-open/);
  assert.match(html, /password-eye-closed/);
  assert.match(client, /type === "text"/);
  assert.match(client, /aria-pressed/);
  assert.match(css, /\.password-toggle\[aria-pressed="true"\] \.password-eye-closed/);
});

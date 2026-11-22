import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("billing login offers the common passkey action without a setup link", async () => {
  const [html, client, css] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.js", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.css", import.meta.url), "utf8")
  ]);
  assert.match(html, /パスキーを使ってログインしてください。/);
  assert.match(html, /id="passkey-login" class="button primary full(?: [^"]*)?"/);
  assert.match(html, /class="passkey-icon"[\s\S]*aria-hidden="true"/);
  const login = html.match(/<section id="login-view"[^>]*>[\s\S]*?<\/section>/)?.[0];
  assert.ok(login, "regular billing login section is present");
  assert.doesNotMatch(login, /<a\b/i, "regular billing login has no setup link");
  assert.doesNotMatch(html, /id="login-(?:form|id|password|submit)"|password-toggle|remember-login|auth-divider|password-login-audit\.js/);
  assert.doesNotMatch(client, /login-password|login-id|login-form|PasswordCredential|saveLoginPreference|restoreLoginPreference|togglePassword|TRoomPasswordLoginAudit/);
  assert.doesNotMatch(css, /password-field|password-eye|password-toggle|remember-login|auth-divider|icon-button|form-stack/);
});

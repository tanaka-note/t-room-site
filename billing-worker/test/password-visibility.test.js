import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("billing login offers only a primary passkey action and Security Center preparation", async () => {
  const [html, client, css] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.js", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.css", import.meta.url), "utf8")
  ]);
  assert.match(html, /登録済みのパスキーでログインしてください。/);
  assert.match(html, /id="passkey-login" class="button primary full(?: [^"]*)?"/);
  assert.match(html, /class="passkey-icon"[\s\S]*aria-hidden="true"/);
  assert.match(html, /href="\/security\/"/);
  assert.doesNotMatch(html, /id="login-(?:form|id|password|submit)"|password-toggle|remember-login|auth-divider|password-login-audit\.js/);
  assert.doesNotMatch(client, /login-password|login-id|login-form|PasswordCredential|saveLoginPreference|restoreLoginPreference|togglePassword|TRoomPasswordLoginAudit/);
  assert.doesNotMatch(css, /password-field|password-eye|password-toggle|remember-login|auth-divider|icon-button|form-stack/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, client, cryptoClient] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/crypto-vault.js", import.meta.url), "utf8")
]);

assert.doesNotMatch(html, /value="sub@a-tanaka\.jp"/);
assert.doesNotMatch(cryptoClient, /sub@a-tanaka\.jp/);
assert.doesNotMatch(html, /id="(?:login-form|login-id|login-password|remember-login)"|password-login-audit\.js/);
assert.doesNotMatch(client, /PasswordCredential|navigator\.credentials\.store|REMEMBER_LOGIN_KEY|api\("\/login"/);
assert.match(html, /id="passkey-login"[^>]*type="button"/);
console.log("passkey-only login without stored password credentials: ok");

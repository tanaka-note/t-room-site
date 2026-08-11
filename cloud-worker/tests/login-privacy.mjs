import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, client, cryptoClient] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/crypto-vault.js", import.meta.url), "utf8")
]);

assert.doesNotMatch(html, /value="sub@a-tanaka\.jp"/);
assert.doesNotMatch(cryptoClient, /sub@a-tanaka\.jp/);
assert.match(html, /id="remember-login"/);
assert.match(client, /navigator\.credentials\.store/);
assert.doesNotMatch(client, /navigator\.credentials\.get/);
assert.match(client, /REMEMBER_LOGIN_KEY/);

console.log("login privacy and opt-in credential storage: ok");

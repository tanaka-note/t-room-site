import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [mainHtml, mainClient, mainCss, shareHtml, shareClient, shareCss] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8"),
  readFile(new URL("../public/share.html", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.css", import.meta.url), "utf8")
]);

const protectedInputs = [
  "login-password",
  "folder-password",
  "folder-upload-password",
  "unlock-password",
  "folder-new-password",
  "share-password",
  "vault-password"
];

for (const id of protectedInputs) {
  assert.match(mainHtml, new RegExp(`id="${id}"[^>]*type="password"|type="password"[^>]*id="${id}"`));
  assert.match(mainHtml, new RegExp(`data-password-target="${id}"`));
}

assert.match(mainClient, /bindPasswordVisibilityToggles\(\)/);
assert.match(mainClient, /input\.type = input\.type === "password" \? "text" : "password"/);
assert.match(mainClient, /aria-pressed/);
assert.match(mainCss, /\.password-visibility-toggle\[aria-pressed="true"\] \.password-eye-closed/);

assert.match(shareHtml, /data-password-target="share-password"/);
assert.match(shareClient, /bindPasswordVisibilityToggles\(\)/);
assert.match(shareClient, /input\.type = input\.type === "password" \? "text" : "password"/);
assert.match(shareCss, /\.password-visibility-toggle\[aria-pressed="true"\] \.password-eye-closed/);

console.log("password visibility controls: ok");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [client, html] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8")
]);

const context = vm.createContext({
  console,
  document: { addEventListener() {} },
  TCloudMedia: { safeFilename: (value) => String(value || "download") }
});
vm.runInContext(client, context);
const formatted = vm.runInContext('formatShareBundle("https://example.test/cloud/share/abc/", "strong-password")', context);
assert.equal(formatted, "【T-Cloud Storage 共有】\n\nURL\nhttps://example.test/cloud/share/abc/\n\nパスワード\nstrong-password");

assert.match(html, /id="copy-share-url"[^>]*>URLをコピー/);
assert.match(html, /id="copy-share-password"[^>]*>PWをコピー/);
assert.match(html, /id="copy-share-bundle"[^>]*>URL・PWをまとめてコピー/);
assert.match(client, /\$\("#copy-share-bundle"\)\.addEventListener/);
assert.match(client, /await copyShareBundle\("共有URLを発行し、URLとPWをまとめてコピーしました。"\)/);
assert.match(client, /function clearShareResultSecrets\(\)[\s\S]*?share-result-url[\s\S]*?share-result-password/);

console.log("combined share URL and password copy: ok");

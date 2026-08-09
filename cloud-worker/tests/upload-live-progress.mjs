import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, client, worker] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8")
]);

assert.match(html, /id="upload-bytes"/);
assert.match(html, /id="upload-eta"/);
assert.match(html, /id="upload-activity"/);
assert.match(client, /new XMLHttpRequest\(\)/);
assert.match(client, /request\.upload\.onprogress/);
assert.match(client, /formatTransferRate/);
assert.match(client, /通信応答待ち/);
assert.match(client, /Cloudflareへの保存確認済み/);
assert.match(client, /tracker\.stop\(\)/);
assert.match(worker, /await env\.FILES\.head\(file\.object_key\)/);
assert.match(worker, /storedBytes !== expectedBytes/);
assert.match(worker, /verified: true, storedBytes/);

console.log("live upload progress and R2 verification: ok");

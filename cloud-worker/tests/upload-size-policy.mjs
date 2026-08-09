import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, client, cryptoClient, worker, config] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/crypto-vault.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8"),
  readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")
]);

assert.doesNotMatch(html, /1ファイル最大10GB/);
assert.doesNotMatch(config, /MAX_FILE_BYTES/);
assert.match(client, /Number\(file\.size\) === 0/);
assert.match(client, /files = files\.filter\(\(file\) => Number\(file\.size\) > 0\)/);
assert.match(client, /空ファイル（0バイト）のため、アップロード対象外です。/);
assert.match(client, /\[\.\.\.finalFailures, \.\.\.skippedFiles\]/);
assert.match(html, /アップロードできなかったデータ/);
assert.match(cryptoClient, /MAX_MULTIPART_PARTS = 10000/);
assert.match(cryptoClient, /MAX_FILE_CHUNK_SIZE = 64 \* 1024 \* 1024/);
assert.match(cryptoClient, /function chooseFileChunkSize/);
assert.match(worker, /MAX_FILE_BYTES = MAX_MULTIPART_CHUNK_BYTES \* MAX_MULTIPART_PARTS/);
assert.match(worker, /現在のアップロード方式では1ファイル最大約640GBです。/);
assert.match(worker, /chunkCount > MAX_MULTIPART_PARTS/);

console.log("zero-byte reporting and expanded multipart size policy: ok");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const client = await readFile(new URL("../public/cloud.js", import.meta.url), "utf8");

assert.match(worker, /scope\.path AS searchPath, scope\.depth AS searchDepth/,
  "recursive search must return the depth of every result");
assert.match(worker, /ORDER BY scope\.depth ASC/,
  "recursive search must return shallow results before deep descendants");
assert.match(worker, /WHEN LOWER\(folder\.name\) = \? THEN 0/,
  "exact folder names must be preferred at the same depth");
assert.match(client, /function matchesActiveSearchFile\(file\)/,
  "the web client must remove encrypted search candidates after decryption");
assert.match(client, /pageFilesRaw\.filter\(\(file\) => matchesActiveSearchFile\(file\)\)/,
  "progressively loaded encrypted candidates must be filtered before rendering");
assert.match(client, /result\.sort\(\(left, right\) => compareSearchResults\(left, right\)\)/,
  "the web client must preserve search-specific depth and match ranking");

console.log("recursive search ranking and decrypted-candidate filtering: ok");

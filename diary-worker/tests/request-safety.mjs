import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

assert.doesNotMatch(source, /request\.json\(\)|request\.formData\(\)/,
  "unbounded request.json()/formData() calls must not bypass the byte-counting stream");
assert.match(source, /function limitedRequestBodyResponse\([\s\S]*?Content-Length[\s\S]*?Number\.isSafeInteger[\s\S]*?TransformStream[\s\S]*?total > maxBytes/,
  "Content-Length and actual streamed bytes must both be bounded");
assert.match(source, /if \(!\/\^\(0\|\[1-9\]\\d\*\)\$\/\.test\(normalizedLength\)\)/,
  "malformed Content-Length values must fail closed");
assert.equal((source.match(/readMultipartForm\(request, PHOTO_REQUEST_MAX_BYTES\)/g) || []).length, 2,
  "both legacy and staged photo uploads must use the bounded multipart parser");
assert.equal((source.match(/original\.size \+ display\.size \+ thumbnail\.size > PHOTO_PARTS_MAX_BYTES/g) || []).length, 2,
  "both photo upload paths must enforce the aggregate payload limit");
assert.match(source, /const PHOTO_REQUEST_MAX_BYTES = 80 \* 1024 \* 1024/);
assert.match(source, /original\.size > 60 \* 1024 \* 1024/);

process.stdout.write("Diary bounded request-body contract tests passed.\n");

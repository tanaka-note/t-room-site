import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

assert.match(html, /id="diary-search-input"[^>]*placeholder="ここに入力する"/);
assert.match(html, /id="entry-tags"[^>]*placeholder="ここに入力する"/);
assert.doesNotMatch(html, /placeholder="例：/);
assert.doesNotMatch(html, /placeholder="家族、仕事、旅行"/);

console.log("diary search placeholders use neutral guidance: ok");

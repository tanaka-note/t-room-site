import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

assert.match(html, /id="diary-search-input"[^>]*placeholder="ここに入力する"/);
assert.match(html, /id="entry-tags"[^>]*placeholder="例：仕事、イベント、記念日、旅行"/);

console.log("diary search and tag placeholders: ok");

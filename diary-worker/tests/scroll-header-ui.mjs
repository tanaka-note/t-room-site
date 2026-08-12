import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(`${root}/public/index.html`, "utf8");
const script = readFileSync(`${root}/public/diary.js`, "utf8");
const style = readFileSync(`${root}/public/diary.css`, "utf8");

assert.match(html, /id="site-header" class="site-header"/);
assert.match(script, /window\.addEventListener\("scroll", scheduleHeaderVisibilityUpdate, \{ passive: true \}\)/);
assert.match(script, /movement > HEADER_SCROLL_THRESHOLD_PX[\s\S]*?classList\.add\("is-scroll-hidden"\)/);
assert.match(script, /movement < -HEADER_SCROLL_THRESHOLD_PX[\s\S]*?classList\.remove\("is-scroll-hidden"\)/);
assert.match(style, /\.site-header\.is-scroll-hidden\s*\{[\s\S]*?translateY\(calc\(-100% - 2px\)\)/);

process.stdout.write("Diary scroll-aware header contract test passed.\n");

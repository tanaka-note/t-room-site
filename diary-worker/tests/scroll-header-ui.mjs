import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(`${root}/public/index.html`, "utf8");
const script = readFileSync(`${root}/public/diary.js`, "utf8");
const style = readFileSync(`${root}/public/diary.css`, "utf8");
const siteHeaderStyle = style.match(/\.site-header\s*\{[\s\S]*?\n\}/)?.[0] || "";

assert.match(html, /id="site-header" class="site-header"/);
assert.match(script, /window\.addEventListener\("scroll", scheduleHeaderVisibilityUpdate, \{ passive: true \}\)/);
assert.match(script, /function resetHeaderVisibilityTracking\(\)[\s\S]*?--header-scroll-offset", "0px"/);
assert.match(script, /state\.headerScrollOffset = Math\.min\([\s\S]*?state\.headerScrollOffset \+ movement/);
assert.match(script, /style\.setProperty\("--header-scroll-offset", `\$\{state\.headerScrollOffset\}px`\)/);
assert.match(script, /classList\.toggle\("is-scroll-hidden", state\.headerScrollOffset >= headerHeight - 0\.5\)/);
assert.match(style, /transform: translateY\(calc\(-1 \* var\(--header-scroll-offset, 0px\)\)\)/);
assert.doesNotMatch(siteHeaderStyle, /transition: transform/);

process.stdout.write("Diary scroll-aware header contract test passed.\n");

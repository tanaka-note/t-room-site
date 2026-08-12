import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(`${root}/public/index.html`, "utf8");
const script = readFileSync(`${root}/public/diary.js`, "utf8");

assert.match(html, /id="boot-view"[^>]*aria-busy="true"/);
assert.match(html, /id="login-view"[^>]*hidden/);
assert.match(html, /id="app-view"[^>]*hidden/);
assert.match(script, /const session = await api\("\/session"\);[\s\S]*?if \(session\.authenticated\)/);
assert.match(script, /async function enterDiary[\s\S]*?elements\.bootView\.hidden = true;[\s\S]*?elements\.loginView\.hidden = true;[\s\S]*?elements\.appView\.hidden = false/);
assert.match(script, /function showLogin[\s\S]*?elements\.bootView\.hidden = true;[\s\S]*?elements\.loginView\.hidden = false;[\s\S]*?elements\.appView\.hidden = true/);

process.stdout.write("Diary authenticated startup view contract test passed.\n");

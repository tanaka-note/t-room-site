import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(`${root}/public/index.html`, "utf8");
const script = readFileSync(`${root}/public/cloud.js`, "utf8");

assert.match(html, /id="boot-view"[^>]*aria-busy="true"/);
assert.match(html, /id="login-view"[^>]*hidden/);
assert.match(html, /id="app-view"[^>]*hidden/);
assert.match(script, /if \(session\.authenticated\)[\s\S]*?await enterApp\(session,[\s\S]*?else \{\s*showLoginView\(\)/);
assert.match(script, /async function enterApp[\s\S]*?\$\("#boot-view"\)\.hidden = true/);
assert.match(script, /function showLoginView\(\) \{[\s\S]*?\$\("#boot-view"\)\.hidden = true;[\s\S]*?\$\("#login-view"\)\.hidden = false;[\s\S]*?\$\("#app-view"\)\.hidden = true/);

process.stdout.write("T-Cloud authenticated startup view contract test passed.\n");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [client, styles] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8")
]);

assert.match(styles, /\.selection-bar \{ position: fixed; z-index: 30;/);
assert.match(styles, /\.selection-bar \{[^}]*left: calc\(248px \+ clamp\(24px, 4vw, 52px\)\)[^}]*margin: 0;/);
assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.selection-bar \{ top: calc\(8px \+ env\(safe-area-inset-top\)\); right: 18px; left: 18px; \}/);
assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.selection-bar \{ right: 12px; left: 12px; align-items: stretch; flex-direction: column; \}/);
assert.equal((client.match(/card\.setPointerCapture\(pointerId\)/g) || []).length, 2);
assert.equal((client.match(/card\.releasePointerCapture\(pointerId\)/g) || []).length, 2);
assert.match(client, /document\.elementFromPoint\(event\.clientX, event\.clientY\)\?\.closest\("\.file-card"\)/);

console.log("selection toolbar does not reflow cards and long press retains pointer ownership: ok");

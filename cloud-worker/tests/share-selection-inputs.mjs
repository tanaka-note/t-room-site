import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [client, css] = await Promise.all([
  readFile(new URL("../public/share.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.css", import.meta.url), "utf8")
]);

assert.match(client, /addEventListener\("contextmenu"/);
assert.match(client, /function installSharedLongPressSelection/);
assert.match(client, /document\.elementFromPoint\(event\.clientX, event\.clientY\)/);
assert.match(client, /state\.selecting = true/);
assert.match(client, /function handleSelectionKeydown/);
assert.match(client, /"ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"/);
assert.match(client, /function selectSharedRange/);
assert.match(client, /scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/);
assert.match(css, /user-select:none/);

console.log("shared right-click, long-press drag, and shift-arrow selection: ok");

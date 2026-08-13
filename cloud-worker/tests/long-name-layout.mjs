import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../public/cloud.css", import.meta.url), "utf8");
const js = fs.readFileSync(new URL("../public/cloud.js", import.meta.url), "utf8");

assert.match(css, /\.topbar h1 \{[^}]*-webkit-line-clamp: 2;/s, "current folder title must be limited to two lines");
assert.match(css, /\.folder-card strong \{[^}]*-webkit-line-clamp: 2;/s, "folder names must be limited to two lines");
assert.match(css, /\.list-mode \.file-copy strong \{[^}]*-webkit-line-clamp: 2;/s, "file names must be limited to two lines");
assert.match(js, /button\.title = folder\.name;/, "full folder name must remain available as a tooltip");
assert.match(js, /button\.title = file\.name;/, "full file name must remain available as a tooltip");
assert.match(js, /function setViewTitle\(value\)[\s\S]*?\.title = title;/, "full current folder name must remain available as a tooltip");

console.log("long-name layout contracts passed");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [script, css] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8"),
]);

const helperSource = script.match(/function usesSquareFileCard\(file\) \{[^}]+\}/)?.[0];
assert.ok(helperSource, "square-card media classifier must exist");
const usesSquareFileCard = Function(`${helperSource}; return usesSquareFileCard;`)();

assert.equal(usesSquareFileCard({ mediaKind: "image" }), true);
assert.equal(usesSquareFileCard({ mediaKind: "video" }), true);
for (const mediaKind of ["audio", "document", "other", ""]) {
  assert.equal(usesSquareFileCard({ mediaKind }), false, `${mediaKind || "blank"} must use a horizontal card`);
}

assert.match(script, /card\.classList\.add\(usesSquareFileCard\(file\) \? "media-file-card" : "non-media-file-card"\)/);
assert.match(css, /\.content-grid:not\(\.list-mode\) \.file-card\.non-media-file-card \{ grid-column: 1 \/ -1; \}/);
assert.match(css, /\.content-grid:not\(\.list-mode\) \.file-card\.non-media-file-card > button:not\(\.file-select-button\) \{[^}]*grid-template-columns: 92px minmax\(0,1fr\);/);
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.content-grid:not\(\.list-mode\) \.file-card\.non-media-file-card > button:not\(\.file-select-button\) \{[^}]*grid-template-columns: 76px minmax\(0, 1fr\);/);
assert.match(css, /\.thumb \{[^}]*aspect-ratio: 1;/);

console.log("Web file card media classification contract test passed.");

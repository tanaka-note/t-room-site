import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const script = await readFile(new URL("../public/cloud.js", import.meta.url), "utf8");
const helperSource = script.match(/function shouldPausePreviewVideo\(pageHidden, pictureInPictureActive\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(helperSource, "video background policy helper must exist");
const shouldPausePreviewVideo = Function(`${helperSource}; return shouldPausePreviewVideo;`)();

assert.equal(shouldPausePreviewVideo(true, false), true, "hidden normal video must pause");
assert.equal(shouldPausePreviewVideo(false, false), false, "visible video must not be forced to pause");
assert.equal(shouldPausePreviewVideo(true, true), false, "PiP video must keep playing while hidden");
assert.match(script, /document\.addEventListener\("visibilitychange", handlePreviewBackgroundVisibility\)/);
assert.match(script, /window\.addEventListener\("pagehide", handlePreviewBackgroundVisibility\)/);
assert.match(script, /document\.addEventListener\("freeze", handlePreviewBackgroundVisibility\)/);
assert.match(script, /state\.previewPictureInPictureActive && state\.previewPictureInPictureVideo === video/);
assert.match(script, /if \(document\.hidden\) \{\s*try \{ video\.pause\(\); \} catch \{\}/s);

console.log("video background playback tests passed");

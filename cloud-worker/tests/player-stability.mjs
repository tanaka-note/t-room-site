import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [main, share, mediaClient, mainCss, shareCss, mainHtml, shareHtml] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8"),
  readFile(new URL("../public/media-client.js", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8"),
  readFile(new URL("../public/share.css", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/share.html", import.meta.url), "utf8")
]);

assert.match(mediaClient, /const pendingRegistrations = new Map\(\)/);
assert.match(mediaClient, /await confirmMediaRegistration\(/);
assert.match(mediaClient, /data\.type === "MEDIA_REGISTERED"/);

for (const client of [main, share]) {
  assert.match(client, /previewVideoFullscreenActive: false/);
  assert.match(client, /screen\.orientation\.lock\("portrait-primary"\)/);
  assert.match(client, /screen\.orientation\.lock\("any"\)/);
  assert.match(client, /window\.addEventListener\("orientationchange"/);
  assert.match(client, /window\.addEventListener\("pageshow"/);
  assert.match(client, /requestAnimationFrame\(syncPlayback\)/);
  assert.match(client, /classList\.add\("is-media-ready"\)/);
  assert.match(client, /loadeddata/);
}

for (const css of [mainCss, shareCss]) {
  assert.match(css, /has-custom-video-controls\.is-media-ready video/);
  assert.match(css, /player-buffering\.is-hidden/);
}

assert.match(main, /prepareVideoPlayer\(stage, file\)[\s\S]*?registerMediaWithDeviceCache/);
assert.match(main, /seek\.addEventListener\("input", previewSeek\)/);
assert.match(main, /seek\.addEventListener\("change", commitSeek\)/);
assert.match(main, /state\.previewPlayer\.currentTime = target/);
assert.doesNotMatch(main, /seek\.addEventListener\("input", \(\) => \{[\s\S]*?video\.currentTime/);
assert.match(main, /bufferedEnd\(duration\)/);
assert.match(mainCss, /--buffered-percent/);
assert.match(share, /prepareSharedVideoPlayer\(stage, file\)[\s\S]*?TCloudMedia\.registerMedia/);
assert.match(mainHtml, /media-client\.js\?v=20260811-2/);
assert.match(shareHtml, /media-client\.js\?v=20260810-10/);

console.log("player registration, stable rendering, and portrait recovery: ok");

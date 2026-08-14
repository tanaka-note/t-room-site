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
assert.match(mediaClient, /navigator\.serviceWorker\.controller \|\| registration\.active/);
assert.match(mediaClient, /controllerchange", registerMediaWithCurrentWorker/);

for (const client of [main, share]) {
  assert.match(client, /previewVideoFullscreenActive: false/);
  assert.match(client, /screen\.orientation\.lock\("portrait-primary"\)/);
  assert.match(client, /screen\.orientation\.lock\("any"\)/);
  assert.match(client, /window\.addEventListener\("orientationchange"/);
  assert.match(client, /window\.addEventListener\("pageshow"/);
  assert.match(client, /requestAnimationFrame\(syncPlayback\)/);
  assert.match(client, /classList\.add\("is-media-ready"\)/);
  assert.match(client, /loadeddata/);
  assert.doesNotMatch(client, /↻1/, "リピートON時に数字の1を表示しないでください。");
  assert.match(client, /button\.textContent = state\.previewPlaybackMode === "continuous-audio" \? "連続" : "↻"/);
  assert.match(client, /classList\.toggle\("is-active", (?:active|state\.previewPlaybackMode !== "off")\)/, "ON/OFFの既存色切替を維持してください。");
}

for (const css of [mainCss, shareCss]) {
  assert.match(css, /has-custom-video-controls\.is-media-ready video/);
  assert.match(css, /player-buffering\.is-hidden/);
  assert.match(css, /\.preview-player-seek \{[^}]*cursor:\s*pointer;/);
  assert.doesNotMatch(css, /\.preview-player-seek \{[^}]*cursor:\s*ew-resize;/);
  assert.match(css, /video::-webkit-media-controls-picture-in-picture-button\s*\{[^}]*display:\s*none\s*!important;/, "動画内のブラウザ標準PiPボタンだけを非表示にしてください。");
}

assert.match(main, /prepareVideoPlayer\(stage, file\)[\s\S]*?registerMediaWithDeviceCache/);
assert.match(main, /seek\.addEventListener\("pointerdown"/);
assert.match(main, /seek\.addEventListener\("pointermove"/);
assert.match(main, /seek\.addEventListener\("pointerup", finishRelativeSeek\)/);
assert.match(main, /relativeSeekTime\(seekPointerStartSeconds, seekPointerStartX, event\.clientX/);
assert.match(main, /state\.previewPlayer\.currentTime = target/);
assert.doesNotMatch(main, /seek\.addEventListener\("input", \(\) => \{[\s\S]*?video\.currentTime/);
assert.match(main, /bufferedEnd\(duration\)/);
assert.match(main, /contiguousCachedPlaybackPercent\(file, entry\)/);
assert.match(main, /Math\.max\(playedPercent, bufferedEnd\(duration\) \/ duration \* 100, cachedPlaybackPercent\)/);
assert.match(mainCss, /--buffered-percent/);
assert.match(mainHtml, /id="preview-pip"[^>]*>縮小<\/button>/);
assert.match(main, /video\.requestPictureInPicture\(\)/);
assert.match(main, /video\.webkitSetPresentationMode\("picture-in-picture"\)/);
assert.match(main, /leavepictureinpicture/);
assert.match(main, /state\.previewKeepMediaOnClose = true/);
assert.match(main, /restorePreviewOrigin\(originFileId\)/);
assert.match(main, /await stopPictureInPicturePreview\(\)/);
assert.match(main, /この端末またはブラウザはピクチャインピクチャに対応していません/);
assert.match(main, /previewPlaybackMode: "off"/);
assert.match(main, /function nextPreviewPlaybackMode\(mediaKind\)/);
assert.match(main, /state\.previewPlaybackMode === "repeat-one"/);
assert.match(main, /state\.previewPlaybackMode === "continuous-audio"/);
assert.match(main, /media\.loop = state\.previewPlaybackMode === "repeat-one"/);
assert.match(main, /void navigatePreviewAudio\(1\)/);
assert.match(main, /function renderAudioPlayer\(stage, file, url\)/);
assert.match(mainCss, /\.preview-audio-playback-mode\.is-active/);
assert.match(mainCss, /\.preview-actions \{[^}]*display: grid;[^}]*grid-auto-flow: column;[^}]*grid-auto-columns: minmax\(0, 1fr\)/);
assert.match(share, /prepareSharedVideoPlayer\(stage, file\)[\s\S]*?TCloudMedia\.registerMedia/);
assert.match(share, /previewPlaybackMode: "off"/);
assert.match(share, /function nextSharedPlaybackMode\(mediaKind\)/);
assert.match(share, /state\.previewPlaybackMode === "continuous-audio"/);
assert.match(share, /function renderSharedAudioPlayer\(stage, file, url\)/);
assert.match(shareCss, /\.preview-audio-playback-mode\.is-active/);
assert.match(share, /seek\.addEventListener\("pointerdown"/);
assert.match(share, /relativeSeekTime\(seekPointerStartSeconds, seekPointerStartX, event\.clientX/);
assert.match(mainHtml, /media-client\.js\?v=20260811-12/);
assert.match(shareHtml, /media-client\.js\?v=20260811-12/);
assert.match(mediaClient, /function playbackMimeType\(file\)/);
assert.match(mediaClient, /mp4: "video\/mp4"/);

console.log("player registration, stable rendering, and portrait recovery: ok");

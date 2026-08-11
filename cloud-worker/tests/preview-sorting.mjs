import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [mainHtml, mainCss, mainJs, shareHtml, shareCss, shareJs] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.html", import.meta.url), "utf8"),
  readFile(new URL("../public/share.css", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8")
]);
const workerJs = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

for (const key of ["updated", "name", "size"]) {
  assert.match(mainHtml, new RegExp(`data-sort-key="${key}"`));
  assert.match(shareHtml, new RegExp(`data-sort-key="${key}"`));
}
assert.match(shareHtml, /id="share-sort-controls"/);
assert.match(shareHtml, /id="share-display-toggle"[^>]*aria-label="横長表示へ切り替え"/);
assert.match(shareJs, /function renderSortedItems\(\)/);
assert.match(shareJs, /state\.sort === "size"/);
assert.match(shareJs, /function changeSharedSort\(key\)/);
assert.match(mainJs, /function changeSort\(key\)/);
assert.match(mainJs, /state\.sortDirection/);
assert.match(mainJs, /sort: "name",\s*sortDirection: "asc",\s*sortUsesTypeDefaults: true/);
assert.match(shareJs, /sort: "updated", sortDirection: "desc", sortUsesTypeDefaults: true/);
assert.match(shareJs, /listMode: false/);
assert.match(shareJs, /root\.classList\.toggle\("list-mode", state\.listMode\)/);
assert.match(shareJs, /state\.listMode = !state\.listMode/);
assert.match(shareCss, /\.folder \{ grid-column:1 \/ -1; \}/);
assert.match(shareCss, /\.items\.list-mode \{ grid-template-columns:1fr/);
assert.match(mainHtml, /class="sort-button active"[^>]*data-sort-key="name"[^>]*aria-pressed="true">名前 <span[^>]*>↑<\/span>/);
assert.match(shareHtml, /class="sort-button active"[^>]*data-sort-key="updated"[^>]*aria-pressed="true">更新日 <span[^>]*>↓<\/span>/);
assert.match(mainJs, /function resetTypeDefaultSort\(\)/);
assert.match(mainJs, /if \(state\.sortUsesTypeDefaults\) result\.sort\(\(a, b\) => a\.name\.localeCompare/);
assert.match(mainJs, /if \(state\.sortUsesTypeDefaults\) result\.sort\(\(a, b\) => String\(b\.createdAt/);
assert.doesNotMatch(mainJs, /state\.sort === "updated"[^\n]+updatedAt/, "更新日順に名称変更日時を使用しないでください。");
assert.match(shareJs, /const byUpdated = \(a, b\) => direction \* String\(a\.createdAt/);
assert.match(workerJs, /"updated-desc": "created_at DESC", "updated-asc": "created_at ASC"/);
assert.match(shareJs, /if \(state\.sortUsesTypeDefaults\) \{[\s\S]*?folders\.sort\(byName\);[\s\S]*?files\.sort/);

assert.doesNotMatch(mainHtml, /id="preview-fullscreen"/, "右上の全画面ボタンを表示しないでください。");
assert.doesNotMatch(shareHtml, /id="share-preview-fullscreen"/, "共有画面でも右上の全画面ボタンを表示しないでください。");
assert.doesNotMatch(mainHtml, /id="preview-rotate"/);
assert.doesNotMatch(shareHtml, /id="share-preview-rotate"/);
assert.match(mainHtml, /id="preview-more"/);
assert.doesNotMatch(mainJs, /togglePreviewFullscreen|preview-fullscreen/, "全画面操作は動画標準コントロールだけに統一してください。");
assert.doesNotMatch(shareJs, /toggleSharedPreviewFullscreen|share-preview-fullscreen/, "共有画面の全画面操作も動画標準コントロールだけに統一してください。");
assert.doesNotMatch(mainJs, /controlsList\.add\("nofullscreen"\)/);
assert.doesNotMatch(shareJs, /controlsList\.add\("nofullscreen"\)/);
assert.match(mainJs, /video\.controls = false/);
assert.match(shareJs, /video\.controls = false/);
assert.match(mainJs, /className = "preview-player-controls"/);
assert.match(shareJs, /className = "preview-player-controls"/);
assert.match(mainJs, /class="preview-player-seek"[\s\S]*?class="preview-player-button preview-player-fullscreen"/);
assert.match(shareJs, /class="preview-player-seek"[\s\S]*?class="preview-player-button preview-player-fullscreen"/);
assert.match(mainJs, /class="preview-player-seek" role="slider"/);
assert.match(shareJs, /class="preview-player-seek" role="slider"/);
assert.doesNotMatch(mainJs, /class="preview-player-seek" type="range"/);
assert.doesNotMatch(shareJs, /class="preview-player-seek" type="range"/);
assert.match(mainJs, /seekPointerStartSeconds[\s\S]*?relativeSeekTime\(seekPointerStartSeconds, seekPointerStartX, event\.clientX/);
assert.match(shareJs, /seekPointerStartSeconds[\s\S]*?relativeSeekTime\(seekPointerStartSeconds, seekPointerStartX, event\.clientX/);
assert.doesNotMatch(mainCss, /preview-player-seek::-(?:webkit-slider-thumb|moz-range-thumb)/);
assert.doesNotMatch(shareCss, /preview-player-seek::-(?:webkit-slider-thumb|moz-range-thumb)/);
assert.match(mainCss, /\.preview-player-seek::before/);
assert.match(shareCss, /\.preview-player-seek::before/);
assert.match(mainJs, /container\.requestFullscreen/);
assert.match(shareJs, /container\.requestFullscreen/);
assert.match(mainJs, /document\.exitFullscreen/);
assert.match(shareJs, /document\.exitFullscreen/);
assert.doesNotMatch(mainJs, /PREVIEW_FULLSCREEN_PORTRAIT_HOLD_MS|previewOrientationReleaseTimer/);
assert.doesNotMatch(shareJs, /PREVIEW_FULLSCREEN_PORTRAIT_HOLD_MS|previewOrientationReleaseTimer/);
assert.match(mainJs, /restoreInstalledAppPortrait[\s\S]*?screen\.orientation\.lock\("portrait-primary"\)/);
assert.match(shareJs, /restoreInstalledAppPortrait[\s\S]*?screen\.orientation\.lock\("portrait-primary"\)/);
assert.match(mainJs, /prepareInstalledVideoFullscreen[\s\S]*?screen\.orientation\.lock\("any"\)/);
assert.match(shareJs, /prepareInstalledVideoFullscreen[\s\S]*?screen\.orientation\.lock\("any"\)/);
assert.match(mainJs, /function previewVideoIsFullscreen\(/);
assert.match(shareJs, /function sharedPreviewVideoIsFullscreen\(/);
assert.match(mainJs, /requestGeneration !== state\.previewOrientationGeneration/);
assert.match(shareJs, /requestGeneration !== state\.previewOrientationGeneration/);
assert.match(mainJs, /!previewVideoIsFullscreen\(sourceVideo\)[\s\S]*?restoreInstalledAppPortrait\(\)/);
assert.match(shareJs, /!sharedPreviewVideoIsFullscreen\(sourceVideo\)[\s\S]*?restoreInstalledAppPortrait\(\)/);
assert.match(mainJs, /fullscreenchange[\s\S]*?handlePreviewFullscreenOrientationChange/);
assert.match(shareJs, /fullscreenchange[\s\S]*?handleSharedPreviewFullscreenOrientationChange/);
assert.match(mainJs, /webkitbeginfullscreen[^\n]*prepareInstalledVideoFullscreen/);
assert.match(shareJs, /webkitbeginfullscreen[^\n]*prepareInstalledVideoFullscreen/);
assert.match(mainJs, /video\.currentTime.*10/);
assert.match(shareJs, /video\.currentTime.*10/);
assert.match(mainJs, /video\.disableRemotePlayback = true/);
assert.match(shareJs, /video\.disableRemotePlayback = true/);
assert.match(mainJs, /controlsList", "noremoteplayback"/);
assert.match(shareJs, /controlsList", "noremoteplayback"/);
assert.match(mainJs, /x-webkit-airplay", "deny"/);
assert.match(shareJs, /x-webkit-airplay", "deny"/);
assert.doesNotMatch(mainJs, /video\.addEventListener\("click"/);
assert.doesNotMatch(shareJs, /video\.addEventListener\("click"/);
assert.match(mainCss, /width: min\(1280px/);
assert.match(shareCss, /width:min\(1280px/);
assert.match(mainCss, /\.player-buffering/);
assert.match(shareCss, /\.player-buffering/);
assert.match(mainCss, /\.preview-stage video \{ touch-action: pinch-zoom; \}/);
assert.match(shareCss, /\.preview-stage video \{ touch-action:pinch-zoom; \}/);
assert.match(mainCss, /height: 100dvh/);
assert.match(shareCss, /height:100dvh/);
assert.match(mainCss, /video:fullscreen[\s\S]*?height: 100dvh/, "動画標準の全画面表示で画面全体を使用してください。");
assert.match(shareCss, /video:fullscreen[\s\S]*?height:100dvh/, "共有動画も標準の全画面表示で画面全体を使用してください。");
assert.doesNotMatch(mainCss, /media-controls-fullscreen-button/);
assert.doesNotMatch(shareCss, /media-controls-fullscreen-button/);
assert.match(mainCss, /\.preview-player-controls[\s\S]*?grid-template-columns/);
assert.match(shareCss, /\.preview-player-controls[\s\S]*?grid-template-columns/);
assert.match(mainCss, /preview-stage-wrap:fullscreen \.preview-stage\.has-custom-video-controls \{ height: 100%; min-height: 0; \}/);
assert.match(shareCss, /preview-stage-wrap:fullscreen \.preview-stage\.has-custom-video-controls \{ height:100%; min-height:0; \}/);
assert.doesNotMatch(mainCss, /preview-rotate-overlay/);
assert.doesNotMatch(shareCss, /preview-rotate-overlay/);
assert.doesNotMatch(mainCss, /is-video-rotated|transform: rotate\(90deg\)/);
assert.doesNotMatch(shareCss, /is-video-rotated|transform:rotate\(90deg\)/);

function verifyRelativeSeek(source, nextFunctionMarker, shared = false) {
  const start = source.indexOf("function relativeSeekTime");
  const end = source.indexOf(nextFunctionMarker, start);
  assert.ok(start >= 0 && end > start, `${shared ? "共有" : "管理"}画面に相対シーク計算を実装してください。`);
  const context = { Number, Math };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.relativeSeek = relativeSeekTime;`, context);
  assert.equal(context.relativeSeek(50, 100, 100, 200, 120), 50, "押しただけでは再生位置を移動しないでください。");
  assert.equal(context.relativeSeek(50, 100, 200, 200, 120), 110, "右へ動かした距離に応じて進めてください。");
  assert.equal(context.relativeSeek(50, 100, 0, 200, 120), 0, "左端を超えないようにしてください。");
  assert.equal(context.relativeSeek(110, 100, 200, 200, 120), 120, "動画の終端を超えないようにしてください。");
}

verifyRelativeSeek(mainJs, "function addPreviewPlayerControls");
verifyRelativeSeek(shareJs, "function addSharedPreviewPlayerControls", true);

async function verifyClosedPreviewWinsOrientationRace(source, startMarker, endMarker, shared = false) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "回転制御関数を検査できる形で維持してください。");
  const video = {};
  const container = { contains: (value) => value === video };
  const dialog = { open: true };
  let orientation = "portrait-primary";
  const orientationLocks = [];
  const context = {
    document: { fullscreenElement: { matches: () => false, querySelector: () => video }, webkitFullscreenElement: null },
    screen: { orientation: { type: "portrait-primary", lock: async (mode) => {
      if (mode === "any") await new Promise((resolve) => setTimeout(resolve, 15));
      orientationLocks.push(mode);
      orientation = mode;
    } } },
    state: { previewOrientationGeneration: 0 },
    isInstalledAppMode: () => true,
    setTimeout,
    $: (selector) => selector.includes("stage-wrap") ? container : dialog
  };
  const prepareName = "prepareInstalledVideoFullscreen";
  const restoreName = "restoreInstalledAppPortrait";
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.orientationApi = { ${prepareName}, ${restoreName} };`, context);
  const pendingFullscreen = context.orientationApi.prepareInstalledVideoFullscreen();
  dialog.open = false;
  context.document.fullscreenElement = null;
  await context.orientationApi.restoreInstalledAppPortrait();
  await pendingFullscreen;
  assert.equal(orientation, "portrait-primary", `${shared ? "共有" : "管理"}画面では、閉じる処理が遅れて完了した回転許可より優先されます。`);
  assert.ok(orientationLocks.includes("portrait-primary"), `${shared ? "共有" : "管理"}画面では、現在縦向きでも縦固定処理を省略しないでください。`);
}

async function verifyPortraitRetryAfterFullscreenExit(source, startMarker, endMarker, shared = false) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "回転制御関数を検査できる形で維持してください。");
  const container = { contains: () => false };
  const dialog = { open: false };
  let attempts = 0;
  const context = {
    document: { fullscreenElement: null, webkitFullscreenElement: null },
    screen: { orientation: { type: "portrait-primary", lock: async (mode) => {
      assert.equal(mode, "portrait-primary");
      attempts += 1;
      if (attempts < 3) throw new Error("temporary lock failure");
    } } },
    state: { previewOrientationGeneration: 0, previewVideoFullscreenActive: false },
    isInstalledAppMode: () => true,
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
    console: { warn: () => {} },
    $: (selector) => selector.includes("stage-wrap") ? container : dialog
  };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.orientationApi = { restoreInstalledAppPortrait };`, context);
  const locked = await context.orientationApi.restoreInstalledAppPortrait({ settle: true, reason: "fullscreen-exit" });
  assert.equal(locked, true, `${shared ? "共有" : "管理"}画面では、一時的な固定失敗後に再試行してください。`);
  assert.equal(attempts, 3, `${shared ? "共有" : "管理"}画面では、縦固定が成功するまで所定回数再試行してください。`);
  assert.equal(context.state.previewOrientationLastError, null, `${shared ? "共有" : "管理"}画面では、固定成功後に一時エラーを解消済みとして記録してください。`);
}

await verifyClosedPreviewWinsOrientationRace(mainJs, "function previewVideoIsFullscreen", "function handlePreviewFullscreenOrientationChange");
await verifyClosedPreviewWinsOrientationRace(shareJs, "function sharedPreviewVideoIsFullscreen", "function handleSharedPreviewFullscreenOrientationChange", true);
await verifyPortraitRetryAfterFullscreenExit(mainJs, "function previewVideoIsFullscreen", "function handlePreviewFullscreenOrientationChange");
await verifyPortraitRetryAfterFullscreenExit(shareJs, "function sharedPreviewVideoIsFullscreen", "function handleSharedPreviewFullscreenOrientationChange", true);

assert.doesNotMatch(mainJs, /screen\.orientation\.type[^\n]*startsWith\("portrait"\)[^\n]*return/, "現在の向きと固定状態を混同しないでください。");
assert.doesNotMatch(shareJs, /screen\.orientation\.type[^\n]*startsWith\("portrait"\)[^\n]*return/, "共有画面でも現在の向きと固定状態を混同しないでください。");
assert.match(mainJs, /waitForOrientationSettle\(\)[\s\S]*?retryDelays = \[0, 120, 360\]/, "全画面終了後に描画を待ち、縦固定を再試行してください。");
assert.match(shareJs, /waitForOrientationSettle\(\)[\s\S]*?retryDelays = \[0, 120, 360\]/, "共有画面でも全画面終了後に縦固定を再試行してください。");

console.log("shared sorting and immersive previews: ok");

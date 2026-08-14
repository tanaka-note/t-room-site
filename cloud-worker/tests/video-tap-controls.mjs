import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const clients = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8")
]);
const styles = await Promise.all([
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8"),
  readFile(new URL("../public/share.css", import.meta.url), "utf8")
]);

for (const [index, source] of clients.entries()) {
  assert.match(source, /addEventListener\("pointerup", remember(?:Shared)?PreviewPointerType\)/);
  assert.match(source, /addEventListener\("click", handle(?:Shared)?PreviewVideoTap\)/);
  assert.match(source, /addEventListener\("dblclick", suppress(?:Shared)?PreviewVideoDoubleClick\)/);
  assert.match(source, /for \(const eventName of \["click", "dblclick", "pointerdown", "pointerup", "touchstart", "touchend"\]\)/);
  assert.doesNotMatch(source, /function handle(?:Shared)?PreviewDoubleClick\(/, "PCのダブルクリックでスキップさせないでください。");
  assert.match(source, /const timer = setTimeout\([\s\S]*?280\)/, "既存の1回タップ判定を維持してください。");
  assert.match(source, /const DOUBLE_TAP_SEEK_SECONDS = 10;/, "左右のダブルタップは10秒に統一してください。");
  assert.match(source, /side \* DOUBLE_TAP_SEEK_SECONDS/, "左右とも共通の10秒定数を使用してください。");
  assert.doesNotMatch(source, /DOUBLE_TAP_SEEK_SECONDS\s*=\s*(?:5|15)\b/, "5秒戻る・15秒進む旧仕様を残さないでください。");
  assert.match(source, /const DOUBLE_TAP_SEEK_CONTROLS_HOLD_MS = 900/);
  assert.match(source, /classList\.add\("is-double-tap-seeking"\)[\s\S]*?clearTimeout\(state\.previewDoubleTapSeekTimer\)[\s\S]*?setTimeout\([\s\S]*?classList\.remove\("is-double-tap-seeking"\)[\s\S]*?DOUBLE_TAP_SEEK_CONTROLS_HOLD_MS/s, "連続ダブルタップ中は直前の解除予約を取り消してください。");
  assert.match(source, /hold(?:Shared)?PreviewControlsForDoubleTapSeek\(stage\);\s*seek(?:Shared)?PreviewVideoBy\(video, side \* DOUBLE_TAP_SEEK_SECONDS\);/s);
  assert.match(source, /dispatchEvent\(new Event\("tcloud:seek-feedback"\)\)/, "スキップ直後にシーク位置を更新してください。");
  assert.match(source, /"tcloud:seek-feedback"[\s\S]*?queuePlaybackSync/, "現在位置更新をシークバーへ接続してください。");
  assert.match(styles[index], /\.preview-stage\.is-double-tap-seeking \.preview-player-controls\s*\{[^}]*opacity:\s*1\s*!important;[^}]*visibility:\s*visible\s*!important;/, "ダブルタップ中はコントロールを表示してください。");

  const functionSource = source.match(/function previewVideoTapAction\([\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource, "端末別のダブルタップ判定が必要です。");
  const context = {};
  vm.runInNewContext(`${functionSource}; globalThis.tapAction = previewVideoTapAction;`, context);
  assert.equal(context.tapAction("touch", false), "toggle");
  assert.equal(context.tapAction("mouse", false), "toggle");
  assert.equal(context.tapAction("touch", true), "seek");
  assert.equal(context.tapAction("pen", true), "seek");
  assert.equal(context.tapAction("mouse", true), "none");
}

assert.match(clients[0], /previewSuppressTapUntil = performance\.now\(\) \+ 700/, "スワイプ直後の誤操作を防止してください。");

console.log("touch double-tap seeks 10 seconds on both sides while desktop double-click does not seek: ok");

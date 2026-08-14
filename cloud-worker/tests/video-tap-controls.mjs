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
  assert.doesNotMatch(source, /function handle(?:Shared)?PreviewDoubleClick\(/, "PCのダブルクリックで10秒移動させないでください。");
  assert.match(source, /const timer = setTimeout\([\s\S]*?280\)/, "単独タップとダブルタップを判定してから操作してください。");
  assert.match(source, /side \* 10/, "スマホの左右ダブルタップは10秒移動にしてください。");
  assert.match(source, /const DOUBLE_TAP_SEEK_CONTROLS_HOLD_MS = 900/);
  assert.match(source, /classList\.add\("is-double-tap-seeking"\)[\s\S]*?clearTimeout\(state\.previewDoubleTapSeekTimer\)[\s\S]*?setTimeout\([\s\S]*?classList\.remove\("is-double-tap-seeking"\)[\s\S]*?DOUBLE_TAP_SEEK_CONTROLS_HOLD_MS/s, "連続ダブルタップ中は直前の解除予約を取り消してシークバーを固定してください。");
  assert.match(source, /hold(?:Shared)?PreviewControlsForDoubleTapSeek\(stage\);\s*seek(?:Shared)?PreviewVideoBy\(video, side \* 10\);/s);
  assert.match(source, /dispatchEvent\(new Event\("tcloud:seek-feedback"\)\)/, "スキップ直後に現在位置をシークバーへ反映してください。");
  assert.match(source, /"tcloud:seek-feedback"[\s\S]*?queuePlaybackSync/, "スキップ位置の同期イベントをシークバー更新へ接続してください。");
  assert.match(styles[index], /\.preview-stage\.is-double-tap-seeking \.preview-player-controls\s*\{[^}]*opacity:\s*1\s*!important;[^}]*visibility:\s*visible\s*!important;/, "ダブルタップスキップ中はコントロールを固定表示してください。");

  const functionSource = source.match(/function previewVideoTapAction\([\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource, "端末別のタップ動作判定が必要です。");
  const context = {};
  vm.runInNewContext(`${functionSource}; globalThis.tapAction = previewVideoTapAction;`, context);
  assert.equal(context.tapAction("touch", false), "toggle");
  assert.equal(context.tapAction("mouse", false), "toggle");
  assert.equal(context.tapAction("touch", true), "seek");
  assert.equal(context.tapAction("pen", true), "seek");
  assert.equal(context.tapAction("mouse", true), "none");
}

assert.match(clients[0], /previewSuppressTapUntil = performance\.now\(\) \+ 700/, "写真・動画のスワイプ直後に誤って再生を切り替えないでください。");

console.log("double-tap seek keeps controls visible, updates position, and preserves existing tap behavior: ok");

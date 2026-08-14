import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const clients = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8"),
]);
const styles = await Promise.all([
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8"),
  readFile(new URL("../public/share.css", import.meta.url), "utf8"),
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
  assert.match(source, /clearTimeout\(state\.previewDoubleTapSeekTimer\)[\s\S]*?const releaseToken = \+\+state\.previewDoubleTapSeekSequence;[\s\S]*?classList\.add\("is-double-tap-seeking"\)[\s\S]*?releaseToken !== state\.previewDoubleTapSeekSequence[\s\S]*?classList\.remove\("is-double-tap-seeking"\)[\s\S]*?DOUBLE_TAP_SEEK_CONTROLS_HOLD_MS/s, "連続ダブルタップ中は古い解除処理を無効化してください。");
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

  const holdName = index === 0 ? "holdPreviewControlsForDoubleTapSeek" : "holdSharedPreviewControlsForDoubleTapSeek";
  const holdSource = source.match(new RegExp(`function ${holdName}\\([\\s\\S]*?\\n\\}`))?.[0];
  assert.ok(holdSource, "ダブルタップ中の表示固定処理が必要です。");
  for (const direction of ["left", "right"]) {
    const scheduled = new Map();
    const cancelled = new Set();
    let timerSequence = 0;
    const activeClasses = new Set();
    const holdContext = {
      state: { previewDoubleTapSeekTimer: 0, previewDoubleTapSeekSequence: 0 },
      DOUBLE_TAP_SEEK_CONTROLS_HOLD_MS: 900,
      setTimeout(callback) {
        const timer = ++timerSequence;
        scheduled.set(timer, callback);
        return timer;
      },
      clearTimeout(timer) { cancelled.add(timer); },
    };
    const stage = {
      classList: {
        add(value) { activeClasses.add(value); },
        remove(value) { activeClasses.delete(value); },
      },
    };
    vm.runInNewContext(`${holdSource}; globalThis.holdControls = ${holdName};`, holdContext);
    const releaseTimers = [];
    for (let tap = 0; tap < 6; tap += 1) {
      holdContext.holdControls(stage);
      releaseTimers.push(holdContext.state.previewDoubleTapSeekTimer);
      assert.equal(activeClasses.has("is-double-tap-seeking"), true, `${direction}ダブルタップ${tap + 1}回目の直後にシークバーを隠さないでください。`);
    }
    for (const timer of releaseTimers.slice(0, -1)) {
      assert.equal(cancelled.has(timer), true, "新しいダブルタップ時に直前の解除予約を取り消してください。");
      scheduled.get(timer)();
      assert.equal(activeClasses.has("is-double-tap-seeking"), true, `${direction}の古い解除処理で連続スキップ中のシークバーを隠さないでください。`);
    }
    scheduled.get(releaseTimers.at(-1))();
    assert.equal(activeClasses.has("is-double-tap-seeking"), false, `${direction}の最後のスキップ終了後だけ通常表示へ戻してください。`);
  }
}

assert.match(clients[0], /previewSuppressTapUntil = performance\.now\(\) \+ 700/, "スワイプ直後の誤操作を防止してください。");

console.log("double-tap seek controls remain visible through six consecutive skips: ok");

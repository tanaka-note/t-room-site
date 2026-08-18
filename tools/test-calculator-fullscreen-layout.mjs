import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [css, javascript, html, manifestText] = await Promise.all([
  readFile(resolve(workspace, "apps/calculator/calculator.css"), "utf8"),
  readFile(resolve(workspace, "apps/calculator/calculator.js"), "utf8"),
  readFile(resolve(workspace, "apps/calculator/index.html"), "utf8"),
  readFile(resolve(workspace, "apps/calculator/manifest.webmanifest"), "utf8")
]);
const manifest = JSON.parse(manifestText);

assert.match(html, /viewport-fit=cover/, "safe areaを利用するviewport設定を維持します");
assert.equal(manifest.display, "fullscreen", "fullscreen表示を維持します");
assert.deepEqual(manifest.display_override, ["fullscreen", "standalone"]);
assert.match(css, /body\s*\{[\s\S]*?height:\s*var\(--calculator-viewport-height,\s*100%\)/);
assert.match(css, /\.calculator-app\s*\{[\s\S]*?height:\s*100%/);
assert.match(css, /\.calculator-body\s*\{[\s\S]*?height:\s*100%/);
assert.match(css, /env\(safe-area-inset-top\)/, "上部safe areaを維持します");
assert.match(css, /env\(safe-area-inset-bottom\)/, "下部safe areaを維持します");
assert.match(css, /@media\s*\(max-height:\s*740px\)/, "低い画面向けレイアウトを維持します");

function createRuntime({ innerHeight, clientHeight, visualHeight, visualScale = 1 }) {
  const properties = new Map();
  const windowListeners = new Map();
  const viewportListeners = new Map();
  const frames = [];
  const visualViewport = visualHeight == null ? undefined : {
    height: visualHeight,
    scale: visualScale,
    offsetTop: Math.max(0, innerHeight - visualHeight),
    addEventListener(type, listener) {
      viewportListeners.set(type, listener);
    }
  };
  const document = {
    documentElement: {
      clientHeight,
      style: {
        setProperty(name, value) {
          properties.set(name, value);
        }
      }
    },
    querySelector() {
      return null;
    }
  };
  const window = {
    innerHeight,
    visualViewport,
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    }
  };

  vm.runInNewContext(javascript, { window, document, Number, Math });

  return {
    properties,
    frames,
    visualViewport,
    dispatchViewportResize() {
      viewportListeners.get("resize")?.();
    },
    dispatchWindowResize() {
      windowListeners.get("resize")?.();
    },
    runFrame() {
      frames.shift()?.();
    }
  };
}

{
  const fullscreen = createRuntime({
    innerHeight: 1536,
    clientHeight: 1536,
    visualHeight: 1455
  });
  assert.equal(
    fullscreen.properties.get("--calculator-viewport-height"),
    "1455px",
    "Android fullscreenで画面全高より短い実可視領域を使用します"
  );

  fullscreen.visualViewport.height = 1420;
  fullscreen.dispatchViewportResize();
  fullscreen.dispatchWindowResize();
  assert.equal(fullscreen.frames.length, 1, "連続resizeを1フレームへまとめます");
  fullscreen.runFrame();
  assert.equal(fullscreen.properties.get("--calculator-viewport-height"), "1420px");
}

{
  const standardBrowser = createRuntime({
    innerHeight: 820,
    clientHeight: 820,
    visualHeight: null
  });
  assert.equal(
    standardBrowser.properties.get("--calculator-viewport-height"),
    "820px",
    "VisualViewport非対応ブラウザではlayout viewportへ安全にフォールバックします"
  );
}

{
  const zoomed = createRuntime({
    innerHeight: 820,
    clientHeight: 820,
    visualHeight: 410,
    visualScale: 2
  });
  assert.equal(
    zoomed.properties.get("--calculator-viewport-height"),
    "820px",
    "ピンチズーム中はvisual viewportに合わせてレイアウトを縮めません"
  );
}

process.stdout.write("電卓のfullscreen可視領域・safe area・低い画面・通常ブラウザ回帰テストに成功しました。\n");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [client, html] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8")
]);

assert.match(client, /function shouldKeepScreenAwake\(\)/);
assert.match(client, /state\.uploading \|\| state\.activeFolderUploadOperationId/);
assert.match(client, /state\.downloadActive && \$\("#keep-screen-awake"\)\?\.checked/);
assert.match(client, /async function requestTransferWakeLock\(\)/);
assert.match(client, /async function syncTransferWakeLock\(\)/);
assert.match(client, /document\.addEventListener\("visibilitychange", handleTransferVisibility\)/);
assert.match(client, /setTransferWakeLockStatus\("消灯防止中", "active"\)/);
assert.match(client, /setTransferWakeLockStatus\("消灯防止を開始できませんでした/);
assert.doesNotMatch(client, /requestDownloadWakeLock|releaseDownloadWakeLock|handleDownloadVisibility/);

const folderUpload = client.match(/async function uploadSelectedFolder\(event\) \{[\s\S]*?\r?\n\}\r?\n\r?\nfunction waitForInterfacePaint/)?.[0] || "";
assert.ok(folderUpload.indexOf("await syncTransferWakeLock()") < folderUpload.indexOf("await planFolderUpload"), "フォルダ差分確認前に消灯防止を開始してください。");
assert.match(folderUpload, /state\.uploading = false;[\s\S]*?await syncTransferWakeLock\(\)/);

const fileUpload = client.match(/async function uploadFiles\(files, destinations = null, options = \{\}\) \{[\s\S]*?\r?\n\}\r?\n\r?\nasync function uploadOne/)?.[0] || "";
assert.ok(fileUpload.indexOf("await syncTransferWakeLock()") < fileUpload.indexOf("excludeExistingUploadFiles"), "ファイル差分確認前に消灯防止を開始してください。");
assert.match(fileUpload, /state\.uploading = false;[\s\S]*?await syncTransferWakeLock\(\)/);

assert.match(html, /id="upload-wake-lock-status"[^>]*>消灯防止を準備しています。/);
assert.match(html, /cloud\.js\?v=20260810-107/);

const wakeLockFunctions = client.match(/function uploadKeepsScreenAwake\(\) \{[\s\S]*?\r?\n\}\r?\n\r?\nfunction renderBreadcrumbs/)?.[0]
  .replace(/\r?\n\r?\nfunction renderBreadcrumbs$/, "") || "";
assert.ok(wakeLockFunctions, "消灯防止の共通処理を読み取れませんでした。");

const elements = {
  "download-retry-wake": { hidden: true },
  "keep-screen-awake": { checked: true },
  "upload-wake-lock-status": { textContent: "", dataset: {} },
  "wake-lock-status": { textContent: "" }
};
const locks = [];
let requestCount = 0;
const context = vm.createContext({
  console,
  state: {
    uploading: false,
    activeFolderUploadOperationId: null,
    downloadActive: false,
    wakeLock: null,
    wakeLockRequest: null
  },
  document: { visibilityState: "visible" },
  navigator: {
    wakeLock: {
      async request() {
        requestCount++;
        const lock = {
          released: false,
          listener: null,
          addEventListener(_event, listener) { this.listener = listener; },
          async release() {
            if (this.released) return;
            this.released = true;
            this.listener?.();
          }
        };
        locks.push(lock);
        return lock;
      }
    }
  },
  $: (selector) => elements[selector.slice(1)] || null
});
vm.runInContext(wakeLockFunctions, context);

await vm.runInContext("state.uploading = true; syncTransferWakeLock()", context);
assert.equal(requestCount, 1);
assert.equal(elements["upload-wake-lock-status"].textContent, "消灯防止中");

context.document.visibilityState = "hidden";
await locks.at(-1).release();
assert.match(elements["upload-wake-lock-status"].textContent, /画面へ戻ると/);
context.document.visibilityState = "visible";
await vm.runInContext("handleTransferVisibility()", context);
assert.equal(requestCount, 2, "画面へ戻ったら消灯防止を再取得してください。");

await vm.runInContext("state.uploading = false; syncTransferWakeLock()", context);
assert.equal(locks.at(-1).released, true);
assert.equal(elements["upload-wake-lock-status"].textContent, "消灯防止を終了しました。");

await vm.runInContext("state.downloadActive = true; syncTransferWakeLock()", context);
assert.equal(requestCount, 3, "ダウンロードも同じ消灯防止処理を使用してください。");
elements["keep-screen-awake"].checked = false;
await vm.runInContext("syncTransferWakeLock()", context);
assert.equal(locks.at(-1).released, true);

console.log("shared upload and download wake lock lifecycle: ok");

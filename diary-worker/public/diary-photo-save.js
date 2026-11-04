const STORAGE_PREFIX = "troom-diary-photo-save-v1:";
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const PHOTO_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function photoSaveMethod(browser = window, device = navigator) {
  const appleMobile = /iPhone|iPad|iPod/i.test(device.userAgent || "")
    || (device.platform === "MacIntel" && device.maxTouchPoints > 1);
  const mobile = appleMobile || device.userAgentData?.mobile === true || /Android|Mobile/i.test(device.userAgent || "");
  if (!mobile && typeof browser.showDirectoryPicker === "function") return "folder";
  if (appleMobile && typeof device.share === "function" && typeof device.canShare === "function") {
    try {
      if (device.canShare({ files: [new File([new Uint8Array([0])], "photo.jpg", { type: "image/jpeg" })] })) return "share";
    } catch { /* Use individual downloads if file sharing is unavailable. */ }
  }
  return "browser";
}

export function validSaveDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function photoSaveFolderName(from, to) {
  return from === to ? `写真_${from}` : `写真_${from}～${to}`;
}

function validFolderName(name, from, to) {
  if (typeof name !== "string" || name.length > 180) return false;
  const base = photoSaveFolderName(from, to);
  return name === base || (name.startsWith(base) && /^ \((?:[2-9]|[1-9]\d+)\)$/.test(name.slice(base.length)));
}

// File names are only held in memory. Persist IDs and acknowledged progress,
// never image bytes, diary text, credentials, directory handles or permissions.
export function readSaveRecord(value, now = Date.now()) {
  try {
    const data = JSON.parse(value);
    if (data?.version !== 1 || !Number.isFinite(data.updatedAt) || data.updatedAt > now
      || now - data.updatedAt > MAX_AGE || !validSaveDate(data.from) || !validSaveDate(data.to) || data.from > data.to
      || !Array.isArray(data.ids) || !data.ids.length || data.ids.length > 100000
      || data.ids.some(id => typeof id !== "string" || !PHOTO_ID.test(id)) || new Set(data.ids).size !== data.ids.length
      || !Array.isArray(data.done) || new Set(data.done).size !== data.done.length) return null;
    const ids = new Set(data.ids);
    if (data.done.some(id => !ids.has(id))) return null;
    if (data.folderName !== undefined && !validFolderName(data.folderName, data.from, data.to)) return null;
    return { version: 1, from: data.from, to: data.to, ids: data.ids, done: data.done, updatedAt: data.updatedAt,
      ...(data.folderName === undefined ? {} : { folderName: data.folderName }) };
  } catch { return null; }
}

function numberedName(name, number) {
  const index = name.lastIndexOf(".");
  const stem = index > 0 ? name.slice(0, index) : name;
  const extension = index > 0 ? name.slice(index) : "";
  return `${stem} (${number})${extension}`;
}

export function savedFileNames(photos) {
  const used = new Set();
  return photos.map(photo => {
    let name = String(photo.fileName || "photo").normalize("NFC")
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").replace(/[. ]+$/, "") || "photo";
    if (name.length > 180) {
      const extension = name.match(/\.[^.]{1,16}$/)?.[0] || "";
      name = name.slice(0, 180 - extension.length).replace(/[. ]+$/, "") + extension;
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    const original = name;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = numberedName(original, n);
    used.add(name.toLowerCase());
    return name;
  });
}

export function createPhotoSaveManager({ api, dialogs, getOwner, getDefaultRange, formatBytes, onSessionExpired, onNotice, bindDateInput }) {
  const node = id => document.getElementById(`photo-save-${id}`);
  const nodes = Object.fromEntries(["dialog", "from", "to", "fallback", "status", "help", "start", "pause", "retry", "reset"].map(id => [id, node(id)]));
  let owner = "", epoch = 0, controller, job = null, photos = [], finished = new Set(), batch = [], files = [];
  let phase = "idle", working = false, loading = false, message = "", directory, storageAvailable = true, totalSize = 0;
  let method = photoSaveMethod(), fallbackAvailable = false, downloadUrl = null;
  let closing = false;
  const operations = new Set();
  function clearFiles() {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null; files = []; batch = [];
  }
  const key = () => STORAGE_PREFIX + owner;
  const pending = () => job ? job.ids.filter(id => !finished.has(id)) : [];
  const current = version => version === epoch && owner && owner === getOwner();
  function assertCurrent(version) { if (!current(version)) throw new DOMException("保存処理を中断しました。", "AbortError"); }
  function persist() {
    if (!job || !owner) return;
    try { localStorage.setItem(key(), JSON.stringify({ ...job, done: [...finished], updatedAt: Date.now() })); }
    catch { storageAvailable = false; }
  }
  function discardRecord() {
    if (owner) { try { localStorage.removeItem(key()); } catch { storageAvailable = false; } }
  }
  function render() {
    nodes.from.disabled = nodes.to.disabled = Boolean(job) || working || closing;
    for (const button of nodes.dialog.querySelectorAll("[data-date-picker-target]")) button.disabled = Boolean(job) || working || closing;
    nodes.fallback.hidden = !fallbackAvailable;
    nodes.fallback.disabled = working || loading || closing;
    nodes.start.hidden = phase === "done";
    nodes.start.disabled = loading || working || closing || phase === "unavailable" || (!job && !photos.length);
    nodes.start.textContent = working ? "処理中…" : phase === "ready" ? "この写真を保存"
      : phase === "confirm" ? "保存できたので次へ" : job ? "未完了分を再開" : "保存を開始";
    nodes.pause.hidden = !working;
    nodes.pause.disabled = closing;
    nodes.retry.hidden = phase !== "confirm";
    nodes.retry.disabled = working || closing;
    nodes.reset.hidden = !job;
    nodes.reset.disabled = working || closing;
    const progress = job ? `${finished.size.toLocaleString()} / ${job.ids.length.toLocaleString()}枚・${formatBytes(totalSize)}` :
      photos.length ? `${photos.length.toLocaleString()}枚・${formatBytes(totalSize)}` : "";
    nodes.status.textContent = [progress, message, !storageAvailable ? "この環境では再開記録を保持できません。" : ""].filter(Boolean).join("　");
    nodes.help.textContent = method === "folder" ? job && !job.folderName
      ? "前回の保存先フォルダを選んでください。未完了の元画像を保存します。同名ファイルは上書きしません。"
      : `保存先の親フォルダを選んでください。その中の「${job?.folderName || photoSaveFolderName(nodes.from.value, nodes.to.value)}」へ元画像を保存します。新規保存で同名フォルダがある場合は連番にします。`
      : method === "share" ? "写真を1枚ずつ保存します。端末の保存画面で保存し、保存できたことを確認して次へ進んでください。元ファイルをそのまま残す場合は「ファイルに保存」を選んでください。"
      : "写真を1枚ずつダウンロードします。保存できたことを確認して次へ進んでください。フォルダへまとめて保存する場合はPC版Chrome・Edgeをご利用ください。";
  }
  function suspend() {
    if (closing) discardRecord(); else persist();
    epoch++; controller?.abort(); controller = null;
    working = loading = closing = false; directory = null; clearFiles(); job = null; photos = []; totalSize = 0; finished = new Set(); owner = "";
    method = photoSaveMethod(); fallbackAvailable = false;
    phase = "idle"; message = ""; render();
  }
  function pause() {
    if (closing) return;
    epoch++; controller?.abort(); controller = null; working = loading = false;
    phase = job ? "paused" : "idle"; clearFiles();
    message = "一時停止しました。未完了分から再開できます。"; persist(); render();
  }
  async function loadList() {
    const version = ++epoch;
    controller?.abort(); controller = new AbortController(); loading = true; photos = []; totalSize = 0;
    message = "対象の写真を確認しています…"; render();
    try {
      const from = nodes.from.value, to = nodes.to.value;
      if (!validSaveDate(from) || !validSaveDate(to) || from > to) throw new Error("開始日と終了日を正しい順序で選択してください。");
      const result = await api(`/photos/save-list?${new URLSearchParams({ dateFrom: from, dateTo: to })}`, { signal: controller.signal });
      assertCurrent(version);
      if (!Array.isArray(result.photos) || result.photos.some(p => !PHOTO_ID.test(p.id) || !Number.isSafeInteger(p.originalSize) || p.originalSize < 0)
        || new Set(result.photos.map(p => p.id)).size !== result.photos.length) throw new Error("対象の写真を確認できませんでした。もう一度開いてください。");
      const names = savedFileNames(result.photos);
      photos = result.photos.map((photo, i) => ({ ...photo, saveName: names[i] }));
      const available = new Set(photos.map(photo => photo.id));
      if (job && pending().some(id => !available.has(id))) {
        photos = []; throw new Error("未完了の写真が削除・変更されています。期間を選び直してください。");
      }
      const savedIds = job && new Set(job.ids);
      totalSize = photos.reduce((sum, photo) => sum + (!savedIds || savedIds.has(photo.id) ? photo.originalSize : 0), 0);
      message = phase === "done" ? "元画像の保存が完了しました。" : job ? "前回の未完了分を再開できます。" : photos.length ? "日記の日付で選択しています。ZIPにはまとめません。" : "指定した期間に写真はありません。";
    } catch (error) {
      if (current(version)) { message = error.message; if (job) phase = "unavailable"; }
    } finally { if (current(version)) { loading = false; render(); } }
  }
  function prepareOpen() {
    if (!owner || owner !== getOwner()) {
      suspend(); owner = getOwner(); storageAvailable = true;
      try { job = readSaveRecord(localStorage.getItem(key())); } catch { storageAvailable = false; }
      finished = new Set(job?.done || []);
      phase = job ? pending().length ? "paused" : "done" : "idle";
      const range = job || getDefaultRange();
      nodes.from.value = range.from; nodes.to.value = range.to;
    }
  }
  async function open() {
    prepareOpen();
    if (!dialogs.open("photo-save-dialog")) return;
    nodes.dialog.scrollTop = 0;
    render();
    if (!working && phase !== "ready" && phase !== "confirm") await loadList();
  }
  function restore() {
    if (closing || working || !getOwner()) return false;
    prepareOpen();
    render();
    void loadList();
    requestAnimationFrame(() => { nodes.dialog.scrollTop = 0; });
    return true;
  }
  function canClose() {
    if (closing) return false;
    if ((working || files.length || pending().length) && !window.confirm("保存を中断して閉じますか？未完了分の再開情報を破棄します。保存済みの写真ファイルは残ります。")) return false;
    if (!operations.size) return true;
    // Invalidate callbacks first, then wait for the writable stream / native
    // handoff to settle before closing. Nothing may write after the screen closes.
    closing = true;
    const version = ++epoch;
    controller?.abort(); clearFiles();
    message = "保存を中断しています…"; render();
    void Promise.allSettled([...operations]).then(() => {
      if (!current(version) || !closing) return;
      working = false;
      void dialogs.close("photo-save-dialog", { force: true });
    });
    return false;
  }
  function onClose() {
    epoch++; controller?.abort(); controller = null;
    discardRecord();
    owner = ""; job = null; finished = new Set(); photos = []; totalSize = 0;
    working = loading = closing = false; directory = null; clearFiles();
    method = photoSaveMethod(); fallbackAvailable = false; phase = "idle"; message = "";
    const range = getDefaultRange(); nodes.from.value = range.from; nodes.to.value = range.to;
    nodes.dialog.scrollTop = 0; render();
  }
  function chooseBatch() {
    const id = pending()[0];
    const photo = photos.find(photo => photo.id === id);
    if (!photo) throw new Error("対象の写真が変更されました。期間を選び直してください。");
    return [photo];
  }
  async function original(photo, version) {
    const response = await fetch(`/diary/api/photos/${photo.id}/original?download=1`, {
      credentials: "same-origin", cache: "no-store", signal: controller.signal
    });
    assertCurrent(version);
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) onSessionExpired();
      throw new Error(response.status === 401 ? "ログインして未完了分を再開してください。" : `元画像を取得できませんでした（${response.status}）。未完了分から再開できます。`);
    }
    return response;
  }
  async function writeOriginal(photo, version) {
    const response = await original(photo, version);
    let name = photo.saveName, handle;
    // Never request a writable stream for an existing file.
    for (let n = 2; ; n++) {
      assertCurrent(version);
      try { await directory.getFileHandle(name); name = numberedName(photo.saveName, n); }
      catch (error) {
        if (error.name === "NotFoundError") break;
        if (error.name === "TypeMismatchError") { name = numberedName(photo.saveName, n); continue; }
        throw error;
      }
    }
    assertCurrent(version);
    handle = await directory.getFileHandle(name, { create: true });
    assertCurrent(version);
    const writable = await handle.createWritable();
    try {
      assertCurrent(version);
      await response.body.pipeTo(writable, { signal: controller.signal });
      assertCurrent(version);
      if ((await handle.getFile()).size !== photo.originalSize) throw new Error("保存した画像のサイズが一致しません。未完了分から再開してください。");
    } catch (error) { await writable.abort().catch(() => {}); throw error; }
  }
  async function targetDirectory(parent, version) {
    // Old checkpoints wrote directly to the picked directory; keep their layout.
    if (job && !job.folderName) return { handle: parent };
    if (job?.folderName) {
      const handle = await parent.getDirectoryHandle(job.folderName);
      assertCurrent(version);
      return { handle, folderName: job.folderName };
    }
    const base = photoSaveFolderName(nodes.from.value, nodes.to.value);
    let folderName = base;
    for (let n = 2; ; n++) {
      assertCurrent(version);
      try { await parent.getDirectoryHandle(folderName); }
      catch (error) {
        if (error.name === "NotFoundError") break;
        if (error.name !== "TypeMismatchError") throw error;
      }
      folderName = numberedName(base, n);
    }
    assertCurrent(version);
    const handle = await parent.getDirectoryHandle(folderName, { create: true });
    assertCurrent(version);
    return { handle, folderName };
  }
  async function run(version) {
    try {
      if (method === "folder") {
        const byId = new Map(photos.map(photo => [photo.id, photo]));
        for (const id of pending()) {
          await writeOriginal(byId.get(id), version); assertCurrent(version);
          finished.add(id); persist(); message = "元画像を保存しています…"; render();
        }
        phase = "done"; message = "元画像の保存が完了しました。";
      } else {
        batch = chooseBatch();
        const photo = batch[0];
        const response = await original(photo, version);
        const blob = await response.blob(); assertCurrent(version);
        if (blob.size !== photo.originalSize) throw new Error("取得した元画像のサイズが一致しません。もう一度お試しください。");
        files = [new File([blob], photo.saveName, { type: photo.contentType || blob.type })];
        if (method === "share" && !navigator.canShare({ files })) {
          fallbackAvailable = true;
          throw new Error("この写真は端末の保存画面へ渡せません。「1枚ずつダウンロードする」をお試しください。");
        }
        phase = "ready"; message = "元画像を1枚準備しました。「この写真を保存」を押してください。";
      }
      if (!nodes.dialog.open) onNotice(message);
    } catch (error) {
      if (current(version)) { controller?.abort(); phase = "paused"; clearFiles(); fallbackAvailable = method !== "browser"; message = error.message; persist(); }
    } finally { if (current(version)) { working = false; render(); } }
  }
  async function start() {
    if (working || loading || phase === "done" || phase === "unavailable") return;
    if (phase === "confirm") {
      for (const photo of batch) finished.add(photo.id);
      clearFiles(); persist();
      phase = pending().length ? "paused" : "done";
      message = phase === "done" ? "全画像の保存確認が完了しました。" : "次の元画像を準備します…";
      render(); if (phase === "done") return;
    }
    if (phase === "ready") {
      // Both OS sharing and downloads run directly in this user click.
      const version = epoch;
      working = true;
      try {
        if (method === "share") {
          const shared = navigator.share({ files }); render(); await shared; assertCurrent(version);
        } else {
          downloadUrl ||= URL.createObjectURL(files[0]);
          const link = document.createElement("a");
          link.href = downloadUrl; link.download = files[0].name;
          link.hidden = true; document.body.append(link); link.click(); link.remove();
        }
        phase = "confirm";
        message = "1枚を保存画面へ渡しました。実際に保存できたことを確認してください。";
      } catch (error) {
        if (current(version)) {
          message = error.name === "AbortError" ? "保存画面を閉じました。もう一度開けます。" : "保存画面を開けませんでした。「1枚ずつダウンロードする」をお試しください。";
          if (error.name !== "AbortError") { phase = "paused"; clearFiles(); fallbackAvailable = method !== "browser"; }
        }
      }
      finally { if (current(version)) { working = false; render(); } }
      return;
    }
    if (!photos.length) return;
    const version = ++epoch;
    working = true; message = "保存を準備しています…"; render();
    try {
      let folderName;
      if (method === "folder") {
        // The picker also requires user activation; call it before a fetch/await.
        const picked = window.showDirectoryPicker({ mode: "readwrite", id: "diary-photo-save" });
        const parent = await picked; assertCurrent(version);
        const target = await targetDirectory(parent, version); assertCurrent(version);
        directory = target.handle; folderName = target.folderName; fallbackAvailable = false;
      }
      if (!job) { job = { version: 1, from: nodes.from.value, to: nodes.to.value, ids: photos.map(photo => photo.id),
        ...(folderName ? { folderName } : {}) }; finished = new Set(); persist(); }
      controller = new AbortController(); phase = "running"; render();
      await run(version);
    } catch (error) {
      if (current(version)) { working = false; fallbackAvailable = method === "folder" && error.name !== "AbortError"; message = error.name === "AbortError" ? "保存先の選択を閉じました。" : job?.folderName && error.name === "NotFoundError" ? "前回の写真フォルダが見つかりません。前回選んだ親フォルダを指定してください。" : "フォルダに保存できませんでした。再試行するか「1枚ずつダウンロードする」をお試しください。"; render(); }
    }
  }
  function reset() {
    if (working || closing) return;
    try { localStorage.removeItem(key()); } catch { storageAvailable = false; }
    epoch++; controller?.abort(); job = null; finished = new Set(); clearFiles(); directory = null;
    method = photoSaveMethod(); fallbackAvailable = false;
    phase = "idle"; void loadList();
  }
  for (const input of [nodes.from, nodes.to]) {
    bindDateInput(input);
    input.addEventListener("change", () => { if (!job) void loadList(); });
  }
  nodes.fallback.addEventListener("click", () => {
    if (working || loading) return;
    clearFiles(); directory = null; method = "browser"; fallbackAvailable = false;
    phase = job ? "paused" : "idle"; message = "写真を1枚ずつダウンロードします。"; render();
  });
  nodes.start.addEventListener("click", () => {
    if (closing) return;
    const operation = start(); operations.add(operation);
    operation.then(() => operations.delete(operation), () => operations.delete(operation));
  });
  nodes.pause.addEventListener("click", pause);
  nodes.retry.addEventListener("click", () => { clearFiles(); phase = "paused"; message = "未確認の分を再試行できます。重複保存にご注意ください。"; render(); });
  nodes.reset.addEventListener("click", reset);
  window.addEventListener("pagehide", () => { if (owner) pause(); });
  return { open, restore, canClose, onClose, suspend, get busy() { return working || closing || files.length > 0; } };
}

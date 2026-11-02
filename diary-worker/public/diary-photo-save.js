const STORAGE_PREFIX = "troom-diary-photo-save-v1:";
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const BATCH_COUNT = 10;
const BATCH_BYTES = 32 * 1024 * 1024;
const PHOTO_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function validSaveDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
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
    return { version: 1, from: data.from, to: data.to, ids: data.ids, done: data.done, updatedAt: data.updatedAt };
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

export function createPhotoSaveManager({ api, dialogs, getOwner, getDefaultRange, formatBytes, onSessionExpired, onNotice }) {
  const node = id => document.getElementById(`photo-save-${id}`);
  const nodes = Object.fromEntries(["dialog", "from", "to", "method", "status", "help", "start", "pause", "retry", "reset"].map(id => [id, node(id)]));
  let owner = "", epoch = 0, controller, job = null, photos = [], finished = new Set(), batch = [], files = [];
  let phase = "idle", working = false, loading = false, message = "", directory, storageAvailable = true;
  const key = () => STORAGE_PREFIX + owner;
  const pending = () => job ? job.ids.filter(id => !finished.has(id)) : [];
  const current = version => version === epoch && owner && owner === getOwner();
  function assertCurrent(version) { if (!current(version)) throw new DOMException("保存処理を中断しました。", "AbortError"); }
  function persist() {
    if (!job || !owner) return;
    try { localStorage.setItem(key(), JSON.stringify({ ...job, done: [...finished], updatedAt: Date.now() })); }
    catch { storageAvailable = false; }
  }
  function render() {
    nodes.from.disabled = nodes.to.disabled = Boolean(job) || working;
    for (const button of nodes.dialog.querySelectorAll("[data-date-picker-target]")) button.disabled = Boolean(job) || working;
    nodes.method.disabled = working || phase === "ready" || phase === "confirm";
    nodes.start.hidden = phase === "done";
    nodes.start.disabled = loading || working || phase === "unavailable" || (!job && !photos.length);
    nodes.start.textContent = working ? "処理中…" : phase === "ready" ? "保存画面を開く"
      : phase === "confirm" ? "保存できたので次へ" : job ? "未完了分を再開" : "保存を開始";
    nodes.pause.hidden = !working;
    nodes.retry.hidden = phase !== "confirm";
    nodes.reset.hidden = !job;
    nodes.reset.disabled = working;
    const progress = job ? `${finished.size.toLocaleString()} / ${job.ids.length.toLocaleString()}枚` :
      photos.length ? `${photos.length.toLocaleString()}枚・${formatBytes(photos.reduce((sum, photo) => sum + photo.originalSize, 0))}` : "";
    nodes.status.textContent = [progress, message, !storageAvailable ? "この環境では再開記録を保持できません。" : ""].filter(Boolean).join("　");
    const method = nodes.method.value;
    nodes.help.textContent = method === "folder" ? "選んだフォルダへ元画像を1枚ずつ保存します。同名ファイルは上書きしません。"
      : method === "share" ? "元画像を小分けに準備します。保存画面で保存先を選び、保存できたことを確認して次へ進んでください。元ファイルをそのまま残す場合は「ファイルに保存」を選んでください。"
      : "複数ファイルのダウンロードを求められたら許可してください。小分けにブラウザへ渡すため、端末への保存を確認して次へ進んでください。";
  }
  function suspend() {
    persist(); epoch++; controller?.abort(); controller = null;
    working = loading = false; directory = null; files = []; batch = []; job = null; photos = []; finished = new Set(); owner = "";
    phase = "idle"; message = ""; render();
  }
  function pause() {
    epoch++; controller?.abort(); controller = null; working = loading = false;
    phase = job ? "paused" : "idle"; files = []; batch = [];
    message = "一時停止しました。未完了分から再開できます。"; persist(); render();
  }
  async function loadList() {
    const version = ++epoch;
    controller?.abort(); controller = new AbortController(); loading = true; photos = [];
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
      message = phase === "done" ? "元画像の保存が完了しました。" : job ? "前回の未完了分を再開できます。" : photos.length ? "日記の日付で選択しています。ZIPにはまとめません。" : "指定した期間に写真はありません。";
    } catch (error) {
      if (current(version)) { message = error.message; if (job) phase = "unavailable"; }
    } finally { if (current(version)) { loading = false; render(); } }
  }
  async function open() {
    if (!owner || owner !== getOwner()) {
      suspend(); owner = getOwner(); storageAvailable = true;
      try { job = readSaveRecord(localStorage.getItem(key())); } catch { storageAvailable = false; }
      finished = new Set(job?.done || []);
      phase = job ? pending().length ? "paused" : "done" : "idle";
      const range = job || getDefaultRange();
      nodes.from.value = range.from; nodes.to.value = range.to;
    }
    dialogs.open("photo-save-dialog");
    render();
    if (!working && phase !== "ready" && phase !== "confirm") await loadList();
  }
  function chooseBatch() {
    const byId = new Map(photos.map(photo => [photo.id, photo]));
    const selected = []; let bytes = 0;
    for (const id of pending()) {
      const photo = byId.get(id);
      if (!photo) throw new Error("対象の写真が変更されました。期間を選び直してください。");
      if (selected.length && (selected.length >= BATCH_COUNT || bytes + photo.originalSize > BATCH_BYTES)) break;
      selected.push(photo); bytes += photo.originalSize;
    }
    return selected;
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
  async function run(version) {
    try {
      const method = nodes.method.value;
      if (method === "folder") {
        const byId = new Map(photos.map(photo => [photo.id, photo]));
        for (const id of pending()) {
          await writeOriginal(byId.get(id), version); assertCurrent(version);
          finished.add(id); persist(); message = "元画像を保存しています…"; render();
        }
        phase = "done"; message = "元画像の保存が完了しました。";
      } else {
        batch = chooseBatch(); files = [];
        for (const photo of batch) {
          assertCurrent(version);
          if (method === "share") {
            const response = await original(photo, version);
            const blob = await response.blob(); assertCurrent(version);
            if (blob.size !== photo.originalSize) throw new Error("取得した元画像のサイズが一致しません。もう一度お試しください。");
            files.push(new File([blob], photo.saveName, { type: photo.contentType || blob.type }));
          } else {
            const link = document.createElement("a");
            link.href = `/diary/api/photos/${photo.id}/original?download=1`; link.download = photo.saveName;
            link.hidden = true; document.body.append(link); link.click(); link.remove();
            await new Promise(resolve => setTimeout(resolve, 800));
          }
        }
        assertCurrent(version);
        if (method === "share") {
          if (!navigator.canShare?.({ files })) throw new Error("この形式・枚数は保存画面へ渡せません。保存方法を「ブラウザでダウンロード」に変更してください。");
          phase = "ready"; message = `${files.length}枚の元画像を準備しました。「保存画面を開く」を押してください。`;
        } else {
          phase = "confirm"; message = `${batch.length}枚をブラウザへ渡しました。端末への保存はまだ確認できていません。`;
        }
      }
      if (!nodes.dialog.open) onNotice(message);
    } catch (error) {
      if (current(version)) { controller?.abort(); phase = "paused"; files = []; batch = []; message = error.message; persist(); }
    } finally { if (current(version)) { working = false; render(); } }
  }
  async function start() {
    if (working || loading || phase === "done" || phase === "unavailable") return;
    if (phase === "confirm") {
      for (const photo of batch) finished.add(photo.id);
      files = []; batch = []; persist();
      phase = pending().length ? "paused" : "done";
      message = phase === "done" ? "全画像の保存確認が完了しました。" : "次の元画像を準備します…";
      render(); if (phase === "done") return;
    }
    if (phase === "ready") {
      // Invoke share directly within this click, before any asynchronous work.
      const version = epoch;
      working = true;
      try {
        const shared = navigator.share({ files }); render(); await shared; assertCurrent(version);
        files = []; phase = "confirm";
        message = `${batch.length}枚を保存画面へ渡しました。実際に保存できたことを確認してください。`;
      } catch (error) {
        if (current(version)) {
          message = error.name === "AbortError" ? "保存画面を閉じました。もう一度開けます。" : "保存画面を開けませんでした。保存方法を変更して再試行できます。";
          if (error.name !== "AbortError") { phase = "paused"; files = []; batch = []; }
        }
      }
      finally { if (current(version)) { working = false; render(); } }
      return;
    }
    if (!photos.length) return;
    const version = ++epoch;
    working = true; message = "保存を準備しています…"; render();
    try {
      if (nodes.method.value === "folder") {
        // The picker also requires user activation; call it before a fetch/await.
        const picked = window.showDirectoryPicker({ mode: "readwrite", id: "diary-photo-save" });
        directory = await picked; assertCurrent(version);
      }
      if (!job) { job = { version: 1, from: nodes.from.value, to: nodes.to.value, ids: photos.map(photo => photo.id) }; finished = new Set(); persist(); }
      controller = new AbortController(); phase = "running"; render();
      await run(version);
    } catch (error) {
      if (current(version)) { working = false; message = error.name === "AbortError" ? "保存先の選択を閉じました。" : error.message; render(); }
    }
  }
  function reset() {
    if (working) return;
    try { localStorage.removeItem(key()); } catch { storageAvailable = false; }
    epoch++; controller?.abort(); job = null; finished = new Set(); files = []; batch = []; directory = null;
    phase = "idle"; void loadList();
  }
  const methods = [["folder", "フォルダに保存", typeof window.showDirectoryPicker === "function"],
    ["share", "端末の保存画面を使う", typeof navigator.share === "function" && navigator.canShare?.({ files: [new File([new Uint8Array([0])], "photo.jpg", { type: "image/jpeg" })] })],
    ["browser", "ブラウザでダウンロード", true]];
  nodes.method.replaceChildren(...methods.filter(([, , supported]) => supported).map(([value, label]) => {
    const option = document.createElement("option"); option.value = value; option.textContent = label; return option;
  }));
  for (const input of [nodes.from, nodes.to]) {
    input.addEventListener("change", () => { if (!job) void loadList(); });
    const button = nodes.dialog.querySelector(`[data-date-picker-target="${input.id}"]`);
    input.addEventListener("click", () => button.click());
    input.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); button.click(); } });
  }
  nodes.start.addEventListener("click", () => { void start(); });
  nodes.pause.addEventListener("click", pause);
  nodes.retry.addEventListener("click", () => { files = []; batch = []; phase = "paused"; message = "未確認の分を再試行できます。重複保存にご注意ください。"; render(); });
  nodes.reset.addEventListener("click", reset);
  nodes.method.addEventListener("change", render);
  window.addEventListener("pagehide", () => { if (owner) pause(); });
  return { open, suspend, get busy() { return working || files.length > 0; } };
}

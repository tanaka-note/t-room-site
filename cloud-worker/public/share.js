const token = location.pathname.match(/\/cloud\/share\/([A-Za-z0-9_-]{43})\/?$/)?.[1] || "";
const API = `/cloud/api/public/shares/${token}`;
const state = { info: null, targetKey: null, targetType: "", rootId: null, folderId: null, folderKeys: new Map(), path: [], files: [], selected: null, selectedFiles: new Map(), previewUrl: "", previewMediaToken: "", previewPlayer: null, previewHistoryActive: false, handlingPopState: false, historyReady: false, downloadActive: false, downloadAbort: null, wakeLock: null };
const $ = (selector) => document.querySelector(selector);

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  bindEvents();
  if (!token) return failUnlock("共有URLを確認してください。");
  try {
    state.info = await api("");
    state.targetType = state.info.targetType;
    $("#share-expiry").textContent = `有効期限：${formatEpoch(state.info.expiresAt)}`;
  } catch (error) {
    $("#unlock-copy").textContent = "この共有URLは利用できません。";
    failUnlock(error.message);
    $("#share-password").disabled = true;
    $("#unlock-form button[type=submit]").disabled = true;
  }
}

function bindEvents() {
  $("#unlock-form").addEventListener("submit", unlockShare);
  $("#toggle-password").addEventListener("click", () => {
    const input = $("#share-password");
    input.type = input.type === "password" ? "text" : "password";
    $("#toggle-password").setAttribute("aria-label", input.type === "password" ? "パスワードを表示" : "パスワードを隠す");
  });
  $("#download-button").addEventListener("click", downloadSelected);
  $("#share-selection-clear").addEventListener("click", clearFileSelection);
  $("#share-selection-download").addEventListener("click", downloadFileSelection);
  $("#share-selection-cancel").addEventListener("click", cancelSharedDownloads);
  $("#share-download-retry-wake").addEventListener("click", requestDownloadWakeLock);
  $("#share-keep-screen-awake").addEventListener("change", async (event) => {
    if (event.target.checked && state.downloadActive) await requestDownloadWakeLock();
    else await releaseDownloadWakeLock();
  });
  document.addEventListener("visibilitychange", handleDownloadVisibility);
  window.addEventListener("popstate", handleShareHistoryNavigation);
  $("#history-button").addEventListener("click", openHistory);
  document.querySelectorAll(".close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $("#preview-dialog").addEventListener("close", handlePreviewClosed);
}

async function unlockShare(event) {
  event.preventDefault();
  const button = event.submitter || $("#unlock-form button[type='submit']");
  button.disabled = true;
  failUnlock("");
  try {
    const password = $("#share-password").value;
    const authProof = await TRoomCrypto.deriveShareAuthProof(state.info, password);
    await api("/unlock", { method: "POST", body: JSON.stringify({ authProof }) });
    const unlocked = await TRoomCrypto.unlockShareKey(state.info, password);
    state.targetKey = unlocked.targetKey;
    $("#share-password").value = "";
    $("#unlock-view").hidden = true;
    $("#browser-view").hidden = false;
    await loadItems(null, null, { historyMode: "replace" });
  } catch (error) {
    failUnlock(error.message.includes("復号") || error.message.includes("暗号化") ? "共有パスワードが違います。" : error.message);
  } finally { button.disabled = false; }
}

async function loadItems(folderId = null, pathIndex = null, options = {}) {
  setNotice("");
  clearFileSelection();
  try {
    const query = folderId ? `?folderId=${folderId}` : "";
    const data = await api(`/items${query}`);
    if (data.targetType === "file") {
      const file = await hydrateSharedFile(data.file, state.targetKey);
      state.files = [file];
      state.rootId = null;
      state.path = [];
      $("#target-title").textContent = file.name;
      renderBreadcrumbs();
      renderItems([], [file]);
    } else {
      state.rootId = Number(data.rootFolderId);
      const folder = data.folder;
      let folderKey;
      if (Number(folder.id) === state.rootId) {
        folderKey = state.targetKey;
        state.folderKeys.set(Number(folder.id), folderKey);
      } else {
        folderKey = state.folderKeys.get(Number(folder.id));
        if (!folderKey) {
          const parentKey = state.folderKeys.get(Number(folder.parentId));
          if (!parentKey) throw new Error("共有フォルダの移動情報を確認できません。");
          folderKey = await TRoomCrypto.unlockFolderFromParent(folder, parentKey);
          state.folderKeys.set(Number(folder.id), folderKey);
        }
      }
      const folderName = folder.name;
      if (Array.isArray(options.historyPath)) state.path = options.historyPath.map((item) => ({ id: Number(item.id), name: String(item.name) }));
      else if (pathIndex !== null) state.path = state.path.slice(0, pathIndex + 1);
      if (!state.path.some((item) => Number(item.id) === Number(folder.id))) state.path.push({ id: Number(folder.id), name: folderName });
      state.folderId = Number(folder.id);
      const folders = [];
      for (const child of data.folders || []) {
        const childKey = await TRoomCrypto.unlockFolderFromParent(child, folderKey);
        state.folderKeys.set(Number(child.id), childKey);
        folders.push({ ...child, name: child.name });
      }
      const files = [];
      for (const record of data.files || []) files.push(await hydrateSharedFile(record, folderKey));
      state.files = files;
      $("#target-title").textContent = folderName;
      renderBreadcrumbs();
      renderItems(folders, files);
    }
    $("#browser-expiry").textContent = `有効期限：${formatEpoch(data.expiresAt)}`;
    if (options.historyMode !== "none") updateShareHistory(options.historyMode === "replace", null);
  } catch (error) { setNotice(error.message, true); }
}

async function hydrateSharedFile(file, folderKey, directFile = state.targetType === "file") {
  const key = directFile ? folderKey : await TRoomCrypto.unlockFileKey(file, folderKey);
  const metadata = await TRoomCrypto.decryptFileMetadata(file, key);
  return { ...file, ...metadata, fileKey: key };
}

function renderItems(folders, files) {
  const root = $("#items");
  root.innerHTML = "";
  for (const folder of folders) {
    const article = document.createElement("article"); article.className = "folder";
    const button = document.createElement("button"); button.type = "button";
    button.innerHTML = `<i>▰</i><span><strong>${escapeHtml(folder.name)}</strong><small>フォルダ</small></span>`;
    button.addEventListener("click", () => loadItems(folder.id));
    article.append(button); root.append(article);
  }
  for (const file of files) root.append(fileCard(file));
  $("#empty").hidden = folders.length + files.length > 0;
}

function fileCard(file) {
  const article = document.createElement("article"); article.className = "file";
  const button = document.createElement("button"); button.type = "button";
  button.innerHTML = `<div class="thumb"><span class="symbol">${kindSymbol(file.mediaKind)}</span></div><div class="file-copy"><strong>${escapeHtml(file.name)}</strong><small>${formatBytes(file.sizeBytes)}</small></div>`;
  button.addEventListener("click", () => openPreview(file));
  article.append(button);
  if (state.targetType === "folder") {
    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "file-select-button";
    selectButton.setAttribute("aria-label", `${file.name}を選択`);
    selectButton.setAttribute("aria-pressed", "false");
    selectButton.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleFileSelection(file, article, selectButton);
    });
    article.append(selectButton);
  }
  if (file.hasThumbnail) loadThumbnail(file, article.querySelector(".thumb"));
  return article;
}

function toggleFileSelection(file, article, button) {
  const selected = state.selectedFiles.has(Number(file.id));
  if (selected) state.selectedFiles.delete(Number(file.id));
  else state.selectedFiles.set(Number(file.id), file);
  article.classList.toggle("selected", !selected);
  button.setAttribute("aria-pressed", String(!selected));
  syncFileSelection();
}

function clearFileSelection() {
  state.selectedFiles.clear();
  document.querySelectorAll(".file.selected").forEach((node) => node.classList.remove("selected"));
  document.querySelectorAll(".file-select-button").forEach((button) => button.setAttribute("aria-pressed", "false"));
  syncFileSelection();
}

function syncFileSelection() {
  const count = state.selectedFiles.size;
  $("#share-selection-bar").hidden = count === 0;
  $("#share-selection-count").textContent = `${count}件を選択中`;
}

async function loadThumbnail(file, stage) {
  try {
    const response = await fetch(`${API}/files/${file.id}/thumbnail`, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return;
    const bytes = await TRoomCrypto.decryptThumbnail(await response.arrayBuffer(), file.fileKey);
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
    const image = new Image(); image.alt = ""; image.onload = image.onerror = () => URL.revokeObjectURL(url); image.src = url;
    stage.replaceChildren(image);
  } catch {}
}

function renderBreadcrumbs() {
  const nav = $("#breadcrumbs"); nav.innerHTML = "";
  for (const [index, item] of state.path.entries()) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = item.name;
    button.addEventListener("click", () => loadItems(item.id, index));
    nav.append(button);
  }
}

async function openPreview(file, options = {}) {
  state.selected = file;
  $("#preview-title").textContent = file.name;
  $("#preview-kind").textContent = kindLabel(file.mediaKind);
  const stage = $("#preview-stage"); stage.innerHTML = "<p>専用プレイヤーを準備しています…</p>";
  if (!$("#preview-dialog").open) $("#preview-dialog").showModal();
  if (options.pushHistory !== false) {
    updateShareHistory(false, Number(file.id));
    state.previewHistoryActive = true;
  }
  try {
    clearPreview();
    const streaming = file.mediaKind === "video" || file.mediaKind === "audio" || Number(file.sizeBytes) > 128 * 1024 * 1024;
    let url;
    if (streaming) {
      const media = await TCloudMedia.registerMedia(file, file.fileKey, `${API}/files/${file.id}/view`);
      state.previewMediaToken = media.token;
      url = media.url;
    } else {
      const blob = await TCloudMedia.decryptToBlob(file, file.fileKey, `${API}/files/${file.id}/view`);
      state.previewUrl = URL.createObjectURL(blob);
      url = state.previewUrl;
    }
    if (file.mediaKind === "image") { const image = new Image(); image.alt = file.name; image.src = url; stage.replaceChildren(image); }
    else if (file.mediaKind === "video") { renderVideoPlayer(stage, file, url); }
    else if (file.mediaKind === "audio") { const audio = document.createElement("audio"); audio.controls = true; audio.src = url; stage.replaceChildren(audio); }
    else if (file.mimeType === "application/pdf") { const frame = document.createElement("iframe"); frame.title = file.name; frame.src = url; stage.replaceChildren(frame); }
    else stage.innerHTML = "<p>この形式はブラウザ内表示に対応していません。ダウンロードしてご確認ください。</p>";
  } catch (error) { stage.innerHTML = `<p>${escapeHtml(error.message)}</p>`; }
}

async function downloadSelected() {
  const file = state.selected;
  if (!file) return;
  await downloadFiles([file], $("#download-button"), false);
}

async function downloadFileSelection() {
  const files = [...state.selectedFiles.values()];
  if (!files.length) return;
  await downloadFiles(files, $("#share-selection-download"), true);
}

async function downloadFiles(files, button, bulk) {
  const targets = new Map();
  try {
    if (files.length > 1 && "showDirectoryPicker" in window) {
      const directory = await TCloudMedia.chooseDownloadDirectory();
      const usedNames = new Set();
      for (const file of files) {
        const name = uniqueDownloadName(file.name, usedNames);
        targets.set(Number(file.id), await directory.getFileHandle(name, { create: true }));
      }
    } else if (files.length === 1 && "showSaveFilePicker" in window) {
      targets.set(Number(files[0].id), await TCloudMedia.chooseDownloadTarget(files[0]));
    } else if (files.some((file) => Number(file.sizeBytes) > 512 * 1024 * 1024)) {
      throw new Error("このブラウザでは大容量ファイルの直接保存に対応していません。最新版のChromeまたはEdgeをご利用ください。");
    }
  } catch (error) {
    if (error.name !== "AbortError") setNotice(error.message, true);
    return;
  }
  const originalLabel = button.textContent;
  button.disabled = true;
  state.downloadAbort = new AbortController();
  state.downloadActive = true;
  $("#share-selection-cancel").hidden = !bulk;
  if ($("#share-keep-screen-awake").checked) await requestDownloadWakeLock();
  let completed = 0;
  try {
    for (const file of files) {
      if (state.downloadAbort.signal.aborted) throw new DOMException("ダウンロードを停止しました", "AbortError");
      const prefix = files.length > 1 ? `${completed + 1} / ${files.length}件目 ` : "";
      const targetHandle = targets.get(Number(file.id)) || null;
      try {
        if (targetHandle) {
          await TCloudMedia.streamDownload(file, file.fileKey, `${API}/files/${file.id}/download`, targetHandle, {
            signal: state.downloadAbort.signal,
            onProgress: (done, total) => { button.textContent = `${prefix}保存中 ${total ? Math.round(done / total * 100) : 100}%`; }
          });
        } else {
          const blob = await TCloudMedia.decryptToBlob(file, file.fileKey, `${API}/files/${file.id}/download`, {
            signal: state.downloadAbort.signal,
            onProgress: (done, total) => { button.textContent = `${prefix}準備中 ${total ? Math.round(done / total * 100) : 100}%`; }
          });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = TCloudMedia.safeFilename(file.name);
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }
        completed++;
        await recordEvent(file.id, "download_completed");
      } catch (error) {
        await recordEvent(file.id, "download_failed", error.name === "AbortError" ? "cancelled" : String(error.message).slice(0, 80));
        throw error;
      }
    }
    if (bulk) {
      setNotice(`${completed}件をZIP化せず、個別ファイルとして保存しました。`);
      clearFileSelection();
    }
  } catch (error) {
    setNotice(error.name === "AbortError" ? `ダウンロードを停止しました。完了済みは${completed}件です。` : error.message, error.name !== "AbortError");
  } finally {
    state.downloadActive = false;
    state.downloadAbort = null;
    await releaseDownloadWakeLock();
    button.disabled = false;
    button.textContent = originalLabel;
    $("#share-selection-cancel").hidden = true;
  }
}

function cancelSharedDownloads() {
  state.downloadAbort?.abort();
  $("#share-selection-cancel").disabled = true;
  setTimeout(() => { $("#share-selection-cancel").disabled = false; }, 500);
}

function uniqueDownloadName(value, usedNames) {
  const safe = TCloudMedia.safeFilename(value);
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : "";
  let name = safe;
  let suffix = 2;
  while (usedNames.has(name.toLowerCase())) name = `${stem} (${suffix++})${extension}`;
  usedNames.add(name.toLowerCase());
  return name;
}

async function requestDownloadWakeLock() {
  $("#share-download-retry-wake").hidden = true;
  if (!("wakeLock" in navigator)) {
    $("#share-wake-lock-status").textContent = "このブラウザは消灯防止に対応していません。端末の画面設定をご確認ください。";
    return;
  }
  if (document.visibilityState !== "visible") {
    $("#share-wake-lock-status").textContent = "画面へ戻ると消灯防止を再開します。";
    return;
  }
  try {
    if (!state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => {
        state.wakeLock = null;
        if (state.downloadActive && $("#share-keep-screen-awake").checked && document.visibilityState === "visible") {
          $("#share-wake-lock-status").textContent = "消灯防止が解除されました。再試行できます。";
          $("#share-download-retry-wake").hidden = false;
        }
      }, { once: true });
    }
    $("#share-wake-lock-status").textContent = "ダウンロード中の消灯を防止しています。";
  } catch {
    $("#share-wake-lock-status").textContent = "省電力設定などにより消灯防止を開始できませんでした。";
    $("#share-download-retry-wake").hidden = false;
  }
}

async function releaseDownloadWakeLock() {
  if (state.wakeLock) {
    const lock = state.wakeLock;
    state.wakeLock = null;
    try { await lock.release(); } catch {}
  }
  if (!state.downloadActive) $("#share-wake-lock-status").textContent = "端末が対応している場合に有効になります。";
}

async function handleDownloadVisibility() {
  if (document.visibilityState === "visible" && state.downloadActive && $("#share-keep-screen-awake").checked) {
    await requestDownloadWakeLock();
  }
}

async function recordEvent(fileId, eventType, errorCode = "") {
  try { await api("/events", { method: "POST", body: JSON.stringify({ fileId, eventType, errorCode }) }); } catch {}
}

async function openHistory() {
  try {
    const data = await api("/events"); const list = $("#history-list"); list.innerHTML = "";
    if (!(data.events || []).length) list.innerHTML = "<p>利用履歴はまだありません。</p>";
    for (const item of data.events || []) {
      let name = "—";
      const known = state.files.find((file) => Number(file.id) === Number(item.fileId));
      if (known) name = known.name;
      const label = ({ unlock_success:"PW認証成功",unlock_failed:"PW認証失敗",download_started:"ダウンロード開始",download_completed:"ダウンロード完了",download_failed:"ダウンロード失敗" })[item.eventType] || item.eventType;
      const row = document.createElement("article"); row.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(name)}</span><small>${formatDateTime(item.occurredAt)}</small>`; list.append(row);
    }
    $("#history-dialog").showModal();
  } catch (error) { setNotice(error.message, true); }
}

function clearPreview() {
  if (state.previewPlayer) { try { state.previewPlayer.destroy(); } catch {} state.previewPlayer = null; }
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = "";
  if (state.previewMediaToken) TCloudMedia.releaseMedia(state.previewMediaToken);
  state.previewMediaToken = "";
}

function handlePreviewClosed() {
  clearPreview();
  if (state.previewHistoryActive && !state.handlingPopState) {
    state.previewHistoryActive = false;
    history.back();
  }
}

function updateShareHistory(replace, previewId) {
  const entry = {
    tcloudShare: true,
    folderId: state.targetType === "folder" ? state.folderId : null,
    path: state.path.map((item) => ({ id: Number(item.id), name: String(item.name) })),
    previewId: previewId ? Number(previewId) : null
  };
  if (replace || !state.historyReady) {
    history.replaceState(entry, "", location.href);
    state.historyReady = true;
  } else {
    history.pushState(entry, "", location.href);
  }
}

async function handleShareHistoryNavigation(event) {
  const entry = event.state;
  if (!entry?.tcloudShare || $("#browser-view").hidden) return;
  state.handlingPopState = true;
  try {
    if ($("#preview-dialog").open) {
      state.previewHistoryActive = false;
      $("#preview-dialog").close();
    }
    const folderChanged = state.targetType === "folder" && Number(entry.folderId) !== Number(state.folderId);
    if (folderChanged) {
      await loadItems(entry.folderId, null, { historyMode: "none", historyPath: entry.path || [] });
    }
    if (entry.previewId) {
      const file = state.files.find((item) => Number(item.id) === Number(entry.previewId));
      if (file) {
        state.previewHistoryActive = true;
        await openPreview(file, { pushHistory: false });
      }
    }
  } finally {
    state.handlingPopState = false;
  }
}

function renderVideoPlayer(stage, file, url) {
  const video = document.createElement("video"); video.controls = true; video.playsInline = true; video.preload = "metadata";
  stage.replaceChildren(video);
  const extension = String(file.name || "").split(".").pop().toLowerCase();
  const mpegType = extension === "flv" ? "flv" : ["ts", "m2ts", "mts"].includes(extension) ? "m2ts" : "";
  if (mpegType && globalThis.mpegts?.isSupported()) {
    const player = mpegts.createPlayer({ type: mpegType, isLive: false, url, filesize: Number(file.sizeBytes) }, { enableWorker: false, lazyLoad: true, lazyLoadMaxDuration: 180, seekType: "range" });
    player.on(mpegts.Events.ERROR, () => {
      if (stage.querySelector(".player-error")) return;
      const message = document.createElement("p"); message.className = "player-error";
      message.textContent = "このFLV・MPEG-TS動画の映像または音声方式には対応していません。元の画質のままダウンロードしてご確認ください。";
      stage.append(message);
      try { player.unload(); } catch {}
    });
    player.attachMediaElement(video); state.previewPlayer = player; player.load(); return;
  }
  video.src = url;
  video.addEventListener("error", () => {
    const message = document.createElement("p"); message.textContent = "この動画の映像・音声方式はブラウザで再生できません。元の画質のままダウンロードしてご確認ください。"; stage.append(message);
  }, { once: true });
}
async function api(path, options = {}) { const headers = new Headers(options.headers); if (!options.rawBody) headers.set("Content-Type", "application/json"); const response = await fetch(`${API}${path}`, { ...options, headers, credentials: "same-origin" }); if (!response.ok) throw await responseError(response); return response.json(); }
async function responseError(response) { let message = `通信に失敗しました（${response.status}）`; try { message = (await response.json()).error || message; } catch {} return new Error(message); }
function failUnlock(message) { $("#unlock-error").textContent = message; }
function setNotice(message, error = false) { const node = $("#notice"); node.textContent = message; node.style.color = error ? "#b44149" : ""; }
function kindSymbol(kind) { return ({ image:"▧",video:"▶",audio:"♪",document:"▤",other:"□" })[kind] || "□"; }
function kindLabel(kind) { return ({ image:"写真",video:"動画",audio:"音声",document:"書類",other:"ファイル" })[kind] || "ファイル"; }
function formatBytes(bytes) { const value=Number(bytes||0); if(value<1024)return `${value} B`; const units=["KB","MB","GB","TB"]; let size=value/1024,i=0; while(size>=1024&&i<units.length-1){size/=1024;i++;} return `${size>=100?size.toFixed(0):size>=10?size.toFixed(1):size.toFixed(2)} ${units[i]}`; }
function formatEpoch(value) { return new Intl.DateTimeFormat("ja-JP",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(Number(value)*1000)); }
function formatDateTime(value) { const date=new Date(String(value).replace(" ","T")+(String(value).includes("Z")?"":"Z")); return new Intl.DateTimeFormat("ja-JP",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(date); }
function escapeHtml(value) { return String(value).replace(/[&<>"]/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[char]); }

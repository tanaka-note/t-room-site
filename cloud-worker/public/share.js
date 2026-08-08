const token = location.pathname.match(/\/cloud\/share\/([A-Za-z0-9_-]{43})\/?$/)?.[1] || "";
const API = `/cloud/api/public/shares/${token}`;
const state = { info: null, targetKey: null, targetType: "", rootId: null, folderId: null, folderKeys: new Map(), path: [], files: [], selected: null, previewUrl: "", previewMediaToken: "", previewPlayer: null, downloadActive: false, wakeLock: null };
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
  $("#share-download-retry-wake").addEventListener("click", requestDownloadWakeLock);
  $("#share-keep-screen-awake").addEventListener("change", async (event) => {
    if (event.target.checked && state.downloadActive) await requestDownloadWakeLock();
    else await releaseDownloadWakeLock();
  });
  document.addEventListener("visibilitychange", handleDownloadVisibility);
  $("#history-button").addEventListener("click", openHistory);
  document.querySelectorAll(".close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $("#preview-dialog").addEventListener("close", clearPreview);
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
    await loadItems();
  } catch (error) {
    failUnlock(error.message.includes("復号") || error.message.includes("暗号化") ? "共有パスワードが違います。" : error.message);
  } finally { button.disabled = false; }
}

async function loadItems(folderId = null, pathIndex = null) {
  setNotice("");
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
      const folderName = await TRoomCrypto.decryptFolderName(folder, folderKey);
      if (pathIndex !== null) state.path = state.path.slice(0, pathIndex + 1);
      if (!state.path.some((item) => Number(item.id) === Number(folder.id))) state.path.push({ id: Number(folder.id), name: folderName });
      state.folderId = Number(folder.id);
      const folders = [];
      for (const child of data.folders || []) {
        const childKey = await TRoomCrypto.unlockFolderFromParent(child, folderKey);
        state.folderKeys.set(Number(child.id), childKey);
        folders.push({ ...child, name: await TRoomCrypto.decryptFolderName(child, childKey) });
      }
      const files = [];
      for (const record of data.files || []) files.push(await hydrateSharedFile(record, folderKey));
      state.files = files;
      $("#target-title").textContent = folderName;
      renderBreadcrumbs();
      renderItems(folders, files);
    }
    $("#browser-expiry").textContent = `有効期限：${formatEpoch(data.expiresAt)}`;
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
  if (file.hasThumbnail) loadThumbnail(file, article.querySelector(".thumb"));
  return article;
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

async function openPreview(file) {
  state.selected = file;
  $("#preview-title").textContent = file.name;
  $("#preview-kind").textContent = kindLabel(file.mediaKind);
  const stage = $("#preview-stage"); stage.innerHTML = "<p>専用プレイヤーを準備しています…</p>";
  $("#preview-dialog").showModal();
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
  let targetHandle = null;
  try {
    if ("showSaveFilePicker" in window) targetHandle = await TCloudMedia.chooseDownloadTarget(file);
    else if (Number(file.sizeBytes) > 512 * 1024 * 1024) throw new Error("このブラウザでは大容量ファイルの直接保存に対応していません。最新版のChromeまたはEdgeをご利用ください。");
  } catch (error) {
    if (error.name !== "AbortError") setNotice(error.message, true);
    return;
  }
  const button = $("#download-button"); button.disabled = true; button.textContent = "復号しています…";
  state.downloadActive = true;
  if ($("#share-keep-screen-awake").checked) await requestDownloadWakeLock();
  try {
    if (targetHandle) {
      await TCloudMedia.streamDownload(file, file.fileKey, `${API}/files/${file.id}/download`, targetHandle, {
        onProgress: (done, total) => { button.textContent = `保存中 ${total ? Math.round(done / total * 100) : 100}%`; }
      });
    } else {
      const blob = await TCloudMedia.decryptToBlob(file, file.fileKey, `${API}/files/${file.id}/download`);
      const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = file.name; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    await recordEvent(file.id, "download_completed");
  } catch (error) {
    await recordEvent(file.id, "download_failed", String(error.message).slice(0, 80));
    setNotice(error.message, true);
  } finally {
    state.downloadActive = false;
    await releaseDownloadWakeLock();
    button.disabled = false;
    button.textContent = "ダウンロード";
  }
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

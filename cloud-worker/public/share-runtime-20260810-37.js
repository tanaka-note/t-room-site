const token = location.pathname.match(/\/cloud\/share\/([A-Za-z0-9_-]{43})\/?$/)?.[1] || "";
const API = `/cloud/api/public/shares/${token}`;
const state = { info: null, targetKey: null, targetType: "", rootId: null, folderId: null, folderKeys: new Map(), path: [], folders: [], files: [], sort: "updated", sortDirection: "desc", sortUsesTypeDefaults: true, listMode: false, selected: null, selectedFiles: new Map(), selectionAnchorId: null, selectionCursorId: null, selecting: false, selectionHistoryActive: false, selectionClearBackPending: false, previewUrl: "", previewMediaToken: "", previewPlayer: null, previewGeneration: 0, previewHistoryActive: false, handlingPopState: false, historyReady: false, downloadActive: false, downloadAbort: null, wakeLock: null };
const $ = (selector) => document.querySelector(selector);

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  bindEvents();
  await restoreInstalledAppPortrait();
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
  $("#share-selection-clear").addEventListener("click", clearSelectionWithoutRefresh);
  $("#share-selection-all").addEventListener("click", selectAllSharedFiles);
  $("#share-selection-download").addEventListener("click", downloadFileSelection);
  $("#share-selection-cancel").addEventListener("click", cancelSharedDownloads);
  document.querySelectorAll("#share-sort-controls [data-sort-key]").forEach((button) => button.addEventListener("click", () => changeSharedSort(button.dataset.sortKey)));
  $("#share-display-toggle").addEventListener("click", () => {
    state.listMode = !state.listMode;
    renderSortedItems();
  });
  $("#preview-stage").addEventListener("dblclick", handleSharedPreviewDoubleClick);
  $("#share-download-retry-wake").addEventListener("click", requestDownloadWakeLock);
  $("#share-keep-screen-awake").addEventListener("change", async (event) => {
    if (event.target.checked && state.downloadActive) await requestDownloadWakeLock();
    else await releaseDownloadWakeLock();
  });
  document.addEventListener("visibilitychange", handleDownloadVisibility);
  document.addEventListener("keydown", handleSelectionKeydown);
  document.addEventListener("keydown", handleSharedPreviewKeydown);
  document.addEventListener("fullscreenchange", handleSharedPreviewFullscreenOrientationChange);
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
  const replaceSelectionHistory = options.historyMode !== "none" && state.selectionHistoryActive;
  clearFileSelection(true, false);
  if (replaceSelectionHistory) state.selectionHistoryActive = false;
  let directFile = null;
  try {
    const query = folderId ? `?folderId=${folderId}` : "";
    const data = await api(`/items${query}`);
    if (data.targetType === "file") {
      const file = await hydrateSharedFile(data.file, state.targetKey);
      state.files = [file];
      state.folders = [];
      state.rootId = null;
      state.path = [];
      $("#target-title").textContent = file.name;
      renderBreadcrumbs();
      renderItems([], [file]);
      $("#share-toolbar").hidden = true;
      directFile = file;
    } else if (data.targetType === "selection") {
      const files = [];
      for (const record of data.files || []) {
        const fileKey = Number(record.id) === Number(data.rootFileId)
          ? state.targetKey
          : await TRoomCrypto.unlockFileFromShare(record, state.targetKey);
        const metadata = await TRoomCrypto.decryptFileMetadata(record, fileKey);
        files.push({ ...record, ...metadata, fileKey });
      }
      state.rootId = null;
      state.folderId = null;
      state.path = [];
      state.folders = [];
      state.files = files;
      $("#target-title").textContent = `共有ファイル（${files.length}件）`;
      renderBreadcrumbs();
      renderSortedItems();
      $("#share-toolbar").hidden = false;
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
      state.folders = folders;
      $("#target-title").textContent = folderName;
      renderBreadcrumbs();
      renderSortedItems();
      $("#share-toolbar").hidden = false;
    }
    $("#browser-expiry").textContent = `有効期限：${formatEpoch(data.expiresAt)}`;
    if (options.historyMode !== "none") updateShareHistory(replaceSelectionHistory || options.historyMode === "replace", null);
    if (directFile) await openPreview(directFile, { pushHistory: false });
  } catch (error) { setNotice(error.message, true); }
}

async function hydrateSharedFile(file, folderKey, directFile = state.targetType === "file") {
  const key = directFile ? folderKey : await TRoomCrypto.unlockFileKey(file, folderKey);
  const metadata = await TRoomCrypto.decryptFileMetadata(file, key);
  return { ...file, ...metadata, fileKey: key };
}

function renderItems(folders, files) {
  const root = $("#items");
  root.classList.toggle("list-mode", state.listMode);
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
  const displayToggle = $("#share-display-toggle");
  displayToggle.textContent = state.listMode ? "▦" : "▤";
  displayToggle.setAttribute("aria-label", state.listMode ? "1:1表示へ切り替え" : "横長表示へ切り替え");
  displayToggle.title = state.listMode ? "1:1表示へ切り替え" : "横長表示へ切り替え";
}

function renderSortedItems() {
  const folders = [...state.folders];
  const files = [...state.files];
  const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ja", { numeric: true, sensitivity: "base" });
  const direction = state.sortDirection === "asc" ? 1 : -1;
  const byUpdated = (a, b) => direction * String(a.updatedAt || a.createdAt || "").localeCompare(String(b.updatedAt || b.createdAt || ""));
  if (state.sortUsesTypeDefaults) {
    folders.sort(byName);
    files.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  } else if (state.sort === "name") {
    folders.sort((a, b) => direction * byName(a, b));
    files.sort((a, b) => direction * byName(a, b));
  } else if (state.sort === "size") {
    folders.sort(byName);
    files.sort((a, b) => direction * (Number(a.sizeBytes || 0) - Number(b.sizeBytes || 0)) || byName(a, b));
  } else {
    folders.sort(byUpdated);
    files.sort(byUpdated);
  }
  renderItems(folders, files);
}

function changeSharedSort(key) {
  if (!["updated", "name", "size"].includes(key)) return;
  if (state.sort === key) state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
  else {
    state.sort = key;
    state.sortDirection = key === "name" ? "asc" : "desc";
  }
  state.sortUsesTypeDefaults = false;
  document.querySelectorAll("#share-sort-controls [data-sort-key]").forEach((button) => {
    const active = button.dataset.sortKey === state.sort;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    const direction = active ? state.sortDirection : button.dataset.sortKey === "name" ? "asc" : "desc";
    button.querySelector("span").textContent = direction === "asc" ? "↑" : "↓";
  });
  clearFileSelection();
  renderSortedItems();
}

function fileCard(file) {
  const article = document.createElement("article"); article.className = "file";
  article.dataset.fileId = String(file.id);
  const button = document.createElement("button"); button.type = "button";
  button.innerHTML = `<div class="thumb"><span class="symbol">${kindSymbol(file.mediaKind)}</span></div><div class="file-copy"><strong>${escapeHtml(file.name)}</strong><small class="file-size">${formatMediaDetails(file)}</small></div>`;
  button.addEventListener("click", (event) => {
    if (article.dataset.longPressed === "true") {
      article.dataset.longPressed = "false";
      return;
    }
    if (["folder", "selection"].includes(state.targetType) && (state.selectedFiles.size || event.ctrlKey || event.metaKey || event.shiftKey)) {
      if (event.shiftKey && state.selectionAnchorId) selectSharedRange(file.id);
      else toggleFileSelection(file, article);
      return;
    }
    openPreview(file);
  });
  article.append(button);
  if (["folder", "selection"].includes(state.targetType)) {
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      selectSharedFile(file, article, true);
    });
    installSharedLongPressSelection(article, file);
    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "file-select-button";
    selectButton.setAttribute("aria-label", `${file.name}を選択`);
    selectButton.setAttribute("aria-pressed", "false");
    selectButton.addEventListener("pointerdown", (event) => event.stopPropagation());
    selectButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.shiftKey && state.selectionAnchorId) selectSharedRange(file.id);
      else toggleFileSelection(file, article);
    });
    article.append(selectButton);
  }
  if (file.hasThumbnail) loadThumbnail(file, article.querySelector(".thumb"));
  return article;
}

function toggleFileSelection(file, article) {
  const selected = state.selectedFiles.has(Number(file.id));
  if (selected) state.selectedFiles.delete(Number(file.id));
  else {
    beginSelectionHistory();
    state.selectedFiles.set(Number(file.id), file);
    state.selectionAnchorId = Number(file.id);
    state.selectionCursorId = Number(file.id);
  }
  article.classList.toggle("selected", !selected);
  article.querySelector(".file-select-button")?.setAttribute("aria-pressed", String(!selected));
  if (!state.selectedFiles.size) {
    state.selectionAnchorId = null;
    state.selectionCursorId = null;
  }
  syncFileSelection();
  if (!state.selectedFiles.size && state.selectionHistoryActive) {
    state.selectionHistoryActive = false;
    history.back();
  }
}

function selectSharedFile(file, article, setAnchor = false) {
  const id = Number(file.id);
  if (!state.selectedFiles.has(id)) beginSelectionHistory();
  if (!state.selectedFiles.has(id)) state.selectedFiles.set(id, file);
  article.classList.add("selected");
  article.querySelector(".file-select-button")?.setAttribute("aria-pressed", "true");
  if (setAnchor || !state.selectionAnchorId) state.selectionAnchorId = id;
  state.selectionCursorId = id;
  syncFileSelection();
}

function sharedFileCards() {
  return [...document.querySelectorAll("#items .file[data-file-id]")];
}

function selectSharedRange(targetId) {
  const cards = sharedFileCards();
  const anchorIndex = cards.findIndex((card) => Number(card.dataset.fileId) === Number(state.selectionAnchorId));
  const targetIndex = cards.findIndex((card) => Number(card.dataset.fileId) === Number(targetId));
  if (anchorIndex < 0 || targetIndex < 0) return;
  state.selectedFiles.clear();
  const first = Math.min(anchorIndex, targetIndex);
  const last = Math.max(anchorIndex, targetIndex);
  for (let index = first; index <= last; index++) {
    const card = cards[index];
    const file = state.files.find((item) => Number(item.id) === Number(card.dataset.fileId));
    if (file) state.selectedFiles.set(Number(file.id), file);
  }
  state.selectionCursorId = Number(targetId);
  syncSharedCardSelection();
  syncFileSelection();
}

function syncSharedCardSelection() {
  for (const card of sharedFileCards()) {
    const selected = state.selectedFiles.has(Number(card.dataset.fileId));
    card.classList.toggle("selected", selected);
    card.querySelector(".file-select-button")?.setAttribute("aria-pressed", String(selected));
  }
}

function handleSelectionKeydown(event) {
  if (!event.shiftKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  if ($("#browser-view").hidden || $("#preview-dialog").open || $("#history-dialog").open || !state.selectedFiles.size) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  const cards = sharedFileCards();
  if (!cards.length) return;
  const currentId = state.selectionCursorId || state.selectionAnchorId;
  const currentIndex = Math.max(0, cards.findIndex((card) => Number(card.dataset.fileId) === Number(currentId)));
  const columns = Math.max(1, getComputedStyle($("#items")).gridTemplateColumns.split(" ").filter(Boolean).length);
  const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -columns : columns;
  const nextIndex = Math.max(0, Math.min(cards.length - 1, currentIndex + delta));
  if (nextIndex === currentIndex) return;
  event.preventDefault();
  selectSharedRange(Number(cards[nextIndex].dataset.fileId));
  cards[nextIndex].scrollIntoView({ block: "nearest", inline: "nearest" });
}

function installSharedLongPressSelection(card, file) {
  let timer = null;
  let started = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  const stopTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  card.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".file-select-button")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    started = false;
    timer = setTimeout(() => {
      started = true;
      state.selecting = true;
      card.dataset.longPressed = "true";
      selectSharedFile(file, card, true);
      if (navigator.vibrate) navigator.vibrate(18);
    }, 380);
  });
  card.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    if (!started && (Math.abs(event.clientX - startX) > 8 || Math.abs(event.clientY - startY) > 8)) stopTimer();
    if (!state.selecting) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".file[data-file-id]");
    if (target) {
      const passedFile = state.files.find((item) => Number(item.id) === Number(target.dataset.fileId));
      if (passedFile) selectSharedFile(passedFile, target);
    }
    const edge = 72;
    if (event.clientY > innerHeight - edge) scrollBy({ top: 18, behavior: "auto" });
    else if (event.clientY < edge) scrollBy({ top: -18, behavior: "auto" });
  }, { passive: false });
  const end = (event) => {
    if (event.pointerId !== pointerId) return;
    stopTimer();
    if (started) {
      event.preventDefault();
      setTimeout(() => { card.dataset.longPressed = "false"; }, 0);
    }
    state.selecting = false;
    pointerId = null;
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
}

function beginSelectionHistory() {
  if (!state.historyReady || state.selectionHistoryActive || state.selectedFiles.size) return;
  updateShareHistory(false, null);
  state.selectionHistoryActive = true;
}

function selectAllSharedFiles() {
  beginSelectionHistory();
  for (const card of sharedFileCards()) {
    const file = state.files.find((item) => Number(item.id) === Number(card.dataset.fileId));
    if (file) state.selectedFiles.set(Number(file.id), file);
  }
  if (!state.selectionAnchorId && state.selectedFiles.size) state.selectionAnchorId = state.selectedFiles.keys().next().value;
  state.selectionCursorId = [...state.selectedFiles.keys()].at(-1) || null;
  syncSharedCardSelection();
  syncFileSelection();
}

function clearFileSelection(update = true, rewindHistory = update) {
  const hadSelection = Boolean(state.selectedFiles.size);
  state.selectedFiles.clear();
  state.selectionAnchorId = null;
  state.selectionCursorId = null;
  state.selecting = false;
  document.querySelectorAll(".file.selected").forEach((node) => node.classList.remove("selected"));
  document.querySelectorAll(".file-select-button").forEach((button) => button.setAttribute("aria-pressed", "false"));
  if (update) syncFileSelection();
  else $("#share-selection-bar").hidden = true;
  if (rewindHistory && hadSelection && state.selectionHistoryActive && !state.handlingPopState) {
    state.selectionHistoryActive = false;
    history.back();
  }
}

function clearSelectionWithoutRefresh() {
  const shouldRewind = Boolean(state.selectedFiles.size && state.selectionHistoryActive && !state.handlingPopState);
  clearFileSelection(true, false);
  if (!shouldRewind) return;
  state.selectionHistoryActive = false;
  state.selectionClearBackPending = true;
  history.back();
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
  const generation = ++state.previewGeneration;
  clearPreview();
  state.selected = file;
  $("#preview-title").textContent = file.name;
  $("#preview-kind").textContent = kindLabel(file.mediaKind);
  $("#share-preview-size").textContent = formatMediaDetails(file);
  $("#share-preview-date").textContent = formatDateTime(file.createdAt);
  const stage = $("#preview-stage");
  stage.classList.remove("has-custom-video-controls");
  stage.innerHTML = '<div class="preview-loading"><p>暗号を復号して再生準備をしています…</p></div>';
  if (!$("#preview-dialog").open) $("#preview-dialog").showModal();
  if (options.pushHistory !== false) {
    updateShareHistory(false, Number(file.id));
    state.previewHistoryActive = true;
  }
  try {
    const streaming = file.mediaKind === "video" || file.mediaKind === "audio" || Number(file.sizeBytes) > 128 * 1024 * 1024;
    let url;
    if (streaming) {
      const media = await TCloudMedia.registerMedia(file, file.fileKey, `${API}/files/${file.id}/view`);
      if (!sharedPreviewRequestActive(generation, file.id)) {
        TCloudMedia.releaseMedia(media.token);
        return;
      }
      state.previewMediaToken = media.token;
      url = media.url;
    } else {
      const blob = await TCloudMedia.decryptToBlob(file, file.fileKey, `${API}/files/${file.id}/view`);
      const objectUrl = URL.createObjectURL(blob);
      if (!sharedPreviewRequestActive(generation, file.id)) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      state.previewUrl = objectUrl;
      url = state.previewUrl;
    }
    if (!sharedPreviewRequestActive(generation, file.id)) return;
    if (file.mediaKind === "image") { renderSharedPreviewImage(stage, file, url, generation); }
    else if (file.mediaKind === "video") { renderVideoPlayer(stage, file, url, generation); }
    else if (file.mediaKind === "audio") { const audio = document.createElement("audio"); audio.controls = true; observeSharedMediaDuration(audio, file); audio.src = url; stage.replaceChildren(audio); }
    else if (file.mimeType === "application/pdf") { const frame = document.createElement("iframe"); frame.title = file.name; frame.src = url; stage.replaceChildren(frame); }
    else stage.innerHTML = "<p>この形式はブラウザ内表示に対応していません。ダウンロードしてご確認ください。</p>";
  } catch (error) {
    if (sharedPreviewRequestActive(generation, file.id)) stage.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
}

function renderSharedPreviewImage(stage, file, url, generation) {
  const image = new Image();
  image.alt = file.name;
  image.addEventListener("load", () => {
    if (sharedPreviewRequestActive(generation, file.id) && $("#preview-dialog").open) stage.replaceChildren(image);
  }, { once: true });
  image.addEventListener("error", () => {
    if (sharedPreviewRequestActive(generation, file.id) && $("#preview-dialog").open) {
      stage.innerHTML = "<p>写真を表示できませんでした。ダウンロードしてご確認ください。</p>";
    }
  }, { once: true });
  image.src = url;
}

function handleSharedPreviewKeydown(event) {
  if (!$("#preview-dialog").open || event.target.closest?.("input, textarea, select, button")) return;
  const video = $("#preview-stage video");
  if (!video) return;
  if (event.code === "Space") {
    event.preventDefault();
    video.paused ? video.play().catch(() => {}) : video.pause();
  } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    video.currentTime = Math.max(0, video.currentTime + (event.key === "ArrowRight" ? 10 : -10));
  }
}

function isInstalledAppMode() {
  return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
}

async function restoreInstalledAppPortrait() {
  if (!isInstalledAppMode() || !screen.orientation?.lock) return;
  try { await screen.orientation.lock("portrait-primary"); } catch {}
}

async function prepareInstalledVideoFullscreen() {
  if (!isInstalledAppMode() || !screen.orientation?.lock) return;
  try { await screen.orientation.lock("any"); } catch {}
}

function handleSharedPreviewFullscreenOrientationChange() {
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  syncSharedPreviewSeekbarFullscreenControl(fullscreenElement);
  const fullscreenVideo = fullscreenElement?.matches?.("video")
    ? fullscreenElement
    : fullscreenElement?.querySelector?.("video");
  if (fullscreenVideo) prepareInstalledVideoFullscreen();
  else restoreInstalledAppPortrait();
}

async function toggleSharedPreviewPlayerFullscreen(event) {
  event.preventDefault();
  event.stopPropagation();
  const container = $("#share-preview-stage-wrap");
  const video = container.querySelector("video");
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  try {
    if (fullscreenElement) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else if (container.requestFullscreen) {
      await container.requestFullscreen();
    } else if (container.webkitRequestFullscreen) {
      container.webkitRequestFullscreen();
    } else if (video?.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    }
  } catch (error) {
    setNotice(`全画面表示を切り替えられませんでした：${error.message}`, true);
  }
}

function syncSharedPreviewSeekbarFullscreenControl(fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement) {
  const button = $("#preview-stage .preview-player-fullscreen");
  if (!button) return;
  const container = $("#share-preview-stage-wrap");
  const active = Boolean(fullscreenElement && container.contains(fullscreenElement)) || fullscreenElement === container;
  button.innerHTML = previewControlIcon(active ? "fullscreen-exit" : "fullscreen");
  button.setAttribute("aria-label", active ? "全画面表示を終了" : "全画面で表示");
  button.title = active ? "全画面表示を終了" : "全画面で表示";
  button.setAttribute("aria-pressed", String(active));
}

function previewControlIcon(name) {
  const paths = {
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M6.5 5h4v14h-4zm7 0h4v14h-4z"/>',
    volume: '<path d="M4 9v6h4l5 4V5L8 9zm11.5-.8v7.6a5 5 0 0 0 0-7.6zm0-3.2v2.1a7 7 0 0 1 0 9.8V19a9 9 0 0 0 0-14z"/>',
    muted: '<path d="M4 9v6h4l5 4V5L8 9zm12.2 1.6 2.1-2.1 1.4 1.4-2.1 2.1 2.1 2.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1-2.1-2.1 1.4-1.4z"/>',
    fullscreen: '<path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/>',
    "fullscreen-exit": '<path d="M8 4h2v6H4V8h4zm6 0h2v4h4v2h-6zM4 14h6v6H8v-4H4zm10 0h6v2h-4v4h-2z"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || ""}</svg>`;
}

function formatPreviewPlaybackTime(value) {
  const total = Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function addSharedPreviewPlayerControls(stage, video) {
  stage.classList.add("has-custom-video-controls");
  const controls = document.createElement("div");
  controls.className = "preview-player-controls";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "動画の再生操作");
  controls.innerHTML = `
    <button class="preview-player-button preview-player-play" type="button" aria-label="再生">${previewControlIcon("play")}</button>
    <span class="preview-player-time">0:00 / 0:00</span>
    <input class="preview-player-seek" type="range" min="0" max="1000" step="1" value="0" aria-label="再生位置" disabled>
    <button class="preview-player-button preview-player-mute" type="button" aria-label="消音">${previewControlIcon("volume")}</button>
    <button class="preview-player-button preview-player-fullscreen" type="button" aria-label="全画面で表示" aria-pressed="false">${previewControlIcon("fullscreen")}</button>`;
  const playButton = controls.querySelector(".preview-player-play");
  const timeLabel = controls.querySelector(".preview-player-time");
  const seek = controls.querySelector(".preview-player-seek");
  const muteButton = controls.querySelector(".preview-player-mute");
  const fullscreenButton = controls.querySelector(".preview-player-fullscreen");
  const syncPlayback = () => {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    playButton.innerHTML = previewControlIcon(video.paused ? "play" : "pause");
    playButton.setAttribute("aria-label", video.paused ? "再生" : "一時停止");
    timeLabel.textContent = `${formatPreviewPlaybackTime(current)} / ${formatPreviewPlaybackTime(duration)}`;
    seek.disabled = !duration;
    seek.value = duration ? String(Math.min(1000, Math.round(current / duration * 1000))) : "0";
    seek.setAttribute("aria-valuetext", `${formatPreviewPlaybackTime(current)} / ${formatPreviewPlaybackTime(duration)}`);
  };
  const syncVolume = () => {
    muteButton.innerHTML = previewControlIcon(video.muted || video.volume === 0 ? "muted" : "volume");
    muteButton.setAttribute("aria-label", video.muted || video.volume === 0 ? "音声を出す" : "消音");
  };
  playButton.addEventListener("click", () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });
  seek.addEventListener("input", () => {
    if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Number(seek.value) / 1000 * video.duration;
  });
  muteButton.addEventListener("click", () => { video.muted = !video.muted; });
  fullscreenButton.addEventListener("click", toggleSharedPreviewPlayerFullscreen);
  for (const eventName of ["click", "dblclick", "pointerdown", "touchstart", "touchend"]) {
    controls.addEventListener(eventName, (event) => event.stopPropagation());
  }
  for (const eventName of ["loadedmetadata", "durationchange", "timeupdate", "play", "pause", "ended"]) {
    video.addEventListener(eventName, syncPlayback);
  }
  video.addEventListener("volumechange", syncVolume);
  stage.append(controls);
  syncPlayback();
  syncVolume();
  syncSharedPreviewSeekbarFullscreenControl();
}

function handleSharedPreviewDoubleClick(event) {
  const video = $("#preview-stage video");
  if (!video) return;
  const bounds = $("#preview-stage").getBoundingClientRect();
  const nextTime = Math.max(0, video.currentTime + (event.clientX >= bounds.left + bounds.width / 2 ? 10 : -10));
  video.currentTime = Number.isFinite(video.duration) ? Math.min(video.duration, nextTime) : nextTime;
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
  renderSharedDownloadFailures([]);
  button.disabled = true;
  state.downloadAbort = new AbortController();
  state.downloadActive = true;
  $("#share-selection-cancel").hidden = !bulk;
  if ($("#share-keep-screen-awake").checked) await requestDownloadWakeLock();
  let completed = 0;
  let deferred = [];
  let activeFile = null;
  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (state.downloadAbort.signal.aborted) throw new DOMException("ダウンロードを停止しました", "AbortError");
      activeFile = file;
      const prefix = files.length > 1 ? `${index + 1} / ${files.length}件目 ` : "";
      const targetHandle = targets.get(Number(file.id)) || null;
      try {
        await downloadSharedFile(file, targetHandle, button, prefix, state.downloadAbort.signal);
        completed++;
        activeFile = null;
        await recordEvent(file.id, "download_completed");
      } catch (error) {
        if (error.name === "AbortError") throw error;
        deferred.push({ file, error });
        activeFile = null;
      }
    }
    if (deferred.length) {
      setNotice("エラーになったデータを最後に再試行しています。");
      const retryFailures = [];
      for (let index = 0; index < deferred.length; index++) {
        if (state.downloadAbort.signal.aborted) throw new DOMException("ダウンロードを停止しました", "AbortError");
        const { file } = deferred[index];
        activeFile = file;
        const prefix = `再試行 ${index + 1} / ${deferred.length}件 `;
        try {
          await downloadSharedFile(file, targets.get(Number(file.id)) || null, button, prefix, state.downloadAbort.signal);
          completed++;
          activeFile = null;
          await recordEvent(file.id, "download_completed");
        } catch (error) {
          if (error.name === "AbortError") throw error;
          retryFailures.push({ file, error });
          activeFile = null;
          await recordEvent(file.id, "download_failed", String(error.message).slice(0, 80));
        }
      }
      deferred = retryFailures;
    }
    if (deferred.length) {
      setNotice(`${completed}件を保存し、${deferred.length}件は保存できませんでした。`, true);
      renderSharedDownloadFailures(deferred);
    } else if (bulk) {
      setNotice(`${completed}件をZIP化せず、個別ファイルとして保存しました。`);
      clearFileSelection();
    }
  } catch (error) {
    if (error.name === "AbortError" && activeFile) await recordEvent(activeFile.id, "download_failed", "cancelled");
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

async function downloadSharedFile(file, targetHandle, button, prefix, signal) {
  if (targetHandle) {
    await TCloudMedia.streamDownload(file, file.fileKey, `${API}/files/${file.id}/download`, targetHandle, {
      signal,
      onProgress: (done, total) => { button.textContent = `${prefix}保存中 ${total ? Math.round(done / total * 100) : 100}%`; }
    });
    return;
  }
  const blob = await TCloudMedia.decryptToBlob(file, file.fileKey, `${API}/files/${file.id}/download`, {
    signal,
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

function renderSharedDownloadFailures(failures) {
  const summary = $("#share-download-failure-summary");
  const list = $("#share-download-failed-list");
  if (!summary || !list) return;
  summary.hidden = !failures.length;
  list.innerHTML = failures.map(({ file, error }) => `<li><strong>${escapeHtml(file.name)}</strong>${error?.message ? ` — ${escapeHtml(error.message)}` : ""}</li>`).join("");
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
  const stage = $("#preview-stage");
  stopSharedPreviewMediaElements(stage);
  if (state.previewPlayer) {
    try { state.previewPlayer.unload(); } catch {}
    try { state.previewPlayer.detachMediaElement(); } catch {}
    try { state.previewPlayer.destroy(); } catch {}
    state.previewPlayer = null;
  }
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = "";
  if (state.previewMediaToken) TCloudMedia.releaseMedia(state.previewMediaToken);
  state.previewMediaToken = "";
  stage?.classList.remove("has-custom-video-controls");
  stage?.replaceChildren();
}

function handlePreviewClosed() {
  state.previewGeneration += 1;
  clearPreview();
  restoreInstalledAppPortrait();
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
    const sameFolder = Number(entry.folderId || 0) === Number(state.folderId || 0);
    if (state.selectionClearBackPending) {
      state.selectionClearBackPending = false;
      if (sameFolder && !entry.previewId) return;
    }
    if (state.selectedFiles.size) {
      state.selectionHistoryActive = false;
      clearFileSelection(true, false);
      if (sameFolder && !entry.previewId) return;
    }
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

function stopSharedPreviewMediaElements(stage) {
  if (!stage) return;
  for (const media of stage.querySelectorAll("video, audio")) {
    try { media.pause(); } catch {}
    try { media.srcObject = null; } catch {}
    media.removeAttribute("src");
    try { media.load(); } catch {}
  }
  for (const frame of stage.querySelectorAll("iframe")) frame.src = "about:blank";
}

function sharedPreviewRequestActive(generation, fileId) {
  return generation === state.previewGeneration && Number(state.selected?.id) === Number(fileId);
}

function renderVideoPlayer(stage, file, url, generation) {
  const video = document.createElement("video"); video.controls = false; video.playsInline = true; video.preload = "metadata";
  video.disableRemotePlayback = true;
  video.setAttribute("disableRemotePlayback", "");
  video.setAttribute("controlsList", "noremoteplayback");
  video.setAttribute("x-webkit-airplay", "deny");
  video.addEventListener("webkitbeginfullscreen", prepareInstalledVideoFullscreen);
  video.addEventListener("webkitendfullscreen", restoreInstalledAppPortrait);
  const buffering = document.createElement("div"); buffering.className = "player-buffering"; buffering.textContent = "再生準備中…";
  stage.replaceChildren(video, buffering);
  addSharedPreviewPlayerControls(stage, video);
  observeSharedMediaDuration(video, file);
  video.addEventListener("canplay", () => buffering.remove(), { once: true });
  const extension = String(file.name || "").split(".").pop().toLowerCase();
  const mpegType = extension === "flv" ? "flv" : ["ts", "m2ts", "mts"].includes(extension) ? "m2ts" : "";
  if (mpegType && globalThis.mpegts?.isSupported()) {
    const player = mpegts.createPlayer({ type: mpegType, isLive: false, url, filesize: Number(file.sizeBytes) }, { enableWorker: false, lazyLoad: true, lazyLoadMaxDuration: 180, seekType: "range" });
    player.on(mpegts.Events.ERROR, () => {
      if (!sharedPreviewRequestActive(generation, file.id) || !$("#preview-dialog").open) return;
      if (stage.querySelector(".player-error")) return;
      buffering.remove();
      const message = document.createElement("p"); message.className = "player-error";
      message.textContent = "このFLV・MPEG-TS動画の映像または音声方式には対応していません。元の画質のままダウンロードしてご確認ください。";
      stage.append(message);
      try { player.unload(); } catch {}
    });
    player.attachMediaElement(video); state.previewPlayer = player; player.load(); return;
  }
  video.src = url;
  video.addEventListener("error", () => {
    if (!sharedPreviewRequestActive(generation, file.id) || !$("#preview-dialog").open) return;
    buffering.remove();
    const message = document.createElement("p"); message.textContent = "この動画の映像・音声方式はブラウザで再生できません。元の画質のままダウンロードしてご確認ください。"; stage.append(message);
  }, { once: true });
}

function observeSharedMediaDuration(media, file) {
  const update = () => {
    const durationSeconds = normalizeDurationSeconds(media.duration);
    if (!durationSeconds) return;
    file.durationSeconds = durationSeconds;
    const size = document.querySelector(`.file[data-file-id="${Number(file.id)}"] .file-size`);
    if (size) size.textContent = formatMediaDetails(file);
    if (Number(state.selected?.id) === Number(file.id)) $("#share-preview-size").textContent = formatMediaDetails(file);
  };
  media.addEventListener("loadedmetadata", update, { once: true });
  media.addEventListener("durationchange", update);
}
async function api(path, options = {}) { const headers = new Headers(options.headers); if (!options.rawBody) headers.set("Content-Type", "application/json"); const response = await fetch(`${API}${path}`, { ...options, headers, credentials: "same-origin" }); if (!response.ok) throw await responseError(response); return response.json(); }
async function responseError(response) { let message = `通信に失敗しました（${response.status}）`; try { message = (await response.json()).error || message; } catch {} return new Error(message); }
function failUnlock(message) { $("#unlock-error").textContent = message; }
function setNotice(message, error = false) { const node = $("#notice"); node.textContent = message; node.style.color = error ? "#b44149" : ""; }
function kindSymbol(kind) { return ({ image:"▧",video:"▶",audio:"♪",document:"▤",other:"□" })[kind] || "□"; }
function kindLabel(kind) { return ({ image:"写真",video:"動画",audio:"音声",document:"書類",other:"ファイル" })[kind] || "ファイル"; }
function formatBytes(bytes) { const value=Number(bytes||0); if(value<1024)return `${value} B`; const units=["KB","MB","GB","TB"]; let size=value/1024,i=0; while(size>=1024&&i<units.length-1){size/=1024;i++;} return `${size>=100?size.toFixed(0):size>=10?size.toFixed(1):size.toFixed(2)} ${units[i]}`; }
function normalizeDurationSeconds(value) { const seconds=Number(value); return Number.isFinite(seconds)&&seconds>0?Math.max(1,Math.round(seconds)):null; }
function formatMediaDuration(value) { const total=normalizeDurationSeconds(value); if(!total)return ""; const hours=Math.floor(total/3600),minutes=Math.floor((total%3600)/60),seconds=total%60; return hours?`${hours}:${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`:`${minutes}:${String(seconds).padStart(2,"0")}`; }
function formatMediaDetails(file) { const duration=["video","audio"].includes(file?.mediaKind)?formatMediaDuration(file.durationSeconds):""; return duration?`${formatBytes(file.sizeBytes)}・${duration}`:formatBytes(file?.sizeBytes); }
function formatEpoch(value) { return new Intl.DateTimeFormat("ja-JP",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(Number(value)*1000)); }
function formatDateTime(value) { const date=new Date(String(value).replace(" ","T")+(String(value).includes("Z")?"":"Z")); return new Intl.DateTimeFormat("ja-JP",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(date); }
function escapeHtml(value) { return String(value).replace(/[&<>"]/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[char]); }
